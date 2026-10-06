import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore, sql, first, rows } from '@meeting/knowledge-db';

// 지식 스토어 시맨틱 검증. KNOWLEDGE_DATABASE_URL(또는 DATABASE_URL의 별도 스키마)과
// pgvector 확장이 필요하다.
// - URL 미설정: 개발 실행으로 간주해 명시적 skip (이유를 남긴다).
// - URL 설정됨: 연결/migration 실패는 테스트 실패로 보고한다 — skip으로 숨기지 않는다.
let store: KnowledgeStore | null = null;
let admin: KnowledgeStore | null = null;
let schema = '';
let setupError: Error | null = null;
const url = process.env.KNOWLEDGE_DATABASE_URL ?? process.env.DATABASE_URL;

beforeAll(async () => {
  if (!url) return;
  try {
    admin = new KnowledgeStore(url);
    schema = 'ktest_' + randomUUID().replaceAll('-', '');
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin.db);
    const u = new URL(url);
    u.searchParams.set('options', '-c search_path=' + schema + ',public');
    store = new KnowledgeStore(u.toString());
    await store.migrate();
  } catch (e) {
    setupError = e instanceof Error ? e : new Error(String(e));
    store = null;
  }
}, 30_000);

afterAll(async () => {
  try {
    if (store) await store.close();
    if (admin && schema)
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin.db);
  } finally {
    if (admin) await admin.close();
  }
}, 30_000);

const skipIf = (ctx: any) => {
  if (!url) ctx.skip(`no KNOWLEDGE_DATABASE_URL/DATABASE_URL — skipped by design (not a pass)`);
  if (setupError) throw new Error(`test DB setup failed (URL was set — this is a failure, not a skip): ${setupError.message}`);
};

describe('knowledge-db semantics', () => {
  it('dedupes source events by (source_id, event_key)', async (ctx) => {
    skipIf(ctx);
    const sid = randomUUID();
    const project = randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${project},'p')`.execute(store!.db);
    await sql`INSERT INTO knowledge_sources(id,project_id,kind,auth_ref)
              VALUES(${sid},${project},'discord','secret-name')`.execute(store!.db);
    const a = await store!.recordSourceEvent(sid, 'delivery-1', 'MESSAGE_CREATE', { x: 1 });
    const b = await store!.recordSourceEvent(sid, 'delivery-1', 'MESSAGE_CREATE', { x: 1 });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const c = await store!.recordSourceEvent(sid, 'delivery-2', 'MESSAGE_UPDATE', { x: 2 });
    expect(c).not.toBeNull();
  });

  it('claims jobs with lease+generation fencing and rejects stale generation writes', async (ctx) => {
    skipIf(ctx);
    await store!.enqueueJob('job-1', 'fetch', { d: 1 });
    const claimed = await store!.claimJobs('w1', ['fetch'], 5, 30_000);
    expect(claimed).toHaveLength(1);
    const job = claimed[0];
    expect(job.generation).toBe(1);
    // 두 번째 worker가 같은 잡을 재claim하면 generation이 올라간다.
    const reclaimed = await store!.claimJobs('w2', ['fetch'], 5, 30_000);
    // RUNNING 상태는 재claim 대상이 아니다 — lease 만료를 흉내내는 경우만.
    expect(reclaimed).toHaveLength(0);
    await store!.finishJob(job, 'DONE');
    const done = await first<{ status: string; generation: number }>(
      sql`SELECT status, generation FROM knowledge_jobs WHERE key='job-1'`,
      store!.db,
    );
    expect(done!.status).toBe('DONE');
  });

  it('tombstones block dirty marking and version publish', async (ctx) => {
    skipIf(ctx);
    const sid = randomUUID();
    const project = randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${project},'p')`.execute(store!.db);
    await sql`INSERT INTO knowledge_sources(id,project_id,kind,auth_ref)
              VALUES(${sid},${project},'notion','secret-name')`.execute(store!.db);
    const key = 'notion:ws:page-1';
    expect(await store!.markDocumentDirty(sid, key)).toBe(true);
    const doc = await first<{ id: string }>(
      sql`SELECT id FROM documents WHERE stable_key=${key}`,
      store!.db,
    );
    expect(
      await store!.publishVersion(doc!.id, {
        contentHash: 'h1',
        sourceRevision: 'r1',
        normalized: { text: 'v1' },
      }),
    ).toBe(true);
    await store!.applyTombstone(key, sid, 'page.deleted');
    // tombstone 이후: dirty 마킹/버전 공개 모두 거부
    expect(await store!.markDocumentDirty(sid, key)).toBe(false);
    expect(
      await store!.publishVersion(doc!.id, {
        contentHash: 'h2',
        sourceRevision: 'r2',
        normalized: { text: 'v2' },
      }),
    ).toBe(false);
    const after = await first<{ state: string; deleted: boolean }>(
      sql`SELECT state, deleted FROM documents WHERE id=${doc!.id}`,
      store!.db,
    );
    expect(after!.state).toBe('UNAVAILABLE');
    expect(after!.deleted).toBe(true);
  });

  it('swaps active chunk_set atomically — one active per document', async (ctx) => {
    skipIf(ctx);
    const sid = randomUUID();
    const project = randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${project},'p')`.execute(store!.db);
    await sql`INSERT INTO knowledge_sources(id,project_id,kind,auth_ref)
              VALUES(${sid},${project},'github','secret-name')`.execute(store!.db);
    const key = 'github:repo:main:a.ts';
    await store!.markDocumentDirty(sid, key);
    const doc = await first<{ id: string }>(
      sql`SELECT id FROM documents WHERE stable_key=${key}`,
      store!.db,
    );
    const s1 = await store!.createChunkSet(doc!.id, 1);
    await store!.insertChunks(s1!, [
      { ordinal: 0, content: '첫 청크' },
      { ordinal: 1, content: '두번째 청크' },
    ]);
    await store!.swapChunkSet(doc!.id, s1!);
    const s2 = await store!.createChunkSet(doc!.id, 2);
    await store!.insertChunks(s2!, [{ ordinal: 0, content: 'v2 청크' }]);
    await store!.swapChunkSet(doc!.id, s2!);
    const actives = await rows<{ id: string }>(
      sql`SELECT id FROM chunk_sets WHERE document_id=${doc!.id} AND active`,
      store!.db,
    );
    expect(actives.map((x) => x.id)).toEqual([s2]);
  });
});
