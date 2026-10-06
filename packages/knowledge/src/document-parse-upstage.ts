import { createHash } from 'node:crypto';

export interface DocumentParseResult {
  text: string;
  html?: string;
  markdown?: string;
  parserVersion: string;
  sourceSha256: string;
  requestId?: string;
  warnings: string[];
  blocks: {
    block_id: string;
    page: number | null;
    ordinal: number;
    block_type: string;
    text: string;
    html?: string;
    metadata: Record<string, unknown>;
  }[];
  pages: { page: number; text: string; block_ids: string[] }[];
}

export interface DocumentParseOptions {
  apiKey: string;
  endpoint: string;
  timeoutMs?: number;
  outputFormat?: 'html' | 'markdown';
  coordinates?: boolean;
  maxResponseBytes?: number;
}

function textFromHtml(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

async function readResponseWithinLimit(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel('response_too_large');
    throw new Error('upstage_document_parse_response_too_large');
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response_too_large');
        throw new Error('upstage_document_parse_response_too_large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export class UpstageDocumentParse {
  constructor(private options: DocumentParseOptions) {}

  async parsePdf(bytes: Buffer, expectedSha256?: string): Promise<DocumentParseResult> {
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 && sourceSha256 !== expectedSha256)
      throw new Error('document_parse_source_hash_mismatch');
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(bytes) as unknown as BlobPart]), 'source.pdf');
    form.append('model', 'document-parse');
    form.append('output_formats', JSON.stringify([this.options.outputFormat ?? 'html']));
    form.append('coordinates', String(this.options.coordinates ?? true));
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.options.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
    if (!response.ok)
      throw Object.assign(new Error('upstage_document_parse_' + response.status), {
        status: response.status,
      });
    const raw = await readResponseWithinLimit(
      response,
      this.options.maxResponseBytes ?? 25 * 1024 * 1024,
    );
    const body = JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
    const content = body.content;
    const contentObject = content && typeof content === 'object' ? (content as Record<string, unknown>) : undefined;
    const html = typeof body.html === 'string' ? body.html : typeof contentObject?.html === 'string' ? contentObject.html : undefined;
    const markdown = typeof body.markdown === 'string' ? body.markdown : typeof contentObject?.markdown === 'string' ? contentObject.markdown : undefined;
    const rawText = typeof body.text === 'string' ? body.text : typeof contentObject?.text === 'string' ? contentObject.text : typeof content === 'string' ? content : undefined;
    const text = rawText ?? markdown ?? (html ? textFromHtml(html) : '');
    if (!text.trim()) throw new Error('upstage_document_parse_empty_result');
    return {
      text,
      html,
      markdown,
      parserVersion: typeof body.model === 'string' ? body.model : 'document-parse',
      sourceSha256,
      requestId: response.headers.get('x-request-id') ?? undefined,
      warnings: [],
      blocks: (Array.isArray(body.elements) ? body.elements : Array.isArray(body.blocks) ? body.blocks : []).map((block: any, index: number) => ({
            block_id: String(block.block_id ?? block.id ?? 'block-' + index),
            page: typeof block.page === 'number' ? block.page : typeof block.page_number === 'number' ? block.page_number : null,
            ordinal: Number(block.ordinal ?? index),
            block_type: String(block.block_type ?? block.category ?? block.type ?? 'unknown'),
            text: String(block.text ?? (typeof block.content === 'string' ? block.content : block.content?.text ?? '')),
            html: typeof block.html === 'string' ? block.html : undefined,
            metadata: {
              ...(block.metadata && typeof block.metadata === 'object' ? block.metadata : {}),
              ...(block.coordinates ? { bbox: block.coordinates } : {}),
            },
          })),
      pages: Array.isArray(body.pages)
        ? body.pages.map((page: any, index: number) => ({
            page: Number(page.page ?? index + 1),
            text: String(page.text ?? ''),
            block_ids: Array.isArray(page.block_ids) ? page.block_ids.map(String) : [],
          }))
        : (() => {
            const grouped = new Map<number, { text: string; block_ids: string[] }>();
            for (const block of (Array.isArray(body.elements) ? body.elements : Array.isArray(body.blocks) ? body.blocks : []) as any[]) {
              const page = Number(block.page ?? block.page_number ?? 1);
              const id = String(block.block_id ?? block.id ?? '');
              const value = grouped.get(page) ?? { text: '', block_ids: [] };
              const text = String(block.text ?? (typeof block.content === 'string' ? block.content : block.content?.text ?? ''));
              value.text = [value.text, text].filter(Boolean).join('\n');
              if (id) value.block_ids.push(id);
              grouped.set(page, value);
            }
            return [...grouped.entries()].map(([page, value]) => ({ page, ...value }));
          })(),
    };
  }
}
