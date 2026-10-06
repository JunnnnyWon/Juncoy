import { describe, expect, it } from 'vitest';
import {
  Answer,
  AnswerStatus,
  ClaimState,
  DocumentState,
  KnowledgeErrorCode,
  QuestionRequest,
  documentKeys,
} from '@meeting/contracts';

describe('knowledge contracts', () => {
  it('document key builders produce stable namespaced keys', () => {
    expect(documentKeys.notionPage('ws1', 'page-9')).toBe('notion:ws1:page-9');
    expect(documentKeys.discordMessage('1545264536158740590', 'ch1', 'm1')).toBe(
      'discord:1545264536158740590:ch1:m1',
    );
    expect(documentKeys.githubFile('R_kgD', 'main', 'src/A.cpp')).toBe(
      'github:R_kgD:main:src/A.cpp',
    );
    expect(documentKeys.meetingTranscript('ws', 'm-1')).toBe('meeting:ws:m-1');
  });

  it('answer schema accepts a spec-compliant PARTIAL response', () => {
    const answer = Answer.parse({
      answer_id: crypto.randomUUID(),
      status: 'PARTIAL',
      answer: '근거로 작성한 본문',
      checked_at: new Date().toISOString(),
      temporal_mode: 'current',
      claims: [{ text: '주장', state: 'CONFIRMED', evidence_ids: ['e1'] }],
      evidence: [
        {
          id: 'e1',
          source: 'discord',
          document_id: 'discord:g:c:m',
          revision: 'hash',
          url: 'https://discord.com/channels/g/c/m',
          quote: '직접 근거',
          observed_at: new Date().toISOString(),
        },
      ],
      source_coverage: [
        {
          source: 'discord',
          read_status: 'LIVE_READ',
          search_status: 'MATCH',
          scope_complete: true,
          last_reconciled_at: new Date().toISOString(),
          gaps: [],
        },
        {
          source: 'notion',
          read_status: 'PARTIAL',
          search_status: 'MATCH',
          scope_complete: false,
          last_reconciled_at: new Date().toISOString(),
          gaps: ['관련 첨부 추출 대기'],
        },
        {
          source: 'github',
          read_status: 'LIVE_READ',
          search_status: 'NO_MATCH',
          scope_complete: true,
          last_reconciled_at: new Date().toISOString(),
          gaps: [],
        },
        {
          source: 'meeting',
          read_status: 'LIVE_READ',
          search_status: 'MATCH',
          scope_complete: true,
          last_reconciled_at: new Date().toISOString(),
          gaps: [],
        },
      ],
      conflicts: [],
      warnings: [],
      model: 'solar-pro4-260806',
      corpus_generation: 'gen-1',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(answer.status).toBe('PARTIAL');
    expect(answer.source_coverage).toHaveLength(4);
  });

  it('rejects unknown enum values and oversized questions', () => {
    expect(AnswerStatus.safeParse('DONE').success).toBe(false);
    expect(DocumentState.safeParse('STALE').success).toBe(false);
    expect(ClaimState.safeParse('APPROVED').success).toBe(false);
    expect(KnowledgeErrorCode.safeParse('SOURCE_AUTH_REQUIRED').success).toBe(true);
    expect(QuestionRequest.safeParse({ question: 'x'.repeat(4001) }).success).toBe(false);
    expect(QuestionRequest.parse({ question: '사다리 코드 어디야?' }).temporal_mode).toBe(
      'current',
    );
  });
});
