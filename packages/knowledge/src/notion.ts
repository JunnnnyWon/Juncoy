import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { KnowledgeStore, sql, first, rows } from '@meeting/knowledge-db';
import { documentKeys } from '@meeting/contracts';
import { queueExtract } from './indexer.ts';

// Notion 수집기 — spec §6.1.
// 공식 API: 검색(last_edited_time 증분), page, block children 재귀, 댓글.
// webhook 서명(X-Notion-Signature HMAC-SHA256)은 수신 신호일 뿐, 진실은 재조회다.

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** X-Notion-Signature 검증 — 'sha256=' + hex HMAC, timing-safe. */
export function verifyNotionSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class NotionRest {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async request(path: string, opts?: { method?: string; params?: Record<string, string>; body?: any }) {
    for (let attempt = 0; ; attempt++) {
      const url = new URL(`${API}${path}`);
      for (const [k, v] of Object.entries(opts?.params ?? {})) url.searchParams.set(k, v);
      const res = await this.fetchImpl(url, {
        method: opts?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': VERSION,
          'content-type': 'application/json',
        },
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const retryAfter = Number(res.headers.get('retry-after'));
      if (res.status === 429 && attempt < 4) {
        await sleep((retryAfter || 1) * 1000 + Math.random() * 250);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(2 ** attempt * 500 + Math.random() * 250);
        continue;
      }
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* empty */
      }
      return { status: res.status, body };
    }
  }
  page(id: string) {
    return this.request(`/pages/${id}`);
  }
  blockChildren(id: string, cursor?: string) {
    return this.request(`/blocks/${id}/children`, {
      params: { page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) },
    });
  }
  comments(blockId: string) {
    return this.request('/comments', { params: { block_id: blockId, page_size: '100' } });
  }
  /** 증분 목록 — data source query 대신 search API (페이지 단위, last_edited_time 정렬). */
  searchPages(editedAfter?: string, cursor?: string) {
    return this.request('/search', {
      method: 'POST',
      body: {
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
  }
  databaseQuery(id: string, cursor?: string) {
    return this.request(`/databases/${id}/query`, {
      method: 'POST',
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
  }
}

interface RichText {
  plain_text?: string;
  href?: string | null;
}
const rt = (arr: RichText[] | undefined) => (arr ?? []).map((t) => t.plain_text ?? '').join('');

/** block → 텍스트 행. has_children인 타입은 호출자가 재귀로 이어 붙인다. */
export function blockLine(b: any): string {
  const t = b.type;
  const c = b[t] ?? {};
  if (t === 'table_row') return '| ' + (c.cells ?? []).map(rt).join(' | ') + ' |';
  if (t === 'to_do') return `[${c.checked ? 'x' : ' '}] ` + rt(c.rich_text);
  if (t === 'code') return '```\n' + rt(c.rich_text) + '\n```';
  if (t === 'child_page') return `# ${c.title ?? ''}`;
  if (t === 'child_database' || t === 'child_table') return `# ${c.title ?? ''}`;
  if (typeof c.rich_text !== 'undefined') {
    const text = rt(c.rich_text);
    if (t?.startsWith('heading_')) return '#'.repeat(Number(t.slice(8)) || 1) + ' ' + text;
    if (t === 'bulleted_list_item' || t === 'numbered_list_item') return '- ' + text;
    if (t === 'quote' || t === 'callout') return '> ' + text;
    return text;
  }
  return '';
}

/** 페이지의 제목 속성 — title 타입 속성 하나를 찾는다. */
export function pageTitle(page: any): string {
  for (const prop of Object.values(page.properties ?? {}) as any[])
    if (prop?.type === 'title') return rt(prop.title);
  return '';
}

export class NotionCollector {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly rest: NotionRest,
    private readonly workspace: string, // notion workspace 식별자 (문서 키 prefix)
    private readonly sourceId: string,
  ) {}

  private cursorKey(kind: 'incremental' | 'structure', ref = '') {
    return `notion:${kind}:${ref}`;
  }
  private async getCursor(kind: 'incremental' | 'structure', ref = '') {
    const row = await first<{ cursor: any }>(
      sql`SELECT cursor FROM connector_cursors WHERE source_id=${this.sourceId} AND scope_key=${this.cursorKey(kind, ref)}`,
      this.store.db,
    );
    return (row?.cursor ?? {}) as { last_edited_time?: string; done_at?: string };
  }
  private async saveCursor(kind: 'incremental' | 'structure', cursor: object, ref = '') {
    await sql`
      INSERT INTO connector_cursors(source_id, scope_key, cursor, last_reconciled_at, updated_at)
      VALUES (${this.sourceId}, ${this.cursorKey(kind, ref)}, ${JSON.stringify(cursor)}::jsonb, now(), now())
      ON CONFLICT (source_id, scope_key) DO UPDATE
        SET cursor=EXCLUDED.cursor, last_reconciled_at=now(), updated_at=now()`.execute(
      this.store.db,
    );
  }

  /** 페이지 전체 텍스트 — 블록 트리 재귀(100개/페이지), 댓글 포함. */
  private async pageText(pageId: string, depth = 0): Promise<string[]> {
    if (depth > 8) return [];
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rest.blockChildren(pageId, cursor);
      if (r.status !== 200) throw new Error(`blocks ${r.status}`);
      for (const b of r.body.results ?? []) {
        const line = blockLine(b);
        if (line.trim()) out.push(line);
        if (b.has_children) out.push(...(await this.pageText(b.id, depth + 1)));
      }
      cursor = r.body.has_more ? r.body.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  /** 페이지 하나 수집 — archived면 tombstone, 내용 같으면 skip. */
  async ingestPage(pageId: string) {
    const key = documentKeys.notionPage(this.workspace, pageId);
    const p = await this.rest.page(pageId);
    if (p.status === 404 || p.status === 403) {
      await this.store.applyTombstone(key, this.sourceId, 'notion_page_gone');
      return { stored: false, gone: true };
    }
    if (p.status !== 200) throw new Error(`page ${p.status}`);
    const page = p.body;
    if (page.archived || page.in_trash) {
      await this.store.applyTombstone(key, this.sourceId, 'notion_page_archived');
      return { stored: false, gone: true };
    }
    const blocks = await this.pageText(pageId);
    const comments = await this.rest.comments(pageId);
    const commentLines =
      comments.status === 200
        ? (comments.body.results ?? []).map(
            (c: any) => `[comment ${c.created_by?.name ?? ''}] ${rt(c.rich_text)}`,
          )
        : [];
    const text = [...blocks, ...commentLines].join('\n');
    const contentHash = sha256(text);
    const ok = await this.store.markDocumentDirty(this.sourceId, key, {
      title: pageTitle(page),
      url: page.url,
    });
    if (!ok) return { stored: false, tombstoned: true };
    const doc = await first<{ id: string }>(
      sql`SELECT id FROM documents WHERE source_id=${this.sourceId} AND stable_key=${key}`,
      this.store.db,
    );
    if (!doc) return { stored: false };
    const existing = await first<{ content_hash: string }>(
      sql`SELECT v.content_hash FROM documents d JOIN document_versions v ON v.id=d.current_version_id
          WHERE d.id=${doc.id}`,
      this.store.db,
    );
    if (existing?.content_hash === contentHash) return { stored: true, unchanged: true };
    const published = await this.store.publishVersion(doc.id, {
      contentHash,
      sourceRevision: page.last_edited_time,
      sourceModifiedAt: page.last_edited_time ? new Date(page.last_edited_time) : null,
      normalized: {
        text,
        title: pageTitle(page),
        url: page.url,
        last_edited_time: page.last_edited_time,
        comments: commentLines.length,
      },
    });
    if (published) await queueExtract(this.store, doc.id, contentHash);
    return { stored: published, changed: true };
  }

  /** 증분 동기 — last_edited_time 커서 이후 변경 페이지만 (§6.1, 2분 주기). */
  async syncIncremental() {
    const cursor = await this.getCursor('incremental');
    let maxEdited = cursor.last_edited_time ?? '1970-01-01T00:00:00.000Z';
    let ingested = 0;
    let next: string | undefined;
    do {
      const r = await this.rest.searchPages(cursor.last_edited_time, next);
      if (r.status !== 200) throw new Error(`search ${r.status}`);
      let reached = false;
      for (const p of r.body.results ?? []) {
        // last_edited_time 내림차순 — 커서 이하가 나오면 이후 페이지는 전부 과거다.
        if (cursor.last_edited_time && p.last_edited_time < cursor.last_edited_time) {
          reached = true;
          break;
        }
        await this.ingestPage(p.id);
        ingested++;
        if (p.last_edited_time > maxEdited) maxEdited = p.last_edited_time;
      }
      next = !reached && r.body.has_more ? r.body.next_cursor : undefined;
    } while (next);
    await this.saveCursor('incremental', { last_edited_time: maxEdited });
    return { ingested };
  }

  /** 구조 대조 — 등록된 root/database scope 전수 점검 (§6.1, 15분 주기). */
  async reconcileStructure() {
    const scopes = await rows<{ scope_key: string; metadata: any }>(
      sql`SELECT scope_key, metadata FROM source_scopes
          WHERE source_id=${this.sourceId} AND allowed
            AND (scope_key LIKE 'root:%' OR scope_key LIKE 'database:%')`,
      this.store.db,
    );
    let checked = 0;
    for (const s of scopes) {
      const id = s.scope_key.split(':').slice(1).join(':');
      try {
        if (s.scope_key === 'root:workspace') {
          // 워크스페이스 전체 — integration에 공유된 모든 페이지를 search로 열거.
          let cursor: string | undefined;
          do {
            const r = await this.rest.searchPages(cursor);
            if (r.status !== 200) break;
            for (const p of r.body.results ?? []) await this.ingestPage(p.id);
            cursor = r.body.has_more ? r.body.next_cursor : undefined;
          } while (cursor);
        } else if (s.scope_key.startsWith('database:')) {
          let cursor: string | undefined;
          do {
            const r = await this.rest.databaseQuery(id, cursor);
            if (r.status !== 200) break;
            for (const row of r.body.results ?? []) await this.ingestPage(row.id);
            cursor = r.body.has_more ? r.body.next_cursor : undefined;
          } while (cursor);
        } else {
          await this.ingestPage(id);
        }
        checked++;
      } catch (e) {
        process.stderr.write(`notion scope ${s.scope_key}: ${e}\n`);
      }
    }
    await this.saveCursor('structure', { done_at: new Date().toISOString() });
    return { checked };
  }
}
