import { fixture, guild, user } from '../tests/integration/helpers.ts';
import { buildServer } from '../apps/api/src/server.ts';
import { Auth } from '../apps/api/src/auth.ts';
import { sql, first } from '@meeting/db';
import { mkdir, writeFile } from 'node:fs/promises';
const f = await fixture();
const people = Array.from({ length: 12 }, (_, i) => ({
  user_id: (900000000000000010n + BigInt(i)).toString(),
  display_name: '부하 화자 ' + (i + 1),
  present: true,
  recording_eligible: true,
}));
const c = await f.store.getConfig(guild);
await f.store.setConfig(guild, { ...c, admin_user_ids: people.map((p) => p.user_id) }, user);
const m = await f.begin();
await f.store.setParticipants(guild, m.id, people);
const app = await buildServer(f.config, f.store);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const auth = new Auth(f.store, f.config),
  snapshot = await f.store.snapshot(guild, m.id);
const controllers: AbortController[] = [],
  cursors = Array(12).fill(snapshot.cursor),
  delays: number[] = [],
  commits = new Map<string, number>();
const started = Date.now();
let errorCount = 0;
const readers: Promise<void>[] = [];
try {
  for (let i = 0; i < 12; i++) {
    const p = people[i]!,
      cookie = await auth.create(
        { id: p.user_id, username: p.display_name },
        {
          access_token: 'mock',
          refresh_token: 'mock',
          expires_at: Date.now() + 3600000,
          mock: true,
        },
      ),
      controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${url}/api/meetings/${m.id}/events?after=${snapshot.cursor}`, {
      headers: { cookie: 'session=' + cookie },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Viewer did not connect');
    const reader = response.body!.getReader();
    readers.push(
      (async () => {
        let text = '';
        const decoder = new TextDecoder();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            text += decoder.decode(next.value, { stream: true });
            let at;
            while ((at = text.indexOf('\n\n')) >= 0) {
              const frame = text.slice(0, at);
              text = text.slice(at + 2);
              const data = frame.split('\n').find((l) => l.startsWith('data: '));
              if (!data) continue;
              const event = JSON.parse(data.slice(6));
              if (!event.event_seq) {
                errorCount++;
                continue;
              }
              if (BigInt(event.event_seq) !== BigInt(cursors[i]) + 1n) errorCount++;
              cursors[i] = event.event_seq;
              if (event.type === 'segment.upsert' && event.data.segment.is_final) {
                const commit = commits.get(event.data.segment.segment_id);
                if (commit !== undefined) delays.push(Date.now() - commit);
              }
            }
          }
        } catch {
          if (!controller.signal.aborted) errorCount++;
        }
      })(),
    );
  }
  const slots = 480;
  for (let slot = 0; slot < slots; slot++) {
    for (const final of [false, true])
      await Promise.all(
        people.map(async (p, i) => {
          const body = await f.store.upsertTranscript({
            guildId: guild,
            meetingId: m.id,
            userId: p.user_id,
            displayName: p.display_name,
            sourceKey: `load:${slot}:${i}`,
            start: slot * 30000,
            end: slot * 30000 + 5000,
            text: final
              ? `4시간분 재생 검증 ${slot} · 화자 ${i} 확정`
              : `4시간분 재생 검증 ${slot}`,
            final,
          });
          if (final && body) commits.set(body.segment_id, Date.now());
        }),
      );
  }
  const high = (await f.store.eventRange(m.id))!.last_seq;
  const deadline = Date.now() + 30000;
  while (cursors.some((c) => c !== high) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  const size = await first(
    sql<{ bytes: string }>`SELECT pg_total_relation_size('meeting_events') AS bytes`,
    f.store.db,
  );
  delays.sort((a, b) => a - b);
  const report = {
    mode: 'accelerated mock transcript replay; not a four-hour wall-clock voice soak',
    represented_hours: 4,
    utterances: slots * 12,
    viewers: 12,
    wall_seconds: (Date.now() - started) / 1000,
    all_cursors_match: cursors.every((c) => c === high),
    sequence_errors: errorCount,
    commit_to_sse_receive_p95_ms: delays[Math.floor(delays.length * 0.95)] ?? null,
    latency_samples: delays.length,
    event_relation_bytes: Number(size?.bytes),
    node_rss_bytes: process.memoryUsage().rss,
    provider_connections: 0,
    status: cursors.every((c) => c === high) && errorCount === 0 ? 'PASS' : 'FAILED',
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/load-report.json', JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  controllers.forEach((c) => c.abort());
  await Promise.allSettled(readers);
  await app.close();
  await f.dispose();
}
