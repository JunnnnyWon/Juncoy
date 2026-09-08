import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql, json, rows, createSummaryLedger } from '@meeting/db';
import type { SummaryInput, LedgerStore } from '@meeting/providers';
import { fixture, guild } from '../../tests/integration/helpers.ts';
/** A real PostgreSQL journal in an isolated test schema; its outbox is never dispatched. */
export async function postgresEvaluation(
  input: SummaryInput,
  directory: string,
  telemetry: { cache_hits: number; stage_requests: number },
) {
  const f = await fixture();
  let timer: NodeJS.Timeout | undefined;
  try {
    const m = await f.begin();
    await f.store.setParticipants(guild, m.id, input.participants);
    await f.store.withMeeting(guild, m.id, async (tx, current) => {
      for (const s of input.segments) {
        await sql`INSERT INTO transcript_segments(segment_id,meeting_id,user_id,source_key,raw_text,body,source_start_ms,source_end_ms) VALUES(${s.segment_id},${m.id},${s.user_id},${'qa:' + s.segment_id},${s.text},${json(s)},${s.start_ms},${s.end_ms})`.execute(
          tx,
        );
        await sql`INSERT INTO segment_versions(segment_id,meeting_id,valid_from,raw_text,body) VALUES(${s.segment_id},${m.id},1,${s.text},${json(s)})`.execute(
          tx,
        );
      }
      current.view.transcript_version = 1;
      current.view.started_at = input.started_at;
      await f.store.saveView(tx, current);
    });
    await f.store.transition(guild, m.id, 'STOPPING');
    await f.store.transition(guild, m.id, 'FINALIZING');
    await sql`UPDATE jobs SET due_at=now()`.execute(f.store.db);
    const job = (await f.store.claimJob('qa-summary'))!;
    timer = setInterval(() => void f.store.renewJob(job).catch(() => {}), 20000);
    input.meeting_id = m.id;
    const base = createSummaryLedger(f.store, job);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const save = (name: string, data: unknown) =>
      writeFile(resolve(directory, name + '.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
    const store: LedgerStore = {
      async open(d) {
        const journal = await base.open(d);
        await save('run', { ...d, run_id: journal.run_id, journal: 'POSTGRESQL_ISOLATED' });
        return {
          ...journal,
          async begin(stage, hash) {
            const claim = await journal.begin(stage, hash);
            if (claim.cached !== undefined) telemetry.cache_hits++;
            else telemetry.stage_requests++;
            return claim;
          },
          async complete(facts, report, result, hash, model) {
            await journal.complete(facts, report, result, hash, model);
            await save('facts', facts);
            await save('report', report);
            await save('summary', result);
            await save('complete', { output_hash: hash, model });
          },
        };
      },
    };
    return {
      store,
      async dispose() {
        clearInterval(timer);
        await save(
          'postgres-stages',
          await rows(
            sql`SELECT s.stage_key,s.input_hash,s.status,s.attempts,s.output,s.model,s.error_code,s.terminal,s.updated_at FROM summary_stages s`,
            f.store.db,
          ),
        );
        await f.dispose();
      },
    };
  } catch (e) {
    clearInterval(timer);
    await f.dispose();
    throw e;
  }
}
