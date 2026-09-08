import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function markQaRun(directory: string, now = Date.now()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      resolve(directory, 'retention.json'),
      JSON.stringify({
        schema: 'meeting-qa-retention-v1',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 180 * 86400000).toISOString(),
        audio_expires_at: new Date(now + 7 * 86400000).toISOString(),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
  }
}
export async function completeQaAudio(directory: string, now = Date.now()) {
  const path = resolve(directory, 'retention.json'),
    current = JSON.parse(await readFile(path, 'utf8'));
  if (current.schema !== 'meeting-qa-retention-v1') throw new Error('UNKNOWN_QA_RETENTION');
  current.audio_expires_at = new Date(
    Math.min(Date.parse(current.audio_expires_at), now + 86400000),
  ).toISOString();
  await writeFile(path, JSON.stringify(current), { mode: 0o600 });
}
/** Only marked application QA directories are removed; never follow symbolic links. */
export async function cleanQaRuns(root: string, now = Date.now()) {
  const removed: string[] = [];
  async function visit(directory: string, depth: number) {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e: any) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const marker = entries.find((e) => e.name === 'retention.json' && e.isFile());
    if (marker) {
      let policy;
      try {
        policy = JSON.parse(await readFile(resolve(directory, marker.name), 'utf8'));
      } catch {
        return;
      }
      if (policy.schema !== 'meeting-qa-retention-v1') return;
      if (Date.parse(policy.expires_at) <= now) {
        await rm(directory, { recursive: true, force: true });
        removed.push(directory);
        return;
      }
      if (Date.parse(policy.audio_expires_at) <= now) {
        for (const name of ['audio', 'input.flac']) {
          const item = entries.find((e) => e.name === name && !e.isSymbolicLink());
          if (item) await rm(resolve(directory, name), { recursive: true, force: true });
        }
      }
    }
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'audio')
        await visit(resolve(directory, entry.name), depth + 1);
  }
  await visit(resolve(root), 0);
  return removed;
}
