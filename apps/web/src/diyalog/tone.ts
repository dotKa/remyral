/**
 * p12-diyalog: the five meaning colours of the Diyalog language. Colour never carries meaning alone — every use
 * pairs it with an icon and a word (docs/design/redesign/research.md, principle 2).
 *   teal   running / the assistant      amber  needs a decision
 *   red    failed / error               green  done / healthy
 *   violet limits and capacity
 * Literal class strings (Tailwind only generates classes it can see in the source).
 */
export type Tone = 'teal' | 'amber' | 'red' | 'green' | 'violet' | 'neutral';

/** Soft pill (kind label, chip "hot" state). */
export const SOFT: Readonly<Record<Tone, string>> = {
  teal: 'bg-dy-teal-soft text-dy-teal-ink',
  amber: 'bg-dy-amber-soft text-dy-amber-ink',
  red: 'bg-dy-red-soft text-dy-red-ink',
  green: 'bg-dy-green-soft text-dy-green',
  violet: 'bg-dy-violet-soft text-dy-violet',
  neutral: 'bg-dy-sunk text-dy-muted',
};

/** Ink only (state badge text, rail icons). */
export const INK: Readonly<Record<Tone, string>> = {
  teal: 'text-dy-teal-ink',
  amber: 'text-dy-amber-ink',
  red: 'text-dy-red-ink',
  green: 'text-dy-green',
  violet: 'text-dy-violet',
  neutral: 'text-dy-muted',
};

/** Solid fill (bars, dots). */
export const FILL: Readonly<Record<Tone, string>> = {
  teal: 'bg-dy-teal',
  amber: 'bg-dy-amber',
  red: 'bg-dy-red',
  green: 'bg-dy-green',
  violet: 'bg-dy-violet',
  neutral: 'bg-dy-line-2',
};
