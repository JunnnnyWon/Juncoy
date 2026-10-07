import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenRouterImages,
  OpenRouterVision,
  UpstageDocumentParse,
  extractUpload,
} from '@meeting/knowledge';

describe('document and image provider adapters', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('Document Parse preserves the source hash and normalizes HTML text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: '<h1>제목</h1><p>본문</p>', elements: [{ id: 'el-1', page: 1, category: 'heading', text: '제목' }, { id: 'el-2', page: 1, category: 'paragraph', text: '본문' }], model: 'parse-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      }),
    );
    const source = Buffer.from('%PDF-test');
    const result = await new UpstageDocumentParse({
      apiKey: 'secret',
      endpoint: 'https://parse.test',
    }).parsePdf(source);
    expect(result.text).toContain('제목');
    expect(result.text).toContain('본문');
    expect(result.parserVersion).toBe('parse-test');
    expect(result.requestId).toBe('req-1');
    expect(result.blocks).toHaveLength(2);
    expect(result.pages).toEqual([{ page: 1, text: '제목\n본문', block_ids: ['el-1', 'el-2'] }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret',
    });
  });

  it('Gemini 3.7 Flash vision payload contains the original image bytes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ description: 'wall', materials: ['paint'] }) },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const source = Buffer.from([1, 2, 3, 4]);
    const result = await new OpenRouterVision('secret').analyzeImage(source, 'image/png');
    const request = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(request.model).toBe('google/gemini-3.7-flash');
    expect(request.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AQIDBA==');
    expect(result.source_sha256).toHaveLength(64);
    expect(result.materials).toEqual(['paint']);
  });

  it('OpenRouter image payload includes input references and role instructions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: 'generated' }] }), { status: 200 }),
      );
    const result = await new OpenRouterImages('secret', 'openai/gpt-image-2.5-flare').generate(
      'character concept',
      undefined,
      [
        {
          bytes: Buffer.from([9, 8, 7]),
          mime: 'image/png',
          role: 'face_shape',
          instruction: '얼굴 비율만 참고',
        },
      ],
    );
    const request = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(request.model).toBe('openai/gpt-image-2.5-flare');
    expect(request.input_references[0].image_url.url).toBe('data:image/png;base64,CQgH');
    expect(request.prompt).toContain('face_shape: 얼굴 비율만 참고');
    expect(result.b64).toBe('generated');
  });

  it('upload extraction falls back to local PDF parsing when Parse fails', async () => {
    const parser = new UpstageDocumentParse({ apiKey: 'secret', endpoint: 'https://parse.test' });
    vi.spyOn(parser, 'parsePdf').mockRejectedValue(new Error('provider_timeout'));
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );
    const result = await extractUpload(pdf, 'application/pdf', {
      documentParse: parser,
    });
    expect(result.parserKind).toBe('local_pdfjs');
    expect(result.parseStatus).toBe('FALLBACK');
    expect(result.parseLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.parseError).toBe('provider_timeout');
  });

  it('normalizes nested HTML into blocks and pages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: { html: '<p>cell</p>', text: '', markdown: '' },
      elements: [{ id: 'nested', page: 2, content: { html: '<h2>title</h2><p>cell</p>', text: '', markdown: '' } }],
    }), { status: 200 }));
    const result = await new UpstageDocumentParse({ apiKey: 'secret', endpoint: 'https://parse.test' }).parsePdf(Buffer.from('%PDF-test'));
    expect(result.blocks[0].text).toContain('title');
    expect(result.blocks[0].html).toContain('<h2>');
    expect(result.pages[0].text).toContain('cell');
    expect(result.pages[0].block_ids).toEqual(['nested']);
  });

  it('rejects an oversized Document Parse response before normalization', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: 'too large' }), { status: 200 }),
    );
    await expect(
      new UpstageDocumentParse({ apiKey: 'secret', endpoint: 'https://parse.test', maxResponseBytes: 4 }).parsePdf(Buffer.from('%PDF-test')),
    ).rejects.toThrow('upstage_document_parse_response_too_large');
  });

  it('cancels a streaming Document Parse response when the limit is crossed', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(
      new UpstageDocumentParse({ apiKey: 'secret', endpoint: 'https://parse.test', maxResponseBytes: 4 }).parsePdf(Buffer.from('%PDF-test')),
    ).rejects.toThrow('upstage_document_parse_response_too_large');
    expect(cancel).toHaveBeenCalled();
  });
});
