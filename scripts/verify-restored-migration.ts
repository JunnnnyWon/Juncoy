import { Store, sql, rows } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
import { migrate } from './migrate.ts';
const name = process.argv[2];
if (!name || !/^meeting_restore_\d+$/.test(name)) throw new Error('RESTORE_DATABASE_REQUIRED');
const config = loadConfig(),
  url = new URL(config.DATABASE_URL);
url.pathname = '/' + name;
const store = new Store(url.toString());
try {
  await migrate(store);
  const migrations = await rows(
    sql<{ name: string }>`SELECT name FROM schema_migrations ORDER BY name`,
    store.db,
  );
  const foreignKeys = await rows(
    sql<{
      table_name: string;
      deletion: string;
    }>`SELECT conrelid::regclass::text AS table_name,confdeltype AS deletion FROM pg_constraint WHERE contype='f' AND conrelid IN ('summary_runs'::regclass,'summary_stages'::regclass,'summary_stage_attempts'::regclass,'summary_facts'::regclass)`,
    store.db,
  );
  if (
    !migrations.some((m) => m.name === '004_fact_ledger.sql') ||
    foreignKeys.some((f) => f.deletion !== 'c')
  )
    throw new Error('RESTORE_MIGRATION_CONTRACT_FAILED');
  process.stdout.write(
    JSON.stringify({
      restored_database: name,
      migrations: migrations.map((m) => m.name),
      cascading_foreign_keys: foreignKeys.length,
      status: 'PASS',
    }) + '\n',
  );
} finally {
  await store.close();
}
