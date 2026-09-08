import { loadConfig } from '@meeting/providers';
import { Store, sql, rows } from '@meeting/db';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
try {
  const services = await rows(
    sql<any>`SELECT service,heartbeat_at,extract(epoch from (now()-heartbeat_at))::int AS age_seconds,metrics FROM health_records`,
    store.db,
  );
  const jobs = await rows(
    sql<any>`SELECT kind,status,count(*) AS count FROM jobs GROUP BY kind,status`,
    store.db,
  );
  const outbox = await rows(
    sql<any>`SELECT status,count(*) AS count FROM outbox WHERE guild_id=${config.DISCORD_GUILD_ID} GROUP BY status`,
    store.db,
  );
  process.stdout.write(JSON.stringify({ services, jobs, outbox }, null, 2) + '\n');
} finally {
  await store.close();
}
