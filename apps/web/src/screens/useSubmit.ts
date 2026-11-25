import { useCallback, useState } from 'react';
import type { ApiError } from '../api/client';
import { toApiError, useRetryCountdown } from '../components/ui';

/** Busy/error state for one form submission. While a 429 retry time runs, `blocked` is true. */
export function useSubmit(): {
  busy: boolean;
  error: ApiError | null;
  retryLeft: number;
  blocked: boolean;
  run: (fn: () => Promise<void>) => Promise<boolean>;
  clearError: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const retryLeft = useRetryCountdown(error);
  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(toApiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => {
    setError(null);
  }, []);
  return { busy, error, retryLeft, blocked: retryLeft > 0, run, clearError };
}

/** Keeps digits only (users paste "123 456"), at most `max`. */
export function digitsOnly(value: string, max = 6): string {
  return value.replace(/\D/g, '').slice(0, max);
}

export const CODE_PATTERN = /^\d{6}$/;

/**
 * p5-mobile: true when a change filled a complete code in one go — the iOS/Android one-time-code autofill
 * (QuickType bar / autofill service), a password manager or a paste — rather than a keystroke. Typing the
 * last digit by hand is not a bulk entry, so a typist still confirms with the button.
 */
export function isBulkCodeEntry(previous: string, next: string): boolean {
  return CODE_PATTERN.test(next) && next.length - previous.length >= 2;
}
