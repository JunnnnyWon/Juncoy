import {it,expect} from 'vitest';
import {cleanEvidenceText} from '@meeting/contracts';
import {stripEvidenceMarkers} from '../../apps/web/src/assistant-format.ts';
it('removes IDs before brackets and cleans historical empty citations',()=>{
  const input='현재 논의 중입니다 [e1].\n- 아트 스타일은 미정입니다 [].\n- 컨셉도 미정입니다 [ e2, e24 ].\n- 시점은 잠정입니다 (e7).';
  const output=cleanEvidenceText(input);
  expect(output).not.toContain('[]');expect(output).not.toMatch(/e\d/);
  expect(output).toContain('아트 스타일은 미정입니다.');
  expect(stripEvidenceMarkers(input)).toBe(output);
});
it('preserves literal arrays, code blocks, Markdown and Git hashes',()=>{
  for(const value of ['[]','결과\n[]','{"e1":[]}','빈 배열 []','반환값은 []','`const values = []; e24`','```json\n{ "items": [] }\n```','[e123456](https://github.com/org/game/commit/e123456abcd)','https://example.com/query?items=[]','abc1e234abcd']) expect(cleanEvidenceText(value)).toBe(value);
});
it('keeps claims, line breaks and numbers unchanged',()=>{
  expect(cleanEvidenceText('1인칭 시점입니다 [].\nAI 소품을 사용합니다 [].')).toBe('1인칭 시점입니다.\nAI 소품을 사용합니다.');
  expect(cleanEvidenceText('문장입니다 [ ]. 다음 문장입니다.')).toBe('문장입니다. 다음 문장입니다.');
});
