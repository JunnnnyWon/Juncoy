import { markQaRun, completeQaAudio } from './lib/qa-retention.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '@meeting/db';
import { displayText } from '@meeting/domain';
import { ReturnZero, loadConfig, pcmToFlac } from '@meeting/providers';
import { orderedBatches } from '../packages/providers/src/summary-evidence.ts';
import { QaBudget } from './lib/qa-budget.ts';
const option = (key: string, fallback: string) => {
  const i = process.argv.indexOf('--' + key);
  return i < 0 ? fallback : process.argv[i + 1]!;
};
const config = loadConfig(),
  account = new Store(config.DATABASE_URL),
  provider = new ReturnZero(config);
const clipsDir = resolve(option('clips', '.data/qa/replay-clips')),
  output = resolve(option('output', '.data/qa/audio-evaluation-' + Date.now()));
const reference = JSON.parse(await readFile(resolve(clipsDir, 'reference.json'), 'utf8'));
const glossaryPath = option('glossary', '');
const glossary = glossaryPath ? JSON.parse(await readFile(resolve(glossaryPath), 'utf8')) : [];
const budget = new QaBudget(
  account,
  config.DISCORD_GUILD_ID,
  option('campaign', 'audio-' + Date.now()),
  Number(option('budget-krw', '1000')),
);
await mkdir(output, { recursive: true, mode: 0o700 });
await markQaRun(output);
const norm = (text: string) => {
  let s = text.normalize('NFC').toLowerCase();
  for (const [a, b] of Object.entries(reference.normalization.aliases))
    s = s.replaceAll(a.toLowerCase(), String(b).toLowerCase());
  return s.replace(/[\s\p{P}]/gu, '');
};
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}
const save = async (name: string, data: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(data, null, 2), { mode: 0o600 });
try {
  const results = await orderedBatches(reference.clips as any[], 3, async (clip) => {
    const pcm = await readFile(resolve(clipsDir, `track-${clip.index}.pcm`));
    if (createHash('sha256').update(pcm).digest('hex') !== clip.sha256)
      throw new Error('REFERENCE_AUDIO_HASH_CHANGED');
    const key = 'track-' + clip.index;
    await budget.reserve(key, 'returnzero', (Math.max(10000, clip.duration_ms) / 3600000) * 1000);
    const at = Date.now();
    const id = await provider.submitFile(await pcmToFlac(pcm), glossary);
    await save(key + '-job.json', {
      id,
      sha256: clip.sha256,
      created_at: new Date().toISOString(),
    });
    const deadline = Date.now() + 180000;
    let status = await provider.fileStatus(id);
    while (status.status !== 'completed') {
      if (Date.now() > deadline) throw new Error('FILE_STT_TIMEOUT');
      await new Promise((r) => setTimeout(r, 2000));
      status = await provider.fileStatus(id);
    }
    const text = status.utterances.map((u) => u.msg).join(' '),
      a = norm(clip.text),
      b = norm(text);
    const result = {
      index: clip.index,
      user_id: clip.user_id,
      name: clip.name,
      reference: clip.text,
      text,
      display_text: displayText(text, glossary),
      display_cer: distance(a, norm(displayText(text, glossary))) / a.length,
      display_terms: reference.terms.map((t: string) => ({
        term: t,
        recognized: norm(displayText(text, glossary)).includes(norm(t)),
      })),
      edits: distance(a, b),
      reference_characters: a.length,
      cer: distance(a, b) / a.length,
      terms: reference.terms.map((t: string) => ({ term: t, recognized: b.includes(norm(t)) })),
      seconds: (Date.now() - at) / 1000,
    };
    await save(key + '-result.json', { ...result, provider_response: status });
    await budget.settleAudio(
      key,
      clip.duration_ms,
      (Math.max(10000, clip.duration_ms) / 3600000) * 1000,
    );
    process.stdout.write(
      JSON.stringify({ index: clip.index, cer: result.cer, seconds: result.seconds }) + '\n',
    );
    return result;
  });
  const edits = results.reduce((n, r) => n + r.edits, 0),
    characters = results.reduce((n, r) => n + r.reference_characters, 0),
    terms = results.flatMap((r) => r.terms);
  const report = {
    source: 'AUTHORED_LOCAL_TTS',
    provider: 'ReturnZero file Sommers',
    actual_discord: false,
    human_review: false,
    normalization: reference.normalization,
    glossary,
    display_cer:
      results.reduce((n, r) => n + r.display_cer * r.reference_characters, 0) / characters,
    display_term_recognition:
      results.flatMap((r) => r.display_terms).filter((t) => t.recognized).length / terms.length,
    results,
    cer: edits / characters,
    term_recognition: terms.filter((t) => t.recognized).length / terms.length,
    budget: await budget.report(),
  };
  await save('report.json', report);
  await completeQaAudio(output);
  process.stdout.write(
    JSON.stringify({
      cer: report.cer,
      term_recognition: report.term_recognition,
      budget: report.budget,
    }) + '\n',
  );
} finally {
  await account.close();
}
