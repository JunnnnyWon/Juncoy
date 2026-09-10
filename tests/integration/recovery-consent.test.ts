import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql, first } from '@meeting/db';
import { pcmToFlac, writeEncrypted } from '@meeting/providers';
import { fixture, guild, user } from './helpers.ts';
import { Jobs } from '../../apps/worker/src/jobs.ts';
import type { Outbox } from '../../apps/worker/src/outbox.ts';

it('withdrawal cancels pending/running automatic recovery and reconsent cannot revive a late result', async () => {
  const f = await fixture(),
    directory = await mkdtemp(join(tmpdir(), 'recovery-consent-'));
  try {
    const m = await f.begin(),
      audioId = randomUUID(),
      ref = m.id + '/chunk.flac.enc';
    const checksum = await writeEncrypted(
      directory,
      ref,
      await pcmToFlac(Buffer.alloc(32000)),
      f.config.AUDIO_ENCRYPTION_KEY,
      audioId,
    );
    await sql`INSERT INTO audio_chunks(id,meeting_id,user_id,start_ms,end_ms,storage_ref,checksum) VALUES(${audioId},${m.id},${user},0,1000,${ref},${checksum})`.execute(
      f.store.db,
    );
    const payload = { user_id: user, start_ms: 0, end_ms: 1000 };
    await f.store.enqueueRecovery(guild, m.id, 'recover:late', payload);
    await f.store.enqueueRecovery(guild, m.id, 'recover:pending', payload);
    const job = (await f.store.claimJob('test'))!;
    let release!: (v: any) => void, waiting!: () => void;
    const polled = new Promise<void>((r) => (waiting = r));
    const provider = {
      submitFile: vi.fn(async () => 'file-test'),
      fileStatus: vi.fn(async () => {
        waiting();
        return new Promise<any>((r) => (release = r));
      }),
    };
    const jobs = new Jobs(
      f.store,
      { ...f.config, RECORDING_STORAGE_PATH: directory },
      {} as Outbox,
      provider,
    );
    const response = jobs.retranscribe(job);
    await polled;
    await f.store.consent(guild, user, false);
    const cancelled = await first(
      sql<{ n: string }>`SELECT count(*)::text AS n FROM jobs WHERE status='CANCELLED'`,
      f.store.db,
    );
    expect(Number(cancelled!.n)).toBe(2);
    expect(await f.store.enqueueRecovery(guild, m.id, 'recover:withdrawn', payload)).toBe(false);
    await f.store.consent(guild, user, true);
    release({
      status: 'completed',
      utterances: [{ start_at: 0, duration: 900, msg: '늦은 응답' }],
    });
    await expect(response).rejects.toThrow(/CONSENT_WITHDRAWN|STALE_JOB/);
    expect(await f.store.allSegments(guild, m.id)).toEqual([]);
    await f.store.finishJob(job);
    expect(
      (await first(sql<any>`SELECT status FROM jobs WHERE id=${job.id}::uuid`, f.store.db)).status,
    ).toBe('CANCELLED');
    expect(provider.submitFile).toHaveBeenCalledTimes(1);
  } finally {
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('a recovered range is applied once, and deletion rejects a late replacement', async () => {
  const f = await fixture();
  try {
    const m = await f.begin();
    await f.store.enqueueRecovery(guild, m.id, 'recover:once', {
      user_id: user,
      start_ms: 0,
      end_ms: 1000,
    });
    const job = (await f.store.claimJob('test'))!;
    const segment = {
      segment_id: randomUUID(),
      user_id: user,
      display_name: '준',
      start_ms: 0,
      end_ms: 1000,
      text: '복구된 발언',
      is_final: true,
      revision: 1,
      corrected: false,
      quality_flags: ['FILE_RECOVERY'],
      overlap_group_id: null,
      updated_at: new Date().toISOString(),
    };
    const version = await f.store.replaceRange(guild, m.id, user, 0, 1000, [segment], job);
    expect(await f.store.replaceRange(guild, m.id, user, 0, 1000, [segment], job)).toBe(version);
    expect(await f.store.allSegments(guild, m.id)).toHaveLength(1);
    await f.store.deleteMeeting(guild, m.id, user);
    await expect(
      f.store.replaceRange(guild, m.id, user, 0, 1000, [segment], job),
    ).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});

it('empty automatic file recovery preserves speech and resolves the gap as no speech/noise', async () => {
  const f = await fixture(),
    directory = await mkdtemp(join(tmpdir(), 'recovery-empty-'));
  try {
    const m = await f.begin(),
      id = randomUUID(),
      ref = m.id + '/empty.flac.enc';
    const checksum = await writeEncrypted(
      directory,
      ref,
      await pcmToFlac(Buffer.alloc(32000)),
      f.config.AUDIO_ENCRYPTION_KEY,
      id,
    );
    await sql`INSERT INTO audio_chunks(id,meeting_id,user_id,start_ms,end_ms,storage_ref,checksum) VALUES(${id},${m.id},${user},0,1000,${ref},${checksum})`.execute(
      f.store.db,
    );
    await f.store.upsertTranscript({
      guildId: guild,
      meetingId: m.id,
      userId: user,
      displayName: '준',
      sourceKey: 'existing',
      start: 0,
      end: 1000,
      text: '이미 보존된 발언',
      final: true,
    });
    const gap = {
      gap_id: randomUUID(),
      user_id: user,
      start_ms: 0,
      end_ms: 1000,
      reason: 'STT_PENDING' as const,
      recoverable: true,
      resolved: false,
    };
    await f.store.gap(guild, m.id, gap);
    await f.store.enqueueRecovery(guild, m.id, 'recover:empty', {
      user_id: user,
      start_ms: 0,
      end_ms: 1000,
      gap_id: gap.gap_id,
    });
    const job = (await f.store.claimJob('test'))!;
    const jobs = new Jobs(
      f.store,
      { ...f.config, RECORDING_STORAGE_PATH: directory },
      {} as Outbox,
      {
        submitFile: async () => 'empty',
        fileStatus: async () => ({ status: 'completed', utterances: [] }),
      },
    );
    await jobs.retranscribe(job);
    expect((await f.store.allSegments(guild, m.id))[0]!.text).toBe('이미 보존된 발언');
    expect((await f.store.snapshot(guild, m.id)).gaps[0]).toMatchObject({
      resolved: true,
      resolution: 'NO_SPEECH_OR_NOISE',
    });
  } finally {
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('withdrawal covers every policy version so an older meeting cannot resume recording', async () => {
  const f = await fixture();
  try {
    const m = await f.begin(),
      config = await f.store.getConfig(guild);
    await f.store.setConfig(
      guild,
      { ...config, policy_version: config.policy_version + '-next' },
      user,
    );
    await f.store.consent(guild, user, true);
    await f.store.consent(guild, user, false);
    expect(
      Number(
        (await first(
          sql<{
            n: string;
          }>`SELECT count(*)::text AS n FROM user_consents WHERE guild_id=${guild} AND user_id=${user} AND withdrawn_at IS NULL`,
          f.store.db,
        ))!.n,
      ),
    ).toBe(0);
    expect(
      await f.store.enqueueRecovery(guild, m.id, 'recover:old-policy', {
        user_id: user,
        start_ms: 0,
        end_ms: 1000,
      }),
    ).toBe(false);
    expect(await f.store.captureAllowed(guild, m.id, user, m.fencing)).toBe(false);
  } finally {
    await f.dispose();
  }
});
