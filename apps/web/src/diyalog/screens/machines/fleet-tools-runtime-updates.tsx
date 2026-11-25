import { type ReactNode, useState } from 'react';
import { fill } from '@remyral/i18n';
import {
  type FleetAction,
  type FleetTools,
  type FleetToolsSummary,
  type MatrixCell,
  type RuntimeCandidate,
  skippedOf,
  startFleetAction,
  verifyRuntimeCandidate,
  getRuntimeLock,
} from '../../../api/fleetTools';
import { RUNTIME_NAME } from '../../../api/remoteOps';
import { useAuth } from '../../../auth/AuthProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { ConfirmButton, DyApiError, DyNotice } from '../forms';
import { DyButton, EmptyLine, Panel, Pill } from '../parts';
import { useGuarded, whenText } from './tabs/config-shared';
import { useFleetWords } from './fleet-tools-parts';

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md §4): the console side of runtime versions newer than the
 * worker release's pin — the "Doğrulanmamış sürüm (pin: X)" badge, the per-machine "Doğrulanmamış olarak kur (Y)" and
 * "Pin’e geri dön (X)" buttons (one fleet action on that machine: the same signed path as Toplu işlem), the per-machine
 * reasons of a refused action (a 409 `nothing_to_do` is listed, never swallowed), the split counter ("K kurulabilir ·
 * M makine yazılımı sürümü gerektirir") and the "Doğrulama adayları" panel with its honest wording.
 */

const runtimeName = (id: string): string =>
  Object.hasOwn(RUNTIME_NAME, id) ? RUNTIME_NAME[id as keyof typeof RUNTIME_NAME] : id;

/** "Doğrulanmamış sürüm (pin: X)" on a runtime running an owner-approved version outside the pins. */
export function UnverifiedBadge(props: { readonly cell: MatrixCell | undefined }): ReactNode {
  const t = useT().runtimeUpdates;
  const active = props.cell?.unverifiedActive;
  if (active === undefined) return null;
  return (
    <span data-testid="unverified-badge" data-pin={active.pin} title={t.badgeHint}>
      <Pill tone="amber" icon="flag" className="bg-transparent ring-1 ring-dy-amber/60 ring-inset">
        {fill(t.badge, { pin: active.pin })}
      </Pill>
    </span>
  );
}

/** A matrix cell's offer: "Doğrulanmamış olarak kurulabilir: Y" (no button in the matrix — Toplu işlem acts). */
export function UnverifiedOffer(props: { readonly cell: MatrixCell }): ReactNode {
  const t = useT().runtimeUpdates;
  const v = props.cell.unverifiedAction?.version;
  if (v === undefined) return null;
  return (
    <span className="max-w-[14rem] text-[0.75rem] text-dy-amber-ink" data-testid="cell-unverified-offer">
      {fill(t.offer, { version: v })}
    </span>
  );
}

/** The per-machine reasons of a refused fleet action (409 `nothing_to_do` → `details.skipped`), in words. */
export function SkippedReasons(props: {
  readonly error: unknown;
  readonly machines: FleetTools['machines'];
}): ReactNode {
  const t = useT().runtimeUpdates.skipped;
  const words = useFleetWords();
  const skipped = skippedOf(props.error);
  if (skipped.length === 0) return null;
  const name = (id: string): string => props.machines.find((m) => m.workerId === id)?.name ?? id;
  return (
    <DyNotice tone="amber" title={t.title} testId="skipped-reasons" live>
      <ul className="m-0 list-none p-0">
        {skipped.map((s) => (
          <li key={s.workerId} data-testid="skipped-reason" data-reason={s.reason}>
            {fill(t.line, { machine: name(s.workerId), reason: words.reason(s.reason) })}
          </li>
        ))}
      </ul>
    </DyNotice>
  );
}

/** "N kurulabilir · M makine yazılımı sürümü gerektirir" next to the "N güncelleme" counter (newer masters only). */
export function SummarySplit(props: { readonly summary: FleetToolsSummary }): ReactNode {
  const t = useT().runtimeUpdates.summary;
  const s = props.summary;
  if (s.installable === undefined) return null;
  const parts = [
    s.installable > 0 ? fill(t.installable, { n: s.installable }) : null,
    (s.releaseRequired ?? 0) > 0 ? fill(t.releaseRequired, { n: s.releaseRequired ?? 0 }) : null,
    (s.unverifiedActive ?? 0) > 0 ? fill(t.unverifiedActive, { n: s.unverifiedActive ?? 0 }) : null,
  ].filter((x): x is string => x !== null);
  if (parts.length === 0) return null;
  return (
    <span className="text-[0.8125rem] text-dy-muted" data-testid="fleet-summary-split">
      {parts.join(' · ')}
    </span>
  );
}

/**
 * Makine → Runtime’lar: "Doğrulanmamış olarak kur (Y)" / "Pin’e geri dön (X)" for one runtime on one machine
 * (owners / admins; confirmed, then step-up). Each starts a fleet action on that machine only; a refusal lists its
 * reason.
 */
export function RuntimeUpdateButtons(props: {
  readonly cell: MatrixCell | undefined;
  readonly workerId: string;
  readonly workerName: string;
  readonly data: FleetTools | null;
  readonly onStarted?: (a: FleetAction) => void;
}): ReactNode {
  const t = useT().runtimeUpdates;
  const { state: auth } = useAuth();
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  const submit = useSubmit();
  const guarded = useGuarded();
  const [started, setStarted] = useState<FleetAction | null>(null);
  const c = props.cell;
  if (!isAdmin || c === undefined) return null;
  const install = c.unverifiedAction;
  const rollback = c.rollback;
  if (install === undefined && rollback === undefined) return null;
  const runtime = runtimeName(c.item);
  const run = (version: string, unverified: boolean, why: string): void => {
    void submit.run(async () => {
      const a = await guarded(
        () =>
          startFleetAction({
            kind: 'runtime.install',
            item: c.item,
            version,
            ...(unverified ? { unverified: true } : {}),
            workers: [props.workerId],
            rollout: 'all',
          }),
        why,
      );
      if (a !== null) {
        setStarted(a);
        props.onStarted?.(a);
      }
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="runtime-update-buttons">
      <div className="flex flex-wrap gap-2">
        {install === undefined ? null : (
          <ConfirmButton
            label={fill(t.install, { version: install.version })}
            question={fill(t.installQuestion, {
              runtime,
              version: install.version,
              pin: c.pinned ?? '—',
            })}
            busy={submit.busy}
            testId={`unverified-install-${c.item}`}
            onConfirm={() => {
              run(
                install.version,
                true,
                fill(t.installWhy, { machine: props.workerName, runtime, version: install.version }),
              );
            }}
          />
        )}
        {rollback === undefined ? null : (
          <ConfirmButton
            label={fill(t.rollback, { version: rollback.version })}
            question={fill(t.rollbackQuestion, { runtime, version: rollback.version })}
            busy={submit.busy}
            testId={`unverified-rollback-${c.item}`}
            onConfirm={() => {
              run(
                rollback.version,
                false,
                fill(t.rollbackWhy, { machine: props.workerName, runtime, version: rollback.version }),
              );
            }}
          />
        )}
      </div>
      {started === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-teal-ink" data-testid="runtime-update-started">
          {t.started}
        </p>
      )}
      <SkippedReasons error={submit.error} machines={props.data?.machines ?? []} />
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </div>
  );
}

function CandidateRow(props: { readonly c: RuntimeCandidate; readonly isAdmin: boolean }): ReactNode {
  const t = useT().runtimeUpdates.candidates;
  const fmt = useFormat();
  const words = useFleetWords();
  const submit = useSubmit();
  const guarded = useGuarded();
  const [startedOn, setStartedOn] = useState<string | null>(null);
  const { c } = props;
  const run = c.lastRun;
  const tone = c.verifyState === 'passed' ? 'green' : c.verifyState === 'failed' ? 'red' : 'neutral';
  const checkWord = (id: string): string =>
    Object.hasOwn(t.checks, id) ? t.checks[id as keyof typeof t.checks] : id;
  const download = (): void => {
    void submit.run(async () => {
      const lock = await getRuntimeLock(c.runtime, c.version);
      const blob = new Blob([JSON.stringify(lock, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${c.runtime}-${c.version}-package-lock.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-t border-dy-line px-4 py-3 first:border-t-0"
      data-testid="runtime-candidate"
      data-runtime={c.runtime}
      data-version={c.version}
      data-state={c.verifyState}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-bold">{runtimeName(c.runtime)}</span>
        <span className="font-dy-mono text-[0.8125rem]">{c.version}</span>
        <span className="text-[0.8125rem] text-dy-muted">{fill(t.pin, { pin: c.pin })}</span>
        <Pill tone={tone}>{t.states[c.verifyState]}</Pill>
        {run === null ? null : (
          <span className="text-[0.8125rem] text-dy-muted">
            {fill(t.machine, {
              machine: run.workerName ?? run.workerId,
              platform: `${run.os ?? '?'}/${run.arch ?? '?'}`,
            })}{' '}
            · {fill(t.when, { when: whenText(run.finishedAt ?? run.startedAt, fmt) })} ·{' '}
            {t.runStates[run.state]}
          </span>
        )}
      </div>
      {run === null || run.checks.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t.title}>
          {run.checks.map((x) => (
            <li key={x.id} data-testid="candidate-check" data-check={x.id} data-status={x.status}>
              <Pill
                tone={x.status === 'passed' ? 'green' : x.status === 'failed' ? 'red' : 'neutral'}
                title={x.detail}
              >
                {checkWord(x.id)}: {t.checkStates[x.status]}
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {run?.reason === null || run?.reason === undefined ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {fill(t.reason, { reason: words.reason(run.reason) })}
          {run.detail === null ? null : <span lang="en"> — {run.detail}</span>}
        </p>
      )}
      {props.isAdmin ? (
        <div className="flex flex-wrap gap-2">
          {c.verifyState === 'passed' || c.verifyState === 'running' ? null : (
            <DyButton
              icon="retry"
              busy={submit.busy}
              data-testid={`candidate-verify-${c.runtime}`}
              onClick={() => {
                void submit.run(async () => {
                  const r = await guarded(
                    () => verifyRuntimeCandidate(c.runtime, c.version),
                    fill(t.verifyWhy, { runtime: runtimeName(c.runtime), version: c.version }),
                  );
                  if (r !== null) setStartedOn(r.workerId);
                });
              }}
            >
              {t.verifyNow}
            </DyButton>
          )}
          {c.lock === null ? null : (
            <DyButton icon="file" busy={submit.busy} onClick={download}>
              {t.lock}
            </DyButton>
          )}
        </div>
      ) : null}
      {startedOn === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-teal-ink" data-testid="candidate-started">
          {fill(t.verifyStarted, { machine: startedOn })}
        </p>
      )}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </li>
  );
}

/** Araçlar ve sürümler → "Doğrulama adayları" (absent on an older master). */
export function CandidatesPanel(props: { readonly data: FleetTools; readonly isAdmin: boolean }): ReactNode {
  const t = useT().runtimeUpdates.candidates;
  const list = props.data.candidates;
  if (list === undefined) return null;
  return (
    <Panel
      title={t.title}
      count={String(list.length)}
      countLabel={fill(t.count, { n: list.length })}
      sub={t.sub}
      flush
      testId="runtime-candidates"
    >
      <p className="m-0 px-4 pb-2 text-[0.8125rem] text-dy-muted" data-testid="candidates-honest">
        {t.honest}
      </p>
      {list.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0" aria-label={t.title}>
          {list.map((c) => (
            <CandidateRow key={`${c.runtime}@${c.version}`} c={c} isAdmin={props.isAdmin} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
