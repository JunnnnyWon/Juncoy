import { Store, sql, rows } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
const id = process.argv[2];
try {
  if (!id) {
    const items = await rows(
      sql<{
        id: string;
        kind: string;
        status: string;
        created_at: Date;
        error_code: string;
      }>`SELECT id,kind,status,created_at,error_code FROM outbox WHERE guild_id=${config.DISCORD_GUILD_ID} AND status='NEEDS_RECONCILIATION' ORDER BY created_at`,
      store.db,
    );
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
  } else {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid outbox ID');
    await sql`UPDATE outbox SET status='RUNNING',lease_until=now()-interval '1 second',attempts=greatest(attempts,1) WHERE id=${id}::uuid AND guild_id=${config.DISCORD_GUILD_ID} AND status='NEEDS_RECONCILIATION'`.execute(
      store.db,
    );
    process.stdout.write(
      'Scheduled history reconciliation. Missing messages will not be resent automatically.\n',
    );
  }
} finally {
  await store.close();
}
