import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  applyEvent,
  initialView,
  mergePage,
  safeReturnTo,
  channelPermissions,
  permissions,
  chunkSegments,
  mapSourceTime,
  validateSummary,
  displayText,
  parseCursor,
} from '@meeting/domain';
import { emptySummary, encrypt, decrypt } from '@meeting/providers';
import { type SegmentDTO, type SnapshotDTO, type MeetingEvent, Event } from '@meeting/contracts';
const segment = (patch: Partial<SegmentDTO> = {}): SegmentDTO => ({
  segment_id: randomUUID(),
  user_id: '10',
  display_name: '준',
  start_ms: 100,
  end_ms: null,
  text: '인식 중',
  is_final: false,
  revision: 1,
  corrected: false,
  quality_flags: [],
  overlap_group_id: null,
  updated_at: new Date().toISOString(),
  ...patch,
});
function snapshot(segments: SegmentDTO[] = []): SnapshotDTO {
  const id = randomUUID();
  return {
    schema_version: 1,
    cursor: '9007199254740993',
    server_time: new Date().toISOString(),
    meeting: {
      meeting_id: id,
      guild_id: '1',
      title: '회의',
      voice_channel_name: '개발',
      status: 'RECORDING',
      started_at: null,
      ended_at: null,
      transcript_version: 0,
      summary_status: 'NOT_REQUESTED',
      summary_version: null,
      last_final_at: null,
    },
    participants: [],
    segments,
    gaps: [],
    markers: [],
    has_older: false,
    older_cursor: null,
  };
}
function event(s: SnapshotDTO, n: number, type: string, data: any) {
  return {
    schema_version: 1,
    meeting_id: s.meeting.meeting_id,
    event_seq: (BigInt(s.cursor) + BigInt(n)).toString(),
    emitted_at: new Date().toISOString(),
    type,
    data,
  };
}
describe('web reducer AT-17~24', () => {
  it('updates one partial row to final, ignores duplicate sequence and old revision', () => {
    const s = snapshot(),
      d = segment();
    let state = initialView(s);
    state = applyEvent(state, event(s, 1, 'segment.upsert', { segment: d, transcript_version: 0 }));
    for (let n = 2; n <= 5; n++)
      state = applyEvent(
        state,
        event(s, n, 'segment.upsert', {
          segment: { ...d, text: '수정 ' + n, revision: n },
          transcript_version: 0,
        }),
      );
    state = applyEvent(
      state,
      event(s, 6, 'segment.upsert', {
        segment: { ...d, text: '확정', revision: 6, is_final: true, end_ms: 1000 },
        transcript_version: 1,
      }),
    );
    const duplicate = applyEvent(
      state,
      event(s, 6, 'segment.upsert', { segment: d, transcript_version: 0 }),
    );
    expect(duplicate).toBe(state);
    expect(state.segments.size).toBe(1);
    state = applyEvent(
      state,
      event(s, 7, 'segment.upsert', { segment: { ...d, revision: 7 }, transcript_version: 0 }),
    );
    expect(state.segments.get(d.segment_id)?.text).toBe('확정');
  });
  it('rejects gaps, cross-meeting events and unsupported schema versions', () => {
    const s = snapshot(),
      d = segment(),
      state = initialView(s);
    expect(() =>
      applyEvent(state, event(s, 2, 'segment.upsert', { segment: d, transcript_version: 0 })),
    ).toThrow('MISSING_EVENT');
    expect(() =>
      applyEvent(state, {
        ...event(s, 1, 'segment.upsert', { segment: d, transcript_version: 0 }),
        meeting_id: randomUUID(),
      }),
    ).toThrow('WRONG_MEETING');
    expect(() =>
      applyEvent(state, {
        ...event(s, 1, 'segment.upsert', { segment: d, transcript_version: 0 }),
        schema_version: 2,
      }),
    ).toThrow('INCOMPATIBLE_EVENT');
  });
  it('tombstones replacement IDs against late history and invalidates old generations', () => {
    const d = segment({ is_final: true, end_ms: 300, revision: 2 }),
      s = snapshot([d]),
      replacement = segment({ is_final: true, end_ms: 400 });
    const state = applyEvent(
      initialView(s, 2),
      event(s, 1, 'segment.replace', {
        removals: [{ segment_id: d.segment_id, revision: 3 }],
        replacements: [replacement],
        transcript_version: 2,
      }),
    );
    expect(mergePage(state, [d], 2).segments.has(d.segment_id)).toBe(false);
    expect(mergePage(state, [segment()], 1)).toBe(state);
  });
  it('removes drafts without resurrecting them', () => {
    const d = segment(),
      s = snapshot([d]);
    const state = applyEvent(
      initialView(s),
      event(s, 1, 'draft.remove', {
        segment_id: d.segment_id,
        revision: 2,
        reason: 'RECOVERY_PENDING',
      }),
    );
    expect(mergePage(state, [d], 0).segments.size).toBe(0);
  });
  it('keeps exact decimal bigint values', () => {
    expect(parseCursor('9007199254740993')).toBe('9007199254740993');
    for (const s of ['-1', '01', '1e9', '9223372036854775808'])
      expect(() => parseCursor(s)).toThrow();
  });
});
describe('security AT-28~31', () => {
  it.each([
    'https://evil.test',
    '//evil.test',
    '/meetings/\\evil',
    '/meetings/%250a',
    '/meetings/%255c%255cevil',
    '/auth/logout',
  ])('blocks unsafe return path %s', (value) => expect(safeReturnTo(value)).toBe('/meetings'));
  it('preserves safe evidence links', () =>
    expect(safeReturnTo('/meetings/abc?tab=transcript&segment=xyz')).toBe(
      '/meetings/abc?tab=transcript&segment=xyz',
    ));
  it('applies everyone, aggregate roles, then member overwrites', () => {
    const view = permissions.ViewChannel,
      history = permissions.ReadMessageHistory;
    const roles = [
      { id: '1', permissions: (view | history).toString() },
      { id: '2', permissions: '0' },
      { id: '3', permissions: '0' },
    ];
    const overwrites = [
      { id: '1', type: 0 as const, allow: '0', deny: view.toString() },
      { id: '2', type: 0 as const, allow: view.toString(), deny: '0' },
      { id: '3', type: 0 as const, allow: '0', deny: view.toString() },
    ];
    expect(channelPermissions('1', '10', ['2', '3'], roles, overwrites, '99') & view).toBe(view);
    expect(
      channelPermissions(
        '1',
        '10',
        ['2'],
        roles,
        [...overwrites, { id: '10', type: 1, allow: '0', deny: view.toString() }],
        '99',
      ) & view,
    ).toBe(0n);
  });
  it('authenticates encrypted files and binds metadata', () => {
    const key = 'a'.repeat(64),
      sealed = encrypt(Buffer.from('개인 회의'), key, 'audio-1');
    expect(decrypt(sealed, key, 'audio-1').toString()).toBe('개인 회의');
    expect(() => decrypt(sealed, key, 'audio-2')).toThrow();
    const bad = Buffer.from(sealed);
    bad[bad.length - 1]! ^= 1;
    expect(() => decrypt(bad, key, 'audio-1')).toThrow();
  });
});
describe('transcript and summary AT-12,15,33~37', () => {
  it('maps disjoint audio ranges to original meeting time', () => {
    const map = [
      { file_start_ms: 0, file_end_ms: 1000, source_start_ms: 5000 },
      { file_start_ms: 1000, file_end_ms: 2000, source_start_ms: 60000 },
    ];
    expect(mapSourceTime(1500, map)).toBe(60500);
    expect(() => mapSourceTime(3000, map)).toThrow();
  });
  it('covers every utterance exactly once without splitting utterances', () => {
    const ss = Array.from({ length: 70 }, () => segment({ text: '가'.repeat(500) }));
    const chunks = chunkSegments(ss, 3000);
    expect(chunks.flatMap((c) => c.primary).map((s) => s.segment_id)).toEqual(
      ss.map((s) => s.segment_id),
    );
    expect(chunks[1]!.context.length).toBe(2);
  });
  it('rejects made-up evidence, users and impossible dates', () => {
    const s = segment({ is_final: true, end_ms: 1000 });
    const summary = emptySummary('회의');
    summary.action_items = [
      {
        task: '작업',
        owner_user_id: null,
        due_date: null,
        due_date_text: null,
        evidence_segment_ids: [s.segment_id],
      },
    ];
    expect(validateSummary(summary, [s], []).action_items[0]!.owner_user_id).toBeNull();
    summary.action_items[0]!.owner_user_id = '99';
    expect(() => validateSummary(summary, [s], [])).toThrow('INVALID_OWNER');
    summary.action_items[0]!.owner_user_id = null;
    summary.action_items[0]!.due_date = '2026-02-30';
    summary.action_items[0]!.due_date_text = '2월 30일';
    expect(() => validateSummary(summary, [s], [])).toThrow('INVALID_DUE_DATE');
    summary.action_items[0]!.due_date = null;
    summary.action_items[0]!.evidence_segment_ids = [randomUUID()];
    expect(() => validateSummary(summary, [s], [])).toThrow('INVALID_EVIDENCE');
  });
  it('only replaces registered standalone glossary aliases', () => {
    expect(
      displayText('드로우 콜과 에프피에스', [
        { spoken: '드로우 콜', written: 'Draw Call' },
        { spoken: '에프피에스', written: 'FPS' },
      ]),
    ).toBe('Draw Call과 FPS');
  });
});
it('AT-35 relative deadlines are based on the utterance date after midnight', () => {
  const s = segment({
    is_final: true,
    end_ms: 125000,
    start_ms: 120000,
    text: '내일까지 확인하겠습니다.',
  });
  const value = emptySummary('자정을 넘긴 회의');
  value.action_items = [
    {
      task: '확인',
      owner_user_id: null,
      due_date: '2026-09-08',
      due_date_text: '내일',
      evidence_segment_ids: [s.segment_id],
    },
  ];
  expect(
    validateSummary(value, [s], [], '2026-09-06T14:59:00.000Z').action_items[0]!.due_date,
  ).toBe('2026-09-08');
  value.action_items[0]!.due_date = '2026-09-07';
  expect(() => validateSummary(value, [s], [], '2026-09-06T14:59:00.000Z')).toThrow(
    'INVALID_DUE_DATE_CONTEXT',
  );
});
import { captureFrameStart } from '@meeting/domain';
it('received packet bursts preserve every sequential audio frame rather than overwriting one time slot', () => {
  let end: number | null = null;
  const starts = [];
  for (let i = 0; i < 10; i++) {
    const start = captureFrameStart(1000, end);
    starts.push(start);
    end = start + 20;
  }
  expect(starts).toEqual([1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140, 1160, 1180]);
  expect(captureFrameStart(5000, end)).toBe(5000);
});
it('a source-map boundary belongs to the next piece for starts and the previous piece for ends', () => {
  const pieces = [
    { file_start_ms: 0, file_end_ms: 1000, source_start_ms: 5000 },
    { file_start_ms: 1000, file_end_ms: 2000, source_start_ms: 60000 },
  ];
  expect(mapSourceTime(1000, pieces)).toBe(60000);
  expect(mapSourceTime(1000, pieces, 'end')).toBe(6000);
});
