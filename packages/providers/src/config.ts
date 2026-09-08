import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROVIDER_MODE: z.enum(['mock', 'real']).default('mock'),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().default(''),
  DISCORD_CLIENT_ID: z.string().default(''),
  DISCORD_CLIENT_SECRET: z.string().default(''),
  DISCORD_REDIRECT_URI: z.string().default('http://localhost:3000/auth/discord/callback'),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  AUDIO_ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  RTZR_CLIENT_ID: z.string().default(''),
  RTZR_CLIENT_SECRET: z.string().default(''),
  RTZR_STREAM_CONCURRENCY_LIMIT: z.coerce.number().int().min(1).max(10).default(10),
  UPSTAGE_API_KEY: z.string().default(''),
  SUMMARY_AUTOPUBLISH_ENABLED: z.enum(['true', 'false']).default('true'),
  UPSTAGE_SUMMARY_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(3),
  UPSTAGE_MODEL: z
    .string()
    .regex(/^solar-pro3(?:-\d+)?$/)
    .default('solar-pro3-260323'),
  RECORDING_STORAGE_PATH: z.string().default('.data/audio'),
  MEETING_TIMEZONE: z.literal('Asia/Seoul').default('Asia/Seoul'),
  ENABLE_AUTO_START: z.enum(['false']).default('false'),
});
export type AppConfig = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const p = schema.safeParse(env);
  if (!p.success)
    throw new Error(
      'Invalid environment: ' + p.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  const c = p.data;
  if (c.PROVIDER_MODE === 'real') {
    const needed = [
      'DISCORD_BOT_TOKEN',
      'DISCORD_CLIENT_ID',
      'RTZR_CLIENT_ID',
      'RTZR_CLIENT_SECRET',
      'UPSTAGE_API_KEY',
    ] as const;
    const missing = needed.filter((k) => !c[k]);
    if (missing.length) throw new Error('Missing provider configuration: ' + missing.join(', '));
  }
  if (
    c.NODE_ENV === 'production' &&
    (c.PROVIDER_MODE !== 'real' ||
      !c.APP_BASE_URL.startsWith('https://') ||
      !c.DISCORD_CLIENT_SECRET ||
      c.DISCORD_REDIRECT_URI !== c.APP_BASE_URL + '/auth/discord/callback')
  )
    throw new Error(
      'Production requires real providers, HTTPS, OAuth secret and matching redirect URI',
    );
  return c;
}
