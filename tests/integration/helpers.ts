import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Store, sql } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
import { migrate } from '../../scripts/migrate.ts';
export const guild = '900000000000000001',
  user = '900000000000000010',
  voice = '900000000000000002',
  channel = '900000000000000003';
export async function fixture() {
  const admin = new Store(process.env.DATABASE_URL!);
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin.db);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('options', '-c search_path=' + schema);
  const store = new Store(url.toString());
  await migrate(store);
  await store.setConfig(
    guild,
    {
      voice_channel_ids: [voice],
      notification_channel_id: channel,
      record_channel_id: channel,
      admin_user_ids: [user],
      monthly_api_budget_krw: 50000,
    },
    user,
  );
  await store.consent(guild, user, true);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    PROVIDER_MODE: 'mock',
    DISCORD_GUILD_ID: guild,
    DATABASE_URL: url.toString(),
    APP_BASE_URL: 'http://localhost:3000',
  });
  const begin = async () => {
    const m = await store.begin({
      guildId: guild,
      channelId: voice,
      channelName: '테스트',
      userId: user,
      interactionId: randomUUID(),
      owner: 'test',
      participants: [
        { user_id: user, display_name: '준', present: true, recording_eligible: true },
      ],
      isMock: true,
    });
    await store.transition(guild, m.id, 'RECORDING');
    return store.meeting(guild, m.id);
  };
  return {
    store,
    config,
    begin,
    dispose: async () => {
      await store.close();
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin.db);
      await admin.close();
    },
  };
}
