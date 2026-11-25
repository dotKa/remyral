import { type ReactNode, useCallback } from 'react';
import { type Op, TERMINAL_STATES } from '../../../../api/remoteOps';
import { DyActor } from '../../../common/actor';
import { runtimeName } from '../../../../lib/reasons';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { DyIcon, type IconName } from '../../../icons';
import { INK, type Tone } from '../../../tone';
import { Pill } from '../../parts';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — machine page, Runtime’lar and Etkinlik: the words for remote operations (the classic
 * `OpLine` of `screens/fleet/RemoteOpsPanel.tsx` in the Diyalog language) and the step-up wrapper that returns the
 * started operation (a cancelled code dialog is not an error, as classic).
 */

export interface Look {
  readonly tone: Tone;
  readonly icon: IconName;
  readonly word: string;
}

type OpsText = Messages['machineRuntimes']['ops'];

/** Operation kind → catalog key (`machineRuntimes.ops.kinds`). */
const OP_KEY: Readonly<Record<string, keyof OpsText['kinds']>> = {
  'runtime.install': 'runtimeInstall',
  'runtime.remove': 'runtimeRemove',
  'runtime.restart': 'runtimeRestart',
  'login.start': 'loginStart',
  'login.status': 'loginStatus',
  'login.logout': 'loginLogout',
  'service.restart': 'serviceRestart',
  'logs.tail': 'logsTail',
  'diagnostics.run': 'diagnosticsRun',
  'usage.refresh': 'usageRefresh',
  'doctor.run': 'doctorRun',
  'disk.clean': 'diskClean',
  // p17-runtime-verify
  'runtime.capabilities.verify': 'runtimeCapabilitiesVerify',
};

/** The words for an operation kind ("Kurulum"); the raw kind when unknown. */
export function opWord(kind: string, t: OpsText): string {
  const key = OP_KEY[kind];
  return key === undefined ? kind : t.kinds[key];
}

const OP_STATE: Readonly<Record<string, Omit<Look, 'word'>>> = {
  sent: { tone: 'teal', icon: 'send' },
  accepted: { tone: 'teal', icon: 'retry' },
  running: { tone: 'teal', icon: 'retry' },
  waiting_for_user: { tone: 'amber', icon: 'shield' },
  succeeded: { tone: 'green', icon: 'checkc' },
  failed: { tone: 'red', icon: 'xc' },
  refused: { tone: 'red', icon: 'xc' },
  lost: { tone: 'red', icon: 'xc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

function wordOf(words: object, key: string): string | undefined {
  return (words as Readonly<Record<string, string | undefined>>)[key];
}

export function opLook(state: string, t: OpsText): Look {
  const look = OP_STATE[state];
  const word = wordOf(t.states, state);
  return look === undefined || word === undefined
    ? { tone: 'neutral', icon: 'clock', word: state.replaceAll('_', ' ') }
    : { ...look, word };
}

/** Runtime readiness (fleet compatibility) and subscription-login states, as word + icon + tone. */
const RUNTIME_STATE: Readonly<Record<string, Omit<Look, 'word'>>> = {
  ready: { tone: 'green', icon: 'checkc' },
  degraded: { tone: 'amber', icon: 'shield' },
  unverified: { tone: 'amber', icon: 'clock' },
  not_installed: { tone: 'neutral', icon: 'tray' },
  not_allowed: { tone: 'neutral', icon: 'xc' },
  not_authenticated: { tone: 'amber', icon: 'key' },
  pin_mismatch: { tone: 'amber', icon: 'flag' },
  unsupported: { tone: 'neutral', icon: 'xc' },
  unknown: { tone: 'neutral', icon: 'clock' },
  logged_in: { tone: 'green', icon: 'checkc' },
  logged_out: { tone: 'amber', icon: 'key' },
  expired: { tone: 'amber', icon: 'clock' },
};

export function runtimeLook(state: string, t: OpsText): Look {
  const look = RUNTIME_STATE[state];
  const word = wordOf(t.runtimeStates, state);
  return look === undefined || word === undefined
    ? { tone: 'neutral', icon: 'clock', word: state.replaceAll('_', ' ') }
    : { ...look, word };
}

export function StatePill(props: { readonly look: Look; readonly testId?: string }): ReactNode {
  return (
    <span data-testid={props.testId}>
      <Pill tone={props.look.tone} icon={props.look.icon}>
        {props.look.word}
      </Pill>
    </span>
  );
}

function opTarget(op: Op): { runtime: string; version: string } {
  return {
    runtime: typeof op.params.runtime === 'string' ? runtimeName(op.params.runtime) : '',
    version: typeof op.params.version === 'string' ? op.params.version : '',
  };
}

/** One operation: what, on which runtime, its state, progress, the reason when it failed; optionally when / who. */
export function OpLine(props: { readonly op: Op; readonly at?: boolean }): ReactNode {
  const fmt = useFormat();
  const t = useT().machineRuntimes.ops;
  const { op } = props;
  const p = op.progress;
  const target = opTarget(op);
  const look = opLook(op.state, t);
  const live = !TERMINAL_STATES.has(op.state);
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.875rem]"
      data-testid="op-line"
      data-state={op.state}
    >
      <span className={`inline-flex shrink-0 ${INK[look.tone]}`}>
        <DyIcon name={look.icon} className={`size-4 ${live ? 'dy-breathe' : ''}`} />
      </span>
      <span className="font-medium">
        {opWord(op.kind, t)}
        {target.runtime === '' ? null : ` · ${target.runtime}`}
        {target.version === '' ? null : (
          <>
            {' '}
            <span className="font-dy-mono text-[0.8125rem]">{target.version}</span>
          </>
        )}
      </span>
      <span className={`text-[0.8125rem] font-bold ${INK[look.tone]}`}>{look.word}</span>
      {p !== null && live ? (
        <span className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
          {p.step}
          {p.total === undefined ? '' : ` ${String(p.done ?? 0)}/${String(p.total)}`}
        </span>
      ) : null}
      {op.reason === null && op.detail === null ? null : (
        <span className="min-w-0 basis-full text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
          {[op.reason, op.detail].filter((x) => x !== null).join(' — ')}
        </span>
      )}
      {props.at === true ? (
        <span className="basis-full text-[0.78125rem] text-dy-muted sm:basis-auto">
          <time dateTime={op.requestedAt}>{fmt.dateWith(op.requestedAt, DATE_TIME_NUMERIC)}</time>
          {op.requestedBy === null ? null : (
            <>
              {' · '}
              <DyActor actor={op.requestedBy} />
            </>
          )}
        </span>
      ) : null}
    </div>
  );
}

/** Runs a privileged call through step-up; resolves null when the code dialog was cancelled. */
export function useGuardedOp(): <T>(fn: () => Promise<T>, why: string) => Promise<T | null> {
  const stepUp = useStepUp();
  const t = useT().machineRuntimes.ops;
  return useCallback(
    async <T,>(fn: () => Promise<T>, why: string): Promise<T | null> => {
      try {
        return await stepUp.run(fn, t.stepUp({ why }));
      } catch (err) {
        if (err instanceof StepUpCancelledError) return null;
        throw err;
      }
    },
    [stepUp, t],
  );
}
