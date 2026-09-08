import { REST, Routes } from 'discord.js';
import { loadConfig } from '@meeting/providers';
import { commands } from '../apps/bot/src/commands.ts';
const config = loadConfig();
if (config.PROVIDER_MODE !== 'real') throw new Error('Use PROVIDER_MODE=real to register commands');
await new REST({ version: '10' })
  .setToken(config.DISCORD_BOT_TOKEN)
  .put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID), {
    body: commands,
  });
process.stdout.write('Registered /회의 commands in the configured guild.\n');
