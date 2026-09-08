import { Store } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
try {
  const active = await store.active(config.DISCORD_GUILD_ID);
  if (active) throw new Error('A voice meeting is active. Finish it before replacing services.');
  process.stdout.write('No active voice meeting; service update may proceed.\n');
} finally {
  await store.close();
}
