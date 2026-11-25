import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';

/**
 * p19-ide W1: the changed hunks of one file (line ranges of both sides), from CodeMirror's own diff (`Chunk.build`,
 * the same chunks the merge view draws). Pure: no DOM. A side's range is null when the hunk has no lines there (a
 * pure addition has no old lines, a pure deletion no new lines).
 */
export interface Hunk {
  readonly index: number;
  readonly oldStart: number | null;
  readonly oldEnd: number | null;
  readonly newStart: number | null;
  readonly newEnd: number | null;
  /** Lines added / removed in this hunk. */
  readonly added: number;
  readonly removed: number;
}

/** The hunk's own key (stable while the file pair does not change). */
export function hunkKey(path: string, h: Hunk): string {
  return `${path}:${String(h.oldStart ?? 0)}-${String(h.oldEnd ?? 0)}:${String(h.newStart ?? 0)}-${String(h.newEnd ?? 0)}`;
}

const doc = (s: string): Text => Text.of(s.split('\n'));

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const a = doc(oldText);
  const b = doc(newText);
  return Chunk.build(a, b).map((c, index) => {
    const hasA = c.toA > c.fromA;
    const hasB = c.toB > c.fromB;
    const oldStart = hasA ? a.lineAt(c.fromA).number : null;
    const oldEnd = hasA ? a.lineAt(c.endA).number : null;
    const newStart = hasB ? b.lineAt(c.fromB).number : null;
    const newEnd = hasB ? b.lineAt(c.endB).number : null;
    return {
      index,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      added: newStart === null || newEnd === null ? 0 : newEnd - newStart + 1,
      removed: oldStart === null || oldEnd === null ? 0 : oldEnd - oldStart + 1,
    };
  });
}
