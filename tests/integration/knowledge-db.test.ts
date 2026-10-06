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
    expect(await store!.markDocumentDirty(sid, key)).toBe('dirty');
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
    expect(await store!.markDocumentDirty(sid, key)).toBe('tombstoned');
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

  it('swaps active chunk_set atomically — version binding enforced', async (ctx) => {
    skipIf(ctx);
    const sid = randomUUID();
    const project = randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${project},'p')`.execute(store!.db);
    await sql`INSERT INTO knowledge_sources(id,project_id,kind,auth_ref)
              VALUES(${sid},${project},'github','secret-name')`.execute(store!.db);
    const key = 'github:repo:main:a.ts';
    await store!.markDocumentDirty(sid, key);
    const doc = await first<{ id: string; current_version_id: string }>(
      sql`SELECT id, current_version_id FROM documents WHERE stable_key=${key}`,
      store!.db,
    );
    // v1 공개 후 그 버전에 결속된 chunk_set 생성
    await store!.publishVersion(doc!.id, {
      contentHash: 'h1',
      sourceRevision: 'r1',
      normalized: { text: 'v1' },
    });
    const v1 = await first<{ id: string }>(
      sql`SELECT current_version_id AS id FROM documents WHERE id=${doc!.id}`,
      store!.db,
    );
    const s1 = await store!.createChunkSet(doc!.id, 1, v1!.id);
    await store!.insertChunks(s1!, [
      { ordinal: 0, content: '첫 청크' },
      { ordinal: 1, content: '두번째 청크' },
    ]);
    expect(await store!.swapChunkSet(doc!.id, s1!)).toBe(s1);
    const s2 = await store!.createChunkSet(doc!.id, 1, v1!.id);
    await store!.insertChunks(s2!, [{ ordinal: 0, content: 'v1 재청크' }]);
    expect(await store!.swapChunkSet(doc!.id, s2!)).toBe(s2);
    const actives = await rows<{ id: string }>(
      sql`SELECT id FROM chunk_sets WHERE document_id=${doc!.id} AND active`,
      store!.db,
    );
    expect(actives.map((x) => x.id)).toEqual([s2]);
    // v1에 결속된 set이 남아 있어도 v2가 current가 되면 활성화 거부 (out-of-order)
    const s3 = await store!.createChunkSet(doc!.id, 1, v1!.id);
    await store!.insertChunks(s3!, [{ ordinal: 0, content: 'stale 청크' }]);
    await store!.publishVersion(doc!.id, {
      contentHash: 'h2',
      sourceRevision: 'r2',
      normalized: { text: 'v2' },
    });
    expect(await store!.swapChunkSet(doc!.id, s3!)).toBeNull();
    const stillActive = await rows<{ id: string }>(
      sql`SELECT id FROM chunk_sets WHERE document_id=${doc!.id} AND active`,
      store!.db,
    );
    expect(stillActive.map((x) => x.id)).toEqual([s2]);
  });

  it('unchanged marking keeps documents searchable (same-content re-ingest)', async (ctx) => {
    skipIf(ctx);
    const sid = randomUUID();
    const project = randomUUID();
    await sql`INSERT INTO knowledge_projects(id,name) VALUES(${project},'p')`.execute(store!.db);
    await sql`INSERT INTO knowledge_sources(id,project_id,kind,auth_ref)
              VALUES(${sid},${project},'discord','secret-name')`.execute(store!.db);
    const key = 'discord:g:c:m1';
    // 최초 수집 → dirty → publish → READY·검색 가능
    expect(
      await store!.markDocumentDirty(sid, key, {}, { unlessHash: 'hA', revision: 'r1' }),
    ).toBe('dirty');
    const doc = await first<{ id: string }>(
      sql`SELECT id FROM documents WHERE stable_key=${key}`,
      store!.db,
    );
    await store!.publishVersion(doc!.id, {
      contentHash: 'hA',
      sourceRevision: 'r1',
      normalized: { text: '본문' },
    });
    // 동일 내용 재수집 — dirty를 세우지 않고 'unchanged'를 반환한다
    expect(
      await store!.markDocumentDirty(sid, key, {}, { unlessHash: 'hA', revision: 'r1' }),
    ).toBe('unchanged');
    const after = await first<{ dirty: boolean; state: string }>(
      sql`SELECT dirty, state FROM documents WHERE id=${doc!.id}`,
      store!.db,
    );
    expect(after!.dirty).toBe(false);
    expect(after!.state).toBe('READY');
    // 변경 수집 — dirty가 세워지고 새 revision이 기록된다
    expect(
      await store!.markDocumentDirty(sid, key, {}, { unlessHash: 'hB', revision: 'r2' }),
    ).toBe('dirty');
    const pending = await first<{ dirty: boolean; pending_revision: string | null }>(
      sql`SELECT dirty, pending_revision FROM documents WHERE id=${doc!.id}`,
      store!.db,
    );
    expect(pending!.dirty).toBe(true);
    expect(pending!.pending_revision).toBe('r2');
    // out-of-order 방지: 오래된 revision의 publish는 거부된다
    expect(
      await store!.publishVersion(doc!.id, {
        contentHash: 'hStale',
        sourceRevision: 'r1.5',
        normalized: { text: 'stale' },
      }, 'r1.5'),
    ).toBe(false);
    // 기대 revision과 일치하면 공개된다
    expect(
      await store!.publishVersion(doc!.id, {
        contentHash: 'hB',
        sourceRevision: 'r2',
        normalized: { text: '새 본문' },
      }, 'r2'),
    ).toBe(true);
  });

  it('expired-lease jobs are reclaimed and stale-generation writes rejected', async (ctx) => {
    skipIf(ctx);
    await store!.enqueueJob('job-lease', 'fetch', { x: 1 });
    const claimed = await store!.claimJobs('w1', ['fetch'], 5, 1); // 1ms lease
    expect(claimed).toHaveLength(1);
    const job = claimed[0];
    expect(job.owner).toBe('w1');
    await new Promise((r) => setTimeout(r, 20)); // lease 만료 대기
    const reclaimed = await store!.claimJobs('w2', ['fetch'], 5, 30_000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].generation).toBe(job.generation + 1);
    // 구 owner의 finish/retry는 generation·owner 불일치로 거부된다
    expect(await store!.finishJob(job, 'DONE')).toBe(false);
    expect(await store!.retryJob(job, new Date(), 'late')).toBe(false);
    expect(await store!.finishJob(reclaimed[0], 'DONE')).toBe(true);
  });
});
