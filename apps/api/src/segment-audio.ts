import { readEncrypted, flacToPcm, type AppConfig } from '@meeting/providers';
import { DomainError } from '@meeting/domain';

export type AudioChunk = { id: string; storage_ref: string; start_ms: number; end_ms: number };
export function assemblePcm(
  start: number,
  end: number,
  pieces: { start_ms: number; pcm: Buffer }[],
) {
  const sampleCount = Math.ceil((end - start) * 16);
  const pcm = Buffer.alloc(sampleCount * 2),
    covered = new Uint8Array(sampleCount);
  for (const piece of pieces) {
    const base = Math.round((piece.start_ms - start) * 16);
    for (
      let source = Math.max(0, -base);
      source < piece.pcm.length / 2 && base + source < sampleCount;
      source++
    ) {
      const target = base + source;
      if (covered[target]) continue;
      pcm.writeInt16LE(piece.pcm.readInt16LE(source * 2), target * 2);
      covered[target] = 1;
    }
  }
  const missingMs = covered.reduce((sum, n) => sum + (n ? 0 : 1), 0) / 16;
  return { pcm, missingMs };
}
export function wav(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export async function segmentAudio(
  config: AppConfig,
  chunks: AudioChunk[],
  start: number,
  end: number,
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 300000 ||
    chunks.length > 512
  )
    throw new DomainError('INVALID_AUDIO_RANGE', '이 발언의 재생 범위를 처리할 수 없습니다.', 422);
  if (!chunks.length)
    throw new DomainError('AUDIO_UNAVAILABLE', '원음이 만료됐거나 아직 저장되지 않았습니다.', 404);
  const pieces = [];
  for (const chunk of chunks) {
    try {
      pieces.push({
        start_ms: chunk.start_ms,
        pcm: await flacToPcm(
          await readEncrypted(
            config.RECORDING_STORAGE_PATH,
            chunk.storage_ref,
            config.AUDIO_ENCRYPTION_KEY,
            chunk.id,
          ),
        ),
      });
    } catch (e) {
      if ((e as any).code === 'ENOENT') continue;
      throw new DomainError(
        'AUDIO_READ_FAILED',
        '원음을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.',
        503,
        true,
      );
    }
  }
  if (!pieces.length)
    throw new DomainError('AUDIO_UNAVAILABLE', '재생 가능한 원음이 남아 있지 않습니다.', 404);
  const result = assemblePcm(start, end, pieces);
  return { data: wav(result.pcm), missingMs: result.missingMs };
}
