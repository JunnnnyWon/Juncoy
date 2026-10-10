import { afterEach, expect, it, vi } from 'vitest';
import { OpenRouterImages } from '../../packages/knowledge/src/image-openrouter.ts';
afterEach(() => vi.unstubAllGlobals());
it('sends exact ordered scoped inputs and negative instructions', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'cG5n' }], id: 'request-test', usage: { cost: 0.1 } })));
  vi.stubGlobal('fetch', fetcher);
  await new OpenRouterImages('test', 'openai/gpt-image-2.5-flare').generate('배경만', '인물 없음', [
    { bytes: Buffer.from('a'), mime: 'image/png', role: 'texture', instruction: 'STRONG_REFERENCE 재질만 참고' },
    { bytes: Buffer.from('b'), mime: 'image/png', role: 'lighting', instruction: 'MOOD_ONLY 조명만 참고' },
  ]);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.model).toBe('openai/gpt-image-2.5-flare');
  expect(body.prompt).toContain('인물 없음');
  expect(body.prompt).toContain('MOOD_ONLY');
  expect(body.input_references.map((r: any) => r.image_url.url)).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==']);
});
