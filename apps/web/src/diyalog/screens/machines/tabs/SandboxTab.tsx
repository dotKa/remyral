import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type Op, TERMINAL_STATES } from '../../../../api/remoteOps';
import {
  getWorkerSandbox,
  prepareSandbox,
  type PrepareStepState,
  prepareStepsOf,
  SANDBOX_PROFILE_ORDER,
  type SandboxCheck,
  type SandboxProfileStatus,
  setUnconfined,
  type WorkerSandbox,
} from '../../../../api/sandbox';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon, type IconName } from '../../../icons';
import { INK, type Tone } from '../../../tone';
import { DyApiError, DyCheck, DyNotice } from '../../forms';
import { DyButton, Panel, Pill, SkeletonRows } from '../../parts';
import { DyConfirmDialog } from '../../../common/actions';
import { OpLine, profileName, useGuarded, useOpPoll, whenText } from './config-shared';
import { RuntimePolicyPanel } from './sandbox-policy';
import type { MachineTabProps } from './types';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Makine → Sandbox ve politika in the Diyalog language, feature for feature with the
 * classic `SandboxCard` (p5-sandbox-ops, ADR-0019) and `RuntimePolicyCard` (p3-runtime-policy): every execution
 * profile ready / not ready with the worker's reason code, what fixes it and who can, the host checks behind it,
 * "Hazırla" with per-step progress (optionally with the privileged helper), and — admins only — the unconfined
 * switch behind an explicit warning (always-fresh step-up, audited, owners notified) and, under it, the machine
 * setting "Sandbox’sız işler paralel çalışabilir" (p19-unconfined-parallel, same route). Then the runtime policy panel.
 */

type SandboxText = Messages['machineConfig']['sandbox'];

/** A text for a worker-sent id (prepare step, host check), or the id itself when the catalog does not know it. */
function known(map: Readonly<Record<string, string>>, id: string): string {
  return Object.hasOwn(map, id) ? (map[id] ?? id) : id;
}

const STEP_LOOK: Readonly<Record<PrepareStepState, { tone: Tone; icon: IconName }>> = {
  pending: { tone: 'neutral', icon: 'clock' },
  running: { tone: 'teal', icon: 'retry' },
  done: { tone: 'green', icon: 'checkc' },
  skipped: { tone: 'neutral', icon: 'chev' },
  failed: { tone: 'red', icon: 'xc' },
  needs_owner: { tone: 'amber', icon: 'shield' },
};

const CHECK_TONE: Readonly<Record<SandboxCheck['status'], Tone>> = {
  ok: 'green',
  failed: 'red',
  warning: 'amber',
  not_applicable: 'neutral',
};

function confinementText(c: NonNullable<SandboxProfileStatus['confinement']>, t: SandboxText): string {
  return `${known(t.filesystem, c.filesystem)} · ${known(t.egress, c.egress)} · ${known(t.limits, c.limits)}`;
}

function concurrencyText(p: SandboxProfileStatus, t: SandboxText): string | null {
  if (p.concurrency === undefined) return null;
  const n = p.concurrency === 1 ? t.parallelOne : t.parallelMax({ n: p.concurrency });
  // p9-windows-slots-local-login: the worker's note ("for API-key runtimes; …") is shown as it comes.
  return p.concurrencyNote === undefined
    ? t.parallel({ what: n })
    : `${t.parallel({ what: n })} — ${p.concurrencyNote}`;
}

/**
 * p19-linux-host-isolation: a ready host profile on Linux still depends on the per-attempt isolation for parallelism —
 * show its state and, when it is missing, how to enable it (the catalog's hint for the worker's code, else its detail).
 */
function isolationHint(
  p: SandboxProfileStatus,
  checks: ReadonlyMap<string, SandboxCheck>,
  t: SandboxText,
): { tone: Tone; text: string; fix?: SandboxCheck['fix'] } | null {
  if (!p.ready || !p.checks.includes('host_isolation')) return null;
  const c = checks.get('host_isolation');
  if (c === undefined || c.status === 'not_applicable') return null;
  const label = known(t.checks, 'host_isolation');
  if (c.status === 'ok') return { tone: 'green', text: `${label}: ${t.ok}` };
  const hint = c.code === undefined ? undefined : known(t.isolationHints, c.code);
  return {
    tone: c.status === 'failed' ? 'red' : 'amber',
    text: `${label}: ${hint !== undefined && hint !== c.code ? hint : (c.detail ?? c.code ?? c.status)}`,
    ...(c.fix === undefined ? {} : { fix: c.fix }),
  };
}

function ProfileRow(props: {
  readonly p: SandboxProfileStatus;
  readonly checks: ReadonlyMap<string, SandboxCheck>;
}): ReactNode {
  const { p } = props;
  const all = useT().machineConfig;
  const t = all.sandbox;
  const conc = p.ready ? concurrencyText(p, t) : null;
  const isolation = isolationHint(p, props.checks, t);
  return (
    <li
      data-testid="sandbox-profile"
      data-profile={p.profile}
      className="flex items-start gap-3 border-t border-dy-line px-4 py-3 first:border-t-0"
    >
      <DyIcon
        name={p.ready ? 'checkc' : 'xc'}
        className={`mt-0.5 size-4 shrink-0 ${p.ready ? 'text-dy-green' : 'text-dy-muted'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{profileName(p.profile, all.shared)}</span>
          <Pill tone={p.ready ? 'green' : 'neutral'}>{p.ready ? t.ready : t.notReady}</Pill>
          {p.runtimes !== undefined && p.runtimes.length > 0 ? (
            <span className="text-[0.8125rem] text-dy-muted">
              {t.forRuntimes({ runtimes: p.runtimes.join(', ') })}
            </span>
          ) : null}
          {!p.ready && p.code !== undefined ? (
            <span className="font-dy-mono text-[0.78125rem] text-dy-muted" data-testid="sandbox-code">
              {p.code}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-col gap-0.5 text-[0.8125rem]">
          {p.ready && p.confinement !== undefined ? (
            <p className="m-0 text-dy-muted">{confinementText(p.confinement, t)}</p>
          ) : null}
          {p.ready && p.code === 'host_unconfined_fallback' ? (
            <p className={`m-0 [overflow-wrap:anywhere] ${INK.amber}`} data-testid="sandbox-unconfined">
              <span className="font-bold">{t.unconfinedFallback}</span>
              {p.reason === undefined ? null : <span className="block">{p.reason}</span>}
              {p.remedy === undefined ? null : (
                <span className="block text-dy-muted">{t.remedy({ remedy: p.remedy })}</span>
              )}
            </p>
          ) : null}
          {conc !== null ? (
            <p className="m-0 text-dy-muted" data-testid="sandbox-concurrency">
              {conc}
            </p>
          ) : null}
          {isolation !== null ? (
            <p
              className={`m-0 [overflow-wrap:anywhere] ${INK[isolation.tone]}`}
              data-testid="sandbox-isolation"
              title={props.checks.get('host_isolation')?.detail}
            >
              {isolation.text}
              {isolation.fix !== undefined && isolation.fix !== 'none' ? (
                <span className="font-bold"> — {t.fixes[isolation.fix]}</span>
              ) : null}
            </p>
          ) : null}
          {!p.ready && p.reason !== undefined ? <p className="m-0">{p.reason}</p> : null}
          {!p.ready && p.remedy !== undefined ? (
            <p className="m-0 text-dy-muted">{t.remedy({ remedy: p.remedy })}</p>
          ) : null}
          {!p.ready && p.fix !== undefined && p.fix !== 'none' ? (
            <p className="m-0 font-bold text-dy-amber-ink" data-testid="sandbox-fix">
              {t.fixes[p.fix]}
            </p>
          ) : null}
          {!p.ready && p.checks.length > 0 ? (
            <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-4 gap-y-0.5 p-0">
              {p.checks.map((id) => {
                const c = props.checks.get(id);
                if (c === undefined || c.status === 'not_applicable') return null;
                const tone = CHECK_TONE[c.status];
                return (
                  <li key={id} className={`inline-flex items-center gap-1 ${INK[tone]}`} title={c.detail}>
                    <DyIcon name={c.status === 'ok' ? 'checkc' : 'xc'} className="size-3.5" />
                    {known(t.checks, id)}: {c.status === 'ok' ? t.ok : (c.code ?? c.status)}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SandboxStatusPanel(props: MachineTabProps): ReactNode {
  const fmt = useFormat();
  const t = useT().machineConfig.sandbox;
  const { worker, isAdmin } = props;
  const workerId = worker.id;
  const name = worker.name;
  const [data, setData] = useState<WorkerSandbox | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [starting, setStarting] = useState(false);
  const [privileged, setPrivileged] = useState(true);
  const [confirmUnconfined, setConfirmUnconfined] = useState(false);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const d = await getWorkerSandbox(workerId);
      setData(d);
      setOp((cur) => cur ?? d.lastPrepare);
    });
  }, [load.run, workerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDone = useCallback(() => {
    void refresh();
  }, [refresh]);
  useOpPoll(workerId, op, setOp, onDone);

  const status = data?.status ?? null;
  const running = op !== null && !TERMINAL_STATES.has(op.state);
  const steps = prepareStepsOf(op);
  // p18-confirm-dialog: allowing unconfined runs is confirmed in a dialog first; disallowing is immediate.
  const applyUnconfined = (allow: boolean): void => {
    if (data === null) return;
    const generation = data.unconfined.generation;
    setConfirmUnconfined(false);
    void act
      .run(async () => {
        await guarded(
          () => setUnconfined(workerId, { allow, expectedGeneration: generation }),
          t.whyUnconfined({ machine: name, allow }),
        );
      })
      .then(() => refresh());
  };
  // p19-unconfined-parallel: same route and step-up; only while unconfined is allowed.
  const applyParallel = (parallel: boolean): void => {
    if (data === null) return;
    const generation = data.unconfined.generation;
    void act
      .run(async () => {
        await guarded(
          () => setUnconfined(workerId, { allow: true, parallel, expectedGeneration: generation }),
          t.whySandboxlessParallel({ machine: name, on: parallel }),
        );
      })
      .then(() => refresh());
  };
  const parallelOn = data?.unconfined.allowed === true && data.unconfined.parallel === true;
  const parallelSupported = data?.unconfined.parallelSupported === true;
  const profiles: SandboxProfileStatus[] =
    status === null
      ? []
      : SANDBOX_PROFILE_ORDER.flatMap((p) => status.profiles.filter((x) => x.profile === p));
  const checkById = new Map((status?.checks ?? []).map((c) => [c.id, c]));
  const ready = profiles.filter((p) => p.ready).length;

  return (
    <div className="flex flex-col gap-5" data-testid="sandbox-card">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {data === null ? (
        load.error === null ? (
          <Panel title={t.title} flush>
            {/* p12-diyalog-default (visual tour): about the profiles list's height (the runtime policy below jumped). */}
            <SkeletonRows label={t.loading} rows={12} />
          </Panel>
        ) : null
      ) : !data.supported ? (
        <DyNotice tone="amber" title={t.unsupportedTitle}>
          {t.unsupported}
        </DyNotice>
      ) : (
        <>
          <Panel
            title={t.profiles}
            count={status === null ? undefined : `${String(ready)}/${String(profiles.length)}`}
            countLabel={status === null ? undefined : t.readyCount({ ready, total: profiles.length })}
            sub={
              status === null ? undefined : (
                <span data-testid="sandbox-user">
                  {t.runsAs({ account: status.workerUser.running })}
                  {status.workerUser.expected === undefined
                    ? ''
                    : t.dedicated({
                        account: status.workerUser.expected,
                        inferred: status.workerUser.source === 'inferred',
                      })}{' '}
                  · {t.checkedAt({ when: whenText(status.checkedAt, fmt) })}
                </span>
              )
            }
            flush
          >
            {status === null ? (
              <p className="m-0 px-4 pb-4 text-[0.875rem] text-dy-muted">{t.notReported}</p>
            ) : (
              <>
                <ul className="m-0 list-none p-0" data-testid="sandbox-profiles" aria-label={t.profiles}>
                  {profiles.map((p) => (
                    <ProfileRow key={p.profile} p={p} checks={checkById} />
                  ))}
                </ul>
                {!status.privilegedPrepare.available ? (
                  <p
                    className="m-0 border-t border-dy-line px-4 py-3 text-[0.8125rem] text-dy-amber-ink"
                    data-testid="sandbox-helper-missing"
                  >
                    {t.noHelper} {status.privilegedPrepare.detail ?? t.noHelperDetail}.
                  </p>
                ) : null}
              </>
            )}
          </Panel>

          {isAdmin || op !== null || starting ? (
            <Panel title={t.prepare} sub={t.prepareSub} testId="sandbox-prepare">
              <div className="flex flex-col gap-3">
                {isAdmin ? (
                  <>
                    <DyCheck
                      label={t.privileged}
                      checked={privileged}
                      disabled={running}
                      onChange={setPrivileged}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <DyButton
                        variant="primary"
                        icon="shield"
                        busy={act.busy || running || starting}
                        disabled={!data.connected}
                        onClick={() => {
                          // Clear the previous run's result right away and say that a new one is starting.
                          const previous = op;
                          setOp(null);
                          setStarting(true);
                          void act
                            .run(async () => {
                              const started = await guarded(
                                () => prepareSandbox(workerId, privileged),
                                t.whyPrepare({ machine: name }),
                              );
                              setOp(started ?? previous);
                            })
                            .finally(() => {
                              setStarting(false);
                            });
                        }}
                      >
                        {t.prepare}
                      </DyButton>
                      {!data.connected ? (
                        <span className="text-[0.8125rem] text-dy-muted">{t.offline}</span>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {starting && op === null ? (
                  <p
                    data-testid="sandbox-prepare-starting"
                    role="status"
                    className="m-0 flex items-center gap-2 text-[0.875rem] text-dy-teal-ink"
                  >
                    <DyIcon name="retry" className="dy-breathe size-4" /> {t.starting}
                  </p>
                ) : null}
                {op !== null ? (
                  <div data-testid="sandbox-prepare-progress" className="flex flex-col gap-2">
                    <OpLine op={op} what={t.preparation} />
                    {steps.length > 0 ? (
                      <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t.stepsLabel}>
                        {steps.map((s) => {
                          const look = STEP_LOOK[s.state];
                          return (
                            <li
                              key={s.id}
                              data-testid="prepare-step"
                              data-step={s.id}
                              className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 text-[0.8125rem]"
                            >
                              <span
                                className={`inline-flex items-center gap-1.5 font-bold ${INK[look.tone]}`}
                              >
                                <DyIcon
                                  name={look.icon}
                                  className={`size-3.5 shrink-0 ${s.state === 'running' ? 'dy-breathe' : ''}`}
                                />
                                {t.stepStates[s.state]}
                              </span>
                              <span className="min-w-0 [overflow-wrap:anywhere]">
                                {known(t.steps, s.id)}
                                {s.privileged ? ` ${t.privilegedStep}` : ''}
                                {s.detail !== undefined ? (
                                  <span className="text-dy-muted"> — {s.detail}</span>
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Panel>
          ) : null}

          {isAdmin ? (
            <Panel
              title={t.unconfined}
              aside={
                <Pill
                  tone={data.unconfined.allowed ? 'red' : 'neutral'}
                  icon={data.unconfined.allowed ? 'shield' : undefined}
                >
                  {data.unconfined.allowed ? t.allowed : t.off}
                </Pill>
              }
              testId="unconfined-switch"
            >
              <div className="flex flex-wrap gap-2">
                <DyButton
                  variant={data.unconfined.allowed ? 'secondary' : 'danger'}
                  busy={act.busy}
                  aria-haspopup={data.unconfined.allowed ? undefined : 'dialog'}
                  onClick={() => {
                    if (!data.unconfined.allowed) {
                      setConfirmUnconfined(true);
                      return;
                    }
                    applyUnconfined(false);
                  }}
                >
                  {data.unconfined.allowed ? t.disallow : t.allow}
                </DyButton>
              </div>
              <DyCheck
                className="mt-3"
                testId="unconfined-parallel"
                label={t.sandboxlessParallel}
                checked={parallelOn}
                disabled={act.busy || !data.unconfined.allowed || (!parallelSupported && !parallelOn)}
                hint={
                  !data.unconfined.allowed
                    ? t.sandboxlessParallelNeedsAllow
                    : !parallelSupported && !parallelOn
                      ? t.sandboxlessParallelUnsupported
                      : t.sandboxlessParallelHint
                }
                onChange={applyParallel}
              />
              <DyConfirmDialog
                open={confirmUnconfined && !data.unconfined.allowed}
                onClose={() => {
                  setConfirmUnconfined(false);
                }}
                title={t.warningTitle}
                description={t.warning}
                confirmLabel={t.confirmAllow}
                cancelLabel={t.cancel}
                testId="unconfined-confirm"
                onConfirm={() => {
                  applyUnconfined(true);
                }}
              />
            </Panel>
          ) : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
        </>
      )}
    </div>
  );
}

export function SandboxTab(props: MachineTabProps): ReactNode {
  return (
    <div className="flex flex-col gap-5">
      <SandboxStatusPanel {...props} />
      <RuntimePolicyPanel {...props} />
    </div>
  );
}
