import { it, expect, beforeEach, afterEach } from 'vitest';
import { fixture, guild, user } from './helpers';
import { buildServer } from '../../apps/api/src/server';
import { Auth } from '../../apps/api/src/auth';
import { randomUUID } from 'node:crypto';
import { sql, rows } from '@meeting/db';
let f: Awaited<ReturnType<typeof fixture>>,
  app: Awaited<ReturnType<typeof buildServer>>,
  cookie: string,
  id: string;
beforeEach(async () => {
  f = await fixture();
  const m = await f.begin();
  id = m.id;
  await f.store.upsertTranscript({
    guildId: guild,
    meetingId: id,
    userId: user,
    displayName: '팀원',
    sourceKey: 'one',
    start: 0,
    end: 1000,
    text: '<script>alert(1)</script> @everyone 회의내용',
    final: true,
  });
  app = await buildServer(f.config, f.store);
  cookie =
    'session=' +
    (await new Auth(f.store, f.config).create(
      { id: user, username: '준' },
      { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 3600000, mock: true },
    ));
});
afterEach(async () => {
  await app.close();
  await f.dispose();
});
it('AT-28 all read and download routes enforce authentication and meeting scope', async () => {
  for (const suffix of ['snapshot', 'summary', 'transcript', 'search?q=회의', 'export?format=md']) {
    expect((await app.inject({ url: `/api/meetings/${id}/${suffix}` })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `/api/meetings/${randomUUID()}/${suffix}`, headers: { cookie } }))
        .statusCode,
    ).toBe(404);
    const good = await app.inject({ url: `/api/meetings/${id}/${suffix}`, headers: { cookie } });
    expect(good.statusCode).toBe(200);
    expect(good.headers['cache-control']).toContain('no-store');
  }
});
it('AT-30 logout invalidates server session and requires same-origin POST', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie, origin: 'https://evil.invalid' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie, origin: f.config.APP_BASE_URL },
      })
    ).statusCode,
  ).toBe(200);
  expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  expect((await rows(sql`SELECT * FROM oauth_sessions`, f.store.db)).length).toBe(0);
});
it('AT-30 OAuth callback rejects a forged state', async () => {
  expect(
    (
      await app.inject({
        url: '/auth/discord/callback?code=fake&state=fake',
        headers: { cookie: 'oauth_browser=fake' },
      })
    ).statusCode,
  ).toBe(400);
});
it('AT-31 untrusted text remains data; export uses attachment and escapes markdown', async () => {
  const response = await app.inject({ url: `/api/meetings/${id}/snapshot`, headers: { cookie } });
  expect(response.json().segments[0].text).toContain('<script>');
  expect(response.headers['content-security-policy']).toContain("script-src 'self'");
  const exported = await app.inject({
    url: `/api/meetings/${id}/export?format=md`,
    headers: { cookie },
  });
  expect(exported.headers['content-disposition']).toContain('attachment;');
  expect(exported.body).toContain('\\<script\\>');
  expect(exported.body).toContain('부분 기록');
});
it('workspace membership guards even empty lists and me, while imported records keep original IDs', async () => {
  const source = '900000000000000777';
  await sql`UPDATE meetings SET guild_id=${source} WHERE id=${id}::uuid`.execute(f.store.db);
  const list = await app.inject({ url: '/api/meetings', headers: { cookie } });
  expect(list.json().meetings.map((m: any) => m.meeting_id)).toContain(id);
  expect(
    (await app.inject({ url: `/api/meetings/${id}/snapshot`, headers: { cookie } })).statusCode,
  ).toBe(200);
  await sql`DELETE FROM workspace_meetings WHERE meeting_id=${id}::uuid`.execute(f.store.db);
  expect(
    (await app.inject({ url: `/api/meetings/${id}/snapshot`, headers: { cookie } })).statusCode,
  ).toBe(404);
  const outsider =
    'session=' +
    (await new Auth(f.store, f.config).create(
      { id: '900000000000008888', username: 'outsider' },
      { access_token: 'mock', refresh_token: 'mock', expires_at: Date.now() + 3600000, mock: true },
    ));
  for (const url of [
    '/api/me',
    '/api/meetings',
    `/api/meetings/${id}/snapshot`,
    `/api/meetings/${id}/export?format=md`,
  ]) {
    expect((await app.inject({ url, headers: { cookie: outsider } })).statusCode).toBe(403);
  }
});
it('audio is scoped to the speaker, clipped to the utterance and unavailable after expiry', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pcmToFlac, writeEncrypted } = await import('@meeting/providers');
  const dir = await mkdtemp(join(tmpdir(), 'meeting-playback-'));
  try {
    await app.close();
    app = await buildServer({ ...f.config, RECORDING_STORAGE_PATH: dir }, f.store);
    const segment = (await f.store.allSegments(guild, id))[0]!;
    for (const [speaker, value] of [
      [user, 1000],
      ['900000000000000088', 9999],
    ] as const) {
      const chunk = randomUUID(),
        ref = id + '/' + chunk + '.flac.enc',
        pcm = Buffer.alloc(2000 * 32);
      for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
      const checksum = await writeEncrypted(
        dir,
        ref,
        await pcmToFlac(pcm),
        f.config.AUDIO_ENCRYPTION_KEY,
        chunk,
      );
      await sql`INSERT INTO audio_chunks(id,meeting_id,user_id,start_ms,end_ms,storage_ref,checksum) VALUES(${chunk},${id},${speaker},0,2000,${ref},${checksum})`.execute(
        f.store.db,
      );
    }
    const url = `/api/meetings/${id}/segments/${segment.segment_id}/audio`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const result = await app.inject({ url, headers: { cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload.length).toBe(32044);
    expect(result.rawPayload.readInt16LE(44)).toBe(1000);
    expect(result.headers['x-audio-missing-ms']).toBe('0');
    expect(
      (await app.inject({ url: url + '?transcript_version=999999', headers: { cookie } }))
        .statusCode,
    ).toBe(400);
    await sql`UPDATE audio_chunks SET expires_at=now()-interval '1 second' WHERE meeting_id=${id}::uuid`.execute(
      f.store.db,
    );
    expect((await app.inject({ url, headers: { cookie } })).json().error.code).toBe(
      'AUDIO_UNAVAILABLE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
