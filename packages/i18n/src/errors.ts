import { formatNumber } from './format.js';
import type { Locale } from './locale.js';
import { EN_ERRORS, type Messages } from './messages.js';

/**
 * p14-i18n-errors (i18n Phase 3, ADR-0053 §5): a master error said in the reader's language. The master sends a
 * machine-readable `error` code, its English `message` and, when the sentence carries values, `params` (strings,
 * numbers, booleans; `reason` picks a variant of the code). The `errors` namespace holds one entry per code: a
 * string with `{placeholders}`, or an object of variants (`default` when there is no `reason`).
 */
export type ErrorParamValue = string | number | boolean | null;
export type ErrorParams = Readonly<Record<string, ErrorParamValue>>;

type Entry = string | Readonly<Record<string, string>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** The catalog template of `code` (and `params.reason`), or null when the code or the variant is not known. */
export function errorTemplate(t: Messages, code: string, params: ErrorParams = {}): string | null {
  const table = t.errors as unknown as Readonly<Record<string, Entry>>;
  if (!Object.hasOwn(table, code)) return null;
  const entry = table[code];
  if (entry === undefined) return null;
  if (typeof entry === 'string') return entry;
  const reason = params.reason;
  if (typeof reason === 'string' && reason !== '') {
    // A variant this console does not know yet: the master's own sentence says it better than `default`.
    return Object.hasOwn(entry, reason) ? (entry[reason] ?? null) : null;
  }
  return Object.hasOwn(entry, 'default') ? (entry.default ?? null) : null;
}

/** The `{placeholders}` of a template, in order of appearance. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
}

/**
 * The sentence for master error `code` with `params` in `locale`, or null — unknown code or variant, or a value
 * the sentence needs is missing (an older or newer master): the caller then shows the master's `message`.
 * Values are only ever text: numbers are formatted for the locale, nothing is parsed as markup.
 */
export function errorSentence(
  t: Messages,
  locale: Locale,
  code: string,
  params: ErrorParams = {},
): string | null {
  const template = errorTemplate(t, code, params);
  if (template === null) return null;
  const value = (name: string): string | null => {
    const v = Object.hasOwn(params, name) ? params[name] : undefined;
    if (typeof v === 'number') return formatNumber(locale, v, { maximumFractionDigits: 2 });
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return String(v);
    return null;
  };
  if (placeholdersOf(template).some((name) => value(name) === null)) return null;
  return template.replace(PLACEHOLDER, (_m, name: string) => value(name) ?? '');
}

/**
 * The sentence for an error body `{ error: code, message, params }` from the master in `locale`, or null (show
 * `message`). A body with `params` comes from a catalogued site and is trusted. A body without them is only
 * translated when the catalog's English sentence for the code is exactly the master's `message`: the same code is
 * also sent by domain errors with their own sentence (`conflict`, `forbidden`, … — "This code was already used."),
 * and those must keep their meaning. `pnpm check:i18n` keeps the English catalog equal to every literal master
 * message, so a reworded message degrades to the English text instead of a wrong translation.
 */
export function masterErrorSentence(
  t: Messages,
  locale: Locale,
  err: { readonly code: string; readonly message: string; readonly params?: ErrorParams | undefined },
): string | null {
  const params = err.params ?? {};
  if (
    Object.keys(params).length === 0 &&
    errorSentence({ errors: EN_ERRORS } as Messages, 'en', err.code) !== err.message
  )
    return null;
  return errorSentence(t, locale, err.code, params);
}
