import { INTL_TAG, type Locale } from './locale.js';

/**
 * Plural forms keyed by `Intl.PluralRules` categories. `other` is required; Turkish copy normally needs only
 * `other` (the noun stays singular after a number: "3 makine"), English needs `one` + `other`.
 */
export interface PluralForms<T = string> {
  readonly zero?: T;
  readonly one?: T;
  readonly two?: T;
  readonly few?: T;
  readonly many?: T;
  readonly other: T;
}

const rules = new Map<Locale, Intl.PluralRules>();

function rulesFor(locale: Locale): Intl.PluralRules {
  let r = rules.get(locale);
  if (r === undefined) {
    r = new Intl.PluralRules(INTL_TAG[locale]);
    rules.set(locale, r);
  }
  return r;
}

/** The plural category of `n` in `locale` (`one`, `other`, …). */
export function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  return rulesFor(locale).select(n);
}

/** Picks the form for `n`; a missing category falls back to `other`. */
export function plural<T>(locale: Locale, n: number, forms: PluralForms<T>): T {
  const cat = pluralCategory(locale, n);
  return forms[cat] ?? forms.other;
}
