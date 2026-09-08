import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { markQaRun, completeQaAudio, cleanQaRuns } from '../../scripts/lib/qa-retention.ts';
it('QA retention expires audio before transcript and never follows external symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-retention-')),
    external = await mkdtemp(join(tmpdir(), 'qa-external-')),
    now = Date.now(),
    run = join(root, 'run');
  try {
    await markQaRun(run, now);
    await markQaRun(external, now - 200 * 86400000);
    await writeFile(join(external, 'keep'), 'external');
    await symlink(external, join(root, 'external'));
    await writeFile(join(run, 'input.flac'), 'audio');
    await writeFile(join(run, 'segments.json'), 'transcript');
    await completeQaAudio(run, now);
    await cleanQaRuns(root, now + 2 * 86400000);
    await expect(access(join(run, 'input.flac'))).rejects.toThrow();
    expect(await readFile(join(run, 'segments.json'), 'utf8')).toBe('transcript');
    await cleanQaRuns(root, now + 181 * 86400000);
    await expect(access(run)).rejects.toThrow();
    expect(await readFile(join(external, 'keep'), 'utf8')).toBe('external');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
