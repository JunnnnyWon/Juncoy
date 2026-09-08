import { postgresEvaluation } from './lib/qa-postgres-ledger.ts';
import { markQaRun, completeQaAudio } from './lib/qa-retention.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '@meeting/db';
import {
  Solar,
  ProviderError,
  loadConfig,
  type SummaryInput,
  type SummaryPolicy,
  type SummaryUsage,
} from '@meeting/providers';
import { canonicalJson } from '@meeting/domain';
import {
  summaryCases,
  caseSegments,
  qaPeople,
  fixtureId,
  type SummaryCase,
} from '../tests/fixtures/summary-cases.ts';
import { QaBudget } from './lib/qa-budget.ts';
import { fileLedger } from './lib/file-ledger.ts';
const option = (key: string, fallback: string) => {
  const i = process.argv.indexOf('--' + key);
  return i < 0 ? fallback : process.argv[i + 1]!;
};
const config = { ...loadConfig(), UPSTAGE_MODEL: 'solar-pro3-260323' },
  account = new Store(config.DATABASE_URL);
const campaign = option('campaign', 'summary-' + randomUUID()),
  output = resolve(option('output', '.data/qa/facts-v1/' + campaign));
const budget = new QaBudget(
  account,
  config.DISCORD_GUILD_ID,
  campaign,
  Number(option('budget-krw', '10000')),
);
const repeat = Number(option('repeat', '1')),
  recording = option('recording', '');
const selected = summaryCases.filter(
  (c) =>
    (option('split', 'development') === 'all' || c.split === option('split', 'development')) &&
    (!option('case', '') || c.id === option('case', '')),
);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 30) throw new Error('Invalid repeat count');
const evalLock = await account.pool.connect();
let evalLockLost = false;
evalLock.on('error', () => {
  evalLockLost = true;
});
const lockKey = config.DISCORD_GUILD_ID + ':summary-qa';
const lock = await evalLock.query(
  'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
  [lockKey],
);
if (!lock.rows[0]?.acquired) {
  evalLock.release();
  await account.close();
  throw new ProviderError('QA_SUMMARY_EVAL_BUSY', false);
}
await mkdir(output, { recursive: true, mode: 0o700 });
await markQaRun(output);
await writeFile(
  resolve(output, 'dataset-manifest.json'),
  JSON.stringify(
    {
      sha256: createHash('sha256').update(canonicalJson(summaryCases)).digest('hex'),
      development: 10,
      validation: 5,
      campaign,
      model: config.UPSTAGE_MODEL,
      recording: recording ? true : false,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const results: any[] = [];
const normalize = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, '');
function score(test: SummaryCase, run: Awaited<ReturnType<Solar['summarize']>>) {
  const active = run.facts.filter((f) =>
    run.report.dispositions.some((d) => d.fact_id === f.fact_id && d.status === 'RENDERED'),
  );
  const missing = test.gold.filter(
    (g) =>
      !active.some(
        (f) =>
          (g.kind === 'TOPIC' || f.kind === g.kind) &&
          g.terms.every((t) => normalize(f.statement).includes(normalize(t))) &&
          f.evidence.some((e) => e.segment_id === fixtureId(test.id + ':' + g.source)) &&
          (g.owner === undefined || f.owner_user_id === g.owner) &&
          (g.due === undefined || f.due_date === g.due),
      ),
  );
  const confirmed = active.filter((f) => ['DECISION', 'ACTION'].includes(f.kind));
  const unexpected = confirmed.filter(
    (f) =>
      !test.gold.some(
        (g) =>
          g.kind === f.kind &&
          g.terms.every((t) => normalize(f.statement).includes(normalize(t))) &&
          (g.owner === undefined || f.owner_user_id === g.owner) &&
          (g.due === undefined || f.due_date === g.due),
      ),
  );
  const forbidden = confirmed.filter((f) =>
    test.forbidden_confirmed.some((t) => normalize(f.statement).includes(normalize(t))),
  );
  return {
    pass:
      missing.length === 0 &&
      unexpected.length === 0 &&
      forbidden.length === 0 &&
      run.result.decisions.length <= test.max_decisions &&
      run.result.action_items.length <= test.max_actions,
    missing,
    unexpected: unexpected.map((f) => ({
      kind: f.kind,
      text: f.statement,
      owner: f.owner_user_id,
      due: f.due_date,
    })),
    forbidden: forbidden.map((f) => f.statement),
  };
}
try {
  const tests = recording ? [null] : selected;
  for (const test of tests)
    for (let iteration = 0; iteration < repeat; iteration++) {
      const id = test?.id ?? 'offline-64m',
        runDir = resolve(output, id + '-' + iteration);
      let input: SummaryInput, policy: SummaryPolicy;
      if (test) {
        input = {
          meeting_id: fixtureId(campaign + ':' + output + ':' + id + ':' + iteration),
          started_at: test.started_at,
          segments: caseSegments(test),
          participants: qaPeople,
          metadata: { transcript_version: 1, source_kind: 'AUTHORED_SCRIPT' },
          glossary: [],
          markers: [],
          gaps: [],
        };
        policy = { verifiedOwners: test.verified_owners, knownDate: Boolean(test.started_at) };
      } else {
        const segments = JSON.parse(await readFile(resolve(recording, 'segments.json'), 'utf8'));
        input = {
          meeting_id: fixtureId(campaign + ':' + output + ':' + id + ':' + iteration),
          started_at: null,
          segments,
          participants: [
            ...new Map(
              segments.map((s: any) => [
                s.user_id,
                {
                  user_id: s.user_id,
                  display_name: s.display_name,
                  present: true,
                  recording_eligible: true,
                },
              ]),
            ).values(),
          ] as any,
          metadata: { transcript_version: 1, source_kind: 'OFFLINE_MIXED_AUDIO' },
          glossary: [],
          markers: [],
          gaps: [],
        };
        policy = { verifiedOwners: false, knownDate: false };
      }
      const usage: SummaryUsage[] = [];
      const cache = { cache_hits: 0, stage_requests: 0 };
      const pg =
        option('journal', 'file') === 'postgres'
          ? await postgresEvaluation(input, runDir, cache)
          : null;
      const started = Date.now();
      const solar = new Solar(config, {
        beforeRequest: (key, bytes, max) => {
          if (evalLockLost) throw new ProviderError('QA_EVAL_LEASE_LOST', false);
          return budget.beforeSummary(key, bytes, max);
        },
      });
      try {
        const run = await solar.summarize(
          input,
          id,
          async (u) => {
            usage.push(u);
            await budget.summaryUsage(u);
          },
          policy,
          { store: pg?.store ?? fileLedger(runDir, cache) },
        );
        let evaluation: any;
        if (test) evaluation = score(test, run);
        else {
          const active = run.facts.filter((f) =>
            run.report.dispositions.some((d) => d.fact_id === f.fact_id && d.status === 'RENDERED'),
          );
          const quote = (f: any) => f.evidence.map((e: any) => e.quote).join(' ');
          const engine = active.some(
            (f) =>
              f.evidence.some((e) =>
                input.segments.some((s) => s.segment_id === e.segment_id && s.start_ms >= 1500000),
              ) &&
              /유니티|언리얼|원리얼|얼리얼/.test(quote(f)) &&
              /엔진|Unity|Unreal|유니티|얼리얼|언리얼/.test(f.statement),
          );
          const art = active.some(
            (f) =>
              f.evidence.some((e) =>
                input.segments.some((s) => s.segment_id === e.segment_id && s.start_ms >= 2100000),
              ) &&
              /AD/.test(quote(f)) &&
              /아트|스타일|AD|폴리곤/.test(f.statement),
          );
          const falseDating = run.result.action_items.some(
            (a) => a.owner_user_id !== null || a.due_date !== null,
          );
          const falseConcept = [
            ...run.result.decisions.map((d) => d.decision),
            ...run.result.action_items.map((a) => a.task),
          ].some((t) => /미연시|미연실/.test(t));
          evaluation = {
            pass: engine && art && !falseDating && !falseConcept,
            engine_topic: engine,
            ad_topic: art,
            false_identity_or_date: falseDating,
            false_dating_sim_decision: falseConcept,
            audio_accuracy: 'UNVERIFIED_NO_HUMAN_REFERENCE',
          };
        }
        const result = {
          id,
          iteration,
          seconds: (Date.now() - started) / 1000,
          status: evaluation.pass ? 'PASS' : 'FAIL',
          evaluation,
          report: run.report,
          model: run.model,
          input_tokens: usage.reduce((n, u) => n + u.input_tokens, 0),
          output_tokens: usage.reduce((n, u) => n + u.output_tokens, 0),
          calls: usage.length,
          ...cache,
        };
        results.push(result);
        await writeFile(resolve(runDir, 'evaluation.json'), JSON.stringify(result, null, 2), {
          mode: 0o600,
        });
        process.stdout.write(
          JSON.stringify({
            id,
            iteration,
            status: result.status,
            seconds: result.seconds,
            calls: usage.length,
            missing: evaluation.missing?.length,
            unexpected: evaluation.unexpected?.length,
          }) + '\n',
        );
      } catch (e: any) {
        const result = {
          id,
          iteration,
          status: 'FAIL',
          seconds: (Date.now() - started) / 1000,
          error: e.code ?? e.message,
          calls: usage.length,
          ...cache,
        };
        results.push(result);
        await mkdir(runDir, { recursive: true });
        await writeFile(resolve(runDir, 'evaluation.json'), JSON.stringify(result, null, 2), {
          mode: 0o600,
        });
        process.stdout.write(JSON.stringify(result) + '\n');
        if (String(result.error).startsWith('QA_BUDGET')) throw e;
      } finally {
        await pg?.dispose();
      }
      await writeFile(
        resolve(output, 'results.json'),
        JSON.stringify({ campaign, results, budget: await budget.report() }, null, 2),
        { mode: 0o600 },
      );
    }
  const times = results.map((r) => r.seconds).sort((a, b) => a - b);
  await writeFile(
    resolve(output, 'summary.json'),
    JSON.stringify(
      {
        campaign,
        total: results.length,
        passed: results.filter((r) => r.status === 'PASS').length,
        failed: results.filter((r) => r.status !== 'PASS').length,
        cold_cache: results.every((r) => r.cache_hits === 0),
        performance_pass:
          results.length >= 20 &&
          results.every((r) => r.status === 'PASS' && r.cache_hits === 0) &&
          (times[Math.ceil(times.length * 0.95) - 1] ?? Infinity) <= 120,
        performance_scope: recording
          ? '64 minute fixed transcript'
          : 'authored scripts; not a one-hour workload unless long-late-topics selected',
        p95_seconds: times[Math.ceil(times.length * 0.95) - 1] ?? null,
        budget: await budget.report(),
        human_review: false,
        journal: option('journal', 'file'),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (results.some((r) => r.status !== 'PASS')) process.exitCode = 1;
} finally {
  await evalLock
    .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey])
    .catch(() => {});
  evalLock.release();
  await account.close();
}
