import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  assignRuntimePolicy,
  getWorkerRuntimePolicy,
  listRuntimePolicies,
  type PolicyRuntimeRow,
  promoteRuntimePolicy,
  rollbackRuntimePolicy,
  type RuntimePolicySummary,
  type WorkerRuntimePolicy,
} from '../../../../api/runtimePolicy';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { RuntimeMark } from '../../../RuntimeMark';
import { INK, type Tone } from '../../../tone';
import { ConfirmButton, DyApiError, DyCheck, DyNotice } from '../../forms';
import { DyButton, DySelect, Panel, SkeletonRows } from '../../parts';
import { useGuarded } from './config-shared';
import type { MachineTabProps } from './types';
import { useT } from '../../../../i18n/I18nProvider';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Makine → Sandbox ve politika → Runtime politikası, feature for feature with the classic
 * `RuntimePolicyCard` (p3-runtime-policy): the policy the worker should run (pins, auth modes, model profiles),
 * whether it reports it applied, per runtime pinned vs installed, runtimes held back as unverified with the way to
 * Ayarlar → Runtime’lar; admins assign the policy group and the canary flag, promote or abandon the group's staged
 * version, or roll back to the previous one — each through step-up, with the classic reasons. Same requests.
 */

const STATUS: Readonly<
  Record<PolicyRuntimeRow['status'], { tone: Tone; key: 'match' | 'mismatch' | 'notInstalled' | 'unknown' }>
> = {
  match: { tone: 'green', key: 'match' },
  mismatch: { tone: 'amber', key: 'mismatch' },
  'not-installed': { tone: 'neutral', key: 'notInstalled' },
  unknown: { tone: 'neutral', key: 'unknown' },
};

export function RuntimePolicyPanel(props: MachineTabProps): ReactNode {
  const { worker, isAdmin } = props;
  const t = useT().machineConfig.policy;
  const workerId = worker.id;
  const name = worker.name;
  const [data, setData] = useState<WorkerRuntimePolicy | null>(null);
  const [policies, setPolicies] = useState<RuntimePolicySummary[]>([]);
  const [choice, setChoice] = useState('');
  const [canary, setCanary] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [w, list] = await Promise.all([getWorkerRuntimePolicy(workerId), listRuntimePolicies()]);
      setData(w);
      setPolicies(list);
      setChoice(w.assignedPolicy ?? '');
      setCanary(w.canary);
    });
  }, [load.run, workerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = async (fn: () => Promise<unknown>, why: string, message: string): Promise<void> => {
    setDone(null);
    const ok = await act.run(async () => {
      const r = await guarded(async () => {
        await fn();
        return true;
      }, why);
      if (r === null) return;
      setDone(message);
    });
    if (ok) await refresh();
  };

  const unverified = (props.overview?.compatibility ?? []).filter((c) => c.status === 'unverified');
  const groupName = data?.effective?.policy ?? data?.assignedPolicy ?? 'default';
  const group = policies.find((p) => p.name === groupName) ?? null;

  return (
    <Panel
      title={t.title}
      aside={
        isAdmin ? (
          <Link
            to="/settings/runtimes"
            className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
            data-testid="edit-policies-link"
          >
            {t.edit}
          </Link>
        ) : undefined
      }
      sub={t.sub}
      flush
      testId="runtime-policy-card"
    >
      <div className="flex flex-col gap-3 px-4 pb-4">
        {unverified.length > 0 ? (
          <DyNotice tone="amber" title={t.unverifiedTitle} testId="runtime-policy-unverified">
            <ul className="m-0 list-none p-0">
              {unverified.map((c) => (
                <li key={c.runtime}>
                  <RuntimeMark runtime={c.runtime} className="font-bold" />: {c.reason}
                </li>
              ))}
            </ul>
            <p className="m-0 mt-1">
              {t.unverifiedBody}{' '}
              <Link to="/settings/runtimes" className="font-medium text-dy-amber-ink underline">
                {t.unverifiedLink}
              </Link>
              {t.unverifiedOutro}
            </p>
          </DyNotice>
        ) : null}
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {data === null ? (
          load.error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : (
          <>
            {data.effective === null ? (
              <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="runtime-policy-none">
                {t.none}
              </p>
            ) : (
              <p
                className="m-0 flex flex-wrap items-center gap-x-2 text-[0.875rem]"
                data-testid="runtime-policy-summary"
              >
                <span className="font-bold">{data.effective.policy}</span>
                <span className="font-dy-mono">v{data.effective.version}</span>
                {data.effective.stage === 'canary' ? <span className="text-dy-violet">(canary)</span> : null}
                <span aria-hidden="true">·</span>
                {data.inSync ? (
                  <span className="inline-flex items-center gap-1 font-medium text-dy-green">
                    <DyIcon name="checkc" className="size-4" /> {t.inSync}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-dy-amber-ink">
                    <DyIcon name="clock" className="size-4" />
                    {data.applied.version === null
                      ? t.notReported
                      : t.reports({ policy: data.applied.policy ?? '?', version: data.applied.version })}
                  </span>
                )}
              </p>
            )}
            {data.runtimes.length > 0 ? (
              <ul
                className="m-0 list-none overflow-hidden rounded-[10px] border border-dy-line p-0"
                data-testid="runtime-policy-table"
                aria-label={t.versions}
              >
                {data.runtimes.map((r) => {
                  const st = STATUS[r.status];
                  return (
                    <li
                      key={r.runtime}
                      data-testid="runtime-policy-row"
                      className="flex flex-wrap items-start gap-x-4 gap-y-1 border-t border-dy-line px-3.5 py-2.5 text-[0.8125rem] first:border-t-0"
                    >
                      <span className="w-full min-w-[8rem] sm:w-auto sm:flex-[0_0_9rem]">
                        <RuntimeMark runtime={r.runtime} className="font-bold" />
                      </span>
                      <span className="min-w-0">
                        <span className="text-dy-muted">{t.pinned} </span>
                        <span className="font-dy-mono">{r.pinned}</span>
                        {r.pinMode === 'hold' ? <span className="text-dy-muted"> {t.held}</span> : null}
                        {r.allowUnpinned ? <span className="text-dy-muted"> {t.unpinnedAllowed}</span> : null}
                      </span>
                      <span className={`min-w-0 ${INK[st.tone]}`}>
                        <span className="text-dy-muted">{t.installed} </span>
                        <span className="font-dy-mono">
                          {r.installed ?? (r.status === 'unknown' ? t.notReportedShort : t.absent)}
                        </span>{' '}
                        <span className="font-bold">· {t.status[st.key]}</span>
                      </span>
                      <span className="min-w-0 text-dy-muted">
                        {t.authProfiles({
                          modes: r.authModes.join(', '),
                          profiles:
                            r.profiles.length === 0
                              ? t.runtimeDefault
                              : r.profiles
                                  .map((p) => (p === r.defaultProfile ? t.defaultProfile({ profile: p }) : p))
                                  .join(', '),
                        })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {isAdmin ? (
              <div className="flex flex-col gap-3 border-t border-dy-line pt-3">
                <div className="flex flex-wrap items-end gap-3">
                  <DySelect
                    label={t.group}
                    value={choice}
                    options={[
                      ['', 'default'],
                      ...policies.filter((p) => p.name !== 'default').map((p) => [p.name, p.name] as const),
                    ]}
                    onChange={setChoice}
                    className="min-w-[12rem]"
                  />
                  <DyCheck label={t.canary} checked={canary} onChange={setCanary} />
                  <DyButton
                    busy={act.busy}
                    disabled={choice === (data.assignedPolicy ?? '') && canary === data.canary}
                    onClick={() =>
                      void change(
                        () =>
                          assignRuntimePolicy(workerId, { policy: choice === '' ? null : choice, canary }),
                        t.whyAssign({ machine: name }),
                        t.assigned,
                      )
                    }
                  >
                    {t.saveAssignment}
                  </DyButton>
                </div>
                {group !== null && group.canaryVersion !== null ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-dy-violet-soft px-3.5 py-2.5 text-[0.875rem]">
                    <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                      {t.staged({
                        group: group.name,
                        version: group.canaryVersion,
                        workers: group.canaryWorkers,
                        active: String(group.activeVersion ?? '—'),
                      })}
                    </span>
                    <DyButton
                      variant="primary"
                      busy={act.busy}
                      onClick={() =>
                        void change(
                          () => promoteRuntimePolicy(group.name, group.canaryVersion ?? 0),
                          t.whyPromote({ group: group.name, version: group.canaryVersion ?? 0 }),
                          t.promoted,
                        )
                      }
                    >
                      {t.promote({ version: group.canaryVersion })}
                    </DyButton>
                    <ConfirmButton
                      label={t.abandon}
                      question={t.abandonQuestion}
                      busy={act.busy}
                      onConfirm={() =>
                        void change(
                          () => rollbackRuntimePolicy(group.name),
                          t.whyAbandon({ group: group.name }),
                          t.abandoned,
                        )
                      }
                    />
                  </div>
                ) : group !== null && group.previousVersion !== null ? (
                  <div className="flex flex-wrap items-center gap-2 text-[0.875rem]">
                    <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                      {t.active({ group: group.name, active: String(group.activeVersion ?? '—') })}
                    </span>
                    <ConfirmButton
                      label={t.rollBack({ version: group.previousVersion })}
                      busy={act.busy}
                      onConfirm={() =>
                        void change(
                          () => rollbackRuntimePolicy(group.name),
                          t.whyRollBack({ group: group.name, version: group.previousVersion ?? 0 }),
                          t.rolledBack({ version: group.previousVersion ?? 0 }),
                        )
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <DyApiError error={act.error} retryLeft={act.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
