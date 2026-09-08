import { spawn } from 'node:child_process';
import { mkdir, appendFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const service = process.argv[2];
const entries: Record<string, string> = {
  api: 'apps/api/src/main.ts',
  bot: 'apps/bot/src/main.ts',
  worker: 'apps/worker/src/main.ts',
};
if (!service || !entries[service]) throw new Error('Unknown service');
const directory = resolve(process.env.OPERATION_LOG_PATH ?? '/data/logs');
await mkdir(directory, { recursive: true, mode: 0o700 });
const secrets = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'RTZR_CLIENT_SECRET',
  'UPSTAGE_API_KEY',
  'TOKEN_ENCRYPTION_KEY',
  'AUDIO_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
]
  .map((k) => process.env[k])
  .filter((v): v is string => !!v && v.length > 8);
let pending = Promise.resolve(),
  pendingBytes = 0;
const log = (line: string) => {
  if (pendingBytes > 1048576) return;
  let text = line.slice(0, 16384);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  const record = new Date().toISOString() + ' ' + text;
  pendingBytes += Buffer.byteLength(record);
  const path = resolve(directory, service + '-' + new Date().toISOString().slice(0, 10) + '.log');
  pending = pending
    .then(() => appendFile(path, record.endsWith('\n') ? record : record + '\n', { mode: 0o600 }))
    .catch(() => {})
    .finally(() => {
      pendingBytes -= Buffer.byteLength(record);
    });
};
const prune = async () => {
  const cutoff = Date.now() - 30 * 86400000;
  for (const file of await readdir(directory)) {
    const match = /^(api|bot|worker|backup)-(\d{4}-\d{2}-\d{2})\.log$/.exec(file);
    if (match && Date.parse(match[2] + 'T00:00:00Z') < cutoff)
      await rm(resolve(directory, file), { force: true });
  }
};
await prune();
const timer = setInterval(() => void prune().catch(() => {}), 3600000);
const child = spawn(process.execPath, ['--import', 'tsx', entries[service]], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
for (const stream of [child.stdout, child.stderr]) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      log(buffer.slice(0, end + 1));
      buffer = buffer.slice(end + 1);
    }
    if (buffer.length > 16384) {
      log(buffer);
      buffer = '';
    }
  });
  stream.on('end', () => {
    if (buffer) log(buffer);
  });
}
child.on('error', () => log('SERVICE_PROCESS_ERROR'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
child.on('close', (code) => {
  clearInterval(timer);
  void pending.finally(() => process.exit(code ?? 1));
});
