import { describe, expect, it } from 'vitest';
import {
  chunkCode,
  chunkDocument,
  chunkMeeting,
  chunkText,
  estimateTokens,
} from '@meeting/knowledge';

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
});

describe('estimateTokens', () => {
  it('estimates CJK denser than code', () => {
    const ko = estimateTokens('가'.repeat(150));
    const en = estimateTokens('a'.repeat(150));
    expect(ko).toBeGreaterThan(en);
  });
});
