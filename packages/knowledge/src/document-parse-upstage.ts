import { createHash } from 'node:crypto';

export interface DocumentParseResult {
  text: string;
  html?: string;
  markdown?: string;
  parserVersion: string;
  sourceSha256: string;
  requestId?: string;
  warnings: string[];
}

export interface DocumentParseOptions {
  apiKey: string;
  endpoint: string;
  timeoutMs?: number;
  outputFormat?: 'html' | 'markdown';
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

export class UpstageDocumentParse {
  constructor(private options: DocumentParseOptions) {}

  async parsePdf(bytes: Buffer, expectedSha256?: string): Promise<DocumentParseResult> {
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 && sourceSha256 !== expectedSha256)
      throw new Error('document_parse_source_hash_mismatch');
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(bytes) as unknown as BlobPart]), 'source.pdf');
    form.append('output_formats', this.options.outputFormat ?? 'html');
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
    const body = (await response.json()) as Record<string, unknown>;
    const html = typeof body.html === 'string' ? body.html : undefined;
    const markdown = typeof body.markdown === 'string' ? body.markdown : undefined;
    const rawText = typeof body.text === 'string' ? body.text : undefined;
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
    };
  }
}
