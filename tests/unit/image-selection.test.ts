import { expect, it } from 'vitest';
import { normalizeReference, selectReferences } from '../../packages/knowledge/src/image-selection.ts';
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
  for (const count of [7, 16]) {
    const ids = refs.slice(0, count).map(ref => ref.upload_id).reverse();
    expect(selectReferences(refs, 'background', ids).map(ref => ref.upload_id)).toEqual(ids);
  }
  expect(() => selectReferences(refs, 'background', ['missing'])).toThrow('준비되지');
  expect(() => selectReferences(refs, 'background', ['1', '1'])).toThrow('중복');
  expect(() => selectReferences(refs, 'background', refs.map(ref => ref.upload_id))).toThrow('16개');
});
