import { describe, expect, it } from 'vitest';
import {
  chunkCode,
  chunkDocument,
  chunkMeeting,
  chunkText,
  estimateTokens,
} from '@meeting/knowledge';
import { filenameTerms, stripUploadHeader } from '../../packages/knowledge/src/chunk.ts';

describe('chunkText', () => {
  it('splits on paragraph/heading boundaries and keeps order', () => {
    const doc = Array.from({ length: 30 }, (_, i) => `## 섹션 ${i}\n\n${'문장. '.repeat(30)}`).join(
      '\n\n',
    );
    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    // 표 헤더(|)도 경계로 인식된다 — 짧은 문서는 하나로 합쳐져도 내용이 보존된다
    const table = chunkText('머리\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table.map((c) => c.content).join('')).toContain('| a | b |');
  });
});

describe('chunkCode', () => {
  it('splits at top-level function/type boundaries with line spans', () => {
    const code = `// header
int helper() { return 1; }

class Foo {
public:
  void run();
};

void Foo::run() {
  // body
}
`;
    const chunks = chunkCode(code, { repo: 'o/r', ref: 'main', path: 'a.cpp' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.span.line_start <= c.span.line_end)).toBe(true);
    expect(chunks[0].span.path).toBe('a.cpp');
  });
});

describe('chunkMeeting', () => {
  it('groups segments into <=120s windows preserving segment spans', () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({
      segment_id: `seg-${i}`,
      speaker: i % 2 ? '김' : '이',
      display_text: `발언 ${i}`,
      start_ms: i * 30_000,
      end_ms: i * 30_000 + 5000,
    }));
    const chunks = chunkMeeting(segs);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.span.segment_ids)).toEqual(segs.map((s) => s.segment_id));
    expect(chunks[0].content).toContain('[김]');
  });
});

describe('chunkDocument dispatch', () => {
  it('routes by source kind and preserves identifiers', () => {
    const meeting = chunkDocument('meeting', 'meeting:ws:m1', {
      segments: [
        { segment_id: 's1', speaker: '김', display_text: '안녕', start_ms: 0, end_ms: 1000 },
      ],
    });
    expect(meeting[0].span.segment_ids).toEqual(['s1']);
    const gh = chunkDocument('github', 'github:R:main:a.ts', {
      text: 'function f() {}',
      path: 'a.ts',
      ref: 'main',
    });
    expect(gh[0].span.path).toBe('a.ts');
    const dc = chunkDocument('discord', 'discord:g:ch:m9', { text: 'msg', author: 'u' });
    expect(dc[0].span.message_id).toBe('m9');
  });

  it('keeps Document Parse page/block citation metadata on chunks', () => {
    const chunks = chunkDocument('upload', 'upload:doc-1', {
      text: '제목\n본문',
      parser: { kind: 'upstage_document_parse', version: 'parse-v1', source_sha256: 'a'.repeat(64) },
      blocks: [
        { block_id: 'p1-b1', page: 1, ordinal: 0, block_type: 'heading', text: '제목' },
        { block_id: 'p2-b1', page: 2, ordinal: 1, block_type: 'paragraph', text: '본문' },
      ],
    });
    expect(chunks[0].span).toMatchObject({
      page_start: 1,
      page_end: 2,
      block_ids: ['p1-b1', 'p2-b1'],
      parser_kind: 'upstage_document_parse',
      source_sha256: 'a'.repeat(64),
    });
  });

  it('puts the filename on every upload chunk so name searches can find it', () => {
    const image = chunkDocument('upload', 'upload:img-1', {
      text: '창문 너머로 거대한 눈동자가 들여다보는 어두운 방\n검색어: 소녀, girl, 눈동자',
      mime: 'image/png',
      filename: 'girl image.png',
    });
    expect(image).toHaveLength(1);
    expect(image[0].content.split('\n')[0]).toBe('레퍼런스 이미지 파일: girl image.png (girl image)');
    expect(image[0].content).toContain('소녀');
    expect(image[0].span.document_key).toBe('upload:img-1');
    // 설명이 없는 이미지는 이전처럼 청크를 만들지 않는다.
    expect(chunkDocument('upload', 'upload:img-2', { text: '', mime: 'image/png', filename: 'a.png' })).toEqual([]);
    // 문서 업로드도 모든 청크에 파일명이 붙는다 (Document Parse 블록 포함).
    const doc = chunkDocument('upload', 'upload:doc-2', {
      text: '제목\n본문',
      mime: 'application/pdf',
      filename: '레퍼런스_게임분석-v2.pdf',
      blocks: [{ block_id: 'b1', page: 1, ordinal: 0, block_type: 'paragraph', text: '본문' }],
    });
    expect(doc[0].content).toBe('파일: 레퍼런스_게임분석-v2.pdf (레퍼런스 게임분석 v2)\n본문');
    expect(doc[0].span.block_ids).toEqual(['b1']);
    // 업로드가 아닌 출처는 바뀌지 않는다.
    expect(chunkDocument('notion', 'notion:p1', { text: '본문', filename: 'x.md' })[0].content).toBe('본문');
  });

  it('strips the filename header so evidence still matches the original text', () => {
    const normalized = { text: '창문 너머 눈동자\n붉은 문', mime: 'image/png', filename: 'girl image.png' };
    const [chunk] = chunkDocument('upload', 'upload:img-1', normalized);
    const body = stripUploadHeader('upload', chunk.content);
    expect(normalized.text.includes(body.trim().slice(0, 80))).toBe(true);
    const [doc] = chunkDocument('upload', 'upload:doc-1', { text: '본문 첫 줄', mime: 'text/plain', filename: 'a.txt' });
    expect(stripUploadHeader('upload', doc.content)).toBe('본문 첫 줄');
    // 업로드가 아닌 출처와 머리글 없는 글은 그대로 둔다.
    expect(stripUploadHeader('notion', '파일: x\n본문')).toBe('파일: x\n본문');
    expect(stripUploadHeader('upload', '본문만')).toBe('본문만');
    expect(stripUploadHeader('upload', '이미지 파일: qa-pixel.png\n붉은 단색')).toBe('붉은 단색');
  });

  it('splits filenames into search words', () => {
    expect(filenameTerms('girl_image-v2.png')).toBe('girl image v2');
    expect(filenameTerms('BossCharacterRef.jpeg')).toBe('Boss Character Ref');
    expect(filenameTerms('소녀 레퍼런스.webp')).toBe('소녀 레퍼런스');
  });
});

describe('estimateTokens', () => {
  it('estimates CJK denser than code', () => {
    const ko = estimateTokens('가'.repeat(150));
    const en = estimateTokens('a'.repeat(150));
    expect(ko).toBeGreaterThan(en);
  });
});
