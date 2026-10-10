import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction, type RawBuilder } from 'kysely';
import { randomUUID, createHash } from 'node:crypto';
import {
  Event as EventSchema,
  GuildConfig,
  Segment,
  Snapshot,
  type GuildSettings,
  type MeetingViewDTO,
  type EventType,
  type EventPayloads,
  type MeetingEvent,
  type SegmentDTO,
  type ParticipantDTO,
  type GapDTO,
  type MarkerDTO,
  type Status,
  type SummaryDTO,
} from '@meeting/contracts';
import {
  DomainError,
  canTransition,
  displayText,
  escapeLike,
  canonicalJson,
} from '@meeting/domain';
export { createSummaryLedger } from './ledger.ts';
export { sql } from 'kysely';
export type Database = Record<string, never>;
export type Conn = Kysely<Database> | Transaction<Database>;
export const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const summaryOnly = (result: SummaryDTO): SummaryDTO => ({
  ...result,
  summary: result.summary.map((x) => x.replace(/(?:^|\n)(?:확인 필요|제안):\s*/g, '')),
  topics: result.topics.map((topic) => ({
    ...topic,
    evidence_segment_ids: topic.evidence_segment_ids.slice(0, 4),
    discussion: topic.discussion.replace(/(?:^|\n)(?:확인 필요|제안):\s*/g, ''),
  })),
  decisions: [],
  action_items: [],
  open_questions: [],
  blockers: [],
  next_agenda: [],
  quality_notes: [],
});
export const rows = async <T>(q: RawBuilder<T>, db: Conn) => (await q.execute(db)).rows;
export const first = async <T>(q: RawBuilder<T>, db: Conn) => (await rows(q, db))[0];
export interface MeetingRow {
  id: string;
  guild_id: string;
  voice_channel_id: string;
  record_channel_id: string;
  controller_id: string;
  status: Status;
  view: MeetingViewDTO;
  settings: GuildSettings;
  owner: string | null;
  fencing: string;
  lease_until: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  runtime: Record<string, any>;
}
export interface Job {
  id: string;
  key: string;
  kind: string;
  meeting_id: string | null;
  payload: Record<string, any>;
  attempts: number;
  generation: number;
  provider_job_id: string | null;
  summary_input_version?: number;
}
export interface EpisodeBody {
  members: {
    user_id: string;
    display_name: string;
    joined_at: number;
    facilitator: boolean;
    can_start: boolean;
  }[];
  stable_since: number | null;
  below_since: number | null;
  auto_sent: boolean;
  snooze_used: boolean;
  snooze_sent: boolean;
  meeting_id: string | null;
  restored: boolean;
  message_id: string | null;
  manual_ended: boolean;
}
export interface Episode {
  id: string;
  guild_id: string;
  channel_id: string;
  state: string;
  body: EpisodeBody;
  closed_at: Date | null;
  opened_at: Date;
}
export class Store {
  readonly pool: Pool;
  readonly db: Kysely<Database>;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 16,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    this.pool.on('error', () => {});
    this.db = new Kysely({ dialect: new PostgresDialect({ pool: this.pool }) });
  }
  async close() {
    await this.db.destroy();
  }
  async getConfig(guildId: string, db: Conn = this.db) {
    const row = await first(
      sql<{ config: unknown }>`SELECT config FROM guild_configs WHERE guild_id=${guildId}`,
      db,
    );
    return GuildConfig.parse(row?.config ?? {});
  }
  async setConfig(guildId: string, value: unknown, actor: string) {
    const config = GuildConfig.parse(value);
    if (config.bot_channel_id) {
      config.notification_channel_id = config.bot_channel_id;
      config.record_channel_id = config.bot_channel_id;
    }
    await this.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO guild_configs(guild_id,config) VALUES(${guildId},${json(config)}) ON CONFLICT(guild_id) DO UPDATE SET config=EXCLUDED.config,updated_at=now()`.execute(
        tx,
      );
      await sql`INSERT INTO glossary_versions(guild_id,version,entries,created_by) VALUES(${guildId},${config.glossary_version},${json(config.glossary)},${actor}) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await this.audit(tx, guildId, null, actor, 'CONFIG_CHANGED', {});
      await sql`SELECT pg_notify('authz_invalidated',${guildId})`.execute(tx);
    });
    return config;
  }
  async audit(
    db: Conn,
    guildId: string,
    meetingId: string | null,
    actor: string | null,
    kind: string,
    data: unknown,
  ) {
    await sql`INSERT INTO audit_events(id,guild_id,meeting_id,actor,kind,data) VALUES(${randomUUID()},${guildId},${meetingId},${actor},${kind},${json(data)})`.execute(
      db,
    );
  }
  async meeting(guildId: string, id: string, db: Conn = this.db) {
    const m = await first(
      sql<MeetingRow>`SELECT * FROM meetings WHERE id=${id}::uuid AND guild_id=${guildId} AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE meeting_id=meetings.id)`,
      db,
    );
    if (!m)
      throw new DomainError(
        'MEETING_NOT_FOUND',
        '회의를 찾을 수 없거나 열람 권한이 없습니다.',
        404,
      );
    return m;
  }
  async workspaceMeeting(workspaceId: string, id: string) {
    const m = await first(
      sql<MeetingRow>`SELECT m.* FROM meetings m JOIN workspace_meetings w ON w.meeting_id=m.id WHERE w.workspace_guild_id=${workspaceId} AND m.id=${id}::uuid AND m.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM deletion_tombstones d WHERE d.meeting_id=m.id)`,
      this.db,
    );
    if (!m) throw new DomainError('MEETING_NOT_FOUND', undefined, 404);
    return m;
  }
  async withMeeting<T>(
    guildId: string,
    id: string,
    fn: (tx: Transaction<Database>, m: MeetingRow) => Promise<T>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM meetings WHERE id=${id}::uuid AND guild_id=${guildId} FOR UPDATE`.execute(
        tx,
      );
      const m = await this.meeting(guildId, id, tx);
      await sql`SELECT meeting_id FROM meeting_event_counters WHERE meeting_id=${id}::uuid FOR UPDATE`.execute(
        tx,
      );
      return fn(tx, m);
    });
  }
  assertFence(m: MeetingRow, fencing?: string) {
    if (
      fencing !== undefined &&
      (m.fencing !== fencing || !m.lease_until || m.lease_until.getTime() <= Date.now())
    )
      throw new DomainError('STALE_LEASE', undefined, 409);
  }
  async event<K extends EventType>(db: Conn, m: MeetingRow, type: K, data: EventPayloads[K]) {
    const row = await first(
      sql<{
        last_seq: string;
      }>`UPDATE meeting_event_counters SET last_seq=last_seq+1 WHERE meeting_id=${m.id}::uuid RETURNING last_seq`,
      db,
    );
    if (!row) throw new Error('Missing meeting counter');
    const event = {
      schema_version: 1,
      meeting_id: m.id,
      event_seq: row.last_seq,
      type,
      emitted_at: new Date().toISOString(),
      data,
    } as MeetingEvent;
    EventSchema.parse(event);
    await sql`INSERT INTO meeting_events(meeting_id,event_seq,event) VALUES(${m.id}::uuid,${row.last_seq}::bigint,${json(event)})`.execute(
      db,
    );
    await sql`SELECT pg_notify('meeting_events',${m.id})`.execute(db);
    return event;
  }
  async saveView(db: Conn, m: MeetingRow) {
    await sql`UPDATE meetings SET view=${json(m.view)},status=${m.view.status},runtime=${json(m.runtime)} WHERE id=${m.id}::uuid`.execute(
      db,
    );
    m.status = m.view.status;
  }
  async enqueue(
    db: Conn,
    key: string,
    kind: string,
    meetingId: string | null,
    payload: unknown,
    due?: Date,
  ) {
    await sql`INSERT INTO jobs(id,key,kind,meeting_id,payload,due_at) VALUES(${randomUUID()},${key},${kind},${meetingId}::uuid,${json(payload)},${due ?? sql`now()`}) ON CONFLICT(key) DO NOTHING`.execute(
      db,
    );
  }
  async post(
    db: Conn,
    entityId: string,
    guildId: string,
    kind: string,
    revision: number,
    channelId: string,
    payload: unknown,
  ) {
    const settings = await this.getConfig(guildId, db);
    channelId = settings.bot_channel_id ?? channelId;
    await sql`INSERT INTO outbox(id,entity_id,guild_id,kind,revision,channel_id,payload) VALUES(${randomUUID()},${entityId}::uuid,${guildId},${kind},${revision},${channelId},${json(payload)}) ON CONFLICT DO NOTHING`.execute(
      db,
    );
  }
  async active(guildId: string) {
    return first(
      sql<MeetingRow>`SELECT * FROM meetings WHERE guild_id=${guildId} AND deleted_at IS NULL AND status IN ('STARTING','RECORDING','PAUSED','DEGRADED','STOPPING')`,
      this.db,
    );
  }
  async begin(input: {
    guildId: string;
    channelId: string;
    channelName: string;
    userId: string;
    interactionId: string;
    owner: string;
    participants: ParticipantDTO[];
    isMock: boolean;
  }) {
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.guildId},0))`.execute(tx);
      const previous = await first(
        sql<{
          result: { meeting_id: string };
        }>`SELECT result FROM processed_interactions WHERE interaction_id=${input.interactionId}`,
        tx,
      );
      if (previous) return this.meeting(input.guildId, previous.result.meeting_id, tx);
      const active = await first(
        sql<MeetingRow>`SELECT * FROM meetings WHERE guild_id=${input.guildId} AND deleted_at IS NULL AND status IN ('STARTING','RECORDING','PAUSED','DEGRADED','STOPPING')`,
        tx,
      );
      if (active) {
        await sql`INSERT INTO processed_interactions(interaction_id,guild_id,result) VALUES(${input.interactionId},${input.guildId},${json({ meeting_id: active.id })}) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
        return active;
      }
      const config = await this.getConfig(input.guildId, tx);
      if (
        (!config.detect_all_voice_channels &&
          !config.voice_channel_ids.includes(input.channelId)) ||
        !config.record_channel_id ||
        !config.notification_channel_id
      )
        throw new DomainError('SETUP_REQUIRED', '/회의 설정에서 채널과 역할을 먼저 등록해 주세요.');
      for (const p of input.participants) {
        if (!config.require_consent) continue;
        const valid = await first(
          sql`SELECT 1 FROM user_consents WHERE guild_id=${input.guildId} AND user_id=${p.user_id} AND policy_version=${config.policy_version} AND withdrawn_at IS NULL`,
          tx,
        );
        p.recording_eligible = p.recording_eligible && !!valid;
      }
      if (
        !input.participants.some(
          (p) => p.user_id === input.userId && p.present && p.recording_eligible,
        )
      )
        throw new DomainError(
          'CONSENT_REQUIRED',
          '현재 음성방의 기록 대상 참가자만 시작할 수 있습니다.',
        );
      if (!input.isMock && config.monthly_api_budget_krw === null)
        throw new DomainError('BUDGET_REQUIRED', '월간 API 예산을 설정해 주세요.');
      const used = await first(
        sql<{
          total: string;
        }>`SELECT coalesce(sum(cost_krw),0) AS total FROM usage_records WHERE guild_id=${input.guildId} AND is_mock=${input.isMock} AND created_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
        tx,
      );
      if (
        config.monthly_api_budget_krw !== null &&
        Number(used?.total ?? 0) >= config.monthly_api_budget_krw
      )
        throw new DomainError('BUDGET_EXCEEDED', '월 예산에 도달해 새 회의를 시작할 수 없습니다.');
      const id = randomUUID();
      const fence = await first(
        sql<{
          fencing: string;
        }>`INSERT INTO guild_leases(guild_id,fencing) VALUES(${input.guildId},1) ON CONFLICT(guild_id) DO UPDATE SET fencing=guild_leases.fencing+1 RETURNING fencing`,
        tx,
      );
      const view: MeetingViewDTO = {
        meeting_id: id,
        guild_id: input.guildId,
        title: input.channelName + ' 회의',
        voice_channel_name: input.channelName,
        status: 'STARTING',
        started_at: null,
        ended_at: null,
        transcript_version: 0,
        summary_status: 'NOT_REQUESTED',
        summary_version: null,
        last_final_at: null,
      };
      await sql`INSERT INTO meetings(id,guild_id,voice_channel_id,record_channel_id,controller_id,status,view,settings,owner,fencing,lease_until,runtime) VALUES(${id},${input.guildId},${input.channelId},${config.record_channel_id},${input.userId},'STARTING',${json(view)},${json(config)},${input.owner},${fence!.fencing}::bigint,now()+interval '15 seconds',${json({ max_end_at: Date.now() + config.max_duration_ms, mode: input.isMock ? 'mock' : 'real' })})`.execute(
        tx,
      );
      await sql`INSERT INTO meeting_event_counters(meeting_id) VALUES(${id})`.execute(tx);
      const m = await this.meeting(input.guildId, id, tx);
      for (const p of input.participants)
        await sql`INSERT INTO meeting_participants(meeting_id,user_id,body,intervals) VALUES(${id},${p.user_id},${json(p)},${json([{ at: new Date().toISOString(), present: p.present, eligible: p.recording_eligible }])})`.execute(
          tx,
        );
      await sql`INSERT INTO processed_interactions(interaction_id,guild_id,result) VALUES(${input.interactionId},${input.guildId},${json({ meeting_id: id })})`.execute(
        tx,
      );
      await sql`INSERT INTO workspace_meetings(workspace_guild_id,meeting_id) VALUES(${input.guildId},${id}::uuid)`.execute(
        tx,
      );
      await sql`UPDATE occupancy_episodes SET body=jsonb_set(body,'{meeting_id}',${json(id)}) WHERE channel_id=${input.channelId} AND closed_at IS NULL`.execute(
        tx,
      );
      await sql`UPDATE durable_timers SET status='CANCELLED',generation=generation+1 WHERE guild_id=${input.guildId} AND kind IN ('PROMPT','REMIND','SNOOZE') AND status IN ('PENDING','RUNNING')`.execute(
        tx,
      );
      await this.event(tx, m, 'meeting.updated', { meeting: view });
      await this.post(tx, id, input.guildId, 'RECORDING', 1, config.notification_channel_id, {
        meeting_id: id,
      });
      return m;
    });
  }
  async heartbeat(id: string, owner: string, fencing: string) {
    const r = await first(
      sql<{
        id: string;
      }>`UPDATE meetings SET lease_until=now()+interval '15 seconds' WHERE id=${id}::uuid AND owner=${owner} AND fencing=${fencing}::bigint AND deleted_at IS NULL AND lease_until>now() RETURNING id`,
      this.db,
    );
    return !!r;
  }
  async reclaim(guildId: string, id: string, owner: string) {
    return this.withMeeting(guildId, id, async (tx, m) => {
      if (m.lease_until && m.lease_until.getTime() > Date.now() && m.owner !== owner) return null;
      const f = await first(
        sql<{
          fencing: string;
        }>`UPDATE guild_leases SET fencing=fencing+1 WHERE guild_id=${guildId} RETURNING fencing`,
        tx,
      );
      await sql`UPDATE meetings SET owner=${owner},fencing=${f!.fencing}::bigint,lease_until=now()+interval '15 seconds' WHERE id=${id}::uuid`.execute(
        tx,
      );
      return this.meeting(guildId, id, tx);
    });
  }
  async transition(guildId: string, id: string, to: Status, fencing?: string) {
    return this.withMeeting(guildId, id, (tx, m) => this.transitionLocked(tx, m, to, fencing));
  }
  /** Caller must hold the meeting row lock through withMeeting. */
  async transitionLocked(tx: Conn, m: MeetingRow, to: Status, fencing?: string) {
    const { id, guild_id: guildId } = m;
    this.assertFence(m, fencing);
    if (m.status === to) return m;
    if (!canTransition(m.status, to)) throw new DomainError('INVALID_STATE', undefined, 409);
    m.view.status = to;
    const now = new Date().toISOString();
    if (to === 'RECORDING' && !m.view.started_at) m.view.started_at = now;
    if (to === 'STOPPING') {
      m.view.ended_at = now;
      m.runtime.stopped_at = Date.now();
    }
    if (to === 'PAUSED') m.runtime.paused_at = Date.now();
    if (to === 'FINALIZING') {
      m.view.summary_status = 'PENDING';
      await sql`UPDATE meetings SET owner=NULL,lease_until=NULL WHERE id=${id}::uuid`.execute(tx);
      await this.enqueue(
        tx,
        `finalize:${id}`,
        'FINALIZE',
        id,
        { guild_id: guildId },
        new Date(Date.now() + 2000),
      );
    }
    await this.saveView(tx, m);
    await this.event(tx, m, 'meeting.updated', { meeting: m.view });
    return m;
  }
  async extendCaptureDeadline(
    guildId: string,
    id: string,
    kind: 'continue' | 'extend',
    fencing?: string,
  ) {
    return this.withMeeting(guildId, id, async (tx, m) => {
      this.assertCaptureControllable(m);
      this.assertFence(m, fencing);
      if (kind === 'continue') m.runtime.one_deadline = Date.now() + 600000;
      else m.runtime.max_end_at = Number(m.runtime.max_end_at) + 3600000;
      await this.saveView(tx, m);
      return m;
    });
  }
  private assertCaptureControllable(m: MeetingRow) {
    if (!['RECORDING', 'PAUSED', 'DEGRADED'].includes(m.status))
      throw new DomainError(
        'MEETING_NOT_RECORDING',
        '종료되었거나 기록 중이 아닌 회의입니다. /회의 상태에서 확인해 주세요.',
        409,
      );
  }
  async setParticipants(guildId: string, id: string, participants: ParticipantDTO[]) {
    await this.withMeeting(guildId, id, async (tx, m) => {
      let changed = false;
      for (const p of participants) {
        const old = await first(
          sql<{
            body: ParticipantDTO;
          }>`SELECT body FROM meeting_participants WHERE meeting_id=${id}::uuid AND user_id=${p.user_id}`,
          tx,
        );
        if (JSON.stringify(old?.body) === JSON.stringify(p)) continue;
        changed = true;
        await sql`INSERT INTO meeting_participants(meeting_id,user_id,body,intervals) VALUES(${id}::uuid,${p.user_id},${json(p)},${json([{ at: new Date().toISOString(), present: p.present, eligible: p.recording_eligible }])}) ON CONFLICT(meeting_id,user_id) DO UPDATE SET body=EXCLUDED.body,intervals=meeting_participants.intervals||EXCLUDED.intervals`.execute(
          tx,
        );
      }
      if (!changed) return;
      const all = (
        await rows(
          sql<{
            body: ParticipantDTO;
          }>`SELECT body FROM meeting_participants WHERE meeting_id=${id}::uuid`,
          tx,
        )
      ).map((r) => r.body);
      await this.event(tx, m, 'participants.updated', { participants: all });
    });
  }
  async consentLock(db: Conn, guildId: string, userId: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId + ':' + userId + ':consent'},0))`.execute(
      db,
    );
  }
  async consent(guildId: string, userId: string, accept: boolean) {
    await this.db.transaction().execute(async (tx) => {
      await this.consentLock(tx, guildId, userId);
      const c = await this.getConfig(guildId, tx);
      await sql`INSERT INTO user_consents(guild_id,user_id,policy_version,withdrawn_at) VALUES(${guildId},${userId},${c.policy_version},${accept ? null : new Date()}) ON CONFLICT(guild_id,user_id,policy_version) DO UPDATE SET accepted_at=CASE WHEN ${accept} AND user_consents.withdrawn_at IS NOT NULL THEN now() ELSE user_consents.accepted_at END,withdrawn_at=EXCLUDED.withdrawn_at`.execute(
        tx,
      );
      if (!accept)
        await sql`UPDATE user_consents SET withdrawn_at=now() WHERE guild_id=${guildId} AND user_id=${userId}`.execute(
          tx,
        );
      if (!accept)
        await sql`UPDATE jobs SET status='CANCELLED',generation=generation+1,error_code='CONSENT_WITHDRAWN',owner=NULL,lease_until=NULL WHERE kind='RETRANSCRIBE' AND payload->>'guild_id'=${guildId} AND payload->>'user_id'=${userId} AND (payload->>'capture_recovery'='true' OR key LIKE 'recover:%' OR key LIKE 'recovered-gap:%') AND status IN ('PENDING','RUNNING')`.execute(
          tx,
        );
      await this.audit(tx, guildId, null, userId, accept ? 'CONSENT' : 'WITHDRAW', {
        policy_version: c.policy_version,
      });
    });
  }
  async enqueueRecovery(
    guildId: string,
    id: string,
    key: string,
    payload: Record<string, any>,
    due?: Date,
  ) {
    return this.withMeeting(guildId, id, async (tx, m) => {
      const userId = String(payload.user_id);
      await this.consentLock(tx, guildId, userId);
      const c =
        m.settings.require_consent === false
          ? { epoch: 'team-recording' }
          : await first(
              sql<{
                epoch: string;
              }>`SELECT accepted_at::text AS epoch FROM user_consents WHERE guild_id=${guildId} AND user_id=${userId} AND policy_version=${m.settings.policy_version} AND withdrawn_at IS NULL`,
              tx,
            );
      if (!c) return false;
      await this.enqueue(
        tx,
        key,
        'RETRANSCRIBE',
        id,
        { ...payload, guild_id: guildId, capture_recovery: true, consent_epoch: c.epoch },
        due,
      );
      return true;
    });
  }
  async assertRecoveryConsent(db: Conn, job: Job) {
    if (!job.payload.capture_recovery && !/^(recover:|recovered-gap:)/.test(job.key)) return;
    const guildId = String(job.payload.guild_id),
      userId = String(job.payload.user_id);
    await this.consentLock(db, guildId, userId);
    const meeting = await this.meeting(guildId, job.meeting_id!, db);
    if (meeting.settings.require_consent === false) return;
    const c = await first(
      sql<{
        epoch: string;
      }>`SELECT accepted_at::text AS epoch FROM user_consents c JOIN meetings m ON m.guild_id=c.guild_id AND m.settings->>'policy_version'=c.policy_version WHERE m.id=${job.meeting_id}::uuid AND c.guild_id=${guildId} AND c.user_id=${userId} AND c.withdrawn_at IS NULL`,
      db,
    );
    if (!c || (job.payload.consent_epoch && c.epoch !== job.payload.consent_epoch))
      throw new DomainError('CONSENT_WITHDRAWN');
  }
  async consented(guildId: string, userId: string) {
    const c = await this.getConfig(guildId);
    if (!c.require_consent) return true;
    return !!(await first(
      sql`SELECT 1 FROM user_consents WHERE guild_id=${guildId} AND user_id=${userId} AND policy_version=${c.policy_version} AND withdrawn_at IS NULL`,
      this.db,
    ));
  }
  async captureAllowed(guildId: string, id: string, userId: string, fencing: string) {
    return !!(await first(
      sql`SELECT 1 FROM meetings m JOIN meeting_participants p ON p.meeting_id=m.id LEFT JOIN user_consents c ON c.guild_id=m.guild_id AND c.user_id=p.user_id AND c.policy_version=m.settings->>'policy_version' WHERE m.id=${id}::uuid AND m.guild_id=${guildId} AND m.fencing=${fencing}::bigint AND m.lease_until>now() AND m.deleted_at IS NULL AND m.status IN ('RECORDING','DEGRADED') AND p.user_id=${userId} AND (p.body->>'recording_eligible')::boolean AND (p.body->>'present')::boolean AND (m.settings->>'require_consent'='false' OR (c.user_id IS NOT NULL AND c.withdrawn_at IS NULL))`,
      this.db,
    ));
  }
  async stale(tx: Conn, m: MeetingRow) {
    if (m.view.summary_version !== null || m.view.summary_status === 'RUNNING') {
      m.view.summary_status = 'STALE';
      await this.event(tx, m, 'summary.updated', {
        status: 'STALE',
        summary_version: m.view.summary_version,
        transcript_version: m.view.transcript_version,
      });
    }
    if (['FINALIZING', 'COMPLETED', 'PARTIAL'].includes(m.status))
      await this.enqueue(
        tx,
        `finalize:${m.id}:${m.view.transcript_version}`,
        'FINALIZE',
        m.id,
        { guild_id: m.guild_id },
        new Date(Date.now() + 500),
      );
  }
  async upsertTranscript(input: {
    guildId: string;
    meetingId: string;
    userId: string;
    displayName: string;
    sourceKey: string;
    start: number;
    end: number | null;
    text: string;
    final: boolean;
    fencing?: string;
    flags?: string[];
  }) {
    return this.withMeeting(input.guildId, input.meetingId, async (tx, m) => {
      this.assertFence(m, input.fencing);
      if (!['RECORDING', 'DEGRADED', 'PAUSED', 'STOPPING'].includes(m.status)) return null;
      const oldFinal = await first(
        sql<{
          body: SegmentDTO;
        }>`SELECT body FROM transcript_segments WHERE meeting_id=${m.id}::uuid AND source_key=${input.sourceKey}`,
        tx,
      );
      if (oldFinal) return null;
      const draft = await first(
        sql<{
          body: SegmentDTO;
        }>`SELECT body FROM transcript_drafts WHERE meeting_id=${m.id}::uuid AND source_key=${input.sourceKey}`,
        tx,
      );
      const text = displayText(input.text, m.settings.glossary);
      if (!input.final && draft?.body.text === text) return null;
      const body: SegmentDTO = Segment.parse({
        segment_id: draft?.body.segment_id ?? randomUUID(),
        user_id: input.userId,
        display_name: input.displayName,
        start_ms: draft?.body.start_ms ?? Math.max(0, Math.round(input.start)),
        end_ms: input.final
          ? Math.max(Math.round(input.end ?? input.start), draft?.body.start_ms ?? input.start)
          : null,
        text,
        is_final: input.final,
        revision: (draft?.body.revision ?? 0) + 1,
        corrected: false,
        quality_flags: input.flags ?? [],
        overlap_group_id: null,
        updated_at: new Date().toISOString(),
      });
      if (input.final && !input.text.trim()) {
        if (draft) {
          await sql`DELETE FROM transcript_drafts WHERE segment_id=${body.segment_id}::uuid`.execute(
            tx,
          );
          await this.event(tx, m, 'draft.remove', {
            segment_id: body.segment_id,
            revision: body.revision,
            reason: 'EMPTY',
          });
        }
        return null;
      }
      if (input.final) {
        const rangeDuplicate = await first(
          sql`SELECT 1 FROM transcript_segments WHERE meeting_id=${m.id}::uuid AND user_id=${input.userId} AND source_start_ms=${body.start_ms} AND source_end_ms=${body.end_ms}`,
          tx,
        );
        if (rangeDuplicate) {
          if (draft) {
            await sql`DELETE FROM transcript_drafts WHERE segment_id=${body.segment_id}::uuid`.execute(
              tx,
            );
            await this.event(tx, m, 'draft.remove', {
              segment_id: body.segment_id,
              revision: body.revision,
              reason: 'DISCARDED',
            });
          }
          return null;
        }
        const overlapping = await first(
          sql<{
            body: SegmentDTO;
          }>`SELECT body FROM transcript_segments WHERE meeting_id=${m.id}::uuid AND canonical AND user_id<>${input.userId} AND source_start_ms<${body.end_ms} AND source_end_ms>${body.start_ms} LIMIT 1`,
          tx,
        );
        if (overlapping) body.quality_flags.push('OVERLAPPING_SPEECH');
        m.view.transcript_version++;
        m.view.last_final_at = new Date().toISOString();
        await sql`INSERT INTO transcript_segments(segment_id,meeting_id,user_id,source_key,raw_text,body,source_start_ms,source_end_ms) VALUES(${body.segment_id},${m.id},${input.userId},${input.sourceKey},${input.text},${json(body)},${body.start_ms},${body.end_ms})`.execute(
          tx,
        );
        await sql`INSERT INTO segment_versions(segment_id,meeting_id,valid_from,raw_text,body) VALUES(${body.segment_id},${m.id},${m.view.transcript_version},${input.text},${json(body)})`.execute(
          tx,
        );
        await sql`DELETE FROM transcript_drafts WHERE segment_id=${body.segment_id}::uuid`.execute(
          tx,
        );
      } else {
        await sql`INSERT INTO transcript_drafts(segment_id,meeting_id,user_id,source_key,body) VALUES(${body.segment_id},${m.id},${input.userId},${input.sourceKey},${json(body)}) ON CONFLICT(meeting_id,source_key) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`.execute(
          tx,
        );
      }
      await this.event(tx, m, 'segment.upsert', {
        segment: body,
        transcript_version: m.view.transcript_version,
      });
      if (input.final) await this.stale(tx, m);
      await this.saveView(tx, m);
      return body;
    });
  }
  async correct(guildId: string, id: string, segmentId: string, text: string, actor: string) {
    if (!text.trim() || text.length > 20000) throw new DomainError('INVALID_ARGUMENT');
    return this.withMeeting(guildId, id, async (tx, m) => {
      const s = await first(
        sql<{
          body: SegmentDTO;
          raw_text: string;
        }>`SELECT body,raw_text FROM transcript_segments WHERE meeting_id=${id}::uuid AND segment_id=${segmentId}::uuid AND canonical`,
        tx,
      );
      if (!s) throw new DomainError('SEGMENT_NOT_FOUND', undefined, 404);
      const body = {
        ...s.body,
        text,
        corrected: true,
        revision: s.body.revision + 1,
        updated_at: new Date().toISOString(),
      };
      m.view.transcript_version++;
      await sql`UPDATE transcript_segments SET body=${json(body)} WHERE segment_id=${segmentId}::uuid`.execute(
        tx,
      );
      await sql`UPDATE segment_versions SET valid_to=${m.view.transcript_version - 1} WHERE segment_id=${segmentId}::uuid AND valid_to IS NULL`.execute(
        tx,
      );
      await sql`INSERT INTO segment_versions(segment_id,meeting_id,valid_from,raw_text,body) VALUES(${segmentId}::uuid,${id}::uuid,${m.view.transcript_version},${s.raw_text},${json(body)})`.execute(
        tx,
      );
      await this.audit(tx, guildId, id, actor, 'TRANSCRIPT_CORRECTED', {
        segment_id: segmentId,
        before: s.body.text,
        after: text,
      });
      await this.event(tx, m, 'segment.upsert', {
        segment: body,
        transcript_version: m.view.transcript_version,
      });
      await this.stale(tx, m);
      await this.saveView(tx, m);
      return body;
    });
  }
  async replaceRange(
    guildId: string,
    id: string,
    userId: string,
    start: number,
    end: number,
    replacements: SegmentDTO[],
    job: Job,
    rawTexts: Record<string, string> = {},
  ) {
    return this.withMeeting(guildId, id, async (tx, m) => {
      await this.assertRecoveryConsent(tx, job);
      await this.assertJob(tx, job);
      const applied = await first(
        sql<{
          transcript_version: number;
        }>`SELECT transcript_version FROM recovery_applications WHERE job_key=${job.key}`,
        tx,
      );
      if (applied) return applied.transcript_version;
      const old = await rows(
        sql<{
          body: SegmentDTO;
        }>`SELECT body FROM transcript_segments WHERE meeting_id=${id}::uuid AND user_id=${userId} AND canonical AND source_start_ms<${end} AND source_end_ms>${start}`,
        tx,
      );
      if (old.some((s) => s.body.corrected))
        throw new DomainError(
          'HUMAN_CORRECTION_CONFLICT',
          '정정된 구간은 자동 재전사로 덮어쓸 수 없습니다.',
        );
      m.view.transcript_version++;
      const removals = old.map((s) => ({
        segment_id: s.body.segment_id,
        revision: s.body.revision + 1,
      }));
      for (const oldSegment of old) {
        await sql`UPDATE transcript_segments SET canonical=false WHERE segment_id=${oldSegment.body.segment_id}::uuid`.execute(
          tx,
        );
        await sql`UPDATE segment_versions SET valid_to=${m.view.transcript_version - 1} WHERE segment_id=${oldSegment.body.segment_id}::uuid AND valid_to IS NULL`.execute(
          tx,
        );
      }
      for (const body of replacements) {
        Segment.parse(body);
        await sql`INSERT INTO transcript_segments(segment_id,meeting_id,user_id,source_key,raw_text,body,source_start_ms,source_end_ms) VALUES(${body.segment_id},${id},${userId},${`file:${job.key}:${body.segment_id}`},${rawTexts[body.segment_id] ?? body.text},${json(body)},${body.start_ms},${body.end_ms})`.execute(
          tx,
        );
        await sql`INSERT INTO segment_versions(segment_id,meeting_id,valid_from,raw_text,body) VALUES(${body.segment_id},${id},${m.view.transcript_version},${rawTexts[body.segment_id] ?? body.text},${json(body)})`.execute(
          tx,
        );
        for (const oldSegment of old)
          await sql`INSERT INTO segment_replacements(meeting_id,previous_id,replacement_id,transcript_version) VALUES(${id},${oldSegment.body.segment_id},${body.segment_id},${m.view.transcript_version})`.execute(
            tx,
          );
      }
      await this.event(tx, m, 'segment.replace', {
        removals,
        replacements,
        transcript_version: m.view.transcript_version,
      });
      const drafts = await rows(
        sql<{
          body: SegmentDTO;
        }>`SELECT body FROM transcript_drafts WHERE meeting_id=${id}::uuid AND user_id=${userId}`,
        tx,
      );
      for (const d of drafts.filter((d) => d.body.start_ms >= start && d.body.start_ms < end)) {
        await sql`DELETE FROM transcript_drafts WHERE segment_id=${d.body.segment_id}`.execute(tx);
        await this.event(tx, m, 'draft.remove', {
          segment_id: d.body.segment_id,
          revision: d.body.revision + 1,
          reason: 'RECOVERY_PENDING',
        });
      }
      await this.stale(tx, m);
      await this.saveView(tx, m);
      await sql`INSERT INTO recovery_applications(job_key,meeting_id,transcript_version) VALUES(${job.key},${id}::uuid,${m.view.transcript_version})`.execute(
        tx,
      );
      return m.view.transcript_version;
    });
  }
  async recoverPendingAudio(guildId: string, id: string, cutoff: number, settleUnrecoverable = false) {
    const snapshot = await this.snapshot(guildId, id);
    for (const draft of snapshot.segments.filter((s) => !s.is_final)) {
      if (
        snapshot.gaps.some(
          (g) =>
            g.user_id === draft.user_id &&
            g.reason === 'STT_PENDING' &&
            !g.resolved &&
            g.start_ms <= draft.start_ms,
        )
      )
        continue;
      const gap: GapDTO = {
        gap_id: randomUUID(),
        user_id: draft.user_id,
        start_ms: draft.start_ms,
        end_ms: Math.max(draft.start_ms, Math.round(cutoff)),
        reason: 'STT_PENDING',
        recoverable: true,
        resolved: false,
      };
      await this.gap(guildId, id, gap);
      snapshot.gaps.push(gap);
    }
    for (const gap of snapshot.gaps.filter(
      (g) => g.user_id && g.reason === 'STT_PENDING' && g.recoverable && !g.resolved,
    )) {
      const existing = await first(
        sql`SELECT 1 FROM jobs WHERE meeting_id=${id}::uuid AND kind='RETRANSCRIBE' AND payload->>'gap_id'=${gap.gap_id}`,
        this.db,
      );
      if (existing) continue;
      const end = gap.end_ms ?? Math.max(gap.start_ms, Math.round(cutoff));
      const audio = await first(
        sql<{
          n: string;
        }>`SELECT count(*) AS n FROM audio_chunks WHERE meeting_id=${id}::uuid AND user_id=${gap.user_id} AND start_ms<${end} AND end_ms>${gap.start_ms} AND expires_at>now()`,
        this.db,
      );
      const updated = { ...gap, end_ms: end, recoverable: Number(audio?.n) > 0 };
      await this.gap(guildId, id, updated);
      Object.assign(gap, updated);
      if (updated.recoverable && end > gap.start_ms)
        await this.enqueueRecovery(guildId, id, `recovered-gap:${gap.gap_id}`, {
          guild_id: guildId,
          user_id: gap.user_id,
          start_ms: gap.start_ms,
          end_ms: end,
          gap_id: gap.gap_id,
        });
    }
    // Close gaps that can never be recovered so the meeting can finalize instead of staying PARTIAL forever.
    if (settleUnrecoverable)
      for (const gap of snapshot.gaps.filter(
        (g) => !g.resolved && g.reason !== 'PAUSED' && !g.recoverable,
      )) {
        const closed = { ...gap, resolved: true, resolution: 'UNRECOVERABLE' as const };
        await this.gap(guildId, id, closed);
        Object.assign(gap, closed);
      }
    await this.clearDrafts(guildId, id);
  }
  async clearDrafts(guildId: string, id: string, userId?: string) {
    await this.withMeeting(guildId, id, async (tx, m) => {
      const drafts = await rows(
        sql<{
          body: SegmentDTO;
        }>`DELETE FROM transcript_drafts WHERE meeting_id=${id}::uuid ${userId ? sql`AND user_id=${userId}` : sql``} RETURNING body`,
        tx,
      );
      for (const d of drafts)
        await this.event(tx, m, 'draft.remove', {
          segment_id: d.body.segment_id,
          revision: d.body.revision + 1,
          reason: 'RECOVERY_PENDING',
        });
    });
  }
  async completeEmptyRecovery(job: Job) {
    const guildId = String(job.payload.guild_id);
    await this.withMeeting(guildId, job.meeting_id!, async (tx, m) => {
      await this.assertJob(tx, job);
      await this.assertRecoveryConsent(tx, job);
      const row = await first(
        sql<{
          body: GapDTO;
        }>`SELECT body FROM coverage_gaps WHERE meeting_id=${m.id}::uuid AND id::text=${String(job.payload.gap_id ?? '')} FOR UPDATE`,
        tx,
      );
      if (row) {
        const gap = { ...row.body, resolved: true, resolution: 'NO_SPEECH_OR_NOISE' as const };
        await sql`UPDATE coverage_gaps SET body=${json(gap)} WHERE id=${gap.gap_id}::uuid`.execute(
          tx,
        );
        await this.event(tx, m, 'gap.upsert', { gap });
      }
      await sql`UPDATE jobs SET payload=payload || ${json({ result: 'NO_SPEECH_OR_NOISE' })} WHERE id=${job.id}::uuid`.execute(
        tx,
      );
      await this.audit(tx, guildId, m.id, null, 'RECOVERY_NO_SPEECH', {
        job_id: job.id,
        gap_id: job.payload.gap_id ?? null,
      });
    });
  }
  async gap(guildId: string, id: string, gap: GapDTO) {
    await this.withMeeting(guildId, id, async (tx, m) => {
      await sql`INSERT INTO coverage_gaps(id,meeting_id,body) VALUES(${gap.gap_id},${id},${json(gap)}) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body`.execute(
        tx,
      );
      await this.event(tx, m, 'gap.upsert', { gap });
    });
  }
  async marker(guildId: string, id: string, userId: string, label: string | null) {
    return this.withMeeting(guildId, id, async (tx, m) => {
      this.assertCaptureControllable(m);
      const marker: MarkerDTO = {
        marker_id: randomUUID(),
        at_ms: m.view.started_at ? Date.now() - Date.parse(m.view.started_at) : 0,
        label,
        created_by: userId,
      };
      await sql`INSERT INTO meeting_markers(id,meeting_id,body) VALUES(${marker.marker_id},${id},${json(marker)})`.execute(
        tx,
      );
      await this.event(tx, m, 'marker.upsert', { marker });
      return marker;
    });
  }
  async snapshot(guildId: string, id: string) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        const m = await this.meeting(guildId, id, tx);
        const c = await first(
          sql<{
            last_seq: string;
          }>`SELECT last_seq FROM meeting_event_counters WHERE meeting_id=${id}::uuid`,
          tx,
        );
        const page = await rows(
          sql<{
            body: SegmentDTO;
          }>`SELECT body FROM transcript_segments WHERE meeting_id=${id}::uuid AND canonical ORDER BY source_start_ms DESC,user_id DESC,segment_id DESC LIMIT 201`,
          tx,
        );
        const segments = page
          .slice(0, 200)
          .reverse()
          .map((s) => s.body);
        const drafts = await rows(
          sql<{
            body: SegmentDTO;
          }>`SELECT body FROM transcript_drafts WHERE meeting_id=${id}::uuid`,
          tx,
        );
        return Snapshot.parse({
          schema_version: 1,
          cursor: c!.last_seq,
          server_time: new Date().toISOString(),
          meeting: m.view,
          participants: (
            await rows(
              sql<{
                body: ParticipantDTO;
              }>`SELECT body FROM meeting_participants WHERE meeting_id=${id}::uuid`,
              tx,
            )
          ).map((r) => r.body),
          segments: [...segments, ...drafts.map((s) => s.body)],
          gaps: (
            await rows(
              sql<{ body: GapDTO }>`SELECT body FROM coverage_gaps WHERE meeting_id=${id}::uuid`,
              tx,
            )
          ).map((r) => r.body),
          markers: (
            await rows(
              sql<{
                body: MarkerDTO;
              }>`SELECT body FROM meeting_markers WHERE meeting_id=${id}::uuid`,
              tx,
            )
          ).map((r) => r.body),
          has_older: page.length > 200,
          older_cursor: segments[0] ? encodePage(segments[0]) : null,
        });
      });
  }
  async transcript(
    guildId: string,
    id: string,
    options: {
      before?: string;
      limit?: number;
      speaker?: string;
      q?: string;
      version?: number;
    } = {},
  ) {
    const m = await this.meeting(guildId, id);
    const limit = Math.min(options.limit ?? 100, 200);
    if (
      options.version !== undefined &&
      (options.version < 0 || options.version > m.view.transcript_version)
    )
      throw new DomainError('INVALID_ARGUMENT');
    const cursor = options.before ? decodePage(options.before) : null;
    const source =
      options.version !== undefined
        ? sql`(SELECT body FROM segment_versions WHERE meeting_id=${id}::uuid AND valid_from<=${options.version} AND (valid_to IS NULL OR valid_to>=${options.version})) t`
        : sql`(SELECT body FROM transcript_segments WHERE meeting_id=${id}::uuid AND canonical) t`;
    const found = await rows(
      sql<{
        body: SegmentDTO;
      }>`SELECT body FROM ${source} WHERE true ${options.speaker ? sql`AND body->>'user_id'=${options.speaker}` : sql``} ${options.q ? sql`AND (body->>'is_final')::boolean=true AND body->>'text' ILIKE ${'%' + escapeLike(options.q) + '%'}` : sql``} ${cursor ? sql`AND ((body->>'start_ms')::int,body->>'user_id',body->>'segment_id')<(${cursor.start},${cursor.user},${cursor.id})` : sql``} ORDER BY (body->>'start_ms')::int DESC,body->>'user_id' DESC,body->>'segment_id' DESC LIMIT ${limit + 1}`,
      this.db,
    );
    const page = found.slice(0, limit).map((r) => r.body);
    return {
      segments: page.reverse(),
      has_older: found.length > limit,
      older_cursor: page[0] ? encodePage(page[0]) : null,
      transcript_version: options.version ?? m.view.transcript_version,
    };
  }
  async allSegments(guildId: string, id: string, version?: number) {
    const m = await this.meeting(guildId, id);
    const v = version ?? m.view.transcript_version;
    if (v < 0 || v > m.view.transcript_version) throw new DomainError('INVALID_ARGUMENT');
    return (
      await rows(
        sql<{
          body: SegmentDTO;
        }>`SELECT body FROM segment_versions WHERE meeting_id=${id}::uuid AND valid_from<=${v} AND (valid_to IS NULL OR valid_to>=${v}) ORDER BY (body->>'start_ms')::int,body->>'user_id',segment_id`,
        this.db,
      )
    ).map((r) => r.body);
  }
  async segmentContext(guildId: string, id: string, segmentId: string, version?: number) {
    const m = await this.meeting(guildId, id);
    const v = version ?? m.view.transcript_version;
    const original = await first(
      sql<{
        body: SegmentDTO;
      }>`SELECT body FROM segment_versions WHERE meeting_id=${id}::uuid AND segment_id=${segmentId}::uuid AND valid_from<=${v} ORDER BY valid_from DESC LIMIT 1`,
      this.db,
    );
    if (!original) throw new DomainError('SEGMENT_NOT_FOUND', undefined, 404);
    const replacements = await rows(
      sql<{
        replacement_id: string;
      }>`WITH RECURSIVE chain(id,depth) AS (SELECT replacement_id,1 FROM segment_replacements WHERE meeting_id=${id}::uuid AND previous_id=${segmentId}::uuid AND transcript_version<=${v} UNION ALL SELECT r.replacement_id,c.depth+1 FROM segment_replacements r JOIN chain c ON r.previous_id=c.id WHERE r.meeting_id=${id}::uuid AND r.transcript_version<=${v} AND c.depth<32) SELECT DISTINCT id AS replacement_id FROM chain WHERE NOT EXISTS(SELECT 1 FROM segment_replacements WHERE previous_id=chain.id AND transcript_version<=${v})`,
      this.db,
    );
    const all = await this.allSegments(guildId, id, v);
    const target = replacements[0]?.replacement_id ?? segmentId;
    const at = all.findIndex((s) => s.segment_id === target);
    return {
      segment: original.body,
      context: at < 0 ? [] : all.slice(Math.max(0, at - 2), at + 3),
      replacement_ids: replacements.map((r) => r.replacement_id),
      transcript_version: v,
    };
  }
  async eventRange(id: string) {
    return first(
      sql<{
        last_seq: string;
        floor_seq: string;
      }>`SELECT last_seq,floor_seq FROM meeting_event_counters WHERE meeting_id=${id}::uuid`,
      this.db,
    );
  }
  async events(id: string, after: string) {
    return (
      await rows(
        sql<{
          event: MeetingEvent;
        }>`SELECT event FROM meeting_events WHERE meeting_id=${id}::uuid AND event_seq>${after}::bigint ORDER BY event_seq LIMIT 500`,
        this.db,
      )
    ).map((r) => r.event);
  }
  async summary(guildId: string, id: string) {
    const m = await this.meeting(guildId, id);
    const s =
      m.view.summary_version === null ||
      (m.view.summary_status === 'FAILED' && m.runtime.mode === 'real')
        ? null
        : await first(
            sql<{
              result: SummaryDTO;
              transcript_version: number;
              model: string;
              partial: boolean;
              created_at: Date;
            }>`SELECT * FROM summaries WHERE meeting_id=${id}::uuid AND summary_version=${m.view.summary_version}`,
            this.db,
          );
    return {
      summary_status: m.view.summary_status,
      summary_version: m.view.summary_version,
      transcript_version: s?.transcript_version ?? m.view.transcript_version,
      result: s?.result ? summaryOnly(s.result) : null,
      generated_at: s?.created_at.toISOString() ?? null,
      model: s?.model ?? null,
      partial: s?.partial ?? false,
      review_status: 'UNREVIEWED' as const,
    };
  }
  async adoptSummary(
    guildId: string,
    id: string,
    version: number,
    result: SummaryDTO,
    model: string,
    promptHash: string,
    partial: boolean,
    job: Job,
    proof?: { runId: string; outputHash: string },
    pending = partial,
  ) {
    return this.withMeeting(guildId, id, async (tx, m) => {
      await this.assertJob(tx, job);
      if (m.view.transcript_version !== version) {
        m.view.summary_status = 'STALE';
        await this.enqueue(tx, `finalize:${id}:${m.view.transcript_version}`, 'FINALIZE', id, {
          guild_id: guildId,
        });
        await this.saveView(tx, m);
        await this.event(tx, m, 'summary.updated', {
          status: 'STALE',
          summary_version: m.view.summary_version,
          transcript_version: m.view.transcript_version,
        });
        return false;
      }
      let inputHash = '';
      if (m.runtime.mode === 'real' || proof) {
        if (!proof) throw new DomainError('SUMMARY_VERIFICATION_REQUIRED');
        const outputHash = createHash('sha256').update(canonicalJson(result)).digest('hex');
        const run = await first(
          sql<{
            input_hash: string;
          }>`SELECT input_hash FROM summary_runs WHERE id=${proof.runId}::uuid AND meeting_id=${id}::uuid AND transcript_version=${version} AND prompt_hash=${promptHash} AND observed_model=${model} AND status='VERIFIED' AND output_hash=${outputHash}`,
          tx,
        );
        if (!run || proof.outputHash !== outputHash)
          throw new DomainError('SUMMARY_VERIFICATION_FAILED');
        inputHash = run.input_hash;
      }
      const publicResult = summaryOnly(result);
      const existing = await first(
        sql<{
          summary_version: number;
        }>`SELECT summary_version FROM summaries WHERE meeting_id=${id}::uuid AND transcript_version=${version} AND prompt_hash=${promptHash} AND model=${model} AND input_hash=${inputHash}`,
        tx,
      );
      const next =
        existing?.summary_version ??
        (await first(
          sql<{
            n: number;
          }>`SELECT coalesce(max(summary_version),0)+1 AS n FROM summaries WHERE meeting_id=${id}::uuid`,
          tx,
        ))!.n;
      if (!existing)
        await sql`INSERT INTO summaries(id,meeting_id,transcript_version,summary_version,prompt_hash,model,result,partial,input_hash,verification_run_id) VALUES(${randomUUID()},${id},${version},${next},${promptHash},${model},${json(publicResult)},${partial},${inputHash},${proof?.runId ?? null}::uuid)`.execute(
          tx,
        );
      m.view.summary_version = next;
      m.view.summary_status = 'READY';
      m.view.status = pending ? 'PARTIAL' : 'COMPLETED';
      m.view.title = publicResult.title || m.view.title;
      await this.saveView(tx, m);
      await this.event(tx, m, 'summary.updated', {
        status: 'READY',
        summary_version: next,
        transcript_version: version,
      });
      await this.event(tx, m, 'meeting.updated', { meeting: m.view });
      await this.post(tx, id, guildId, 'SUMMARY', next, m.record_channel_id, {
        meeting_id: id,
        summary_version: next,
      });
      if (!pending && process.env.AUDIO_RETENTION !== "forever")
        await sql`UPDATE audio_chunks SET expires_at=least(expires_at,now()+interval '24 hours') WHERE meeting_id=${id}::uuid`.execute(
          tx,
        );
      return true;
    });
  }
  async failSummaryJob(job: Job, code: string) {
    if (!job.meeting_id) return;
    await this.withMeeting(String(job.payload.guild_id), job.meeting_id, async (tx, m) => {
      await this.assertJob(tx, job);
      if (
        job.summary_input_version !== undefined &&
        m.view.transcript_version !== job.summary_input_version
      ) {
        await this.stale(tx, m);
        await this.saveView(tx, m);
        return;
      }
      m.view.summary_status = 'FAILED';
      if (m.status === 'FINALIZING')
        m.view.status = m.view.transcript_version > 0 ? 'PARTIAL' : 'FAILED';
      await this.saveView(tx, m);
      await this.event(tx, m, 'summary.updated', {
        status: 'FAILED',
        summary_version: m.view.summary_version,
        transcript_version: m.view.transcript_version,
      });
      await this.event(tx, m, 'meeting.updated', { meeting: m.view });
      await this.post(tx, m.id, m.guild_id, 'NOTICE', Date.now(), m.record_channel_id, {
        meeting_id: m.id,
        text: '전사는 보관되어 있습니다. 회의록 검증을 통과하지 못해 자동 게시를 보류했습니다. 전사를 확인·정정한 뒤 /회의 재요약으로 다시 처리할 수 있습니다.',
      });
      await this.audit(tx, m.guild_id, m.id, null, 'SUMMARY_HELD', { code });
    });
  }
  async claimJob(owner: string, guildId?: string) {
    return this.db
      .transaction()
      .execute(async (tx) =>
        first(
          sql<Job>`UPDATE jobs SET status='RUNNING',owner=${owner},lease_until=now()+interval '60 seconds',attempts=attempts+1,generation=generation+1 WHERE id=(SELECT id FROM jobs WHERE ((status='PENDING' AND due_at<=now()) OR (status='RUNNING' AND lease_until<now())) ${guildId ? sql`AND (meeting_id IS NULL OR EXISTS(SELECT 1 FROM meetings m WHERE m.id=jobs.meeting_id AND m.guild_id=${guildId}))` : sql``} ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          tx,
        ),
      );
  }
  async assertJob(db: Conn, job: Job) {
    if (
      !(await first(
        sql`SELECT id FROM jobs WHERE id=${job.id}::uuid AND generation=${job.generation} AND status='RUNNING' AND lease_until>now()`,
        db,
      ))
    )
      throw new DomainError('STALE_JOB', undefined, 409);
  }
  async renewJob(job: Job) {
    return !!(await first(
      sql`UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=${job.id}::uuid AND generation=${job.generation} AND status='RUNNING' RETURNING id`,
      this.db,
    ));
  }
  async finishJob(job: Job, error?: string, retryMs?: number) {
    await sql`UPDATE jobs SET status=${error ? (retryMs === undefined ? 'FAILED' : 'PENDING') : 'DONE'},error_code=${error ?? null},due_at=${new Date(Date.now() + (retryMs ?? 0))},lease_until=NULL,owner=NULL WHERE id=${job.id}::uuid AND generation=${job.generation} AND status='RUNNING'`.execute(
      this.db,
    );
  }
  async timer(
    db: Conn,
    entityId: string,
    guildId: string,
    kind: string,
    due: number,
    payload: unknown = {},
  ) {
    await sql`INSERT INTO durable_timers(id,entity_id,guild_id,kind,due_at,payload) VALUES(${randomUUID()},${entityId}::uuid,${guildId},${kind},${new Date(due)},${json(payload)}) ON CONFLICT(entity_id,kind) DO UPDATE SET due_at=EXCLUDED.due_at,payload=EXCLUDED.payload,status='PENDING',generation=durable_timers.generation+1,owner=NULL,lease_until=NULL`.execute(
      db,
    );
  }
  async cancelTimers(db: Conn, entityId: string, kinds: string[]) {
    await sql`UPDATE durable_timers SET status='CANCELLED',generation=generation+1 WHERE entity_id=${entityId}::uuid AND kind IN (${sql.join(kinds)}) AND status IN ('PENDING','RUNNING')`.execute(
      db,
    );
  }
  async deleteMeeting(guildId: string, id: string, actor: string) {
    await this.withMeeting(guildId, id, async (tx, m) => {
      await sql`INSERT INTO deletion_tombstones(meeting_id,guild_id) VALUES(${id},${guildId}) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`UPDATE meetings SET deleted_at=now(),fencing=fencing+1 WHERE id=${id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE jobs SET status='CANCELLED',generation=generation+1 WHERE meeting_id=${id}::uuid AND status IN ('PENDING','RUNNING')`.execute(
        tx,
      );
      await sql`UPDATE outbox SET status='CANCELLED',error_code=CASE WHEN status='RUNNING' AND attempts>0 AND message_id IS NULL THEN coalesce(error_code,'DELIVERY_UNCERTAIN') ELSE error_code END WHERE entity_id=${id}::uuid AND status IN ('PENDING','RUNNING')`.execute(
        tx,
      );
      await this.enqueue(tx, `delete:${id}`, 'DELETE', id, { guild_id: guildId });
      await this.audit(tx, guildId, id, actor, 'DELETE_REQUESTED', {});
      await sql`SELECT pg_notify('authz_invalidated',${guildId})`.execute(tx);
    });
  }
  async health(service: string, instance: string, metrics: unknown) {
    await sql`INSERT INTO health_records(service,instance_id,heartbeat_at,metrics) VALUES(${service},${instance},now(),${json(metrics)}) ON CONFLICT(service) DO UPDATE SET instance_id=EXCLUDED.instance_id,heartbeat_at=now(),metrics=EXCLUDED.metrics`.execute(
      this.db,
    );
  }
  async usage(
    guildId: string,
    meetingId: string,
    key: string,
    provider: string,
    cost: number,
    fields: {
      audio_ms?: number;
      input_tokens?: number;
      output_tokens?: number;
      is_mock?: boolean;
    } = {},
  ) {
    await sql`INSERT INTO usage_records(id,guild_id,meeting_id,request_key,provider,cost_krw,audio_ms,input_tokens,output_tokens,is_mock) VALUES(${randomUUID()},${guildId},${meetingId},${key},${provider},${cost},${fields.audio_ms ?? 0},${fields.input_tokens ?? 0},${fields.output_tokens ?? 0},${fields.is_mock ?? false}) ON CONFLICT(request_key) DO UPDATE SET cost_krw=greatest(usage_records.cost_krw,EXCLUDED.cost_krw),audio_ms=greatest(usage_records.audio_ms,EXCLUDED.audio_ms),input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens`.execute(
      this.db,
    );
  }
}
export function encodePage(s: SegmentDTO) {
  return Buffer.from(
    JSON.stringify({ start: s.start_ms, user: s.user_id, id: s.segment_id }),
  ).toString('base64url');
}
export function decodePage(value: string): { start: number; user: string; id: string } {
  try {
    if (value.length > 512) throw new Error();
    const v = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !Number.isSafeInteger(v.start) ||
      v.start < 0 ||
      !/^\d{1,20}$/.test(v.user) ||
      !/^[-\da-f]{36}$/i.test(v.id)
    )
      throw new Error();
    return v;
  } catch {
    throw new DomainError('INVALID_CURSOR');
  }
}
