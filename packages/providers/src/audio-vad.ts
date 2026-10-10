export function speechRanges(pcm: Buffer) {
  const frameBytes = 640; // 20ms, mono 16kHz PCM16
  const raw: { start: number; end: number }[] = [];
  for (let from = 0; from < pcm.length; from += frameBytes) {
    const to = Math.min(pcm.length, from + frameBytes);
    let energy = 0;
    for (let i = from; i + 1 < to; i += 2) energy += pcm.readInt16LE(i) ** 2;
    if (Math.sqrt(energy / Math.max(1, (to - from) / 2)) < 100) continue;
    const start = Math.max(0, from / 32 - 300), end = Math.min(pcm.length / 32, to / 32 + 300);
    const previous = raw.at(-1);
    if (previous && start - previous.end <= 800) previous.end = end;
    else raw.push({ start, end });
  }
  return raw;
}
