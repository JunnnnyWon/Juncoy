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
