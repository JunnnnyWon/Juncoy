import { cleanQaRuns } from '../../../scripts/lib/qa-retention.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, stat, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Store, sql, rows, first, json, createSummaryLedger, type Job } from '@meeting/db';
import {
  MockSolar,
  Solar,
  ReturnZero,
  PROMPT_HASH,
  readEncrypted,
  flacToPcm,
  pcmToFlac,
  safeAudioPath,
  emptySummary,
  type AppConfig,
} from '@meeting/providers';
import { displayText, mapSourceTime, DomainError } from '@meeting/domain';
import type { SegmentDTO, GapDTO } from '@meeting/contracts';
import type { Outbox } from './outbox.ts';
export class Jobs {
  private solar: Solar;
  private rtzr: ReturnZero;
  constructor(
    private store: Store,
    private config: AppConfig,
    private outbox: Outbox,
    private testFileProvider?: Pick<ReturnZero, 'submitFile' | 'fileStatus'>,
  ) {
    if (testFileProvider && config.NODE_ENV !== 'test') throw new Error('TEST_ADAPTER_NOT_ALLOWED');
    this.solar = new Solar(config);
    this.rtzr = new ReturnZero(config);
  }
  async run(job: Job) {
    if (job.kind === 'DELETE') return this.delete(job);
    if (job.kind === 'RETRANSCRIBE') return this.retranscribe(job);
    if (job.kind === 'FINALIZE') return this.finalize(job);
    if (job.kind === 'RETENTION') return this.retention();
    throw new DomainError('UNKNOWN_JOB');
  }
  async finalize(job: Job) {
    const guildId = job.payload.guild_id as string,
      id = job.meeting_id!,
      m = await this.store.meeting(guildId, id);
    if (!['FINALIZING', 'COMPLETED', 'PARTIAL', 'FAILED'].includes(m.status))
      throw new DomainError('NOT_FINALIZABLE');
    const UNRECOVERABLE_SETTLE_MS = 10 * 60_000;
    const endedAtMs = Date.parse(m.view.ended_at ?? '');
    // Unrecoverable gaps only auto-close once late audio flushes had time to land.
    const canSettle = Number.isFinite(endedAtMs) && Date.now() - endedAtMs >= UNRECOVERABLE_SETTLE_MS;
    await this.store.recoverPendingAudio(
      guildId,
      id,
      Math.max(
        0,
        (Number.isFinite(endedAtMs) ? endedAtMs : Date.now()) -
          Date.parse(m.view.started_at ?? new Date().toISOString()),
      ),
      canSettle,
    );
    const pending = await first(
      sql<{
        n: string;
      }>`SELECT count(*) AS n FROM jobs WHERE meeting_id=${id}::uuid AND kind='RETRANSCRIBE' AND status IN ('PENDING','RUNNING')`,
      this.store.db,
    );
    if (
      Number(pending?.n) > 0 &&
      Date.now() - Date.parse(m.view.ended_at ?? new Date().toISOString()) < 120000
    ) {
      await sql`UPDATE jobs SET status='PENDING',due_at=now()+interval '5 seconds',attempts=attempts-1 WHERE id=${job.id}::uuid AND generation=${job.generation}`.execute(
        this.store.db,
      );
      return;
    }
    const version = m.view.transcript_version,
      segments = await this.store.allSegments(guildId, id, version),
      snapshot = await this.store.snapshot(guildId, id);
    const unresolvedGaps = snapshot.gaps.some((g) => !g.resolved && g.reason !== 'PAUSED');
    // The summary keeps flagging lost coverage even after unrecoverable gaps auto-close.
    const partial =
      unresolvedGaps ||
      snapshot.gaps.some((g) => g.resolution === 'UNRECOVERABLE') ||
      Number(pending?.n) > 0;
    const awaiting = unresolvedGaps || Number(pending?.n) > 0;
    if (
      !canSettle &&
      Number.isFinite(endedAtMs) &&
      snapshot.gaps.some((g) => !g.resolved && g.reason !== 'PAUSED' && !g.recoverable)
    )
      await this.store.enqueue(
        this.store.db,
        `finalize-sweep:${id}:${version}`,
        'FINALIZE',
        id,
        { guild_id: guildId },
        new Date(endedAtMs + UNRECOVERABLE_SETTLE_MS),
      );
    job.summary_input_version = version;
    if (this.config.PROVIDER_MODE === 'real' && this.config.SUMMARY_AUTOPUBLISH_ENABLED === 'false')
      throw new DomainError('SUMMARY_PUBLICATION_DISABLED');
    await this.store.withMeeting(guildId, id, async (tx, current) => {
      await this.store.assertJob(tx, job);
      if (current.view.transcript_version !== version) throw new DomainError('STALE_SUMMARY_INPUT');
      current.view.summary_status = 'RUNNING';
      await this.store.saveView(tx, current);
      await this.store.event(tx, current, 'summary.updated', {
        status: 'RUNNING',
        summary_version: current.view.summary_version,
        transcript_version: current.view.transcript_version,
      });
    });
    let result, model;
    let proof: { runId: string; outputHash: string } | undefined;
    if (this.config.PROVIDER_MODE === 'mock') {
      ({ result, model } = await new MockSolar().summarize({
        meeting_id: id,
        started_at: m.view.started_at!,
        segments,
        participants: snapshot.participants,
        metadata: { title: m.view.title },
        glossary: m.settings.glossary,
        markers: snapshot.markers,
        gaps: snapshot.gaps,
      }));
    } else {
      ({ result, model, proof } = await this.solar.summarize(
        {
          meeting_id: id,
          started_at: m.view.started_at!,
          segments,
          participants: snapshot.participants,
          metadata: { title: m.view.title, transcript_version: version, partial },
          glossary: m.settings.glossary,
          markers: snapshot.markers,
          gaps: snapshot.gaps,
        },
        `${job.id}:${job.attempts}`,
        (u) =>
          this.store.usage(
            guildId,
            id,
            u.key,
            'upstage',
            ((u.input_tokens * 0.15 + u.output_tokens * 0.6) / 1e6) * m.settings.usd_krw,
            { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
          ),
        {},
        { store: createSummaryLedger(this.store, job) },
      ));
    }
    if (partial && this.config.PROVIDER_MODE === 'mock')
      result.quality_notes.push('수집 누락 또는 복구 대기 구간이 포함된 부분 회의록입니다.');
    await this.store.adoptSummary(
      guildId,
      id,
      version,
      result,
      model,
      PROMPT_HASH,
      partial,
      job,
      proof,
      awaiting,
    );
  }
  async retranscribe(job: Job) {
    const id = job.meeting_id!,
      guildId = String(job.payload.guild_id),
      m = await this.store.meeting(guildId, id),
      userId = String(job.payload.user_id),
      start = Number(job.payload.start_ms),
      end = Number(job.payload.end_ms);
    const audio = await rows(
      sql<{
        id: string;
        start_ms: number;
        end_ms: number;
        storage_ref: string;
      }>`SELECT id,start_ms,end_ms,storage_ref FROM audio_chunks WHERE meeting_id=${id}::uuid AND user_id=${userId} AND start_ms<${end} AND end_ms>${start} ORDER BY start_ms`,
      this.store.db,
    );
    if (!audio.length) throw new DomainError('AUDIO_NOT_AVAILABLE');
    const groups: (typeof audio)[] = [];
    let batch: typeof audio = [];
    let batchDuration = 0;
    for (const chunk of audio) {
      if (batch.length && batchDuration + chunk.end_ms - chunk.start_ms > 300000) {
        groups.push(batch);
        batch = [];
        batchDuration = 0;
      }
      batch.push(chunk);
      batchDuration += chunk.end_ms - chunk.start_ms;
    }
    if (batch.length) groups.push(batch);
    if (groups.length > 1) {
      await this.store.db.transaction().execute(async (tx) => {
        await this.store.assertRecoveryConsent(tx, job);
        await this.store.assertJob(tx, job);
        for (const group of groups)
          await this.store.enqueue(tx, `${job.key}:${group[0]!.start_ms}`, 'RETRANSCRIBE', id, {
            ...job.payload,
            start_ms: group[0]!.start_ms,
            end_ms: group[group.length - 1]!.end_ms,
          });
      });
      return;
    }
    const buffers: Buffer[] = [],
      pieces: { file_start_ms: number; file_end_ms: number; source_start_ms: number }[] = [];
    let offset = 0;
    for (const chunk of audio) {
      const flac = await readEncrypted(
        this.config.RECORDING_STORAGE_PATH,
        chunk.storage_ref,
        this.config.AUDIO_ENCRYPTION_KEY,
        chunk.id,
      );
      const pcm = await flacToPcm(flac);
      buffers.push(pcm);
      pieces.push({
        file_start_ms: offset,
        file_end_ms: offset + pcm.length / 32,
        source_start_ms: chunk.start_ms,
      });
      offset += pcm.length / 32;
    }
    if (this.config.PROVIDER_MODE === 'mock' && !this.testFileProvider)
      throw new DomainError('MOCK_AUDIO_NOT_TRANSCRIBED');
    const provider = this.testFileProvider ?? this.rtzr;
    let providerId = job.provider_job_id;
    if (!providerId) {
      await this.store.assertJob(this.store.db, job);
      await this.store.meeting(guildId, id);
      const encoded = await pcmToFlac(Buffer.concat(buffers));
      // Consent lock serializes the upload with withdrawal acknowledgement.
      providerId = await this.store.db.transaction().execute(async (tx) => {
        await this.store.assertRecoveryConsent(tx, job);
        await this.store.assertJob(tx, job);
        await this.store.meeting(guildId, id, tx);
        return provider.submitFile(encoded, job.payload.glossary ?? m.settings.glossary);
      });
      await sql`UPDATE jobs SET provider_job_id=${providerId} WHERE id=${job.id}::uuid AND generation=${job.generation} AND status='RUNNING'`.execute(
        this.store.db,
      );
      await this.store.usage(
        guildId,
        id,
        'file:' + job.key,
        'returnzero',
        (Math.max(10000, offset) / 3600000) * 1000,
        { audio_ms: Math.round(offset), is_mock: Boolean(this.testFileProvider) },
      );
    }
    await this.store.assertJob(this.store.db, job);
    await this.store.assertRecoveryConsent(this.store.db, job);
    const result = await provider.fileStatus(providerId);
    if (result.status !== 'completed') {
      await sql`UPDATE jobs SET status='PENDING',due_at=now()+interval '10 seconds',attempts=attempts-1 WHERE id=${job.id}::uuid AND generation=${job.generation}`.execute(
        this.store.db,
      );
      return;
    }
    if (
      (job.payload.capture_recovery || /^(recover:|recovered-gap:)/.test(job.key)) &&
      !result.utterances.some((u) => u.msg.trim())
    ) {
      await this.store.completeEmptyRecovery(job);
      return;
    }
    const glossary = job.payload.glossary ?? m.settings.glossary;
    const participant = (await this.store.snapshot(guildId, id)).participants.find(
      (p) => p.user_id === userId,
    );
    const replacements: SegmentDTO[] = result.utterances
      .filter((u) => u.msg.trim())
      .map((u) => ({
        segment_id: randomUUID(),
        user_id: userId,
        display_name: participant?.display_name ?? userId,
        start_ms: Math.round(mapSourceTime(u.start_at, pieces)),
        end_ms: Math.round(mapSourceTime(Math.min(offset, u.start_at + u.duration), pieces, 'end')),
        text: displayText(u.msg, glossary),
        is_final: true,
        revision: 1,
        corrected: false,
        quality_flags: ['FILE_RECOVERY'],
        overlap_group_id: null,
        updated_at: new Date().toISOString(),
      }));
    await this.store.replaceRange(
      guildId,
      id,
      userId,
      audio[0]!.start_ms,
      audio[audio.length - 1]!.end_ms,
      replacements,
      job,
      Object.fromEntries(
        replacements.map((s, i) => [
          s.segment_id,
          result.utterances.filter((u) => u.msg.trim())[i]!.msg,
        ]),
      ),
    );
    const gap = (await this.store.snapshot(guildId, id)).gaps.find(
      (g) => g.gap_id === job.payload.gap_id,
    );
    if (gap) await this.store.gap(guildId, id, { ...gap, resolved: true });
  }
  async delete(job: Job) {
    const id = job.meeting_id!,
      guildId = String(job.payload.guild_id);
    if (
      !(await first(
        sql`SELECT 1 FROM deletion_tombstones WHERE meeting_id=${id}::uuid`,
        this.store.db,
      ))
    )
      throw new DomainError('DELETION_NOT_AUTHORIZED');
    const ledger = resolve(this.config.RECORDING_STORAGE_PATH, '../deletion-ledger.jsonl');
    await mkdir(dirname(ledger), { recursive: true, mode: 0o700 });
    await appendFile(
      ledger,
      JSON.stringify({ meeting_id: id, guild_id: guildId, deleted_at: new Date().toISOString() }) +
        '\n',
      { mode: 0o600 },
    );
    await this.outbox.removeMessages(id);
    await rm(safeAudioPath(this.config.RECORDING_STORAGE_PATH, id), {
      recursive: true,
      force: true,
    });
    await this.store.db.transaction().execute(async (tx) => {
      await sql`DELETE FROM outbox WHERE entity_id=${id}::uuid`.execute(tx);
      await sql`DELETE FROM meetings WHERE id=${id}::uuid`.execute(tx);
      await sql`UPDATE deletion_tombstones SET cleaned_at=now() WHERE meeting_id=${id}::uuid`.execute(
        tx,
      );
    });
  }
  async retention() {
    if (this.config.NODE_ENV === 'production')
      await cleanQaRuns(resolve(this.config.RECORDING_STORAGE_PATH, '../qa'));
    const expired = await rows(
      sql<{
        id: string;
        guild_id: string;
      }>`SELECT id,guild_id FROM meetings WHERE deleted_at IS NULL AND view->>'ended_at' IS NOT NULL AND (view->>'ended_at')::timestamptz<now()-interval '180 days'`,
      this.store.db,
    );
    for (const m of expired) await this.store.deleteMeeting(m.guild_id, m.id, 'retention');
    const files = await rows(
      sql<{
        id: string;
        storage_ref: string;
      }>`SELECT id,storage_ref FROM audio_chunks WHERE expires_at<now()`,
      this.store.db,
    );
    for (const file of files) {
      await rm(safeAudioPath(this.config.RECORDING_STORAGE_PATH, file.storage_ref), {
        force: true,
      });
      await sql`DELETE FROM audio_chunks WHERE id=${file.id}::uuid`.execute(this.store.db);
    }
    const meetings = await rows(
      sql<{
        id: string;
        guild_id: string;
      }>`SELECT DISTINCT m.id,m.guild_id FROM meetings m JOIN meeting_events e ON e.meeting_id=m.id WHERE e.created_at<now()-interval '24 hours' AND m.deleted_at IS NULL`,
      this.store.db,
    );
    for (const m of meetings)
      await this.store.withMeeting(m.guild_id, m.id, async (tx) => {
        await sql`WITH removed AS (DELETE FROM meeting_events WHERE meeting_id=${m.id}::uuid AND created_at<now()-interval '24 hours' RETURNING event_seq) UPDATE meeting_event_counters SET floor_seq=greatest(floor_seq,coalesce((SELECT max(event_seq) FROM removed),0)) WHERE meeting_id=${m.id}::uuid`.execute(
          tx,
        );
      });
    await sql`DELETE FROM oauth_sessions WHERE expires_at<now()`.execute(this.store.db);
    await sql`DELETE FROM oauth_states WHERE expires_at<now()`.execute(this.store.db);
    await sql`DELETE FROM processed_interactions WHERE created_at<now()-interval '180 days'`.execute(
      this.store.db,
    );
    const drafts = await rows(
      sql<{
        meeting_id: string;
        guild_id: string;
      }>`SELECT DISTINCT d.meeting_id,m.guild_id FROM transcript_drafts d JOIN meetings m ON m.id=d.meeting_id WHERE d.updated_at<now()-interval '24 hours' AND m.deleted_at IS NULL`,
      this.store.db,
    );
    for (const d of drafts) await this.store.clearDrafts(d.guild_id, d.meeting_id);
  }
}
