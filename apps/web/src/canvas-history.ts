export interface CanvasHistory<T> { past: T[]; present: T; future: T[] }
export function changeCanvas<T>(history: CanvasHistory<T>, present: T): CanvasHistory<T> {
  if (JSON.stringify(history.present) === JSON.stringify(present)) return history;
  return { past: [...history.past, history.present].slice(-100), present, future: [] };
}
export function travelCanvas<T>(history: CanvasHistory<T>, direction: 'undo' | 'redo'): CanvasHistory<T> {
  if (direction === 'undo') {
    if (!history.past.length) return history;
    return { past: history.past.slice(0, -1), present: history.past.at(-1)!, future: [history.present, ...history.future] };
  }
  if (!history.future.length) return history;
  return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) };
}
