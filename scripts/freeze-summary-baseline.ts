import { markQaRun, completeQaAudio } from './lib/qa-retention.ts';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const option = (k: string, d: string) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : process.argv[i + 1]!;
};
const source = resolve(option('source', '.data/qa/offline-20260907')),
  output = resolve(option('output', '.data/qa/summary-baseline-frozen'));
await mkdir(output, { recursive: true, mode: 0o700 });
await markQaRun(output);
const entries: {
  path: string;
  sha256: string;
  bytes: number;
  evidence_ids: number;
  min_ms: number | null;
  max_ms: number | null;
}[] = [];
const segments = JSON.parse(await readFile(resolve(source, 'segments.json'), 'utf8'));
const times = new Map<string, number>(segments.map((s: any) => [s.segment_id, s.start_ms]));
const files = [
  'segments.json',
  'summary.json',
  'summary-metrics.json',
  ...(await readdir(resolve(source, 'revised-v3')))
    .filter((n) => n.endsWith('.json'))
    .map((n) => 'revised-v3/' + n),
];
for (const name of files) {
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(source, name));
  } catch (e: any) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }
  const target = resolve(output, name);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
    if (!(await readFile(target)).equals(bytes)) throw new Error('FROZEN_BASELINE_CHANGED:' + name);
  }
  const ids = [...new Set(bytes.toString().match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? [])].filter(
    (id) => times.has(id),
  );
  const at = ids.map((id) => times.get(id)!);
  entries.push({
    path: name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    evidence_ids: ids.length,
    min_ms: at.length ? Math.min(...at) : null,
    max_ms: at.length ? Math.max(...at) : null,
  });
}
const manifest = {
  source_kind: 'OFFLINE_MIXED_AUDIO',
  actual_discord: false,
  human_reference: false,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 180 * 86400000).toISOString(),
  known_failures: [
    'PROPOSAL_PROMOTED_TO_DECISION',
    'LATE_ENGINE_AD_OMITTED',
    'MERGE_COPIED_FIRST_CHUNK',
  ],
  entries,
};
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2), {
  mode: 0o600,
});
process.stdout.write(JSON.stringify({ files: entries.length, output }) + '\n');
