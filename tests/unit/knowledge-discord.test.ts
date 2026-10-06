import { describe, expect, it, vi } from 'vitest';
import { DiscordRest, messageHash, type DiscordMessage } from '@meeting/knowledge';

const res = (body: any, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const msg = (over: Partial<DiscordMessage>): DiscordMessage => ({
  id: '1',
  channel_id: 'c',
  timestamp: '2026-10-06T00:00:00Z',
  edited_timestamp: null,
  ...over,
});

describe('DiscordRest', () => {
  it('sends before/after only one at a time as snowflake strings', async () => {
    const spy = vi.fn(async () => res([]));
    const rest = new DiscordRest('t', spy as any);
    await rest.messages('ch1', { before: '1234567890123456789', limit: 50 });
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.searchParams.get('before')).toBe('1234567890123456789');
    expect(url.searchParams.get('after')).toBeNull();
    await rest.messages('ch1', { after: '999' });
    const url2 = new URL(spy.mock.calls[1][0] as string);
    expect(url2.searchParams.get('after')).toBe('999');
    expect(url2.searchParams.get('before')).toBeNull();
  });

  it('retries on 429 honoring retry-after, then returns', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(res({ retry_after: 0.01 }, 429, { 'retry-after': '0.01' }))
      .mockResolvedValueOnce(res([{ id: 'm1' }]));
    const rest = new DiscordRest('t', spy as any);
    const r = await rest.messages('ch', {});
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(200);
    expect(r.body[0].id).toBe('m1');
  });

  it('does not retry 403 (access lost is surfaced, not hidden)', async () => {
    const spy = vi.fn(async () => res({ message: 'Missing Access' }, 403));
    const rest = new DiscordRest('t', spy as any);
    const r = await rest.messages('ch', {});
    expect(r.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('messageHash', () => {
  it('changes on edit and attachment set change, stable otherwise', () => {
    const a = msg({ content: 'hello' });
    const edited = msg({ content: 'hello', edited_timestamp: '2026-10-06T01:00:00Z' });
    const attached = msg({ content: 'hello', attachments: [{ id: 'a1' } as any] });
    expect(messageHash(a)).not.toBe(messageHash(edited));
    expect(messageHash(a)).not.toBe(messageHash(attached));
    expect(messageHash(a)).toBe(messageHash({ ...a }));
    // attachment 순서는 해시에 영향 없음
    const ab = msg({
      attachments: [{ id: 'a1' } as any, { id: 'a2' } as any],
    });
    const ba = msg({
      attachments: [{ id: 'a2' } as any, { id: 'a1' } as any],
    });
    expect(messageHash(ab)).toBe(messageHash(ba));
  });
});
