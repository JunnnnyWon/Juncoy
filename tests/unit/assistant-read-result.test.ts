import { expect,it } from 'vitest';
import { isCommitRequest,commitRequestInput,resolveFollowup,formatReadResult } from '../../packages/knowledge/src/tools/read-result.ts';
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
