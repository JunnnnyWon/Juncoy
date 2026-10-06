import { z } from 'zod';
import { sql } from 'kysely';
import { first } from '@meeting/knowledge-db';
import { DomainError } from '@meeting/domain';
import type { ToolContext, ToolRegistry } from './registry.ts';
import type { NotionRest } from '../notion.ts';
import { extractDbRow, rowHash } from './notion.ts';

// Notion 변경 도구 — spec §10: preview는 쓰기 0건 + approval 레코드만 만든다.
// commit은 승인된 after만 실행하며, update 계열은 before_hash를 재검증한다.
// 스키마 고정 매핑 — 모델이 속성명을 만들어내지 않는다 (§1).

const ttl = () => Number(process.env.ASSISTANT_APPROVAL_TTL_MS ?? 600_000);
const SCHEDULE_DB = () => process.env.NOTION_SCHEDULE_DATABASE_ID ?? '';
const TASK_DB = () => process.env.NOTION_TASK_DATABASE_ID ?? '';

function notion(ctx: ToolContext) {
  const n = ctx.deps.notion as NotionRest | undefined;
  if (!n) throw new Error('notion_connector_unavailable');
  return n;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/, 'ISO 날짜 형식');
const statusEnum = z.enum(['시작 전', '진행 중', '완료']);

/** 사용자 입력 → Notion properties (일정/작업 공통 속성). */
function buildProperties(
  input: {
    name?: string;
    date_start?: string;
    date_end?: string;
    assignee_ids?: string[];
    status?: string;
    priority?: string;
    part?: string;
    progress?: number;
    relation_ids?: string[];
  },
  titleProp: string,
): Record<string, any> {
  const props: Record<string, any> = {};
  if (input.name !== undefined) props[titleProp] = { title: [{ text: { content: input.name } }] };
  if (input.date_start !== undefined)
    props['날짜'] = {
      date: {
        start: input.date_start,
        end: input.date_end ?? null,
        time_zone: 'Asia/Seoul',
      },
    };
  if (input.assignee_ids !== undefined)
    props['담당자'] = { people: input.assignee_ids.map((id) => ({ id })) };
  if (input.status !== undefined) props['상태'] = { status: { name: input.status } };
  if (input.priority !== undefined) props['우선순위'] = { select: { name: input.priority } };
  if (input.part !== undefined) props['파트'] = { select: { name: input.part } };
  if (input.progress !== undefined) props['진행률'] = { number: input.progress };
  if (input.relation_ids !== undefined)
    props['관련 기획서'] = { relation: input.relation_ids.map((id) => ({ id })) };
  return props;
}

/** 동일 이름+날짜 중복 검사 — 미리보기에 경고로 싣는다. */
async function findDuplicates(
  n: NotionRest,
  dbId: string,
  titleProp: string,
  name?: string,
  dateStart?: string,
) {
  if (!name) return [];
  const filters: any[] = [{ property: titleProp, title: { contains: name } }];
  if (dateStart) filters.push({ property: '날짜', date: { equals: dateStart } });
  const r = await n.databaseQuery(dbId, { filter: { and: filters }, pageSize: 10 });
  if (r.status !== 200) return [];
  return (r.body?.results ?? []).map((p: any) => ({ id: p.id, url: p.url }));
}

async function makePreview(
  ctx: ToolContext,
  opts: {
    kind: string;
    target: Record<string, any>;
    beforeHash: string | null;
    after: unknown;
    summary: string;
    current?: Record<string, any> | null;
    warnings?: string[];
  },
) {
  const approvalId = await ctx.store.createApproval({
    projectId: ctx.projectId,
    userId: ctx.userId,
    kind: opts.kind,
    target: opts.target,
    beforeHash: opts.beforeHash,
    after: opts.after,
    expiresAt: new Date(Date.now() + ttl()),
  });
  return {
    approval_id: approvalId,
    summary: opts.summary,
    current: opts.current ?? null,
    after: opts.after,
    warnings: opts.warnings ?? [],
    expires_at: new Date(Date.now() + ttl()).toISOString(),
  };
}

async function fetchRow(n: NotionRest, pageId: string) {
  const r = await n.page(pageId);
  if (r.status === 404) throw new DomainError('NOT_FOUND', '대상 페이지가 없습니다.', 404);
  if (r.status !== 200) throw new Error(`notion_page_${r.status}`);
  return r.body;
}

async function approvalOrThrow(ctx: ToolContext, approvalId: string) {
  const a = await ctx.store.getApproval(approvalId, ctx.projectId);
  if (!a) throw new DomainError('NOT_FOUND', '승인을 찾을 수 없습니다.', 404);
  // 재시도 안전: 이 approval로 이미 성공한 commit이 있으면 그대로 반환 (§10 idempotent)
  const done = await first<{ id: string }>(
    sql`SELECT id FROM assistant_audit
        WHERE project_id=${ctx.projectId} AND action LIKE 'notion.commit%'
          AND target->>'approval_id'=${approvalId} AND status='DONE' LIMIT 1`,
    ctx.store.db,
  );
  if (done) return { approval: a, alreadyDone: true };
  return { approval: a, alreadyDone: false };
}

const commitTarget = (a: any) => ({ ...a.target, approval_id: a.id });

export function registerNotionMutateTools(reg: ToolRegistry) {
  const schedFields = {
    name: z.string().min(1).max(200).optional(),
    date_start: isoDate.optional(),
    date_end: isoDate.optional(),
    assignee_ids: z.array(z.string().uuid()).max(20).optional(),
    status: statusEnum.optional(),
  };
  const taskFields = {
    ...schedFields,
    priority: z.string().max(50).optional(),
    part: z.string().max(50).optional(),
    progress: z.number().min(0).max(100).optional(),
    relation_ids: z.array(z.string().uuid()).max(20).optional(),
  };

  reg.register({
    name: 'notion.preview_create_schedule',
    kind: 'preview',
    description: '일정 추가 미리보기 — 승인 시 일정 DB에 행 생성',
    input: z.strictObject({ ...schedFields, name: schedFields.name.unwrap() as any }),
    minRole: 'editor',
    auditKind: 'notion.preview_schedule',
    async run(ctx, q) {
      const dbId = SCHEDULE_DB();
      if (!dbId) throw new Error('schedule_db_unconfigured');
      const properties = buildProperties({ ...q, status: q.status ?? '시작 전' }, '이름');
      const dups = await findDuplicates(notion(ctx), dbId, '이름', q.name, q.date_start);
      return makePreview(ctx, {
        kind: 'notion_schedule',
        target: { op: 'create', database: 'schedule', name: q.name },
        beforeHash: null,
        after: { database_id: dbId, properties },
        summary: `일정 "${q.name}" 추가${q.date_start ? ` (${q.date_start}${q.date_end ? ` ~ ${q.date_end}` : ''})` : ''}`,
        warnings: dups.length ? [`같은 이름의 일정이 ${dups.length}건 있습니다.`] : [],
      });
    },
  });

  reg.register({
    name: 'notion.preview_update_schedule',
    kind: 'preview',
    description: '일정 수정 미리보기 — 현재 값과 변경 후 값을 함께 보여준다',
    input: z.strictObject({ page_id: z.string().uuid(), ...schedFields }),
    minRole: 'editor',
    auditKind: 'notion.preview_schedule',
    async run(ctx, q) {
      const page = await fetchRow(notion(ctx), q.page_id);
      const current = extractDbRow(page);
      const properties = buildProperties(q, '이름');
      if (!Object.keys(properties).length)
        throw new DomainError('INVALID_ARGUMENT', '변경할 속성이 없습니다.', 400);
      return makePreview(ctx, {
        kind: 'notion_schedule',
        target: { op: 'update', database: 'schedule', page_id: q.page_id, name: current['이름'] },
        beforeHash: rowHash(current),
        after: { page_id: q.page_id, properties },
        summary: `일정 "${current['이름'] ?? q.page_id}" 수정`,
        current,
        warnings: [],
      });
    },
  });

  reg.register({
    name: 'notion.preview_create_task',
    kind: 'preview',
    description: '작업 추가 미리보기 — 승인 시 작업 현황판에 행 생성',
    input: z.strictObject({ ...taskFields, name: taskFields.name.unwrap() as any }),
    minRole: 'editor',
    auditKind: 'notion.preview_task',
    async run(ctx, q) {
      const dbId = TASK_DB();
      if (!dbId) throw new Error('task_db_unconfigured');
      const properties = buildProperties({ ...q, status: q.status ?? '시작 전' }, '작업명');
      const dups = await findDuplicates(notion(ctx), dbId, '작업명', q.name);
      return makePreview(ctx, {
        kind: 'notion_task',
        target: { op: 'create', database: 'task', name: q.name },
        beforeHash: null,
        after: { database_id: dbId, properties },
        summary: `작업 "${q.name}" 추가`,
        warnings: dups.length ? [`같은 이름의 작업이 ${dups.length}건 있습니다.`] : [],
      });
    },
  });

  reg.register({
    name: 'notion.preview_update_task',
    kind: 'preview',
    description: '작업 수정 미리보기 — 상태/담당자/진행률 등 속성 변경',
    input: z.strictObject({ page_id: z.string().uuid(), ...taskFields }),
    minRole: 'editor',
    auditKind: 'notion.preview_task',
    async run(ctx, q) {
      const page = await fetchRow(notion(ctx), q.page_id);
      const current = extractDbRow(page);
      const properties = buildProperties(q, '작업명');
      if (!Object.keys(properties).length)
        throw new DomainError('INVALID_ARGUMENT', '변경할 속성이 없습니다.', 400);
      return makePreview(ctx, {
        kind: 'notion_task',
        target: { op: 'update', database: 'task', page_id: q.page_id, name: current['작업명'] },
        beforeHash: rowHash(current),
        after: { page_id: q.page_id, properties },
        summary: `작업 "${current['작업명'] ?? q.page_id}" 수정`,
        current,
        warnings: [],
      });
    },
  });

  reg.register({
    name: 'notion.preview_create_page',
    kind: 'preview',
    description: 'Notion 페이지 생성 미리보기 — 부모 페이지 아래 새 문서',
    input: z.strictObject({
      parent_page_id: z.string().uuid(),
      title: z.string().min(1).max(200),
      content: z.string().max(20_000).optional(),
    }),
    minRole: 'editor',
    auditKind: 'notion.preview_page',
    async run(ctx, q) {
      return makePreview(ctx, {
        kind: 'notion_page',
        target: { op: 'create', parent_page_id: q.parent_page_id, title: q.title },
        beforeHash: null,
        after: {
          parent_page_id: q.parent_page_id,
          title: q.title,
          content: q.content ?? '',
        },
        summary: `페이지 "${q.title}" 생성`,
      });
    },
  });

  reg.register({
    name: 'notion.preview_update_page',
    kind: 'preview',
    description: 'Notion 페이지에 내용 추가 미리보기 (덮어쓰기가 아니라 하단 추가)',
    input: z.strictObject({
      page_id: z.string().uuid(),
      append_text: z.string().min(1).max(20_000),
    }),
    minRole: 'editor',
    auditKind: 'notion.preview_page',
    async run(ctx, q) {
      const page = await fetchRow(notion(ctx), q.page_id);
      const current = extractDbRow(page);
      return makePreview(ctx, {
        kind: 'notion_page',
        target: {
          op: 'append',
          page_id: q.page_id,
          title: current.Name ?? current['이름'] ?? q.page_id,
        },
        beforeHash: rowHash(current),
        after: { page_id: q.page_id, append_text: q.append_text },
        summary: `페이지 "${current.Name ?? current['이름'] ?? q.page_id}"에 내용 추가`,
        current,
      });
    },
  });

  // ── commit — 승인 레코드의 after만 실행. 입력은 approval_id뿐. ──────
  const commitInput = z.strictObject({ approval_id: z.string().uuid() });

  const commitCreateOrUpdate = async (ctx: ToolContext, approvalId: string, kindPrefix: string) => {
    const { approval, alreadyDone } = await approvalOrThrow(ctx, approvalId);
    if (alreadyDone) return { skipped: true, reason: 'already_done' };
    const n = notion(ctx);
    const after = approval.after as any;
    if (approval.target.op === 'create') {
      const r = await n.createPage({
        parent: { database_id: after.database_id },
        properties: after.properties,
      });
      if (r.status !== 200) throw new Error(`notion_create_${r.status}`);
      return { created: true, page_id: r.body.id, url: r.body.url };
    }
    // update — before_hash 재검증 (preview 이후 원본이 바뀌었으면 CONFLICT)
    const page = await fetchRow(n, approval.target.page_id);
    const now = rowHash(extractDbRow(page));
    if (approval.before_hash && now !== approval.before_hash)
      throw new DomainError(
        'CONFLICT',
        '대상이 미리보기 이후 변경되었습니다. 새 미리보기를 만들어 주세요.',
        409,
      );
    const r = await n.updatePage(approval.target.page_id, { properties: after.properties });
    if (r.status !== 200) throw new Error(`notion_update_${r.status}`);
    return { updated: true, page_id: r.body.id, url: r.body.url };
  };

  reg.register({
    name: 'notion.commit_schedule_change',
    kind: 'commit',
    description: '승인된 일정 변경을 실행한다',
    input: commitInput,
    minRole: 'editor',
    auditKind: 'notion.commit_schedule',
    run: (ctx, q) => commitCreateOrUpdate(ctx, q.approval_id, 'notion_schedule'),
  });

  reg.register({
    name: 'notion.commit_task_change',
    kind: 'commit',
    description: '승인된 작업 변경을 실행한다',
    input: commitInput,
    minRole: 'editor',
    auditKind: 'notion.commit_task',
    run: (ctx, q) => commitCreateOrUpdate(ctx, q.approval_id, 'notion_task'),
  });

  reg.register({
    name: 'notion.commit_page_change',
    kind: 'commit',
    description: '승인된 페이지 생성/추가를 실행한다',
    input: commitInput,
    minRole: 'editor',
    auditKind: 'notion.commit_page',
    async run(ctx, q) {
      const { approval, alreadyDone } = await approvalOrThrow(ctx, q.approval_id);
      if (alreadyDone) return { skipped: true, reason: 'already_done' };
      const n = notion(ctx);
      const after = approval.after as any;
      if (approval.target.op === 'create') {
        const children = after.content
          ? after.content
              .split(/\n+/)
              .filter(Boolean)
              .map((line: string) => ({
                type: 'paragraph',
                paragraph: { rich_text: [{ text: { content: line.slice(0, 2000) } }] },
              }))
          : [];
        const r = await n.createPage({
          parent: { page_id: after.parent_page_id },
          properties: { title: { title: [{ text: { content: after.title } }] } },
          children,
        });
        if (r.status !== 200) throw new Error(`notion_create_${r.status}`);
        return { created: true, page_id: r.body.id, url: r.body.url };
      }
      // append — 원본 변경 여부 재검증 후 하단에 블록 추가
      const page = await fetchRow(n, approval.target.page_id);
      const now = rowHash(extractDbRow(page));
      if (approval.before_hash && now !== approval.before_hash)
        throw new DomainError('CONFLICT', '대상이 미리보기 이후 변경되었습니다.', 409);
      const children = after.append_text
        .split(/\n+/)
        .filter(Boolean)
        .map((line: string) => ({
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: line.slice(0, 2000) } }] },
        }));
      const r = await n.request(`/blocks/${approval.target.page_id}/children`, {
        method: 'PATCH',
        body: { children },
      });
      if (r.status !== 200) throw new Error(`notion_append_${r.status}`);
      return { appended: true, page_id: approval.target.page_id };
    },
  });
}
