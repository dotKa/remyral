import { type ButtonHTMLAttributes, type ReactNode, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useSharedErrorText } from '../i18n/errors';
import { useSharedT } from '../i18n/scope';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2',
  danger: 'bg-surface text-danger border border-line-strong hover:bg-danger-soft',
  ghost: 'bg-transparent text-fg border border-transparent hover:bg-surface-2',
};

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: Variant;
    readonly busy?: boolean;
    readonly block?: boolean;
  },
): ReactNode {
  const { variant = 'primary', busy = false, block = false, className, children, disabled, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={cx(
        'relative inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium',
        'disabled:cursor-not-allowed disabled:opacity-60 sm:h-9',
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner(props: { readonly label?: string }): ReactNode {
  return (
    <span
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
      role={props.label ? 'status' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    />
  );
}

/** Seconds left until `retryAfterSeconds` (from the moment the error arrived) has elapsed. */
export function useRetryCountdown(error: ApiError | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const total = error?.retryAfterSeconds ?? 0;
    if (total <= 0) {
      setLeft(0);
      return;
    }
    const until = Date.now() + total * 1000;
    const tick = (): void => {
      setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      clearInterval(t);
    };
  }, [error]);
  return left;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${String(m)} min ${String(s).padStart(2, '0')} s` : `${String(s)} s`;
}

type Tone = 'danger' | 'warn' | 'info' | 'ok';

const TONES: Record<Tone, string> = {
  danger: 'border-danger/40 bg-danger-soft text-danger',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  info: 'border-line bg-surface-2 text-fg',
  ok: 'border-ok/40 bg-ok-soft text-ok',
};

export function Notice(props: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly live?: boolean;
}): ReactNode {
  return (
    <div
      role={props.live ? (props.tone === 'danger' ? 'alert' : 'status') : undefined}
      className={cx('rounded-md border px-3 py-2 text-sm', TONES[props.tone])}
    >
      {props.children}
    </div>
  );
}

/**
 * Shows an API error (classic: exactly as the master phrased it; Diyalog: in the user's language) — never which
 * factor failed — plus, for 429, the retry time from `Retry-After`. The surrounding region is always rendered so it
 * can be announced.
 */
export function ApiErrorNotice(props: {
  readonly error: ApiError | null;
  readonly retryLeft: number;
}): ReactNode {
  const { error, retryLeft } = props;
  // p14-i18n-shell / p14-i18n-errors: inside Diyalog the error (the console's own and the master's code + params)
  // and the wait follow the user's language; the classic console keeps the master's text and the English wait.
  const t = useSharedT();
  const say = useSharedErrorText();
  const e = t.shared.errors;
  return (
    <div aria-live="assertive" className="empty:hidden">
      {error ? (
        <Notice tone="danger">
          <span data-testid="api-error">{say(error)}</span>
          {error.retryAfterSeconds !== null && retryLeft > 0 ? (
            <span className="mt-0.5 block text-xs">
              {e.retryIn({ wait: e.wait({ seconds: retryLeft }) })}
            </span>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}

/** The catch-all `message` stays English (API / classic text); Diyalog shows `shared.errors.unknown` for it. */
export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong. Try again.');
}
