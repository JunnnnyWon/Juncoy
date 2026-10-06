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
  const fetchUrl = (spy: { mock: { calls: any[] } }, i: number) =>
    new URL(String(spy.mock.calls[i][0]));

  it('sends before/after only one at a time as snowflake strings', async () => {
    const spy = vi.fn(async (_u: any, _o?: any) => res([]));
    const rest = new DiscordRest('t', spy as any);
    await rest.messages('ch1', { before: '1234567890123456789', limit: 50 });
    const url = fetchUrl(spy, 0);
    expect(url.searchParams.get('before')).toBe('1234567890123456789');
    expect(url.searchParams.get('after')).toBeNull();
    await rest.messages('ch1', { after: '999' });
    const url2 = fetchUrl(spy, 1);
    expect(url2.searchParams.get('after')).toBe('999');
    expect(url2.searchParams.get('before')).toBeNull();
  });

  it('retries on 429 honoring retry-after, then returns', async () => {
    const spy = vi
      .fn(async (_u: any, _o?: any) => res([]))
      .mockResolvedValueOnce(res({ retry_after: 0.01 }, 429, { 'retry-after': '0.01' }))
      .mockResolvedValueOnce(res([{ id: 'm1' }]));
    const rest = new DiscordRest('t', spy as any);
    const r = await rest.messages('ch', {});
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(200);
    expect(r.body[0].id).toBe('m1');
  });

  it('does not retry 403 (access lost is surfaced, not hidden)', async () => {
    const spy = vi.fn(async (_u: any, _o?: any) => res({ message: 'Missing Access' }, 403));
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

// ── RAG-009/010/011: 백필 완료 조건 + gateway seq/직렬화 ─────────────
import { DiscordCollector, DiscordGateway } from '@meeting/knowledge';

const fakeStore = () => ({ db: {} }) as any;

describe('DiscordCollector.backfillChannel (RAG-009)', () => {
  const makeCollector = (pages: any[][]) => {
    const calls: Record<string, string>[] = [];
    const rest = {
      messages: vi.fn(async (_ch: string, o: any) => {
        calls.push({ ...o });
        return { status: 200, body: pages.shift() ?? [] };
      }),
    };
    const c = new DiscordCollector(fakeStore(), rest as any, 'g1');
    const ingested: string[] = [];
    const saved: any[] = [];
    (c as any).getCursor = vi.fn(async () => ({}));
    (c as any).saveCursor = vi.fn(async (_s: string, _ch: string, cur: any) => {
      saved.push(cur);
    });
    (c as any).ingestMessage = vi.fn(async (_s: string, _ch: string, m: any) => {
      ingested.push(m.id);
      return { stored: true, changed: true };
    });
    return { c, rest, ingested, saved, calls };
  };

  it('첫 수집에서 head 메시지 자체를 수집한다', async () => {
    const { c, ingested } = makeCollector([
      [{ id: '50' }], // head
      [{ id: '49' }, { id: '48' }], // <100 → reachedStart
    ]);
    const r = await c.backfillChannel('src', 'ch', { limit: 500 });
    expect(ingested[0]).toBe('50'); // head가 빠지면 안 됨
    expect(r.done).toBe(true);
  });

  it('slice 한도로 멈춘 것은 done이 아니다 — 재개 가능', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ({ id: String(100 - i) }));
    const { c, saved, ingested } = makeCollector([
      [{ id: '200' }], // head
      hundred, // 정확히 100 → reachedStart 아님
    ]);
    const r = await c.backfillChannel('src', 'ch', { limit: 100 });
    expect(r.done).toBe(false);
    expect(ingested).toHaveLength(101);
    expect(saved.at(-1).backfill_done).toBe(false);
  });

  it('빈 페이지 = 채널 시작 도달 → done', async () => {
    const { c, saved } = makeCollector([[{ id: '9' }], []]);
    const r = await c.backfillChannel('src', 'ch', {});
    expect(r.done).toBe(true);
    expect(saved.at(-1).backfill_done).toBe(true);
  });

  it('403/404 → access_lost 마킹, done 아님', async () => {
    const { c, saved } = makeCollector([]);
    (c as any).rest = undefined;
    // rest를 직접 교체
    const rest = { messages: vi.fn(async () => ({ status: 403, body: {} })) };
    (c as any).rest = rest;
    const r = await c.backfillChannel('src', 'ch', {});
    expect(r.done).toBe(false);
    expect(saved.at(-1).access_lost).toBe(true);
  });
});

describe('DiscordGateway seq/직렬화 (RAG-011)', () => {
  const make = () => {
    const dispatched: string[] = [];
    const resyncs: string[] = [];
    let delay = 0;
    const gw = new DiscordGateway('t', 0, {
      onDispatch: async (t: string, d: any) => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (d?.fail) throw new Error('boom');
        dispatched.push(`${t}:${d?.n}`);
      },
      onResyncNeeded: async (r: string) => {
        resyncs.push(r);
      },
    });
    return { gw, dispatched, resyncs, setDelay: (ms: number) => (delay = ms) };
  };

  it('seq는 내구 처리된 디스패치에 대해서만 올라간다', async () => {
    const { gw, resyncs } = make();
    const onPacket = (gw as any).onPacket.bind(gw);
    // s=5 디스패치 실패 → seq는 5로 올라가지 않는다
    await onPacket(JSON.stringify({ op: 0, t: 'M', s: 5, d: { fail: true, n: 1 } }));
    await (gw as any).dispatchChain.catch(() => {});
    expect((gw as any).seq).toBeNull();
    expect(resyncs.some((r) => r.startsWith('dispatch_error'))).toBe(true);
    // s=7 성공 → seq=null 상태라 gap 감지 안 하고 7로 올라감
    await onPacket(JSON.stringify({ op: 0, t: 'M', s: 7, d: { n: 2 } }));
    await (gw as any).dispatchChain.catch(() => {});
    expect((gw as any).seq).toBe(7);
    // s=9 → gap (기대 8)
    await onPacket(JSON.stringify({ op: 0, t: 'M', s: 9, d: { n: 3 } }));
    expect(resyncs.some((r) => r.includes('seq gap 7→9'))).toBe(true);
  });

  it('디스패치는 제출 순서대로 직렬 처리된다', async () => {
    const { gw, dispatched, setDelay } = make();
    const onPacket = (gw as any).onPacket.bind(gw);
    setDelay(5);
    const p1 = onPacket(JSON.stringify({ op: 0, t: 'A', s: 1, d: { n: 1 } }));
    const p2 = onPacket(JSON.stringify({ op: 0, t: 'B', s: 2, d: { n: 2 } }));
    const p3 = onPacket(JSON.stringify({ op: 0, t: 'C', s: 3, d: { n: 3 } }));
    await Promise.all([p1, p2, p3]);
    await (gw as any).dispatchChain;
    expect(dispatched).toEqual(['A:1', 'B:2', 'C:3']);
    expect((gw as any).seq).toBe(3);
  });

  it('역행 seq도 resync를 유발한다', async () => {
    const { gw, resyncs } = make();
    const onPacket = (gw as any).onPacket.bind(gw);
    await onPacket(JSON.stringify({ op: 0, t: 'M', s: 10, d: { n: 1 } }));
    await (gw as any).dispatchChain; // seq=10이 올라간 뒤여야 갭 비교가 성립
    await onPacket(JSON.stringify({ op: 0, t: 'M', s: 5, d: { n: 2 } }));
    expect(resyncs.some((r) => r.includes('10→5'))).toBe(true);
  });
});

// ── RAG-019: 출처별 후보 쿼터 ────────────────────────────────────
import { perSourceQuota } from '@meeting/knowledge';

describe('perSourceQuota (RAG-019)', () => {
  const items = (kind: string, n: number, start = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `${kind}${start + i}`, source: kind }));

  it('한 출처가 결과를 독점하지 못한다', () => {
    // github 20개가 전부 상위면 notion/meeting 결과가 잘린다
    const merged = [...items('github', 30), ...items('notion', 2), ...items('meeting', 2)];
    const out = perSourceQuota(merged, (m) => m.source, 12);
    const byKind = (k: string) => out.filter((x) => x.source === k).length;
    expect(byKind('github')).toBeLessThanOrEqual(12);
    expect(byKind('notion')).toBe(2); // 최소 커버리지 보장
    expect(byKind('meeting')).toBe(2);
    expect(out).toHaveLength(12);
  });

  it('limit보다 후보가 적으면 전부 돌아온다', () => {
    const merged = items('discord', 5);
    expect(perSourceQuota(merged, (m) => m.source, 40)).toHaveLength(5);
  });

  it('출처가 하나뿐이면 그 출처로 채운다', () => {
    const merged = items('github', 50);
    expect(perSourceQuota(merged, (m) => m.source, 10)).toHaveLength(10);
  });
});
