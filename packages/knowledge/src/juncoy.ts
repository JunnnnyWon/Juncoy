import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { KnowledgeStore, sql, first } from '@meeting/knowledge-db';
import { documentKeys } from '@meeting/contracts';
import { queueExtract } from './indexer.ts';

// Juncoy 회의 수집기 — spec §6.4.
// 회의 DB는 read-only 전용 role(pool 2)로 읽고, 지식 DB에만 쓴다.
// canonical 전사·정정·대체·삭제·workspace 공유 변화를 5초 polling으로 반영한다.

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface SharedMeeting {
  meeting_id: string;
  guild_id: string;
  deleted_at: Date | null;
  tombstoned: boolean;
  transcript_version: number;
  status: string;
  ended_at: string | null;
}

export class MeetingReader {
  private readonly pool: Pool;
  constructor(url: string, max = 2) {
    this.pool = new Pool({ connectionString: url, max });
  }
  async close() {
    await this.pool.end();
  }
  async sharedMeetings(workspaceGuildId: string): Promise<SharedMeeting[]> {
    const { rows } = await this.pool.query<SharedMeeting>(
      `SELECT m.id AS meeting_id, m.guild_id, m.deleted_at,
              (t.meeting_id IS NOT NULL) AS tombstoned,
              COALESCE((m.view->>'transcript_version')::int, 0) AS transcript_version,
              m.status, m.view->>'ended_at' AS ended_at
         FROM workspace_meetings w
         JOIN meetings m ON m.id = w.meeting_id
         LEFT JOIN deletion_tombstones t ON t.meeting_id = m.id
        WHERE w.workspace_guild_id = $1`,
      [workspaceGuildId],
    );
    return rows;
  }
  async canonicalSegments(meetingId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.segment_id, s.user_id, s.raw_text, s.source_start_ms, s.source_end_ms,
              s.body->>'text' AS display_text,
              COALESCE(s.body->>'display_name', s.user_id) AS speaker,
              s.body->'quality_flags' AS quality_flags,
              (SELECT json_agg(v ORDER BY v.valid_from) FROM segment_versions v
                WHERE v.segment_id = s.segment_id) AS versions,
              (SELECT json_agg(r) FROM segment_replacements r
                WHERE r.previous_id = s.segment_id OR r.replacement_id = s.segment_id) AS replacements
         FROM transcript_segments s
        WHERE s.meeting_id = $1 AND s.canonical
        ORDER BY s.source_start_ms`,
      [meetingId],
    );
    return rows;
  }
}

export class JuncoyCollector {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly meetings: MeetingReader,
    private readonly workspaceId: string,
    private readonly sourceId: string,
  ) {}

  private cursorKey(meetingId: string) {
    return `meeting:${meetingId}`;
  }
  private async lastSyncedVersion(meetingId: string) {
    const row = await first<{ cursor: any }>(
      sql`SELECT cursor FROM connector_cursors WHERE source_id=${this.sourceId} AND scope_key=${this.cursorKey(meetingId)}`,
      this.store.db,
    );
    return (row?.cursor ?? {}) as { transcript_version?: number };
  }
  private async saveCursor(meetingId: string, version: number) {
    await sql`
      INSERT INTO connector_cursors(source_id, scope_key, cursor, last_reconciled_at, updated_at)
      VALUES (${this.sourceId}, ${this.cursorKey(meetingId)},
        ${JSON.stringify({ transcript_version: version })}::jsonb, now(), now())
      ON CONFLICT (source_id, scope_key) DO UPDATE
        SET cursor=EXCLUDED.cursor, last_reconciled_at=now(), updated_at=now()`.execute(
      this.store.db,
    );
  }

  /**
   * 회의 하나 동기화. canonical만 수집하고 draft partial은 근거에서 제외한다 (§5.3).
   * 표시 text와 raw_text를 함께 보존해 정정 전 문장이 current 근거가 되지 않는다.
   */
  private async syncMeeting(m: SharedMeeting) {
    const key = documentKeys.meetingTranscript(this.workspaceId, m.meeting_id);
    if (m.deleted_at || m.tombstoned) {
      await this.store.applyTombstone(key, this.sourceId, 'meeting_deleted_or_unshared');
      return { synced: false, deleted: true };
    }
    const last = await this.lastSyncedVersion(m.meeting_id);
    const revision = `tv:${m.transcript_version}`;
    if (last.transcript_version === m.transcript_version && m.transcript_version > 0)
      return { synced: false, unchanged: true };
    const segments = await this.meetings.canonicalSegments(m.meeting_id);
    const contentHash = sha256(JSON.stringify(segments));
    // 버전은 올랐는데 내용이 동일하면 dirty를 세우지 않는다 — 검색에서 숨겨지지 않는다.
    const marked = await this.store.markDocumentDirty(
      this.sourceId,
      key,
      { meeting_id: m.meeting_id, origin_guild_id: m.guild_id, status: m.status },
      {
        unlessHash: contentHash,
        revision,
        acl: { guild: m.guild_id, scope: `guild:${m.guild_id}` },
      },
    );
    if (marked === 'tombstoned') return { synced: false, deleted: true };
    if (marked === 'unchanged') {
      await this.saveCursor(m.meeting_id, m.transcript_version);
      return { synced: true, unchanged: true };
    }
    const doc = await first<{ id: string }>(
      sql`SELECT id FROM documents WHERE source_id=${this.sourceId} AND stable_key=${key}`,
      this.store.db,
    );
    if (!doc) return { synced: false };
    const published = await this.store.publishVersion(doc.id, {
      contentHash,
      sourceRevision: revision,
      sourceModifiedAt: m.ended_at ? new Date(m.ended_at) : null,
      normalized: {
        text: segments
          .map((s: any) => `[${s.speaker}] ${s.display_text ?? s.raw_text}`)
          .join('\n'),
        transcript_version: m.transcript_version,
        meeting_status: m.status,
        in_progress: m.status !== 'COMPLETED' && m.status !== 'PARTIAL' && !m.ended_at,
        segments: segments.map((s: any) => ({
          segment_id: s.segment_id,
          user_id: s.user_id,
          speaker: s.speaker,
          display_text: s.display_text ?? s.raw_text,
          raw_text: s.raw_text,
          start_ms: s.source_start_ms,
          end_ms: s.source_end_ms,
          versions: s.versions ?? null,
          replacements: s.replacements ?? null,
        })),
      },
    }, revision);
    if (published) {
      await queueExtract(this.store, doc.id, contentHash);
      await this.saveCursor(m.meeting_id, m.transcript_version);
    }
    return { synced: published };
  }

  /** 한 번 전체 대조 — 5초 주기 호출 (§6.4). */
  async syncOnce() {
    const meetings = await this.meetings.sharedMeetings(this.workspaceId);
    let synced = 0;
    for (const m of meetings) {
      const r = await this.syncMeeting(m);
      if (r.synced) synced++;
    }
    return { meetings: meetings.length, synced };
  }
}
