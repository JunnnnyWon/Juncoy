import { describe, expect, it } from 'vitest';
import { changeCanvas, travelCanvas } from '../../apps/web/src/canvas-history.ts';
describe('canvas edit history', () => {
  it('undoes and redoes nodes and edges together', () => {
    const initial = { past: [], present: { nodes: [], edges: [] } as {nodes: string[]; edges: string[]}, future: [] };
    const changed = changeCanvas(initial, { nodes: ['a', 'b'], edges: ['a-b'] });
    expect(travelCanvas(changed, 'undo').present).toEqual(initial.present);
    expect(travelCanvas(travelCanvas(changed, 'undo'), 'redo').present).toEqual(changed.present);
  });
  it('clears redo after a divergent edit and caps retained history', () => {
    let history = { past: [] as number[], present: 0, future: [] as number[] };
    for (let n = 1; n <= 110; n++) history = changeCanvas(history, n);
    expect(history.past).toHaveLength(100);
    expect(changeCanvas(travelCanvas(history, 'undo'), 999).future).toEqual([]);
  });
});
