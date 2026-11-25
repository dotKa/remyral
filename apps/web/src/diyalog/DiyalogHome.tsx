import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getBackupOverview, type HealthState } from '../api/backups';
import { type ExpirySummary, getCostBrake, getExpiry } from '../api/opsSafety';
import { getSystemStatus, type SystemStatus } from '../api/system';
import { ApiError } from '../api/client';
import type { JobSummary } from '../api/jobs';
import type { OpsItem } from '../api/opsThread';
import { getQueue, PRIORITY_CLASS_LABEL, PRIORITY_CLASSES, type QueueView } from '../api/queue';
import {
  accountText,
  getUsageOverview,
  orderedWindows,
  percentText,
  resetText,
  runtimeSummary,
  type UsageLevel,
  type UsageOverview,
  windowName,
} from '../api/runtimeUsage';
import { listMonitorsPage } from '../api/uptime';
import { getUsageSummary, type UsageSummary } from '../api/usage';
import { useAuth } from '../auth/AuthProvider';
import { cx } from '../components/ui';
import { type InvalidationTopic, onInvalidate } from '../lib/invalidate';
import { useNow } from '../lib/now';
import { useRememberedState } from '../lib/remembered';
import { machineHref, runtimeName } from '../lib/reasons';
import { type Loaded, useDismissed, useHomeData, useSnoozed } from '../screens/home/homeData';
import { isActiveMachine } from '../screens/home/needsYou';
import { POLL_MS } from '../shell/notificationPoll';
import { DyHeaderTools } from './topbar';
import { remainingText } from './Countdown';
import { DyIcon, type IconName } from './icons';
import { eventLook } from './ops/cards';
import { useDecisions } from './ops/decisions';
import { FailureDigestLine } from './ops/FailureDigest';
import { CostBrakeBanner } from './ops/CostBrakeBanner';
import { useOpsEvents } from './ops/useOpsEvents';
import { useWaitingWatches, WaitingWatches } from './ops/WaitingWatches';
import { cardFor } from './registry';
import { runtimeCode, RuntimeMark, runtimeDisplayName } from './RuntimeMark';
import { agoText, DyButtonLink, EmptyLine, Meter, Panel, SkeletonRows, SlotCells } from './screens/parts';
import { FleetToolsLink } from './screens/machines/fleet-tools-parts';
import { StateBadge } from './StateBadge';
import { INK, type Tone } from './tone';
import { NeedsTile, QuickAccess } from './homeTiles';
import './ops/register';
import { fill, type Messages } from '@remyral/i18n';
import { useFormat, useT } from '../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from './common/time';
import { DyOnboardingCard } from './onboarding/nudge';

/**
 * p12-diyalog: the Home PANEL dashboard (a design change, docs/design/p12-diyalog.md §9). It
 * replaced the Faz 1 operations thread: the same data (`GET /ops-thread` for the decisions and the event history, the
 * classic Home reads for jobs and machines) laid out as panels, no chat bubbles and no composer.
 *
 * p17-needs-page (docs/design/p17-needs-page.md): the decisions moved to their own page (`/needs`); the home is the
 * dashboard and the quick-access area:
 *
 *   top    "Senden bekleyen" summary (count, kinds, the most urgent one, "Tümünü aç") · Hızlı erişim ("Yeni iş" in
 *          Sohbet, "Formla", the screens)
 *   grid   Bekleniyor (p20-quick: active watches, only when there are any) · Çalışan işler · Bugün · Kuyruk özeti ·
 *          Makineler · Runtime limitleri · Son olaylar · Sağlık · Son hatalar
 *
 * Every feature of the former classic Home has its place here or on `/needs` (docs/design/p15-classic-removal.md).
 */

// ------------------------------------------------------------------------------------------------ data

/**
 * Polls `load` while the tab is visible (and at once on `topics` invalidations); `data` stays null when the source is
 * not readable (403 / 404: older master, no access) — the panel then says so instead of waiting. `dep` reloads it.
 */
function usePolled<T>(
  load: () => Promise<T>,
  ms: number,
  opts: {
    readonly topics?: readonly InvalidationTopic[];
    readonly dep?: string;
    /** p14-web-perf: remembers the last answer under this key (a revisit shows it while refreshing). */
    readonly key?: string;
  } = {},
): { readonly data: T | null; readonly settled: boolean } {
  const [state, setState] = useRememberedState<{ data: T | null; settled: boolean }>(
    opts.key === undefined ? null : `home:${opts.key}`,
    { data: null, settled: false },
  );
  const ref = useRef(load);
  ref.current = load;
  const topics = (opts.topics ?? []).join(',');
  const dep = opts.dep ?? '';
  useEffect(() => {
    let live = true;
    const run = (): void => {
      ref.current().then(
        (v) => {
          if (live) setState({ data: v, settled: true });
        },
        (err: unknown) => {
          if (!live) return;
          if (err instanceof ApiError && (err.status === 403 || err.status === 404))
            setState({ data: null, settled: true });
          else setState((s) => ({ ...s, settled: true }));
        },
      );
    };
    run();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') run();
    }, ms);
    const off = topics === '' ? () => undefined : onInvalidate(topics.split(',') as InvalidationTopic[], run);
    return () => {
      live = false;
      clearInterval(t);
      off();
    };
  }, [ms, topics, dep, setState]);
  return state;
}

function startOfToday(now: number): Date {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

interface Health {
  readonly backups: {
    readonly state: HealthState;
    readonly lagSeconds: number | null;
    readonly at: string | null;
  } | null;
  readonly monitors: { readonly down: number; readonly up: number } | null;
  /** p16-ops-safety: keys and certificates needing attention (owners / admins; null for others). */
  readonly expiry: ExpirySummary | null;
  /** p16-ops-safety: the cost brake — engaged ceilings and whether they hold work. */
  readonly brake: { readonly engaged: number; readonly blocking: boolean } | null;
  /** p16-observability: the status page's verdict (owners and admins; null for others or an older master). */
  readonly system: { readonly overall: SystemStatus['overall']; readonly problems: number } | null;
}

async function loadHealth(admin: boolean): Promise<Health> {
  const [b, down, up, ex, cb, sys] = await Promise.allSettled([
    getBackupOverview(),
    listMonitorsPage({ status: 'down' }, { offset: 0, limit: 1 }),
    listMonitorsPage({ status: 'up' }, { offset: 0, limit: 1 }),
    getExpiry(),
    getCostBrake(),
    admin ? getSystemStatus() : Promise.resolve(null),
  ]);
  return {
    system:
      sys.status === 'fulfilled' && sys.value !== null
        ? { overall: sys.value.overall, problems: sys.value.problems.length }
        : null,
    backups:
      b.status === 'fulfilled'
        ? {
            state: b.value.health.state,
            lagSeconds: b.value.standby?.enabled === true ? b.value.standby.lagSeconds : null,
            at: b.value.lastBackup?.finishedAt ?? b.value.lastBackup?.startedAt ?? null,
          }
        : null,
    monitors:
      down.status === 'fulfilled' && up.status === 'fulfilled'
        ? { down: down.value.total, up: up.value.total }
        : null,
    expiry: ex.status === 'fulfilled' ? ex.value.summary : null,
    brake:
      cb.status === 'fulfilled' ? { engaged: cb.value.engaged.length, blocking: cb.value.blocking } : null,
  };
}

// ------------------------------------------------------------------------------------------------ top bar

function TopBar(props: { readonly status: 'loading' | 'ready' | 'error' | 'off' }): ReactNode {
  const w = useT().home.topBar;
  return (
    <div className="sticky top-0 z-[5] flex min-h-[53px] items-center gap-3 border-b border-dy-line bg-dy-thread/85 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-[14px] backdrop-saturate-150 sm:px-6">
      <span
        className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-dy-teal text-dy-on-fill md:hidden"
        aria-hidden="true"
      >
        <DyIcon name="home" />
      </span>
      <span
        className="hidden text-[0.9375rem] font-extrabold tracking-[-0.01em] sm:inline"
        aria-hidden="true"
      >
        {w.title}
      </span>
      <span className="flex items-center gap-[7px] text-[0.78125rem] text-dy-muted">
        <span
          className={cx(
            'size-2 rounded-full',
            props.status === 'error' ? 'bg-dy-red' : 'dy-breathe bg-dy-green',
          )}
          aria-hidden="true"
        />
        {props.status === 'error' ? w.offline : w.live}
      </span>
      <DyHeaderTools className="ml-auto" />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ panels

function since(iso: string, now: number): string {
  return remainingText(Math.max(0, now - Date.parse(iso)));
}

function jobState(j: JobSummary, t: Messages): ReactNode {
  const w = t.home.jobStates;
  switch (j.state) {
    case 'AWAITING_APPROVAL':
      return <StateBadge state="needs" label={w.awaitingApproval} />;
    case 'VERIFYING':
      return <StateBadge state="running" label={w.verifying} />;
    case 'STARTING':
      return <StateBadge state="running" label={w.starting} />;
    default:
      return <StateBadge state="running" />;
  }
}

function RunningJobs(props: { readonly data: Loaded | null; readonly now: number }): ReactNode {
  const t = useT();
  const w = t.home.running;
  const jobs = props.data?.running ?? [];
  const names = new Map((props.data?.workers ?? []).map((m) => [m.id, m.name] as const));
  return (
    <Panel
      title={w.title}
      count={props.data === null ? undefined : String(jobs.length)}
      countLabel={w.countLabel({ n: jobs.length })}
      aside={
        <Link to="/jobs" className="text-[0.8125rem] text-dy-teal-ink no-underline hover:underline">
          {w.all}
        </Link>
      }
      flush
      testId="dy-home-running"
    >
      {props.data === null ? (
        <SkeletonRows label={w.loading} />
      ) : jobs.length === 0 ? (
        <EmptyLine>{w.empty}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0" aria-label={w.title}>
          {jobs.slice(0, 8).map((j) => (
            <li key={j.id} className="border-t border-dy-line first:border-t-0">
              <Link
                to={`/jobs/${encodeURIComponent(j.id)}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-inherit no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
              >
                <span className="min-w-0 truncate text-[0.9375rem] font-medium">
                  {j.title === '' ? t.home.untitledJob : j.title}
                </span>
                <span className="row-span-2 self-center text-right font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                  {since(j.stateChangedAt, props.now)}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[0.8125rem] text-dy-muted">
                  {jobState(j, t)}
                  {j.runtime === null ? null : <RuntimeMark runtime={j.runtime} />}
                  {j.workerId === null ? null : (
                    <span className="inline-flex items-center gap-1 truncate font-dy-mono" translate="no">
                      <DyIcon name="cpu" className="size-3.5" />
                      {names.get(j.workerId) ?? j.workerId.slice(0, 8)}
                    </span>
                  )}
                  <span className="truncate">{j.project}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {jobs.length > 8 ? (
        <p className="m-0 border-t border-dy-line px-4 py-2 text-[0.8125rem] text-dy-muted">
          <Link to="/jobs" className="text-dy-teal-ink">
            {w.more({ n: jobs.length - 8 })}
          </Link>
        </p>
      ) : null}
    </Panel>
  );
}

function Figure(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: Tone | undefined;
  readonly note?: ReactNode;
  readonly to?: string | undefined;
}): ReactNode {
  const body = (
    <>
      <dt className="text-[0.8125rem] text-dy-muted">{props.label}</dt>
      <dd
        className={cx(
          'm-0 text-[1.375rem] leading-tight font-extrabold tracking-[-0.015em] tabular-nums',
          props.tone === undefined ? '' : INK[props.tone],
        )}
      >
        {props.value}
      </dd>
      {props.note === undefined ? null : <dd className="m-0 text-[0.75rem] text-dy-muted">{props.note}</dd>}
    </>
  );
  return props.to === undefined ? (
    <div className="min-w-0">{body}</div>
  ) : (
    <Link
      to={props.to}
      className="min-w-0 rounded-lg text-inherit no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
    >
      {body}
    </Link>
  );
}

function Today(props: {
  readonly data: Loaded | null;
  readonly usage: UsageSummary | null;
  readonly now: number;
}): ReactNode {
  const start = startOfToday(props.now).getTime();
  const today = (j: JobSummary): boolean => Date.parse(j.stateChangedAt) >= start;
  const done = (props.data?.later ?? []).filter((j) => j.state === 'SUCCEEDED' && today(j)).length;
  const failed = (props.data?.failed ?? []).filter(today).length;
  const cost = props.usage?.totals.costUsd.total ?? null;
  const sub = props.usage?.totals.flags.hasSubscription === true;
  const w = useT().home.today;
  const f = useFormat();
  return (
    <Panel title={w.title} testId="dy-home-today" sub={w.sub}>
      {props.data === null ? (
        <SkeletonRows label={w.loading} rows={2} />
      ) : (
        <dl className="m-0 grid grid-cols-3 gap-3">
          <Figure
            label={w.succeeded}
            value={done}
            tone={done > 0 ? 'green' : undefined}
            to="/jobs?state=SUCCEEDED"
          />
          <Figure
            label={w.failed}
            value={failed}
            tone={failed > 0 ? 'red' : undefined}
            to="/jobs?state=FAILED"
          />
          <Figure
            label={w.cost}
            value={
              cost === null
                ? '—'
                : f.number(cost, {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
            }
            note={cost === null ? w.hidden : sub ? w.subscription : undefined}
            to="/usage"
          />
        </dl>
      )}
    </Panel>
  );
}

function Queue(props: {
  readonly queue: QueueView | null;
  readonly loaded: boolean;
  readonly now: number;
}): ReactNode {
  const q = props.queue;
  const jobs = q === null ? [] : q.pools.flatMap((p) => p.jobs);
  const byClass = PRIORITY_CLASSES.map((c) => ({ c, n: jobs.filter((j) => j.priorityClass === c).length }));
  const next = [...jobs]
    .sort(
      (a, b) =>
        (a.estimatedStart === null ? 1 : 0) - (b.estimatedStart === null ? 1 : 0) || a.position - b.position,
    )
    .slice(0, 3);
  const t = useT();
  const w = t.home.queue;
  return (
    <Panel
      title={w.title}
      count={q === null ? undefined : String(q.total)}
      countLabel={q === null ? undefined : w.countLabel({ n: q.total })}
      aside={
        <Link to="/jobs?tab=queue" className="text-[0.8125rem] text-dy-teal-ink no-underline hover:underline">
          {w.link}
        </Link>
      }
      testId="dy-home-queue"
    >
      {q === null ? (
        props.loaded ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{w.hidden}</p>
        ) : (
          <SkeletonRows label={w.loading} rows={2} />
        )
      ) : (
        <div className="grid gap-3">
          <dl className="m-0 grid grid-cols-3 gap-3">
            {byClass.map(({ c, n }) => (
              <Figure
                key={c}
                label={PRIORITY_CLASS_LABEL[c]}
                value={n}
                tone={c === 'urgent' && n > 0 ? 'red' : undefined}
              />
            ))}
          </dl>
          {q.paused.length > 0 ? (
            <p className="m-0 flex items-center gap-1.5 text-[0.8125rem] text-dy-violet">
              <DyIcon name="pause" className="size-3.5" />
              {w.paused({ n: q.paused.length })}
            </p>
          ) : null}
          {next.length === 0 ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{w.empty}</p>
          ) : (
            <div>
              <h3 className="m-0 mb-1 text-[0.8125rem] font-bold text-dy-muted">{w.next}</h3>
              <ul className="m-0 grid list-none gap-1 p-0">
                {next.map((j) => (
                  <li key={j.jobId} className="flex items-center gap-2 text-[0.84375rem]">
                    <span className="w-6 shrink-0 font-dy-mono text-dy-muted tabular-nums">{`#${String(j.position)}`}</span>
                    <Link
                      to={`/jobs/${encodeURIComponent(j.jobId)}`}
                      className="min-w-0 flex-1 truncate text-inherit no-underline hover:underline"
                    >
                      {j.title === '' ? t.home.untitledJob : j.title}
                    </Link>
                    <span className="shrink-0 font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
                      {j.estimatedStart === null
                        ? w.noEstimate
                        : Date.parse(j.estimatedStart) <= props.now
                          ? w.now
                          : `~${remainingText(Date.parse(j.estimatedStart) - props.now)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Machines(props: { readonly data: Loaded | null; readonly canAdd: boolean }): ReactNode {
  const { data } = props;
  const all = useT();
  const w = all.home.machines;
  const caps = new Map((data?.overview ?? []).map((o) => [o.id, o] as const));
  const machines = (data?.workers ?? []).filter(isActiveMachine);
  const rows = machines
    .map((w) => {
      const o = caps.get(w.id);
      const ready =
        o === undefined
          ? 0
          : o.compatibility.filter((c) => c.status === 'ready' || c.status === 'degraded').length;
      return {
        w,
        used: o?.capacity.running ?? w.runningJobs,
        max: o?.capacity.max ?? Math.max(1, w.runningJobs),
        ready,
        total: o?.compatibility.length ?? 0,
      };
    })
    .sort((a, b) => Number(!a.w.connected) - Number(!b.w.connected) || a.w.name.localeCompare(b.w.name));
  const online = rows.filter((r) => r.w.connected);
  const used = online.reduce((n, r) => n + r.used, 0);
  const max = online.reduce((n, r) => n + r.max, 0);
  return (
    <Panel
      title={w.title}
      count={rows.length === 0 ? undefined : `${String(used)}/${String(max)}`}
      countLabel={w.slotsUsed({ used, max })}
      sub={rows.length === 0 ? undefined : w.online({ n: online.length, total: rows.length })}
      aside={
        <>
          {/* p13-fleet-tools: "N güncelleme" → Araçlar ve sürümler (only when there are updates). */}
          <FleetToolsLink variant="home" />
          <Link to="/machines" className="text-[0.8125rem] text-dy-teal-ink no-underline hover:underline">
            {w.all}
          </Link>
        </>
      }
      flush
      testId="dy-home-machines"
    >
      {data === null ? (
        <SkeletonRows label={w.loading} />
      ) : data.workers === null ? (
        <EmptyLine>{w.hidden}</EmptyLine>
      ) : rows.length === 0 ? (
        <EmptyLine
          action={
            props.canAdd ? (
              <DyButtonLink to="/machines/add" icon="plus">
                {w.add}
              </DyButtonLink>
            ) : undefined
          }
        >
          {w.empty}
        </EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0" aria-label={w.title}>
          {rows.map((r) => (
            <li key={r.w.id} className="border-t border-dy-line first:border-t-0">
              <Link
                to={machineHref(r.w.id)}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 text-inherit no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
              >
                <span
                  className={cx(
                    'min-w-0 truncate font-dy-mono text-[0.84375rem]',
                    !r.w.connected && 'text-dy-red-ink',
                  )}
                  translate="no"
                >
                  {r.w.name}
                </span>
                <SlotCells
                  used={r.used}
                  max={r.max}
                  off={!r.w.connected}
                  limit={8}
                  label={r.w.connected ? w.slotsUsed({ used: r.used, max: r.max }) : w.off}
                />
                <span className="col-span-2 text-[0.75rem] text-dy-muted tabular-nums">
                  {!r.w.connected
                    ? r.w.lastSeenAt === null
                      ? w.off
                      : w.offSince({ ago: agoText(r.w.lastSeenAt, Date.now(), all.screenKit.time) })
                    : r.total > 0
                      ? w.ready({ ready: r.ready, total: r.total, used: r.used })
                      : w.noRuntime}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface LimitLine {
  readonly key: string;
  readonly runtime: string;
  readonly name: string;
  readonly percent: number | null;
  readonly text: string;
  readonly level: UsageLevel;
}

const BAR: Readonly<Record<string, string>> = {
  cc: 'bg-dy-cc',
  cx: 'bg-dy-cx',
  pi: 'bg-dy-pi',
  oc: 'bg-dy-oc',
};

export function limitLines(usage: UsageOverview | null, now: number): LimitLine[] {
  if (usage === null) return [];
  const runtimes = [...new Set(usage.entries.map((e) => e.runtime))];
  const out: LimitLine[] = [];
  for (const rt of runtimes) {
    const { best, multiAccount } = runtimeSummary(usage.entries, rt);
    if (best === null) continue;
    if (multiAccount) {
      // p13-runtime-accounts: one line per account (its fullest window), named by its label. The same subscription
      // added on several machines is reported by each of them: one line per account and window, the fullest report.
      const byAccount = new Map<string, LimitLine>();
      for (const e of usage.entries.filter((x) => x.runtime === rt && x.auth === 'subscription')) {
        const w = orderedWindows(e.windows)[0];
        if (w === undefined) continue;
        const reset = w.resetsAt === null ? '' : `, ${resetText(w.resetsAt, now)}`;
        const key = `${rt}:${accountText(e)}:${w.id}`;
        const prev = byAccount.get(key);
        if (prev !== undefined && (prev.percent ?? -1) >= (w.usedPercent ?? -1)) continue;
        byAccount.set(key, {
          key,
          runtime: rt,
          name: `${runtimeDisplayName(rt)} · ${accountText(e)} ${windowName(w)}`,
          percent: w.usedPercent,
          text: `${percentText(w.usedPercent)}${reset}`,
          level: w.level,
        });
      }
      out.push(...byAccount.values());
      continue;
    }
    for (const w of orderedWindows(best.windows).slice(0, 2)) {
      const reset = w.resetsAt === null ? '' : `, ${resetText(w.resetsAt, now)}`;
      out.push({
        key: `${rt}:${w.id}`,
        runtime: rt,
        name: `${runtimeDisplayName(rt)} ${windowName(w)}`,
        percent: w.usedPercent,
        text: `${percentText(w.usedPercent)}${reset}`,
        level: w.level,
      });
    }
  }
  return out;
}

function Limits(props: { readonly usage: UsageOverview | null; readonly now: number }): ReactNode {
  const lines = limitLines(props.usage, props.now);
  const paused = props.usage?.otherLimits ?? [];
  const w = useT().home.limits;
  return (
    <Panel
      title={w.title}
      aside={
        <Link to="/usage" className="text-[0.8125rem] text-dy-teal-ink no-underline hover:underline">
          {w.usage}
        </Link>
      }
      testId="dy-home-limits"
    >
      {lines.length === 0 && paused.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{props.usage === null ? w.noData : w.none}</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {lines.map((l) => {
            const code = runtimeCode(l.runtime);
            return (
              <li key={l.key}>
                <Meter
                  label={l.name}
                  value={l.percent}
                  text={l.text}
                  tone={l.level === 'limited' ? 'red' : l.level === 'near' ? 'amber' : undefined}
                  fill={l.level === 'ok' && code !== null ? BAR[code] : undefined}
                />
              </li>
            );
          })}
          {paused.map((o) => (
            <li key={o.id} className="flex items-center gap-1.5 text-[0.8125rem] text-dy-violet">
              <DyIcon name="pause" className="size-3.5" />
              {w.paused({ runtime: runtimeDisplayName(o.runtime), when: resetText(o.resumeAt, props.now) })}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function eventLine(
  i: OpsItem,
  t: Messages,
): { icon: IconName; tone: Tone; text: string; link: string | null } {
  if (i.type === 'event') {
    const e = i.event;
    if (e === null) return { icon: 'bubble', tone: 'neutral', text: i.kind, link: null };
    const look = eventLook(e);
    return {
      icon: look.icon,
      tone: look.warn ? 'red' : 'neutral',
      text: e.body === '' ? e.title : `${e.title}: ${e.body}`,
      link: e.link,
    };
  }
  const spec = cardFor(i.type).kind;
  const label =
    i.type === 'approval:request'
      ? t.home.kinds.approval
      : i.type === 'deploy:action'
        ? t.home.kinds.deploy
        : i.type === 'merge:integration'
          ? t.home.kinds.merge
          : i.type === 'job:failed'
            ? t.home.kinds.failed
            : i.type === 'workflow:approval'
              ? t.chatFlow.approval.kind
              : t.home.kinds.limit;
  const title =
    i.type === 'approval:request'
      ? i.approval.headline.text
      : i.type === 'deploy:action'
        ? `${i.deploy.project} ${i.deploy.env ?? ''}`.trim()
        : i.type === 'merge:integration'
          ? i.merge.branch
          : i.type === 'job:failed'
            ? i.job.title
            : i.type === 'workflow:approval'
              ? (i.approval.title ?? `${i.approval.workflow} · ${i.approval.node}`)
              : t.home.limits.atLimit({ runtime: runtimeDisplayName(i.limit.runtime) });
  return {
    icon: spec.icon,
    tone: spec.tone,
    text: `${label}: ${i.event?.title ?? title}`,
    link: i.event?.link ?? null,
  };
}

function RecentEvents(props: {
  readonly items: readonly OpsItem[];
  readonly status: 'loading' | 'ready' | 'error' | 'off';
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onOlder: () => void;
  readonly seen: (ids: readonly string[]) => void;
  readonly now: number;
}): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.home.events;
  const [limit, setLimit] = useState(12);
  const list = useMemo(() => [...props.items].reverse(), [props.items]);
  const shown = list.slice(0, limit);
  const ref = useRef<HTMLUListElement>(null);
  const { seen } = props;
  // Unread notifications that were on screen are marked read (the bell follows), as in the Faz 1 thread.
  useEffect(() => {
    const root = ref.current;
    if (root === null || typeof IntersectionObserver === 'undefined') return;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.notification;
          if (e.isIntersecting && id !== undefined && document.visibilityState === 'visible') pending.add(id);
        }
        if (pending.size > 0 && timer === null)
          timer = setTimeout(() => {
            timer = null;
            seen([...pending]);
            pending.clear();
          }, 1200);
      },
      { threshold: 0.6 },
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-notification]')) io.observe(el);
    return () => {
      io.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [shown, seen]);
  return (
    <Panel title={w.title} flush testId="dy-home-events">
      {props.status === 'loading' ? (
        <SkeletonRows label={w.loading} />
      ) : props.status === 'off' ? (
        <EmptyLine>{w.off}</EmptyLine>
      ) : list.length === 0 ? (
        <EmptyLine>{w.empty}</EmptyLine>
      ) : (
        <ul ref={ref} className="m-0 list-none p-0" aria-label={w.title}>
          {shown.map((i) => {
            const l = eventLine(i, t);
            const text = l.text.length > 180 ? `${l.text.slice(0, 179)}…` : l.text;
            return (
              <li
                key={i.id}
                data-notification={i.unread && i.event !== null ? i.event.notificationId : undefined}
                className="grid grid-cols-[3.25rem_1rem_minmax(0,1fr)] items-start gap-x-2.5 border-t border-dy-line px-4 py-2 text-[0.875rem] first:border-t-0"
              >
                <time
                  dateTime={i.at}
                  className="pt-px font-dy-mono text-[0.75rem] text-dy-faint tabular-nums"
                  title={fmt.dateWith(i.at, DATE_TIME_NUMERIC)}
                >
                  {Date.parse(i.at) >= startOfToday(props.now).getTime()
                    ? fmt.dateWith(i.at, { hour: '2-digit', minute: '2-digit' })
                    : fmt.dateWith(i.at, { day: 'numeric', month: 'short' })}
                </time>
                <DyIcon name={l.icon} className={cx('mt-[3px] size-4', INK[l.tone])} />
                <span
                  className={cx(
                    'min-w-0 [overflow-wrap:anywhere]',
                    l.tone === 'red' ? 'text-dy-red-ink' : 'text-dy-ink',
                  )}
                >
                  {i.unread ? (
                    <span
                      className="mr-1.5 inline-block size-1.5 rounded-full bg-dy-teal align-middle"
                      data-testid="dy-unread"
                    >
                      <span className="sr-only">{w.unread}</span>
                    </span>
                  ) : null}
                  {l.link === null ? (
                    text
                  ) : (
                    <Link to={l.link} className="text-inherit no-underline hover:underline">
                      {text}
                    </Link>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > limit || props.hasOlder ? (
        <div className="border-t border-dy-line px-4 py-2">
          <button
            type="button"
            disabled={props.loadingOlder}
            onClick={() => {
              if (list.length > limit) setLimit((n) => n + 20);
              else props.onOlder();
            }}
            className="dy-press text-[0.84375rem] font-medium text-dy-teal-ink disabled:opacity-50"
          >
            {props.loadingOlder ? w.loadingOlder : w.older}
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

const BACKUP: Readonly<
  Record<HealthState, { tone: Tone; icon: IconName; text: keyof Messages['home']['health']['backups'] }>
> = {
  ok: { tone: 'green', icon: 'checkc', text: 'ok' },
  warning: { tone: 'amber', icon: 'shield', text: 'warning' },
  failing: { tone: 'red', icon: 'xc', text: 'failing' },
  not_configured: { tone: 'neutral', icon: 'clock', text: 'notConfigured' },
};

function HealthLine(props: {
  readonly icon: IconName;
  readonly tone: Tone;
  readonly text: string;
  readonly to?: string;
  readonly note?: string | null;
}): ReactNode {
  const body = (
    <>
      <DyIcon name={props.icon} className={cx('size-4 shrink-0', INK[props.tone])} />
      <span className="min-w-0 flex-1">{props.text}</span>
      {props.note === undefined || props.note === null ? null : (
        <span className="font-dy-mono text-[0.75rem] text-dy-muted tabular-nums">{props.note}</span>
      )}
    </>
  );
  return (
    <li className="text-[0.875rem]">
      {props.to === undefined ? (
        <span className="flex items-center gap-2">{body}</span>
      ) : (
        <Link to={props.to} className="flex items-center gap-2 text-inherit no-underline hover:underline">
          {body}
        </Link>
      )}
    </li>
  );
}

function HealthPanel(props: {
  readonly health: Health | null;
  readonly data: Loaded | null;
  readonly live: 'loading' | 'ready' | 'error' | 'off';
}): ReactNode {
  const h = props.health;
  const machines = (props.data?.workers ?? []).filter(isActiveMachine);
  const offline = machines.filter((w) => !w.connected).length;
  const b = h?.backups ?? null;
  const m = h?.monitors ?? null;
  const ex = h?.expiry ?? null;
  const brake = h?.brake ?? null;
  const sys = h?.system ?? null;
  const all = useT();
  const w = all.home.health;
  const os = all.opsSafety.home;
  const sw = all.systemStatus.home;
  const attention = ex === null ? 0 : ex.soon + ex.urgent + ex.expired;
  return (
    <Panel title={w.title} testId="dy-home-health">
      <ul className="m-0 grid list-none gap-2 p-0">
        <HealthLine
          icon={props.live === 'error' ? 'xc' : 'checkc'}
          tone={props.live === 'error' ? 'red' : 'green'}
          text={props.live === 'error' ? w.serverDown : w.serverLive}
        />
        {sys === null ? null : (
          <HealthLine
            icon={sys.overall === 'ok' ? 'checkc' : sys.overall === 'warning' ? 'shield' : 'xc'}
            tone={sys.overall === 'ok' ? 'green' : sys.overall === 'warning' ? 'amber' : 'red'}
            text={
              sys.overall === 'ok'
                ? sw.ok
                : sys.overall === 'warning'
                  ? sw.warning({ n: sys.problems })
                  : sw.failing
            }
            to="/settings/system"
          />
        )}
        {machines.length === 0 ? null : (
          <HealthLine
            icon="cpu"
            tone={offline > 0 ? 'amber' : 'green'}
            text={offline > 0 ? w.machinesOff({ n: offline }) : w.machinesOn}
            to="/machines"
          />
        )}
        {m === null ? null : (
          <HealthLine
            icon={m.down > 0 ? 'xc' : 'globe'}
            tone={m.down > 0 ? 'red' : 'green'}
            text={m.down > 0 ? w.sitesDown({ n: m.down }) : w.sitesUp({ n: m.up })}
            to="/uptime"
          />
        )}
        {b === null ? null : (
          <HealthLine
            icon={BACKUP[b.state].icon}
            tone={BACKUP[b.state].tone}
            text={w.backups[BACKUP[b.state].text]}
            note={b.at === null ? null : agoText(b.at, Date.now(), all.screenKit.time)}
            to="/settings/backups"
          />
        )}
        {ex === null ? null : (
          <HealthLine
            icon={attention > 0 ? 'key' : 'checkc'}
            tone={ex.expired + ex.urgent > 0 ? 'red' : attention > 0 ? 'amber' : 'green'}
            text={attention > 0 ? fill(os.expiryAttention, { n: attention }) : os.expiryOk}
            to="/settings/ops-safety"
          />
        )}
        {brake === null || brake.engaged === 0 ? null : (
          <HealthLine
            icon="gauge"
            tone={brake.blocking ? 'red' : 'amber'}
            text={brake.blocking ? os.brakeOn : os.brakeWarn}
            to="/settings/ops-safety?tab=brake"
          />
        )}
        {b?.lagSeconds === null || b?.lagSeconds === undefined ? null : (
          <HealthLine
            icon="retry"
            tone={b.lagSeconds > 900 ? 'amber' : 'green'}
            text={w.standby({ behind: b.lagSeconds > 900 })}
            note={w.minutes({ n: Math.round(b.lagSeconds / 60) })}
            to="/settings/backups"
          />
        )}
      </ul>
    </Panel>
  );
}

function RecentFailures(props: { readonly data: Loaded | null; readonly now: number }): ReactNode {
  const list = props.data?.recentFailures ?? [];
  const t = useT();
  const w = t.home.failures;
  return (
    <Panel title={w.title} flush testId="dy-home-failures">
      {props.data === null ? (
        <SkeletonRows label={w.loading} rows={2} />
      ) : list.length === 0 ? (
        <EmptyLine>{w.empty}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0" aria-label={w.title}>
          {list.map((j) => (
            <li key={j.id} className="border-t border-dy-line first:border-t-0">
              <Link
                to={`/jobs/${encodeURIComponent(j.id)}`}
                className="flex items-center gap-2.5 px-4 py-2 text-inherit no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
              >
                <DyIcon
                  name={j.state === 'LOST' ? 'cpu' : 'xc'}
                  className="size-4 shrink-0 text-dy-red-ink"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.875rem] font-medium">
                    {j.title === '' ? t.home.untitledJob : j.title}
                  </span>
                  <span className="block truncate text-[0.75rem] text-dy-muted">
                    {`${j.state === 'LOST' ? w.lost : w.failed} · ${j.project}${j.runtime === null ? '' : ` · ${runtimeName(j.runtime)}`}`}
                  </span>
                </span>
                <span className="shrink-0 font-dy-mono text-[0.75rem] text-dy-muted tabular-nums">
                  {agoText(j.stateChangedAt, props.now, t.screenKit.time)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ page

export function DiyalogHome(): ReactNode {
  const t = useT();
  const { state: auth } = useAuth();
  const role = auth.kind === 'signedIn' ? auth.user.role : 'viewer';
  const data = useHomeData();
  const [dismissed] = useDismissed();
  // p19-needs-snooze: what the viewer put off on `/needs` is not counted here either.
  const [snoozed] = useSnoozed();
  const usage = usePolled(getUsageOverview, POLL_MS * 2, { key: 'usage' }).data;
  const queue = usePolled(() => getQueue(null), 15_000, { topics: ['approvals'], key: 'queue' });
  const isAdmin = role === 'owner' || role === 'admin';
  const health = usePolled(() => loadHealth(isAdmin), 60_000, {
    key: 'health',
    dep: isAdmin ? 'admin' : 'user',
  }).data;
  const now = useNow();
  const todayKey = startOfToday(now).toISOString();
  const today = usePolled(
    () => getUsageSummary({ groupBy: 'project', from: todayKey, to: new Date().toISOString() }),
    60_000,
    { dep: todayKey, key: `today:${todayKey}` },
  ).data;
  const events = useOpsEvents();
  // p17-needs-page: the decisions live on `/needs`; the home keeps their summary (same sources, same counts).
  const decisions = useDecisions(data, events, dismissed, now, snoozed);
  // p20-quick: what Remyral still waits for on the person's behalf (their active watches) — not decisions.
  const waiting = useWaitingWatches();

  useEffect(() => {
    document.title = t.home.page.docTitle;
  }, [t]);

  return (
    <div
      className="dy-surface dy-bridge flex min-h-dvh min-w-0 flex-1 flex-col bg-dy-thread"
      data-testid="dy-home"
    >
      <TopBar status={events.status} />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 px-3 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))] outline-none sm:px-6 md:pb-12"
      >
        <header className="mb-5">
          <h1 className="m-0 text-[1.625rem] leading-tight font-extrabold tracking-[-0.02em]">
            {t.home.page.title}
          </h1>
          <p className="m-0 mt-1 text-[0.9375rem] text-dy-muted">{t.home.page.lede}</p>
        </header>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {/* p16-selfhost-onboarding: owners of a fresh install — "Kurulumu tamamla" until the wizard is done. */}
          <DyOnboardingCard />
          {/* p16-ops-safety: the cost brake band while a spend ceiling is reached. */}
          <CostBrakeBanner />
          {/* p15-auto-mode: the 24-hour failure digest, linking to the failed jobs. */}
          <FailureDigestLine />
          {/* p17-needs-page: "Senden bekleyen" in short (the list is its own page) next to the quick access. */}
          <div className="grid items-stretch gap-4 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <NeedsTile decisions={decisions} now={now} />
            <QuickAccess role={role} />
          </div>
          {events.status === 'error' ? (
            <p
              role="alert"
              className="m-0 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
            >
              {t.home.page.eventsError({ error: events.error ?? '' })}
            </p>
          ) : null}
          {/* The panels are drawn at once: the summary above keeps its height while it loads, so nothing jumps;
              each panel holds its own place with skeleton rows until its data is there. */}
          {/* Two independent column stacks (no shared rows): a short panel never leaves a hole next to a tall one. */}
          <div
            className="grid items-start gap-4 min-[760px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-[1180px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
            data-testid="dy-home-panels"
          >
            <div className="grid min-w-0 gap-4">
              <WaitingWatches watches={waiting} now={now} testId="dy-home-waiting" />
              <RunningJobs data={data} now={now} />
              <div className="grid items-stretch gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Queue queue={queue.data} loaded={queue.settled} now={now} />
                <Machines data={data} canAdd={role === 'owner' || role === 'admin'} />
              </div>
              <RecentEvents
                items={events.items}
                status={events.status}
                hasOlder={events.hasOlder}
                loadingOlder={events.loadingOlder}
                onOlder={events.loadOlder}
                seen={events.seen}
                now={now}
              />
            </div>
            <div className="grid min-w-0 gap-4">
              <Today data={data} usage={today} now={now} />
              <Limits usage={usage} now={now} />
              <HealthPanel health={health} data={data} live={events.status} />
              <RecentFailures data={data} now={now} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
