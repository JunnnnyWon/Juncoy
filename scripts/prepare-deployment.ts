import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
const original = await readFile('.env', 'utf8');
const database = new URL(process.env.DATABASE_URL!);
const password = decodeURIComponent(database.password);
database.hostname = 'postgres';
database.port = '5432';
database.search = '';
const values: Record<string, string> = {
  NODE_ENV: 'production',
  PROVIDER_MODE: 'real',
  APP_BASE_URL: 'https://juncoystt.junnnny.kr',
  DISCORD_REDIRECT_URI: 'https://juncoystt.junnnny.kr/auth/discord/callback',
  DATABASE_URL: database.toString(),
  RECORDING_STORAGE_PATH: '/data/audio',
};
const env = original
  .split('\n')
  .map((line) => {
    const key = line.split('=')[0]!;
    return key in values ? key + '=' + values[key] : line;
  })
  .join('\n');
await writeFile(
  '.env.production',
  env +
    '\nPOSTGRES_PASSWORD=' +
    password +
    '\nMEETING_IMAGE=juncoy-meeting:0.1.0\nMEETING_UID=1002\nMEETING_GID=1002\n',
  { mode: 0o600 },
);
process.stdout.write('Production environment prepared without displaying secrets.\n');
