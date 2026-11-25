import { type Locale, masterErrorSentence, type Messages } from '@remyral/i18n';
import { useCallback } from 'react';
import { ApiError, SESSION_REFRESHED } from '../api/client';
import { useLocale, useT } from './I18nProvider';
import { useInDiyalog, useSharedT } from './scope';

/**
 * p14-i18n-shell (i18n Phase 2): the sentence for an `ApiError` the console made itself — unreachable server,
 * an unexpected answer, a just-rotated session, `toApiError`'s catch-all — in the current language. Every other
 * code is the master's: `errorText` says it from the `errors` catalog.
 */
export function clientErrorText(t: Messages, err: ApiError): string {
  const e = t.shared.errors;
  switch (err.code) {
    case 'network_error':
      return err.status === 0 ? e.network : err.message;
    case 'unexpected_response':
      return e.unexpected;
    case SESSION_REFRESHED:
      return e.sessionRefreshed;
    case 'unknown':
      return err.status === 0 ? e.unknown : err.message;
    default:
      return err.message;
  }
}

const CLIENT_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'unexpected_response',
  SESSION_REFRESHED,
  'unknown',
]);

const warned = new Set<string>();

/**
 * p14-i18n-errors (i18n Phase 3, ADR-0053 §5): an API error in the reader's language — the console's own codes via
 * `clientErrorText`, the master's codes via the `errors` catalog with the body's `params` (`masterErrorSentence`).
 * A code, a variant or a value this console does not know (an older or newer master), or a code a domain error
 * reuses with its own sentence, shows the master's English `message`, as before (development builds warn once).
 */
export function errorText(t: Messages, locale: Locale, err: ApiError): string {
  if (CLIENT_CODES.has(err.code)) return clientErrorText(t, err);
  const sentence = masterErrorSentence(t, locale, err);
  if (sentence !== null) return sentence;
  if (import.meta.env.DEV && import.meta.env.MODE !== 'test' && !warned.has(err.code)) {
    warned.add(err.code);
    console.warn(`i18n: no "${locale}" sentence for master error ${err.code}; showing its message`);
  }
  return err.message;
}

/** Anything thrown → an `ApiError` (the catch-all keeps the English `message`; Diyalog says `shared.errors.unknown`). */
export function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong. Try again.');
}

/** Diyalog-only modules: `(err) => text` in the user's language (useT). */
export function useErrorText(): (err: unknown) => string {
  const t = useT();
  const { locale } = useLocale();
  return useCallback((err: unknown) => errorText(t, locale, asApiError(err)), [t, locale]);
}

/**
 * Modules both shells render (`components/ui`, …): the user's language inside the Diyalog scope; the master's
 * `message` verbatim in the classic console (by design, the classic console stays English as it was).
 */
export function useSharedErrorText(): (err: unknown) => string {
  const t = useSharedT();
  const inDiyalog = useInDiyalog();
  const { locale } = useLocale();
  return useCallback(
    (err: unknown) => {
      const e = asApiError(err);
      return inDiyalog ? errorText(t, locale, e) : e.message;
    },
    [t, locale, inDiyalog],
  );
}
