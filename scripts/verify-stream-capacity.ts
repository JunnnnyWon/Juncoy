import { loadConfig, ReturnZero, type SpeechStream } from '@meeting/providers';
import { mkdir, writeFile } from 'node:fs/promises';
const provider = new ReturnZero(loadConfig()),
  streams: SpeechStream[] = [],
  results: { index: number; connected: boolean; code?: string }[] = [];
await provider.authenticate();
for (let i = 0; i < 12; i++) {
  const stream = provider.stream([]);
  stream.on('failure', () => {});
  try {
    await stream.open();
    stream.send(Buffer.alloc(3200));
    streams.push(stream);
    results.push({ index: i, connected: true });
  } catch (e) {
    results.push({ index: i, connected: false, code: (e as any).code ?? 'CONNECTION_FAILED' });
    stream.abort();
  }
}
await Promise.all(streams.map((s) => s.end()));
const report = {
  at: new Date().toISOString(),
  type: 'real provider capacity check with synthetic silence',
  attempted: 12,
  connected: results.filter((r) => r.connected).length,
  results,
  status: results.every((r) => r.connected) ? 'PASS' : 'LIMITED',
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/stream-capacity.json', JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
