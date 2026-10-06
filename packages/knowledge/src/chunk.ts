// 청크 규칙 — spec §9.3.
// tokenizer 없이 보수적 근사치로 token_count를 기록한다 (실측 교정은 C05/P8에서).
// CJK는 ~1.5자/token, 코드/영문은 ~4자/token으로 추정한다.

export interface ChunkOut {
  ordinal: number;
  content: string;
  tokenCount: number;
  span: Record<string, any>;
  metadata: Record<string, any>;
}

const cjkRatio = (s: string) => {
  const cjk = (s.match(/[ᄀ-ᅟ⺀-぀-ヿ가-힯]/g) ?? []).length;
  return s.length ? cjk / s.length : 0;
};
export const estimateTokens = (s: string) =>
  Math.max(1, Math.ceil(s.length / (cjkRatio(s) > 0.3 ? 1.5 : 4)));

const CHARS_PER_TOKEN = 2.2; // 한국어 혼용 보수치
const windowChars = (tokens: number) => Math.floor(tokens * CHARS_PER_TOKEN);

/** 문단/heading/표 경계를 우선하는 일반 문서 청커 — 500~900tok, overlap ~100tok. */
export function chunkText(
  text: string,
  opts?: { targetTokens?: number; overlapTokens?: number; spanBase?: Record<string, any> },
): ChunkOut[] {
  const target = windowChars(opts?.targetTokens ?? 700);
  const overlap = windowChars(opts?.overlapTokens ?? 100);
  const boundaries = /(?=^#{1,6}\s)|(?:\n\n+)|(?=^\|)/gm;
  const blocks = text.split(boundaries).filter((b) => b.trim());
  const chunks: ChunkOut[] = [];
  let buf = '';
  let startBlock = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (buf && buf.length + blocks[i].length > target) {
      chunks.push({
        ordinal: chunks.length,
        content: buf,
        tokenCount: estimateTokens(buf),
        span: { ...(opts?.spanBase ?? {}), block_start: startBlock, block_end: i - 1 },
        metadata: {},
      });
      // overlap: 이전 청크 끝부분을 이어 붙인다.
      buf = buf.slice(Math.max(0, buf.length - overlap)) + blocks[i];
      startBlock = i - 1;
    } else {
      buf += blocks[i];
      if (!buf.trim()) startBlock = i;
    }
  }
  if (buf.trim())
    chunks.push({
      ordinal: chunks.length,
      content: buf,
      tokenCount: estimateTokens(buf),
      span: { ...(opts?.spanBase ?? {}), block_start: startBlock, block_end: blocks.length - 1 },
      metadata: {},
    });
  return chunks;
}

/** 코드 청커 — 함수/타입 경계 + 줄 구간 span. 큰 함수는 줄 창으로 분할. */
export function chunkCode(
  text: string,
  meta: { repo: string; ref: string; path: string; commit?: string },
): ChunkOut[] {
  const lines = text.split('\n');
  const boundaryRe =
    /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|struct|enum|interface|namespace|template\b|(?:[\w:<>,~*&]+\s+)+[\w:]+::[\w]+\s*\(|(?:[\w:<>,~*&]+\s+)+[\w]+\s*\([^;]*$)/;
  const bounds: number[] = [0];
  for (let i = 1; i < lines.length; i++) if (boundaryRe.test(lines[i])) bounds.push(i);
  bounds.push(lines.length);
  const maxLines = 200;
  const chunks: ChunkOut[] = [];
  const flush = (a: number, b: number) => {
    const content = lines.slice(a, b).join('\n');
    if (!content.trim()) return;
    chunks.push({
      ordinal: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      span: { ...meta, line_start: a + 1, line_end: b },
      metadata: { symbol_hint: lines[a]?.trim().slice(0, 120) },
    });
  };
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    if (b - a > maxLines)
      for (let s = a; s < b; s += maxLines) flush(s, Math.min(s + maxLines, b));
    else flush(a, b);
  }
  return chunks;
}

/** 회의 청커 — 화자/시간 60~120초 창, segment ID·ms span 보존. */
export function chunkMeeting(
  segments: {
    segment_id: string;
    speaker: string;
    display_text: string;
    start_ms: number;
    end_ms: number | null;
  }[],
): ChunkOut[] {
  const WINDOW_MS = 120_000;
  const chunks: ChunkOut[] = [];
  let buf: string[] = [];
  let ids: string[] = [];
  let winStart = 0;
  for (const s of segments) {
    if (buf.length && s.start_ms - winStart > WINDOW_MS) {
      const content = buf.join('\n');
      chunks.push({
        ordinal: chunks.length,
        content,
        tokenCount: estimateTokens(content),
        span: {
          segment_ids: [...ids],
          start_ms: winStart,
          end_ms: ids.length ? segments.find((x) => x.segment_id === ids.at(-1))?.end_ms : null,
        },
        metadata: {},
      });
      buf = [];
      ids = [];
    }
    if (!buf.length) winStart = s.start_ms;
    buf.push(`[${s.speaker}] ${s.display_text}`);
    ids.push(s.segment_id);
  }
  if (buf.length) {
    const content = buf.join('\n');
    chunks.push({
      ordinal: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      span: { segment_ids: ids, start_ms: winStart, end_ms: segments.at(-1)?.end_ms ?? null },
      metadata: {},
    });
  }
  return chunks;
}

/**
 * 문서의 normalized 내용을 청크로 변환 — 출처별 규칙 분기.
 * 반환 span에는 문서 원복에 필요한 식별자를 모두 포함한다 (citation용).
 */
/** 임베딩 모델 컨텍스트 상한 대비 보수 하드캡 — 이 길이를 넘는 청크는 순서대로 쪼갠다. */
const MAX_CHUNK_CHARS = 5_000;

function capChunkSize(chunks: ChunkOut[]): ChunkOut[] {
  const out: ChunkOut[] = [];
  for (const c of chunks) {
    if (c.content.length <= MAX_CHUNK_CHARS) {
      c.ordinal = out.length;
      out.push(c);
      continue;
    }
    const total = Math.ceil(c.content.length / MAX_CHUNK_CHARS);
    for (let i = 0; i < total; i++) {
      const content = c.content.slice(i * MAX_CHUNK_CHARS, (i + 1) * MAX_CHUNK_CHARS);
      if (!content.trim()) continue;
      out.push({
        ordinal: out.length,
        content,
        tokenCount: estimateTokens(content),
        span: c.span,
        metadata: { ...c.metadata, split_part: total > 1 ? `${i + 1}/${total}` : undefined },
      });
    }
  }
  return out;
}

export function chunkDocument(
  sourceKind: string,
  stableKey: string,
  normalized: Record<string, any>,
): ChunkOut[] {
  const text: string = normalized.text ?? '';
  if (!text && !(normalized.segments?.length ?? 0)) return [];
  if (sourceKind === 'meeting' && Array.isArray(normalized.segments))
    return capChunkSize(
      chunkMeeting(
        normalized.segments.map((s: any) => ({
          segment_id: s.segment_id,
          speaker: s.speaker ?? s.user_id,
          display_text: s.display_text ?? s.raw_text,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
        })),
      ),
    );
  if (sourceKind === 'github')
    return capChunkSize(
      chunkCode(text, {
        repo: normalized.repo ?? stableKey.split(':')[1],
        ref: normalized.ref ?? 'main',
        path: normalized.path ?? '',
        commit: normalized.sha,
      }),
    );
  if (sourceKind === 'discord')
    return capChunkSize([
      {
        ordinal: 0,
        content: text,
        tokenCount: estimateTokens(text),
        span: {
          message_id: stableKey.split(':').at(-1),
          channel_id: stableKey.split(':')[2],
        },
        metadata: {
          author: normalized.author,
          reply_to: normalized.reply_to ?? null,
        },
      },
    ]);
  if (Array.isArray(normalized.blocks) && normalized.blocks.length) {
    const blocks = normalized.blocks
      .filter((b: any) => String(b.text ?? '').trim())
      .sort((a: any, b: any) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
    const out: ChunkOut[] = [];
    let text = '';
    let blockIds: string[] = [];
    let pages: number[] = [];
    const flush = () => {
      if (!text.trim()) return;
      out.push({
        ordinal: out.length,
        content: text,
        tokenCount: estimateTokens(text),
        span: {
          document_key: stableKey,
          page_start: pages.length ? Math.min(...pages) : null,
          page_end: pages.length ? Math.max(...pages) : null,
          block_ids: [...blockIds],
          parser_kind: normalized.parser?.kind ?? null,
          parser_version: normalized.parser?.version ?? null,
          source_sha256: normalized.parser?.source_sha256 ?? null,
        },
        metadata: { block_types: blocks.filter((b: any) => blockIds.includes(String(b.block_id))).map((b: any) => b.block_type) },
      });
      text = '';
      blockIds = [];
      pages = [];
    };
    for (const block of blocks) {
      const value = String(block.text).trim();
      if (text && text.length + value.length + 1 > windowChars(700)) flush();
      text += (text ? '\n' : '') + value;
      blockIds.push(String(block.block_id));
      if (typeof block.page === 'number') pages.push(block.page);
    }
    flush();
    return capChunkSize(out);
  }
  return capChunkSize(chunkText(text, { spanBase: { document_key: stableKey } }));
}
