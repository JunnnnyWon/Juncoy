import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { first, type KnowledgeStore } from '@meeting/knowledge-db';
import { UpstageDocumentParse } from './document-parse-upstage.ts';

// 업로드 파일 파이프라인 (spec §5, §6):
// init(선언+검증) → complete(바이트 수신+magic 검사+저장+추출 잡) → READY 이후만 검색 대상.
// 텍스트 추출은 외부 서비스가 아니라 로컬 파서로 수행 — 원문은 private 저장소에만.

export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const UPLOAD_MAX_FILES_PER_REQ = 10;
export const UPLOAD_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

export const UPLOAD_MIMES = {
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: 'docx',
    magic: [0x50, 0x4b, 0x03, 0x04], // PK zip
  },
  'text/csv': { ext: 'csv' },
  'text/markdown': { ext: 'md' },
  'text/plain': { ext: 'txt' },
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpeg', magic: [0xff, 0xd8, 0xff] },
  'image/webp': { ext: 'webp' }, // RIFF????WEBP — 별도 검사
} as const;
export type UploadMime = keyof typeof UPLOAD_MIMES;

export function magicOk(buf: Buffer, mime: UploadMime): boolean {
  if (mime === 'image/webp')
    return (
      buf.length >= 12 &&
      buf.readUInt32BE(0) === 0x52494646 && // RIFF
      buf.readUInt32BE(8) === 0x57454250
    ); // WEBP
  const magic = (UPLOAD_MIMES[mime] as any).magic as number[] | undefined;
  if (!magic) return true; // text 계열
  return magic.every((b, i) => buf.length > i && buf[i] === b);
}

const stripXml = (xml: string) =>
  xml
    .replace(/<w:p[ >]/g, '\n<w:p ') // 문단 경계
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function extractDocx(buf: Buffer): Promise<string> {
  const yauzl = await import('yauzl');
  const zip = await new Promise<any>((res, rej) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (e: any, z: any) => (e ? rej(e) : res(z))),
  );
  if (!zip) return '';
  return new Promise((res, rej) => {
    const parts: Buffer[] = [];
    let done = false;
    zip.readEntry();
    zip.on('entry', (entry: any) => {
      if (entry.fileName === 'word/document.xml') {
        zip.openReadStream(entry, (e: any, stream: any) => {
          if (e) return rej(e);
          stream.on('data', (c: Buffer) => parts.push(c));
          stream.on('end', () => {
            done = true;
            res(stripXml(Buffer.concat(parts).toString('utf8')));
          });
        });
      } else zip.readEntry();
    });
    zip.on('end', () => {
      if (!done) res(''); // document.xml 없는 docx
    });
    zip.on('error', rej);
  });
}

async function extractPdf(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false })
    .promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(tc.items.map((i: any) => i.str).join(' '));
  }
  await doc.destroy();
  return out.join('\n\n').trim();
}

/** 텍스트 추출. 이미지/실패 시 '' — normalized에 플래그로 남김. */
export async function extractUploadText(buf: Buffer, mime: UploadMime): Promise<string> {
  if (mime === 'application/pdf') return extractPdf(buf);
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return extractDocx(buf);
  if (mime.startsWith('text/')) return buf.toString('utf8');
  return '';
}

export async function extractUpload(
  buf: Buffer,
  mime: UploadMime,
  opts?: { documentParse?: UpstageDocumentParse; expectedSha256?: string },
) {
  if (mime === 'application/pdf' && opts?.documentParse) {
    try {
      const parsed = await opts.documentParse.parsePdf(buf, opts.expectedSha256);
      return {
        text: parsed.text,
        normalized: {
          text: parsed.text,
          html: parsed.html,
          markdown: parsed.markdown,
          filename: undefined,
          mime,
          parser: {
            kind: 'upstage_document_parse',
            version: parsed.parserVersion,
            source_sha256: parsed.sourceSha256,
            request_id: parsed.requestId,
          },
        },
        parserKind: 'upstage_document_parse' as const,
        parseStatus: 'READY' as const,
      };
    } catch (error) {
      const text = await extractUploadText(buf, mime);
      return {
        text,
        normalized: {
          text,
          mime,
          parser: { kind: 'local_pdfjs', fallback: true },
        },
        parserKind: 'local_pdfjs' as const,
        parseStatus: 'FALLBACK' as const,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const text = await extractUploadText(buf, mime);
  return {
    text,
    normalized: { text, mime, parser: { kind: 'local' } },
    parserKind: 'local' as const,
    parseStatus: 'NOT_REQUESTED' as const,
  };
}

/** 프로젝트의 'upload' 지식 소스 행 — 없으면 생성 (auth_ref는 식별용 문자열). */
export async function ensureUploadSource(store: KnowledgeStore, projectId: string) {
  const s = await first<{ id: string }>(
    sql`INSERT INTO knowledge_sources(id, project_id, kind, auth_ref)
        VALUES (gen_random_uuid(), ${projectId}, 'upload', 'local')
        ON CONFLICT (project_id, kind, auth_ref) DO UPDATE SET status='ACTIVE'
        RETURNING id`,
    store.db,
  );
  return s!.id;
}

export class UploadStorage {
  constructor(public dir: string) {}
  async put(key: string, buf: Buffer) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), buf, { mode: 0o600 });
  }
  async remove(key: string) {
    await rm(join(this.dir, key), { force: true });
  }
  async sizeOf(key: string) {
    return (await stat(join(this.dir, key))).size;
  }
  async read(key: string) {
    return readFile(join(this.dir, key));
  }
}

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
