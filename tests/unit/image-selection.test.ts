import { expect, it } from 'vitest';
import { normalizeReference, selectReferences, inferImageOutput } from '../../packages/knowledge/src/image-selection.ts';
it('keeps character edits as character even when expanded instructions mention background and lighting only', () => {
  expect(inferImageOutput('기존 이미지 수정\n이번 요청: 남성 탐험가 얼굴과 포즈 유지, 조명만 밝게\n변경: 배경 요소 유지, 조명만 밝게', 'background')).toBe('character');
  expect(inferImageOutput('캐릭터 생성. 남성 탐험가. HUD 제외', 'game_scene')).toBe('character');
  expect(inferImageOutput('온실 배경 전용 이미지. HUD 제외, 인물 제외', 'ui')).toBe('background');
  expect(inferImageOutput('게임 UI 신규 시안. 인물 없이', 'game_scene')).toBe('ui');
});
it('marks inconsistent role strengths for review', () => {
  expect(normalizeReference({ roles: ['mood'], roleUsage: { modeling_language: 'MUST_FOLLOW' } }).review_required).toBe(true);
});
it('UI excludes character-only references', () => {
  expect(selectReferences([{ roles: ['face_shape'], usage: 'STRONG_REFERENCE' }], 'ui')).toEqual([]);
});
it('selects up to six related styles and prevents scene copying', () => {
  const selected = selectReferences(Array.from({ length: 13 }, (_, id) => ({ id, roles: ['texture'], usage: 'STRONG_REFERENCE' })), 'background');
  expect(selected).toHaveLength(6);
  expect(selected[0].note).toContain('복제하지 않는다');
  expect(selected[0].note).toContain('STRONG_REFERENCE');
});
it('does not overwrite human scope and keeps review assets out', () => {
  expect(selectReferences([{ roles: ['texture'], roleUsage: { texture: 'REVIEW_REQUIRED' }, note: 'human' }], 'background')).toEqual([]);
});
it('preserves 7 and 16 explicitly requested originals in user order; rejects missing and duplicate inputs', () => {
  const refs = Array.from({ length: 17 }, (_, index) => ({ upload_id: String(index), roles: ['texture'], usage: 'STRONG_REFERENCE' }));
  for (const count of [1, 7, 16]) {
    const ids = refs.slice(0, count).map(ref => ref.upload_id).reverse();
    expect(selectReferences(refs, 'background', ids).map(ref => ref.upload_id)).toEqual(ids);
  }
  expect(() => selectReferences(refs, 'background', ['missing'])).toThrow('준비되지');
  expect(() => selectReferences(refs, 'background', ['1', '1'])).toThrow('중복');
  expect(() => selectReferences(refs, 'background', refs.map(ref => ref.upload_id))).toThrow('16개');
});
