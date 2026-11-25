import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { toApiError } from '../../../components/ui';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useT } from '../../../i18n/I18nProvider';
import type { Formatter, Messages } from '@remyral/i18n';

/**
 * p12-diyalog-w2: shared pieces of the Kullanım tabs rebuilt in the Diyalog language — table cell classes, a
 * load-once hook, a step-up guarded action (same `useStepUp().run` as the classic panels; a cancelled step-up is
 * silent) and the user's-language wording for the classic client-side validation messages (the rules stay in the
 * classic helpers; only the sentence is translated — p14-i18n-screens-b: from the `usage.problems` catalog).
 */

export const TH = 'py-2 pr-4 text-left text-[0.78125rem] font-medium whitespace-nowrap text-dy-muted';
export const TD = 'py-2 pr-4 font-dy-mono text-[0.84375rem] tabular-nums';

/** `new Date(iso)` short in the user's language ("19 Eki 2026 14:05" / "19 Oct 2026, 14:05"). */
export function shortWhen(iso: string, f: Formatter): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return f.dateWith(d, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Agent time in hours: "1,5 sa" / "1.5 h" (whole hours from 10 h). */
export function hoursText(t: Messages['usage'], f: Formatter, ms: number): string {
  const digits = ms >= 36_000_000 ? 0 : 1;
  return t.hours({
    h: f.number(ms / 3_600_000, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  });
}

/** Loads once (and on `reload`); keeps the last value while reloading. */
export function useLoad<T>(fn: () => Promise<T>): {
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly reload: () => void;
  readonly set: (v: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then(
      (v) => {
        if (!live) return;
        setData(v);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [n]);
  const reload = useCallback(() => {
    setN((x) => x + 1);
  }, []);
  return { data, error, reload, set: setData };
}

/**
 * One write with step-up: `run(fn, reason)` → true when it went through, false when it failed (error kept) or the
 * person cancelled the code.
 */
export function useGuarded(): {
  readonly busy: boolean;
  readonly error: ApiError | null;
  readonly run: (fn: () => Promise<unknown>, reason: string, stepUp?: boolean) => Promise<boolean>;
  readonly clear: () => void;
} {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(
    async (fn: () => Promise<unknown>, reason: string, withStepUp = true): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        if (withStepUp) await stepUp.run(fn, reason);
        else await fn();
        return true;
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [stepUp],
  );
  const clear = useCallback(() => {
    setError(null);
  }, []);
  return { busy, error, run, clear };
}

type Problems = Messages['usage']['problems'];

// The classic helpers' English sentences (matched, never shown in Diyalog) → the catalog sentence.
const PROBLEMS: readonly (readonly [RegExp, (t: Problems, m: RegExpExecArray) => string])[] = [
  // PricesPanel.rowsToEntries
  [/^Row (\d+): provider and model are required\.$/, (t, m) => t.rowProviderModel({ row: m[1] ?? '' })],
  [/^Row (\d+): effective date is required\.$/, (t, m) => t.rowDate({ row: m[1] ?? '' })],
  [/^Row (\d+): input and output prices must be numbers ≥ 0\.$/, (t, m) => t.rowPrices({ row: m[1] ?? '' })],
  [/^Row (\d+): cache prices must be numbers ≥ 0 or empty\.$/, (t, m) => t.rowCache({ row: m[1] ?? '' })],
  [/^Row (\d+): say where the price comes from\.$/, (t, m) => t.rowSource({ row: m[1] ?? '' })],
  // BudgetsPanel.formToInput
  [/^Give the budget a name\.$/, (t) => t.budgetName],
  [/^Enter a limit greater than 0\.$/, (t) => t.limitPositive],
  [/^Use a whole number\.$/, (t) => t.wholeNumber],
  [/^Required for this scope\.$/, (t) => t.scopeRequired],
  [/^Up to five whole percentages from 1 to 100/, (t) => t.thresholds],
  [/^Subscription runs have no per-run dollars/, (t) => t.subscriptionDollars],
  [/^Enter a time zone/, (t) => t.timeZone],
  // usageLimits.usageLimitPolicyProblem
  [/^Wait at most between 0\.25 and 168 hours\.$/, (t) => t.maxWait],
  [/^At most four fallbacks\.$/, (t) => t.fallbackCount],
  [/^Each fallback \(runtime and profile\) once\.$/, (t) => t.fallbackOnce],
  [/^A fallback profile is a model catalog id/, (t) => t.fallbackProfile],
];

/** The classic validation sentence in the user's language (unknown sentences pass through unchanged). */
export function problemText(t: Problems, s: string): string {
  for (const [re, f] of PROBLEMS) {
    const m = re.exec(s);
    if (m !== null) return f(t, m);
  }
  return s;
}

export function useProblemText(): (s: string) => string {
  const t = useT().usage.problems;
  return (s) => problemText(t, s);
}
