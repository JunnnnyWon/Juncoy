import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ToolContext, ToolRegistry } from './registry.ts';
import type { NotionRest } from '../notion.ts';

// notion.* read 도구 — spec §6/§10: 일정·작업 DB는 스키마가 확정된 실제 DB.
// 속성은 타입으로 추출해 이름이 달라도 동작하게 하되, 결과 필드는 한국어 정규화.

/** Notion page.properties → 정규화된 스칼라 맵. */
export function extractDbRow(page: any): Record<string, any> {
  const out: Record<string, any> = { id: page.id, url: page.url };
  for (const [name, p] of Object.entries<any>(page.properties ?? {})) {
    switch (p.type) {
      case 'title':
        out[name] = (p.title ?? []).map((t: any) => t.plain_text).join('');
        break;
      case 'rich_text':
        out[name] = (p.rich_text ?? []).map((t: any) => t.plain_text).join('');
        break;
      case 'date':
        out[name] = p.date
          ? { start: p.date.start, end: p.date.end, time_zone: p.date.time_zone }
          : null;
        break;
      case 'people':
        out[name] = (p.people ?? []).map((u: any) => u.name ?? u.id);
        break;
      case 'status':
      case 'select':
        out[name] = (p[p.type]?.name ?? null) as string | null;
        break;
      case 'multi_select':
        out[name] = (p.multi_select ?? []).map((s: any) => s.name);
        break;
      case 'number':
        out[name] = p.number;
        break;
      case 'checkbox':
        out[name] = p.checkbox;
        break;
      case 'relation':
        out[name] = (p.relation ?? []).map((r: any) => r.id);
        break;
      case 'url':
        out[name] = p.url;
        break;
      default:
        break; // files/formula/rollup 등은 미지원 — 무시하고 누락되지 않게 이름만 남김
    }
  }
  return out;
}

/** row 전체 내용의 안정 해시 — before_hash/감사에 쓴다. */
export function rowHash(row: Record<string, any>) {
  const stable = JSON.stringify(row, Object.keys(row).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

const SCHEDULE_DB = () => process.env.NOTION_SCHEDULE_DATABASE_ID ?? '';
const TASK_DB = () => process.env.NOTION_TASK_DATABASE_ID ?? '';

function notion(ctx: ToolContext) {
  const n = ctx.deps.notion as NotionRest | undefined;
  if (!n) throw new Error('notion_connector_unavailable');
  return n;
}

const DateRange = z.object({
  from: z.string().optional(), // ISO date — KST 해석은 호출자 책임
  to: z.string().optional(),
});

async function queryDbAll(n: NotionRest, dbId: string, filter: any, sorts?: any[], cap = 100) {
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await n.databaseQuery(dbId, { filter, sorts, cursor });
    if (r.status !== 200) throw new Error(`notion_query_${r.status}`);
    items.push(...(r.body?.results ?? []));
    cursor = r.body?.has_more ? r.body?.next_cursor : undefined;
  } while (cursor && items.length < cap);
  return items.slice(0, cap);
}

export function registerNotionReadTools(reg: ToolRegistry) {
  reg.register({
    name: 'notion.query_schedule',
    kind: 'read',
    description: '일정 DB 조회 — 기간/상태/담당자/키워드/날짜 없음 필터',
    minRole: 'reader',
    auditKind: 'NOTION_QUERY_SCHEDULE',
    input: z.object({
      range: DateRange.optional(),
      status: z.string().optional(),
      assignee: z.string().optional(),
      keyword: z.string().optional(),
      missing_date: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    run: async (ctx, q) => {
      const dbId = SCHEDULE_DB();
      if (!dbId) throw new Error('schedule_db_unconfigured');
      const filters: any[] = [];
      if (q.range?.from) filters.push({ property: '날짜', date: { on_or_after: q.range.from } });
      if (q.range?.to) filters.push({ property: '날짜', date: { on_or_before: q.range.to } });
      if (q.status) filters.push({ property: '상태', status: { equals: q.status } });
      if (q.assignee) filters.push({ property: '담당자', people: { contains: q.assignee } });
      if (q.missing_date) filters.push({ property: '날짜', date: { is_empty: true } });
      if (q.keyword) filters.push({ property: '이름', title: { contains: q.keyword } });
      const filter =
        filters.length > 1 ? { and: filters } : filters.length ? filters[0] : undefined;
      const pages = await queryDbAll(
        notion(ctx),
        dbId,
        filter,
        [{ property: '날짜', direction: 'ascending' }],
        q.limit,
      );
      return pages.map((p) => ({ ...extractDbRow(p), last_edited_time: p.last_edited_time }));
    },
  });

  reg.register({
    name: 'notion.query_tasks',
    kind: 'read',
    description: '통합 작업 현황판 조회 — 상태/담당자/파트/우선순위/날짜 없음 필터',
    minRole: 'reader',
    auditKind: 'NOTION_QUERY_TASKS',
    input: z.object({
      status: z.string().optional(),
      assignee: z.string().optional(),
      part: z.string().optional(),
      priority: z.string().optional(),
      missing_date: z.boolean().optional(),
      keyword: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    run: async (ctx, q) => {
      const dbId = TASK_DB();
      if (!dbId) throw new Error('task_db_unconfigured');
      const filters: any[] = [];
      if (q.status) filters.push({ property: '상태', status: { equals: q.status } });
      if (q.assignee) filters.push({ property: '담당자', people: { contains: q.assignee } });
      if (q.part) filters.push({ property: '파트', select: { equals: q.part } });
      if (q.priority) filters.push({ property: '우선순위', select: { equals: q.priority } });
      if (q.missing_date) filters.push({ property: '날짜', date: { is_empty: true } });
      if (q.keyword) filters.push({ property: '작업명', title: { contains: q.keyword } });
      const filter =
        filters.length > 1 ? { and: filters } : filters.length ? filters[0] : undefined;
      const pages = await queryDbAll(notion(ctx), dbId, filter, undefined, q.limit);
      return pages.map((p) => ({ ...extractDbRow(p), last_edited_time: p.last_edited_time }));
    },
  });

  reg.register({
    name: 'notion.search',
    kind: 'read',
    description: 'Notion 워크스페이스 페이지 검색',
    minRole: 'reader',
    auditKind: 'NOTION_SEARCH',
    input: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().max(25).default(10),
    }),
    run: async (ctx, q) => {
      const r = await notion(ctx).request('/search', {
        method: 'POST',
        body: {
          query: q.query,
          filter: { property: 'object', value: 'page' },
          page_size: q.limit,
        },
      });
      if (r.status !== 200) throw new Error(`notion_search_${r.status}`);
      return (r.body?.results ?? []).map((p: any) => ({
        id: p.id,
        url: p.url,
        last_edited_time: p.last_edited_time,
        ...extractDbRow(p),
      }));
    },
  });

  reg.register({
    name: 'notion.fetch_page',
    kind: 'read',
    description: 'Notion 페이지를 ID로 조회 — title/properties + 블록 본문 첫 페이지',
    minRole: 'reader',
    auditKind: 'NOTION_FETCH_PAGE',
    input: z.object({ page_id: z.string().uuid() }),
    run: async (ctx, q) => {
      const n = notion(ctx);
      const r = await n.page(q.page_id);
      if (r.status !== 200) throw new Error(`notion_page_${r.status}`);
      const blocks = await n.blockChildren(q.page_id);
      return {
        page: { id: r.body.id, url: r.body.url, last_edited_time: r.body.last_edited_time },
        properties: extractDbRow(r.body),
        block_count: (blocks.body?.results ?? []).length,
      };
    },
  });
}
