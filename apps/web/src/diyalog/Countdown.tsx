import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Messages, messagesFor } from '@remyral/i18n';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { useReducedMotion } from './motion';
import { FILL, INK, type Tone } from './tone';

/** "41:35" under an hour, "2:05:09" above, "0:00" when past. */
export function remainingText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${two(m)}:${two(sec)}` : `${String(m)}:${two(sec)}`;
}

/** Spoken form for the accessible name ("41 dakika", "2 saat 5 dakika"). Minutes only: a screen reader never ticks. */
export function remainingSpoken(
  ms: number,
  t: Messages['shell']['countdown'] = messagesFor('tr').shell.countdown,
): string {
  const min = Math.max(0, Math.ceil(ms / 60_000));
  if (min < 60) return t.minutes({ n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? t.hours({ n: h }) : t.hoursMinutes({ h, m });
}

/**
 * p12-diyalog: time left until something happens on its own (an approval goes stale, a waiting job pauses, a limit
 * window resets). Text ticks every second; with `from` a track shows the share of time left. Reduced motion: the
 * track jumps instead of gliding (no transition) — the numbers still update, they are information, not motion.
 * `role="timer"` is not announced on every tick; the accessible name is in minutes.
 */
export function Countdown(props: {
  readonly until: string;
  /** Start of the period: shows a track of the time left. */
  readonly from?: string | undefined;
  /** "Bayatlamaya", "Duraklamaya", "Sıfırlanma". */
  readonly label: string;
  readonly tone?: Tone | undefined;
  readonly onExpire?: (() => void) | undefined;
  /** Test seam: the clock. */
  readonly now?: (() => number) | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const clock = props.now ?? Date.now;
  const [now, setNow] = useState(clock);
  const reduced = useReducedMotion();
  const end = Date.parse(props.until);
  const left = end - now;
  const expired = left <= 0;
  const fired = useRef(false);
  const onExpire = props.onExpire;

  useEffect(() => {
    if (expired) return;
    const t = setInterval(() => {
      setNow(clock());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [clock, expired]);

  useEffect(() => {
    if (expired && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [expired, onExpire]);

  const words = useT().shell.countdown;
  const tone = props.tone ?? 'amber';
  const start = props.from === undefined ? null : Date.parse(props.from);
  const share = start === null || end <= start ? null : Math.min(1, Math.max(0, left / (end - start)));
  return (
    <div
      className={cx('grid gap-1.5', props.className)}
      data-motion={reduced ? 'reduce' : 'full'}
      data-expired={expired ? '' : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2.5 text-[0.84375rem]">
        <span className="text-dy-muted">{props.label}</span>
        <span
          role="timer"
          aria-label={`${props.label}: ${expired ? words.expired : words.left({ time: remainingSpoken(left, words) })}`}
          className={cx('font-dy-mono font-medium tabular-nums', INK[tone])}
        >
          {expired ? words.expired : remainingText(left)}
        </span>
      </div>
      {share === null ? null : (
        <div className="relative h-1.5 overflow-hidden rounded-full bg-dy-sunk" aria-hidden="true">
          <i
            className={cx('dy-track-fill absolute inset-0 rounded-full', FILL[tone])}
            style={{ transform: `scaleX(${String(share)})` }}
          />
        </div>
      )}
    </div>
  );
}
