import { type ReactNode, useCallback, useEffect } from 'react';
import { getOp, type Op, type OpState, TERMINAL_STATES } from '../../../../api/remoteOps';
import type { SandboxProfile } from '../../../../api/sandbox';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { DyIcon, type IconName } from '../../../icons';
import { INK, type Tone } from '../../../tone';
import { TR_FORMAT } from '../../../common/time';
import type { Formatter, Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3, machine-config): small pieces shared by the Araçlar, Sandbox ve politika and Yapılandırma
 * tabs — the step-up wrapper the classic panels use (cancel = no change, no error), the remote-operation poll (same
 * 1.5 s cadence as the classic cards) and the operation state in words.
 */

export const OP_POLL_MS = 1_500;

/** `stepUp.run` that turns a cancelled code prompt into `null` (nothing happens, no error), as in the classic panels. */
export function useGuarded(): <T>(fn: () => Promise<T>, why: string) => Promise<T | null> {
  const stepUp = useStepUp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, why: string): Promise<T | null> => {
      try {
        return await stepUp.run(fn, why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return null;
        throw err;
      }
    },
    [stepUp],
  );
}

/** Polls a running remote operation until it ends; `onDone` after the terminal state (reload the status). */
export function useOpPoll(
  workerId: string,
  op: Op | null,
  setOp: (op: Op) => void,
  onDone: () => void,
): void {
  useEffect(() => {
    if (op === null || TERMINAL_STATES.has(op.state)) return;
    let live = true;
    const timer = setTimeout(() => {
      getOp(workerId, op.id).then(
        (next) => {
          if (!live) return;
          setOp(next);
          if (TERMINAL_STATES.has(next.state)) onDone();
        },
        () => undefined,
      );
    }, OP_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [op, workerId, setOp, onDone]);
}

type SharedText = Messages['machineConfig']['shared'];

const OP_LOOK: Readonly<Record<OpState, { tone: Tone; icon: IconName }>> = {
  sent: { tone: 'teal', icon: 'send' },
  accepted: { tone: 'teal', icon: 'retry' },
  running: { tone: 'teal', icon: 'retry' },
  waiting_for_user: { tone: 'amber', icon: 'clock' },
  succeeded: { tone: 'green', icon: 'checkc' },
  failed: { tone: 'red', icon: 'xc' },
  refused: { tone: 'red', icon: 'xc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
  lost: { tone: 'red', icon: 'xc' },
};

export function opLook(state: OpState, t: SharedText): { word: string; tone: Tone; icon: IconName } {
  return { ...OP_LOOK[state], word: t.opStates[state] };
}

/** One line for a remote operation: state word + icon, what runs now, the worker's detail and reason. */
export function OpLine(props: {
  readonly op: Op;
  readonly what: string;
  readonly testId?: string;
}): ReactNode {
  const t = useT().machineConfig.shared;
  const { op } = props;
  const look = opLook(op.state, t);
  const running = !TERMINAL_STATES.has(op.state);
  return (
    <p
      role="status"
      data-testid={props.testId}
      data-state={op.state}
      className="m-0 flex flex-wrap items-start gap-x-2 gap-y-0.5 text-[0.875rem]"
    >
      <span className={`inline-flex items-center gap-1.5 font-bold ${INK[look.tone]}`}>
        <DyIcon name={look.icon} className={`size-4 shrink-0 ${running ? 'dy-breathe' : ''}`} />
        {props.what}: {look.word}
      </span>
      {op.progress !== null ? <span className="text-dy-muted">· {op.progress.step}</span> : null}
      {op.detail !== null ? <span className="min-w-0 [overflow-wrap:anywhere]">— {op.detail}</span> : null}
      {op.reason !== null && op.state !== 'succeeded' ? (
        <span className="font-dy-mono text-[0.8125rem] text-dy-muted">({op.reason})</span>
      ) : null}
    </p>
  );
}

/** A short date-time for facts ("19.10.2026 14:05"); Turkish unless a formatter is given. */
export function whenText(iso: string | null | undefined, f: Formatter = TR_FORMAT): string {
  if (iso === null || iso === undefined) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return f.dateWith(t, { dateStyle: 'short', timeStyle: 'short' });
}

const PROFILE_KEY: Readonly<Record<SandboxProfile, keyof SharedText['profiles']>> = {
  container: 'container',
  'runtime-sandbox': 'runtimeSandbox',
  'host-restricted': 'hostRestricted',
  unconfined: 'unconfined',
};

/** A sandbox profile's name in the user's language (the raw id stays visible where it matters). */
export function profileName(profile: SandboxProfile, t: SharedText): string {
  return t.profiles[PROFILE_KEY[profile]];
}
