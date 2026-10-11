import {it,expect} from 'vitest';
import {inlineMarkdown,stripEvidenceMarkers} from '../../apps/web/src/assistant-format.ts';
it('preserves commit links and code while hiding internal evidence markers',()=>{
  const link='[e123456](https://github.com/org/game/commit/abc1e23456789)';
  expect(stripEvidenceMarkers(link+' 회의(e2, e24) [e7] `stage7`')).toBe(link+' 회의  `stage7`');
  expect(inlineMarkdown(link)).toEqual([{kind:'link',text:'e123456',url:'https://github.com/org/game/commit/abc1e23456789'}]);
});
it('does not interpret script URLs or escaped commit messages as links',()=>{
  expect(inlineMarkdown('[bad](javascript:alert)')[0]?.kind).toBe('text');
  expect(inlineMarkdown('\\[ignore\\](https://example.com)')[0]?.kind).toBe('text');
});
it('supports emphasis and code without corrupting plain identifiers',()=>{
  expect(inlineMarkdown('**기록** `SHA`').map(item=>item.kind)).toEqual(['strong','text','code']);
  expect(stripEvidenceMarkers('scene7 abc1e234abcd')).toBe('scene7 abc1e234abcd');
  expect(inlineMarkdown('**Team\\_23**')).toEqual([{kind:'strong',text:'Team_23'}]);
});
