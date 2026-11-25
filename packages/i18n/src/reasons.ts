import type { Messages } from './messages.js';
import type { ReasonVars } from './reason-vars.js';

export type { ReasonVars } from './reason-vars.js';

/**
 * p14-i18n-reasons (i18n Phase 4, docs/design/i18n-plan.md §4.4): a reported reason said in the reader's language.
 * A `reasons.codes` entry is a sentence function, or an object of variants chosen by the reason's `params.cause`
 * (`default` when there is none, or when the cause is one this console does not know — the code's general sentence
 * is still true). Unknown code ⇒ null: the caller shows the reported raw text, never an invented sentence.
 */
type Sentence = (v: ReasonVars) => string;
type Entry = Sentence | Readonly<Record<string, Sentence>>;

function entryOf(t: Messages, code: string): Entry | null {
  const table = t.reasons.codes as unknown as Readonly<Record<string, Entry>>;
  return Object.hasOwn(table, code) ? (table[code] ?? null) : null;
}

/** Whether `code` has a sentence in the catalog. */
export function isReasonCode(t: Messages, code: string): boolean {
  return entryOf(t, code) !== null;
}

/** The variant names (`params.cause` values) of `code` besides `default`; empty for a plain sentence. */
export function reasonVariants(t: Messages, code: string): string[] {
  const e = entryOf(t, code);
  if (e === null || typeof e === 'function') return [];
  return Object.keys(e).filter((k) => k !== 'default');
}

/** The codes with a sentence (tests, docs). */
export function reasonCodes(t: Messages): string[] {
  return Object.keys(t.reasons.codes);
}

/** The sentence for reason `code` (variant `cause`) with `vars`, or null when the code is not known. */
export function reasonSentence(
  t: Messages,
  code: string,
  vars: ReasonVars,
  cause: string | null = null,
): string | null {
  const e = entryOf(t, code);
  if (e === null) return null;
  if (typeof e === 'function') return e(vars);
  const fn = cause !== null && Object.hasOwn(e, cause) ? e[cause] : e.default;
  return fn === undefined ? null : fn(vars);
}

/** A fix label key of `reasons.actions`. */
export type ReasonActionKey = keyof Messages['reasons']['actions'];
