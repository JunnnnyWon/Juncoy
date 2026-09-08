import 'dotenv/config';
import { REST, Routes, ChannelType, PermissionsBitField } from 'discord.js';
import { Store } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
const config = loadConfig(),
  rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN),
  store = new Store(config.DATABASE_URL);
try {
  const guild = (await rest.get(Routes.guild(config.DISCORD_GUILD_ID))) as any;
  const roles = (await rest.get(Routes.guildRoles(guild.id))) as any[];
  let role = roles.find((r) => r.name === '회의 팀원');
  if (!role)
    role = await rest.post(Routes.guildRoles(guild.id), {
      body: { name: '회의 팀원', permissions: '0', mentionable: false },
    });
  const channels = (await rest.get(Routes.guildChannels(guild.id))) as any[];
  let record = channels.find((c) => c.name === '회의기록');
  if (!record) {
    const read =
      PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.ReadMessageHistory;
    record = await rest.post(Routes.guildChannels(guild.id), {
      body: {
        name: '회의기록',
        type: ChannelType.GuildText,
        topic: '동의한 팀 회의의 전사·요약·근거를 열람하는 비공개 기록 채널',
        permission_overwrites: [
          { id: guild.id, type: 0, deny: read.toString(), allow: '0' },
          { id: role.id, type: 0, allow: read.toString(), deny: '0' },
          { id: config.DISCORD_CLIENT_ID, type: 1, allow: '1166336', deny: '0' },
        ],
      },
    });
  }
  const voice = channels.find((c) => c.type === 2 && c.name === 'tesitng'),
    notification = channels.find((c) => c.type === 0 && c.name === 'test');
  if (!voice || !notification) throw new Error('Selected channels are missing');
  const old = await store.getConfig(guild.id);
  await store.setConfig(
    guild.id,
    {
      ...old,
      voice_channel_ids: [voice.id],
      notification_channel_id: notification.id,
      record_channel_id: record.id,
      team_role_ids: [role.id],
      admin_user_ids: [...new Set([...old.admin_user_ids, guild.owner_id])],
    },
    guild.owner_id,
  );
  process.stdout.write(
    JSON.stringify({
      guild: guild.name,
      guild_id: guild.id,
      voice_channel: voice.name,
      notification_channel: notification.name,
      record_channel: record.name,
      team_role: role.name,
      budget_configured: old.monthly_api_budget_krw !== null,
    }) + '\n',
  );
} finally {
  await store.close();
}
