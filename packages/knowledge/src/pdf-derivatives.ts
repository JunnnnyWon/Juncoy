import { createCanvas, DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
import sharp from 'sharp';
import { UploadStorage, sha256 } from './uploads.ts';

export interface PdfDerivative {
  key: string; page: number; block_id?: string; kind: 'page_preview' | 'figure';
  mime: 'image/png'; bytes: number; sha256: string; source_sha256: string;
  bbox?: [number, number, number, number]; origin: 'local_pdf_render';
}
export function normalizedBox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || !value.length) return;
  const coords = typeof value[0] === 'object'
    ? value.map((p) => [p?.x, p?.y]) : value.length === 4 ? [[value[0], value[1]], [value[2], value[3]]] : [];
  if (!coords.length || !coords.every((p) => p.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))) return;
  const xs = coords.map((p) => p[0]), ys = coords.map((p) => p[1]);
  const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return box[2] > box[0] && box[3] > box[1] ? box : undefined;
}
export async function openPdf(bytes: Buffer) {
  Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
  return pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
}
/** Always a labelled local rendering, never presented as provider-extracted originals. */
export async function renderPdfDerivatives(bytes: Buffer, storage: UploadStorage, blocks: any[] = []): Promise<PdfDerivative[]> {
  const document = await openPdf(bytes);
  const derivatives: PdfDerivative[] = [];
  const sourceHash = sha256(bytes);
  try {
    const maxPages = Number(process.env.UPSTAGE_DOCUMENT_PARSE_MAX_PAGES ?? 100);
    if (document.numPages > maxPages) throw new Error('pdf_page_limit');
    const factory = {
      create(width: number, height: number) { const canvas = createCanvas(Math.ceil(width), Math.ceil(height)); return { canvas, context: canvas.getContext('2d') }; },
      reset(target: any, width: number, height: number) { target.canvas.width = width; target.canvas.height = height; },
      destroy(target: any) { target.canvas.width = 0; target.canvas.height = 0; },
    };
    for (let p = 1; p <= document.numPages; p++) {
      const page = await document.getPage(p);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 1400 / Math.max(original.width, original.height)) });
      const target = factory.create(viewport.width, viewport.height);
      await page.render({ canvasContext: target.context, viewport, canvasFactory: factory }).promise;
      const png = target.canvas.toBuffer('image/png');
      const save = async (buffer: Buffer, kind: PdfDerivative['kind'], block_id?: string, bbox?: PdfDerivative['bbox']) => {
        const hash = sha256(buffer), key = 'derived-' + sourceHash + '-' + hash + '.png';
        await storage.put(key, buffer);
        derivatives.push({ key, page: p, kind, block_id, bbox, mime: 'image/png', bytes: buffer.length, sha256: hash, source_sha256: sourceHash, origin: 'local_pdf_render' });
      };
      await save(png, 'page_preview');
      for (const block of blocks.filter((b) => b.page === p && ['image', 'figure', 'chart'].includes(b.block_type))) {
        const bbox = normalizedBox(block.metadata?.bbox);
        if (!bbox) continue;
        const left = Math.floor(bbox[0] * target.canvas.width), top = Math.floor(bbox[1] * target.canvas.height);
        const width = Math.min(target.canvas.width - left, Math.max(1, Math.ceil((bbox[2] - bbox[0]) * target.canvas.width)));
        const height = Math.min(target.canvas.height - top, Math.max(1, Math.ceil((bbox[3] - bbox[1]) * target.canvas.height)));
        await save(await sharp(png).extract({ left, top, width, height }).png().toBuffer(), 'figure', block.block_id, bbox);
      }
      page.cleanup();
    }
    return derivatives;
  } finally { await document.destroy(); }
}
