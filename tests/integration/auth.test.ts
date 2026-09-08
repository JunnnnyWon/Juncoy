import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { Auth } from '../../apps/api/src/auth.ts';
import { fixture, guild, user, channel } from './helpers.ts';
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.dispose();
});
async function setup() {
  const auth = new Auth(f.store, { ...f.config, PROVIDER_MODE: 'real' });
  const cookie = await auth.create(
    { id: user, username: 'QA' },
    { access_token: 'qa-token', refresh_token: 'qa-refresh', expires_at: Date.now() + 3600000 },
  );
  return { auth, session: await auth.session(cookie) };
}
function responses(identityStatus = 200, memberStatus = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname.replace('/api/v10', '');
    if (path === '/users/@me') return Response.json({ id: user }, { status: identityStatus });
    if (path === `/guilds/${guild}/members/${user}`)
      return Response.json({ roles: [], retry_after: 2 }, { status: memberStatus });
    if (path === `/guilds/${guild}`) return Response.json({ id: guild, owner_id: user });
    if (path === `/guilds/${guild}/roles`) return Response.json([]);
    if (path === `/channels/${channel}`)
      return Response.json({ id: channel, guild_id: guild, permission_overwrites: [] });
    throw new Error('Unexpected auth endpoint ' + path);
  });
}
it('OAuth identity is checked while current membership comes from the bot guild-member endpoint', async () => {
  const { auth, session } = await setup();
  const fetch = responses();
  expect(await auth.check(session, guild, channel)).toBeGreaterThan(Date.now());
  await auth.check(session, guild, channel);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockRestore();
  responses(401);
  auth.invalidate();
  await expect(auth.check(session, guild, channel)).rejects.toMatchObject({ status: 403 });
});
it('a Discord Retry-After blocks repeated upstream attempts until the cooldown expires', async () => {
  const { auth, session } = await setup();
  const fetch = responses(200, 429);
  await expect(auth.check(session, guild, channel)).rejects.toMatchObject({
    code: 'AUTHZ_RATE_LIMITED',
    retryAfterSeconds: 2,
  });
  await expect(auth.check(session, guild, channel)).rejects.toMatchObject({
    code: 'AUTHZ_RATE_LIMITED',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockRestore();
  const recovered = responses();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
  expect(await auth.check(session, guild, channel)).toBeGreaterThan(Date.now());
  expect(recovered).toHaveBeenCalledTimes(2);
});

it('role-less members can read every channel and membership loss expires within 30 seconds', async () => {
  const { auth, session } = await setup();
  const upstream = responses();
  await auth.check(session, guild, channel);
  await auth.check(session, guild, '900000000000009999');
  expect(upstream).toHaveBeenCalledTimes(2);
  upstream.mockRestore();
  responses(200, 404);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11000);
  await expect(auth.check(session, guild, channel)).rejects.toMatchObject({ status: 403 });
});
it('Discord failure never renews an expired allow decision', async () => {
  const { auth, session } = await setup();
  const upstream = responses();
  await auth.check(session, guild, channel);
  upstream.mockRestore();
  responses(200, 500);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11000);
  await expect(auth.check(session, guild, channel)).rejects.toMatchObject({ status: 503 });
});
