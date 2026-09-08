import 'dotenv/config';
import { spawn } from 'node:child_process';
import { Store } from '@meeting/db';
import { migrate } from './migrate.ts';
import { seed, DEMO_GUILD } from './seed.ts';
const store = new Store(process.env.DATABASE_URL!);
await migrate(store);
await seed(store);
await store.close();
const build = spawn('pnpm', ['build'], { stdio: 'inherit' });
await new Promise<void>((resolve, reject) =>
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Web build failed')))),
);
const env = {
  ...process.env,
  PROVIDER_MODE: 'mock',
  DISCORD_GUILD_ID: DEMO_GUILD,
  APP_BASE_URL: 'http://127.0.0.1:3000',
  NODE_ENV: 'development',
};
const children = ['apps/api/src/main.ts', 'apps/worker/src/main.ts', 'scripts/demo-feed.ts'].map(
  (path) => spawn('pnpm', ['exec', 'tsx', path], { stdio: 'inherit', env }),
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    children.forEach((c) => c.kill('SIGTERM'));
  });
process.stdout.write('Explicit mock workspace: http://127.0.0.1:3000\n');
