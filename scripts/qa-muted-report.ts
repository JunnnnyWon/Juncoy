import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store, sql, rows } from '@meeting/db';
import { Id } from '@meeting/contracts';
import { loadConfig } from '@meeting/providers';

const ids = process.argv.slice(2).map((id) => Id.parse(id));
if (!ids.length) throw new Error('Provide the actual QA meeting IDs.');
const config = loadConfig(),
  store = new Store(config.DATABASE_URL);
const directory = resolve('.data/qa/discord-muted-20260907');
try {
  const meetings = [];
  for (const id of ids) {
    const snapshot = await store.snapshot(config.DISCORD_GUILD_ID, id);
    meetings.push({
      meeting: snapshot.meeting,
      cursor: snapshot.cursor,
      markers: snapshot.markers,
      gaps: snapshot.gaps,
      audit: await rows(
        sql`SELECT kind,data,created_at FROM audit_events WHERE meeting_id=${id}::uuid ORDER BY created_at`,
        store.db,
      ),
      counts: await rows(
        sql`SELECT (SELECT count(*) FROM audio_chunks WHERE meeting_id=${id}::uuid) AS audio_chunks, (SELECT count(*) FROM stt_streams WHERE meeting_id=${id}::uuid) AS stt_streams, (SELECT count(*) FROM transcript_segments WHERE meeting_id=${id}::uuid) AS transcript_segments, (SELECT count(*) FROM usage_records WHERE meeting_id=${id}::uuid) AS provider_usage_records`,
        store.db,
      ),
      outbox: await rows(
        sql`SELECT kind,status,message_id FROM outbox WHERE entity_id=${id}::uuid ORDER BY created_at`,
        store.db,
      ),
      consents: await rows(
        sql`SELECT user_id,policy_version,withdrawn_at FROM user_consents WHERE guild_id=${config.DISCORD_GUILD_ID} AND user_id IN (SELECT user_id FROM meeting_participants WHERE meeting_id=${id}::uuid)`,
        store.db,
      ),
    });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(directory, 'runtime.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: 'ACTUAL_DISCORD_MUTED',
        speech_receive: 'NOT_TESTED_USER_REQUESTED_MUTE',
        meetings,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      meetings: meetings.map((m) => ({
        id: m.meeting.meeting_id,
        status: m.meeting.status,
        counts: m.counts,
      })),
      report: '.data/qa/discord-muted-20260907/runtime.json',
    }) + '\n',
  );
} finally {
  await store.close();
}
