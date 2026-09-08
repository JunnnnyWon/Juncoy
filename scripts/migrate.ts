import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store, sql, rows } from '@meeting/db';
export async function migrate(store: Store) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`.execute(
    store.db,
  );
  const dir = resolve('packages/db/migrations');
  for (const name of (await readdir(dir)).filter((n) => /^\d+_.*\.sql$/.test(n)).sort())
    await store.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(478821991)`.execute(tx);
      if ((await rows(sql`SELECT name FROM schema_migrations WHERE name=${name}`, tx)).length)
        return;
      await sql.raw(await readFile(resolve(dir, name), 'utf8')).execute(tx);
      await sql`INSERT INTO schema_migrations(name) VALUES(${name})`.execute(tx);
      if (process.argv[1]?.endsWith('migrate.ts')) process.stdout.write(`Applied ${name}\n`);
    });
}
if (process.argv[1]?.endsWith('migrate.ts')) {
  const store = new Store(process.env.DATABASE_URL!);
  try {
    await migrate(store);
  } finally {
    await store.close();
  }
}
