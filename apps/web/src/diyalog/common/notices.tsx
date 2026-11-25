import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { ApiError } from '../../api/client';
import { cx, useRetryCountdown } from '../../components/ui';
import { messagesFor } from '@remyral/i18n';
import { errorText } from '../../i18n/errors';
import { useLocale, useT } from '../../i18n/I18nProvider';
import type { ReasonContext, ReasonParams } from '../../lib/reasons';
import { useDescribeReason } from '../../i18n/reasons';
import { DyIcon, type IconName } from '../icons';
import { SOFT, type Tone } from '../tone';

/**
 * p12-diyalog-final: the notices of the Diyalog UI, once (the W2 kit, the W3 forms, the W4 forms and the composer
 * re-export these) — the classic `Notice`, `ApiErrorNotice` and `ReasonNotice` in the Diyalog language:
 *
 *   - DyNotice    a soft band with an icon and words in the five meaning tones (tone never carries meaning alone);
 *   - DyApiError  the error in the user's language (p14-i18n-errors: the master's code + params through the
 *                 `errors` catalog, its English message for an unknown code; never which factor failed) and, for a 429, the
 *                 `Retry-After` countdown in Turkish ("1 dk 05 sn sonra yeniden deneyebilirsin."); the live region is
 *                 always rendered so the error is announced;
 *   - DyReason    a reported reason code in the user's language (p14-i18n-reasons: `lib/reasons.ts` over the
 *                 `reasons` catalog, the variant from the reason's params) with its fix link, the raw code and text
 *                 under "Ayrıntı"; unknown codes show the raw text.
 */

const NOTICE_ICON: Readonly<Record<Tone, IconName>> = {
  teal: 'bubble',
  amber: 'shield',
  red: 'xc',
  green: 'checkc',
  violet: 'gauge',
  neutral: 'bubble',
};

/** A notice band: icon + words on a soft tone. `live` announces it (red as an alert, the others politely). */
export function DyNotice(props: {
  readonly tone: Tone;
  readonly children?: ReactNode;
  readonly live?: boolean | undefined;
  readonly icon?: IconName | undefined;
  /** A bold first line. */
  readonly title?: ReactNode;
  /** Buttons / links at the end of the band (they wrap under the text on phones). */
  readonly action?: ReactNode;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <div
      role={props.live === true ? (props.tone === 'red' ? 'alert' : 'status') : undefined}
      data-testid={props.testId}
      className={cx(
        'dy-notice flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-[var(--dy-r-band)] px-3.5 py-2.5 text-[0.875rem] leading-snug',
        SOFT[props.tone],
        props.className,
      )}
    >
      <DyIcon name={props.icon ?? NOTICE_ICON[props.tone]} className="mt-0.5 size-4 shrink-0" />
      {/* p17-ui-review: the words keep a readable width; on a phone the action wraps under them instead of squeezing
          them into a narrow column. */}
      <div className="min-w-[min(100%,15rem)] flex-1 [overflow-wrap:anywhere]">
        {props.title === undefined ? null : <p className="m-0 font-bold">{props.title}</p>}
        {props.children}
      </div>
      {props.action === undefined || props.action === null ? null : (
        <div className="flex flex-wrap items-center gap-2">{props.action}</div>
      )}
    </div>
  );
}

const TR = messagesFor('tr');

/** "2 dk 05 sn" / "40 sn" — the Turkish form of the classic `formatDuration` (the catalog's `shared.errors.wait`). */
export function durationTr(seconds: number): string {
  return TR.shared.errors.wait({ seconds });
}

/** The wait sentence under a 429, in `t`'s language (Turkish by default). */
export function retryText(seconds: number, t: Pick<typeof TR, 'shared'> = TR): string {
  const e = t.shared.errors;
  return e.retryIn({ wait: e.wait({ seconds }) });
}

/**
 * The API error band. `retryLeft` comes from `useSubmit().retryLeft` (which also blocks resubmission); without it
 * the band counts the `Retry-After` wait down itself (the classic `useRetryCountdown`), so every error with a wait
 * says when to try again.
 */
export function DyApiError(props: {
  readonly error: ApiError | null;
  readonly retryLeft?: number | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const { error } = props;
  const t = useT();
  const { locale } = useLocale();
  const own = useRetryCountdown(props.retryLeft === undefined ? error : null);
  const left = props.retryLeft ?? own;
  return (
    <div aria-live="assertive" className={cx('empty:hidden', props.className)}>
      {error === null ? null : (
        <DyNotice tone="red">
          <span data-testid="api-error">{errorText(t, locale, error)}</span>
          {error.retryAfterSeconds !== null && left > 0 ? (
            <span className="mt-0.5 block text-[0.8125rem]" data-testid="retry-left">
              {retryText(left, t)}
            </span>
          ) : null}
        </DyNotice>
      )}
    </div>
  );
}

const REASON_TONE: Readonly<Record<'attention' | 'danger' | 'neutral', Tone>> = {
  attention: 'amber',
  danger: 'red',
  neutral: 'neutral',
};

/**
 * A reported reason in plain Turkish with the action that fixes it, the raw code and text under "Ayrıntı". `tone`
 * takes a Diyalog tone or the classic `attention` / `danger` / `neutral`; `compact` drops the band (inside rows);
 * `action` replaces the mapped fix (a screen that fixes it in place).
 */
export function DyReason(props: {
  readonly reason: string;
  readonly context?: ReasonContext | undefined;
  /** p14-i18n-reasons: the reason's params as reported (`cause` picks the sentence variant). */
  readonly params?: ReasonParams | null | undefined;
  readonly tone?: Tone | 'attention' | 'danger' | 'neutral' | 'warn' | 'info' | undefined;
  readonly compact?: boolean | undefined;
  readonly action?: ReactNode;
  readonly className?: string | undefined;
}): ReactNode {
  const t = useT();
  const info = useDescribeReason()(props.reason, props.context, props.params);
  const raw = props.tone ?? 'amber';
  const tone: Tone =
    raw === 'attention' || raw === 'danger' || raw === 'neutral'
      ? REASON_TONE[raw]
      : raw === 'warn'
        ? 'amber'
        : raw === 'info'
          ? 'neutral'
          : raw;
  const { pathname } = useLocation();
  // A fix that only opens the machine's own page is no fix on that page (its tabs are right there).
  const selfLink =
    info.action !== null &&
    props.context?.workerId != null &&
    info.action.href === `/machines?${new URLSearchParams({ worker: props.context.workerId }).toString()}` &&
    pathname.startsWith(`/machines/${encodeURIComponent(props.context.workerId)}`);
  const action =
    props.action ??
    (info.action === null || selfLink ? null : (
      <Link
        to={info.action.href}
        className="dy-press inline-flex min-h-9 items-center rounded-lg px-1 text-[0.8125rem] font-bold whitespace-nowrap text-current underline underline-offset-2"
      >
        {info.action.label}
      </Link>
    ));
  const body = (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="m-0 min-w-[min(100%,14rem)] flex-1">{info.sentence}</p>
        {action}
      </div>
      {info.known && info.raw.trim() !== '' ? (
        <details className="mt-1 text-[0.75rem] opacity-85">
          <summary className="w-fit cursor-pointer select-none">{t.shared.details}</summary>
          <p className="m-0 mt-1 font-dy-mono break-words whitespace-pre-wrap">{info.raw}</p>
        </details>
      ) : null}
    </>
  );
  if (props.compact === true)
    return (
      <div data-reason={info.code ?? undefined} className={cx('text-[0.84375rem]', props.className)}>
        {body}
      </div>
    );
  return (
    <div
      data-reason={info.code ?? undefined}
      className={cx(
        'flex items-start gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[0.875rem]',
        SOFT[tone],
        props.className,
      )}
    >
      <DyIcon name={NOTICE_ICON[tone]} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{body}</div>
    </div>
  );
}
