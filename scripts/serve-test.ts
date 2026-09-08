import { fixture } from '../tests/integration/helpers.ts';
import { seed, DEMO_GUILD, demoPeople } from './seed.ts';
import { buildServer } from '../apps/api/src/server.ts';
import { Auth } from '../apps/api/src/auth.ts';
import { sql, rows, json } from '@meeting/db';
const f = await fixture();
const meetingId = await seed(f.store);
const config = {
  ...f.config,
  DISCORD_GUILD_ID: DEMO_GUILD,
  APP_BASE_URL: 'http://127.0.0.1:3100',
  API_PORT: 3100,
};
const app = await buildServer(config, f.store);
const auth = new Auth(f.store, config);
app.post('/__test/transcript', async (req) => {
  const b = req.body as any;
  const p = demoPeople[Number(b.user ?? 0)]!;
  return f.store.upsertTranscript({
    guildId: DEMO_GUILD,
    meetingId,
    userId: p.user_id,
    displayName: p.display_name,
    sourceKey: String(b.key),
    text: String(b.text),
    start: Number(b.start),
    end: Number(b.start) + 1000,
    final: Boolean(b.final),
  });
});
app.post('/__test/access', async (req) => {
  const allowed = Boolean((req.body as any).allowed);
  const c = await f.store.getConfig(DEMO_GUILD);
  await f.store.setConfig(
    DEMO_GUILD,
    { ...c, admin_user_ids: allowed ? demoPeople.map((p) => p.user_id) : [] },
    demoPeople[0]!.user_id,
  );
  return { ok: true };
});
app.post('/__test/session', async (req) => {
  const p = demoPeople[Number((req.body as any).user)]!;
  return {
    cookie: await auth.create(
      { id: p.user_id, username: p.display_name },
      { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 3600000, mock: true },
    ),
  };
});
app.get('/__test/state', async () => ({
  meeting_id: meetingId,
  events: (await f.store.eventRange(meetingId))?.last_seq,
  streams: (await rows(sql`SELECT * FROM stt_streams`, f.store.db)).length,
  jobs: (await rows(sql`SELECT * FROM jobs`, f.store.db)).length,
}));
await app.listen({ host: '127.0.0.1', port: 3100 });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => f.dispose()).then(() => process.exit(0));
  });
