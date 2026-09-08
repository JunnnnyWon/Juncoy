import { randomUUID } from 'node:crypto';
import {
  sql,
  first,
  rows,
  json,
  type Store,
  type Job,
  type Conn,
  type MeetingRow,
} from './index.ts';
import { DomainError, renderFactLedger, canonicalJson } from '@meeting/domain';
import type { SegmentDTO, ParticipantDTO } from '@meeting/contracts';
import type { LedgerStore, LedgerDescriptor, LedgerJournal } from '@meeting/providers';
interface Run {
  id: string;
  status: string;
  owner_job_id: string;
  owner_generation: number;
  transcript_version: number;
}
interface Stage {
  input_hash: string;
  status: string;
  attempts: number;
  output: unknown;
  model: string;
  terminal: boolean;
}
/** Every write rechecks both the job generation and the meeting deletion/version boundary. */
export function createSummaryLedger(store: Store, job: Job): LedgerStore {
  const guildId = String(job.payload.guild_id);
  return {
    async open(d: LedgerDescriptor): Promise<LedgerJournal> {
      const run = await store.withMeeting(guildId, d.meeting_id, async (tx, m) => {
        await store.assertJob(tx, job);
        if (m.view.transcript_version !== d.transcript_version)
          throw new DomainError('STALE_SUMMARY_INPUT');
        let existing = await first(
          sql<Run>`SELECT * FROM summary_runs WHERE run_key=${d.run_key} FOR UPDATE`,
          tx,
        );
        if (
          existing?.status === 'RUNNING' &&
          (existing.owner_job_id !== job.id || existing.owner_generation !== job.generation)
        ) {
          const active = await first(
            sql`SELECT 1 FROM jobs WHERE id=${existing.owner_job_id}::uuid AND generation=${existing.owner_generation} AND status='RUNNING' AND lease_until>now()`,
            tx,
          );
          if (active)
            throw new DomainError(
              'SUMMARY_RUN_BUSY',
              '회의록 검증이 이미 진행 중입니다.',
              503,
              true,
            );
        }
        if (!existing) {
          const id = randomUUID();
          await sql`INSERT INTO summary_runs(id,meeting_id,transcript_version,run_key,input_hash,model,prompt_hash,status,owner_job_id,owner_generation) VALUES(${id},${d.meeting_id},${d.transcript_version},${d.run_key},${d.input_hash},${d.model},${d.prompt_hash},'RUNNING',${job.id},${job.generation})`.execute(
            tx,
          );
          existing = {
            id,
            status: 'RUNNING',
            owner_job_id: job.id,
            owner_generation: job.generation,
            transcript_version: d.transcript_version,
          };
        } else
          await sql`UPDATE summary_runs SET owner_job_id=${job.id},owner_generation=${job.generation},updated_at=now() WHERE id=${existing.id}`.execute(
            tx,
          );
        return existing;
      });
      const guarded = async <T>(fn: (tx: Conn, m: MeetingRow) => Promise<T>, allowStale = false) =>
        store.withMeeting(guildId, d.meeting_id, async (tx, m) => {
          await store.assertJob(tx, job);
          const owner = await first(
            sql`SELECT id FROM summary_runs WHERE id=${run.id}::uuid AND owner_job_id=${job.id}::uuid AND owner_generation=${job.generation} FOR UPDATE`,
            tx,
          );
          if (!owner) throw new DomainError('STALE_SUMMARY_OWNER');
          if (!allowStale && m.view.transcript_version !== d.transcript_version)
            throw new DomainError('STALE_SUMMARY_INPUT');
          return fn(tx, m);
        });
      return {
        run_id: run.id,
        begin: (stage, inputHash) =>
          guarded(async (tx) => {
            const s = await first(
              sql<Stage>`SELECT * FROM summary_stages WHERE run_id=${run.id}::uuid AND stage_key=${stage} FOR UPDATE`,
              tx,
            );
            if (s && s.input_hash !== inputHash) throw new DomainError('STAGE_INPUT_CHANGED');
            if (s?.status === 'SUCCEEDED')
              return { attempt: s.attempts, cached: s.output, model: s.model };
            if (s?.terminal || (s?.attempts ?? 0) >= 3)
              throw new DomainError('STAGE_RETRIES_EXHAUSTED');
            const attempt = (s?.attempts ?? 0) + 1;
            await sql`INSERT INTO summary_stages(run_id,stage_key,input_hash,status,attempts) VALUES(${run.id},${stage},${inputHash},'RUNNING',${attempt}) ON CONFLICT(run_id,stage_key) DO UPDATE SET status='RUNNING',attempts=EXCLUDED.attempts,updated_at=now()`.execute(
              tx,
            );
            await sql`INSERT INTO summary_stage_attempts(run_id,stage_key,attempt,job_id,generation,status) VALUES(${run.id},${stage},${attempt},${job.id},${job.generation},'RUNNING')`.execute(
              tx,
            );
            return { attempt };
          }),
        success: (stage, inputHash, output, model) =>
          guarded(async (tx) => {
            await sql`UPDATE summary_stages SET status='SUCCEEDED',output=${json(output)},model=${model},updated_at=now() WHERE run_id=${run.id}::uuid AND stage_key=${stage} AND input_hash=${inputHash}`.execute(
              tx,
            );
            await sql`UPDATE summary_stage_attempts a SET status='SUCCEEDED',ended_at=now() FROM summary_stages s WHERE a.run_id=s.run_id AND a.stage_key=s.stage_key AND a.attempt=s.attempts AND s.run_id=${run.id}::uuid AND s.stage_key=${stage}`.execute(
              tx,
            );
          }),
        failure: (stage, code, terminal) =>
          guarded(async (tx) => {
            await sql`UPDATE summary_stages SET status='FAILED',error_code=${code},terminal=${terminal},updated_at=now() WHERE run_id=${run.id}::uuid AND stage_key=${stage}`.execute(
              tx,
            );
            await sql`UPDATE summary_stage_attempts a SET status='FAILED',error_code=${code},ended_at=now() FROM summary_stages s WHERE a.run_id=s.run_id AND a.stage_key=s.stage_key AND a.attempt=s.attempts AND s.run_id=${run.id}::uuid AND s.stage_key=${stage}`.execute(
              tx,
            );
          }),
        complete: (facts, report, result, outputHash, model) =>
          guarded(async (tx, m) => {
            if (!report.quality_passed || report.dispositions.length !== facts.length)
              throw new DomainError('SUMMARY_VERIFICATION_FAILED');
            const sources = (
              await rows(
                sql<{
                  body: SegmentDTO;
                }>`SELECT body FROM transcript_segments WHERE meeting_id=${m.id}::uuid AND canonical ORDER BY source_start_ms,user_id,segment_id`,
                tx,
              )
            ).map((x) => x.body);
            const participants = (
              await rows(
                sql<{
                  body: ParticipantDTO;
                }>`SELECT body FROM meeting_participants WHERE meeting_id=${m.id}::uuid`,
                tx,
              )
            ).map((x) => x.body);
            const expected = renderFactLedger(
              facts,
              report.dispositions,
              sources,
              d.transcript_version,
              { participants, startedAt: m.view.started_at },
            );
            if (
              canonicalJson({ ...expected.result, quality_notes: [] }) !==
              canonicalJson({ ...result, quality_notes: [] })
            )
              throw new DomainError('SUMMARY_NOT_FROM_LEDGER');
            for (const fact of facts) {
              const disposition = report.dispositions.find((x) => x.fact_id === fact.fact_id);
              if (!disposition) throw new DomainError('FACT_DISPOSITION_COVERAGE');
              await sql`INSERT INTO summary_facts(run_id,fact_id,body,disposition) VALUES(${run.id},${fact.fact_id},${json(fact)},${json(disposition)}) ON CONFLICT(run_id,fact_id) DO UPDATE SET body=EXCLUDED.body,disposition=EXCLUDED.disposition`.execute(
                tx,
              );
            }
            await sql`UPDATE summary_runs SET status='VERIFIED',observed_model=${model},output_hash=${outputHash},result=${json(result)},report=${json(report)},error_code=NULL,updated_at=now() WHERE id=${run.id}::uuid`.execute(
              tx,
            );
          }),
        reject: (code) =>
          guarded(async (tx, m) => {
            await sql`UPDATE summary_runs SET status='REJECTED',error_code=${code},updated_at=now() WHERE id=${run.id}::uuid AND status<>'VERIFIED'`.execute(
              tx,
            );
            if (code === 'STALE_SUMMARY_INPUT') {
              await store.stale(tx, m);
              await store.saveView(tx, m);
            }
          }, true),
      };
    },
  };
}
