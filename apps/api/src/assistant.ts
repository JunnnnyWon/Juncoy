import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { selectReferences } from '../../../packages/knowledge/src/image-selection.ts';
import { z } from 'zod';
import { sql, first, rows } from '@meeting/knowledge-db';
import { AssistantMode, ArtBoardSnapshot, ImageBrief, ImageBriefDraft, ImageGenerationPlan, imageBriefHashInput } from '@meeting/contracts';
import {
  ToolRegistry,
  registerReadTools,
  registerNotionReadTools,
  registerFileTools,
  registerNotionMutateTools,
  registerImageTools,
  listImages,
  getImage,
  reviewImageResult,
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
  buildImagePrompt,
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

async function summarizeConversationTitle(ctx: KnowledgeCtx, firstMessage: string) {
  try {
    const result = await ctx.model.structured(
      z.object({ title: z.string().min(2).max(36) }),
      { first_message: firstMessage },
      '첫 사용자 메시지를 보고 대화 제목을 만든다. 한국어 2~8단어, 36자 이내로 작성한다. 질문의 핵심 주제만 남기고 날짜, 이모지, 따옴표, 마침표, 대화라는 단어는 쓰지 않는다. JSON으로 title만 반환한다.',
    );
    return result.result.title.trim().replace(/["'“”‘’.,!?]/g, '').slice(0, 36) || '새 대화';
  } catch {
    return firstMessage.replace(/\s+/g, ' ').trim().slice(0, 32) || '새 대화';
  }
}

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
const conversationQueue = new Map<string, Promise<void>>();
async function executeRun(...args: Parameters<typeof executeRunInOrder>) {
  const key = args[6];
  const task = (conversationQueue.get(key) ?? Promise.resolve()).catch(() => {}).then(() => executeRunInOrder(...args));
  conversationQueue.set(key, task);
  try { await task; } finally { if (conversationQueue.get(key) === task) conversationQueue.delete(key); }
}
async function executeRunInOrder(
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
    const allMessages = await store.listMessages(conversationId, 1000);
    const currentIndex = allMessages.findIndex(message => message.run_id === runId && message.role === "user");
    const history = currentIndex >= 0 ? allMessages.slice(0, currentIndex + 1) : allMessages;
    const conversationImages = history.flatMap(message => (message.attachments as any[]).filter(image => image?.type === "generated_image").map(image => ({ ...image, message_id: message.id, response: message.content })));
    const current = history.find(message => message.run_id === runId && message.role === "user");
    const explicitTarget = (current?.attachments as any[])?.find(item => item?.type === "edit_image")?.id;
    let mode = await classifyMode(ctx, text);
    let parentImageId: string | undefined;
    let referenceImages: { id: string; instruction: string }[] = [];
    let generationRequest = text;
    if (conversationImages.length || explicitTarget) {
      const plan = await ctx.model.structured(z.object({ intent: z.enum(["new", "edit", "variant", "question", "other"]), image_number: z.number().int().nonnegative(), change: z.string().max(1000), preserve: z.string().max(1000), references: z.array(z.object({ image_number: z.number().int().positive(), instruction: z.string().min(1).max(500) })).max(15) }), { request: text, selected_image_id: explicitTarget, images: conversationImages.map((image, index) => ({ number: index + 1, id: image.id, prompt: String(image.prompt).slice(0, 1600), parent_image_id: image.parent_image_id, reference_images: image.reference_images, user_request: image.user_request })), conversation: history.slice(-30).map(message => ({ role: message.role, content: message.content.slice(0, 2000), image_ids: (message.attachments as any[]).filter(item => item?.type === "generated_image").map(item => item.id) })) }, "대화 전체 맥락으로 이미지 작업과 참조를 능동적으로 결정한다. 사용자는 이미지 순번을 말할 필요가 없다. 더 밝게, 이 느낌 유지, 이전 분위기로, 다시 수정 등은 기존 이미지 편집이다. 최근 성공 이미지는 명시적 부분 수정일 때만 기본 기준이다. 새 인물·새 장소·다른 후보·UI 신규 생성 요청에 이전 인물/의상/행동/구도를 자동 상속하지 않는다. variant는 화풍만 계승하고 preserve에 인물과 구도를 넣지 않는다. 씬 변경과 HUD 유지는 edit로 선택하되 preserve에는 HUD만 넣는다. 명시 선택 또는 이전 대화에서 지목한 인물/배경/조명에 맞는 이미지가 있으면 그 대상을 선택한다. new는 기존 결과와 무관한 새 생성, variant는 다른 후보, question은 설명만 하는 질문, other는 이미지 무관 요청이다. image_number는 주 원본 순번. references에는 이전 대화의 요구와 누적 참조 관계를 읽고 필요한 보조 이미지와 그 용도(인물, 배경, 조명 등)를 선택한다. 사용자가 순번을 명시하지 않아도 이전에 좋아했던 조명이나 배경을 가져오라고 하면 해당 이미지를 찾는다. 단순 밝기 변경은 주 원본만 사용하고, 과거 참조가 필요한 복합 요청만 보조를 추가한다. 관련 없는 이미지는 넣지 않는다. 주 원본은 references에서 제외. 서로 다른 대상이 똑같이 가능해 결정 불가능할 때만 image_number=0. change와 preserve는 짧고 구체적인 한국어, JSON 전체를 간결하게 반환한다.");
      if (["edit", "variant"].includes(plan.result.intent) || explicitTarget || (/유지/.test(text) && /씬|장면|배경/.test(text))) {
        const target = explicitTarget ? conversationImages.find(image => image.id === explicitTarget) : conversationImages[plan.result.image_number - 1] ?? (/유지/.test(text) && /씬|장면|배경/.test(text) ? conversationImages.at(-1) : undefined);
        if (!target) throw new Error("어느 이미지를 수정할지 대화에서 알려 주세요.");
        mode = "generate"; parentImageId = target.id;
        referenceImages = plan.result.references.map(ref => { const image = conversationImages[ref.image_number - 1]; if (!image) throw new Error("대화의 참고 이미지를 확인하지 못했습니다. 다시 요청해 주세요."); return { id: image.id, instruction: ref.instruction }; }).filter((ref, index, all) => ref.id !== parentImageId && all.findIndex(item => item.id === ref.id) === index);
        generationRequest = [plan.result.intent === "variant" ? "다른 후보 생성. 화풍만 유지하고 인물·행동·장소·구도는 새롭게 구성한다." : "기존 이미지 수정. 아래 유지 대상으로 명시된 요소만 유지한다.", "이번 요청: " + text, "변경: " + plan.result.change, "유지: " + plan.result.preserve].join("\n").slice(0, 4000);
      } else if (plan.result.intent === "question") mode = "answer";
    }
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
        extra: { answer_id: ans.answer_id, warnings: ans.warnings, evidence: ans.evidence ?? [] },
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
      final = await handleActionMode(ctx, registry, tctx, mode, runId, generationRequest, projectId, userId, parentImageId, referenceImages);
    }

    if (await cancelled()) {
      await store.updateRun(runId, { phase: 'failed', status: 'FAILED', error: 'cancelled' });
      return;
    }
    const msgId = await store.createMessage(conversationId, 'assistant', final.text, {
      runId,
      attachments: final.extra?.images ?? [],
      citations: final.extra?.evidence ?? (final.extra?.answer_id ? [{ answer_id: final.extra.answer_id }] : []),
    });
    // Provider responses are structured rather than token-streamed. Emit safe deltas so the UI
    // can show progress immediately without changing the provider contract.
    for (let offset = 0; offset < final.text.length; offset += 80) {
      await store.emitRunEvent(runId, 'delta', { text: final.text.slice(offset, offset + 80), done: offset + 80 >= final.text.length });
    }
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
  parentImageId?: string,
  referenceImages: { id: string; instruction: string }[] = [],
) {
  if (mode === 'ingest')
    return {
      status: 'NEEDS_CLARIFICATION',
      phase: 'partial',
      text: '파일은 어시스턴트 패널의 업로드 버튼으로 추가해 주세요. 업로드 후 자동으로 지식에 인덱싱됩니다.',
    };

  if (mode === 'generate') {
    const preview = await ctx.previewArtBoard?.(projectId, userId, tctx.role, text, parentImageId, referenceImages);
    const r = preview ? { ok: true, result: { ...preview, summary: "요청별 참고 자료 · " + preview.reference_upload_ids.length + "개 보드 원본" } } : { ok: false, error: "아트보드 연결을 확인해 주세요." };
    if (!r.ok)
      return {
        status: 'NEEDS_CLARIFICATION',
        phase: 'partial',
        text: `이미지 미리보기 실패: ${r.error}`,
      };
    const res = r.result as any;
    if (!res.approval_id) throw new Error('이미지 생성 기능을 사용할 수 없습니다.');
    const run = await ctx.store.getRun(runId);
    await sql`UPDATE assistant_approvals SET conversation_id=${run?.conversation_id ?? null}, run_id=${runId} WHERE id=${res.approval_id} AND user_id=${userId}`.execute(ctx.store.db);
    await ctx.store.emitRunEvent(runId, 'approval', { approval_id: res.approval_id });
    return { status: 'PARTIAL', phase: 'awaiting_approval', text: '이미지 생성 조건을 준비했습니다. 유지·변경 요소와 참고 목적을 확인한 뒤 승인해 주세요.', extra: { approval_id: res.approval_id, generation_plan: res.brief?.plan } };
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
  app.setErrorHandler((error, req, reply) => {
    const e = error as any;
    req.log.error({ error_name: e.name, error_code: e.code, provider_status: e.providerStatus, path: req.url.split('?')[0] }, 'assistant request failed');
    const status =
      (e instanceof z.ZodError ? 502 : undefined) ?? e.statusCode ??
      e.status ??
      (e.code === 'KNOWLEDGE_DISABLED' ? 503 : e.code === 'PROJECT_SCOPE_DENIED' ? 403 : 503);
    return reply.code(status).send({
      error: {
        code: status === 429 ? 'RATE_LIMITED' : e instanceof z.ZodError ? 'MODEL_OUTPUT_INVALID' : e.code ?? 'TEMPORARY_FAILURE',
        message: status === 429 ? '요청이 잠시 몰렸습니다. 잠시 후 다시 시도해 주세요.' : e instanceof z.ZodError ? '자동 분석 결과의 형식이 올바르지 않습니다. 다시 시도해 주세요.' : e.code ? e.message : '어시스턴트가 일시적으로 불안정합니다.',
        retryable: status === 429 || status >= 500,
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
    c.previewArtBoard = async (projectId, userId, role, request, parentImageId, referenceImages) => {
      const boards = await c.store.listArtBoards(projectId, userId);
      if (!boards[0]) throw Object.assign(new Error("아트보드에 참고 이미지를 먼저 추가해 주세요."), { code: "ART_BOARD_REQUIRED", statusCode: 409 });
      return previewArtBoard(c, projectId, userId, role, boards[0].id, { request, parent_image_id: parentImageId, reference_images: referenceImages });
    };
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

  app.patch('/api/assistant/conversations/:id', async (req, reply) => {
    const { session, ctx, projectId } = await requireSession(req);
    const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
    const ok = await ctx.store.updateConversationTitle(projectId, (req.params as any).id, session.user_id, body.title);
    if (!ok) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return { ok: true, title: body.title };
  });

  app.delete('/api/assistant/conversations', async (req) => {
    const { session, ctx, projectId } = await requireSession(req);
    return { ok: true, deleted: await ctx.store.deleteAllConversations(projectId, session.user_id) };
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
        attachments: z.array(z.union([z.string(), z.object({ type: z.literal("edit_image"), id: z.string().uuid() })])).max(10).default([]),
      })
      .parse(req.body ?? {});
    const existingMessages = await ctx.store.listMessages(conv.id, 1);
    const runId = await ctx.store.createRun(conv.id, 'answer');
    const messageId = await ctx.store.createMessage(conv.id, 'user', body.content, {
      runId,
      attachments: body.attachments,
    });
    let generatedTitle: string | undefined;
    if (!existingMessages.length && conv.title === '새 대화') {
      const title = await summarizeConversationTitle(ctx, body.content);
      await ctx.store.updateConversationTitle(projectId, conv.id, session.user_id, title);
      generatedTitle = title;
    }
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
    return reply.code(202).send({ run_id: runId, message_id: messageId, title: generatedTitle });
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
    if (committed && approval?.kind === 'image_generate' && approval.conversation_id) {
      const image = await first<any>(sql`SELECT r.*, j.prompt, j.model, j.options FROM image_results r JOIN image_jobs j ON j.id=r.job_id WHERE j.approval_id=${approval.id} AND j.project_id=${projectId}`, ctx.store.db);
      if (image) await ctx.store.createMessage(approval.conversation_id, 'assistant', '이미지 생성이 완료됐습니다. 이미지를 눌러 크게 볼 수 있습니다.', {
        runId: approval.run_id ?? undefined, attachments: [{ ...image, type: 'generated_image', parent_image_id: image.options?.parent_image_id ?? null, reference_images: image.options?.reference_images ?? [], user_request: approval.after?.image_brief?.request }],
      });
    }
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
        .header('Content-Type', img.mime ?? 'image/png')
        .header('Cache-Control', 'private, max-age=3600')
        .send(stream);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }
  });

  app.post('/api/assistant/images/:id/review', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({
      status: z.enum(['REVIEW', 'APPROVED_CANONICAL', 'REJECTED']),
      review_role: z.string().min(1).max(80).default('art_reference'),
      note: z.string().max(1000).optional(),
    }).parse(req.body ?? {});
    const ok = await reviewImageResult(ctx.store, projectId, (req.params as any).id, session.user_id, body.status, body.review_role, body.note);
    if (!ok) return reply.code(409).send({ error: { code: body.status === 'APPROVED_CANONICAL' ? 'CANONICAL_RIGHTS_REQUIRED' : 'NOT_FOUND' } });
    return { reviewed: true, status: body.status };
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
      await ctx.store.enqueueJob('ingest:' + u.id + ':' + u.sha256, 'parse', {
        upload_id: u.id, project_id: projectId, source_sha256: u.sha256,
      });
      await ctx.store.updateUpload(u.id, { state: 'EXTRACTING', error: null });
      return reply.code(202).send({ id: u.id, state: 'EXTRACTING' });
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

  app.post('/api/assistant/art-assets/init', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ upload_id: z.string().uuid(), source_label: z.string().max(200).optional(), rights_note: z.string().max(1000).optional() }).parse(req.body ?? {});
    const id = await ctx.store.createArtReferenceAsset({ projectId, uploadId: body.upload_id, label: body.source_label, rightsNote: body.rights_note, createdBy: session.user_id });
    if (!id) return reply.code(400).send({ error: { code: 'INVALID_ART_ASSET' } });
    return { id };
  });

  app.get('/api/assistant/art-assets/:id', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const asset = await ctx.store.getArtReferenceAsset(projectId, (req.params as any).id);
    if (!asset) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return asset;
  });

  app.get('/api/assistant/art-assets/:id/content', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const asset = await ctx.store.getArtReferenceAsset(projectId, (req.params as any).id);
    if (!asset || asset.upload_state === 'DELETED') return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    try {
      const bytes = await storage.read(asset.storage_key);
      if (sha256(bytes) !== asset.sha256) return reply.code(409).send({ error: { code: 'SOURCE_HASH_MISMATCH' } });
      return reply.header('Content-Type', asset.mime).header('Content-Length', String(bytes.length)).header('Cache-Control', 'private, max-age=3600').send(bytes);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }
  });

  app.get('/api/assistant/art-assets/:id/extraction', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const extraction = await ctx.store.getLatestArtExtraction(projectId, (req.params as any).id);
    if (!extraction) return reply.code(404).send({ error: { code: 'EXTRACTION_NOT_FOUND' } });
    return extraction;
  });

  app.patch('/api/assistant/art-assets/:id/extraction', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ corrections: z.record(z.string(), z.unknown()) }).parse(req.body ?? {});
    const result = await ctx.store.updateArtExtractionCorrections(projectId, (req.params as any).id, body.corrections);
    if (!result) return reply.code(404).send({ error: { code: 'EXTRACTION_NOT_FOUND' } });
    return { ...result, updated_by: session.user_id };
  });

  app.post('/api/assistant/art-assets/:id/analyze', async (req, reply) => {
    const { ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const asset = await ctx.store.getArtReferenceAsset(projectId, (req.params as any).id);
    if (!asset) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_VISION_ENABLED !== 'true')
      return reply.code(503).send({ error: { code: 'VISION_NOT_CONFIGURED' } });
    const bytes = await storage.read(asset.storage_key);
    if (sha256(bytes) !== asset.sha256) return reply.code(409).send({ error: { code: 'SOURCE_HASH_MISMATCH' } });
    const observation = await new OpenRouterVision(
      process.env.OPENROUTER_API_KEY,
      process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-3.7-flash',
    ).analyzeImage(bytes, asset.mime);
    const extractionId = await ctx.store.saveArtExtraction({ assetId: asset.id, revision: asset.sha256, model: observation.model, observations: observation, ocr: { visible_text: observation.visible_text }, confidence: observation.confidence_note });
    if (!extractionId) return reply.code(409).send({ error: { code: 'ART_ASSET_UNAVAILABLE' } });
    return { id: extractionId, asset_id: asset.id, asset_revision: asset.sha256, status: 'DRAFT', model: observation.model, observations: observation };
  });

  app.patch('/api/assistant/art-assets/:id/rights-note', async (req, reply) => {
    const { ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ rights_note: z.string().max(1000) }).parse(req.body);
    const result = await sql`UPDATE art_reference_assets SET rights_note=${body.rights_note}, updated_at=now()
      WHERE id=${(req.params as any).id} AND project_id=${projectId}`.execute(ctx.store.db);
    if (!Number(result.numAffectedRows)) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return { saved: true };
  });

  app.post('/api/assistant/art-assets/:id/canonical-review', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ state: z.enum(['NONE', 'REVIEW', 'APPROVED_CANONICAL', 'REJECTED', 'ARCHIVED']), rights_note: z.string().max(1000).optional() }).parse(req.body ?? {});
    if (body.state === 'APPROVED_CANONICAL' && !body.rights_note?.trim()) {
      const asset = await ctx.store.getArtReferenceAsset(projectId, (req.params as any).id);
      if (asset && !asset.rights_note?.trim()) return reply.code(409).send({ error: { code: 'REFERENCE_RIGHTS_REQUIRED' } });
    }
    const ok = await ctx.store.reviewArtReferenceAsset(projectId, (req.params as any).id, session.user_id, body.state, body.rights_note);
    if (!ok) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return { reviewed: true, canonical_state: body.state };
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
      force: true,
    });
    await ctx.store.updateUpload(upload.id, { state: 'EXTRACTING', error: null });
    return { queued: true, upload_id: upload.id, source_sha256: upload.sha256 };
  });

  app.get('/api/assistant/files/:id/derived-assets/:assetId', async (req, reply) => {
    const { ctx, projectId } = await requireSession(req);
    const a = await ctx.store.getParseDerivative(projectId, (req.params as any).id, (req.params as any).assetId);
    if (!a) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const bytes = await storage.read(a.storage_key);
    if (sha256(bytes) !== a.sha256) return reply.code(409).send({ error: { code: 'DERIVED_HASH_MISMATCH' } });
    return reply.type(a.mime).header('Cache-Control', 'private, no-store').send(bytes);
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

  app.get('/api/assistant/art-boards/:id/history', async (req) => {
    const { session, ctx, projectId } = await requireSession(req);
    return ctx.store.listArtBoardHistory(projectId, session.user_id, (req.params as any).id);
  });

  app.patch('/api/assistant/art-boards/:id', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body ?? {});
    const board = await ctx.store.renameArtBoard(projectId, session.user_id, (req.params as any).id, body.name);
    if (!board) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return board;
  });

  app.post('/api/assistant/art-boards/:id/archive', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const board = await ctx.store.archiveArtBoard(projectId, session.user_id, (req.params as any).id);
    if (!board) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return { archived: true, ...board };
  });

  app.post('/api/assistant/art-boards/:id/restore-revision', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ revision: z.number().int().nonnegative() }).parse(req.body ?? {});
    const result = await ctx.store.restoreArtBoardRevision(projectId, session.user_id, (req.params as any).id, body.revision);
    if (result.kind === 'NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (result.kind === 'CONFLICT') return reply.code(409).send({ error: { code: 'REVISION_CONFLICT' } });
    return result;
  });

  app.get('/api/assistant/art-boards/:id/shares', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    const owner = await ctx.store.getArtBoardOwner(projectId, (req.params as any).id);
    if (!owner || (owner.owner_id !== session.user_id && role !== 'admin')) return reply.code(403).send({ error: { code: 'BOARD_OWNER_REQUIRED' } });
    const shares = await ctx.store.listArtBoardShares(projectId, session.user_id, (req.params as any).id);
    return shares;
  });

  app.post('/api/assistant/art-boards/:id/shares', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role !== 'admin') return reply.code(403).send({ error: { code: 'ADMIN_REQUIRED' } });
    const body = z.object({ user_id: z.string().min(1).max(100), role: z.enum(['reader', 'editor']) }).parse(req.body ?? {});
    const share = await ctx.store.shareArtBoard(projectId, session.user_id, (req.params as any).id, body.user_id, body.role);
    if (!share) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return share;
  });

  app.delete('/api/assistant/art-boards/:id/shares/:userId', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role !== 'admin') return reply.code(403).send({ error: { code: 'ADMIN_REQUIRED' } });
    const removed = await ctx.store.removeArtBoardShare(projectId, session.user_id, (req.params as any).id, (req.params as any).userId);
    if (!removed) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return { removed: true };
  });

  app.post('/api/assistant/art-boards/:id/revisions', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    if (!(await ctx.store.canEditArtBoard(projectId, session.user_id, (req.params as any).id))) return reply.code(403).send({ error: { code: 'BOARD_EDITOR_REQUIRED' } });
    const body = z
      .object({
        base_revision: z.number().int().nonnegative(),
        snapshot: ArtBoardSnapshot,
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
    if (!(await ctx.store.canEditArtBoard(projectId, session.user_id, (req.params as any).id))) return reply.code(403).send({ error: { code: 'BOARD_EDITOR_REQUIRED' } });
    if (!ctx.model) return reply.code(503).send({ error: { code: 'MODEL_NOT_CONFIGURED' } });
    const board = await ctx.store.getArtBoard(projectId, session.user_id, (req.params as any).id);
    if (!board) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const revision = await ctx.store.getArtBoardRevision(projectId, session.user_id, board.id);
    if (!revision) return reply.code(409).send({ error: { code: 'REVISION_NOT_FOUND' } });
    const refs = ((revision.snapshot as any)?.references ?? []).filter((ref: any) => !ref.excluded);
    const uploadIds = refs.map((ref: any) => ref.upload_id).filter(Boolean);
    const extractions = await ctx.store.getArtExtractionsForUploads(projectId, uploadIds);
    const schema = z.object({
      summary: z.string(),
      appearance: z.object({ character: z.string(), materials: z.string(), overall: z.string() }),
      common_rules: z.array(z.object({ category: z.string(), statement: z.string(), evidence_ids: z.array(z.string()) })),
      conflicts: z.array(z.object({ statement: z.string(), evidence_ids: z.array(z.string()) })),
      suggestions: z.array(z.object({ asset_id: z.string(), role: z.string(), usage: z.string(), observation: z.string() })),
    });
    const result = await ctx.model.structured(schema, { revision: revision.revision, references: refs, extractions, nodes: (revision.snapshot as any)?.nodes ?? [], edges: (revision.snapshot as any)?.edges ?? [] },
      '현재 보드의 참고 이미지, AI 이미지 설명, 사람 수정값, 팀 메모, 프레임만 분석한다. 사람 수정값과 역할별 지시를 우선한다. 기획자와 아트 담당자가 바로 이해할 쉬운 한국어로 원하는 모습과 작업 기준을 설명한다. appearance.character는 캐릭터의 형태와 그림체, materials는 옷과 소품의 재질, overall은 최종 느낌이다. 각 항목은 2~3개의 짧은 문장으로 무엇을 따라야 하는지 구체적으로 쓴다. summary는 이 세 항목을 요약한다. 사용자에게 보이는 문장에 revision, MUST_FOLLOW, STRONG_REFERENCE, mood_only, asset id, 파생 근거, canonical 같은 내부 용어를 넣지 않는다. common_rules는 근거가 있는 공통 기준 3~6개, conflicts는 실제 충돌만 적는다. suggestions는 이미지 카드별 한 번만 작성하고 이유는 2문장 이내다. 없는 사실을 추정하지 않는다. evidence_ids와 asset_id는 제공된 카드 id를 사용한다.');
    const knownEvidence = new Set(refs.flatMap((ref: any) => [ref.id, ref.art_asset_id]).filter(Boolean));
    const invalidEvidence = [...(result.result.common_rules ?? []), ...(result.result.conflicts ?? [])].flatMap((item: any) => (item.evidence_ids ?? []).filter((id: string) => !knownEvidence.has(id)));
    if (invalidEvidence.length) return reply.code(502).send({ error: { code: 'MODEL_EVIDENCE_OUT_OF_SCOPE' } });
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

  app.patch('/api/assistant/art-boards/:id/analysis/:revision', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ analysis_id: z.string().uuid(), result: z.record(z.string(), z.unknown()) }).parse(req.body ?? {});
    const current = await ctx.store.getArtBoardAnalysis(projectId, session.user_id, (req.params as any).id, Number((req.params as any).revision));
    if (!current || current.id !== body.analysis_id || current.status !== 'DRAFT') return reply.code(409).send({ error: { code: 'ANALYSIS_NOT_EDITABLE' } });
    const resultHash = createHash('sha256').update(JSON.stringify(body.result)).digest('hex');
    const id = await ctx.store.createArtBoardAnalysisDraft({ boardId: current.board_id, revision: current.revision, userId: session.user_id, model: current.model, result: body.result, resultHash });
    return { id, board_id: current.board_id, revision: current.revision, status: 'DRAFT', model: current.model, result: body.result, result_hash: resultHash, supersedes_id: current.id };
  });

  app.post('/api/assistant/art-boards/:id/analysis/:revision/reject', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ analysis_id: z.string().uuid() }).parse(req.body ?? {});
    const rejected = await ctx.store.rejectArtBoardAnalysis(projectId, session.user_id, (req.params as any).id, Number((req.params as any).revision), body.analysis_id);
    if (!rejected) return reply.code(409).send({ error: { code: 'ANALYSIS_NOT_REJECTABLE' } });
    return { rejected: true, id: body.analysis_id };
  });

  app.post('/api/assistant/art-boards/:id/analysis/:revision/approve', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    if (role === 'reader') return reply.code(403).send({ error: { code: 'ROLE_REQUIRED' } });
    const body = z.object({ analysis_id: z.string().uuid(), expected_hash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body ?? {});
    const result = await ctx.store.approveArtBoardAnalysis({
      projectId,
      ownerId: session.user_id,
      boardId: (req.params as any).id,
      revision: Number((req.params as any).revision),
      analysisId: body.analysis_id,
      approvedBy: session.user_id,
      expectedHash: body.expected_hash,
    });
    if (result.kind === 'NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (result.kind !== 'APPROVED') return reply.code(409).send({ error: { code: result.kind } });
    return result;
  });

  app.post('/api/assistant/art-boards/:id/image-briefs/preview', async (req, reply) => {
    const { session, ctx, projectId, role } = await requireSession(req);
    return previewArtBoard(ctx, projectId, session.user_id, role, (req.params as any).id, req.body);
  });
  async function previewArtBoard(ctx: KnowledgeCtx, projectId: string, userId: string, role: "reader" | "editor" | "admin", boardId: string, input: unknown) {
    const session = { user_id: userId };
    const board = await ctx.store.getArtBoard(projectId, userId, boardId);
    if (!board) throw Object.assign(new Error("아트보드를 찾을 수 없습니다."), { code: "NOT_FOUND", statusCode: 404 });
    const body = z
      .object({
        request: z.string().min(1).max(8000).default('캐릭터 컨셉 아트'),
        parent_image_id: z.string().uuid().optional(),
        reference_images: z.array(z.object({ id: z.string().uuid(), instruction: z.string().max(1000) })).max(15).default([]),
        revision: z.number().int().positive().optional(),
      })
      .parse(input ?? {});
    const revision = await ctx.store.getArtBoardRevision(
      projectId,
      session.user_id,
      board.id,
      body.revision,
    );
    const refs = Array.isArray((revision?.snapshot as any)?.references)
      ? (revision!.snapshot as any).references.filter((ref: any) => !ref.excluded)
      : [];
    const candidateUploadIds = refs.map((ref: any) => ref.upload_id).filter(Boolean);
    const uploads = await ctx.store.getUploadsByIds(projectId, candidateUploadIds);
    const readyIds = new Set(uploads.filter((upload: any) => upload.state === 'READY').map((upload: any) => upload.id));
    const eligibleRefs = refs.filter((ref: any) =>
      Boolean(ref.upload_id) && readyIds.has(ref.upload_id) && ref.usage !== 'EXCLUDED' && ref.usage !== 'REVIEW_REQUIRED',
    );
    const uniqueRefs = new Map<string, any>();
    for (const ref of eligibleRefs) {
      const existing = uniqueRefs.get(ref.upload_id);
      if (!existing) uniqueRefs.set(ref.upload_id, { ...ref });
      else {
        existing.roles = [...new Set([...(existing.roles ?? [existing.role]), ...(ref.roles ?? [ref.role])])];
        existing.roleUsage = { ...existing.roleUsage, ...ref.roleUsage };
        existing.note = [...new Set([existing.note, ref.note].filter(Boolean))].join('\n').slice(0, 2000);
      }
    }
    const planned = await ctx.model.structured(ImageGenerationPlan.omit({ primary: true, supporting: true }), { request: body.request, has_parent: Boolean(body.parent_image_id) }, '이미지 요청을 new/edit/variant/recompose와 character/background/game_scene/ui/other로 분류한다. 다른 후보는 variant, 장면을 바꾸고 HUD 등 일부 유지하면 recompose다. preserve는 사용자가 유지하라고 한 요소만, change는 변경 요소, free는 명시되지 않은 인물/의상/행동/배경/구도다. 신규 UI에 교복 여성이나 복도를 임의로 고정하지 않는다. 배경 전용은 인물 없음. JSON만 반환.');
    const output = planned.result.output;
    const usableRefs = body.parent_image_id ? [] : selectReferences([...uniqueRefs.values()], output);
    if (usableRefs.length > 16) throw Object.assign(new Error("현재 이미지 모델은 원본 16개까지 입력할 수 있습니다. 전체 원본을 전달하려면 아트보드의 이미지를 16개 이하로 정리해 주세요."), { code: "REFERENCE_LIMIT", statusCode: 409 });
    const referenceUploadIds = usableRefs.map((ref: any) => ref.upload_id).filter(Boolean);
    const imageObservations = await Promise.all(usableRefs.filter((ref: any) => ref.art_asset_id).map(async (ref: any) => {
      const extraction = await ctx.store.getLatestArtExtraction(projectId, ref.art_asset_id);
      const observation = { ...(extraction?.observations as any ?? {}), ...(extraction?.human_corrections as any ?? {}) };
      return { name: ref.name, style_features: { materials: observation.materials, textures: observation.textures, palette: observation.palette, lighting: observation.lighting }, purpose: ref.purpose };
    }));
    const approvedStyle = await ctx.store.getApprovedStyleProfile(projectId);
    const loadPlanImage = async (id: string, purpose: string) => {
      const image = await getImage(ctx.store, projectId, id);
      if (!image || image.owner_id !== userId || !image.sha256) throw Object.assign(new Error('참고 이미지를 확인하지 못했습니다.'), { code: 'IMAGE_NOT_FOUND', statusCode: 409 });
      return { id, hash: image.sha256, purpose };
    };
    const plan = ImageGenerationPlan.parse({ ...planned.result, operation: body.parent_image_id ? planned.result.operation === 'new' ? 'recompose' : planned.result.operation : planned.result.operation === 'edit' ? 'new' : planned.result.operation,
      primary: body.parent_image_id ? await loadPlanImage(body.parent_image_id, planned.result.operation === 'variant' ? '화풍만 참고. 인물과 구도는 새로 구성' : '유지 요소: ' + planned.result.preserve.join(', ') + '. 변경 요소: ' + planned.result.change.join(', ')) : null,
      supporting: await Promise.all(body.reference_images.map(ref => loadPlanImage(ref.id, ref.instruction))),
    });
    const savedRules = approvedStyle ? await ctx.store.getApprovedStyleRules(projectId, approvedStyle.version) : [];
    const ruleSource = savedRules.length ? savedRules : approvedStyle?.body?.common_rules;
    const approvedRules = Array.isArray(ruleSource)
      ? ruleSource
          .filter((rule: any) => typeof rule?.statement === 'string')
          .filter((rule: any) => !['ui', 'background'].includes(output) || !/캐릭터|인물|얼굴|교복|의상/.test(rule.statement))
          .map((rule: any) => String(rule.category ?? 'style') + ': ' + rule.statement)
      : [];
    const artDirection = [
      ...usableRefs.map((ref: any) => (ref.roles ?? [ref.role]).join(', ') + ': ' + ref.note),
      ...approvedRules,
    ].join('\n');
    if (!ctx.model) throw Object.assign(new Error("모델 설정을 확인해 주세요."), { code: "MODEL_NOT_CONFIGURED", statusCode: 503 });
    if (ctx.discordRead) await ctx.discordRead(10_000).catch(() => ({ ok: false, gaps: ['refresh_failed'] }));
    const rag = await buildImagePrompt(ctx.store, {
      projectId, request: body.request, output, embeddings: ctx.embeddings, acl: { guilds: [deps.config.DISCORD_GUILD_ID] },
    });
    const drafted = await ctx.model.structured(ImageBriefDraft, {
      request: body.request, generation_plan: plan, project_evidence: rag.prompt, art_board: { name: board.name, frames_and_notes: (revision?.snapshot as any)?.nodes ?? [], references: usableRefs.map((ref: any) => ({ name: ref.name, roles: ref.roles, usage: ref.roleUsage, purpose: ref.purpose, instruction: ref.note })) }, role_directives: usableRefs.map((ref: any) => ({ roles: ref.roles, instruction: ref.note })),
      image_observations: imageObservations, approved_art_bible_rules: approvedRules, default_negative_constraints: rag.negative,
    }, '프로젝트 근거와 승인된 Art Bible, 사용자가 정한 역할 지시만 사용해 구조화된 이미지 브리프를 작성한다. 사람 수정/사용자 지시가 AI 관찰보다 우선한다. 근거 없는 고유 설정을 만들지 않는다. 출력 prompt는 GPT Image 2.5 Flare용으로 구체적인 장면/재질/구도를 설명하고 negative_constraints는 제외할 시각 요소만 담는다. prompt는 4000자 이내로 핵심을 통합하고 레퍼런스별 지시를 반복하지 않는다. negative_constraints는 12개 이내, 각 100자 이내다. role_directives는 역할별로 중복 없이 최대 6개, 각 instruction은 300자 이내로 요약한다. 완결된 JSON 객체만 반환한다.');
    const prompt = drafted.result.prompt + '\n必須条件 / 요청 우선: ' + body.request + '\n유지: ' + plan.preserve.join(', ') + '\n변경: ' + plan.change.join(', ') + '\n자유 구성: ' + plan.free.join(', ') + (output === 'background' ? '\n배경 전용. 인물을 추가하지 않는다.' : output === 'ui' ? '\nUI 설계 중심. 요청하지 않은 교복 여성/복도를 고정하지 않는다.' : '');
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    const sourceRows = await rows<any>(sql`SELECT s.kind, s.status, max(c.last_reconciled_at) AS latest_at
      FROM knowledge_sources s LEFT JOIN connector_cursors c ON c.source_id=s.id
      WHERE s.project_id=${projectId} GROUP BY s.kind, s.status`, ctx.store.db);
    let discordLive: { ok: boolean; gaps: string[] } = { ok: true, gaps: [] };
    if (ctx.discordRead) {
      try { discordLive = await ctx.discordRead(10_000); } catch { discordLive = { ok: false, gaps: ['discord_live_read_failed'] }; }
    } else discordLive = { ok: false, gaps: ['discord_context_disabled'] };
    const coverage = Object.fromEntries(['notion', 'github', 'discord', 'meeting'].map((source) => {
      const row = sourceRows.find((item: any) => item.kind === source);
      const sourceEvidence = rag.evidence.some((item) => item.stable_key.startsWith(source + ':'));
      const gaps: string[] = [];
      let read_status: 'OK' | 'PARTIAL' | 'FAILED' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED';
      let latest_at: string | null = row?.latest_at ? new Date(row.latest_at).toISOString() : null;
      if (row?.status && row.status !== 'ACTIVE') { read_status = 'FAILED'; gaps.push('source_' + String(row.status).toLowerCase()); }
      else if (source === 'discord' && !discordLive.ok) { read_status = 'PARTIAL'; gaps.push(...discordLive.gaps); latest_at = new Date().toISOString(); }
      else if (row) {
        read_status = latest_at ? 'OK' : 'PARTIAL';
        if (!latest_at) gaps.push('never_reconciled');
        if (!sourceEvidence) gaps.push('관련 근거 없음');
      }
      return [source, { read_status, latest_at, gaps }];
    }));
    const briefBase = {
      schema_version: 2 as const, request: body.request, plan, plan_hash: createHash('sha256').update(imageBriefHashInput(plan)).digest('hex'),
      role_directives: usableRefs.flatMap((ref: any) => (ref.roles ?? [ref.role]).map((role: string) => ({ role, instruction: ref.note || '원본의 해당 역할만 참고' }))),
      negative_constraints: [...drafted.result.negative_constraints, ...(output === 'background' ? ['인물, 캐릭터 추가 금지'] : [])],
      board_id: board.id, board_revision: revision?.revision ?? board.current_revision,
      art_bible_version: approvedStyle?.version ?? null,
      references: usableRefs.map((ref: any, index: number) => ({
        asset_id: uploads.find((upload: any) => upload.id === ref.upload_id)?.asset_id ?? ref.art_asset_id ?? null, upload_id: ref.upload_id,
        asset_revision: uploads.find((upload: any) => upload.id === ref.upload_id)?.sha256 ?? ref.sha256,
        source_sha256: uploads.find((upload: any) => upload.id === ref.upload_id)?.sha256 ?? ref.sha256, order: index, role: ref.roles ?? [ref.role], usage: ref.roleUsage ?? Object.fromEntries((ref.roles ?? [ref.role]).map((item: string) => [item, ref.usage])),
        crop: ref.crop ?? null, instruction: ref.note ?? '', purpose: ref.purpose, reason: ref.reason, forbidden: ref.forbidden,
      })),
      evidence: [
        { id: `board:${board.id}:${revision?.revision ?? board.current_revision}`, source: 'art_board' as const, stable_key: `art_board:${board.id}`, revision: String(revision?.revision ?? board.current_revision), read_status: 'OK' as const },
        ...rag.evidence.map((item, index) => ({ id: `rag:${index}:${item.stable_key}`, source: (item.stable_key.split(':')[0] as any), stable_key: item.stable_key, revision: item.revision, read_status: 'OK' as const })),
      ],
      coverage, provider: 'openrouter' as const, model: 'openai/gpt-image-2.5-flare' as const,
      prompt, prompt_hash: promptHash,
    };
    const brief = ImageBrief.parse({ ...briefBase, brief_hash: createHash('sha256').update(imageBriefHashInput(briefBase)).digest('hex') });
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
            board_revision: brief.board_revision, brief_hash: brief.brief_hash,
          },
          beforeHash: null,
          after: {
            image_brief: brief, prompt: brief.prompt, model: brief.model, negative: drafted.result.negative_constraints.join(', '), parent_image_id: body.parent_image_id, reference_images: body.reference_images,
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
      model: brief.model,
      provider: 'openrouter',
      references: refs.map((ref: any) => ({
        asset_key: ref.id,
        upload_id: ref.upload_id,
        role: ref.role, usage: ref.usage, crop: ref.crop ?? null,
        note: ref.note,
        ready: Boolean(ref.upload_id && readyIds.has(ref.upload_id)),
      })),
      request: body.request,
      review_warnings: [...uniqueRefs.values()].filter(ref => Object.keys(ref.roleUsage ?? {}).some(key => !(ref.roles ?? [ref.role]).includes(key))).map(ref => ref.name + '의 역할과 사용 강도가 달라 자동 참고에서 제외했습니다.'),
      reference_upload_ids: referenceUploadIds,
      approval_id: approvalId,
      generation_ready: Boolean(approvalId),
      blocked_reference_count: refs.length - usableRefs.length,
      instructions: usableRefs.map((ref: any) => ref.role + ': ' + ref.note).join('\n'),
      style_version: approvedStyle?.version ?? null,
      style_approved: Boolean(approvedStyle),
      brief,
      brief_hash: brief.brief_hash,
      coverage: brief.coverage,
      note: 'ImageBrief 초안입니다. 승인 후 OpenRouter 이미지 생성으로 전달됩니다.',
    };
  }
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
