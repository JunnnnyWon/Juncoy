import { describe, expect, it } from 'vitest';
import {
  buildConversationMemory,
  understandTurn,
  answerFromConversation,
  keepConversationLinks,
  EMPTY_MEMORY,
} from '../../packages/knowledge/src/conversation.ts';
import type { ChatModel } from '../../packages/knowledge/src/answer.ts';

const fakeModel = (result: unknown, seen: { input?: any; system?: string } = {}): ChatModel => ({
  async structured(schema, input, system) {
    seen.input = input;
    seen.system = system;
    return { result: schema.parse(result), model: 'fake' };
  },
});
const failingModel: ChatModel = {
  async structured() {
    throw new Error('down');
  },
};

describe('buildConversationMemory', () => {
  it('keeps the whole short conversation in order and drops non-chat roles', () => {
    const memory = buildConversationMemory([
      { role: 'user', content: '소녀 레퍼런스 어디 있음?' },
      { role: 'tool', content: 'ignored' },
      { role: 'assistant', content: '화풍레퍼런스5.jpg에 있습니다.' },
      { role: 'assistant', content: '   ' },
    ]);
    expect(memory.recent).toEqual([
      { role: 'user', content: '소녀 레퍼런스 어디 있음?' },
      { role: 'assistant', content: '화풍레퍼런스5.jpg에 있습니다.' },
    ]);
    expect(memory.earlier_user_messages).toEqual([]);
  });

  it('keeps recent turns verbatim and older user messages short in a long session', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `${i % 2 ? '답' : '질문'} ${i} ` + 'x'.repeat(500),
    }));
    messages[0].content = '앞으로 답은 표로 정리해줘';
    const memory = buildConversationMemory(messages, {
      recentChars: 3000,
      perMessageChars: 2000,
      earlierChars: 4000,
      perEarlierChars: 50,
    });
    expect(memory.recent.at(-1)?.content).toContain('답 39');
    expect(memory.recent.length).toBeLessThan(40);
    // 오래전에 정한 조건도 남는다
    expect(memory.earlier_user_messages[0]).toBe('앞으로 답은 표로 정리해줘');
    expect(memory.earlier_user_messages.every((m) => m.length <= 51)).toBe(true);
    // 최근 원문과 앞선 사용자 말이 겹치지 않는다
    expect(memory.earlier_user_messages.some((m) => m.startsWith(memory.recent[0].content.slice(0, 10)))).toBe(false);
  });

  it('caps a single huge message instead of dropping the conversation', () => {
    const memory = buildConversationMemory([{ role: 'assistant', content: 'y'.repeat(10_000) }]);
    expect(memory.recent).toHaveLength(1);
    expect(memory.recent[0].content.length).toBeLessThanOrEqual(2001);
  });
});

describe('understandTurn', () => {
  const memory = buildConversationMemory([
    { role: 'user', content: '소녀 레퍼런스 어디 있음?' },
    { role: 'assistant', content: '화풍레퍼런스5.jpg와 화풍레퍼런스2.jpg가 있습니다.' },
  ]);

  it('rewrites a follow-up with no pronoun using the conversation', async () => {
    const seen: any = {};
    const out = await understandTurn(
      fakeModel({ question: '화풍레퍼런스5.jpg는 누가 올렸어?', kind: 'lookup' }, seen),
      '올린 사람은?',
      memory,
    );
    expect(out).toEqual({ question: '화풍레퍼런스5.jpg는 누가 올렸어?', from_conversation: false });
    expect(seen.input.conversation.recent).toHaveLength(2);
    expect(seen.input.current_message).toBe('올린 사람은?');
  });

  it('skips the model call when there is no earlier conversation', async () => {
    const out = await understandTurn(failingModel, '첫 질문', EMPTY_MEMORY);
    expect(out).toEqual({ question: '첫 질문', from_conversation: false });
  });

  it('falls back to the original message and a data search on model failure', async () => {
    const out = await understandTurn(failingModel, '표로 정리해줘', memory);
    expect(out).toEqual({ question: '표로 정리해줘', from_conversation: false });
  });

  it('answers reformat, recall and smalltalk from the conversation only', async () => {
    for (const kind of ['reformat', 'recall', 'smalltalk'])
      expect((await understandTurn(fakeModel({ question: 'q', kind }), 'x', memory)).from_conversation).toBe(true);
  });
});

describe('answerFromConversation', () => {
  it('answers from the conversation only', async () => {
    const seen: any = {};
    const memory = buildConversationMemory([
      { role: 'assistant', content: '화풍레퍼런스5.jpg와 화풍레퍼런스2.jpg가 있습니다.' },
    ]);
    const text = await answerFromConversation(
      fakeModel({ needs_lookup: false, lines: ['| 파일 |', '| --- |', '| 화풍레퍼런스5.jpg |'] }, seen),
      '표로 정리해줘',
      memory,
    );
    expect(text).toBe('| 파일 |\n| --- |\n| 화풍레퍼런스5.jpg |');
    expect(seen.input).not.toHaveProperty('evidence');
    expect(seen.system).toContain('이전 대화에 없는 사실을 지어내지 않는다');
    expect(seen.system).toContain('요청한 결과물만');
  });

  it('hands off to the data search when the conversation cannot answer', async () => {
    const memory = buildConversationMemory([{ role: 'assistant', content: '화풍레퍼런스2.jpg가 있습니다.' }]);
    expect(await answerFromConversation(fakeModel({ needs_lookup: true, lines: [] }), '그 그림 뭐야?', memory)).toBeNull();
  });
});

describe('keepConversationLinks', () => {
  it('keeps links from the conversation and unlinks made-up ones', () => {
    const memory = buildConversationMemory([
      { role: 'assistant', content: '- [화풍레퍼런스5.jpg](/api/assistant/files/b3b8/content)' },
    ]);
    expect(
      keepConversationLinks('[화풍레퍼런스5.jpg](/api/assistant/files/b3b8/content) [가짜](https://evil.example)', memory),
    ).toBe('[화풍레퍼런스5.jpg](/api/assistant/files/b3b8/content) 가짜');
  });
});
