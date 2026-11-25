import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { reserveKept } from '../../../api/fleet-queue';
import { getFleetOverview, type WorkerOverview } from '../../../api/fleet';
import { type JobSummary, listJobs } from '../../../api/jobs';
import { getQuotaStatus, type QuotaPause } from '../../../api/quotas';
import { machineHasAccounts } from '../../../api/runtimeUsage';
import { useLimitTexts } from '../usage/limitText';
import { getWorker, type WorkerDetail } from '../../../api/workers';
import { useAuth } from '../../../auth/AuthProvider';
import type { TabItem } from '../../../lib/tabs';
import { toApiError } from '../../../components/ui';
import { useDescribeReason } from '../../../i18n/reasons';
import { DyNotice, DyReason } from '../../common/notices';
import { useNow } from '../../../lib/now';
import { machinePath, sectionTab } from '../../../screens/fleet/machineLinks';
import { groupMachineReasons, machineReasons, machineTabs } from '../../../screens/fleet/machineTabs';
import { firstLine, formatSpan } from '../../../screens/job/format';
import { useRuntimeUsage } from '../../../screens/usage/runtimeUsage';
import { Chip } from '../../Chip';
import { DyIcon } from '../../icons';
import { KeyValue, type KeyValueRow } from '../../KeyValue';
import { RuntimeMark } from '../../RuntimeMark';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import {
  agoText,
  DyButton,
  DyButtonLink,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  SlotCells,
  ThreadLink,
} from '../parts';
import { EntryWindows, LEVEL_TONE, MachineStateMark, platformText, ReadyRuntimes, slotsOf } from './shared';
import { PairingCard } from './Pairing';
import { useMachineNameEdit } from './MachineName';
import { RestartBanner } from './RestartBanner';
import { ActivityTab } from './tabs/ActivityTab';
import { AdminTab } from './tabs/AdminTab';
import { CapacityPanels } from './tabs/CapacityPanels';
import { ConfigurationTab } from './tabs/ConfigurationTab';
import { RuntimesTab } from './tabs/RuntimesTab';
import { SandboxTab } from './tabs/SandboxTab';
import { ToolsTab } from './tabs/ToolsTab';
import { ServicesPanel } from '../services/ServicesPanel';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Formatter } from '@remyral/i18n';
import { DATE_TIME_NUMERIC } from '../../common/time';

/**
 * p12-diyalog Faz 4 — `/machines/:id` in the Diyalog language (docs/design/p12-diyalog.md §12). "Genel bakış" is
 * new: what needs attention (the classic reasons and their fixes), slot cells with the jobs running here (each opens
 * its job thread), the runtimes' usage-limit windows with the near-limit mark and a 24 h sparkline, capacity (the
 * classic capacity / mode / queue-slot / cache cards — their rules and step-up unchanged) and the facts. The other
 * tabs (`?tab=`, the classic names so deep links keep working) host the classic panels: runtimes, tools, sandbox &
 * runtime policy, configuration, admin (drain / rotate / revoke, restart, machine admin — each with its own
 * confirmation and step-up) and activity.
 */

const POLL_MS = 5_000;

interface MachineData {
  readonly worker: WorkerDetail | null;
  readonly overview: WorkerOverview | undefined;
  readonly pauses: readonly QuotaPause[];
  readonly jobs: readonly JobSummary[] | null;
  readonly error: ApiError | null;
  readonly reload: () => void;
}

function useMachine(id: string): MachineData {
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [overview, setOverview] = useState<WorkerOverview | undefined>(undefined);
  const [pauses, setPauses] = useState<readonly QuotaPause[]>([]);
  const [jobs, setJobs] = useState<readonly JobSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // p12-diyalog-default (visual tour): the four reads run together and land in one render — read one after another,
  // the attention panel, the slots and the facts appeared in turn and pushed the page down each time.
  const load = useCallback(async () => {
    const [w, o, q, j] = await Promise.allSettled([
      getWorker(id),
      getFleetOverview(),
      getQuotaStatus(),
      listJobs({ worker: id, state: 'RUNNING' }, null, { limit: 20 }),
    ]);
    if (w.status === 'fulfilled') {
      setWorker(w.value);
      setError(null);
    } else setError(toApiError(w.reason));
    setOverview(o.status === 'fulfilled' ? o.value.find((x) => x.id === id) : undefined);
    setPauses(q.status === 'fulfilled' ? q.value.pauses.filter((p) => p.workers.includes(id)) : []);
    setJobs(j.status === 'fulfilled' ? j.value.items : []);
  }, [id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [load]);
  return { worker, overview, pauses, jobs, error, reload: () => void load() };
}

function gib(n: number, fmt: Formatter): string {
  const digits = n >= 100 * 2 ** 30 ? 0 : 1;
  return `${fmt.number(n / 2 ** 30, { minimumFractionDigits: digits, maximumFractionDigits: digits })} GiB`;
}

// ------------------------------------------------------------------------------------------------ overview

/** p17-ui-review: the statuses whose grouped card has a sentence of its own (`machines.page.group`). */
const GROUP_SENTENCE = {
  pin_mismatch: 1,
  not_authenticated: 1,
  unverified: 1,
  not_allowed: 1,
  degraded: 1,
} as const;
type GroupStatus = keyof typeof GROUP_SENTENCE;

function Reasons(props: {
  readonly worker: WorkerDetail;
  readonly overview: WorkerOverview | undefined;
  readonly pauses: readonly QuotaPause[];
}): ReactNode {
  const w = props.worker;
  const tAll = useT();
  const t = tAll.machines.page;
  const describeReason = useDescribeReason();
  const reasons = machineReasons(w, props.overview, props.pauses);
  if (reasons.length === 0) return null;
  // p17-ui-review: runtimes with the same problem share one card (one action), not one card each.
  const cards = groupMachineReasons(reasons);
  /** The fix of a reason on this page: the tab it points at (the classic page's deep link), or the reason's own tab. */
  const fixOf = (r: (typeof reasons)[number]): ReactNode | undefined => {
    const info = describeReason(r.reason, r.context, r.params);
    const href = info.action?.href ?? null;
    if (href !== null && href.startsWith('/machines?')) {
      const q = new URLSearchParams(href.slice('/machines?'.length));
      if (q.get('worker') !== w.id) return undefined;
      const section = q.get('section');
      return section === null ? (
        <></>
      ) : (
        <DyButtonLink to={machinePath(w.id, sectionTab(section))}>{info.action?.label}</DyButtonLink>
      );
    }
    if (href === null && r.tab !== undefined) {
      const label = r.local?.kind === 'policy' ? tAll.reasons.actions.openRuntimePolicy : t.tabs[r.tab];
      return <DyButtonLink to={machinePath(w.id, r.tab)}>{label}</DyButtonLink>;
    }
    return undefined;
  };
  return (
    <Panel
      title={t.reasonsTitle}
      count={String(cards.length)}
      countLabel={t.reasonsCount({ n: cards.length })}
      testId="machine-reasons"
      className="border-dy-amber/40"
    >
      <div className="flex flex-col gap-2">
        {cards.map((c) => {
          if (c.kind === 'group') {
            const first = c.items[0];
            const action = first === undefined ? undefined : fixOf(first);
            const say = c.status in GROUP_SENTENCE ? t.group[c.status as GroupStatus] : t.group.other;
            const sentence = say({ n: c.items.length, machine: w.name });
            return (
              <DyNotice
                key={c.key}
                tone={c.tone === 'danger' ? 'red' : c.tone === 'neutral' ? 'neutral' : 'amber'}
                testId="machine-reason-group"
                {...(action === undefined ? {} : { action })}
              >
                <p className="m-0" data-reason={c.status}>
                  {sentence}
                </p>
                <ul
                  className="m-0 mt-1.5 flex list-none flex-wrap gap-x-3 gap-y-1 p-0"
                  aria-label={t.group.runtimes}
                >
                  {c.items.map((r) => (
                    <li key={r.key}>
                      <RuntimeMark runtime={r.context.runtime ?? ''} />
                    </li>
                  ))}
                </ul>
                <details className="mt-1 text-[0.75rem] opacity-85">
                  <summary className="w-fit cursor-pointer select-none">{tAll.shared.details}</summary>
                  {c.items.map((r) => (
                    <p key={r.key} className="m-0 mt-1 font-dy-mono break-words whitespace-pre-wrap">
                      {r.reason}
                    </p>
                  ))}
                </details>
              </DyNotice>
            );
          }
          const r = c.item;
          const action = fixOf(r);
          if (r.local !== undefined) {
            const l = r.local;
            const text =
              l.kind === 'policy'
                ? t.local.policy
                : `${t.local.release({ version: l.toVersion, rolledBack: l.rolledBack, cause: l.cause?.replaceAll('_', ' ') ?? null })}${l.detail === null ? '' : ` ${l.detail}`}`;
            return (
              <DyNotice
                key={r.key}
                tone={r.tone === 'danger' ? 'red' : r.tone === 'neutral' ? 'neutral' : 'amber'}
                testId={`machine-reason-${r.key}`}
                {...(action === undefined ? {} : { action })}
              >
                {text}
              </DyNotice>
            );
          }
          return (
            <DyReason
              key={r.key}
              reason={r.reason}
              context={r.context}
              params={r.params}
              tone={r.tone}
              {...(action === undefined ? {} : { action })}
            />
          );
        })}
      </div>
    </Panel>
  );
}

function SlotsAndJobs(props: {
  readonly worker: WorkerDetail;
  readonly overview: WorkerOverview | undefined;
  readonly jobs: readonly JobSummary[] | null;
}): ReactNode {
  const w = props.worker;
  const t = useT().machines.page;
  const now = useNow();
  const s = slotsOf(w, props.overview);
  const off = !w.connected;
  const q = props.overview?.queue ?? null;
  // p11-fixes-a: the default reserve only from 3 slots on (the classic rule, reused).
  const kept = q === null ? 0 : reserveKept(q.urgentReserve, q.urgentReserveAuto, s.max);
  const full = t.slotsFull({ used: s.used, max: s.max });
  return (
    <Panel
      title={t.slotsTitle}
      count={off ? t.off : `${String(s.used)}/${String(s.max)}`}
      countLabel={off ? t.machineOff : full}
      flush
      testId="machine-slots-panel"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
        <SlotCells
          used={s.used}
          max={s.max}
          off={off}
          limit={16}
          label={off ? t.nameOff({ name: w.name }) : full}
        />
        {kept > 0 ? (
          <span className="text-[0.8125rem] text-dy-muted" data-testid="urgent-reserve">
            {t.urgentKept({ n: kept })}
          </span>
        ) : null}
      </div>
      {props.jobs === null ? (
        <SkeletonRows label={t.jobsLoading} rows={2} />
      ) : props.jobs.length === 0 ? (
        <EmptyLine>{t.noJobs}</EmptyLine>
      ) : (
        <Rows label={t.jobsLabel} testId="machine-jobs">
          {props.jobs.map((j) => {
            const title = firstLine(j.title) || j.id;
            return (
              <Row
                key={j.id}
                compact
                lead={<DyIcon name="retry" className="dy-breathe size-4" />}
                tone="teal"
                title={
                  <Link
                    to={`/jobs/${encodeURIComponent(j.id)}`}
                    className="text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                  >
                    {title}
                  </Link>
                }
                meta={
                  <>
                    {j.runtime === null ? null : <RuntimeMark runtime={j.runtime} />}
                    <span>{j.project}</span>
                    <span className="font-dy-mono tabular-nums">
                      {formatSpan(Math.max(0, now - Date.parse(j.stateChangedAt)))}
                    </span>
                  </>
                }
                actions={<ThreadLink target={{ kind: 'job', id: j.id }} about={title} />}
              />
            );
          })}
        </Rows>
      )}
    </Panel>
  );
}

function Limits(props: { readonly workerId: string }): ReactNode {
  const sayError = useErrorText();
  const tm = useT().machines;
  const t = tm.page;
  const fmt = useFormat();
  const lt = useLimitTexts();
  const { data, error } = useRuntimeUsage({ history: true });
  const now = useNow();
  const mine = data?.entries.filter((e) => e.workerId === props.workerId) ?? [];
  return (
    <Panel
      title={t.limitsTitle}
      sub={data === null ? undefined : t.limitsSub({ percent: fmt.percent(data.nearThreshold / 100) })}
      testId="machine-limits"
    >
      {data === null ? (
        error === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.limitsLoading}</p>
        ) : (
          <p className="m-0 text-[0.875rem] text-dy-red-ink">{t.limitsFailed({ error: sayError(error) })}</p>
        )
      ) : mine.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.limitsNone}</p>
      ) : (
        <ul className="m-0 grid list-none gap-5 p-0">
          {mine.map((e) => (
            <li
              key={`${e.runtime}-${e.auth}-${e.account}`}
              data-testid={`machine-limit-${e.runtime}`}
              data-account={e.account}
              data-level={e.level}
            >
              <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <RuntimeMark runtime={e.runtime} className="font-bold" />
                {machineHasAccounts(mine, e.workerId, e.runtime) ? (
                  <span className="text-[0.8125rem] font-semibold" data-testid="machine-limit-account">
                    {lt.accountText(e)}
                  </span>
                ) : null}
                <span className="text-[0.8125rem] text-dy-muted">
                  {e.auth === 'subscription'
                    ? e.plan === null
                      ? t.subscription
                      : t.subscriptionPlan({ plan: e.plan })
                    : t.apiKey}
                </span>
                <Pill tone={LEVEL_TONE[e.level]} className="ml-auto">
                  {tm.shared.level[e.level]}
                </Pill>
              </div>
              {e.limit !== null ? (
                <p className="m-0 mb-2 flex items-center gap-1.5 rounded-[9px] bg-dy-red-soft px-3 py-2 text-[0.8125rem] text-dy-red-ink">
                  <DyIcon name="pause" className="size-4 shrink-0" />
                  {t.limitReached({ when: lt.resetText(e.limit.resetAt ?? e.limit.resumeAt, now) })}
                </p>
              ) : null}
              <EntryWindows entry={e} nearThreshold={data.nearThreshold} now={now} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Above this worst event-loop delay a pong timeout is the machine stalling, not the network (half the 10 s wait). */
const STALL_MS = 5_000;

/** p17-chat-reconnect: "Son bağlantı kopmaları" — time · cause (· details), newest first, at most five. */
function Disconnects(props: { readonly list: WorkerDetail['disconnects'] }): ReactNode {
  const fmt = useFormat();
  const t = useT().machines.page.facts;
  const causes = t.disconnectCause;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="machine-disconnects">
      {props.list.slice(0, 5).map((d) => {
        const parts: string[] = [
          Object.hasOwn(causes, d.cause)
            ? causes[d.cause as keyof typeof causes]
            : d.cause.replaceAll('_', ' '),
        ];
        if (d.code !== null && d.cause !== 'pong_timeout')
          parts.push(t.disconnectCode({ code: String(d.code) }));
        if (d.detail !== null) parts.push(d.detail);
        if (d.pongWaitMs !== null) parts.push(t.disconnectWaited({ ms: fmt.number(d.pongWaitMs) }));
        if (d.loopDelayMaxMs !== null) parts.push(t.disconnectLoop({ ms: fmt.number(d.loopDelayMaxMs) }));
        if (d.cause === 'pong_timeout' && d.loopDelayMaxMs !== null)
          parts.push(d.loopDelayMaxMs >= STALL_MS ? t.disconnectStalled : t.disconnectNetwork);
        return (
          <li key={`${d.at}-${d.cause}`} className="text-[0.8125rem]" data-cause={d.cause}>
            <span className="font-dy-mono text-dy-muted">{fmt.dateWith(d.at, DATE_TIME_NUMERIC)}</span>
            {' · '}
            {parts.join(' · ')}
          </li>
        );
      })}
    </ul>
  );
}

function Facts(props: {
  readonly worker: WorkerDetail;
  readonly overview: WorkerOverview | undefined;
  readonly pauses: readonly QuotaPause[];
}): ReactNode {
  const fmt = useFormat();
  const tAll = useT();
  const t = tAll.machines.page.facts;
  const statusWords = tAll.machineManaged.update.last.status;
  // p17-ui-review: the updater's status in words (the Yönetim tab's catalog), the raw value only when unknown.
  const statusText = (s: string): string =>
    Object.hasOwn(statusWords, s) ? statusWords[s as keyof typeof statusWords] : s.replaceAll('_', ' ');
  const w = props.worker;
  const o = props.overview;
  const rows: KeyValueRow[] = [
    {
      k: t.connection,
      v: (
        <>
          {w.connected ? t.connected : t.lastSeen({ ago: agoText(w.lastSeenAt) })}
          {w.drainRequestedAt !== null ? (
            <span className="text-dy-muted">
              {' '}
              · {t.drainRequested({ when: fmt.dateWith(w.drainRequestedAt, DATE_TIME_NUMERIC) })}
            </span>
          ) : null}
        </>
      ),
    },
  ];
  // p17-chat-reconnect: why the connection dropped lately, as the machine itself reported it.
  if (w.disconnects.length > 0) rows.push({ k: t.disconnects, v: <Disconnects list={w.disconnects} /> });
  if (o?.load)
    rows.push({
      k: t.load,
      v: t.loadValue({
        cpu: fmt.percent(Math.round(o.load.cpuPercent) / 100),
        memory: gib(o.load.memoryFreeBytes, fmt),
        disk: gib(o.load.diskFreeBytes, fmt),
      }),
    });
  // p15-merge-approvals item 4: free disk under the workspace root vs. the machine's minimum; below it the master
  // places no job here (disk_low) — say so, with the setting that decides it.
  const wd = o?.load?.workspaceDisk;
  if (wd !== undefined) {
    const low = wd.freeBytes < wd.minFreeBytes;
    rows.push({
      k: t.workspaceDisk,
      v: (
        <span data-testid="workspace-disk">
          <span className={low ? 'font-bold text-dy-red-ink' : undefined}>
            {t.workspaceDiskValue({ free: gib(wd.freeBytes, fmt), min: gib(wd.minFreeBytes, fmt) })}
          </span>
          {low ? (
            <span className="block text-[0.8125rem] text-dy-red-ink" role="alert">
              {t.diskLow}{' '}
              <Link
                to={machinePath(w.id, 'configuration')}
                className="font-bold underline underline-offset-2"
              >
                {t.diskLowFix}
              </Link>
            </span>
          ) : null}
        </span>
      ),
    });
  }
  if (o !== undefined) rows.push({ k: t.readyRuntimes, v: <ReadyRuntimes overview={o} /> });
  rows.push({
    k: t.version,
    v: (
      <span data-testid="release-state">
        <span className="font-dy-mono">{w.workerVersion}</span>
        {o !== undefined ? (
          <span className="text-dy-muted">
            {' '}
            · {t.channel({ channel: o.release.channel })}
            {o.release.targetVersion !== null ? ` · ${t.pinnedTo({ version: o.release.targetVersion })}` : ''}
          </span>
        ) : null}
        {o?.release.lastAttempt ? (
          <span className="block text-[0.8125rem] text-dy-muted">
            {t.lastUpdate} <span className="font-dy-mono">{o.release.lastAttempt.toVersion}</span>:{' '}
            {statusText(o.release.lastAttempt.status)}
            {o.release.lastAttempt.reason !== null
              ? ` (${o.release.lastAttempt.reason.replaceAll('_', ' ')})`
              : ''}
          </span>
        ) : null}
      </span>
    ),
  });
  if (o !== undefined) {
    rows.push({
      k: t.runtimePolicy,
      v: (
        <>
          {o.runtimePolicy.effective === null
            ? t.policyNone
            : `${o.runtimePolicy.effective} v${String(o.runtimePolicy.version ?? '?')}${o.runtimePolicy.stage === 'canary' ? ' (canary)' : ''}`}
          {' · '}
          {o.runtimePolicy.inSync ? (
            <span className="text-dy-green">{t.applied}</span>
          ) : (
            <span className="text-dy-amber-ink">{t.notApplied}</span>
          )}
        </>
      ),
    });
    rows.push({
      k: t.sandbox,
      v:
        o.sandboxReadiness.length === 0 ? (
          <span className="text-dy-muted">
            {o.sandboxProfiles.length > 0 ? o.sandboxProfiles.join(', ') : t.notReported}
          </span>
        ) : (
          // p17-ui-review: the ready profiles on one line; a profile that is not ready gets its own line with why.
          <div className="flex flex-col gap-0.5" data-testid="sandbox-readiness">
            {o.sandboxReadiness.some((s) => s.ready) ? (
              <span>
                <span className="font-bold text-dy-green">{t.ready}</span>
                {': '}
                <span className="font-dy-mono">
                  {o.sandboxReadiness
                    .filter((s) => s.ready)
                    .map((s) => s.profile)
                    .join(', ')}
                </span>
              </span>
            ) : null}
            {o.sandboxReadiness
              .filter((s) => !s.ready)
              .map((s) => (
                <span key={s.profile}>
                  <span className="font-bold text-dy-muted">{t.notReady}</span>
                  {': '}
                  <span className="font-dy-mono">{s.profile}</span>
                  {s.reason !== null ? (
                    <span className="block text-[0.8125rem] text-dy-muted">{s.reason}</span>
                  ) : null}
                </span>
              ))}
          </div>
        ),
    });
    rows.push({
      k: t.tools,
      v:
        o.tools.length === 0 ? (
          <span className="text-dy-muted">{t.notReported}</span>
        ) : (
          o.tools.map((x) => (x.version ? `${x.name} ${x.version}` : x.name)).join(', ')
        ),
    });
    rows.push({ k: t.network, v: o.network.label });
  }
  rows.push({ k: t.fingerprint, v: w.fingerprint ?? '—', mono: true });
  rows.push({ k: t.added, v: fmt.dateWith(w.createdAt, DATE_TIME_NUMERIC) });
  return (
    <Panel title={t.title} testId="worker-facts">
      <KeyValue rows={rows} />
    </Panel>
  );
}

function Overview(props: {
  readonly data: MachineData & { readonly worker: WorkerDetail };
  readonly isAdmin: boolean;
  readonly focusCode: number;
  readonly onFocused: () => void;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().machines.page;
  const { worker: w, overview: o, pauses, jobs, reload } = props.data;
  const active = w.state !== 'pending' && w.archivedAt === null;
  const healthy = active && machineReasons(w, o, pauses).length === 0;
  const ready = (o?.compatibility ?? []).filter((c) => c.status === 'ready' || c.status === 'degraded');
  return (
    <div className="flex flex-col gap-5">
      {w.state === 'pending' ? (
        <Panel title={t.pairTitle} testId="pair-machine">
          <PairingCard
            worker={w}
            onChanged={reload}
            focusRequest={props.focusCode}
            onFocused={props.onFocused}
          />
        </Panel>
      ) : null}
      {w.archivedAt !== null ? (
        <p
          className="m-0 rounded-[10px] bg-dy-sunk px-3.5 py-2.5 text-[0.875rem] text-dy-muted"
          data-testid="worker-archived-note"
        >
          {t.archivedNote({ when: fmt.dateWith(w.archivedAt, DATE_TIME_NUMERIC) })}
        </p>
      ) : null}
      <Reasons worker={w} overview={o} pauses={pauses} />
      {healthy && ready.length > 0 ? (
        <p
          className="m-0 flex items-center gap-2 rounded-[10px] bg-dy-green-soft px-3.5 py-2.5 text-[0.9375rem] text-dy-green"
          data-testid="machine-healthy"
        >
          <DyIcon name="checkc" className="size-4 shrink-0" />
          <span>
            <b>{t.healthyTitle}</b> {t.healthy({ name: w.name, n: ready.length })}
          </span>
        </p>
      ) : null}
      {/* p17-ui-review: two independent column stacks (no grid rows, so a short panel leaves no hole next to a tall one):
          what runs here and the facts on the left, the limit windows on the right; capacity below, closed to one line. */}
      <div
        className={
          active ? 'flex flex-col gap-5 lg:grid lg:grid-cols-2 lg:items-start' : 'flex flex-col gap-5'
        }
      >
        {/* On a phone the columns dissolve (`contents`) and the order is slots, limits, facts. */}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-5">
          {active ? (
            <div className="order-1 min-w-0 lg:order-none">
              <SlotsAndJobs worker={w} overview={o} jobs={jobs} />
            </div>
          ) : null}
          <div className="order-3 min-w-0 lg:order-none">
            <Facts worker={w} overview={o} pauses={pauses} />
          </div>
        </div>
        {active ? (
          <div className="order-2 flex min-w-0 flex-col gap-5 lg:order-none">
            <Limits workerId={w.id} />
          </div>
        ) : null}
      </div>
      {o !== undefined && active ? (
        <CapacityPanels worker={w} overview={o} isAdmin={props.isAdmin} onChanged={reload} collapsed />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ other tabs

function TabBody(props: {
  readonly tab: string;
  readonly data: MachineData & { readonly worker: WorkerDetail };
  readonly isAdmin: boolean;
  readonly focusCode: number;
  readonly onFocused: () => void;
}): ReactNode {
  const { worker: w, overview, reload } = props.data;
  const tabProps = { worker: w, overview, isAdmin: props.isAdmin, onChanged: reload };
  switch (props.tab) {
    case 'runtimes':
      return (
        <div className="flex flex-col gap-5">
          <Limits workerId={w.id} />
          <RuntimesTab {...tabProps} />
        </div>
      );
    case 'tools':
      return <ToolsTab {...tabProps} />;
    case 'sandbox':
      return <SandboxTab {...tabProps} />;
    case 'configuration':
      return <ConfigurationTab {...tabProps} />;
    case 'admin':
      return <AdminTab {...tabProps} />;
    case 'activity':
      return <ActivityTab {...tabProps} />;
    case 'services':
      // p15-services: what this machine keeps running outside jobs (no job slot).
      return <ServicesPanel workerId={w.id} canManage />;
    default:
      return (
        <Overview
          data={props.data}
          isAdmin={props.isAdmin}
          focusCode={props.focusCode}
          onFocused={props.onFocused}
        />
      );
  }
}

// ------------------------------------------------------------------------------------------------ page

export function MachineScreen(props: { readonly id: string }): ReactNode {
  const data = useMachine(props.id);
  const servicesLabel = useT().services.tab;
  const { state: auth } = useAuth();
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  const [, setParams] = useSearchParams();
  const [focusCode, setFocusCode] = useState(0);
  const focused = useCallback(() => {
    setFocusCode(0);
  }, []);
  const tm = useT().machines;
  const t = tm.page;
  const w = data.worker;
  const back = { to: '/machines', label: tm.list.title };
  // p15-chat-cards-scroll: an admin renames the machine in place (pencil in the title).
  const nameEdit = useMachineNameEdit({ worker: w, canEdit: isAdmin, onSaved: data.reload });

  if (w === null) {
    return (
      <ScreenFrame title={t.machine} back={back} testId="dy-machine">
        {data.error !== null ? (
          data.error.status === 404 ? (
            <Panel title={t.notFound}>
              <p className="m-0 mb-3 text-dy-muted">{t.notFoundBody}</p>
              <DyButtonLink to="/machines">{t.allMachines}</DyButtonLink>
            </Panel>
          ) : (
            <ErrorLine error={data.error} what={t.machine} onRetry={data.reload} />
          )
        ) : (
          <Panel title={t.machine} flush>
            <SkeletonRows label={t.loading} rows={4} />
          </Panel>
        )}
      </ScreenFrame>
    );
  }

  const loaded = { ...data, worker: w };
  // p17-ui-review: what needs the user, counted as the cards the overview shows (a group of runtimes is one).
  const reasons = groupMachineReasons(machineReasons(w, data.overview, data.pauses)).filter(
    (c) => (c.kind === 'one' ? c.item.tone : c.tone) !== 'neutral',
  ).length;
  const tabs: TabItem[] = machineTabs(w, isAdmin).map((tab) => ({
    id: tab,
    label: t.tabs[tab],
    ...(tab === 'overview' ? { count: reasons } : {}),
  }));
  // p15-services: Servisler after Araçlar (Diyalog only; not for pending / removed machines).
  if (w.state !== 'pending' && w.archivedAt === null) {
    const at = tabs.findIndex((x) => x.id === 'tools');
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, { id: 'services', label: servicesLabel });
  }
  const pending = w.state === 'pending';
  const s = slotsOf(w, data.overview);

  return (
    <ScreenFrame
      title={w.name}
      titleAccessory={nameEdit.accessory}
      titleEditor={nameEdit.editor}
      back={back}
      live={data.error !== null ? 'error' : 'live'}
      testId="dy-machine"
      purpose={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <MachineStateMark worker={w} />
          <span>{platformText(w.os, w.arch, tm.shared.unknownOs)}</span>
          <span>
            {t.version} <span className="font-dy-mono">{w.workerVersion}</span>
          </span>
          {w.hostname !== null && w.hostname !== w.name ? (
            <span className="font-dy-mono" translate="no">
              {w.hostname}
            </span>
          ) : null}
        </span>
      }
      facts={
        pending || w.archivedAt !== null ? undefined : (
          <>
            <Chip
              icon="cpu"
              value={w.connected ? `${String(s.used)}/${String(s.max)}` : '—'}
              label={t.slotsFull({ used: s.used, max: s.max })}
            >
              {t.slot}
            </Chip>
            {data.overview !== undefined ? <Chip icon="globe">{data.overview.network.label}</Chip> : null}
            {data.pauses.length > 0 ? (
              <Chip icon="pause" hot>
                {t.paused({ n: data.pauses.length })}
              </Chip>
            ) : null}
          </>
        )
      }
      actions={
        pending && !w.pairingExpired ? (
          <span data-testid="page-actions">
            <DyButton
              variant="primary"
              icon="key"
              onClick={() => {
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.delete('tab');
                    return next;
                  },
                  { replace: true },
                );
                setFocusCode((n) => n + 1);
              }}
            >
              {t.approve}
            </DyButton>
          </span>
        ) : undefined
      }
    >
      {nameEdit.status}
      <ErrorLine error={data.error} what={t.machine} onRetry={data.reload} />
      {pending || w.archivedAt !== null ? null : <RestartBanner workerId={w.id} isAdmin={isAdmin} />}
      <SegTabs label={t.machine} items={tabs}>
        {(tab) => (
          <div data-testid="worker-details" data-tab={tab}>
            <TabBody tab={tab} data={loaded} isAdmin={isAdmin} focusCode={focusCode} onFocused={focused} />
          </div>
        )}
      </SegTabs>
    </ScreenFrame>
  );
}
