import { cosine } from '../search/embedder.js';
import { normalizeLearning } from './extract.js';

/**
 * p10-semantic-memory (docs/design/p10-semantic-memory.md §5): de-duplication of proposed learnings against the
 * project's existing memory. Pure.
 *
 * - **Semantic** (when an embedding provider is configured *and* the project's search capture is consented): cosine
 *   similarity of the candidate's vector with the stored vectors of the project's live documents. `>= duplicate`
 *   → not proposed; `>= related` → proposed with "similar to <document>" so the reviewer can edit that one instead.
 * - **Lexical** (always; the only check without consent — nothing leaves the system): Jaccard similarity of the
 *   normalised word sets against live documents and pending suggestions, with its own thresholds.
 */

export interface Thresholds {
  readonly duplicate: number;
  readonly related: number;
}

/** Default semantic thresholds (Cohere Embed Multilingual v3; `MEMORY_DUPLICATE_THRESHOLD` overrides `duplicate`). */
export const SEMANTIC_THRESHOLDS: Thresholds = { duplicate: 0.9, related: 0.78 };
/** Lexical thresholds (Jaccard over word sets). */
export const LEXICAL_THRESHOLDS: Thresholds = { duplicate: 0.8, related: 0.5 };

export type Verdict = 'duplicate' | 'related' | 'new';

/** Semantic thresholds for a configured duplicate threshold: `related` stays 0.12 below it (and below it). */
export function semanticThresholds(duplicate: number): Thresholds {
  if (!(duplicate > 0 && duplicate < 1)) throw new RangeError('duplicate threshold must be in (0, 1)');
  return { duplicate, related: Math.max(0, Math.min(duplicate - 0.12, duplicate)) };
}

export function classify(score: number, t: Thresholds): Verdict {
  if (!Number.isFinite(score)) return 'new';
  if (score >= t.duplicate) return 'duplicate';
  if (score >= t.related) return 'related';
  return 'new';
}

export function wordSet(text: string): Set<string> {
  return new Set(
    normalizeLearning(text)
      .split(' ')
      .filter((w) => w.length >= 2),
  );
}

/** Jaccard similarity of two word sets (0 when either is empty). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface Match {
  readonly id: string;
  readonly score: number;
}

/** The best-scoring entry (ties: the smaller id, for stable results); null for no entries. */
export function bestMatch<T extends { readonly id: string }>(
  entries: readonly T[],
  score: (e: T) => number,
): Match | null {
  let best: Match | null = null;
  for (const e of entries) {
    const s = score(e);
    if (!Number.isFinite(s)) continue;
    if (best === null || s > best.score || (s === best.score && e.id < best.id))
      best = { id: e.id, score: s };
  }
  return best;
}

export function bestSemantic(
  vector: ArrayLike<number>,
  docs: readonly { readonly id: string; readonly embedding: ArrayLike<number> }[],
): Match | null {
  return bestMatch(docs, (d) => cosine(vector, d.embedding));
}

export function bestLexical(
  text: string,
  entries: readonly { readonly id: string; readonly text: string }[],
): Match | null {
  const words = wordSet(text);
  return bestMatch(entries, (e) => jaccard(words, wordSet(e.text)));
}
