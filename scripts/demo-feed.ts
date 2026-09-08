import 'dotenv/config';
import { Store, sql, first } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
import { DEMO_GUILD, demoPeople, demoLines } from './seed.ts';
const config = loadConfig();
if (config.PROVIDER_MODE !== 'mock') throw new Error('Demo feed requires explicit mock mode');
const store = new Store(config.DATABASE_URL);
let n = 0,
  stopped = false;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopped = true;
  });
while (!stopped) {
  const m = await store.active(DEMO_GUILD);
  if (!m) {
    await wait(2000);
    continue;
  }
  const p = demoPeople[n % 6]!,
    text = demoLines[n % demoLines.length]!,
    start = Math.max(0, Date.now() - Date.parse(m.view.started_at!)),
    sourceKey = 'demo-live:' + Date.now() + ':' + n;
  for (const fraction of [0.22, 0.48, 0.78, 1]) {
    if (stopped) break;
    await store.upsertTranscript({
      guildId: DEMO_GUILD,
      meetingId: m.id,
      userId: p.user_id,
      displayName: p.display_name,
      sourceKey,
      start,
      end: start + 4000,
      text: text.slice(0, Math.max(1, Math.floor(text.length * fraction))),
      final: fraction === 1,
    });
    await wait(900);
  }
  n++;
  await wait(3500);
}
await store.close();
