import { z } from 'zod';
export * from './facts.ts';
export const Snowflake = z.string().regex(/^\d{1,20}$/);
export const Id = z.uuid();
export const Cursor = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
export const MeetingStatus = z.enum([
  'STARTING',
  'RECORDING',
  'PAUSED',
  'DEGRADED',
  'STOPPING',
  'FINALIZING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
]);
export const SummaryStatus = z.enum([
  'NOT_REQUESTED',
  'PENDING',
  'RUNNING',
  'READY',
  'STALE',
  'FAILED',
]);
export const activeStatuses = ['STARTING', 'RECORDING', 'PAUSED', 'DEGRADED', 'STOPPING'] as const;
export const Segment = z
  .object({
    segment_id: Id,
    user_id: Snowflake,
    display_name: z.string(),
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().nonnegative().nullable(),
    text: z.string(),
    is_final: z.boolean(),
    revision: z.number().int().positive(),
    corrected: z.boolean(),
    quality_flags: z.array(z.string()),
    overlap_group_id: Id.nullable(),
    updated_at: z.iso.datetime(),
  })
  .strict();
export const Participant = z
  .object({
    user_id: Snowflake,
    display_name: z.string(),
    present: z.boolean(),
    recording_eligible: z.boolean(),
  })
  .strict();
export const Gap = z
  .object({
    gap_id: Id,
    user_id: Snowflake.nullable(),
    start_ms: z.number().nonnegative(),
    end_ms: z.number().nonnegative().nullable(),
    reason: z.enum(['PAUSED', 'VOICE_LOST', 'STT_PENDING', 'STORAGE_ERROR']),
    recoverable: z.boolean(),
    resolved: z.boolean(),
    resolution: z.literal('NO_SPEECH_OR_NOISE').optional(),
  })
  .strict();
export const Marker = z
  .object({
    marker_id: Id,
    at_ms: z.number().nonnegative(),
    label: z.string().nullable(),
    created_by: Snowflake,
  })
  .strict();
export const MeetingView = z
  .object({
    meeting_id: Id,
    guild_id: Snowflake,
    title: z.string(),
    voice_channel_name: z.string(),
    status: MeetingStatus,
    started_at: z.iso.datetime().nullable(),
    ended_at: z.iso.datetime().nullable(),
    transcript_version: z.number().int().nonnegative(),
    summary_status: SummaryStatus,
    summary_version: z.number().int().nullable(),
    last_final_at: z.iso.datetime().nullable(),
  })
  .strict();
export const Snapshot = z
  .object({
    schema_version: z.literal(1),
    cursor: Cursor,
    server_time: z.iso.datetime(),
    meeting: MeetingView,
    participants: z.array(Participant),
    segments: z.array(Segment),
    gaps: z.array(Gap),
    markers: z.array(Marker),
    has_older: z.boolean(),
    older_cursor: z.string().nullable(),
  })
  .strict();
const evidence = { evidence_segment_ids: z.array(Id) };
export const MeetingSummary = z
  .object({
    title: z.string(),
    summary: z.array(z.string()),
    topics: z.array(
      z
        .object({
          category: z.enum(['기획', '프로그래밍', '아트', '사운드', 'QA', '운영', '기타']),
          title: z.string(),
          discussion: z.string(),
          ...evidence,
        })
        .strict(),
    ),
    decisions: z.array(
      z.object({ decision: z.string(), reason: z.string().nullable(), ...evidence }).strict(),
    ),
    action_items: z.array(
      z
        .object({
          task: z.string(),
          owner_user_id: Snowflake.nullable(),
          due_date: z.string().nullable(),
          due_date_text: z.string().nullable(),
          ...evidence,
        })
        .strict(),
    ),
    open_questions: z.array(z.object({ question: z.string(), ...evidence }).strict()),
    blockers: z.array(
      z
        .object({
          issue: z.string(),
          impact: z.string().nullable(),
          mentioned_solution: z.string().nullable(),
          ...evidence,
        })
        .strict(),
    ),
    next_agenda: z.array(
      z
        .object({ agenda: z.string(), origin: z.enum(['EXPLICIT', 'DERIVED']), ...evidence })
        .strict(),
    ),
    quality_notes: z.array(z.string()),
  })
  .strict();
const eventData = {
  'segment.upsert': z.object({ segment: Segment, transcript_version: z.number().int() }),
  'segment.replace': z.object({
    removals: z.array(z.object({ segment_id: Id, revision: z.number().int() })),
    replacements: z.array(Segment),
    transcript_version: z.number().int(),
  }),
  'draft.remove': z.object({
    segment_id: Id,
    revision: z.number().int(),
    reason: z.enum(['EMPTY', 'RECOVERY_PENDING', 'DISCARDED']),
  }),
  'meeting.updated': z.object({ meeting: MeetingView }),
  'participants.updated': z.object({ participants: z.array(Participant) }),
  'gap.upsert': z.object({ gap: Gap }),
  'marker.upsert': z.object({ marker: Marker }),
  'summary.updated': z.object({
    status: SummaryStatus,
    summary_version: z.number().int().nullable(),
    transcript_version: z.number().int(),
  }),
};
export type EventType = keyof typeof eventData;
export type EventPayloads = { [K in EventType]: z.infer<(typeof eventData)[K]> };
export type MeetingEvent = {
  [K in EventType]: {
    schema_version: 1;
    meeting_id: string;
    event_seq: string;
    type: K;
    emitted_at: string;
    data: EventPayloads[K];
  };
}[EventType];
export const Event = z.discriminatedUnion(
  'type',
  Object.entries(eventData).map(([type, data]) =>
    z
      .object({
        schema_version: z.literal(1),
        meeting_id: Id,
        event_seq: Cursor,
        type: z.literal(type),
        emitted_at: z.iso.datetime(),
        data,
      })
      .strict(),
  ) as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]],
);
export const eventTypes = Object.keys(eventData) as EventType[];
export type SegmentDTO = z.infer<typeof Segment>;
export type ParticipantDTO = z.infer<typeof Participant>;
export type MeetingViewDTO = z.infer<typeof MeetingView>;
export type SnapshotDTO = z.infer<typeof Snapshot>;
export type GapDTO = z.infer<typeof Gap>;
export type MarkerDTO = z.infer<typeof Marker>;
export type SummaryDTO = z.infer<typeof MeetingSummary>;
export type Status = z.infer<typeof MeetingStatus>;
export const GlossaryEntry = z
  .object({
    spoken: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[가-힣ㄱ-ㅎㅏ-ㅣ0-9 ]+$/u),
    written: z.string().min(1).max(100),
    weight: z.number().int().min(-5).max(5).default(2),
  })
  .strict();
export const GuildConfig = z
  .object({
    detect_all_voice_channels: z.boolean().default(false),
    voice_channel_ids: z.array(Snowflake).default([]),
    notification_channel_id: Snowflake.nullable().default(null),
    record_channel_id: Snowflake.nullable().default(null),
    team_role_ids: z.array(Snowflake).default([]),
    facilitator_role_ids: z.array(Snowflake).default([]),
    admin_user_ids: z.array(Snowflake).default([]),
    shared_microphone_user_ids: z.array(Snowflake).default([]),
    approved_shared_microphone_user_ids: z.array(Snowflake).default([]),
    require_consent: z.boolean().default(true),
    bot_channel_id: Snowflake.nullable().default(null),
    policy_version: z.string().default('2026-09-06'),
    stabilize_ms: z.number().int().positive().default(45000),
    remind_ms: z.number().int().positive().default(180000),
    snooze_ms: z.number().int().positive().default(600000),
    episode_close_ms: z.number().int().positive().default(300000),
    max_duration_ms: z.number().int().positive().default(14400000),
    monthly_api_budget_krw: z.number().positive().nullable().default(null),
    usd_krw: z.number().positive().default(1500),
    glossary: z.array(GlossaryEntry).max(100).default([]),
    glossary_version: z.number().int().positive().default(1),
    auto_start: z.literal(false).default(false),
  })
  .strict();
export type GuildSettings = z.infer<typeof GuildConfig>;
export const SummaryResult = z.object({
  summary_status: SummaryStatus,
  summary_version: z.number().int().nullable(),
  transcript_version: z.number().int(),
  result: MeetingSummary.nullable(),
  generated_at: z.iso.datetime().nullable(),
  model: z.string().nullable(),
  partial: z.boolean(),
  review_status: z.literal('UNREVIEWED'),
});
export type SummaryResultDTO = z.infer<typeof SummaryResult>;
