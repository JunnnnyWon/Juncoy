import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
let env: string;
try {
  env = await readFile('.env', 'utf8');
} catch {
  env = await readFile('.env.example', 'utf8');
}
for (const name of ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'AUDIO_ENCRYPTION_KEY'])
  env = env.replace(
    new RegExp('^' + name + '=$', 'm'),
    name + '=' + randomBytes(32).toString('hex'),
  );
await writeFile('.env', env, { mode: 0o600 });
await chmod('.env', 0o600);
process.stdout.write(
  'Local environment prepared. Existing values were preserved; secrets are not printed.\n',
);
