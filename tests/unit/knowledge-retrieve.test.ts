import { describe, expect, it } from 'vitest';
import { rrfMerge } from '@meeting/knowledge';
import { UpstageEmbeddings } from '@meeting/knowledge';

describe('rrfMerge', () => {
  const item = (id: string) => ({ id });
  it('combines lists with reciprocal-rank scores', () => {
    const out = rrfMerge([
      [item('a'), item('b'), item('c')],
      [item('b'), item('a')],
    ]);
    // a: 1/61+1/62, b: 1/62+1/61 → 동점 (삽입 순 a 먼저)
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62, 5);
    expect(out[0].ranks).toEqual([1, 2]);
    expect(out[1].ranks).toEqual([2, 1]);
    expect(out[2].ranks).toEqual([3, null]);
  });
  it('rank-1-only beats shared mid ranks', () => {
    const out = rrfMerge([
      [item('x'), item('a'), item('b')],
      [item('a'), item('b')],
    ]);
    // a: 1/62+1/61 > b: 1/63+1/62 > x: 1/61
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'x']);
  });
  it('items present in only one list keep a null rank for the other', () => {
    const out = rrfMerge([[item('x')], [item('y')]]);
    expect(out[0].ranks).toEqual([1, null]);
    expect(out[1].ranks).toEqual([null, 1]);
  });
});

describe('UpstageEmbeddings', () => {
  it('posts model+input and returns vectors', async () => {
    const calls: any[] = [];
    const client = new UpstageEmbeddings('key', 'q', 'd', async (_u: any, o: any) => {
      calls.push(JSON.parse(o.body));
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 });
    });
    expect(await client.embedQuery('hi')).toEqual([1, 2, 3]);
    expect(calls[0]).toEqual({ model: 'q', input: 'hi' });
    expect(await client.embedDocuments(['a', 'b'])).toEqual([[1, 2, 3]]);
    expect(calls[1]).toEqual({ model: 'd', input: ['a', 'b'] });
  });
  it('throws with response body on upstream error', async () => {
    const client = new UpstageEmbeddings('k', 'q', 'd', async () =>
      new Response(JSON.stringify({ error: 'bad' }), { status: 400 }),
    );
    await expect(client.embedQuery('x')).rejects.toThrow('400');
  });
});
