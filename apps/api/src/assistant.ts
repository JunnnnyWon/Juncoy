import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql, first, rows } from '@meeting/knowledge-db';
import { AssistantMode } from '@meeting/contracts';
import {
  ToolRegistry,
  registerReadTools,
  registerNotionReadTools,
  registerFileTools,
  registerNotionMutateTools,
  registerImageTools,
  listImages,
  getImage,
  NotionRest,
  GitHubRest,
  InstallationTokenProvider,
  UploadStorage,
  ensureUploadSource,
  extractUpload,
  UpstageDocumentParse,
  OpenRouterVision,
  magicOk,
  queueExtract,
  sha256,
  UPLOAD_MIMES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES_PER_REQ,
  UPLOAD_QUOTA_BYTES,
  type UploadMime,
  type ToolContext,
} from '@meeting/knowledge';
import type { AppConfig } from '@meeting/providers';
import type { Auth } from './auth.ts';
import { sharedKnowledgeCtx, findProjectForGuild, type KnowledgeCtx } from './knowledge.ts';

// 웹 어시스턴트 API — spec §13. 대화/run/SSE/승인/파일/이미지.
// 실행은 서버측 executor가 비동기로 하고 결과는 run_events로 흘러간다.

interface Deps {
  auth: Auth;
  config: AppConfig;
}

const APPROVAL_TTL_MS = () => Number(process.env.ASSISTANT_APPROVAL_TTL_MS ?? 600_000);
const SSE_HEARTBEAT_MS = () => Number(process.env.ASSISTANT_SSE_HEARTBEAT_MS ?? 15_000);

/** 질문을 실행 모드로 분류 — Solar structured. 실패 시 answer로 안전하게 떨어진다. */
async function classifyMode(
  ctx: KnowledgeCtx,
  text: string,
): Promise<z.infer<typeof AssistantMode>> {
  try {
    const out = z.object({ mode: AssistantMode });
    const res = await ctx.model.structured(
      out as unknown as z.ZodType<{ mode: z.infer<typeof AssistantMode> }>,
      { request: text },
      `사용자 요청을 실행 모드 하나로 분류한다.
- answer: 프로젝트 자료에 근거한 질문 답변 (기본값)
- search: 일정·작업·코드·파일 등 목록/조회
- propose: 변경은 하지 않고 계획·미리보기만
- mutate: Notion 일정/작업/페이지를 실제로 추가·수정
- generate: 이미지 생성 요청
- ingest: 파일을 지식에 추가
애매하면 answer. JSON으로 { "mode": "..." } 만 반환.`,
    );
    return res.result.mode;
  } catch {
    return 'answer';
  }
}

/**
 * assistant 실행기 — run을 한 단계씩 진행하면서 이벤트를 기록한다.
 * SSE는 run_events 테이블을 폴링해서 읽으므로 실행기는 이벤트를 DB에 쓰기만 한다.
 */
export function buildToolContext(
  ctx: KnowledgeCtx,
  projectId: string,
  userId: string,
  role: 'reader' | 'editor' | 'admin',
  config: AppConfig,
): ToolContext {
  const deps: Record<string, unknown> = {};
  if (process.env.NOTION_TOKEN) deps.notion = new NotionRest(process.env.NOTION_TOKEN);
  const appId = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const inst = process.env.GITHUB_APP_INSTALLATION_ID;
  if (appId && key && inst)
    deps.github = new GitHubRest(new InstallationTokenProvider(appId, key, inst));
  return {
    store: ctx.store,
    projectId,
    userId,
    role,
    acl: { guilds: [config.DISCORD_GUILD_ID] },
    model: ctx.model,
    embeddings: ctx.embeddings,
    discordRead: ctx.discordRead,
    deps,
  };
}

export function buildRegistry() {
  const reg = new ToolRegistry();
  registerReadTools(reg);
  registerNotionReadTools(reg);
  registerFileTools(
    reg,
    new UploadStorage(process.env.KNOWLEDGE_UPLOAD_DIR ?? '/data/knowledge/uploads'),
  );
  registerNotionMutateTools(reg);
  registerImageTools(
    reg,
    new UploadStorage(process.env.KNOWLEDGE_UPLOAD_DIR ?? '/data/knowledge/uploads'),
  );
  return reg;
}

/** 실행기 — fire-and-forget으로 돌린다. 취소는 단계 사이에서 확인. */
async function executeRun(
  ctx: KnowledgeCtx,
  config: AppConfig,
  registry: ToolRegistry,
  projectId: string,
  userId: string,
  role: 'reader' | 'editor' | 'admin',
  conversationId: string,
  runId: string,
  text: string,
) {
  const store = ctx.store;
  const phase = async (p: string) => {
    await store.updateRun(runId, { phase: p });
    await store.emitRunEvent(runId, 'phase', { phase: p });
  };
  const cancelled = async () => (await store.getRun(runId))?.cancelled === true;
  try {
    if (await cancelled()) return;
    await phase('planning_tool_call');
    const mode = await classifyMode(ctx, text);
    if (ctx.model) await store.updateRun(runId, { model: 'solar' });
    const tctx = buildToolContext(ctx, projectId, userId, role, config);

    let final: { status: string; phase: string; text: string; extra?: Record<string, any> };
    if (mode === 'answer') {
      await phase('retrieving');
      const r = await registry.execute(tctx, 'knowledge.ask', { question: text });
      if (!r.ok) throw new Error(r.error);
      const ans = r.result as any;
      for (const e of ans.evidence ?? []) await store.emitRunEvent(runId, 'evidence', e);
      await store.emitRunEvent(runId, 'coverage', { source_coverage: ans.source_coverage });
      final = {
        status: ans.status,
        phase:
          ans.status === 'COMPLETE' ? 'completed' : ans.status === 'FAILED' ? 'failed' : 'partial',
        text: ans.answer,
        extra: { answer_id: ans.answer_id, warnings: ans.warnings },
      };
    } else if (mode === 'search') {
      await phase('executing_tool');
      // 도구 선택 — 모델이 도구와 입력을 고른다 (registry가 스키마·권한으로 재검증).
      const plan = await pickTool(ctx, registry, text);
      if (!plan) {
        final = {
          status: 'NEEDS_CLARIFICATION',
          phase: 'partial',
          text: '조회 대상을 특정해 주세요 (일정/작업/코드/회의 전사).',
        };
      } else {
        const r = await registry.execute(tctx, plan.tool, plan.input);
        if (!r.ok) throw new Error(r.error);
        await store.emitRunEvent(runId, 'tool_call', {
          tool: plan.tool,
          status: 'DONE',
          input: plan.input,
        });
        final = {
          status: 'COMPLETE',
          phase: 'completed',
          text: JSON.stringify(r.result),
          extra: { tool: plan.tool, rows: Array.isArray(r.result) ? r.result.length : 1 },
        };
      }
    } else {
      // propose/mutate/generate/ingest — 승인 필요 작업은 preview 도구가 approval을 만든다.
      final = await handleActionMode(ctx, registry, tctx, mode, runId, text, projectId, userId);
    }

    if (await cancelled()) {
      await store.updateRun(runId, { phase: 'failed', status: 'FAILED', error: 'cancelled' });
      return;
    }
    const msgId = await store.createMessage(conversationId, 'assistant', final.text, {
      runId,
      citations: final.extra?.answer_id ? [{ answer_id: final.extra.answer_id }] : [],
    });
    await store.emitRunEvent(runId, 'result', {
      status: final.status,
      message_id: msgId,
      ...final.extra,
    });
    await store.updateRun(runId, {
      phase: final.phase === 'awaiting_approval' ? 'awaiting_approval' : final.phase,
      status: final.phase === 'awaiting_approval' ? undefined : (final.status as any),
    });
  } catch (err: any) {
    await store.emitRunEvent(runId, 'error', { message: String(err?.message ?? err) });
    await store.updateRun(runId, {
      phase: 'failed',
      status: 'FAILED',
      error: String(err?.message ?? err),
    });
    try {
      await store.createMessage(
        conversationId,
        'assistant',
        '처리 중 오류가 발생했습니다. 다시 시도해 주세요.',
        { runId },
      );
    } catch {
      /* best effort */
    }
  }
}

/** 모델이 read 도구 하나와 입력을 고른다 — registry의 스키마 이름만 허용. */
async function pickTool(ctx: KnowledgeCtx, registry: ToolRegistry, text: string) {
  const tools = registry
    .names()
    .filter(
      (n) =>
        n.endsWith('search') ||
        n.includes('query') ||
        n.includes('fetch') ||
        n.includes('refresh') ||
        n.includes('status'),
    )
    .join(', ');
  const schema = z.object({
    tool: z.string(),
    input: z.any(),
  });
  try {
    const res = await ctx.model.structured(
      schema as unknown as z.ZodType<{ tool: string; input: any }>,
      { request: text, available_tools: tools },
      `사용자 요청에 맞는 도구 하나와 입력을 고른다. 도구 이름은 제공된 목록에서만.
일정→notion.query_schedule, 작업→notion.query_tasks, 코드→github.search_code/fetch_file,
회의 전사→meeting.search_transcript, 지식 검색→knowledge.search, Discord 새로고침→discord.refresh_context.
못 고르면 tool에 "none". 입력은 각 도구 스키마에 맞게 최소한만.`,
    );
    if (res.result.tool === 'none' || !registry.has(res.result.tool)) return null;
    return { tool: res.result.tool, input: res.result.input ?? {} };
  } catch {
    return null;
  }
}

/** 액션 모드 — propose/mutate는 preview 도구로 approval 생성, generate는 이미지 preview. */
async function handleActionMode(
  ctx: KnowledgeCtx,
  registry: ToolRegistry,
  tctx: ToolContext,
  mode: z.infer<typeof AssistantMode>,
  runId: string,
  text: string,
  projectId: string,
  userId: string,
) {
  if (mode === 'ingest')
    return {
      status: 'NEEDS_CLARIFICATION',
      phase: 'partial',
      text: '파일은 어시스턴트 패널의 업로드 버튼으로 추가해 주세요. 업로드 후 자동으로 지식에 인덱싱됩니다.',
    };

  if (mode === 'generate') {
    const r = await registry.execute(tctx, 'image.preview_generation', { request: text });
    if (!r.ok)
      return {
        status: 'NEEDS_CLARIFICATION',
        phase: 'partial',
        text: `이미지 미리보기 실패: ${r.error}`,
      };
    const res = r.result as any;
    await ctx.store.emitRunEvent(runId, 'approval', {
      approval_id: res.approval_id,
      summary: res.summary,
    });
    return {
      status: 'PARTIAL',
      phase: 'awaiting_approval',
      text: `${res.summary}\n승인하면 이미지를 생성합니다. (10분 내 승인 필요)`,
      extra: { approval_id: res.approval_id },
    };
  }

  // propose / mutate — 모델이 preview 도구와 입력을 고른다.
  const previewTools = registry
    .names()
    .filter((n) => n.includes('preview'))
    .join(', ');
  let tool = '';
  let input: any = {};
  try {
    const res = await ctx.model.structured(
      z.object({ tool: z.string(), input: z.any() }) as unknown as z.ZodType<{
        tool: string;
        input: any;
      }>,
      { request: text, preview_tools: previewTools },
      `사용자 요청을 실행할 미리보기 도구 하나와 입력을 고른다. 도구 이름은 목록에서만.
일정 추가→notion.preview_create_schedule, 일정 수정→notion.preview_update_schedule(page_id 필요),
작업 추가→notion.preview_create_task, 작업 수정→notion.preview_update_task,
페이지 생성→notion.preview_create_page, 파일 삭제→file.preview_delete_or_replace(upload_id 필요).
수정 요청인데 page_id를 모르면 먼저 조회가 필요하다는 뜻이므로 tool에 "none".
입력은 해당 도구 스키마에 맞게. 못 고르면 "none".`,
    );
    tool = res.result.tool;
    input = res.result.input ?? {};
  } catch {
    /* 모델 실패 → 아래 안내 */
  }
  if (tool === 'none' || !tool || !registry.has(tool))
    return {
      status: 'NEEDS_CLARIFICATION',
      phase: 'partial',
      text: '요청을 실행할 미리보기로 변환하지 못했습니다. 무엇을 만들거나 바꿀지 더 구체적으로 알려주세요.',
    };
  const r = await registry.execute(tctx, tool, input);
  if (!r.ok)
    return {
      status: 'NEEDS_CLARIFICATION',
      phase: 'partial',
      text: `미리보기 생성 실패: ${r.error}`,
    };
  const res = r.result as any;
  await ctx.store.emitRunEvent(runId, 'approval', {
    approval_id: res.approval_id,
    summary: res.summary,
    warnings: res.warnings,
  });
  const warn = res.warnings?.length ? `\n경고: ${res.warnings.join(' / ')}` : '';
  return {
    status: 'PARTIAL',
    phase: 'awaiting_approval',
    text: `[미리보기] ${res.summary}${warn}\n승인하면 반영됩니다. 아래 승인 카드에서 확인해 주세요.`,
    extra: { approval_id: res.approval_id, tool },
  };
}

export function registerAssistantRoutes(app: FastifyInstance, deps: Deps) {
  app.setErrorHandler((error, _req, reply) => {
    const e = error as any;
    const status =
      e.statusCode ??
      e.status ??
      (e.code === 'KNOWLEDGE_DISABLED' ? 503 : e.code === 'PROJECT_SCOPE_DENIED' ? 403 : 503);
    return reply.code(status).send({
      error: {
        code: e.code ?? 'TEMPORARY_FAILURE',
        message: e.code ? e.message : '어시스턴트가 일시적으로 불안정합니다.',
      },
    });
  });

  const getCtx = sharedKnowledgeCtx(deps.config);
  const registry = buildRegistry();

  const requireSession = async (req: any) => {
    const session = await deps.auth.session(req.cookies.session);
    await deps.auth.check(session, deps.config.DISCORD_GUILD_ID);
    const c = await getCtx();
    if (!c || process.env.ASSISTANT_ENABLED !== 'true')
      throw Object.assign(new Error('assistant disabled'), {
        statusCode: 503,
        code: 'KNOWLEDGE_DISABLED',
      });
    const project = await findProjectForGuild(c, deps.config.DISCORD_GUILD_ID);
    if (!project)
      throw Object.assign(new Error('no project scope'), {
        statusCode: 403,
        code: 'PROJECT_SCOPE_DENIED',
      });
    // 역할 — project_memberships.role (기본 reader). 자동 승격 없음 (§11).
    const m = await first<{ role: string }>(
      sql`SELECT role FROM project_memberships WHERE project_id=${project.id} AND user_id=${session.user_id}`,
      c.store.db,
    );
    const role = (m?.role === 'admin' || m?.role === 'editor' ? m.role : 'reader') as
      'reader' | 'editor' | 'admin';
    return { session, ctx: c, projectId: project.id, role };
  };

  // ── 대화 ──────────────────────────────────────────────────────────
  app.post('/api/assistant/conversations', async (req) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const body = z.object({ title: z.string().max(120).optional() }).parse(req.body ?? {});
    const id = await ctx.store.createConversation(projectId, session.user_id, body.title);
    return { id };
  });

  app.get('/api/assistant/conversations', async (req) => {
    const { session, ctx, projectId } = await requireSession(req);
    return ctx.store.listConversations(projectId, session.user_id);
  });

  app.get('/api/assistant/conversations/:id', async (req) => {
    const { session, ctx, projectId } = await requireSession(req);
    const id = (req.params as any).id;
    const conv = await ctx.store.getConversation(projectId, id, session.user_id);
    if (!conv) return { not_found: true };
    const messages = await ctx.store.listMessages(id);
    const approvals = await ctx.store.listApprovals(projectId, session.user_id);
    return { conversation: conv, messages, pending_approvals: approvals };
  });

  app.delete('/api/assistant/conversations/:id', async (req, reply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const ok = await ctx.store.archiveConversation(
      projectId,
      (req.params as any).id,
      session.user_id,
    );
    if (!ok) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return { ok: true };
  });

  // ── 메시지 → run ──────────────────────────────────────────────────
  app.post('/api/assistant/conversations/:id/messages', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const conv = await ctx.store.getConversation(
      projectId,
      (req.params as any).id,
      session.user_id,
    );
    if (!conv || conv.archived) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const body = z
      .object({
        content: z.string().min(1).max(8000),
        attachments: z.array(z.string()).max(10).default([]),
      })
      .parse(req.body ?? {});
    const runId = await ctx.store.createRun(conv.id, 'answer');
    const messageId = await ctx.store.createMessage(conv.id, 'user', body.content, {
      runId,
      attachments: body.attachments,
    });
    // 비동기 실행 — 응답은 run_id만, 결과는 SSE로.
    void executeRun(
      ctx,
      deps.config,
      registry,
      projectId,
      session.user_id,
      role,
      conv.id,
      runId,
      body.content,
    );
    return reply.code(202).send({ run_id: runId, message_id: messageId });
  });

  app.get('/api/assistant/runs/:id', async (req, reply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const run = await ctx.store.getRun((req.params as any).id);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const conv = await ctx.store.getConversation(projectId, run.conversation_id, session.user_id);
    if (!conv) return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
    return run;
  });

  /** SSE — 매 tick ownership 재검증, heartbeat 15s, run 종료 시 종결. */
  app.get('/api/assistant/runs/:id/stream', async (req, reply: FastifyReply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const runId = (req.params as any).id;
    const run = await ctx.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const conv = await ctx.store.getConversation(projectId, run.conversation_id, session.user_id);
    if (!conv) return reply.code(403).send({ error: { code: 'FORBIDDEN' } });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let lastSeq = 0;
    let closed = false;
    req.raw.on('close', () => (closed = true));
    const heartbeat = SSE_HEARTBEAT_MS();
    let lastBeat = Date.now();
    const deadline = Date.now() + 10 * 60_000; // 스트림 상한 10분

    while (!closed && Date.now() < deadline) {
      // ownership 재검증 — 대화가 삭제/양도됐으면 끊는다 (§15).
      const still = await ctx.store.getConversation(
        projectId,
        run.conversation_id,
        session.user_id,
      );
      if (!still) break;
      const events = await ctx.store.runEvents(runId, lastSeq);
      for (const e of events) {
        lastSeq = Number(e.seq);
        reply.raw.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e.payload)}\n\n`);
      }
      const now = Date.now();
      if (now - lastBeat >= heartbeat) {
        reply.raw.write(`: hb\n\n`);
        lastBeat = now;
      }
      const fresh = await ctx.store.getRun(runId);
      if (fresh?.status || fresh?.cancelled) {
        reply.raw.write(
          `event: done\ndata: ${JSON.stringify({ status: fresh.status ?? 'FAILED' })}\n\n`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    reply.raw.end();
    return reply;
  });

  app.post('/api/assistant/runs/:id/cancel', async (req, reply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const run = await ctx.store.getRun((req.params as any).id);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const conv = await ctx.store.getConversation(projectId, run.conversation_id, session.user_id);
    if (!conv) return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
    await ctx.store.cancelRun(run.id);
    return { ok: true };
  });

  // ── 승인·action ───────────────────────────────────────────────────
  app.get('/api/assistant/approvals', async (req) => {
    const { session, ctx, projectId } = await requireSession(req);
    return ctx.store.listApprovals(projectId, session.user_id, false);
  });

  app.post('/api/assistant/approvals/:id/approve', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader')
      return reply
        .code(403)
        .send({ error: { code: 'ROLE_REQUIRED', message: 'editor 이상만 승인할 수 있습니다.' } });
    const outcome = await ctx.store.resolveApproval((req.params as any).id, session.user_id, true);
    if (outcome !== 'approved')
      return reply.code(409).send({ error: { code: outcome.toUpperCase() } });
    // 승인된 변경 실행 — commit 도구는 Phase 3에서 등록된다. 없으면 CONFLICT로 기록.
    const approval = await ctx.store.getApproval((req.params as any).id, projectId);
    const committed = approval
      ? await executeApproval(
          ctx,
          deps.config,
          registry,
          projectId,
          session.user_id,
          role,
          approval,
        )
      : false;
    return { approved: true, executed: committed };
  });

  app.post('/api/assistant/approvals/:id/reject', async (req, reply) => {
    const { session, ctx } = await requireSession(req);
    const outcome = await ctx.store.resolveApproval((req.params as any).id, session.user_id, false);
    if (outcome !== 'rejected')
      return reply.code(409).send({ error: { code: outcome.toUpperCase() } });
    return { rejected: true };
  });

  app.get('/api/assistant/actions', async (req) => {
    const { ctx, projectId } = await requireSession(req);
    return rows(
      sql`SELECT id, connector, target, action, before_hash, after_hash, status, error, created_at
          FROM assistant_audit WHERE project_id=${projectId} ORDER BY created_at DESC LIMIT 100`,
      ctx.store.db,
    );
  });

  // ── 일정·작업 read 패널 (spec §13) — reader 도구 그대로 통과 ────────
  app.get('/api/assistant/schedule', async (req) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const tctx = buildToolContext(ctx, projectId, session.user_id, role, deps.config);
    const r = await registry.execute(tctx, 'notion.query_schedule', {
      limit: Number((req.query as any).limit) || 50,
      status: (req.query as any).status,
    });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  // ── 이미지 (spec §12) ────────────────────────────────────────────
  app.post('/api/assistant/images/preview', async (req) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const tctx = buildToolContext(ctx, projectId, session.user_id, role, deps.config);
    const body = z.object({ request: z.string().min(1).max(2000) }).parse(req.body ?? {});
    const r = await registry.execute(tctx, 'image.preview_generation', body);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  // 명시적 생성 — 승인 + 실행을 한 번의 사용자 동작으로 (spec §13)
  app.post('/api/assistant/images/generate', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ approval_id: z.string().uuid() }).parse(req.body ?? {});
    const outcome = await ctx.store.resolveApproval(body.approval_id, session.user_id, true);
    if (outcome !== 'approved')
      return reply.code(409).send({ error: { code: outcome.toUpperCase() } });
    const approval = await ctx.store.getApproval(body.approval_id, projectId);
    const ok = approval
      ? await executeApproval(
          ctx,
          deps.config,
          registry,
          projectId,
          session.user_id,
          role,
          approval,
        )
      : false;
    return { executed: ok };
  });

  app.get('/api/assistant/images', async (req) => {
    const { ctx, projectId } = await requireSession(req);
    return listImages(ctx.store, projectId);
  });

  // 결과 파일 — 프로젝트 멤버에게만 (private 저장소, ACL 검증은 requireSession이 담당)
  app.get('/api/assistant/images/:id', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const img = await getImage(ctx.store, projectId, (req.params as any).id);
    if (!img) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const dir = process.env.KNOWLEDGE_UPLOAD_DIR ?? '/data/knowledge/uploads';
    const { createReadStream } = await import('node:fs');
    try {
      const stream = createReadStream(`${dir}/${img.storage_key}`);
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'private, max-age=3600')
        .send(stream);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }
  });

  // ── 파일 업로드 (spec §5): init → complete(바이트+magic) → 추출 잡 ──
  // 바이트 본문은 octet-stream으로 받는다 — 이 플러그인 스코프에서만 파서 등록.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  const storage = new UploadStorage(process.env.KNOWLEDGE_UPLOAD_DIR ?? '/data/knowledge/uploads');

  app.post('/api/assistant/files/init', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z
      .object({
        filename: z.string().min(1).max(200),
        mime: z.string(),
        bytes: z.number().int().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .parse(req.body ?? {});
    if (!(body.mime in UPLOAD_MIMES))
      return reply
        .code(400)
        .send({ error: { code: 'UNSUPPORTED_TYPE', message: '지원하지 않는 형식입니다.' } });
    if (body.bytes > UPLOAD_MAX_BYTES)
      return reply
        .code(400)
        .send({ error: { code: 'TOO_LARGE', message: '50MB를 초과했습니다.' } });
    if ((await ctx.store.uploadQuotaUsed(projectId)) + body.bytes > UPLOAD_QUOTA_BYTES)
      return reply.code(400).send({ error: { code: 'QUOTA_EXCEEDED' } });
    const { id, reused } = await ctx.store.createUpload({
      projectId,
      uploaderId: session.user_id,
      filename: body.filename,
      mime: body.mime,
      bytes: body.bytes,
      sha256: body.sha256,
      storageKey: `u-${body.sha256.slice(0, 24)}`,
    });
    return { id, storage_key: `u-${body.sha256.slice(0, 24)}`, reused };
  });

  app.post(
    '/api/assistant/files/:id/complete',
    { bodyLimit: UPLOAD_MAX_BYTES + 1024 * 1024 },
    async (req, reply) => {
      const { session, ctx, projectId, role } = await requireSession(req);
      if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
      const u = await ctx.store.getUpload(projectId, (req.params as any).id);
      if (!u) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      if (u.state !== 'UPLOADED' && u.state !== 'FAILED') return { id: u.id, state: u.state };
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || !buf.length)
        return reply.code(400).send({ error: { code: 'EMPTY_BODY' } });
      if (buf.length !== Number(u.bytes))
        return reply.code(400).send({ error: { code: 'SIZE_MISMATCH' } });
      if (sha256(buf) !== u.sha256)
        return reply.code(400).send({ error: { code: 'HASH_MISMATCH' } });
      if (!magicOk(buf, u.mime as UploadMime))
        return reply
          .code(400)
          .send({ error: { code: 'MAGIC_MISMATCH', message: '파일 내용이 형식과 다릅니다.' } });

      await storage.put(u.storage_key, buf);
      await ctx.store.updateUpload(u.id, { state: 'EXTRACTING', error: null });
      try {
        const documentParse =
          u.mime === 'application/pdf' &&
          process.env.UPSTAGE_DOCUMENT_PARSE_ENABLED === 'true' &&
          process.env.UPSTAGE_API_KEY &&
          process.env.UPSTAGE_DOCUMENT_PARSE_ENDPOINT
            ? new UpstageDocumentParse({
                apiKey: process.env.UPSTAGE_API_KEY,
                endpoint: process.env.UPSTAGE_DOCUMENT_PARSE_ENDPOINT,
                timeoutMs: Number(process.env.UPSTAGE_DOCUMENT_PARSE_TIMEOUT_MS ?? 60_000),
              })
            : undefined;
        const extracted = await extractUpload(buf, u.mime as UploadMime, {
          documentParse,
          expectedSha256: u.sha256,
        });
        let text = extracted.text;
        let vision: unknown;
        if (
          u.mime.startsWith('image/') &&
          process.env.OPENROUTER_VISION_ENABLED === 'true' &&
          process.env.OPENROUTER_API_KEY
        ) {
          const observation = await new OpenRouterVision(
            process.env.OPENROUTER_API_KEY,
            process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-3.7-flash',
          ).analyzeImage(buf, u.mime);
          vision = observation;
          text = [
            observation.description,
            observation.subjects.length ? 'Subjects: ' + observation.subjects.join(', ') : '',
            observation.materials.length ? 'Materials: ' + observation.materials.join(', ') : '',
            observation.lighting.length ? 'Lighting: ' + observation.lighting.join(', ') : '',
            observation.palette.length ? 'Palette: ' + observation.palette.join(', ') : '',
            observation.visible_text.length
              ? 'Visible text: ' + observation.visible_text.join(' | ')
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
        const sourceId = await ensureUploadSource(ctx.store, projectId);
        const stableKey = `upload:${u.id}`;
        await ctx.store.markDocumentDirty(sourceId, stableKey, {
          filename: u.filename,
          mime: u.mime,
          uploader: session.user_id,
        });
        const doc = await first<{ id: string }>(
          sql`SELECT id FROM documents WHERE source_id=${sourceId} AND stable_key=${stableKey}`,
          ctx.store.db,
        );
        await ctx.store.publishVersion(doc!.id, {
          contentHash: u.sha256,
          sourceRevision: u.sha256,
          normalized: {
            ...extracted.normalized,
            text,
            filename: u.filename,
            mime: u.mime,
            upload_id: u.id,
            vision,
          },
        });
        const uploadVersionId = await ctx.store.createUploadVersion({
          uploadId: u.id,
          extractorVersion: '2',
          sourceRevision: u.sha256,
          parserKind: extracted.parserKind,
          parserVersion: extracted.normalized.parser?.version,
          parseStatus: extracted.parseStatus,
          parseRequestId: extracted.normalized.parser?.request_id,
          parseErrorCode: extracted.parseError,
          sourceSha256: u.sha256,
          normalizedHash: createHash('sha256')
            .update(JSON.stringify(extracted.normalized))
            .digest('hex'),
        });
        await ctx.store.saveDocumentParseStructure(uploadVersionId, extracted.normalized);
        await queueExtract(ctx.store, doc!.id, u.sha256);
        await ctx.store.updateUpload(u.id, { state: 'INDEXING', documentId: doc!.id });
      } catch (err: any) {
        await ctx.store.updateUpload(u.id, { state: 'FAILED', error: String(err?.message ?? err) });
        return reply
          .code(422)
          .send({ error: { code: 'EXTRACT_FAILED', message: '텍스트 추출에 실패했습니다.' } });
      }
      return { id: u.id, state: 'INDEXING' };
    },
  );

  app.get('/api/assistant/files', async (req) => {
    const { ctx, projectId } = await requireSession(req);
    return ctx.store.listUploads(projectId);
  });

  app.get('/api/assistant/files/:id', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const u = await ctx.store.getUpload(projectId, (req.params as any).id);
    if (!u) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return u;
  });

  app.get('/api/assistant/files/:id/content', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const u = await ctx.store.getUpload(projectId, (req.params as any).id);
    if (!u || u.state === 'DELETED') return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    try {
      const bytes = await storage.read(u.storage_key);
      return reply
        .header('Content-Type', u.mime)
        .header('Content-Length', String(bytes.length))
        .header('Cache-Control', 'private, max-age=3600')
        .send(bytes);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }
  });

  app.get('/api/assistant/files/:id/parse', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const upload = await ctx.store.getUpload(projectId, (req.params as any).id);
    if (!upload) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const parsed = await ctx.store.getDocumentParse(projectId, upload.id);
    if (!parsed) return reply.code(404).send({ error: { code: 'PARSE_NOT_FOUND' } });
    return { upload_id: upload.id, source_sha256: upload.sha256, ...parsed };
  });

  app.post('/api/assistant/files/:id/reparse', async (req, reply) => {
    const { ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const upload = await ctx.store.getUpload(projectId, (req.params as any).id);
    if (!upload) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (upload.mime !== 'application/pdf')
      return reply.code(400).send({ error: { code: 'PARSE_PDF_ONLY' } });
    if (!upload.document_id)
      return reply.code(409).send({ error: { code: 'DOCUMENT_NOT_READY' } });
    const key = 'parse:' + upload.id + ':' + upload.sha256 + ':' + Date.now();
    await ctx.store.enqueueJob(key, 'parse', {
      upload_id: upload.id,
      project_id: projectId,
      document_id: upload.document_id,
      source_sha256: upload.sha256,
    });
    await ctx.store.updateUpload(upload.id, { state: 'EXTRACTING', error: null });
    return { queued: true, upload_id: upload.id, source_sha256: upload.sha256 };
  });

  app.post('/api/assistant/files/:id/ingest', async (req, reply) => {
    const { ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const u = await ctx.store.getUpload(projectId, (req.params as any).id);
    if (!u?.document_id) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    await queueExtract(ctx.store, u.document_id, u.sha256);
    await ctx.store.updateUpload(u.id, { state: 'INDEXING' });
    return { ok: true };
  });

  app.post('/api/assistant/files/:id/delete-preview', async (req) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const tctx = buildToolContext(ctx, projectId, session.user_id, role, deps.config);
    const r = await registry.execute(tctx, 'file.preview_delete_or_replace', {
      upload_id: (req.params as any).id,
    });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  app.get('/api/assistant/tasks', async (req) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const tctx = buildToolContext(ctx, projectId, session.user_id, role, deps.config);
    const r = await registry.execute(tctx, 'notion.query_tasks', {
      limit: Number((req.query as any).limit) || 50,
      status: (req.query as any).status,
    });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

  app.post('/api/assistant/art-boards', async (req) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader')
      throw Object.assign(new Error('editor required'), { statusCode: 403, code: 'ROLE_REQUIRED' });
    const body = z.object({ name: z.string().min(1).max(120).optional() }).parse(req.body ?? {});
    return { id: await ctx.store.createArtBoard(projectId, session.user_id, body.name) };
  });

  app.get('/api/assistant/art-boards', async (req) => {
    const { session, ctx, projectId } = await requireSession(req);
    return ctx.store.listArtBoards(projectId, session.user_id);
  });

  app.get('/api/assistant/art-boards/:id', async (req, reply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const board = await ctx.store.getArtBoard(projectId, session.user_id, (req.params as any).id);
    if (!board) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const revision = await ctx.store.getArtBoardRevision(projectId, session.user_id, board.id);
    return { board, revision };
  });

  app.post('/api/assistant/art-boards/:id/revisions', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z
      .object({
        base_revision: z.number().int().nonnegative(),
        snapshot: z.record(z.string(), z.any()),
      })
      .parse(req.body ?? {});
    const result = await ctx.store.saveArtBoardRevision({
      projectId,
      ownerId: session.user_id,
      boardId: (req.params as any).id,
      baseRevision: body.base_revision,
      snapshot: body.snapshot,
      snapshotHash: createHash('sha256').update(JSON.stringify(body.snapshot)).digest('hex'),
    });
    if (result.kind === 'NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (result.kind === 'CONFLICT')
      return reply
        .code(409)
        .send({ error: { code: 'REVISION_CONFLICT' }, current_revision: result.current_revision });
    return result;
  });

  app.post('/api/assistant/art-boards/:id/analyze', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    if (!ctx.model) return reply.code(503).send({ error: { code: 'MODEL_NOT_CONFIGURED' } });
    const board = await ctx.store.getArtBoard(projectId, session.user_id, (req.params as any).id);
    if (!board) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const revision = await ctx.store.getArtBoardRevision(projectId, session.user_id, board.id);
    if (!revision) return reply.code(409).send({ error: { code: 'REVISION_NOT_FOUND' } });
    const schema = z.object({
      summary: z.string(),
      common_rules: z.array(z.object({ category: z.string(), statement: z.string(), evidence_ids: z.array(z.string()) })),
      conflicts: z.array(z.object({ statement: z.string(), evidence_ids: z.array(z.string()) })),
      suggestions: z.array(z.object({ asset_id: z.string(), role: z.string(), usage: z.string(), observation: z.string() })),
    });
    const result = await ctx.model.structured(schema, { revision: revision.revision, references: (revision.snapshot as any)?.references ?? [] },
      '현재 아트 보드의 레퍼런스 메모와 역할만 분석한다. 관찰은 초안이며 승인된 Art Bible 규칙으로 간주하지 않는다. 이미지에 보이지 않는 권리, 사실, 스타일을 추정하지 않는다. 공통 규칙과 충돌을 분리하고 각 항목에 asset id를 evidence_ids로 연결한다.');
    const resultHash = createHash('sha256').update(JSON.stringify(result.result)).digest('hex');
    const analysisId = await ctx.store.saveArtBoardAnalysis({ boardId: board.id, revision: revision.revision, userId: session.user_id, model: result.model, result: result.result, resultHash });
    return { id: analysisId, board_id: board.id, revision: revision.revision, status: 'DRAFT', model: result.model, result: result.result, result_hash: resultHash };
  });

  app.get('/api/assistant/art-boards/:id/analysis/:revision', async (req, reply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const analysis = await ctx.store.getArtBoardAnalysis(projectId, session.user_id, (req.params as any).id, Number((req.params as any).revision));
    if (!analysis) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return analysis;
  });

  app.post('/api/assistant/art-boards/:id/analysis/:revision/approve', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ analysis_id: z.string().uuid() }).parse(req.body ?? {});
    const result = await ctx.store.approveArtBoardAnalysis({
      projectId,
      ownerId: session.user_id,
      boardId: (req.params as any).id,
      revision: Number((req.params as any).revision),
      analysisId: body.analysis_id,
      approvedBy: session.user_id,
    });
    if (result.kind === 'NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return result;
  });

  app.post('/api/assistant/art-boards/:id/image-briefs/preview', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const board = await ctx.store.getArtBoard(projectId, session.user_id, (req.params as any).id);
    if (!board) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const body = z
      .object({
        request: z.string().min(1).max(2000).default('캐릭터 컨셉 아트'),
        revision: z.number().int().positive().optional(),
      })
      .parse(req.body ?? {});
    const revision = await ctx.store.getArtBoardRevision(
      projectId,
      session.user_id,
      board.id,
      body.revision,
    );
    const refs = Array.isArray((revision?.snapshot as any)?.references)
      ? (revision!.snapshot as any).references.filter((ref: any) => ref.selected)
      : [];
    const candidateUploadIds = refs.map((ref: any) => ref.upload_id).filter(Boolean);
    const uploads = await ctx.store.getUploadsByIds(projectId, candidateUploadIds);
    const readyIds = new Set(uploads.filter((upload: any) => upload.state === 'READY').map((upload: any) => upload.id));
    const usableRefs = refs.filter((ref: any) =>
      Boolean(ref.upload_id) && readyIds.has(ref.upload_id) && ref.usage !== 'EXCLUDED' && ref.usage !== 'REVIEW_REQUIRED',
    );
    const referenceUploadIds = usableRefs.map((ref: any) => ref.upload_id).filter(Boolean);
    const referenceInstructions = Object.fromEntries(
      usableRefs.map((ref: any) => [ref.upload_id, ref.role + ': ' + ref.note]),
    );
    const providerReady =
      role !== 'reader' &&
      process.env.IMAGE_GENERATION_ENABLED === 'true' &&
      Boolean(process.env.OPENROUTER_API_KEY);
    const approvalId = providerReady
      ? await ctx.store.createApproval({
          projectId,
          userId: session.user_id,
          kind: 'image_generate',
          target: {
            board_id: board.id,
            board_revision: revision?.revision ?? board.current_revision,
            reference_upload_ids: referenceUploadIds,
          },
          beforeHash: null,
          after: {
            prompt:
              body.request +
              '\n\nArt direction:\n' +
              usableRefs.map((ref: any) => ref.role + ': ' + ref.note).join('\n'),
            negative: '글자, 워터마크, 로고, 저해상도, 왜곡된 손, 어색한 비율',
            model: 'openai/gpt-image-2.5-flare',
            reference_upload_ids: referenceUploadIds,
            reference_instructions: referenceInstructions,
            evidence: [
              { board_id: board.id, revision: revision?.revision ?? board.current_revision },
            ],
          },
          expiresAt: new Date(
            Date.now() + Number(process.env.ASSISTANT_APPROVAL_TTL_MS ?? 600_000),
          ),
        })
      : undefined;
    return {
      status: 'DRAFT',
      board_id: board.id,
      board_revision: revision?.revision ?? board.current_revision,
      request: body.request,
      model: 'openai/gpt-image-2.5-flare',
      provider: 'openrouter',
      references: refs.map((ref: any) => ({
        asset_key: ref.id,
        upload_id: ref.upload_id,
        role: ref.role,
        usage: ref.usage,
        note: ref.note,
        ready: Boolean(ref.upload_id && readyIds.has(ref.upload_id)),
      })),
      reference_upload_ids: refs.map((ref: any) => ref.upload_id).filter(Boolean),
      approval_id: approvalId,
      generation_ready: Boolean(approvalId),
      blocked_reference_count: refs.length - usableRefs.length,
      instructions: usableRefs.map((ref: any) => ref.role + ': ' + ref.note).join('\n'),
      note: 'ImageBrief 초안입니다. 승인 후 OpenRouter 이미지 생성으로 전달됩니다.',
    };
  });
}

/**
 * 승인된 preview를 실제 commit 도구로 실행한다.
 * before_hash 재검증은 각 commit 도구가 한다 (spec §10 단계 7).
 * Phase 3에서 notion commit 도구가 등록되면 실제 경로로 들어간다.
 */
async function executeApproval(
  ctx: KnowledgeCtx,
  config: AppConfig,
  registry: ToolRegistry,
  projectId: string,
  userId: string,
  role: 'reader' | 'editor' | 'admin',
  approval: any,
): Promise<boolean> {
  const toolName =
    approval.kind === 'notion_schedule'
      ? 'notion.commit_schedule_change'
      : approval.kind === 'notion_task'
        ? 'notion.commit_task_change'
        : approval.kind === 'notion_page'
          ? 'notion.commit_page_change'
          : approval.kind === 'file_delete'
            ? 'file.commit_delete_or_replace'
            : approval.kind === 'image_generate'
              ? 'image.generate'
              : null;
  if (!toolName || !registry.has(toolName)) {
    await ctx.store.audit({
      projectId,
      actor: userId,
      connector: approval.kind.split('_')[0],
      target: approval.target,
      action: 'commit',
      status: 'FAILED',
      error: 'commit_tool_unregistered',
    });
    return false;
  }
  if (!(await ctx.store.consumeApproval(approval.id))) return false; // 1회성
  const tctx = buildToolContext(ctx, projectId, userId, role, config);
  const r = await registry.execute(
    tctx,
    toolName,
    { approval_id: approval.id, after: approval.after },
    `approval:${approval.id}`,
  );
  await ctx.store.audit({
    projectId,
    actor: userId,
    connector: approval.kind.split('_')[0],
    target: approval.target,
    action: toolName,
    status: r.ok ? 'DONE' : 'FAILED',
    error: r.ok ? undefined : r.error,
  });
  return r.ok;
}
