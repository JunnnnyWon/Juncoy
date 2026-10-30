import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stableKeyToUrl } from '../../packages/knowledge/src/answer.ts';
import { formatReadResult } from '../../packages/knowledge/src/tools/read-result.ts';
import { ToolRegistry } from '../../packages/knowledge/src/tools/registry.ts';
import { Evidence } from '@meeting/contracts';

// QA 10-12 후속 수정 회귀 테스트.
describe('github evidence permalink', () => {
  const sha = 'a'.repeat(40);
  it('uses head sha permalink instead of branch name', () => {
    const url = stableKeyToUrl(
      'github:JunnnnyWon/Team_23:deleted-branch:docs/plan.md',
      {},
      { repo: 'JunnnnyWon/Team_23', head: sha },
    );
    expect(url).toBe(`https://github.com/JunnnnyWon/Team_23/blob/${sha}/docs/plan.md`);
  });
  it('recovers head from source_revision for older documents', () => {
    const url = stableKeyToUrl(
      'github:org/repo:deleted-branch:x.md',
      {},
      null,
      `${sha}:${'b'.repeat(40)}`,
    );
    expect(url).toBe(`https://github.com/org/repo/blob/${sha}/x.md`);
  });
  it('falls back to branch ref when no head is known', () => {
    expect(stableKeyToUrl('github:org/repo:main:x.md')).toBe(
      'https://github.com/org/repo/blob/main/x.md',
    );
  });
  it('leaves discord and other kinds unchanged', () => {
    expect(stableKeyToUrl('discord:g:c:m')).toBe('https://discord.com/channels/g/c/m');
  });
});

describe('formatReadResult fallback', () => {
  it('formats korean-keyed notion rows with date and link', () => {
    const text = formatReadResult('notion.query_schedule', [
      {
        이름: '기획 검토',
        날짜: { start: '2026-10-12' },
        상태: '진행 중',
        url: 'https://notion.so/p1',
      },
    ]);
    expect(text).toContain('기획 검토');
    expect(text).toContain('2026');
    expect(text).toContain('https://notion.so/p1');
    expect(text).not.toContain('조회 항목');
  });
  it('falls back to first string field instead of bare 조회 항목', () => {
    const text = formatReadResult('knowledge.search', [{ count: 3, label: '회의록 A안' }]);
    expect(text).toContain('회의록 A안');
    expect(text).not.toBe('- 조회 항목');
  });
  it('still distinguishes empty arrays and missing results', () => {
    expect(formatReadResult('knowledge.search', [])).toContain('조회 결과가 없습니다');
    expect(formatReadResult('knowledge.search', null)).toContain('표시할 항목이 없습니다');
  });
});

describe('registry tool exception isolation', () => {
  it('turns connector exceptions into structured failure', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'knowledge.search' as any,
      kind: 'read',
      description: 'x',
      input: z.object({ q: z.string() }).passthrough(),
      minRole: 'reader',
      auditKind: 'read',
      run: async () => {
        throw new Error('notion offline');
      },
    });
    const r = await registry.execute({ role: 'reader' } as any, 'knowledge.search', { q: 'x' });
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('tool_error');
    expect((r as any).error).toContain('notion offline');
  });
});

describe('evidence source timing fields', () => {
  it('accepts occurred/modified/indexed timestamps', () => {
    const now = new Date().toISOString();
    const parsed = Evidence.parse({
      id: 'e1',
      source: 'github',
      document_id: 'd',
      revision: 'r',
      url: 'https://github.com/x',
      quote: 'q',
      observed_at: now,
      source_occurred_at: now,
      source_modified_at: now,
      indexed_at: now,
    });
    expect(parsed.source_occurred_at).toBe(now);
    // 과거 저장 답변 호환 — 필드가 없어도 통과한다.
    expect(
      Evidence.parse({
        id: 'e1',
        source: 'meeting',
        document_id: 'd',
        revision: 'r',
        url: 'juncoy://meeting/m1',
        quote: 'q',
        observed_at: now,
      }).source_occurred_at,
    ).toBeUndefined();
  });
});
