import { describe, expect, it } from 'vitest';
import { ArtBoardSnapshot } from '@meeting/contracts';
const node = (id: string) => ({ id, node_type: 'text_note', x: 0, y: 0, width: 200, height: 100, text: '메모' });
describe('art board geometry contract', () => {
  it('accepts legacy references and defaults geometry arrays', () => {
    expect(ArtBoardSnapshot.parse({ references: [{ id: 'image', role: 'mood' }] }).nodes).toEqual([]);
  });
  it('preserves explicit semantic relationships', () => {
    const snapshot = ArtBoardSnapshot.parse({ nodes: [node('a'), node('b')], edges: [{ id: 'edge', source: 'a', target: 'b', edge_type: 'contradicts' }] });
    expect(snapshot.edges[0].edge_type).toBe('contradicts');
  });
  it.each(['a', 'missing'])('rejects a self or dangling target %s', (target) => {
    expect(ArtBoardSnapshot.safeParse({ nodes: [node('a')], edges: [{ id: 'edge', source: 'a', target, edge_type: 'supports' }] }).success).toBe(false);
  });
  it('rejects duplicate nodes and edges and invalid geometry', () => {
    expect(ArtBoardSnapshot.safeParse({ nodes: [node('a'), node('a')] }).success).toBe(false);
    const edge = { id: 'edge', source: 'a', target: 'b', edge_type: 'supports' };
    expect(ArtBoardSnapshot.safeParse({ nodes: [node('a'), node('b')], edges: [edge, edge] }).success).toBe(false);
    expect(ArtBoardSnapshot.safeParse({ nodes: [{ ...node('a'), x: Infinity }] }).success).toBe(false);
  });
});
