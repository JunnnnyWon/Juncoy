import { describe, expect, it } from 'vitest';
import { orderedImageReferences } from '../../packages/knowledge/src/image-references.ts';
const a = { id: 'a', mime: 'image/png', state: 'READY' };
const b = { id: 'b', mime: 'image/jpeg', state: 'READY' };
describe('approved image reference resolution', () => {
  it('preserves approval order despite DB row order', () => {
    expect(orderedImageReferences(['b', 'a'], [a, b]).map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('rejects missing, duplicate and non-ready references', () => {
    expect(() => orderedImageReferences(['missing'], [a])).toThrow();
    expect(() => orderedImageReferences(['a', 'a'], [a])).toThrow();
    expect(() => orderedImageReferences(['a'], [{ ...a, state: 'INDEXING' }])).toThrow();
    expect(() => orderedImageReferences(['a'], [{ ...a, mime: 'application/pdf' }])).toThrow();
  });
  it.each(['REJECTED', 'ARCHIVED'])('blocks %s art assets', (canonical_state) => {
    expect(() => orderedImageReferences(['a'], [{ ...a, asset_id: 'asset', asset_state: 'READY', canonical_state }])).toThrow();
  });
  it('blocks failed art analysis state while preserving explicitly selected ready assets', () => {
    expect(() => orderedImageReferences(['a'], [{ ...a, asset_id: 'asset', asset_state: 'FAILED' }])).toThrow();
    expect(orderedImageReferences(['a'], [{ ...a, asset_id: 'asset', asset_state: 'READY', canonical_state: 'NONE', rights_note: '팀 제작 자료' }])).toHaveLength(1);
  });
  it('allows ready references without a rights-note field', () => {
    expect(orderedImageReferences(['a'], [{ ...a, asset_id: 'asset', asset_state: 'READY', canonical_state: 'NONE' }])).toHaveLength(1);
    expect(orderedImageReferences(['a'], [{ ...a, asset_id: 'asset', asset_state: 'READY', canonical_state: 'NONE', rights_note: '팀 제작 자료' }])).toHaveLength(1);
  });
});
