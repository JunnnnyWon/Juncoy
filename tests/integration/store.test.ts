import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, rows, first, json } from '@meeting/db';
import { applyEvent, initialView } from '@meeting/domain';
import { fixture, guild, user, voice, channel } from './helpers.ts';
import { Episodes } from '../../apps/bot/src/episodes.ts';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.dispose();
});
const utterance = (id: string, key: string, text = '확정된 발언', start = 100) => ({
  guildId: guild,
  meetingId: id,
  userId: user,
  displayName: '준',
  sourceKey: key,
  start,
  end: start + 1000,
  text,
  final: true,
});
it('AT-05/06 12 simultaneous starts acquire one voice slot and reuse interactions', async () => {
  const starts = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      f.store.begin({
        guildId: guild,
        channelId: voice,
        channelName: '개발',
        userId: user,
        interactionId: 'click-' + i,
        owner: 'test',
        participants: [
          { user_id: user, display_name: '준', present: true, recording_eligible: true },
        ],
        isMock: true,
      }),
    ),
  );
  expect(new Set(starts.map((m) => m.id)).size).toBe(1);
  expect((await rows(sql`SELECT id FROM meetings`, f.store.db)).length).toBe(1);
  expect((await rows(sql`SELECT id FROM outbox WHERE kind='RECORDING'`, f.store.db)).length).toBe(
    1,
  );
});
it('AT-11/12 duplicate finals collapse while repeated sentences at different times remain', async () => {
  const m = await f.begin();
  await Promise.all(
    Array.from({ length: 10 }, () => f.store.upsertTranscript(utterance(m.id, 'same'))),
  );
  await f.store.upsertTranscript({ ...utterance(m.id, 'same', '옛 partial'), final: false });
  await f.store.upsertTranscript(utterance(m.id, 'different', '확정된 발언', 5000));
  const s = await f.store.snapshot(guild, m.id);
  expect(s.segments.length).toBe(2);
  expect(s.meeting.transcript_version).toBe(2);
});
it('AT-19/20 snapshot to replay converges and sequence follows commit order', async () => {
  const m = await f.begin();
  const before = await f.store.snapshot(guild, m.id);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      f.store.upsertTranscript(utterance(m.id, 'u' + i, '내용 ' + i, i * 2000)),
    ),
  );
  const events = await f.store.events(m.id, before.cursor);
  let state = initialView(before);
  for (const e of events) state = applyEvent(state, e);
  const after = await f.store.snapshot(guild, m.id);
  expect(state.cursor).toBe(after.cursor);
  expect([...state.segments.values()].sort((a, b) => a.start_ms - b.start_ms)).toEqual(
    after.segments,
  );
});
it('AT-13 pause, withdrawal and fencing prevent further capture', async () => {
  const m = await f.begin();
  expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(true);
  await f.store.consent(guild, user, false);
  expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(false);
  await f.store.consent(guild, user, true);
  await f.store.transition(guild, m.id, 'PAUSED');
  expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(false);
  await expect(
    f.store.upsertTranscript({ ...utterance(m.id, 'bad'), fencing: '999' }),
  ).rejects.toThrow('STALE_LEASE');
});
it('ended meeting controls cannot extend deadlines or add markers', async () => {
  const m = await f.begin();
  await f.store.extendCaptureDeadline(guild, m.id, 'continue', m.fencing);
  await f.store.transition(guild, m.id, 'STOPPING');
  const stopped = await f.store.meeting(guild, m.id);
  await expect(
    f.store.extendCaptureDeadline(guild, m.id, 'continue', m.fencing),
  ).rejects.toMatchObject({ code: 'MEETING_NOT_RECORDING' });
  await expect(f.store.marker(guild, m.id, user, '늦은 클릭')).rejects.toMatchObject({
    code: 'MEETING_NOT_RECORDING',
  });
  expect((await f.store.meeting(guild, m.id)).runtime.one_deadline).toBe(
    stopped.runtime.one_deadline,
  );
  expect((await f.store.snapshot(guild, m.id)).markers).toEqual([]);
  await f.store.transition(guild, m.id, 'FINALIZING');
  await f.store.transition(guild, m.id, 'COMPLETED');
  await expect(
    f.store.extendCaptureDeadline(guild, m.id, 'extend', m.fencing),
  ).rejects.toMatchObject({ code: 'MEETING_NOT_RECORDING' });
});
it('timer expiry and extension serialize on the same meeting lock', async () => {
  const m = await f.begin();
  let release!: () => void, locked!: () => void;
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = f.store.withMeeting(guild, m.id, async (tx, current) => {
    locked();
    await hold;
    await f.store.transitionLocked(tx, current, 'STOPPING', m.fencing);
  });
  await acquired;
  const extension = expect(
    f.store.extendCaptureDeadline(guild, m.id, 'continue', m.fencing),
  ).rejects.toMatchObject({ code: 'MEETING_NOT_RECORDING' });
  release();
  await Promise.all([timer, extension]);
  expect((await f.store.meeting(guild, m.id)).status).toBe('STOPPING');
});
it('AT-23 correction keeps historical evidence and stale pages cannot roll back', async () => {
  const m = await f.begin();
  const s = await f.store.upsertTranscript(utterance(m.id, 'source', '원래 문장'));
  await f.store.correct(guild, m.id, s!.segment_id, '정정된 문장', user);
  expect((await f.store.allSegments(guild, m.id, 1))[0]!.text).toBe('원래 문장');
  expect((await f.store.allSegments(guild, m.id))[0]!.text).toBe('정정된 문장');
  expect((await f.store.segmentContext(guild, m.id, s!.segment_id, 1)).segment.text).toBe(
    '원래 문장',
  );
});
it('AT-27 server search includes unloaded history and treats wildcards as literals', async () => {
  const m = await f.begin();
  await f.store.upsertTranscript(utterance(m.id, 'old', '첫 안건 희귀단어 100%_완료', 0));
  for (let i = 1; i <= 205; i++)
    await f.store.upsertTranscript(utterance(m.id, 'a' + i, '발언 ' + i, i * 2000));
  expect((await f.store.snapshot(guild, m.id)).segments.length).toBe(200);
  expect((await f.store.transcript(guild, m.id, { q: '희귀단어' })).segments.length).toBe(1);
  expect((await f.store.transcript(guild, m.id, { q: '%_' })).segments.length).toBe(1);
  const page = await f.store.transcript(guild, m.id, { limit: 100 });
  const older = await f.store.transcript(guild, m.id, { before: page.older_cursor!, limit: 100 });
  expect(new Set([...page.segments, ...older.segments].map((s) => s.segment_id)).size).toBe(200);
});
it('AT-39 delete blocks API-visible reads and stale workers', async () => {
  const m = await f.begin();
  await f.store.deleteMeeting(guild, m.id, user);
  await expect(f.store.meeting(guild, m.id)).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
  await expect(f.store.upsertTranscript(utterance(m.id, 'late'))).rejects.toMatchObject({
    code: 'MEETING_NOT_FOUND',
  });
  expect((await rows(sql`SELECT * FROM deletion_tombstones`, f.store.db)).length).toBe(1);
});
it('AT-01/02/03 45 seconds and 100 repeated observations create one episode and card', async () => {
  const episodes = new Episodes(f.store),
    members = [
      { user_id: user, display_name: '준', joined_at: 0, facilitator: true, can_start: true },
      {
        user_id: '900000000000000011',
        display_name: '서연',
        joined_at: 0,
        facilitator: false,
        can_start: true,
      },
    ];
  await episodes.observe(guild, voice, members.slice(0, 1), 0);
  expect((await rows(sql`SELECT * FROM occupancy_episodes`, f.store.db)).length).toBe(0);
  for (let i = 0; i < 100; i++) await episodes.observe(guild, voice, members, 1000 + i);
  await episodes.tick(45999);
  expect((await rows(sql`SELECT * FROM outbox`, f.store.db)).length).toBe(0);
  await new Episodes(f.store).tick(46000);
  await episodes.tick(46001);
  expect((await rows(sql`SELECT * FROM occupancy_episodes`, f.store.db)).length).toBe(1);
  expect((await rows(sql`SELECT * FROM outbox`, f.store.db)).length).toBe(1);
});
it('AT-04 snooze cancels auto reminder; skip cancels all pending prompts', async () => {
  const ep = new Episodes(f.store),
    now = Date.now(),
    members = [user, '900000000000000011'].map((id) => ({
      user_id: id,
      display_name: '팀원',
      joined_at: now,
      facilitator: false,
      can_start: true,
    }));
  const id = await ep.observe(guild, voice, members, now);
  await ep.tick(now + 45000);
  await ep.choose(guild, id!, 'SNOOZE', user);
  await expect(ep.choose(guild, id!, 'SNOOZE', user)).rejects.toMatchObject({
    code: 'ALREADY_SNOOZED',
  });
  await ep.tick(now + 300000);
  expect((await rows(sql`SELECT * FROM outbox WHERE kind='REMIND'`, f.store.db)).length).toBe(0);
  await ep.choose(guild, id!, 'SKIP', user);
  await ep.tick(now + 1000000);
  expect((await rows(sql`SELECT * FROM outbox WHERE kind='REMIND'`, f.store.db)).length).toBe(0);
});
it('job lease recovery does not let the previous worker commit', async () => {
  const m = await f.begin();
  await f.store.enqueue(f.store.db, 'job', 'FINALIZE', m.id, { guild_id: guild });
  const job = await f.store.claimJob('one');
  await sql`UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=${job!.id}`.execute(
    f.store.db,
  );
  const next = await f.store.claimJob('two');
  expect(next!.generation).toBe(job!.generation + 1);
  await expect(f.store.assertJob(f.store.db, job!)).rejects.toMatchObject({ code: 'STALE_JOB' });
});
it('AT-36 summary results for an older transcript cannot replace current state', async () => {
  const m = await f.begin();
  const s = await f.store.upsertTranscript(utterance(m.id, 'one'));
  await f.store.transition(guild, m.id, 'STOPPING');
  await f.store.transition(guild, m.id, 'FINALIZING');
  await f.store.enqueue(f.store.db, 'summary-now', 'FINALIZE', m.id, { guild_id: guild });
  const job = await f.store.claimJob('worker');
  await f.store.correct(guild, m.id, s!.segment_id, '최신 정정', user);
  const summary = {
    title: '이전 요약',
    summary: [],
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    blockers: [],
    next_agenda: [],
    quality_notes: [],
  };
  expect(await f.store.adoptSummary(guild, m.id, 1, summary, 'mock', 'hash', false, job!)).toBe(
    false,
  );
  expect((await f.store.meeting(guild, m.id)).view.summary_status).toBe('STALE');
  expect((await rows(sql`SELECT * FROM summaries`, f.store.db)).length).toBe(0);
});
it('AT-15 retrying a committed replacement does not apply it twice', async () => {
  const m = await f.begin();
  const old = await f.store.upsertTranscript(utterance(m.id, 'old'));
  await f.store.enqueue(f.store.db, 'recovery', 'RETRANSCRIBE', m.id, { guild_id: guild });
  const job = await f.store.claimJob('worker');
  const replacement = {
    ...old!,
    segment_id: randomUUID(),
    revision: 1,
    text: '파일 재전사',
    start_ms: 100,
    end_ms: 1100,
  };
  const v = await f.store.replaceRange(guild, m.id, user, 100, 1100, [replacement], job!);
  expect(
    await f.store.replaceRange(
      guild,
      m.id,
      user,
      100,
      1100,
      [{ ...replacement, segment_id: randomUUID() }],
      job!,
    ),
  ).toBe(v);
  expect((await f.store.allSegments(guild, m.id)).length).toBe(1);
  expect((await f.store.segmentContext(guild, m.id, old!.segment_id)).replacement_ids).toEqual([
    replacement.segment_id,
  ]);
});
it('budget threshold stops new meetings while existing capture can continue', async () => {
  const c = await f.store.getConfig(guild);
  await f.store.setConfig(guild, { ...c, monthly_api_budget_krw: 100 }, user);
  const m = await f.begin();
  await f.store.usage(guild, m.id, 'charge', 'returnzero', 101, { is_mock: true });
  expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(true);
  await f.store.transition(guild, m.id, 'STOPPING');
  await f.store.transition(guild, m.id, 'FINALIZING');
  await expect(f.begin()).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
});
it('AT-13 a stale consent snapshot cannot start collecting after withdrawal', async () => {
  const participants = [
    { user_id: user, display_name: '준', present: true, recording_eligible: true },
  ];
  await f.store.consent(guild, user, false);
  await expect(
    f.store.begin({
      guildId: guild,
      channelId: voice,
      channelName: '테스트',
      userId: user,
      interactionId: 'withdraw-race',
      owner: 'test',
      participants,
      isMock: true,
    }),
  ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
});
