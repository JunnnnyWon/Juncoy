import { it, expect } from 'vitest';
import { sql, first } from '@meeting/db';
import { fixture, guild, user } from './helpers.ts';

it('team recording needs no consent row, routes posts to the bot channel, and still fences pause/deletion', async () => {
  const f = await fixture();
  try {
    const bot = '900000000000000099';
    await f.store.setConfig(
      guild,
      { ...(await f.store.getConfig(guild)), require_consent: false, bot_channel_id: bot },
      user,
    );
    await sql`DELETE FROM user_consents`.execute(f.store.db);
    expect(await f.store.consented(guild, user)).toBe(true);
    const m = await f.begin();
    expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(true);
    expect(await f.store.captureAllowed(guild, m.id, '900000000000000088', m.fencing)).toBe(false);
    expect(
      await f.store.enqueueRecovery(guild, m.id, 'recover:team', {
        user_id: user,
        start_ms: 0,
        end_ms: 1000,
      }),
    ).toBe(true);
    const job = (await f.store.claimJob('test'))!;
    await f.store.assertRecoveryConsent(f.store.db, job);
    const output = await first(
      sql<any>`SELECT channel_id FROM outbox WHERE entity_id=${m.id}::uuid`,
      f.store.db,
    );
    expect(output.channel_id).toBe(bot);
    await f.store.transition(guild, m.id, 'PAUSED');
    expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(false);
    await sql`UPDATE meetings SET deleted_at=now() WHERE id=${m.id}::uuid`.execute(f.store.db);
    expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(false);
    await expect(f.store.assertRecoveryConsent(f.store.db, job)).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});
it('all voice mode starts a meeting without a configured channel allowlist', async () => {
  const f = await fixture();
  try {
    await f.store.setConfig(guild, { ...(await f.store.getConfig(guild)), detect_all_voice_channels: true, voice_channel_ids: [] }, user);
    const m = await f.begin();
    expect(m.status).toBe('RECORDING');
  } finally { await f.dispose(); }
});
