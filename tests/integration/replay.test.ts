import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Guild } from 'discord.js';
import { sql, first } from '@meeting/db';
import { Capture } from '../../apps/bot/src/capture.ts';
import { ReplayMockSpeech, sineFrame } from '../../scripts/lib/replay-provider.ts';
import { fixture, guild, user } from './helpers.ts';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
it('withdrawal drains pending archive work and rejects late streaming callbacks and new PCM', async () => {
  const f = await fixture(),
    directory = await mkdtemp(join(tmpdir(), 'capture-revoke-'));
  let release!: () => void, began!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    reached = new Promise<void>((r) => (began = r));
  const stream = new ReplayMockSpeech(user, 0);
  let capture: Capture | undefined;
  try {
    const m = await f.begin();
    capture = new Capture(
      f.store,
      { ...f.config, RECORDING_STORAGE_PATH: directory },
      m,
      { id: guild } as Guild,
      'test',
      {
        stream: () => stream,
        beforeArchive: async () => {
          began();
          await blocked;
        },
      },
    );
    await capture.startReplay((await f.store.snapshot(guild, m.id)).participants);
    capture.ingestReplay(user, Buffer.alloc(960000));
    await reached;
    let ack = false;
    const withdrawing = capture.revoke(user).then(() => {
      ack = true;
    });
    await delay(50);
    expect(ack).toBe(false);
    release();
    await withdrawing;
    await f.store.consent(guild, user, false);
    const before = capture.metrics().users[0]!;
    for (let i = 0; i < 20; i++) capture.ingestReplay(user, sineFrame(0));
    stream.emit('transcript', {
      seq: '999',
      start_at: 0,
      duration: 1000,
      final: true,
      text: '늦은 응답',
    });
    await delay(200);
    await capture.settled();
    const after = capture.metrics().users[0]!;
    expect(after.sent_pcm_bytes).toBe(before.sent_pcm_bytes);
    expect(after.archived_pcm_bytes).toBe(before.archived_pcm_bytes);
    expect(after.blocked_pcm_bytes).toBeGreaterThan(before.blocked_pcm_bytes);
    expect(
      Number(
        (await first(sql<{ n: string }>`SELECT count(*)::text AS n FROM audio_chunks`, f.store.db))!
          .n,
      ),
    ).toBe(0);
    expect(await f.store.allSegments(guild, m.id)).toEqual([]);
  } finally {
    release?.();
    capture?.abort();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
it('pause stops writes and sends; resuming opens a new stream with the same user identity', async () => {
  const f = await fixture(),
    directory = await mkdtemp(join(tmpdir(), 'capture-pause-'));
  let capture: Capture | undefined;
  const streams: ReplayMockSpeech[] = [];
  try {
    const m = await f.begin(),
      people = (await f.store.snapshot(guild, m.id)).participants;
    capture = new Capture(
      f.store,
      { ...f.config, RECORDING_STORAGE_PATH: directory },
      m,
      { id: guild } as Guild,
      'test',
      {
        stream: (id) => {
          const s = new ReplayMockSpeech(id, streams.length);
          streams.push(s);
          return s;
        },
      },
    );
    await capture.startReplay(people);
    for (let i = 0; i < 12; i++) {
      capture.ingestReplay(user, sineFrame(0));
      await delay(100);
    }
    await capture.pause();
    const before = capture.metrics().users[0]!;
    for (let i = 0; i < 10; i++) {
      capture.ingestReplay(user, sineFrame(0));
      await delay(50);
    }
    expect(capture.metrics().users[0]!.sent_pcm_bytes).toBe(before.sent_pcm_bytes);
    expect(capture.metrics().users[0]!.archived_pcm_bytes).toBe(before.archived_pcm_bytes);
    await capture.resume(people);
    for (let i = 0; i < 10; i++) {
      capture.ingestReplay(user, sineFrame(0));
      await delay(100);
    }
    for (let i = 0; i < 15; i++) {
      capture.ingestReplay(user, Buffer.alloc(3200));
      await delay(100);
    }
    await capture.stop();
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect((await f.store.allSegments(guild, m.id)).every((s) => s.user_id === user)).toBe(true);
    expect(capture.metrics().peak_reservations).toBeLessThanOrEqual(10);
  } finally {
    capture?.abort();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('normal stop accepts the final for already captured speech while withdrawal still fences it', async () => {
  const f = await fixture(),
    directory = await mkdtemp(join(tmpdir(), 'capture-final-'));
  let capture: Capture | undefined;
  try {
    const m = await f.begin();
    capture = new Capture(
      f.store,
      { ...f.config, RECORDING_STORAGE_PATH: directory },
      m,
      { id: guild } as Guild,
      'test',
      { stream: (id) => new ReplayMockSpeech(id, 0) },
    );
    await capture.startReplay((await f.store.snapshot(guild, m.id)).participants);
    for (let i = 0; i < 8; i++) {
      capture.ingestReplay(user, sineFrame(0));
      await delay(100);
    }
    await capture.stop();
    expect(await f.store.allSegments(guild, m.id)).toHaveLength(1);
  } finally {
    capture?.abort();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
