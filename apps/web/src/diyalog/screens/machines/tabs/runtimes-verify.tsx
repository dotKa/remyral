import { fill, type Messages } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Op, type OpsRuntime, RUNTIME_NAME, TERMINAL_STATES } from '../../../../api/remoteOps';
import {
  type CheckResult,
  evidenceRefused,
  getWorkerVerification,
  opResults,
  type RuntimeVerification,
  verifyRuntime,
  type WorkerVerification,
} from '../../../../api/runtimeVerification';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { useOp } from '../../../../screens/fleet/remoteOps';
import { useSubmit } from '../../../../screens/useSubmit';
import { DATE_TIME_NUMERIC } from '../../../common/time';
import { DyDialog } from '../../../DyDialog';
import { DyIcon } from '../../../icons';
import type { Tone } from '../../../tone';
import { DyApiError } from '../../forms';
import { DyButton, Pill } from '../../parts';
import { useGuardedOp } from './runtimes-ops';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md §5): the proof block of a Makine → Runtime’lar row — the state
 * ("Kanıtlandı (makine, tarih)" / "Kanıtlanmadı: …"), "Doğrula" (owner / admin on a machine whose worker advertises
 * the feature; expected tokens and time shown before it starts; step-up), live progress with the results so far, the
 * result per capability and the history. An older worker gets no button but a note to update it.
 */

type Text = Messages['runtimeVerify'];

/** The machine's verification view, reloaded on demand (one request for every runtime row). */
export function useWorkerVerification(workerId: string): {
  readonly view: WorkerVerification | null;
  readonly reload: () => void;
} {
  const [view, setView] = useState<WorkerVerification | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    getWorkerVerification(workerId).then(
      (v) => {
        if (live) setView(v);
      },
      () => {
        // An older master has no such route: the rows simply show no proof block.
        if (live) setView(null);
      },
    );
    return () => {
      live = false;
    };
  }, [workerId, tick]);
  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  return { view, reload };
}

const STATE_TONE: Readonly<Record<string, Tone>> = {
  verified: 'green',
  partial: 'amber',
  unverified: 'amber',
  not_applicable: 'neutral',
};

const OUTCOME_TONE: Readonly<Record<string, Tone>> = { passed: 'green', failed: 'red', skipped: 'neutral' };

function word(words: object, key: string): string {
  return (words as Readonly<Record<string, string | undefined>>)[key] ?? key.replaceAll('_', ' ');
}

/** A progress step: a session ("görev oturumu") or the capability just decided. */
function stepLabel(t: Text, step: string): string {
  if (Object.hasOwn(t.steps, step)) return word(t.steps, step);
  return word(t.capability, step);
}

function capList(t: Text, caps: readonly string[]): string {
  return caps.map((c) => word(t.capability, c)).join(', ');
}

/** "Kanıtlandı (mac-1, 27.10.2026 10:00)" / "Kanıtlanmadı: …". */
function stateLine(t: Text, rv: RuntimeVerification, when: (iso: string) => string): string {
  const last = rv.lastRun;
  const failed = rv.capabilities.filter((c) => c.decided?.outcome === 'failed').map((c) => c.capability);
  if (rv.state === 'verified' && last !== null)
    return fill(t.provenBy, { machine: last.machine, when: when(last.finishedAt) });
  if (rv.state === 'partial' && last !== null)
    return failed.length > 0
      ? fill(t.partialBy, { machine: last.machine, when: when(last.finishedAt), caps: capList(t, failed) })
      : fill(t.provenBy, { machine: last.machine, when: when(last.finishedAt) });
  if (failed.length > 0)
    return fill(t.notProven, { reason: fill(t.failedCaps, { caps: capList(t, failed) }) });
  return fill(t.notProven, { reason: t.noRun });
}

function ResultList(props: {
  readonly t: Text;
  readonly results: readonly CheckResult[];
  readonly testId: string;
}): ReactNode {
  const { t } = props;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid={props.testId} aria-label={t.results}>
      {props.results.map((r) => (
        <li
          key={r.capability}
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.8125rem]"
          data-capability={r.capability}
          data-status={r.status}
        >
          <Pill tone={OUTCOME_TONE[r.status] ?? 'neutral'}>{word(t.outcome, r.status)}</Pill>
          <span className="font-medium">{word(t.capability, r.capability)}</span>
          <span className="min-w-0 text-dy-muted [overflow-wrap:anywhere]">{r.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function RuntimeProof(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: OpsRuntime;
  readonly view: WorkerVerification | null;
  /** Owner / admin on an operable machine. */
  readonly manage: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT().runtimeVerify;
  const fmt = useFormat();
  const submit = useSubmit();
  const guarded = useGuardedOp();
  const [asking, setAsking] = useState(false);
  const [tracked, setTracked] = useState<Op | null>(null);
  const progress = useOp(props.workerId, tracked);
  const onChanged = props.onChanged;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const rv = props.view?.runtimes.find((r) => r.runtime === props.runtime);
  const running = rv?.running ?? null;
  // A run started elsewhere (another tab, the API) is followed too.
  useEffect(() => {
    if (tracked === null && running !== null) {
      setTracked({
        id: running.opId,
        workerId: props.workerId,
        kind: 'runtime.capabilities.verify',
        params: { runtime: props.runtime },
        state: 'sent',
        reason: null,
        detail: null,
        progress: null,
        result: null,
        requestedBy: null,
        requestedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        finishedAt: null,
        login: null,
        logs: null,
      });
    }
  }, [running?.opId]);
  const op = progress.op;
  const ended = op !== null && TERMINAL_STATES.has(op.state);
  useEffect(() => {
    if (ended) changed.current();
  }, [ended, op?.id]);

  if (props.view === null || rv === undefined) return null;
  const when = (iso: string) => fmt.dateWith(iso, DATE_TIME_NUMERIC);
  const name = RUNTIME_NAME[props.runtime];
  const live = op !== null && !ended;
  const supported = props.view.supported;
  const canStart =
    props.manage && supported && props.view.connected && !live && rv.state !== 'not_applicable';
  const auth =
    rv.authMode === 'local-login'
      ? t.authSubscription
      : rv.authMode === 'secret-ref'
        ? t.authKey
        : t.authNone;
  const lastApplies = rv.history.find((h) => h.applies) ?? null;
  // Live: the results so far; just ended: that run's; otherwise the last run that applies to this tuple.
  const shownResults = op !== null && (live || ended) ? opResults(op) : (lastApplies?.results ?? []);
  const start = (): void => {
    setAsking(false);
    void submit.run(async () => {
      const started = await guarded(
        () => verifyRuntime(props.workerId, props.runtime),
        fill(t.verifyWhy, { machine: props.workerName, runtime: name }),
      );
      if (started !== null) setTracked(started);
    });
  };
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-dy-sunk px-3.5 py-3"
      data-testid={`runtime-proof-${props.runtime}`}
      data-state={rv.state}
    >
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem]">
          <span className="font-bold">{t.title}</span>
          <Pill tone={STATE_TONE[rv.state] ?? 'neutral'} icon={rv.state === 'verified' ? 'checkc' : 'shield'}>
            {word(t.state, rv.state)}
          </Pill>
          <span className="min-w-0 text-dy-muted [overflow-wrap:anywhere]" data-testid="runtime-proof-line">
            {stateLine(t, rv, when)}
          </span>
        </div>
        {canStart ? (
          <DyButton
            icon="shield"
            busy={submit.busy}
            onClick={() => {
              setAsking(true);
            }}
          >
            {rv.lastRun === null ? t.verify : t.verifyAgain}
          </DyButton>
        ) : null}
      </div>
      {!supported && props.manage ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="runtime-proof-update">
          {t.olderWorker}
        </p>
      ) : null}
      {live ? (
        <p
          className="m-0 flex items-center gap-2 text-[0.8125rem] text-dy-teal-ink"
          aria-live="polite"
          data-testid="runtime-proof-running"
        >
          <DyIcon name="retry" className="dy-breathe size-4" /> {t.running}
          {op.progress === null ? null : (
            <span className="text-dy-muted">{stepLabel(t, op.progress.step)}</span>
          )}
        </p>
      ) : null}
      {ended && op.state === 'refused' ? (
        <p className="m-0 text-[0.8125rem] text-dy-red-ink" data-testid="runtime-proof-refused">
          {fill(t.refused, { reason: [op.reason, op.detail].filter((x) => x !== null).join(' — ') })}
        </p>
      ) : null}
      {ended && evidenceRefused(op) ? (
        <p className="m-0 text-[0.8125rem] text-dy-red-ink" data-testid="runtime-proof-evidence-refused">
          {t.evidenceRefused}
        </p>
      ) : null}
      {shownResults.length > 0 ? (
        <ResultList t={t} results={shownResults} testId="runtime-proof-results" />
      ) : null}
      {lastApplies !== null && !live ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted">
          {fill(t.usage, {
            tokens: fmt.number(lastApplies.inputTokens + lastApplies.outputTokens),
            seconds: fmt.number(Math.round(lastApplies.durationMs / 1000)),
          })}
          {lastApplies.stoppedBy === null ? null : ` · ${word(t.stoppedBy, lastApplies.stoppedBy)}`}
          {' · '}
          {t.fleetWide}
        </p>
      ) : null}
      {rv.history.length > 0 ? (
        <details className="text-[0.8125rem]" data-testid="runtime-proof-history">
          <summary className="cursor-pointer font-medium">{t.history}</summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-dy-muted">
            {rv.history.map((h) => (
              <li key={h.id}>
                {fill(t.historyLine, {
                  when: when(h.finishedAt),
                  version: h.runtimeVersion,
                  passed: h.passed,
                  failed: h.failed,
                })}
                {h.applies ? null : ` — ${t.historyExpired}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <DyDialog
        open={asking}
        onClose={() => {
          setAsking(false);
        }}
        size="sm"
        title={fill(t.confirmTitle, { runtime: name, version: rv.version })}
        description={t.confirmBody}
        testId="runtime-proof-confirm"
        footer={
          <>
            <DyButton variant="primary" onClick={start} busy={submit.busy}>
              {t.start}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              {t.cancel}
            </DyButton>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-[0.875rem]">
          <p className="m-0" data-testid="runtime-proof-estimate">
            {fill(t.confirmCost, {
              tokens: fmt.number(rv.estimate.tokens),
              minutes: fmt.number(Math.ceil(rv.estimate.durationSec / 60)),
              maxTokens: fmt.number(rv.estimate.maxTokens),
              maxMinutes: fmt.number(Math.ceil(rv.estimate.maxDurationSec / 60)),
            })}
          </p>
          <p className="m-0 text-dy-muted">{auth}</p>
        </div>
      </DyDialog>
    </div>
  );
}
