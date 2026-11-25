import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { DyIcon, type IconName } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import type { JobStep, StepStatus } from './steps';
import { Swap } from '../motionKit';

/**
 * p12-diyalog panels: the job's step progress bar across the top of the control panel (steps from `jobSteps`).
 * An ordered list: each step a segment (colour) + icon + word + a short note; the current step carries
 * `aria-current="step"`. Phones keep the segments and spell out the current step in one line under them.
 * p17-panel-motion: each segment is a track with a fill — a step that starts or ends fills from the left and changes
 * colour over --dy-m-fill (a transform; the first render stands still, none under reduced motion), and the step's word
 * comes in through the state swap.
 */

const SEG: Readonly<Record<StepStatus, string>> = {
  done: 'bg-dy-teal',
  current: 'bg-dy-teal dy-breathe',
  needs: 'bg-dy-amber',
  paused: 'bg-dy-violet',
  failed: 'bg-dy-red',
  todo: 'bg-dy-line',
  skipped: 'bg-[repeating-linear-gradient(90deg,var(--dy-line-2)_0_4px,transparent_4px_7px)]',
};

const ICON: Readonly<Record<StepStatus, IconName | null>> = {
  done: 'check',
  current: 'retry',
  needs: 'shield',
  paused: 'pause',
  failed: 'xc',
  todo: null,
  skipped: 'xc',
};

const INK: Readonly<Record<StepStatus, string>> = {
  done: 'text-dy-ink',
  current: 'text-dy-teal-ink',
  needs: 'text-dy-amber-ink',
  paused: 'text-dy-violet',
  failed: 'text-dy-red-ink',
  todo: 'text-dy-faint',
  skipped: 'text-dy-faint',
};

const LIVE = new Set<StepStatus>(['current', 'needs', 'paused', 'failed']);

export function StepBar(props: { readonly steps: readonly JobStep[] }): ReactNode {
  const { steps } = props;
  const w = useT().job.steps;
  const nowIdx = steps.findIndex((s) => LIVE.has(s.status));
  const now = nowIdx < 0 ? steps.at(-1) : steps[nowIdx];
  return (
    <nav aria-label={w.nav} data-testid="dy-steps">
      <ol className="m-0 flex list-none gap-1 p-0 sm:gap-1.5">
        {steps.map((s, i) => {
          const icon = ICON[s.status];
          const isNow = i === nowIdx;
          return (
            <li
              key={s.key}
              data-step={s.key}
              data-status={s.status}
              aria-current={isNow ? 'step' : undefined}
              className="min-w-0 flex-1"
            >
              <span
                aria-hidden="true"
                className={cx(
                  'block h-1.5 overflow-hidden rounded-full',
                  s.status === 'skipped' ? 'bg-transparent' : 'bg-dy-line',
                )}
              >
                <span
                  className={cx('dy-m-fill block h-full', SEG[s.status])}
                  style={s.status === 'todo' ? { transform: 'scaleX(0)' } : undefined}
                />
              </span>
              <span
                className={cx(
                  'mt-1.5 hidden min-w-0 items-center gap-1 text-[0.8125rem] leading-tight sm:flex',
                  INK[s.status],
                  isNow ? 'font-bold' : 'font-medium',
                )}
              >
                {icon === null ? (
                  <span className="size-3 shrink-0 rounded-full border border-current" aria-hidden="true" />
                ) : (
                  <DyIcon name={icon} className="size-3.5 shrink-0" />
                )}
                <Swap k={s.status} className="min-w-0 truncate">
                  {s.label}
                </Swap>
              </span>
              <span className="mt-0.5 hidden truncate text-[0.75rem] text-dy-muted tabular-nums sm:block">
                {s.note ?? ' '}
              </span>
              <span className="sr-only">{`${s.label}: ${w.status[s.status]}${s.note === null ? '' : `, ${s.note}`}`}</span>
            </li>
          );
        })}
      </ol>
      {now === undefined ? null : (
        <p aria-hidden="true" className={cx('m-0 mt-1.5 text-[0.8125rem] sm:hidden', INK[now.status])}>
          <b>{`${String(Math.max(0, steps.indexOf(now)) + 1)}/${String(steps.length)} ${now.label}`}</b>
          {now.note === null ? '' : ` · ${now.note}`}
        </p>
      )}
    </nav>
  );
}
