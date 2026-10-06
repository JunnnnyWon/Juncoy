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

/** Discord 라이브 읽기 — 질문마다 등록된 채널의 head를 재대조한다 (§11.1 단계 2). */
async function makeDiscordRead(store: KnowledgeStore, token: string) {
  const rest = new DiscordRest(token);
  return async (timeoutMs: number) => {
    const gaps: string[] = [];
    const deadline = Date.now() + timeoutMs;
    const channels = await kRows<{ channel_id: string; source_id: string }>(
      sql`SELECT DISTINCT split_part(scope_key, ':', 2) AS channel_id, source_id
          FROM connector_cursors
          WHERE scope_key LIKE 'channel:%'
            AND source_id IN (SELECT id FROM knowledge_sources WHERE kind='discord')`,
      store.db,
    );
    for (const c of channels) {
      if (Date.now() > deadline) {
        gaps.push(`timeout:${c.channel_id}`);
        break;
      }
      try {
        await new DiscordCollector(store, rest, '').reconcileHead(c.source_id, c.channel_id);
      } catch {
        gaps.push(`channel:${c.channel_id}`);
      }
    }
    return { ok: gaps.length === 0, gaps };
  };
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: Deps) {
  let ctx: KnowledgeCtx | null | Promise<KnowledgeCtx | null> = null;
  const getCtx = async (): Promise<KnowledgeCtx | null> => {
    if (ctx) return ctx;
    return (ctx = (async () => {
      const url = process.env.KNOWLEDGE_DATABASE_URL;
      if (!url) return null;
      const store = new KnowledgeStore(url);
      const on = (name: string) => process.env[name] === 'true';
      const embeddings =
        deps.config.UPSTAGE_API_KEY && on('KNOWLEDGE_ENABLED')
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
          ? await makeDiscordRead(store, deps.config.DISCORD_BOT_TOKEN)
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

  /** POST /api/knowledge/ask — 질문 → 검증된 Answer (§13.1). */
  app.post('/api/knowledge/ask', async (req, reply) => {
    const { session, ctx } = await requireCtx(req);
    const body = QuestionRequest.parse(req.body ?? {});
    const project = await first<{ id: string }>(
      sql`SELECT id FROM knowledge_projects ORDER BY created_at LIMIT 1`,
      ctx.store.db,
    );
    if (!project)
      return reply.code(503).send({ error: { code: 'INDEX_NOT_READY', message: '프로젝트가 없습니다.' } });
    const answer = await answerQuestion(
      {
        store: ctx.store,
        model: ctx.model,
        embeddings: ctx.embeddings,
        discordRead: ctx.discordRead,
        userId: session.user_id,
      },
      project.id,
      body,
    );
    return answer;
  });

  /** GET /api/knowledge/answer/:id — 완료된 실행의 Answer (§13.2 조회). */
  app.get('/api/knowledge/answer/:id', async (req) => {
    const { ctx } = await requireCtx(req);
    const id = z.uuid().parse((req.params as any).id);
    const run = await first<{ body: any; status: string; phase: string }>(
      sql`SELECT body, status, phase FROM answer_runs WHERE id=${id}`,
      ctx.store.db,
    );
    if (!run) return { status: 'FAILED' };
    return run.body ?? { status: run.status, phase: run.phase };
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

  /** GET /api/knowledge/search?q= — 디버그/탐색용 후보 청크 (검증 없음). */
  app.get('/api/knowledge/search', async (req) => {
    const { ctx } = await requireCtx(req);
    const q = z.object({ q: z.string().min(1).max(500) }).parse(req.query);
    const project = await first<{ id: string }>(
      sql`SELECT id FROM knowledge_projects ORDER BY created_at LIMIT 1`,
      ctx.store.db,
    );
    if (!project) return { chunks: [] };
    const chunks = await retrieve(ctx.store, {
      projectId: project.id,
      query: q.q,
      embeddings: ctx.embeddings,
      limit: 20,
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
