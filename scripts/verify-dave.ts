import { Store, sql, rows, first } from '@meeting/db';
import { loadConfig } from '@meeting/providers';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const config = loadConfig({ ...process.env, PROVIDER_MODE: 'real' }),
  store = new Store(config.DATABASE_URL);
const index = process.argv.indexOf('--meeting');
const requested = index >= 0 ? process.argv[index + 1] : null;
const expectedPath = process.argv[process.argv.indexOf('--expected') + 1];
try {
  const meeting = requested
    ? await store.meeting(config.DISCORD_GUILD_ID, requested)
    : await first(
        sql<{
          id: string;
        }>`SELECT id FROM meetings WHERE guild_id=${config.DISCORD_GUILD_ID} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        store.db,
      );
  const result: Record<string, unknown> = {
    at: new Date().toISOString(),
    voice_version: '0.19.2',
    mode: 'real',
    status: 'BLOCKED_EXTERNAL',
  };
  if (!meeting)
    result.reason =
      'No real consented meeting has been recorded. Run /회의 동의 and /회의 시작 with actual users.';
  else {
    const ready = await rows(
      sql<{
        data: any;
      }>`SELECT data FROM audit_events WHERE meeting_id=${meeting.id}::uuid AND kind='VOICE_READY'`,
      store.db,
    );
    const stats = await rows(
      sql<{
        data: any;
      }>`SELECT data FROM audit_events WHERE meeting_id=${meeting.id}::uuid AND kind='VOICE_CAPTURE_STATS'`,
      store.db,
    );
    const audio = await rows(
      sql<{
        user_id: string;
        chunks: string;
        ms: string;
      }>`SELECT user_id,count(*) AS chunks,sum(end_ms-start_ms) AS ms FROM audio_chunks WHERE meeting_id=${meeting.id}::uuid GROUP BY user_id`,
      store.db,
    );
    const segments = await store.allSegments(config.DISCORD_GUILD_ID, meeting.id);
    Object.assign(result, {
      meeting_id: meeting.id,
      dave_protocols: ready.map((r) => r.data.dave_protocol),
      capture_stats: stats.map((r) => r.data),
      audio_users: audio.map((a) => ({
        user_id: a.user_id,
        chunks: Number(a.chunks),
        audio_ms: Number(a.ms),
      })),
      final_utterances: segments.length,
    });
    const basic =
      ready.some((r) => r.data.dave_protocol > 0) && audio.length >= 2 && segments.length > 0;
    result.two_user_receive = basic ? 'PASS' : 'BLOCKED_EXTERNAL';
    result.twelve_user_receive =
      audio.length >= 12 && ready.some((r) => r.data.dave_protocol > 0)
        ? 'OBSERVED_REQUIRES_MAPPING_REVIEW'
        : 'BLOCKED_EXTERNAL';
    if (process.argv.includes('--expected') && expectedPath) {
      const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as {
        user_id: string;
        phrase: string;
      }[];
      const mapping = expected.map((e) => ({
        user_id: e.user_id,
        own_track_found: segments.some((s) => s.user_id === e.user_id && s.text.includes(e.phrase)),
        other_track_found: segments.some(
          (s) => s.user_id !== e.user_id && s.text.includes(e.phrase),
        ),
      }));
      result.scripted_mapping = mapping;
      result.status =
        basic &&
        expected.length >= 12 &&
        mapping.every((m) => m.own_track_found && !m.other_track_found)
          ? 'PASS'
          : 'FAILED';
    } else
      result.reason =
        'Twelve-user overlapping speech, reconnect and DAVE transition protocol still requires the controlled human test described in docs/verification-report.md.';
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/dave-verification.json', JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await store.close();
}
