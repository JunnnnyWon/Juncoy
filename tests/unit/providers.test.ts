import { it, expect } from 'vitest';
import { MockSpeechStream, MockReturnZero } from '@meeting/providers';
it('AT-14 mock contract can exercise 429 and mid-stream disconnect without calling real providers', async () => {
  await expect(new MockSpeechStream({ failOpen: 429 }).open()).rejects.toMatchObject({
    httpStatus: 429,
    retryable: true,
  });
  const stream = new MockSpeechStream({ failAfterMs: 100 });
  let failed = false;
  stream.on('failure', () => {
    failed = true;
  });
  await stream.open();
  stream.send(Buffer.alloc(3200));
  expect(failed).toBe(true);
  expect(stream.sentMs).toBe(100);
});
it('mock partial and final share a provider sequence and file polling is explicit', async () => {
  const stream = new MockSpeechStream();
  const messages: any[] = [];
  stream.on('transcript', (m) => messages.push(m));
  await stream.open();
  stream.inject('중간');
  stream.inject('확정', true);
  expect(messages.map((m) => m.seq)).toEqual(['0', '0']);
  const provider = new MockReturnZero(),
    id = await provider.submitFile(Buffer.alloc(0));
  provider.setFileResult(id, [{ start_at: 0, duration: 1000, msg: '예시 발언' }]);
  expect((await provider.fileStatus(id)).utterances[0]!.msg).toBe('예시 발언');
});
import { StreamPool } from '@meeting/providers';
it('10 reservations include closing sockets; queued speakers start immediately in FIFO order', async () => {
  const pool = new StreamPool(10),
    releases = await Promise.all(Array.from({ length: 10 }, (_, i) => pool.acquire(String(i))));
  const order: string[] = [];
  const eleventh = pool.acquire('11').then((release) => {
    order.push('11');
    return release;
  });
  const twelfth = pool.acquire('12').then((release) => {
    order.push('12');
    return release;
  });
  expect(pool.activeCount).toBe(10);
  expect(pool.waitingCount).toBe(2);
  await Promise.resolve();
  expect(order).toEqual([]);
  releases[3]!();
  const release11 = await eleventh;
  expect(order).toEqual(['11']);
  expect(pool.activeCount).toBe(10);
  releases[4]!();
  const release12 = await twelfth;
  expect(order).toEqual(['11', '12']);
  expect(pool.activeCount).toBe(10);
  release11();
  release12();
  releases.forEach((r) => r());
  expect(pool.activeCount).toBe(0);
});
it('withdrawn queue entries do not consume a later slot', async () => {
  const pool = new StreamPool(1),
    release = await pool.acquire('first'),
    controller = new AbortController();
  const cancelled = pool.acquire('withdrawn', controller.signal);
  const handled = expect(cancelled).rejects.toMatchObject({ code: 'STREAM_QUEUE_CANCELLED' });
  controller.abort();
  await handled;
  const next = pool.acquire('next');
  release();
  const done = await next;
  expect(pool.activeCount).toBe(1);
  expect(pool.waitingCount).toBe(0);
  done();
  done();
  expect(pool.activeCount).toBe(0);
});

import { vi } from 'vitest';
import { ReturnZero, type AppConfig } from '@meeting/providers';
it('cancelling during authentication never opens a late WebSocket and releases once', async () => {
  const provider = new ReturnZero({} as AppConfig);
  let resolve!: (s: string) => void;
  vi.spyOn(provider, 'authenticate').mockImplementation(
    () => new Promise<string>((r) => (resolve = r)),
  );
  const stream = provider.stream([]),
    closed = vi.fn();
  stream.on('closed', closed);
  const opening = stream.open();
  stream.abort();
  resolve('test-token-never-used');
  await expect(opening).rejects.toMatchObject({ code: 'RTZR_CANCELLED' });
  await stream.end();
  stream.abort();
  expect(closed).toHaveBeenCalledTimes(1);
  expect(stream.sentMs).toBe(0);
});
