import type { Locale } from '@remyral/i18n';
import { useCallback, useState } from 'react';
import { useLocale } from './I18nProvider';

export interface LanguageChoice {
  readonly locale: Locale;
  readonly choose: (locale: Locale) => Promise<void>;
  readonly busy: boolean;
  /** Why the last change failed (the master's message; the switch was rolled back). */
  readonly error: string | null;
  readonly saved: boolean;
}

/**
 * Profile → "Dil / Language" (both shells): switches the console language at once and saves it on the master;
 * a failed save rolls the language back and reports why.
 */
export function useLanguageChoice(): LanguageChoice {
  const { locale, changeLocale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const choose = useCallback(
    async (next: Locale) => {
      if (next === locale) return;
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        await changeLocale(next);
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [locale, changeLocale],
  );
  return { locale, choose, busy, error, saved };
}
