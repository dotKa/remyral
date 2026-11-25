import type { ReactNode } from 'react';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { DyIcon, type IconName } from './icons';
import { useChangeCount } from './motionKit';
import { INK, type Tone } from './tone';

/**
 * p12-diyalog: one state vocabulary for every card and row — colour + shape + word (never colour alone). The live
 * states (running) breathe; the rest stand still. p17-panel-motion: a state that changes while the badge is shown
 * (Onay bekliyor → Çalışıyor) comes in through a short blur cross-fade (`dy-m-swap`); the first render stands still,
 * and a label-only change ("3/5" → "4/5") does not move.
 */
export type DyState = 'running' | 'queued' | 'needs' | 'paused' | 'stale' | 'failed' | 'done' | 'cancelled';

/** The word comes from the `shared.state` catalog (i18n Phase 2). */
const STATE: Readonly<Record<DyState, { tone: Tone; icon: IconName }>> = {
  running: { tone: 'teal', icon: 'retry' },
  queued: { tone: 'neutral', icon: 'clock' },
  needs: { tone: 'amber', icon: 'shield' },
  paused: { tone: 'violet', icon: 'pause' },
  stale: { tone: 'amber', icon: 'clock' },
  failed: { tone: 'red', icon: 'xc' },
  done: { tone: 'green', icon: 'checkc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

export function stateTone(s: DyState): Tone {
  return STATE[s].tone;
}

export function StateBadge(props: {
  readonly state: DyState;
  /** Replaces the default word ("Çalışıyor 3/5", "Bayat, 18 dk"). */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const s = STATE[props.state];
  const words = useT().shared.state;
  const changed = useChangeCount(props.state);
  return (
    <span
      key={changed}
      data-state={props.state}
      className={cx(
        'inline-flex items-center gap-1.5 text-[0.78125rem] font-bold whitespace-nowrap',
        changed > 0 && 'dy-m-swap',
        INK[s.tone],
        props.className,
      )}
    >
      <DyIcon
        name={s.icon}
        className={cx('size-[13px] shrink-0', props.state === 'running' && 'dy-breathe')}
      />
      {props.label ?? words[props.state]}
    </span>
  );
}
