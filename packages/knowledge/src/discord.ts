import { createHash } from 'node:crypto';
import { KnowledgeStore, sql, first, rows } from '@meeting/knowledge-db';
import { documentKeys } from '@meeting/contracts';
import { queueExtract } from './indexer.ts';

// Discord 수집기 — spec §6.3. REST 과거/증분 수집(Gateway 실시간은 P3).
// snowflake는 절대 JS number로 다루지 않는다 — 문자열/BigInt만.

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author?: { id: string; username?: string; global_name?: string; bot?: boolean };
  content?: string;
  timestamp: string;
  edited_timestamp: string | null;
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string };
  referenced_message?: DiscordMessage | null;
  attachments?: {
    id: string;
    filename: string;
    size: number;
    content_type?: string;
    url: string;
  }[];
  thread?: { id: string; name?: string; parent_id?: string };
  type?: number;
}

export interface FetchLike {
  (path: string, params?: Record<string, string>): Promise<{
    status: number;
    body: any;
    retryAfter?: number;
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Discord rate-limit 헤더/retry_after를 따르는 최소 REST 클라이언트 (§6.3).
export class DiscordRest {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxRetries = 3,
  ) {}
  async request(path: string, params?: Record<string, string>) {
    for (let attempt = 0; ; attempt++) {
      const url = new URL(`https://discord.com/api/v10${path}`);
      for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bot ${this.token}` },
      });
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      if (res.status === 429 && attempt < this.maxRetries) {
        await sleep((retryAfter ?? 1) * 1000 + Math.random() * 250);
        continue;
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        await sleep(2 ** attempt * 500 + Math.random() * 250);
        continue;
      }
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* 빈 본문 */
      }
      return { status: res.status, body, retryAfter };
    }
  }
  /** spec §6.3: before/after/around는 한 요청에 하나만. cursor는 snowflake 문자열. */
  messages(channelId: string, opts: { before?: string; after?: string; limit?: number }) {
    const params: Record<string, string> = { limit: String(opts.limit ?? 100) };
    if (opts.before) params.before = opts.before;
    else if (opts.after) params.after = opts.after;
    return this.request(`/channels/${channelId}/messages`, params);
  }
  message(channelId: string, messageId: string) {
    return this.request(`/channels/${channelId}/messages/${messageId}`);
  }
  activeThreads(guildId: string) {
    return this.request(`/guilds/${guildId}/threads/active`);
  }
  archivedPublicThreads(channelId: string) {
    return this.request(`/channels/${channelId}/threads/archived/public`);
  }
  joinedPrivateArchivedThreads(channelId: string) {
    return this.request(`/channels/${channelId}/users/@me/threads/archived/private`);
  }
}

export const messageHash = (m: DiscordMessage) =>
  sha256(
    JSON.stringify({
      content: m.content ?? '',
      edited: m.edited_timestamp ?? null,
      attachments: (m.attachments ?? []).map((a) => a.id).sort(),
      type: m.type ?? 0,
    }),
  );

export class DiscordCollector {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly rest: DiscordRest,
    private readonly guildId: string,
  ) {}

  private cursorKey(channelId: string) {
    return `channel:${channelId}`;
  }
  private async getCursor(sourceId: string, channelId: string) {
    const row = await first<{ cursor: any }>(
      sql`SELECT cursor FROM connector_cursors WHERE source_id=${sourceId} AND scope_key=${this.cursorKey(channelId)}`,
      this.store.db,
    );
    return (row?.cursor ?? {}) as { oldest_id?: string; newest_id?: string; backfill_done?: boolean };
  }
  private async saveCursor(sourceId: string, channelId: string, cursor: object) {
    await sql`
      INSERT INTO connector_cursors(source_id, scope_key, cursor, updated_at)
      VALUES (${sourceId}, ${this.cursorKey(channelId)}, ${JSON.stringify(cursor)}::jsonb, now())
      ON CONFLICT (source_id, scope_key) DO UPDATE
        SET cursor=EXCLUDED.cursor, updated_at=now()`.execute(this.store.db);
  }

  private async docIdFor(sourceId: string, channelId: string, messageId: string) {
    const key = documentKeys.discordMessage(this.guildId, channelId, messageId);
    const doc = await first<{ id: string }>(
      sql`SELECT id FROM documents WHERE source_id=${sourceId} AND stable_key=${key}`,
      this.store.db,
    );
    return doc?.id ?? null;
  }

  /** 메시지 1건을 문서로 기록 — 생성·편집·백필 공용. 변경 없으면 스킵. */
  async ingestMessage(sourceId: string, channelId: string, m: DiscordMessage) {
    const key = documentKeys.discordMessage(this.guildId, channelId, m.id);
    const hash = messageHash(m);
    const revision = m.edited_timestamp ?? `create:${m.id}`;
    const ok = await this.store.markDocumentDirty(sourceId, key, {
      channel_id: channelId,
      author_id: m.author?.id ?? null,
    });
    if (!ok) return { stored: false as const, changed: false as const }; // tombstoned
    const doc = await first<{ id: string; current_version_id: string | null }>(
      sql`SELECT id, current_version_id FROM documents WHERE source_id=${sourceId} AND stable_key=${key}`,
      this.store.db,
    );
    if (!doc) return { stored: false as const, changed: false as const };
    const existing = await first<{ content_hash: string }>(
      sql`SELECT v.content_hash FROM documents d
          JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=${doc.id}`,
      this.store.db,
    );
    if (existing?.content_hash === hash) return { stored: true as const, changed: false as const };
    // 빈 본문이 attachment-only인지 content 제한인지 구분 (§6.3).
    const contentRestricted =
      !m.content && !(m.attachments?.length ?? 0) && !m.author?.id;
    const published = await this.store.publishVersion(doc.id, {
      contentHash: hash,
      sourceRevision: revision,
      sourceOccurredAt: new Date(m.timestamp),
      sourceModifiedAt: m.edited_timestamp ? new Date(m.edited_timestamp) : null,
      normalized: {
        text: m.content ?? '',
        author: m.author?.username ?? m.author?.id ?? null,
        reply_to: m.message_reference?.message_id ?? null,
        attachment_ids: (m.attachments ?? []).map((a) => a.id),
        content_restricted: contentRestricted,
        message_type: m.type ?? 0,
      },
    });
    for (const a of m.attachments ?? [])
      await sql`
        INSERT INTO attachments(id, document_id, stable_key, mime, bytes, metadata)
        VALUES (${crypto.randomUUID()}, ${doc.id},
          ${documentKeys.discordFile(m.id, a.id)}, ${a.content_type ?? null}, ${a.size},
          ${JSON.stringify({ filename: a.filename, source_url: a.url })}::jsonb)
        ON CONFLICT (document_id, stable_key) DO UPDATE
          SET mime=EXCLUDED.mime, bytes=EXCLUDED.bytes, metadata=EXCLUDED.metadata`.execute(
        this.store.db,
      );
    // 답글 관계 — 대상이 아직 없으면 나중 백필에서 자연 해결된다.
    if (m.message_reference?.message_id) {
      const dst = await this.docIdFor(
        sourceId,
        m.message_reference.channel_id ?? channelId,
        m.message_reference.message_id,
      );
      if (dst)
        await sql`
          INSERT INTO source_relations(id, src_document_id, dst_document_id, kind)
          VALUES (${crypto.randomUUID()}, ${doc.id}, ${dst}, 'discord_reply')
          ON CONFLICT DO NOTHING`.execute(this.store.db);
    }
    if (published) await queueExtract(this.store, doc.id, hash);
    return { stored: published, changed: true as const };
  }

  /**
   * 채널 과거 수집: 시작 시점 high-watermark를 고정하고 before cursor로
   * newest→oldest 페이지네이션 (§6.3). 이후 수신분은 증분 루프가 가져간다.
   */
  async backfillChannel(
    sourceId: string,
    channelId: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ) {
    const cursor = await this.getCursor(sourceId, channelId);
    let newest = cursor.newest_id;
    let before = cursor.oldest_id;
    if (!cursor.backfill_done && !newest) {
      const head = await this.rest.messages(channelId, { limit: 1 });
      if (head.status !== 200 || !Array.isArray(head.body) || !head.body.length) {
        // 200 빈 배열이라도 권한·커버리지 확인 전 '대화 없음'으로 단정하지 않는다.
        if (head.status === 403 || head.status === 404)
          await this.saveCursor(sourceId, channelId, { ...cursor, access_lost: true });
        return { fetched: 0, done: false, status: head.status };
      }
      newest = head.body[0].id;
      before = newest;
    }
    let fetched = 0;
    if (!cursor.backfill_done) {
      // 지정 개수만큼만 과거로 내려간다(재호출로 재개).
      let remaining = opts?.limit ?? 500;
      while (remaining > 0 && before) {
        if (opts?.signal?.aborted) break;
        const page = await this.rest.messages(channelId, {
          limit: Math.min(100, remaining),
          before,
        });
        if (page.status !== 200 || !Array.isArray(page.body)) break;
        if (!page.body.length) break;
        for (const m of page.body) await this.ingestMessage(sourceId, channelId, m);
        fetched += page.body.length;
        remaining -= page.body.length;
        before = page.body[page.body.length - 1].id;
        if (page.body.length < 100) break;
      }
    }
    const done = cursor.backfill_done || !before || fetched > 0;
    await this.saveCursor(sourceId, channelId, {
      oldest_id: before,
      newest_id: newest,
      backfill_done: done && fetched > 0 ? true : cursor.backfill_done ?? false,
    });
    return { fetched, done: done || !before, status: 200 };
  }

  /** 최신 head 확인 — new message + edited_message를 after cursor로 수집 (§6.3 대조). */
  async reconcileHead(sourceId: string, channelId: string) {
    const cursor = await this.getCursor(sourceId, channelId);
    const after = cursor.newest_id;
    let collected = 0;
    let newest = after;
    const head = await this.rest.messages(channelId, { limit: 1 });
    if (head.status === 403 || head.status === 404) {
      await this.saveCursor(sourceId, channelId, { ...cursor, access_lost: true });
      return { collected: 0, access_lost: true };
    }
    if (!after) {
      if (head.status === 200 && head.body?.[0]?.id) {
        await this.saveCursor(sourceId, channelId, { ...cursor, newest_id: head.body[0].id });
        await this.ingestMessage(sourceId, channelId, head.body[0]);
      }
      return { collected: 1 };
    }
    // 최신 head와 커서가 같아도 편집 감지를 위해 최근 구간은 다시 읽는다.
    const recent = await this.rest.messages(channelId, { limit: 20 });
    if (recent.status === 200 && Array.isArray(recent.body))
      for (const m of recent.body) {
        const r = await this.ingestMessage(sourceId, channelId, m);
        if (r.changed) collected++;
      }
    if (head.status === 200 && head.body?.[0]?.id) newest = head.body[0].id;
    let page = await this.rest.messages(channelId, { after, limit: 100 });
    while (page.status === 200 && Array.isArray(page.body) && page.body.length) {
      for (const m of page.body) {
        await this.ingestMessage(sourceId, channelId, m);
        collected++;
      }
      newest = page.body[0].id;
      if (page.body.length < 100) break;
      page = await this.rest.messages(channelId, { after: newest, limit: 100 });
    }
    await this.saveCursor(sourceId, channelId, { ...cursor, newest_id: newest });
    return { collected };
  }

  /** 활성 + 공개 보관 + 참여 가능한 비공개 보관 스레드 열거 (§6.3). */
  async discoverThreads(channelId: string) {
    const ids: string[] = [];
    const active = await this.rest.activeThreads(this.guildId);
    if (active.status === 200 && Array.isArray(active.body?.threads))
      for (const t of active.body.threads)
        if (t.parent_id === channelId) ids.push(t.id);
    for (const path of [
      `/channels/${channelId}/threads/archived/public`,
      `/channels/${channelId}/users/@me/threads/archived/private`,
    ]) {
      // has_more 종료까지 timestamp cursor로 페이지네이션 (§6.3).
      let before: string | undefined;
      for (;;) {
        const r = await this.rest.request(path, before ? { before } : undefined);
        if (r.status !== 200 || !Array.isArray(r.body?.threads)) break;
        for (const t of r.body.threads) ids.push(t.id);
        if (!r.body.has_more || !r.body.threads.length) break;
        const last = r.body.threads[r.body.threads.length - 1];
        before = last.thread_metadata?.archive_timestamp ?? last.id;
      }
    }
    return [...new Set(ids)];
  }
}
