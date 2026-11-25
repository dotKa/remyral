import {
  createFormatter,
  DEFAULT_LOCALE,
  type Formatter,
  hasCatalog,
  isLocale,
  loadCatalog,
  type Locale,
  type Messages,
  messagesFor,
  negotiateLocale,
} from '@remyral/i18n';
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useState } from 'react';

/**
 * p14-i18n-foundation (ADR-0053): the console language. One provider at the app root holds the locale and hands
 * out the typed catalog (`useT()`), the bound formatters (`useFormat()`) and the switch (`useLocale()`).
 *
 * Where the language comes from (by design):
 *   signed in    the master's `users.locale` (via `GET /auth/session`, Turkish when never chosen);
 *   before that  the last language used in this browser (`localStorage['remyral.locale']`), else the browser's
 *                languages (`navigator.languages` negotiated to tr / en), else Turkish.
 * The stored value is a convenience, never a security input; a broken or blocked storage just falls through.
 *
 * Without a provider (component tests) everything is Turkish — the Diyalog default.
 */

export const LOCALE_STORAGE_KEY = 'remyral.locale';

export function readStoredLocale(): Locale | null {
  try {
    const v = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts for this page view.
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  const list = navigator.languages as readonly string[] | undefined;
  if (list !== undefined && list.length > 0) return list;
  return typeof navigator.language === 'string' && navigator.language !== '' ? [navigator.language] : [];
}

/** The language before the master has spoken: this browser's last choice → the browser language → Turkish. */
export function initialLocale(): Locale {
  return readStoredLocale() ?? negotiateLocale(browserLanguages(), DEFAULT_LOCALE);
}

export interface I18nValue {
  readonly locale: Locale;
  readonly t: Messages;
  readonly format: Formatter;
  /** Switches the language now (no reload) and saves it; rolls back and rejects when saving fails. */
  readonly changeLocale: (locale: Locale) => Promise<void>;
}

function valueFor(locale: Locale, changeLocale: I18nValue['changeLocale']): I18nValue {
  return { locale, t: messagesFor(locale), format: createFormatter(locale), changeLocale };
}

const FALLBACK: I18nValue = valueFor(DEFAULT_LOCALE, () =>
  Promise.reject(new Error('changeLocale needs an <I18nProvider>')),
);

const I18nContext = createContext<I18nValue>(FALLBACK);

export function I18nProvider(props: {
  readonly children: ReactNode;
  /** A fixed language (the classic console later, tests): the stored/session language is ignored. */
  readonly locale?: Locale;
  /** The signed-in user's language from the master; adopted (and remembered in this browser) when it changes. */
  readonly sessionLocale?: Locale | undefined;
  /** Persists a choice (PUT /me/locale). Without it a choice only lasts in this browser. */
  readonly save?: (locale: Locale) => Promise<void>;
}): ReactNode {
  const { sessionLocale, save } = props;
  const [chosen, setChosen] = useState<Locale>(() => props.locale ?? sessionLocale ?? initialLocale());

  useEffect(() => {
    if (sessionLocale === undefined) return;
    let live = true;
    // p14-web-perf-2: the catalog first, then the switch (no half-translated frame).
    void loadCatalog(sessionLocale)
      .catch(() => undefined)
      .then(() => {
        if (!live) return;
        setChosen(sessionLocale);
        storeLocale(sessionLocale);
      });
    return () => {
      live = false;
    };
  }, [sessionLocale]);

  const changeLocale = useCallback(
    async (next: Locale) => {
      const previous = chosen;
      await loadCatalog(next);
      setChosen(next);
      storeLocale(next);
      try {
        await save?.(next);
      } catch (err) {
        setChosen(previous);
        storeLocale(previous);
        throw err;
      }
    },
    [save, chosen],
  );

  const locale = props.locale ?? chosen;
  // A fixed or remembered language whose catalog is still loading: re-render once it is there.
  const [catalogs, setCatalogs] = useState(0);
  const ready = hasCatalog(locale);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void loadCatalog(locale).then(
      () => {
        if (live) setCatalogs((n) => n + 1);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [locale, ready]);
  const value = useMemo(
    () => valueFor(locale, changeLocale),
    // `catalogs`: a new value once the language's catalog arrived.
    [locale, changeLocale, catalogs],
  );
  return <I18nContext value={value}>{props.children}</I18nContext>;
}

/** The typed catalog of the current language: `t.nav.jobs`, `t.common.machineCount({ n })`. */
export function useT(): Messages {
  return use(I18nContext).t;
}

/** Dates, numbers, sizes and durations in the current language. */
export function useFormat(): Formatter {
  return use(I18nContext).format;
}

export function useLocale(): Pick<I18nValue, 'locale' | 'changeLocale'> {
  const { locale, changeLocale } = use(I18nContext);
  return { locale, changeLocale };
}

/**
 * Sets `<html lang>` to the current language while the calling shell is mounted (screen readers, hyphenation)
 * and restores the previous value afterwards — the classic console keeps its English `lang`.
 */
export function useDocumentLang(): void {
  const { locale } = use(I18nContext);
  useEffect(() => {
    const el = document.documentElement;
    const before = el.lang;
    el.lang = locale;
    return () => {
      el.lang = before;
    };
  }, [locale]);
}
