/**
 * The console's languages (ADR-0053). Turkish is the default for everyone; English is the second language.
 * A locale is chosen per user and stored on the master (`users.locale`); before sign-in the web console
 * uses the browser's last choice, then the browser language, then Turkish.
 */
export type Locale = 'tr' | 'en';

export const LOCALES: readonly Locale[] = ['tr', 'en'];

export const DEFAULT_LOCALE: Locale = 'tr';

/** BCP 47 tag handed to `Intl.*`: `en` uses en-GB (24 h clock, day-month order, like the weekly report). */
export const INTL_TAG: Readonly<Record<Locale, string>> = { tr: 'tr-TR', en: 'en-GB' };

/** Each language's own name (a language picker shows these, never translated). */
export const LOCALE_NAME: Readonly<Record<Locale, string>> = { tr: 'Türkçe', en: 'English' };

export function isLocale(v: unknown): v is Locale {
  return v === 'tr' || v === 'en';
}

/**
 * The first supported language in a preference list (`navigator.languages`, or the tags of an
 * `Accept-Language` header in order), matched by primary subtag (`en-US` → `en`, `tr-TR` → `tr`);
 * `fallback` when nothing matches.
 */
export function negotiateLocale(
  preferences: readonly string[] | string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  const list = typeof preferences === 'string' ? parseAcceptLanguage(preferences) : (preferences ?? []);
  for (const tag of list) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return fallback;
}

/** The tags of an `Accept-Language` header, most preferred first (`q=0` entries dropped). Bounded input. */
export function parseAcceptLanguage(header: string): string[] {
  const entries: { tag: string; q: number; i: number }[] = [];
  header
    .slice(0, 512)
    .split(',')
    .slice(0, 16)
    .forEach((part, i) => {
      const [rawTag, ...params] = part.trim().split(';');
      const tag = (rawTag ?? '').trim();
      if (tag === '' || tag === '*') return;
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
        if (m) q = Number(m[1]);
      }
      if (!Number.isFinite(q) || q <= 0) return;
      entries.push({ tag, q, i });
    });
  return entries.sort((a, b) => b.q - a.q || a.i - b.i).map((e) => e.tag);
}
