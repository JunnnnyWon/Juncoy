import {
  Cursor,
  Event,
  MeetingSummary,
  type MeetingEvent,
  type SnapshotDTO,
  type SegmentDTO,
  type Status,
  type SummaryDTO,
  type ParticipantDTO,
} from '@meeting/contracts';
export * from './facts.ts';
export class DomainError extends Error {
  constructor(
    public code: string,
    message = code,
    public status = 400,
    public retryable = false,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
const transitions: Record<Status, Status[]> = {
  STARTING: ['RECORDING', 'FAILED', 'STOPPING'],
  RECORDING: ['PAUSED', 'DEGRADED', 'STOPPING'],
  PAUSED: ['RECORDING', 'STOPPING'],
  DEGRADED: ['RECORDING', 'PAUSED', 'STOPPING'],
  STOPPING: ['FINALIZING', 'FAILED'],
  FINALIZING: ['COMPLETED', 'PARTIAL', 'FAILED'],
  COMPLETED: [],
  PARTIAL: ['COMPLETED'],
  FAILED: [],
};
export function canTransition(from: Status, to: Status) {
  return transitions[from].includes(to);
}
export const permissions = {
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  ReadMessageHistory: 1n << 16n,
};
export interface Role {
  id: string;
  permissions: string;
}
export interface Overwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}
export function channelPermissions(
  guildId: string,
  userId: string,
  roleIds: string[],
  roles: Role[],
  overwrites: Overwrite[],
  ownerId: string,
): bigint {
  if (userId === ownerId) return (1n << 53n) - 1n;
  let bits = roles
    .filter((r) => r.id === guildId || roleIds.includes(r.id))
    .reduce((a, r) => a | BigInt(r.permissions), 0n);
  if (bits & permissions.Administrator) return (1n << 53n) - 1n;
  const everyone = overwrites.find((o) => o.id === guildId && o.type === 0);
  if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const rs = overwrites.filter((o) => o.type === 0 && roleIds.includes(o.id));
  bits =
    (bits & ~rs.reduce((a, r) => a | BigInt(r.deny), 0n)) |
    rs.reduce((a, r) => a | BigInt(r.allow), 0n);
  const member = overwrites.find((o) => o.type === 1 && o.id === userId);
  return member ? (bits & ~BigInt(member.deny)) | BigInt(member.allow) : bits;
}
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) return '/meetings';
  let decoded = value;
  try {
    for (let i = 0; i < 4; i++) decoded = decodeURIComponent(decoded);
  } catch {
    return '/meetings';
  }
  if (
    /[\\\r\n\u0000]/.test(decoded) ||
    !/^\/meetings(?:\/|\?|$)/.test(decoded) ||
    decoded.startsWith('//')
  )
    return '/meetings';
  const u = new URL(value, 'https://meeting.invalid');
  return u.origin === 'https://meeting.invalid' ? u.pathname + u.search : '/meetings';
}
export function compareSegments(a: SegmentDTO, b: SegmentDTO) {
  return (
    a.start_ms - b.start_ms ||
    a.user_id.localeCompare(b.user_id) ||
    a.segment_id.localeCompare(b.segment_id)
  );
}
export interface ViewState {
  snapshot: SnapshotDTO;
  segments: Map<string, SegmentDTO>;
  tombstones: Map<string, number>;
  cursor: string;
  generation: number;
}
export function initialView(snapshot: SnapshotDTO, generation = 0): ViewState {
  return {
    snapshot,
    segments: new Map(snapshot.segments.map((s) => [s.segment_id, s])),
    tombstones: new Map(),
    cursor: snapshot.cursor,
    generation,
  };
}
function upsert(state: ViewState, s: SegmentDTO) {
  const old = state.segments.get(s.segment_id);
  if (
    (state.tombstones.get(s.segment_id) ?? 0) >= s.revision ||
    (old && (old.revision >= s.revision || (old.is_final && !s.is_final)))
  )
    return;
  state.segments.set(s.segment_id, s);
}
export function mergePage(state: ViewState, segments: SegmentDTO[], generation: number) {
  if (generation !== state.generation) return state;
  const next = { ...state, segments: new Map(state.segments) };
  segments.forEach((s) => upsert(next, s));
  return next;
}
export function applyEvent(state: ViewState, raw: unknown): ViewState {
  const parsed = Event.safeParse(raw);
  if (!parsed.success) throw new DomainError('INCOMPATIBLE_EVENT');
  const event = parsed.data as MeetingEvent;
  if (event.meeting_id !== state.snapshot.meeting.meeting_id)
    throw new DomainError('WRONG_MEETING');
  if (BigInt(event.event_seq) <= BigInt(state.cursor)) return state;
  if (BigInt(event.event_seq) !== BigInt(state.cursor) + 1n) throw new DomainError('MISSING_EVENT');
  const next: ViewState = {
    ...state,
    segments: new Map(state.segments),
    tombstones: new Map(state.tombstones),
    snapshot: { ...state.snapshot, meeting: { ...state.snapshot.meeting } },
  };
  const remove = (id: string, revision: number) => {
    if ((next.segments.get(id)?.revision ?? 0) <= revision) next.segments.delete(id);
    next.tombstones.set(id, Math.max(next.tombstones.get(id) ?? 0, revision));
  };
  switch (event.type) {
    case 'segment.upsert':
      upsert(next, event.data.segment);
      next.snapshot.meeting.transcript_version = Math.max(
        next.snapshot.meeting.transcript_version,
        event.data.transcript_version,
      );
      break;
    case 'segment.replace':
      event.data.removals.forEach((r) => remove(r.segment_id, r.revision));
      event.data.replacements.forEach((s) => upsert(next, s));
      next.snapshot.meeting.transcript_version = Math.max(
        next.snapshot.meeting.transcript_version,
        event.data.transcript_version,
      );
      break;
    case 'draft.remove':
      remove(event.data.segment_id, event.data.revision);
      break;
    case 'meeting.updated':
      next.snapshot.meeting = {
        ...event.data.meeting,
        transcript_version: Math.max(
          event.data.meeting.transcript_version,
          next.snapshot.meeting.transcript_version,
        ),
      };
      break;
    case 'participants.updated':
      next.snapshot.participants = event.data.participants;
      break;
    case 'gap.upsert':
      next.snapshot.gaps = [
        ...next.snapshot.gaps.filter((g) => g.gap_id !== event.data.gap.gap_id),
        event.data.gap,
      ];
      break;
    case 'marker.upsert':
      next.snapshot.markers = [
        ...next.snapshot.markers.filter((m) => m.marker_id !== event.data.marker.marker_id),
        event.data.marker,
      ];
      break;
    case 'summary.updated':
      if ((event.data.summary_version ?? 0) >= (next.snapshot.meeting.summary_version ?? 0))
        Object.assign(next.snapshot.meeting, {
          summary_status: event.data.status,
          summary_version: event.data.summary_version,
        });
      next.snapshot.meeting.transcript_version = Math.max(
        next.snapshot.meeting.transcript_version,
        event.data.transcript_version,
      );
      break;
  }
  next.cursor = event.event_seq;
  return next;
}
export function parseCursor(value: unknown) {
  const p = Cursor.safeParse(value);
  if (!p.success) throw new DomainError('INVALID_CURSOR');
  return p.data;
}
export function displayText(raw: string, glossary: { spoken: string; written: string }[]) {
  const suffix =
    '(?=$|[^\\p{L}\\p{N}]|(?:으로|에서|에게|한테|은|는|이|가|을|를|의|와|과|로|도|만)(?=$|[^\\p{L}\\p{N}]))';
  return glossary
    .slice()
    .sort((a, b) => b.spoken.length - a.spoken.length)
    .reduce((text, entry) => {
      const escaped = entry.spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.replace(
        new RegExp('(?<![\\p{L}\\p{N}])' + escaped + suffix, 'gu'),
        () => entry.written,
      );
    }, raw);
}
export function mapSourceTime(
  at: number,
  pieces: { file_start_ms: number; file_end_ms: number; source_start_ms: number }[],
  boundary: 'start' | 'end' = 'start',
) {
  const p =
    pieces.find((p) =>
      boundary === 'start'
        ? at >= p.file_start_ms && at < p.file_end_ms
        : at > p.file_start_ms && at <= p.file_end_ms,
    ) ?? (at === 0 ? pieces[0] : at === pieces.at(-1)?.file_end_ms ? pieces.at(-1) : undefined);
  if (!p) throw new DomainError('UNMAPPED_AUDIO_TIME');
  return p.source_start_ms + at - p.file_start_ms;
}
/** A short receive jitter/burst must not make consecutive PCM frames overlap. */
export function captureFrameStart(proposed: number, previousEnd: number | null) {
  return previousEnd !== null && proposed - previousEnd <= 250 ? previousEnd : proposed;
}
export function chunkSegments(
  segments: SegmentDTO[],
  maxChars = 24000,
): { primary: SegmentDTO[]; context: SegmentDTO[] }[] {
  const chunks: { primary: SegmentDTO[]; context: SegmentDTO[] }[] = [];
  let current: SegmentDTO[] = [];
  let size = 0;
  for (const s of segments) {
    const n = JSON.stringify(s).length;
    if (current.length && size + n > maxChars) {
      chunks.push({ primary: current, context: [] });
      current = [];
      size = 0;
    }
    current.push(s);
    size += n;
  }
  if (current.length) chunks.push({ primary: current, context: [] });
  chunks.forEach((c, i) => (c.context = i ? chunks[i - 1]!.primary.slice(-2) : []));
  return chunks;
}
export function validateSummary(
  raw: unknown,
  segments: SegmentDTO[],
  participants: ParticipantDTO[],
  startedAt?: string,
): SummaryDTO {
  const value = MeetingSummary.parse(raw);
  const ids = new Set(segments.map((s) => s.segment_id)),
    users = new Set(participants.map((p) => p.user_id));
  for (const item of [
    ...value.topics,
    ...value.decisions,
    ...value.action_items,
    ...value.open_questions,
    ...value.blockers,
    ...value.next_agenda,
  ]) {
    if (!item.evidence_segment_ids.length || item.evidence_segment_ids.some((id) => !ids.has(id)))
      throw new DomainError('INVALID_EVIDENCE');
  }
  for (const item of value.action_items) {
    if (item.owner_user_id !== null && !users.has(item.owner_user_id))
      throw new DomainError('INVALID_OWNER');
    const evidence = segments.filter((s) => item.evidence_segment_ids.includes(s.segment_id));
    if (item.owner_user_id !== null) {
      const owner = participants.find((p) => p.user_id === item.owner_user_id)!;
      const selfAssigned = evidence.some(
        (s) => s.user_id === item.owner_user_id && /(제가|저는|내가|나는)/.test(s.text),
      );
      const explicitlyNamed =
        participants.filter((p) => p.display_name === owner.display_name).length === 1 &&
        evidence.some((s) => s.text.includes(owner.display_name));
      if (!selfAssigned && !explicitlyNamed) throw new DomainError('UNSUPPORTED_OWNER');
    }

    if (item.due_date !== null) {
      const date = new Date(item.due_date + 'T00:00:00Z');
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(item.due_date) ||
        Number.isNaN(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== item.due_date ||
        !item.due_date_text
      )
        throw new DomainError('INVALID_DUE_DATE');
    }
    if (item.due_date !== null && startedAt) {
      const text = item.due_date_text!;
      if (
        !evidence.some((s) => s.text.includes(text)) ||
        /(쯤|스프린트|언젠가|가능하면)/.test(text)
      )
        throw new DomainError('UNSUPPORTED_DUE_DATE');
      const relative = /(오늘|내일|모레)/.exec(text);
      if (relative) {
        const offset = { 오늘: 0, 내일: 1, 모레: 2 }[relative[1] as '오늘' | '내일' | '모레'];
        const valid = evidence
          .filter((s) => s.text.includes(text))
          .map((s) => {
            const day = new Date(localDate(startedAt, s.start_ms) + 'T00:00:00Z');
            day.setUTCDate(day.getUTCDate() + offset);
            return day.toISOString().slice(0, 10);
          });
        if (!valid.includes(item.due_date)) throw new DomainError('INVALID_DUE_DATE_CONTEXT');
      }
    }
  }
  return value;
}
export function localDate(startedAt: string, offset: number) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.parse(startedAt) + offset));
}
export function backoff(attempt: number, random = Math.random) {
  return Math.min(30000, 1000 * 2 ** attempt) * (0.75 + random() * 0.5);
}
export function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, '\\$&');
}
export function boundedText(s: string, max: number) {
  return [...s].slice(0, max).join('');
}
