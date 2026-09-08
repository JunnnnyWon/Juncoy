import { Store } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
try {
  const settings = await store.getConfig(config.DISCORD_GUILD_ID);
  if (settings.monthly_api_budget_krw === null)
    await store.setConfig(
      config.DISCORD_GUILD_ID,
      { ...settings, monthly_api_budget_krw: 50000 },
      settings.admin_user_ids[0] ?? 'setup',
    );
  process.stdout.write('Initial monthly API budget configured.\n');
} finally {
  await store.close();
}
