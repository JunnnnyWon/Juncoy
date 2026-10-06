import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KnowledgeStore, sql, first, rows as kRows } from '@meeting/knowledge-db';
import { QuestionRequest } from '@meeting/contracts';
import {
  answerQuestion,
  retrieve,
  UpstageEmbeddings,
  ensureProfile,
  DiscordCollector,
  DiscordRest,
  buildImagePrompt,
  verifyWebhookSignature,
  verifyNotionSignature,
} from '@meeting/knowledge';
import type { AppConfig } from '@meeting/providers';
import type { Auth } from './auth.ts';

// 지식 문답 API — spec §13. 별도 knowledge DB + 별도 큐 (§10/§16).
// KNOWLEDGE_DATABASE_URL 없으면 KNOWLEDGE_DISABLED로 503.

interface Deps {
  auth: Auth;
  config: AppConfig;
}

interface KnowledgeCtx {
  store: KnowledgeStore;
  embeddings?: UpstageEmbeddings;
  discordRead?: (timeoutMs: number) => Promise<{ ok: boolean; gaps: string[] }>;
  model: {
    structured<T>(s: z.ZodType<T>, input: unknown, system: string): Promise<{ result: T; model: string }>;
  };
}

/** Solar 래퍼 — structured 인자 키/usage 콜백을 버린다. */
function solarModel(config: AppConfig) {
  const key = config.UPSTAGE_API_KEY;
  return {
    async structured<T>(s: z.ZodType<T>, input: unknown, system: string) {
      const res = await fetch('https://api.upstage.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.UPSTAGE_MODEL,
          stream: false,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(input) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'knowledge_answer',
              strict: true,
              schema: z.toJSONSchema(s, { target: 'draft-7' }),
            },
          },
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`solar ${res.status}`);
      const data = (await res.json()) as any;
      return {
        result: s.parse(JSON.parse(data.choices[0].message.content)) as T,
        model: (data.model ?? config.UPSTAGE_MODEL) as string,
      };
    },
  };
}

/**
 * Discord 라이브 읽기 — 질문마다 **허용된 스코프(source_scopes)** 의 채널 head를
 * 재대조한다 (§11.1 단계 2, RAG-008).
 * - connector_cursors가 아니라 source_scopes에서 채널을 읽는다 — 등록 전 채널과
 *   allowed=false 채널이 섞이지 않는다. 허용 채널 0개는 성공이 아니라 gap이다.
 * - ACCESS_LOST 소스는 읽기를 시도하지 않고 gap으로 보고한다.
 * - 채널 간 병렬(3개씩), 전체 예산은 timeoutMs — REST 단건 30s 타임아웃과
 *   무관하게 호출자 예산 안에서 끝낸다.
 * - 대조 후 짧게 인덱스 반영을 기다린다 — 방금 읽은 내용이 이번 질문 검색에
 *   반영되도록 extract 잡 큐가 빌 때까지(최대 3s) 기다린다.
 */
async function makeDiscordRead(store: KnowledgeStore, token: string, guildId: string) {
  const rest = new DiscordRest(token);
  return async (timeoutMs: number) => {
    const gaps: string[] = [];
    const deadline = Date.now() + timeoutMs;
    const channels = await kRows<{ channel_id: string; source_id: string; status: string }>(
      sql`SELECT split_part(sc.scope_key, ':', 2) AS channel_id, s.id AS source_id, s.status
          FROM source_scopes sc
          JOIN knowledge_sources s ON s.id=sc.source_id
          WHERE s.kind='discord' AND sc.allowed AND sc.scope_key LIKE 'channel:%'`,
      store.db,
    );
    if (!channels.length) return { ok: false, gaps: ['no_allowed_channels'] };
    const collector = new DiscordCollector(store, rest, guildId);
    const CONCURRENCY = 3;
    for (let i = 0; i < channels.length; i += CONCURRENCY) {
      await Promise.all(
        channels.slice(i, i + CONCURRENCY).map(async (c) => {
          if (c.status !== 'ACTIVE') {
            gaps.push(`source_${c.status.toLowerCase()}:${c.channel_id}`);
            return;
          }
          if (Date.now() > deadline) {
            gaps.push(`timeout:${c.channel_id}`);
            return;
          }
          try {
            await collector.reconcileHead(c.source_id, c.channel_id);
          } catch {
            gaps.push(`channel:${c.channel_id}`);
          }
        }),
      );
      if (Date.now() > deadline) break;
    }
    // 인덱스 반영 대기 — 방금 재대조로 생긴 extract 잡이 처리되길 최대 3s 기다린다.
    const waitDeadline = Math.min(deadline, Date.now() + 3_000);
    while (Date.now() < waitDeadline) {
      const pending = await first<{ c: number }>(
        sql`SELECT count(*)::int AS c FROM knowledge_jobs j
            JOIN documents d ON d.id=j.document_id
            JOIN knowledge_sources s ON s.id=d.source_id
            WHERE s.kind='discord' AND j.kind='extract'
              AND j.status IN ('PENDING','RETRYABLE','RUNNING')`,
        store.db,
      );
      if (!pending?.c) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ok: gaps.length === 0, gaps };
  };
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: Deps) {
  // 지식 라우트는 외부 인프라(knowledge DB·Upstage·Discord REST) 의존이 크다.
  // 알 수 없는 오류를 500으로 두면 클라이언트가 영구 실패로 오인한다 —
  // 스코프 핸들러가 미분류 오류를 503 TEMPORARY_FAILURE로 내린다 (RAG-015).
  app.setErrorHandler((error, _req, reply) => {
    const e = error as any;
    if (e instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_ARGUMENT', message: '잘못된 요청입니다.' } });
    const status =
      e.code === 'KNOWLEDGE_DISABLED' || e.code === 'PROJECT_SCOPE_DENIED' || e.statusCode
        ? (e.statusCode ?? (e.code === 'KNOWLEDGE_DISABLED' ? 503 : 403))
        : 503;
    return reply.code(status).send({
      error: {
        code: e.code ?? 'TEMPORARY_FAILURE',
        message: e.code ? e.message : '지식 서비스가 일시적으로 불안정합니다.',
      },
    });
  });

  let ctx: KnowledgeCtx | null | Promise<KnowledgeCtx | null> = null;
  const getCtx = async (): Promise<KnowledgeCtx | null> => {
    if (ctx) return ctx;
    return (ctx = (async () => {
      // 기능 off면 DB에 아예 붙지 않는다 — 컨텍스트 없음 = 모든 라우트 503 (RAG-015).
      if (process.env.KNOWLEDGE_ENABLED !== 'true') return null;
      const url = process.env.KNOWLEDGE_DATABASE_URL;
      if (!url) return null;
      const store = new KnowledgeStore(url);
      const on = (name: string) => process.env[name] === 'true';
      const embeddings = deps.config.UPSTAGE_API_KEY
        ? new UpstageEmbeddings(deps.config.UPSTAGE_API_KEY)
        : undefined;
      if (embeddings)
        await ensureProfile(
          store,
          'upstage',
          process.env.UPSTAGE_EMBEDDING_QUERY_MODEL ?? 'embedding-query',
          process.env.UPSTAGE_EMBEDDING_DOCUMENT_MODEL ?? 'embedding-passage',
          4096,
        );
      const discordRead =
        on('DISCORD_CONTEXT_ENABLED') && deps.config.DISCORD_BOT_TOKEN
          ? await makeDiscordRead(
              store,
              deps.config.DISCORD_BOT_TOKEN,
              deps.config.DISCORD_GUILD_ID,
            )
          : undefined;
      return { store, embeddings, discordRead, model: solarModel(deps.config) };
    })());
  };

  const requireCtx = async (req: any) => {
    const session = await deps.auth.session(req.cookies.session);
    await deps.auth.check(session, deps.config.DISCORD_GUILD_ID);
    const c = await getCtx();
    if (!c)
      throw Object.assign(new Error('knowledge disabled'), {
        statusCode: 503,
        code: 'KNOWLEDGE_DISABLED',
      });
    return { session, ctx: c };
  };

  /**
   * 질문자 권한으로 프로젝트를 결정한다 (RAG-001) — "첫 번째 프로젝트"가 아니라
   * 질문자 guild를 scope로 등록한 소스를 가진 프로젝트만 선택한다.
   * 매칭되는 프로젝트가 없으면 403 — 남의 프로젝트로 굴러가지 않는다.
   */
  const projectForAsker = async (ctx: KnowledgeCtx, guildId: string) =>
    first<{ id: string }>(
      sql`SELECT p.id FROM knowledge_projects p
          WHERE EXISTS (
            SELECT 1 FROM knowledge_sources s
            JOIN source_scopes sc ON sc.source_id=s.id AND sc.allowed
            WHERE s.project_id=p.id AND sc.scope_key=${`guild:${guildId}`}
          )
          ORDER BY p.created_at LIMIT 1`,
      ctx.store.db,
    );

  /** POST /api/knowledge/ask — 질문 → 검증된 Answer (§13.1). */
  app.post('/api/knowledge/ask', async (req, reply) => {
    const { session, ctx } = await requireCtx(req);
    const body = QuestionRequest.parse(req.body ?? {});
    const project = await projectForAsker(ctx, deps.config.DISCORD_GUILD_ID);
    if (!project)
      return reply.code(403).send({
        error: { code: 'PROJECT_SCOPE_DENIED', message: '이 길드에 허용된 지식 프로젝트가 없습니다.' },
      });
    const answer = await answerQuestion(
      {
        store: ctx.store,
        model: ctx.model,
        embeddings: ctx.embeddings,
        discordRead: ctx.discordRead,
        userId: session.user_id,
        acl: { guilds: [deps.config.DISCORD_GUILD_ID] },
      },
      project.id,
      body,
    );
    return answer;
  });

  /**
   * GET /api/knowledge/answer/:id — 완료된 실행의 Answer (§13.2 조회).
   * 저장된 body를 그대로 반환하지 않는다 (RAG-002): 근거 문서가 아직
   * READY·비삭제·ACL 통과인지 재검증하고, 무효화된 근거는 빼고
   * `evidence_stale` 표시를 붙여 반환한다.
   */
  app.get('/api/knowledge/answer/:id', async (req) => {
    const { ctx } = await requireCtx(req);
    const id = z.uuid().parse((req.params as any).id);
    const run = await first<{ body: any; status: string; phase: string }>(
      sql`SELECT body, status, phase FROM answer_runs WHERE id=${id}`,
      ctx.store.db,
    );
    if (!run) return { status: 'FAILED' };
    const body = run.body;
    if (!body?.evidence?.length) return body ?? { status: run.status, phase: run.phase };
    // 저장 당시 근거 재검증 — 삭제/권한 회수/버전 변경이 있으면 캐시 그대로 안 쓴다.
    const evIds = (body.evidence as any[]).map((e) => e.document_id).filter(Boolean);
    const current = new Map(
      (
        await kRows<{ id: string; ok: boolean; hash: string | null }>(
          sql`SELECT d.id,
                (NOT d.deleted AND d.state='READY' AND NOT d.dirty
                  AND src.status='ACTIVE'
                  AND (d.acl->>'scope' IS NULL OR EXISTS(
                    SELECT 1 FROM source_scopes sc
                    WHERE sc.source_id=d.source_id
                      AND sc.scope_key=d.acl->>'scope' AND sc.allowed))
                  AND (d.acl->>'guild' IS NULL
                       OR d.acl->>'guild' = ${deps.config.DISCORD_GUILD_ID})) AS ok,
                v.content_hash AS hash
              FROM documents d
              JOIN knowledge_sources src ON src.id=d.source_id
              LEFT JOIN document_versions v ON v.id=d.current_version_id
              WHERE d.id = ANY(${evIds}::uuid[])`,
          ctx.store.db,
        )
      ).map((r) => [r.id, r]),
    );
    const validEvidence = (body.evidence as any[]).filter((e) => {
      const cur = current.get(e.document_id);
      return cur?.ok && cur.hash === (e.revision ?? cur.hash);
    });
    if (validEvidence.length === body.evidence.length) return body;
    const validIds = new Set(validEvidence.map((e: any) => e.id));
    return {
      ...body,
      evidence: validEvidence,
      claims: (body.claims ?? [])
        .map((c: any) => ({
          ...c,
          evidence_ids: (c.evidence_ids ?? []).filter((id: string) => validIds.has(id)),
        }))
        .filter((c: any) => c.evidence_ids.length > 0),
      evidence_stale: true,
      warnings: [
        ...(body.warnings ?? []),
        '일부 근거가 저장 이후 변경·삭제·권한 회수되어 제외되었습니다.',
      ],
    };
  });

  /** POST /api/knowledge/image-prompt — 코퍼스 근거로 이미지 프롬프트 합성 (§11.2). */
  app.post('/api/knowledge/image-prompt', async (req, reply) => {
    const { ctx } = await requireCtx(req);
    const body = z.object({ request: z.string().min(1).max(2000) }).parse(req.body ?? {});
    const project = await first<{ id: string }>(
      sql`SELECT id FROM knowledge_projects ORDER BY created_at LIMIT 1`,
      ctx.store.db,
    );
    if (!project)
      return reply.code(503).send({ error: { code: 'INDEX_NOT_READY' } });
    if (process.env.IMAGE_GENERATION_ENABLED !== 'true')
      reply.header('X-Image-Generation', 'provider_unconfigured');
    return buildImagePrompt(ctx.store, {
      projectId: project.id,
      request: body.request,
      embeddings: ctx.embeddings,
    });
  });

  // ── webhook 수신 — 세션 대신 HMAC 서명 (Origin 면제 대상, §6.2/§6.1) ──
  /** POST /api/knowledge/webhooks/github — push 등 신호 → refresh 잡으로 변환. */
  app.post('/api/knowledge/webhooks/github', async (req, reply) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const c = await getCtx();
    if (!c || !secret)
      return reply.code(503).send({ error: { code: 'KNOWLEDGE_DISABLED' } });
    const sig = (req.headers['x-hub-signature-256'] as string) ?? null;
    if (!verifyWebhookSignature(secret, (req as any).rawBody ?? '', sig))
      return reply.code(401).send({ error: { code: 'BAD_SIGNATURE' } });
    const delivery = String(req.headers['x-github-delivery'] ?? crypto.randomUUID());
    const event = String(req.headers['x-github-event'] ?? 'unknown');
    const payload = req.body as any;
    const repo = payload?.repository?.full_name;
    const ref = typeof payload?.ref === 'string' ? payload.ref.replace('refs/heads/', '') : null;
    if (!repo) return { received: true, queued: false };
    // source 바인딩 (RAG-014): "첫 ACTIVE 소스"가 아니라 이 repo를 scope로
    // 등록한 github 소스를 찾는다. push면 ref 허용 스코프까지 확인한다.
    const src = await first<{ id: string }>(
      sql`SELECT s.id FROM knowledge_sources s
          WHERE s.kind='github' AND s.status='ACTIVE'
            AND EXISTS (
              SELECT 1 FROM source_scopes sc
              WHERE sc.source_id=s.id AND sc.allowed
                AND sc.scope_key LIKE 'ref:%'
                AND sc.metadata->>'repo' = ${repo}
                ${ref ? sql`AND sc.scope_key = ${`ref:${ref}`}` : sql``}
            )
          LIMIT 1`,
      c.store.db,
    );
    if (!src) return { received: true, queued: false, ignored: 'unregistered_repo_or_ref' };
    // dedupe + 잡 생성을 한 트랜잭션으로 — 이벤트만 저장되고 잡이 빠지지 않는다.
    const { eventId } = await c.store.recordSourceEventWithJob(
      src.id,
      delivery,
      `github.${event}`,
      payload,
      event === 'push' && ref
        ? {
            key: `gh-refresh:${delivery}`,
            kind: 'refresh',
            payload: { source_kind: 'github', repo, ref },
          }
        : undefined,
    );
    if (eventId === null) return { received: true, duplicate: true };
    return { received: true, queued: event === 'push' && !!ref };
  });

  /** POST /api/knowledge/webhooks/notion — page 이벤트 → refresh 잡. */
  app.post('/api/knowledge/webhooks/notion', async (req, reply) => {
    const secret = process.env.NOTION_WEBHOOK_SECRET;
    const c = await getCtx();
    if (!c || !secret)
      return reply.code(503).send({ error: { code: 'KNOWLEDGE_DISABLED' } });
    const sig = (req.headers['x-notion-signature'] as string) ?? null;
    if (!verifyNotionSignature(secret, (req as any).rawBody ?? '', sig))
      return reply.code(401).send({ error: { code: 'BAD_SIGNATURE' } });
    const payload = req.body as any;
    // source 바인딩 (RAG-014): ACTIVE notion 소스가 정확히 하나일 때만 자동 매칭한다.
    // 여럿이면 페이지를 어느 소스로 보낼지 알 수 없으므로 무시한다.
    const sources = await kRows<{ id: string }>(
      sql`SELECT id FROM knowledge_sources WHERE kind='notion' AND status='ACTIVE'`,
      c.store.db,
    );
    if (sources.length !== 1)
      return { received: true, queued: false, ignored: 'ambiguous_notion_source' };
    const src = sources[0];
    // payload.id는 이벤트 id — 페이지 id로 쓰면 안 된다. data 안의 page id만 신뢰.
    const pageId = payload?.data?.page_id ?? payload?.data?.id ?? null;
    const { eventId } = await c.store.recordSourceEventWithJob(
      src.id,
      `ntn:${payload?.id ?? crypto.randomUUID()}`,
      `notion.${payload?.type ?? 'event'}`,
      payload,
      pageId
        ? {
            key: `ntn-refresh:${payload?.id ?? pageId}`,
            kind: 'refresh',
            payload: { source_kind: 'notion', page_id: pageId },
          }
        : undefined,
    );
    if (eventId === null) return { received: true, duplicate: true };
    return { received: true, queued: !!pageId };
  });

  /** GET /api/knowledge/search?q= — 디버그/탐색용 후보 청크 (검증 없음). */
  app.get('/api/knowledge/search', async (req, reply) => {
    const { ctx } = await requireCtx(req);
    const q = z.object({ q: z.string().min(1).max(500) }).parse(req.query);
    const project = await projectForAsker(ctx, deps.config.DISCORD_GUILD_ID);
    if (!project)
      return reply.code(403).send({ error: { code: 'PROJECT_SCOPE_DENIED' } });
    const chunks = await retrieve(ctx.store, {
      projectId: project.id,
      query: q.q,
      embeddings: ctx.embeddings,
      limit: 20,
      acl: { guilds: [deps.config.DISCORD_GUILD_ID] },
    });
    return {
      chunks: chunks.map((c) => ({
        source: c.source,
        stable_key: c.stable_key,
        score: c.score,
        excerpt: c.content.slice(0, 400),
      })),
    };
  });
}
