import type { Doc } from './model';

/**
 * p13-workflows-ui: undo / redo over whole documents (they are small: ≤ 50 steps). Consecutive edits with the same
 * tag inside `COALESCE_MS` (typing in one field, one drag) are one step. At most `LIMIT` steps are kept.
 */

export const LIMIT = 100;
export const COALESCE_MS = 800;

export interface History {
  readonly past: readonly Doc[];
  readonly present: Doc;
  readonly future: readonly Doc[];
  readonly tag: string | null;
  readonly at: number;
}

export type HistoryAction =
  | { readonly type: 'commit'; readonly doc: Doc; readonly tag?: string | undefined; readonly now: number }
  /** Replaces the present without an undo step (a drag in progress, positions filled in on load). */
  | { readonly type: 'replace'; readonly doc: Doc }
  | { readonly type: 'reset'; readonly doc: Doc }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

export function initHistory(doc: Doc): History {
  return { past: [], present: doc, future: [], tag: null, at: 0 };
}

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case 'commit': {
      if (a.doc === h.present) return h;
      const tag = a.tag ?? null;
      if (tag !== null && tag === h.tag && a.now - h.at < COALESCE_MS) {
        return { ...h, present: a.doc, future: [], at: a.now };
      }
      return { past: [...h.past, h.present].slice(-LIMIT), present: a.doc, future: [], tag, at: a.now };
    }
    case 'replace':
      return { ...h, present: a.doc };
    case 'reset':
      return initHistory(a.doc);
    case 'undo': {
      const prev = h.past[h.past.length - 1];
      if (prev === undefined) return h;
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], tag: null, at: 0 };
    }
    case 'redo': {
      const next = h.future[0];
      if (next === undefined) return h;
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1), tag: null, at: 0 };
    }
  }
}
