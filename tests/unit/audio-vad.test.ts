import { expect, it } from "vitest";
import { speechRanges } from "../../packages/providers/src/audio-vad.ts";
it("omits silence and pads speech without modifying source PCM", () => {
  const pcm = Buffer.alloc(32000 * 3);
  expect(speechRanges(pcm)).toEqual([]);
  for (let i = 32000; i < 38400; i += 2) pcm.writeInt16LE(1000, i);
  const before = Buffer.from(pcm);
  expect(speechRanges(pcm)).toEqual([{ start: 700, end: 1500 }]);
  expect(pcm.equals(before)).toBe(true);
});
