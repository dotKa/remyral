import type { MentionType } from '../../api/chat';

/**
 * p12-mention-badges: where the `@label` tokens of a message's mention refs sit in its text. Pure and shared by the
 * message rows (badges in sent messages) and the composer (atomic tokens, the chip row mirroring the text, the
 * highlight under the field).
 *
 * Only refs make badges: a token is a ref's `@label` with a word boundary on both sides (start / whitespace / an
 * opening bracket before the `@`, end / whitespace / punctuation after the label). Anything else that merely looks
 * like `@x` stays plain text. The text is never parsed as markup — callers render the segments as React text and
 * React elements only.
 */

export interface MentionLike {
  readonly type: MentionType;
  readonly id: string;
  readonly label: string;
}

export interface TokenRange<M extends MentionLike = MentionLike> {
  /** Index of the `@`. */
  readonly start: number;
  /** Index after the label. */
  readonly end: number;
  readonly mention: M;
}

export type Segment<M extends MentionLike = MentionLike> =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mention'; readonly text: string; readonly mention: M };

const BEFORE = /[\s([{"'«]/;
const AFTER = /[\s.,;:!?)\]}"'»…]/;

/** The composer's display form of a label (whitespace collapsed, ≤ 80 chars) — what a pick inserts. */
export function tokenLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function boundaryBefore(text: string, at: number): boolean {
  return at === 0 || BEFORE.test(text.charAt(at - 1));
}

function boundaryAfter(text: string, end: number): boolean {
  return end === text.length || AFTER.test(text.charAt(end));
}

/**
 * Every token of `mentions` in `text`, left to right, not overlapping. At one `@` the longest matching label wins
 * ("@acme web" over "@acme"). A ref matches its label as stored and its composer form. A ref with an empty label never
 * matches.
 */
export function findTokens<M extends MentionLike>(text: string, mentions: readonly M[]): TokenRange<M>[] {
  if (mentions.length === 0 || !text.includes('@')) return [];
  const candidates = mentions
    .flatMap((m) => {
      const forms = new Set([m.label, tokenLabel(m.label)]);
      return [...forms].filter((f) => f !== '').map((form) => ({ form, m }));
    })
    .sort((a, b) => b.form.length - a.form.length);
  const out: TokenRange<M>[] = [];
  let i = text.indexOf('@');
  while (i !== -1) {
    let next = i + 1;
    if (boundaryBefore(text, i)) {
      for (const c of candidates) {
        const end = i + 1 + c.form.length;
        if (text.startsWith(c.form, i + 1) && boundaryAfter(text, end)) {
          out.push({ start: i, end, mention: c.m });
          next = end;
          break;
        }
      }
    }
    i = text.indexOf('@', next);
  }
  return out;
}

/** The text cut into plain runs and mention tokens. */
export function segmentMentions<M extends MentionLike>(text: string, mentions: readonly M[]): Segment<M>[] {
  const out: Segment<M>[] = [];
  let last = 0;
  for (const t of findTokens(text, mentions)) {
    if (t.start > last) out.push({ kind: 'text', text: text.slice(last, t.start) });
    out.push({ kind: 'mention', text: text.slice(t.start, t.end), mention: t.mention });
    last = t.end;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** The refs with no token in the text (shown as a row of badges under the message). */
export function unplacedMentions<M extends MentionLike>(text: string, mentions: readonly M[]): M[] {
  const placed = new Set(findTokens(text, mentions).map((t) => t.mention));
  return mentions.filter((m) => !placed.has(m));
}

/**
 * The composer's refs that still have their token in the text: a label shared by k refs keeps the first n of them
 * when n tokens of it are left. Edited or deleted tokens drop their ref, so the chip row mirrors the text exactly.
 */
export function liveMentions<M extends MentionLike>(text: string, mentions: readonly M[]): M[] {
  const counts = new Map<string, number>();
  for (const t of findTokens(text, mentions)) {
    const k = tokenLabel(t.mention.label);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return mentions.filter((m) => {
    const k = tokenLabel(m.label);
    const n = counts.get(k) ?? 0;
    if (n <= 0) return false;
    counts.set(k, n - 1);
    return true;
  });
}

/**
 * The token a key acts on as one unit, for a collapsed caret: Backspace at its end or inside it, Delete at its start
 * or inside it; ArrowLeft from its end or inside, ArrowRight from its start or inside. Null: the key is the browser's.
 */
export function tokenAt(
  ranges: readonly TokenRange[],
  caret: number,
  key: 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight',
): TokenRange | null {
  for (const r of ranges) {
    const inside = caret > r.start && caret < r.end;
    if (inside) return r;
    if ((key === 'Backspace' || key === 'ArrowLeft') && caret === r.end) return r;
    if ((key === 'Delete' || key === 'ArrowRight') && caret === r.start) return r;
  }
  return null;
}
