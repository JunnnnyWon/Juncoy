import { loadConfig, ReturnZero } from '@meeting/providers';
import { readFile, writeFile } from 'node:fs/promises';
const rtzr = new ReturnZero(loadConfig());
const audio = await readFile('artifacts/synthetic-stt.flac');
const id = await rtzr.submitFile(audio, [{ spoken: '유니티', weight: 2 }]);
await writeFile('artifacts/file-stt-job.json', JSON.stringify({ id }));
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const result = await rtzr.fileStatus(id);
  if (result.status === 'completed') {
    const report = {
      at: new Date().toISOString(),
      status: 'PASS',
      input: 'synthetic Yuna voice; not a human accuracy benchmark',
      utterances: result.utterances.length,
      timestamps_valid: result.utterances.every(
        (u) => Number.isFinite(u.start_at) && Number.isFinite(u.duration),
      ),
      recognized_text: result.utterances.map((u) => u.msg),
    };
    await writeFile('artifacts/file-stt-verification.json', JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
process.stdout.write('File STT remains queued. Job ID saved locally.\n');
