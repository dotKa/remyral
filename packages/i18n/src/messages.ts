import enErrors from './en/errors.js';
import type { Locale } from './locale.js';
import type { Shape } from './shape.js';
import { tr } from './tr/index.js';

/** Every message of one language, accessed by property: `t.nav.jobs`, `t.common.machineCount({ n })`. */
export type Messages = Shape<typeof tr>;

/**
 * p14-web-perf-2 (docs/design/p14-followups.md §3): only the active language is in a page's initial JS. Turkish (the
 * default, and the fallback many modules read at import time) is always here; English is loaded with
 * {@link loadCatalog} (a dynamic `import()`, its own chunk in the console). Node callers that need both languages
 * synchronously (the master, catalog tests) import `@remyral/i18n/all`, which registers English at import.
 */
const loaded: Partial<Record<Locale, Messages>> = { tr };
let pendingEn: Promise<Messages> | undefined;

/**
 * The English error sentences, always bundled: `masterErrorSentence` translates a master error without params only
 * when the master's English `message` equals this catalog's sentence — in every language.
 */
export const EN_ERRORS: Messages['errors'] = enErrors;

/** Makes a loaded catalog available to {@link messagesFor} (used by `@remyral/i18n/all` and {@link loadCatalog}). */
export function registerCatalog(locale: Locale, messages: Messages): void {
  loaded[locale] = messages;
}

/** Whether `locale`'s catalog is loaded (Turkish always is). */
export function hasCatalog(locale: Locale): boolean {
  return loaded[locale] !== undefined;
}

/** Loads `locale`'s catalog once (idempotent; a failed load is retried on the next call). */
export function loadCatalog(locale: Locale): Promise<Messages> {
  const have = loaded[locale];
  if (have !== undefined) return Promise.resolve(have);
  pendingEn ??= import('./en/index.js').then(
    (m) => {
      registerCatalog('en', m.en);
      return m.en;
    },
    (err: unknown) => {
      pendingEn = undefined;
      throw err;
    },
  );
  return pendingEn;
}

/**
 * The catalog of `locale`. A language that is not loaded yet answers with Turkish (never throws) and starts its
 * load; the console loads the active language before it renders it (main.tsx, I18nProvider).
 */
export function messagesFor(locale: Locale): Messages {
  const have = loaded[locale];
  if (have !== undefined) return have;
  loadCatalog(locale).catch(() => undefined);
  return tr;
}
