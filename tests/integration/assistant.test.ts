import 'dotenv/config';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { buildServer } from '../../apps/api/src/server.ts';
import { Auth } from '../../apps/api/src/auth.ts';
import { fixture, guild, user } from './helpers.ts';
import { KnowledgeStore, sql, first } from '@meeting/knowledge-db';

// 어시스턴트 API 통합 테스트 — 대화/run/승인/파일 경로를 격리 스키마에서 검증한다.
// knowledge DB는 별도 스키마, meeting DB는 helpers.fixture의 스키마.
// Solar/Upstage는 mock 모드라 호출 실패할 수 있다 — run이 영구 대기하지 않고
// status가 정해지는 것까지만 검증한다.

const K_URL = process.env.KNOWLEDGE_DATABASE_URL ?? process.env.DATABASE_URL;
const url = K_URL
  ? (() => {
      const u = new URL(K_URL);
      return u.toString();
    })()
  : null;

let f: Awaited<ReturnType<typeof fixture>>;
let kstore: KnowledgeStore | null = null;
let kschema = '';
let app: Awaited<ReturnType<typeof buildServer>>;
let cookie = '';
let projectId = '';
const prevEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  if (!url) return;
  f = await fixture();
  // 지식 스키마 분리
  const admin = new KnowledgeStore(url);
  kschema = 'atest_' + randomUUID().replaceAll('-', '');
  await sql`CREATE SCHEMA ${sql.id(kschema)}`.execute(admin.db);
  const u = new URL(url);
  u.searchParams.set('options', '-c search_path=' + kschema + ',public');
  kstore = new KnowledgeStore(u.toString());
  await kstore.migrate();

  // 프로젝트 + guild 스코프 + editor 멤버십
  projectId = randomUUID();
  await sql`INSERT INTO knowledge_projects(id, name) VALUES (${projectId}, '테스트')`.execute(
    kstore.db,
  );
  const src = await first<{ id: string }>(
    sql`INSERT INTO knowledge_sources(id, project_id, kind, auth_ref)
        VALUES (${randomUUID()}, ${projectId}, 'upload', 'local') RETURNING id`,
    kstore.db,
  );
  await sql`INSERT INTO source_scopes(id, source_id, scope_key, allowed)
            VALUES (${randomUUID()}, ${src!.id}, ${'guild:' + guild}, true)`.execute(kstore.db);
  await sql`INSERT INTO project_memberships(project_id, user_id, role)
            VALUES (${projectId}, ${user}, 'editor')`.execute(kstore.db);
  await admin.close();

  // 어시스턴트 라우트가 참조하는 env — 같은 프로세스에서 켠다.
  for (const k of [
    'KNOWLEDGE_ENABLED',
    'ASSISTANT_ENABLED',
    'KNOWLEDGE_DATABASE_URL',
    'KNOWLEDGE_UPLOAD_DIR',
    'ASSISTANT_APPROVAL_TTL_MS',
    'IMAGE_GENERATION_ENABLED',
  ])
    prevEnv[k] = process.env[k];
  process.env.KNOWLEDGE_ENABLED = 'true';
  process.env.ASSISTANT_ENABLED = 'true';
  process.env.KNOWLEDGE_DATABASE_URL = u.toString();
  process.env.KNOWLEDGE_UPLOAD_DIR = `/tmp/juncoy-test-uploads-${randomUUID().slice(0, 8)}`;
  process.env.IMAGE_GENERATION_ENABLED = 'false';

  app = await buildServer(f.config, f.store);
  cookie =
    'session=' +
    (await new Auth(f.store, f.config).create(
      { id: user, username: '준' },
      { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 3600000, mock: true },
    ));
}, 30_000);

afterEach(async () => {
  for (const [k, v] of Object.entries(prevEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  if (app) await app.close();
  if (kstore) {
    await kstore.close();
    const admin = new KnowledgeStore(url!);
    await sql`DROP SCHEMA ${sql.id(kschema)} CASCADE`.execute(admin.db);
    await admin.close();
  }
  if (f) await f.dispose();
}, 30_000);

const skip = !url;

describe('assistant', () => {
  it.skipIf(skip)('대화 생성/목록/삭제', async () => {
    const created = await app.inject({
      url: '/api/assistant/conversations',
      method: 'POST',
      headers: { cookie, origin: f.config.APP_BASE_URL },
      payload: { title: 'QA 대화' },
    });
    expect(created.statusCode).toBe(200);
    const { id } = created.json();
    const list = await app.inject({ url: '/api/assistant/conversations', headers: { cookie } });
    expect(list.json().some((c: any) => c.id === id)).toBe(true);
    const del = await app.inject({
      url: `/api/assistant/conversations/${id}`,
      method: 'DELETE',
      headers: { cookie, origin: f.config.APP_BASE_URL },
    });
    expect(del.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/assistant/conversations', headers: { cookie } })).json()
        .length,
    ).toBe(0);
  });

  it.skipIf(skip)(
    '메시지 → run → SSE 이벤트 → status 결정 (mock 모드에서도 종결)',
    async () => {
      const conv = (
        await app.inject({
          url: '/api/assistant/conversations',
          method: 'POST',
          headers: { cookie, origin: f.config.APP_BASE_URL },
          payload: {},
        })
      ).json().id;
      const msg = await app.inject({
        url: `/api/assistant/conversations/${conv}/messages`,
        method: 'POST',
        headers: { cookie, origin: f.config.APP_BASE_URL },
        payload: { content: '이번 주 일정 알려줘' },
      });
      expect(msg.statusCode).toBe(202);
      const { run_id } = msg.json();
      // 실행기는 비동기 — status가 정해질 때까지 폴링
      for (let i = 0; i < 30; i++) {
        const run = (
          await app.inject({ url: `/api/assistant/runs/${run_id}`, headers: { cookie } })
        ).json();
        if (run.status || run.phase === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      const events = await kstore!.runEvents(run_id, 0);
      expect(events.length).toBeGreaterThan(0);
      const run = (
        await app.inject({ url: `/api/assistant/runs/${run_id}`, headers: { cookie } })
      ).json();
      expect(run.status !== null || run.phase === 'awaiting_approval').toBe(true);
    },
    30_000,
  );

  it.skipIf(skip)('reader는 업로드/승인을 할 수 없다', async () => {
    // reader 멤버십으로 교체
    await sql`UPDATE project_memberships SET role='reader' WHERE project_id=${projectId}`.execute(
      kstore!.db,
    );
    const r = await app.inject({
      url: '/api/assistant/files/init',
      method: 'POST',
      headers: { cookie, origin: f.config.APP_BASE_URL },
      payload: { filename: 'a.txt', mime: 'text/plain', bytes: 10, sha256: 'a'.repeat(64) },
    });
    expect(r.statusCode).toBe(403);
  });

  it.skipIf(skip)(
    '파일 업로드 전체 흐름 + 삭제 승인 → tombstone',
    async () => {
      const text = '프로젝트 킥오프 회의록. 다음 회의는 금요일.';
      const buf = Buffer.from(text, 'utf8');
      const sha = createHash('sha256').update(buf).digest('hex');
      const init = await app.inject({
        url: '/api/assistant/files/init',
        method: 'POST',
        headers: { cookie, origin: f.config.APP_BASE_URL },
        payload: { filename: 'kickoff.txt', mime: 'text/plain', bytes: buf.length, sha256: sha },
      });
      expect(init.statusCode).toBe(200);
      const { id } = init.json();
      const complete = await app.inject({
        url: `/api/assistant/files/${id}/complete`,
        method: 'POST',
        headers: {
          cookie,
          origin: f.config.APP_BASE_URL,
          'content-type': 'application/octet-stream',
        },
        payload: buf,
      });
      expect(complete.statusCode).toBe(200);
      const file = (
        await app.inject({ url: `/api/assistant/files/${id}`, headers: { cookie } })
      ).json();
      expect(['INDEXING', 'EXTRACTING']).toContain(file.state);
      expect(file.document_state).toBe('READY');

      // 삭제 미리보기 → approval 생성
      const prev = await app.inject({
        url: `/api/assistant/files/${id}/delete-preview`,
        method: 'POST',
        headers: { cookie, origin: f.config.APP_BASE_URL },
        payload: {},
      });
      expect(prev.statusCode).toBe(200);
      const approvalId = prev.json().approval_id;
      // 승인 → tombstone + DELETED
      const approve = await app.inject({
        url: `/api/assistant/approvals/${approvalId}/approve`,
        method: 'POST',
        headers: { cookie, origin: f.config.APP_BASE_URL },
      });
      expect(approve.statusCode).toBe(200);
      const after = await first<{ state: string }>(
        sql`SELECT state FROM knowledge_uploads WHERE id=${id}`,
        kstore!.db,
      );
      expect(after?.state).toBe('DELETED');
      // 재승인 불가 — 1회성
      const again = await app.inject({
        url: `/api/assistant/approvals/${approvalId}/approve`,
        method: 'POST',
        headers: { cookie, origin: f.config.APP_BASE_URL },
      });
      expect(again.statusCode).toBe(409);
    },
    30_000,
  );

  it.skipIf(skip)('hash/size 불일치 업로드 거부', async () => {
    const init = await app.inject({
      url: '/api/assistant/files/init',
      method: 'POST',
      headers: { cookie, origin: f.config.APP_BASE_URL },
      payload: { filename: 'x.txt', mime: 'text/plain', bytes: 3, sha256: 'b'.repeat(64) },
    });
    const { id } = init.json();
    const bad = await app.inject({
      url: `/api/assistant/files/${id}/complete`,
      method: 'POST',
      headers: {
        cookie,
        origin: f.config.APP_BASE_URL,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('abc'),
    });
    expect(bad.statusCode).toBe(400); // sha 불일치
  });

  it.skipIf(skip)(
    'SSE 스트림 헤더 + 종결',
    async () => {
      const conv = (
        await app.inject({
          url: '/api/assistant/conversations',
          method: 'POST',
          headers: { cookie, origin: f.config.APP_BASE_URL },
          payload: {},
        })
      ).json().id;
      const msg = (
        await app.inject({
          url: `/api/assistant/conversations/${conv}/messages`,
          method: 'POST',
          headers: { cookie, origin: f.config.APP_BASE_URL },
          payload: { content: 'test' },
        })
      ).json();
      // 실행이 끝날 때까지 대기
      for (let i = 0; i < 30; i++) {
        const run = (
          await app.inject({ url: `/api/assistant/runs/${msg.run_id}`, headers: { cookie } })
        ).json();
        if (run.status || run.phase === 'awaiting_approval') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      const res = await app.inject({
        url: `/api/assistant/runs/${msg.run_id}/stream`,
        headers: { cookie },
      });
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('event:');
    },
    30_000,
  );
});
