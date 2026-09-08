import { it, expect, vi } from 'vitest';
import { VoiceConnectionStatus } from '@discordjs/voice';
import type { Guild } from 'discord.js';
import { Capture } from '../../apps/bot/src/capture.ts';
import { fixture, guild } from './helpers.ts';

it('silent stop finalizes successfully and repeated teardown never destroys voice twice', async () => {
  const f = await fixture();
  try {
    const meeting = await f.begin();
    const capture = new Capture(f.store, f.config, meeting, { id: guild } as Guild, 'test');
    const connection = {
      state: { status: VoiceConnectionStatus.Ready as string },
      destroy: vi.fn(() => {
        if (connection.state.status === VoiceConnectionStatus.Destroyed)
          throw new Error('Cannot destroy VoiceConnection - it has already been destroyed');
        connection.state.status = VoiceConnectionStatus.Destroyed;
      }),
    };
    Object.assign(capture, { connection });
    await expect(capture.stop()).resolves.toBeUndefined();
    expect((await f.store.meeting(guild, meeting.id)).status).toBe('FINALIZING');
    expect(() => capture.abort()).not.toThrow();
    expect(() => capture.abort()).not.toThrow();
    await capture.stop();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  } finally {
    await f.dispose();
  }
});
