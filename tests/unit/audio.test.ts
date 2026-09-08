import { it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pcmToFlac, flacToPcm } from '@meeting/providers';
const require = createRequire(import.meta.url);
it('Opus worker returns mono 16kHz PCM and preserves the original capture gate and time', async () => {
  const Opus = require('opusscript');
  const encoder = new Opus(48000, 2, Opus.Application.AUDIO);
  const pcm = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) {
    const sample = Math.round(Math.sin((i * 2 * Math.PI * 440) / 48000) * 8000);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  const packet = encoder.encode(pcm, 960);
  const worker = new Worker(new URL('../../apps/bot/src/audio-worker.mjs', import.meta.url));
  try {
    const result = await new Promise<any>((resolve, reject) => {
      worker.on('message', (m) => {
        if (m.type === 'ready') worker.postMessage({ packet, capture_ms: 1000, gate: 3 });
        else resolve(m);
      });
      worker.on('error', reject);
    });
    expect(result.type).toBe('pcm');
    expect(result.pcm.length).toBe(640);
    expect(result.capture_ms).toBe(1000);
    expect(result.gate).toBe(3);
  } finally {
    await worker.terminate();
    encoder.delete();
  }
});
it('encrypted archive input format survives FLAC round-trip without length or sample drift', async () => {
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.02) * 10000), i * 2);
  const flac = await pcmToFlac(pcm);
  expect(flac.subarray(0, 4).toString()).toBe('fLaC');
  expect(await flacToPcm(flac)).toEqual(pcm);
});
