import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const existing = spawnSync(
  'ssh',
  [
    '-o',
    'BatchMode=yes',
    'junnnnyserver',
    'docker inspect discord-meeting-db --format "{{.State.Running}}"',
  ],
  { encoding: 'utf8' },
);
if (existing.status !== 0) {
  const pass = randomBytes(24).toString('hex');
  const result = spawnSync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      'junnnnyserver',
      `docker run -d --name discord-meeting-db --restart unless-stopped -e POSTGRES_USER=meeting -e POSTGRES_DB=meeting -e POSTGRES_PASSWORD=${pass} -p 127.0.0.1:15439:5432 -v discord-meeting-pgdata:/var/lib/postgresql/data postgres:17-bookworm`,
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  if (result.status !== 0) throw new Error('Remote PostgreSQL container did not start');
  const path = '.env';
  const env = await readFile(path, 'utf8');
  await writeFile(
    path,
    env.replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=postgresql://meeting:${pass}@127.0.0.1:15439/meeting`,
    ),
    { mode: 0o600 },
  );
}
process.stdout.write('Dedicated PostgreSQL container ready; connect through the SSH forward.\n');
