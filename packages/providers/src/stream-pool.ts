import { ProviderError } from './returnzero.ts';
interface Waiter {
  key: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}
/** Reservations cover CONNECTING, OPEN and CLOSING, until the socket actually closes. */
export class StreamPool {
  private active = new Set<symbol>();
  private queue: Waiter[] = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid stream limit');
  }
  get activeCount() {
    return this.active.size;
  }
  get waitingCount() {
    return this.queue.length;
  }
  get waitingKeys() {
    return this.queue.map((w) => w.key);
  }
  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ProviderError('STREAM_QUEUE_CANCELLED', false));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, resolve, reject, signal };
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(new ProviderError('STREAM_QUEUE_CANCELLED', false));
        }
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }
  private drain() {
    while (this.active.size < this.limit && this.queue.length) {
      const next = this.queue.shift()!;
      next.signal?.removeEventListener('abort', next.abort!);
      if (next.signal?.aborted) {
        next.reject(new ProviderError('STREAM_QUEUE_CANCELLED', false));
        continue;
      }
      const token = Symbol(next.key);
      this.active.add(token);
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(token);
        this.drain();
      });
    }
  }
}
