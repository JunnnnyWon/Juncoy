import { markQaRun, completeQaAudio } from './lib/qa-retention.ts';
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import type { Guild } from 'discord.js';
import { Store, sql, first, rows, type Job } from '@meeting/db';
import { initialView, applyEvent, compareSegments, type ViewState } from '@meeting/domain';
import { ReturnZero, loadConfig } from '@meeting/providers';
import { Capture } from '../apps/bot/src/capture.ts';
import { buildServer } from '../apps/api/src/server.ts';
import { Auth } from '../apps/api/src/auth.ts';
import { fixture, guild, user } from '../tests/integration/helpers.ts';
import { ReplayMockSpeech, sineFrame } from './lib/replay-provider.ts';
import { QaBudget } from './lib/qa-budget.ts';
import { Jobs } from '../apps/worker/src/jobs.ts';
import type { Outbox } from '../apps/worker/src/outbox.ts';

const option = (name: string, fallback: string) => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : process.argv[i + 1]!;
};
const seconds = Number(option('seconds', '60')),
  tracks = Number(option('tracks', '12')),
  viewers = Number(option('viewers', '12'));
const providerMode = option('provider', 'mock'),
  browserCount = Number(option('browsers', '0'));
if (
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  ![2, 10, 12].includes(tracks) ||
  viewers < 0 ||
  viewers > 12 ||
  browserCount < 0 ||
  browserCount > 12 ||
  !['mock', 'real'].includes(providerMode)
)
  throw new Error('Invalid replay options');
const scenario = option('scenario', 'steady');
if (!['steady', 'overlap', 'faults'].includes(scenario)) throw new Error('Unknown replay scenario');
const output = resolve(option('output', 'artifacts/replay-' + Date.now()));
await mkdir(output, { recursive: true, mode: 0o700 });
await markQaRun(output);
const liveConfig = loadConfig();
const account = providerMode === 'real' ? new Store(liveConfig.DATABASE_URL) : null;
const budget = account
  ? new QaBudget(
      account,
      liveConfig.DISCORD_GUILD_ID,
      option('campaign', 'replay-' + Date.now()),
      Number(option('budget-krw', '10000')),
    )
  : null;
if (budget)
  await budget.reserve('replay', 'returnzero', (((seconds + 30) * tracks + 2000) / 3600) * 1000);
const f = await fixture();
const people = Array.from({ length: tracks }, (_, i) => ({
  user_id: (900000000000000010n + BigInt(i)).toString(),
  display_name: '재생 화자 ' + (i + 1),
  present: true,
  recording_eligible: true,
}));
const viewerPeople = Array.from({ length: Math.max(viewers, browserCount) }, (_, i) => ({
  user_id: (900000000000001000n + BigInt(i)).toString(),
  display_name: '웹 재생 검사 ' + i,
}));
const config = { ...f.config, RECORDING_STORAGE_PATH: resolve(output, 'audio') };
const settings = await f.store.getConfig(guild);
await f.store.setConfig(
  guild,
  { ...settings, admin_user_ids: [...people, ...viewerPeople].map((p) => p.user_id) },
  user,
);
for (const p of people) await f.store.consent(guild, p.user_id, true);
const m = await f.begin();
await f.store.setParticipants(guild, m.id, people);
const app = await buildServer(config, f.store);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const auth = new Auth(f.store, config),
  controllers: AbortController[] = [],
  readers: Promise<void>[] = [],
  states: ViewState[] = [],
  cookies: string[] = [];
const speechWindows = new Map<string, { start: number; end: number }[]>(),
  inputFinalLatencies: number[] = [];
const commits = new Map<string, number>(),
  latencies: number[] = [],
  errors: string[] = [],
  events: { user: string; phase: string; at: number }[] = [];
let serial = 0,
  browser: Browser | null = null;
const contexts: BrowserContext[] = [];
const real = providerMode === 'real' ? new ReturnZero({ ...config, PROVIDER_MODE: 'real' }) : null;
const clips = real
  ? await Promise.all(
      people.map((_, i) =>
        readFile(resolve(option('clips', '.data/qa/replay-clips'), `track-${i}.pcm`)),
      ),
    )
  : people.map((_, i) => sineFrame(i));
const capture = new Capture(f.store, config, m, { id: guild } as Guild, 'test', {
  mockUsage: !real,
  stream: (id, words) =>
    real
      ? real.stream(words)
      : new ReplayMockSpeech(id, serial++, {
          closeDelayMs: 75,
          failOpen: scenario === 'faults' && serial === 1 ? 429 : undefined,
          failAtMs: scenario === 'faults' && serial === 2 ? 1500 : undefined,
        }),
  committed: (s, at) => {
    if (s.is_final) {
      commits.set(s.segment_id, at);
      const window = speechWindows
        .get(s.user_id)
        ?.find(
          (w) =>
            (s.end_ms ?? s.start_ms) >= w.start &&
            Math.abs((s.end_ms ?? s.start_ms) - w.end) <= 2000,
        );
      if (window && capture.now() >= window.end)
        inputFinalLatencies.push(capture.now() - window.end);
    }
  },
  streamEvent: (user, phase, at) => {
    events.push({ user, phase, at });
    if (events.length > 5000) events.splice(0, 1000);
  },
});
let finished = false;
let feedTicks = 0;
const t0 = performance.now();
async function save(name: string, value: unknown) {
  await writeFile(resolve(output, name), JSON.stringify(value, null, 2), { mode: 0o644 });
}
try {
  await capture.startReplay(people);
  for (let i = 0; i < Math.max(viewers, browserCount); i++) {
    const p = viewerPeople[i]!;
    cookies.push(
      await auth.create(
        { id: p.user_id, username: p.display_name },
        {
          access_token: 'mock',
          refresh_token: 'mock',
          expires_at: Date.now() + 12 * 3600000,
          mock: true,
        },
      ),
    );
  }
  for (let i = 0; i < viewers; i++) {
    const snap = await f.store.snapshot(guild, m.id);
    states.push(initialView(snap));
    const controller = new AbortController();
    controllers.push(controller);
    const res = await fetch(`${url}/api/meetings/${m.id}/events?after=${snap.cursor}`, {
      headers: { cookie: 'session=' + cookies[i] },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('SSE connect HTTP ' + res.status);
    const reader = res.body!.getReader();
    readers.push(
      (async () => {
        let text = '';
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            text += decoder.decode(next.value, { stream: true });
            let end;
            while ((end = text.indexOf('\n\n')) >= 0) {
              const frame = text.slice(0, end);
              text = text.slice(end + 2);
              const data = frame.split('\n').find((l) => l.startsWith('data: '));
              if (!data) continue;
              const event = JSON.parse(data.slice(6));
              if (!event.event_seq) {
                errors.push('SSE_CONTROL:' + frame.slice(0, 80));
                continue;
              }
              try {
                states[i] = applyEvent(states[i]!, event);
                if (event.type === 'segment.upsert' && event.data.segment.is_final) {
                  const at = commits.get(event.data.segment.segment_id);
                  if (at !== undefined) latencies.push(Date.now() - at);
                }
              } catch (e) {
                errors.push(String(e));
              }
            }
          }
        } catch (e) {
          if (!controller.signal.aborted) errors.push(String(e));
        }
      })(),
    );
  }
  if (browserCount) {
    browser = await chromium.launch({ headless: true });
    for (let i = 0; i < browserCount; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      contexts.push(context);
      await context.addCookies([{ name: 'session', value: cookies[i]!, url }]);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push('BROWSER:' + e.message));
      await page.goto(`${url}/meetings/${m.id}?tab=transcript`);
      await page.getByText('실시간 연결됨', { exact: true }).waitFor();
    }
  }
  const began = performance.now();
  const recognition = real
    ? JSON.parse(
        await readFile(resolve(option('clips', '.data/qa/replay-clips'), 'reference.json'), 'utf8'),
      )
    : null;
  await save('manifest.json', {
    source: 'TEST_PCM_REPLAY',
    provider: providerMode,
    browsers: browserCount,
    sse_probes: viewers,
    tracks,
    seconds,
    scenario,
    meeting_id: m.id,
    started_at: new Date().toISOString(),
    actual_discord: false,
    reference: real
      ? 'independent authored TTS tracks'
      : 'deterministic signal + mock STT, not speech recognition',
  });
  let nextCheckpoint = 0;
  let speechCycle = -1;
  let revoked = false;
  let revokeBefore: unknown = null;
  let revokeAfter: unknown = null;
  while (performance.now() - began < seconds * 1000) {
    const elapsed = performance.now() - began,
      at = capture.now();
    if (scenario === 'faults' && !revoked && elapsed >= Math.min(5000, seconds * 200)) {
      await capture.revoke(people[tracks - 1]!.user_id);
      await f.store.consent(guild, people[tracks - 1]!.user_id, false);
      revoked = true;
      revokeBefore = capture.metrics().users.find((u) => u.user_id === people[tracks - 1]!.user_id);
    }
    const cycle = Math.floor(elapsed / (real ? 10000 : 30000));
    if (cycle !== speechCycle) {
      speechCycle = cycle;
      for (let i = 0; i < tracks; i++) {
        const start =
          at - (elapsed % (real ? 10000 : 30000)) + (real ? 0 : Math.floor(i / 3) * 5000);
        const list = speechWindows.get(people[i]!.user_id) ?? [];
        list.push({ start, end: start + (real ? clips[i]!.length / 32 : 3000) });
        speechWindows.set(people[i]!.user_id, list);
      }
    }
    for (let i = 0; i < tracks; i++) {
      const phase = elapsed % 30000,
        start = Math.floor(i / 3) * 5000;
      const speaking =
        scenario === 'overlap' ? elapsed % 90000 < 70000 : phase >= start && phase < start + 3000;
      let pcm: Buffer;
      if (real) {
        const clip = clips[i]!,
          offset = Math.floor((elapsed % 10000) / 100) * 3200;
        pcm = Buffer.alloc(3200);
        if (offset < clip.length) clip.copy(pcm, 0, offset, Math.min(clip.length, offset + 3200));
      } else if (!speaking) pcm = Buffer.alloc(3200);
      else pcm = clips[i]!;
      capture.ingestReplay(people[i]!.user_id, pcm, at);
    }
    feedTicks++;
    const metrics = capture.metrics();
    if (metrics.peak_reservations > 10) throw new Error('STREAM_LIMIT_BROKEN');
    if (
      metrics.users.some((u) => u.buffered_pcm_bytes > 160000 || u.pending_archive_bytes > 1920000)
    )
      throw new Error('BUFFER_LIMIT_BROKEN');
    if (metrics.storage_failed) throw new Error('CAPTURE_STORAGE_FAILED');
    if (elapsed >= nextCheckpoint) {
      const checkpoint = {
        elapsed_seconds: elapsed / 1000,
        metrics,
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
        errors: errors.length,
        cursors: states.map((s) => s.cursor),
      };
      await appendFile(resolve(output, 'checkpoints.jsonl'), JSON.stringify(checkpoint) + '\n');
      process.stdout.write(
        JSON.stringify({
          elapsed_seconds: Math.round(elapsed / 1000),
          active: metrics.open_streams,
          queued: metrics.queued_streams,
          finals: commits.size,
          errors: errors.length,
        }) + '\n',
      );
      nextCheckpoint += 60000;
    }
    const target = feedTicks * 100 - (performance.now() - began);
    if (target > 0) await new Promise((r) => setTimeout(r, target));
  }
  if (revoked)
    revokeAfter = capture.metrics().users.find((u) => u.user_id === people[tracks - 1]!.user_id);
  await capture.stop();
  await capture.settled();
  const recoveryResults: { key: string; status: string; error?: string }[] = [];
  if (process.argv.includes('--recover')) {
    await f.store.recoverPendingAudio(guild, m.id, Math.round(capture.now()));
    const remaining = await rows(
      sql<{
        id: string;
      }>`SELECT id FROM jobs WHERE meeting_id=${m.id}::uuid AND kind='RETRANSCRIBE' AND status='PENDING'`,
      f.store.db,
    );
    const fileBudgetKeys = new Set<string>();
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const job = await first(
        sql<Job>`UPDATE jobs SET status='RUNNING',generation=generation+1,lease_until=now()+interval '60 seconds',owner='qa-recovery',attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE meeting_id=${m.id}::uuid AND kind='RETRANSCRIBE' AND status='PENDING' ORDER BY due_at LIMIT 1) RETURNING *`,
        f.store.db,
      );
      if (!job) break;
      const fileKey = 'file:' + job.key;
      if (budget && !fileBudgetKeys.has(fileKey)) {
        const total = await first(
          sql<{
            ms: string;
          }>`SELECT coalesce(sum(end_ms-start_ms),0)::text AS ms FROM audio_chunks WHERE meeting_id=${m.id}::uuid AND user_id=${String(job.payload.user_id)} AND start_ms<${Number(job.payload.end_ms)} AND end_ms>${Number(job.payload.start_ms)}`,
          f.store.db,
        );
        await budget.reserve(
          fileKey,
          'returnzero',
          (Math.max(10000, Number(total?.ms ?? 0)) / 3600000) * 1000,
        );
        fileBudgetKeys.add(fileKey);
      }
      const mockFile = real
        ? undefined
        : {
            submitFile: async () => 'mock-file-' + job.id,
            fileStatus: async () => ({
              status: 'completed',
              utterances: [
                {
                  start_at: 0,
                  duration: Math.max(1, Number(job.payload.end_ms) - Number(job.payload.start_ms)),
                  msg: 'MOCK 화자 ' + job.payload.user_id + ' · 파일 복구',
                },
              ],
            }),
          };
      const jobs = new Jobs(
        f.store,
        { ...config, PROVIDER_MODE: real ? 'real' : 'mock' },
        {} as Outbox,
        mockFile,
      );
      try {
        await jobs.retranscribe(job);
        const state = await first(
          sql<{ status: string }>`SELECT status FROM jobs WHERE id=${job.id}::uuid`,
          f.store.db,
        );
        if (state?.status === 'PENDING') {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        await f.store.finishJob(job);
        recoveryResults.push({ key: job.key, status: 'DONE' });
        if (budget) {
          const u = await first(
            sql<{
              audio_ms: string;
              cost_krw: string;
            }>`SELECT audio_ms::text,cost_krw::text FROM usage_records WHERE request_key=${fileKey}`,
            f.store.db,
          );
          if (u) await budget.settleAudio(fileKey, Number(u.audio_ms), Number(u.cost_krw));
        }
      } catch (e: any) {
        await f.store.finishJob(job, e.code ?? String(e));
        recoveryResults.push({ key: job.key, status: 'FAILED', error: e.code ?? String(e) });
      }
    }
  }
  const high = (await f.store.eventRange(m.id))!.last_seq;
  const deadline = Date.now() + 30000;
  while (states.some((s) => s.cursor !== high) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  const canonical = (await f.store.allSegments(guild, m.id)).sort(compareSegments);
  const canon = (list: typeof canonical) =>
    JSON.stringify(list.map((s) => Object.entries(s).sort(([a], [b]) => a.localeCompare(b))));
  const match = states.every(
    (s) =>
      canon([...s.segments.values()].filter((x) => x.is_final).sort(compareSegments)) ===
      canon(canonical),
  );
  const mismatch = real ? null : canonical.filter((s) => !s.text.includes(s.user_id)).length;
  const browserFinals = [];
  for (const context of contexts) {
    const page = context.pages()[0]!;
    browserFinals.push({
      error: await page.getByRole('heading', { name: /기록을 불러오지 못/ }).count(),
      rows: await page.locator('.transcript-row').count(),
      rendered: await page.locator('.transcript-row.final').evaluateAll((rows) =>
        rows.map((r) => ({
          id: r.getAttribute('data-segment-id'),
          revision: Number(r.getAttribute('data-revision')),
          user_id: r.getAttribute('data-user-id'),
          text: r.querySelector('.utterance p')?.textContent,
        })),
      ),
    });
  }
  latencies.sort((a, b) => a - b);
  const report = {
    source: 'TEST_PCM_REPLAY',
    provider: providerMode,
    actual_discord: false,
    elapsed_wall_seconds: (performance.now() - began) / 1000,
    total_wall_seconds: (performance.now() - t0) / 1000,
    requested_seconds: seconds,
    tracks,
    viewers,
    browsers: browserCount,
    feed_ticks: feedTicks,
    canonical_finals: canonical.length,
    mapping_errors: mismatch,
    all_canonical_match: match,
    all_cursors_match: states.every((s) => s.cursor === high),
    errors,
    metrics: capture.metrics(),
    latency_samples: latencies.length,
    commit_to_sse_p95_ms: latencies[Math.floor(latencies.length * 0.95)] ?? null,
    browserFinals,
    recovery: recoveryResults,
    remaining_recovery_jobs: Number(
      (await first(
        sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM jobs WHERE kind='RETRANSCRIBE' AND status IN ('PENDING','RUNNING')`,
        f.store.db,
      ))!.n,
    ),
    input_end_to_final_p95_ms: (() => {
      const times = canonical
        .map(
          (s) =>
            Date.parse(s.updated_at) - Date.parse(m.view.started_at!) - (s.end_ms ?? s.start_ms),
        )
        .sort((a, b) => a - b);
      return times[Math.ceil(times.length * 0.95) - 1] ?? null;
    })(),
    authored_input_end_to_final_p95_ms:
      inputFinalLatencies.sort((a, b) => a - b)[Math.ceil(inputFinalLatencies.length * 0.95) - 1] ??
      null,
    authored_latency_samples: inputFinalLatencies.length,
    authored_end_basis:
      'end of authored clip including trailing silence; matches provider final only within 2 seconds of that clip end',
    input_end_time_basis:
      'provider segment end mapped to original input timeline; includes provider timestamp error',
    recognition: recognition
      ? people.map((p, i) => ({
          user_id: p.user_id,
          reference_name: recognition.clips[i].name,
          observed_name: canonical
            .filter((s) => s.user_id === p.user_id)
            .some((s) => s.text.replaceAll(' ', '').includes(recognition.clips[i].name)),
        }))
      : null,
    revokeBefore,
    revokeAfter,
    event_samples: events,
    ending_rss: process.memoryUsage().rss,
    status:
      errors.length === 0 &&
      match &&
      mismatch !== 1 &&
      states.every((s) => s.cursor === high) &&
      browserFinals.every((b) => b.error === 0)
        ? 'PASS'
        : 'FAIL',
  };
  if (!real && mismatch !== 0) report.status = 'FAIL';
  if (new Set(canonical.map((s) => s.user_id)).size < tracks - (scenario === 'faults' ? 1 : 0))
    report.status = 'FAIL';
  if (
    browserFinals.some(
      (b) =>
        b.rows === 0 ||
        b.rendered.some(
          (r) =>
            !canonical.some(
              (s) =>
                s.segment_id === r.id &&
                s.revision === r.revision &&
                s.text === r.text &&
                s.user_id === r.user_id,
            ),
        ),
    )
  )
    report.status = 'FAIL';
  if (revoked && revokeBefore && revokeAfter) {
    const a = revokeBefore as any,
      b = revokeAfter as any;
    if (a.sent_pcm_bytes !== b.sent_pcm_bytes || a.archived_pcm_bytes !== b.archived_pcm_bytes)
      report.status = 'FAIL';
  }
  if (
    process.argv.includes('--recover') &&
    (report.remaining_recovery_jobs || recoveryResults.some((r) => r.status === 'FAILED'))
  )
    report.status = 'FAIL';
  if (budget) {
    const u = await first(
      sql<{
        audio_ms: string;
        cost_krw: string;
      }>`SELECT coalesce(sum(audio_ms),0)::text AS audio_ms,coalesce(sum(cost_krw),0)::text AS cost_krw FROM usage_records WHERE request_key LIKE 'stream:%'`,
      f.store.db,
    );
    await budget.settleAudio('replay', Number(u!.audio_ms), Number(u!.cost_krw));
  }
  await save('budget.json', budget ? await budget.report() : { provider: 'mock', cost_krw: 0 });
  await save('report.json', report);
  await completeQaAudio(output);
  await save('canonical.json', canonical);
  await save('gaps.json', (await f.store.snapshot(guild, m.id)).gaps);
  finished = true;
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      elapsed_wall_seconds: report.elapsed_wall_seconds,
      canonical_finals: canonical.length,
      all_canonical_match: match,
      report: resolve(output, 'report.json'),
    }) + '\n',
  );
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  await save('failure.json', {
    error: String(error),
    metrics: capture.metrics(),
    errors,
    at: new Date().toISOString(),
  });
  throw error;
} finally {
  capture.abort();
  controllers.forEach((c) => c.abort());
  await Promise.allSettled(readers);
  await browser?.close();
  await app.close();
  await f.dispose();
  await account?.close();
  if (finished && !process.argv.includes('--keep-audio'))
    await rm(resolve(output, 'audio'), { recursive: true, force: true });
}
