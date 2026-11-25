import { type ReactNode, useId } from 'react';
import type { ApiError } from '../../../../api/client';
import { cx } from '../../../../components/ui';
import { DyApiError, DyNotice } from '../../forms';
import { ErrorLine, Pill, SkeletonRows } from '../../parts';
import { useT } from '../../../../i18n/I18nProvider';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Politika: small pieces shared by the policy panels (the load state, the
 * "saved" line, a radio-card group). Display only; every rule stays in the classic modules and the master.
 */

/** Loading skeleton or the read error of a policy panel (null when loaded). */
export function LoadState(props: {
  readonly loaded: boolean;
  readonly error: ApiError | null;
  readonly what: string;
  readonly onRetry?: (() => void) | undefined;
  /** Placeholder rows, about the loaded panel's height (p12-diyalog-default visual tour: no jump on load). */
  readonly rows?: number | undefined;
}): ReactNode {
  const t = useT().projects.policy;
  if (props.loaded) return null;
  if (props.error !== null)
    return <ErrorLine error={props.error} what={props.what} onRetry={props.onRetry} />;
  return (
    <div className="-mx-4">
      <SkeletonRows label={t.loading({ what: props.what })} rows={props.rows ?? 2} />
    </div>
  );
}

/**
 * The save error with the Retry-After wait, next to the form. p17-toasts-shortcuts: the "Kaydedildi" result is a
 * toast (it used to be a green line here).
 */
export function SaveResult(props: {
  readonly done: string | null;
  readonly error: ApiError | null;
  readonly retryLeft: number;
}): ReactNode {
  useDoneToast(props.done, { testId: 'policy-saved' });
  return <DyApiError error={props.error} retryLeft={props.retryLeft} />;
}

export interface RadioOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: ReactNode;
  readonly badge?: string | undefined;
}

/** A radio group as selectable cards (native radios: arrow keys, one tab stop). */
export function RadioCardGroup<T extends string>(props: {
  readonly legend: string;
  readonly value: T;
  readonly options: readonly RadioOption<T>[];
  readonly onChange: (v: T) => void;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const name = useId();
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" data-testid={props.testId} disabled={props.disabled}>
      <legend className="mb-1.5 p-0 text-[0.8125rem] font-bold">{props.legend}</legend>
      <div className="grid gap-2 md:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
        {props.options.map((o) => {
          const on = o.value === props.value;
          return (
            <label
              key={o.value}
              className={cx(
                'flex min-w-0 cursor-pointer gap-2.5 rounded-[11px] border px-3 py-2.5 text-[0.875rem] has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-dy-teal',
                on ? 'border-dy-ink bg-dy-sunk' : 'border-dy-line bg-dy-card',
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                onChange={() => {
                  props.onChange(o.value);
                }}
                className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 font-bold">
                  {o.label}
                  {o.badge === undefined ? null : <Pill tone="neutral">{o.badge}</Pill>}
                </span>
                {o.description === undefined ? null : (
                  <span className="mt-0.5 block text-[0.8125rem] text-dy-muted">{o.description}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The classic client-side validation sentences in the user's language (the same validators decide; unknown text
 * passes). The validator's English sentence picks the catalog entry.
 */
export function useProblemText(): (p: string | null) => string | null {
  const t = useT().projects.policy.problems;
  return (p) => {
    switch (p) {
      case null:
        return null;
      case 'Use 24-hour times such as 22:00 and 07:00.':
        return t.time24;
      case 'Start and end must differ.':
        return t.startEnd;
      case 'Enter a time zone such as Europe/Istanbul.':
        return t.timeZone;
      case 'Wait at most between 0.25 and 168 hours.':
        return t.maxWait;
      case 'At most four fallbacks.':
        return t.fallbackCount;
      case 'Each fallback (runtime and profile) once.':
        return t.fallbackOnce;
      case 'A fallback profile is a model catalog id such as anthropic-api.':
        return t.fallbackProfile;
      case 'Exploration must be a whole number from 0 to 30 %.':
        return t.exploration;
      case 'Minimum jobs must be from 3 to 100.':
        return t.minSamples;
      case 'Half-life must be from 7 to 365 days.':
        return t.halfLife;
      case 'Rerun window must be from 0 to 30 days.':
        return t.rerunWindow;
      case 'Every path rule needs at least one glob.':
        return t.pathGlob;
      default:
        return p;
    }
  };
}

export function ProblemLine(props: { readonly problem: string | null }): ReactNode {
  return props.problem === null ? null : (
    <DyNotice tone="amber" live>
      {props.problem}
    </DyNotice>
  );
}
