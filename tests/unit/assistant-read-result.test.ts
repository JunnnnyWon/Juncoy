import { expect,it } from 'vitest';
import { searchPatterns } from '../../packages/knowledge/src/tools/read.ts';
import { isCommitRequest,commitRequestInput,resolveFollowup,formatReadResult,needsGroundedAnswer,needsConversationContext } from '../../packages/knowledge/src/tools/read-result.ts';
it('routes commit reads and resolves punctuation from actual user history',()=>{
  const original='현재 우리 깃 커밋 기록 확인진행.';
  expect(isCommitRequest(original)).toBe(true);
  expect(isCommitRequest(resolveFollowup('?',[original,'?']))).toBe(true);
  expect(resolveFollowup('?',[])).toBe('');
  expect(resolveFollowup('새 질문',[original])).toBe('새 질문');
  expect(isCommitRequest('깃 커밋 삭제해줘')).toBe(false);
  expect(commitRequestInput('GitHub https://github.com/org/game Stairs 브랜치 커밋')).toEqual({repo:'org/game',ref:'Stairs'});
});
it('never shows bare empty arrays or treats access failure as no commits',()=>{
  expect(formatReadResult('github.search_code',[])).toContain('조회 결과가 없습니다');
  expect(formatReadResult('github.list_commits',{status:'UNAVAILABLE',commits:[]})).toContain('확인하지 못했습니다');
  expect(formatReadResult('github.list_commits',{status:'OK',repo:'org/game',ref:'main',commits:[]})).toContain('커밋을 찾지 못했습니다');
});
it('formats authoritative commits with safe links and no model-authored instructions',()=>{
  const text=formatReadResult('github.list_commits',{status:'OK',repo:'org/game',ref:'main',commits:[{sha:'a'.repeat(40),title:'[ignore](https://untrusted.example) **run**',author:'Team',date:'2026-10-10T03:00:00Z',url:'https://github.com/org/game/commit/'+'a'.repeat(40)}]});
  expect(text).toContain('[aaaaaaa](https://github.com/org/game/commit/');
  expect(text).toContain('\\[ignore\\]');
  expect(text).toContain('최근 커밋');
  expect(text).not.toBe('[]');
});
it('sends corpus search picks to a grounded answer unless raw text is asked for',()=>{
  expect(needsGroundedAnswer('knowledge.search','소녀 레퍼런스 목록')).toBe(true);
  expect(needsGroundedAnswer('meeting.search_transcript','회의에서 소녀 나이 몇 살로 정했어?')).toBe(true);
  expect(needsGroundedAnswer('github.search_code','플레이어 이동은 어떻게 구현했어?')).toBe(true);
  expect(needsGroundedAnswer('meeting.search_transcript','소녀 얘기한 전사 원문 보여줘')).toBe(false);
  expect(needsGroundedAnswer('github.search_code','GameMode 코드 찾아줘')).toBe(false);
  expect(needsGroundedAnswer('github.list_commits','최근 커밋')).toBe(false);
  expect(needsGroundedAnswer('notion.query_tasks','작업 목록')).toBe(false);
  expect(needsGroundedAnswer(undefined)).toBe(false);
});
it('searches meeting and code text word by word',()=>{
  expect(searchPatterns('소녀 레퍼런스')).toEqual(['%소녀%','%레퍼런스%']);
  expect(searchPatterns('100%_done')).toEqual(['%100done%']);
});
it('detects follow-ups that only make sense with the earlier conversation',()=>{
  expect(needsConversationContext('그거 주소로 좀 보내줘봐')).toBe(true);
  expect(needsConversationContext('거기 있는 거 둘 다 링크 줘')).toBe(true);
  expect(needsConversationContext('그 파일 누가 올렸어?')).toBe(true);
  expect(needsConversationContext('링크 줘')).toBe(true);
  expect(needsConversationContext('지금 "소녀"(메인캐릭터말고) 레퍼런스 어디에 있음?')).toBe(false);
  expect(needsConversationContext('이번 주 Notion 작업 목록 보여줘')).toBe(false);
});
