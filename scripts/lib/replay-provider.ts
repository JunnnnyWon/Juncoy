import { EventEmitter } from 'node:events';
import { ProviderError, type SpeechStream, type SttMessage } from '@meeting/providers';

export class ReplayMockSpeech extends EventEmitter implements SpeechStream {
  sentMs = 0;
  private connected = false;
  private ended = false;
  private seq = 0;
  private speechStart: number | null = null;
  private speechEnd = 0;
  private partialAt = -Infinity;
  constructor(
    readonly userId: string,
    readonly serial: number,
    private options: {
      openDelayMs?: number;
      closeDelayMs?: number;
      failOpen?: number;
      failAtMs?: number;
    } = {},
  ) {
    super();
  }
  async open() {
    await new Promise((r) => setTimeout(r, this.options.openDelayMs ?? 25));
    if (this.ended) throw new ProviderError('REPLAY_CANCELLED', false);
    if (this.options.failOpen)
      throw new ProviderError('REPLAY_HTTP_' + this.options.failOpen, true, this.options.failOpen);
    this.connected = true;
  }
  send(pcm: Buffer) {
    if (!this.connected || this.ended) throw new ProviderError('REPLAY_NOT_CONNECTED', true);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    const speech = Math.sqrt(sum / (pcm.length / 2)) > 120;
    const before = this.sentMs;
    this.sentMs += pcm.length / 32;
    if (this.options.failAtMs && this.sentMs >= this.options.failAtMs) {
      this.options.failAtMs = undefined;
      this.emit('failure', new ProviderError('REPLAY_DISCONNECTED', true));
      this.abort();
      return;
    }
    if (speech) {
      this.speechStart ??= before;
      this.speechEnd = this.sentMs;
      if (this.sentMs - this.partialAt >= 500) {
        this.partialAt = this.sentMs;
        this.publish(false);
      }
    } else if (this.speechStart !== null && this.sentMs - this.speechEnd >= 800) this.finalize();
  }
  private publish(final: boolean) {
    if (this.speechStart === null) return;
    this.emit('transcript', {
      seq: String(this.seq),
      start_at: this.speechStart,
      duration: this.speechEnd - this.speechStart,
      final,
      text: `MOCK 화자 ${this.userId} · 연결 ${this.serial} · 발언 ${this.seq}`,
    } satisfies SttMessage);
  }
  finalize() {
    if (this.speechStart === null) return;
    this.publish(true);
    this.seq++;
    this.speechStart = null;
  }
  async end() {
    if (this.ended) return;
    this.ended = true;
    this.finalize();
    await new Promise((r) => setTimeout(r, this.options.closeDelayMs ?? 50));
    this.connected = false;
    this.emit('closed');
  }
  abort() {
    if (this.ended) return;
    this.ended = true;
    this.connected = false;
    setTimeout(() => this.emit('closed'), this.options.closeDelayMs ?? 50);
  }
}
export function sineFrame(index: number) {
  const b = Buffer.alloc(3200),
    frequency = 230 + index * 37;
  for (let i = 0; i < 1600; i++)
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / 16000) * 1800), i * 2);
  return b;
}
