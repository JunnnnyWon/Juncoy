import { beforeEach, afterEach, it, expect } from 'vitest';
import { sql, rows, first, createSummaryLedger } from '@meeting/db';
import { runFactLedger, FACTS_PROMPT_HASH, type StructuredEngine } from '@meeting/providers';
import { fixture, guild, user } from './helpers.ts';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.dispose();
});
async function prepared() {
  const m = await f.begin();
  await f.store.upsertTranscript({
    guildId: guild,
    meetingId: m.id,
    userId: user,
    displayName: '준',
    sourceKey: 'source',
    start: 0,
    end: 1000,
    text: '테스트 서버 이름을 Aurora로 결정합니다.',
    final: true,
  });
  await f.store.transition(guild, m.id, 'STOPPING');
  await f.store.transition(guild, m.id, 'FINALIZING');
  await sql`UPDATE jobs SET due_at=now()`.execute(f.store.db);
  const job = (await f.store.claimJob('test'))!;
  return { m, job };
}
function engine(counter: { calls: number }): StructuredEngine {
  return {
    model: 'mock-fact-engine',
    concurrency: 3,
    async request(schema, input: any) {
      counter.calls++;
      if (!input.units)
        return {
          result: schema.parse({
            kind: 'DECISION',
            assignment: 'UNSPECIFIED',
            deadline: 'NONE',
          }),
          model: 'mock-fact-engine',
        };
      const labels = Object.fromEntries(input.units.map((u: any) => [u.unit_key, 'DECISION']));
      const claims = Object.fromEntries(
        Object.keys(input.structured_values ?? {}).map((k) => [
          k,
          { kind_supported: true, owner_supported: false, due_supported: false },
        ]),
      );
      return {
        result: schema.parse({ labels, ...(input.structured_values ? { claims } : {}) }),
        model: 'mock-fact-engine',
      };
    },
  };
}
it('durable stages are reused and only the verified result can be published', async () => {
  const { m, job } = await prepared(),
    segments = await f.store.allSegments(guild, m.id),
    counter = { calls: 0 };
  const input = {
    meeting_id: m.id,
    started_at: m.view.started_at,
    segments,
    participants: (await f.store.snapshot(guild, m.id)).participants,
    metadata: { transcript_version: 1 },
    glossary: [],
    markers: [],
    gaps: [],
  };
  const run = await runFactLedger(input, engine(counter), async () => {}, {
    store: createSummaryLedger(f.store, job),
  });
  expect(counter.calls).toBe(3);
  const again = await runFactLedger(input, engine(counter), async () => {}, {
    store: createSummaryLedger(f.store, job),
  });
  expect(counter.calls).toBe(3);
  expect(again.proof).toEqual(run.proof);
  await sql`UPDATE meetings SET runtime=jsonb_set(runtime,'{mode}','"real"') WHERE id=${m.id}::uuid`.execute(
    f.store.db,
  );
  await expect(
    f.store.adoptSummary(guild, m.id, 1, run.result, run.model, FACTS_PROMPT_HASH, false, job),
  ).rejects.toThrow('SUMMARY_VERIFICATION_REQUIRED');
  const forged = structuredClone(run.result);
  forged.decisions[0]!.decision = '조작된 결정';
  await expect(
    f.store.adoptSummary(
      guild,
      m.id,
      1,
      forged,
      run.model,
      FACTS_PROMPT_HASH,
      false,
      job,
      run.proof,
    ),
  ).rejects.toThrow('SUMMARY_VERIFICATION_FAILED');
  expect(
    await f.store.adoptSummary(
      guild,
      m.id,
      1,
      run.result,
      run.model,
      FACTS_PROMPT_HASH,
      false,
      job,
      run.proof,
    ),
  ).toBe(true);
  expect((await rows(sql`SELECT * FROM summary_facts`, f.store.db)).length).toBeGreaterThan(0);
  job.summary_input_version = 1;
  await f.store.failSummaryJob(job, 'FACT_SEMANTIC_REJECTED');
  const held = await f.store.summary(guild, m.id);
  expect(held.summary_status).toBe('FAILED');
  expect(held.result).toBeNull();
  expect(await f.store.allSegments(guild, m.id)).toHaveLength(1);
});
it('deletion and job fencing reject late stage completion', async () => {
  const { m, job } = await prepared();
  const store = createSummaryLedger(f.store, job);
  const journal = await store.open({
    meeting_id: m.id,
    transcript_version: 1,
    input_hash: 'input',
    run_key: 'run',
    model: 'mock',
    prompt_hash: 'prompt',
  });
  await journal.begin('extract:0', 'hash');
  await f.store.deleteMeeting(guild, m.id, user);
  await expect(journal.success('extract:0', 'hash', {}, 'mock')).rejects.toThrow();
  expect((await first(sql<any>`SELECT status FROM summary_stages`, f.store.db)).status).toBe(
    'RUNNING',
  );
  await sql`DELETE FROM meetings WHERE id=${m.id}::uuid`.execute(f.store.db);
  expect((await rows(sql`SELECT * FROM summary_runs`, f.store.db)).length).toBe(0);
  expect((await rows(sql`SELECT * FROM summary_stages`, f.store.db)).length).toBe(0);
});
it('stage attempt limits survive a new journal instance', async () => {
  const { m, job } = await prepared();
  const desc = {
    meeting_id: m.id,
    transcript_version: 1,
    input_hash: 'input',
    run_key: 'retry-run',
    model: 'mock',
    prompt_hash: 'prompt',
  };
  for (let i = 1; i <= 3; i++) {
    const journal = await createSummaryLedger(f.store, job).open(desc);
    expect((await journal.begin('stage', 'same-input')).attempt).toBe(i);
    await journal.failure('stage', 'TRANSIENT', false);
  }
  const fourth = await createSummaryLedger(f.store, job).open(desc);
  await expect(fourth.begin('stage', 'same-input')).rejects.toThrow('STAGE_RETRIES_EXHAUSTED');
});
