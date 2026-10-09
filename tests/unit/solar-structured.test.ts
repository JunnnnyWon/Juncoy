import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { solarModel } from '../../apps/api/src/knowledge.ts';
import type { AppConfig } from '@meeting/providers';
afterEach(() => vi.unstubAllGlobals());
it('retries invalid structured output with contract feedback', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'too long' }) } }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'ok' }) } }] })));
  vi.stubGlobal('fetch', fetcher);
  const out = await solarModel({ UPSTAGE_API_KEY: 'test', UPSTAGE_MODEL: 'solar-pro4-260806' } as AppConfig)
    .structured(z.object({ title: z.string().max(3) }), {}, 'short title');
  expect(out.result.title).toBe('ok');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[0].content).toContain('title');
});
it('fails after bounded correction rather than accepting invalid data', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"too long"}' } }] })));
  vi.stubGlobal('fetch', fetcher);
  await expect(solarModel({ UPSTAGE_API_KEY: 'test' } as AppConfig).structured(z.object({ title: z.string().max(3) }), {}, 'short')).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', statusCode: 502 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('recovers malformed JSON with a larger completion budget', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"unfinished' } }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"title":"ok"}' } }] })));
  vi.stubGlobal('fetch', fetcher);
  const out = await solarModel({ UPSTAGE_API_KEY: 'test' } as AppConfig).structured(z.object({ title: z.string() }), {}, 'title');
  expect(out.result.title).toBe('ok');
  expect(JSON.parse(fetcher.mock.calls[1][1].body).max_tokens).toBeGreaterThan(JSON.parse(fetcher.mock.calls[0][1].body).max_tokens);
});
it('rejects truncated responses even when their partial JSON parses', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"title":"ok"}' } }] })));
  vi.stubGlobal('fetch', fetcher);
  await expect(solarModel({ UPSTAGE_API_KEY: 'test' } as AppConfig).structured(z.object({ title: z.string() }), {}, 'title')).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
