import { it, expect } from 'vitest';
import { assemblePcm, wav } from '../../apps/api/src/segment-audio.ts';
const tone = (ms: number, value: number) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};
it('clips both boundaries, preserves missing time and avoids duplicate overlap', () => {
  const { pcm, missingMs } = assemblePcm(1000, 2000, [
    { start_ms: 900, pcm: tone(300, 111) },
    { start_ms: 1500, pcm: tone(700, 222) },
    { start_ms: 1500, pcm: tone(700, 333) },
  ]);
  expect(pcm.length).toBe(32000);
  expect(missingMs).toBe(300);
  expect(pcm.readInt16LE(0)).toBe(111);
  expect(pcm.readInt16LE(300 * 32)).toBe(0);
  expect(pcm.readInt16LE(600 * 32)).toBe(222);
  const file = wav(pcm);
  expect(file.toString('ascii', 0, 4)).toBe('RIFF');
  expect(file.readUInt32LE(40)).toBe(32000);
});
