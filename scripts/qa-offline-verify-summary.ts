import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Solar, loadConfig, PROMPT_HASH } from '@meeting/providers';
import type { SummaryUsage, SummaryPolicy } from '../packages/providers/src/solar.ts';
import type { SegmentDTO } from '@meeting/contracts';

const sourceDirectory = resolve(process.argv[2] ?? '.data/qa/offline-20260907');
const directory = resolve(sourceDirectory, process.argv[3] ?? 'revised');
await mkdir(directory, { recursive: true, mode: 0o700 });
const read = async (name: string) =>
  JSON.parse(await readFile(resolve(sourceDirectory, name), 'utf8'));
const segments: SegmentDTO[] = await read('segments.json');
const manifest = await read('manifest.json');
const participants = [
  ...new Map(
    segments.map((s) => [
      s.user_id,
      {
        user_id: s.user_id,
        display_name: s.display_name,
        present: true,
        recording_eligible: true,
      },
    ]),
  ).values(),
];
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (!response.ok)
    await save(
      'http-error-' + response.status + '.json',
      await response
        .clone()
        .json()
        .catch(() => ({ status: response.status })),
    );
  return response;
};
try {
  await readFile(resolve(directory, 'run.json'));
  throw new Error(
    'A benchmark run already exists; preserve it and choose a separate output directory.',
  );
} catch (error: any) {
  if (error.code !== 'ENOENT') throw error;
}
const started = Date.now();
await save('run.json', {
  started_at: new Date(started).toISOString(),
  prompt_hash: PROMPT_HASH,
  source_sha256: manifest.input_sha256,
  path: 'production Solar.summarize',
  known_recording_date: false,
  verified_owner_ids: false,
});
const usage: SummaryUsage[] = [];
let writes = Promise.resolve();
const stages: any[] = [];
class ObservedSolar extends Solar {
  override async chat(
    input: unknown,
    key: string,
    onUsage: (u: SummaryUsage) => Promise<void>,
    policy: SummaryPolicy = {},
  ) {
    const at = Date.now();
    const result = await super.chat(input, key, onUsage, policy);
    stages.push({ key, seconds: (Date.now() - at) / 1000 });
    await save(key.replaceAll(':', '-') + '.json', result);
    process.stdout.write(key + ' passed\n');
    return result;
  }
}
try {
  const result = await new ObservedSolar(loadConfig()).summarize(
    {
      meeting_id: 'offline-private-qa',
      started_at: null,
      segments,
      participants,
      metadata: {
        source_kind: 'OFFLINE_QA',
        reported_participants_minimum: 10,
        actual_meeting_date: null,
        verified_discord_ids: false,
      },
      glossary: [],
      markers: [],
      gaps: [],
    },
    'revised',
    (u) => {
      usage.push(u);
      writes = writes.then(() => save('usage.json', usage));
      return writes;
    },
    { verifiedOwners: false },
  );
  await save('summary.json', result.result);
  const metrics = {
    summary_seconds: (Date.now() - started) / 1000,
    stages,
    provider_requests: usage.length,
    input_tokens: usage.reduce((n, u) => n + u.input_tokens, 0),
    output_tokens: usage.reduce((n, u) => n + u.output_tokens, 0),
    model: result.model,
    all_evidence_ids_valid: true,
    unverified_owner_ids: result.result.action_items.filter((a) => a.owner_user_id !== null).length,
    unverified_dates: result.result.action_items.filter((a) => a.due_date !== null).length,
  };
  await save('metrics.json', metrics);
  process.stdout.write(JSON.stringify(metrics) + '\n');
} catch (error: any) {
  await writes;
  await save('failure.json', {
    seconds: (Date.now() - started) / 1000,
    error: error.code ?? error.message,
    stages,
  });
  throw error;
}
