import { type ReactNode, type SyntheticEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Messages } from '@remyral/i18n';
import {
  type ComponentState,
  getSystemStatus,
  getTrace,
  LOG_LEVELS,
  type LogFilters,
  type LogLevelName,
  type LogLine,
  type LogPage,
  listTraces,
  searchLogs,
  type SystemStatus,
  type TraceDetail,
  type TraceSummary,
} from '../../../api/system';
import { cx } from '../../../components/ui';
import { formatBytes } from '../../../screens/backupBytes';
import { useSubmit } from '../../../screens/useSubmit';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { DyTabs } from '../../formkit';
import { DyIcon, type IconName } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { INK, type Tone } from '../../tone';
import { DyField } from '../forms';
import {
  agoText,
  DyButton,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  SkeletonRows,
  StatTile,
  StatTiles,
} from '../parts';

/**
 * p16-observability (docs/design/p16-observability.md §2–§4): Ayarlar → Sistem durumu, owners and admins, read-only.
 * Three tabs (`?tab=`): Durum — what `GET /system/status` reports, problems first, then tiles and panels; Kayıtlar —
 * the master's redacted log search with level / component / request / job / trace / text filters and paging; İzler —
 * the recent slow and failed traces with a span tree. Words from the `systemStatus` catalog.
 */

type Words = Messages['systemStatus'];
type Tab = 'status' | 'logs' | 'traces';
const TABS: readonly Tab[] = ['status', 'logs', 'traces'];
/** A tab click starts the next tab without the last one's filters (the links between tabs set their own). */
const TAB_FILTERS: readonly string[] = ['traceId', 'jobId', 'level', 'trace'];

const STATE: Readonly<Record<ComponentState, { tone: Tone; icon: IconName }>> = {
  ok: { tone: 'green', icon: 'checkc' },
  warning: { tone: 'amber', icon: 'shield' },
  failing: { tone: 'red', icon: 'xc' },
  unknown: { tone: 'neutral', icon: 'clock' },
  not_configured: { tone: 'neutral', icon: 'pause' },
};

const OVERALL: Readonly<Record<SystemStatus['overall'], { tone: Tone; icon: IconName }>> = {
  ok: { tone: 'green', icon: 'checkc' },
  warning: { tone: 'amber', icon: 'shield' },
  failing: { tone: 'red', icon: 'xc' },
};

/** A duration in seconds as "12 sn" / "4 dk" / "3 sa" / "2 gün". */
export function ageText(t: Words, seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t.age.seconds({ n: s });
  if (s < 3600) return t.age.minutes({ n: Math.round(s / 60) });
  if (s < 172_800) return t.age.hours({ n: Math.round(s / 3600) });
  return t.age.days({ n: Math.round(s / 86_400) });
}

function problemText(t: Words, code: string): string {
  const words: Readonly<Record<string, string>> = t.problems as unknown as Record<string, string>;
  const v = words[code];
  return typeof v === 'string' ? v : t.problems.other({ code });
}

function StatePill(props: { readonly state: ComponentState }): ReactNode {
  const t = useT().systemStatus;
  const s = STATE[props.state];
  return (
    <Pill tone={s.tone} icon={s.icon}>
      {t.components.states[props.state]}
    </Pill>
  );
}

// ------------------------------------------------------------------------------------------------ status

function Overall(props: {
  readonly s: SystemStatus;
  readonly now: number;
  readonly busy: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  const all = useT();
  const t = all.systemStatus;
  const o = OVERALL[props.s.overall];
  const n = props.s.problems.length;
  return (
    <div
      role="status"
      data-testid="dy-system-overall"
      className="flex flex-wrap items-start gap-3 rounded-[14px] border border-dy-line bg-dy-card px-4 py-3 shadow-dy"
    >
      <DyIcon name={o.icon} className={cx('mt-0.5 size-5 shrink-0', INK[o.tone])} />
      <div className="min-w-0 flex-1">
        <p className={cx('m-0 font-bold', INK[o.tone])}>
          {props.s.overall === 'ok'
            ? t.overall.ok
            : props.s.overall === 'warning'
              ? t.overall.warning({ n })
              : t.overall.failing({ n })}
        </p>
        {n > 0 ? (
          <ul
            className="m-0 mt-1 list-disc pl-5 text-[0.875rem] text-dy-muted"
            data-testid="dy-system-problems"
          >
            {props.s.problems.map((p) => (
              <li key={p}>{problemText(t, p)}</li>
            ))}
          </ul>
        ) : null}
        <p className="m-0 mt-1 text-[0.8125rem] text-dy-faint">
          {t.checkedAt({ ago: agoText(props.s.checkedAt, props.now, all.screenKit.time) })}
        </p>
      </div>
      <DyButton variant="ghost" icon="retry" busy={props.busy} onClick={props.onRefresh}>
        {t.refresh}
      </DyButton>
    </div>
  );
}

function Tiles(props: { readonly s: SystemStatus }): ReactNode {
  const t = useT().systemStatus;
  const s = props.s;
  const total = (s.workers?.online ?? 0) + (s.workers?.offline ?? 0);
  const data = s.disk.find((d) => d.id === 'data') ?? s.disk[0];
  return (
    <StatTiles label={t.tiles.label}>
      <StatTile
        label={t.tiles.queue}
        value={s.queue === null ? t.tiles.unknown : t.tiles.queueValue({ n: s.queue.queued })}
        note={
          s.queue === null
            ? undefined
            : s.queue.queued === 0
              ? t.tiles.queueEmpty
              : t.tiles.queueOldest({ age: ageText(t, s.queue.oldestQueuedSec) })
        }
        tone={s.problems.includes('queue_backlog') ? 'amber' : undefined}
        testId="dy-system-tile-queue"
      />
      <StatTile
        label={t.tiles.machines}
        value={
          s.workers === null ? t.tiles.unknown : t.tiles.machinesValue({ online: s.workers.online, total })
        }
        note={
          s.workers === null
            ? undefined
            : s.workers.offline > 0
              ? t.tiles.machinesOffline({ n: s.workers.offline })
              : t.tiles.machinesAll
        }
        tone={s.workers !== null && s.workers.offline > 0 ? 'amber' : undefined}
        to="/machines"
      />
      <StatTile
        label={t.tiles.errors}
        value={s.errors === null ? t.tiles.unknown : String(s.errors.http5xx)}
        note={s.errors === null ? t.tiles.errorsNotYet : t.tiles.errorsOf({ n: s.errors.httpRequests })}
        tone={s.errors !== null && s.errors.http5xx > 0 ? 'red' : undefined}
        testId="dy-system-tile-errors"
      />
      <StatTile
        label={t.tiles.disk}
        value={data === undefined ? t.tiles.unknown : `%${String(Math.round(data.usedPercent))}`}
        note={data === undefined ? undefined : t.tiles.diskFree({ free: formatBytes(data.freeBytes) })}
        tone={
          data === undefined
            ? undefined
            : STATE[data.state].tone === 'green'
              ? undefined
              : STATE[data.state].tone
        }
        testId="dy-system-tile-disk"
      />
    </StatTiles>
  );
}

function Components(props: { readonly s: SystemStatus }): ReactNode {
  const t = useT().systemStatus;
  return (
    <Panel title={t.components.title} testId="dy-system-components">
      <ul className="m-0 grid list-none gap-2 p-0">
        {props.s.components.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-2 text-[0.875rem]"
            data-testid={`dy-system-${c.id}`}
          >
            <span className="min-w-0 flex-1 font-medium">{t.components.names[c.id]}</span>
            {c.latencyMs === null ? null : (
              <span className="font-dy-mono text-[0.75rem] text-dy-muted tabular-nums">
                {t.components.latency({ ms: c.latencyMs })}
              </span>
            )}
            {c.code === null ? null : (
              <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                {t.components.code({ code: c.code })}
              </span>
            )}
            <StatePill state={c.state} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function QueuePanel(props: { readonly s: SystemStatus }): ReactNode {
  const t = useT().systemStatus;
  const q = props.s.queue;
  return (
    <Panel title={t.queue.title} testId="dy-system-queue">
      {q === null ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.queue.unavailable}</p>
      ) : (
        <KeyValue
          rows={[
            { k: t.queue.queued, v: String(q.queued) },
            { k: t.queue.running, v: String(q.running) },
            {
              k: t.queue.oldest,
              v:
                q.oldestQueuedJobId === null ? (
                  t.queue.oldestNone
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{t.queue.oldestValue({ age: ageText(t, q.oldestQueuedSec) })}</span>
                    <Link to={`/jobs/${q.oldestQueuedJobId}`} className="text-dy-teal-ink underline">
                      {t.queue.openJob}
                    </Link>
                  </span>
                ),
            },
            { k: t.queue.leases, v: String(q.activeLeases) },
            { k: t.queue.approvals, v: String(q.approvalsPending) },
          ]}
        />
      )}
    </Panel>
  );
}

function MachinesPanel(props: { readonly s: SystemStatus; readonly now: number }): ReactNode {
  const all = useT();
  const t = all.systemStatus;
  const w = props.s.workers;
  const shown = (w?.list ?? []).slice(0, 12);
  return (
    <Panel
      title={t.machines.title}
      testId="dy-system-machines"
      aside={
        <Link to="/machines" className="text-[0.8125rem] text-dy-muted underline">
          {t.machines.all}
        </Link>
      }
    >
      {w === null || w.list.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.machines.none}</p>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {shown.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.875rem]">
              <DyIcon
                name={m.connected ? 'checkc' : 'xc'}
                className={cx('size-4 shrink-0', m.connected ? INK.green : INK.amber)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
              <span className="text-[0.8125rem] text-dy-muted">
                {m.connected ? t.machines.online : t.machines.offline} ·{' '}
                {m.lastSeenAt === null
                  ? t.machines.never
                  : t.machines.lastSeen({ ago: agoText(m.lastSeenAt, props.now, all.screenKit.time) })}
                {' · '}
                {t.machines.version({ v: m.workerVersion })}
                {m.runningJobs > 0 ? ` · ${t.machines.jobs({ n: m.runningJobs })}` : ''}
              </span>
            </li>
          ))}
          {w.list.length > shown.length ? (
            <li className="text-[0.8125rem] text-dy-muted">
              {t.machines.more({ n: w.list.length - shown.length })}
            </li>
          ) : null}
        </ul>
      )}
      {w !== null && w.pending > 0 ? (
        <p className="m-0 mt-2 text-[0.8125rem] text-dy-amber-ink">{t.machines.pending({ n: w.pending })}</p>
      ) : null}
    </Panel>
  );
}

function DeployPanel(props: { readonly s: SystemStatus }): ReactNode {
  const t = useT().systemStatus;
  const m = props.s.master;
  return (
    <Panel title={t.deploy.title} testId="dy-system-deploy">
      <KeyValue
        rows={[
          { k: t.deploy.release, v: m.releaseTag ?? t.deploy.releaseUnknown, mono: m.releaseTag !== null },
          ...(props.s.workerRelease.length === 0
            ? [{ k: t.deploy.workerRelease({ channel: 'stable' }), v: t.deploy.noWorkerRelease }]
            : props.s.workerRelease.map((r) => ({
                k: t.deploy.workerRelease({ channel: r.channel }),
                v: t.deploy.workerReleaseValue({ version: r.version, percent: r.rolloutPercent }),
              }))),
          { k: t.deploy.uptime, v: ageText(t, m.uptimeSec) },
          {
            k: t.deploy.memory,
            v: t.deploy.memoryValue({ rss: formatBytes(m.rssBytes), heap: formatBytes(m.heapUsedBytes) }),
          },
          ...(m.eventLoopDelayMs === null
            ? []
            : [{ k: t.deploy.loop, v: t.deploy.loopValue({ ms: m.eventLoopDelayMs.toFixed(1) }) }]),
          { k: t.deploy.node, v: m.node, mono: true },
        ]}
      />
    </Panel>
  );
}

function ErrorsPanel(props: { readonly s: SystemStatus; readonly onShowLogs: () => void }): ReactNode {
  const t = useT().systemStatus;
  const e = props.s.errors;
  return (
    <Panel
      title={t.errors.title}
      testId="dy-system-errors"
      sub={e === null ? undefined : t.errors.window({ n: e.windowMinutes })}
      aside={
        <DyButton variant="ghost" icon="search" onClick={props.onShowLogs}>
          {t.errors.showLogs}
        </DyButton>
      }
    >
      {e === null ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.errors.notYet}</p>
      ) : (
        <KeyValue
          rows={[
            { k: t.errors.http, v: t.errors.httpValue({ errors: e.http5xx, total: e.httpRequests }) },
            { k: t.errors.db, v: String(e.dbErrors) },
            { k: t.errors.jobs, v: String(e.jobFailures) },
            { k: t.errors.leases, v: String(e.leaseExpiries) },
            { k: t.errors.steps, v: String(e.stepFailures) },
            { k: t.errors.worker, v: String(e.workerMessageErrors) },
            { k: t.errors.chat, v: t.errors.chatValue({ failed: e.chatTurnsFailed, total: e.chatTurns }) },
            ...(e.errorLogLines === null ? [] : [{ k: t.errors.logs, v: String(e.errorLogLines) }]),
          ]}
        />
      )}
    </Panel>
  );
}

function DiskPanel(props: { readonly s: SystemStatus }): ReactNode {
  const t = useT().systemStatus;
  const s = props.s;
  return (
    <Panel title={t.disk.title} testId="dy-system-disk">
      <KeyValue
        rows={[
          ...(s.disk.length === 0
            ? [{ k: t.disk.data, v: t.disk.none }]
            : s.disk.map((d) => ({
                k: d.id === 'data' ? t.disk.data : t.disk.root,
                v: (
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      {t.disk.value({
                        used: d.usedPercent.toFixed(1),
                        free: formatBytes(d.freeBytes),
                        total: formatBytes(d.totalBytes),
                      })}
                    </span>
                    {d.state === 'ok' ? null : <StatePill state={d.state} />}
                  </span>
                ),
              }))),
          ...(s.database === null
            ? []
            : [
                {
                  k: t.disk.db,
                  v: t.disk.dbValue({ size: formatBytes(s.database.sizeBytes), n: s.database.connections }),
                },
              ]),
          ...(s.redis === null
            ? []
            : [
                {
                  k: t.disk.redis,
                  v: t.disk.redisValue({
                    used: formatBytes(s.redis.usedMemoryBytes),
                    max:
                      s.redis.maxMemoryBytes === null ? t.disk.noLimit : formatBytes(s.redis.maxMemoryBytes),
                  }),
                },
              ]),
        ]}
      />
    </Panel>
  );
}

function IntegrationsPanel(props: { readonly s: SystemStatus; readonly now: number }): ReactNode {
  const all = useT();
  const t = all.systemStatus.integrations;
  const ago = (iso: string | null): string => agoText(iso, props.now, all.screenKit.time);
  const test = (x: { usable: boolean; lastTestAt: string | null; lastTestOk: boolean | null }): ReactNode => {
    if (!x.usable) return <span className={INK.red}>{t.tokenBad}</span>;
    if (x.lastTestOk === null) return t.notTested;
    return x.lastTestOk ? (
      <span className={INK.green}>{t.testOk({ ago: ago(x.lastTestAt) })}</span>
    ) : (
      <span className={INK.red}>{t.testFailed({ ago: ago(x.lastTestAt) })}</span>
    );
  };
  const i = props.s.integrations;
  const f = props.s.versionFeed;
  const rows = [
    ...(i?.coolify ?? []).map((c) => ({ k: t.coolify({ label: c.label }), v: test(c) })),
    ...(i?.cloudflare == null ? [] : [{ k: t.cloudflare, v: test(i.cloudflare) }]),
    ...(i?.github == null
      ? []
      : [
          {
            k: t.github,
            v: !i.github.connected ? (
              t.notConnected
            ) : i.github.keyUsable === false ? (
              <span className={INK.red}>{t.keyBad}</span>
            ) : i.github.missingPermissions > 0 ? (
              <span className={INK.amber}>{t.missing({ n: i.github.missingPermissions })}</span>
            ) : (
              t.connected
            ),
          },
        ]),
    ...(f === null
      ? []
      : [
          {
            k: t.feed,
            v: !f.enabled
              ? t.feedOff
              : f.lastCheckedAt === null
                ? t.feedNever
                : t.feedValue({ items: f.items, failing: f.failing, ago: ago(f.lastCheckedAt) }),
          },
        ]),
  ];
  return (
    <Panel
      title={t.title}
      testId="dy-system-integrations"
      aside={
        <Link to="/settings/integrations" className="text-[0.8125rem] text-dy-muted underline">
          {t.manage}
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.none}</p>
      ) : (
        <KeyValue rows={rows} />
      )}
      {f !== null && f.errors.length > 0 ? (
        <ul className="m-0 mt-2 list-disc pl-5 text-[0.8125rem] text-dy-muted">
          {f.errors.map((e) => (
            <li key={e.item}>
              <span className="font-dy-mono">{e.item}</span> — {e.error}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

function MonitoringPanel(props: { readonly s: SystemStatus }): ReactNode {
  const t = useT().systemStatus.monitoring;
  const s = props.s;
  return (
    <Panel title={t.title} testId="dy-system-monitoring">
      <KeyValue
        rows={[
          {
            k: t.tracing,
            v: !s.tracing.enabled
              ? t.tracingOff
              : s.tracing.exporting
                ? t.tracingExport
                : t.tracingOn({ slow: s.tracing.slow, errors: s.tracing.errors }),
          },
          {
            k: t.logs,
            v: s.logs.enabled ? (
              <span>
                {t.logsOn({ days: s.logs.retentionDays })}
                {s.logs.dropped > 0 ? ` · ${t.logsDropped({ n: s.logs.dropped })}` : ''}
              </span>
            ) : (
              t.logsOff
            ),
          },
        ]}
      />
    </Panel>
  );
}

function StatusTab(props: { readonly onShowLogs: () => void }): ReactNode {
  const t = useT().systemStatus;
  const loader = useSubmit();
  const [data, setData] = useState<SystemStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = (): void => {
    void loader.run(async () => {
      setData(await getSystemStatus());
      setNow(Date.now());
    });
  };
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  if (data === null)
    return (
      <div className="flex flex-col gap-4">
        <ErrorLine error={loader.error} what={t.what} onRetry={load} />
        {loader.error === null ? <SkeletonRows label={t.loading} rows={4} /> : null}
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-testid="dy-system-status">
      <ErrorLine error={loader.error} what={t.what} onRetry={load} />
      <Overall s={data} now={now} busy={loader.busy} onRefresh={load} />
      <Tiles s={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Components s={data} />
        <QueuePanel s={data} />
        <ErrorsPanel s={data} onShowLogs={props.onShowLogs} />
        <MachinesPanel s={data} now={now} />
        <DiskPanel s={data} />
        <DeployPanel s={data} />
        <IntegrationsPanel s={data} now={now} />
        <MonitoringPanel s={data} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ logs

const LEVEL_TONE: Readonly<Record<string, Tone>> = {
  trace: 'neutral',
  debug: 'neutral',
  info: 'teal',
  warn: 'amber',
  error: 'red',
  fatal: 'red',
};

function LogRow(props: {
  readonly line: LogLine;
  readonly onFilter: (f: Partial<LogFilters>) => void;
  readonly onTrace: (traceId: string) => void;
}): ReactNode {
  const all = useT();
  const t = all.systemStatus.logs;
  const fmt = useFormat();
  const l = props.line;
  const levels: Readonly<Record<string, string>> = t.levels;
  const level = levels[l.levelName] ?? l.levelName;
  return (
    <li className="border-t border-dy-line px-4 py-2.5 first:border-t-0" data-testid="dy-log-line">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
        <Pill tone={LEVEL_TONE[l.levelName] ?? 'neutral'}>{level}</Pill>
        <span className="font-dy-mono text-dy-muted tabular-nums">
          {fmt.dateWith(l.at, DATE_TIME_NUMERIC)}
        </span>
        {l.component === null ? null : (
          <button
            type="button"
            className="font-dy-mono text-dy-muted underline"
            onClick={() => {
              props.onFilter({ component: l.component ?? undefined });
            }}
          >
            {l.component}
          </button>
        )}
      </div>
      <p className="m-0 mt-1 text-[0.875rem] [overflow-wrap:anywhere]">{l.msg}</p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.8125rem]">
        {l.jobId === null ? null : (
          <Link to={`/jobs/${l.jobId}`} className="text-dy-teal-ink underline">
            {t.jobLog}
          </Link>
        )}
        {l.reqId === null ? null : (
          <button
            type="button"
            className="text-dy-muted underline"
            onClick={() => {
              props.onFilter({ reqId: l.reqId ?? undefined });
            }}
          >
            {t.sameRequest}
          </button>
        )}
        {l.traceId === null ? null : (
          <button
            type="button"
            className="text-dy-muted underline"
            onClick={() => {
              props.onTrace(l.traceId ?? '');
            }}
          >
            {t.openTrace}
          </button>
        )}
      </div>
      {l.fields === null ? null : (
        <details className="mt-1">
          <summary className="cursor-pointer text-[0.8125rem] text-dy-muted">{t.fields}</summary>
          <pre className="m-0 mt-1 max-h-64 overflow-auto rounded-[8px] bg-dy-thread p-2 font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {JSON.stringify(l.fields, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

function LogsTab(props: {
  readonly initial: LogFilters;
  readonly onTrace: (traceId: string) => void;
}): ReactNode {
  const all = useT();
  const t = all.systemStatus.logs;
  const fmt = useFormat();
  const loader = useSubmit();
  const [draft, setDraft] = useState<LogFilters>(props.initial);
  const [applied, setApplied] = useState<LogFilters>(props.initial);
  const [page, setPage] = useState<LogPage | null>(null);
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const run = (f: LogFilters, more: string | null): void => {
    void loader.run(async () => {
      const p = await searchLogs({ ...f, limit: 100, ...(more === null ? {} : { before: more }) });
      setPage(p);
      setLines((prev) => (more === null ? p.lines : [...prev, ...p.lines]));
    });
  };
  useEffect(() => {
    run(applied, null);
  }, [applied]);
  const apply = (f: LogFilters): void => {
    setDraft(f);
    setApplied(f);
  };
  const submit = (e: SyntheticEvent): void => {
    e.preventDefault();
    apply(draft);
  };
  const set = (k: keyof LogFilters) => (v: string) => {
    setDraft((d) => ({ ...d, [k]: v === '' ? undefined : v }));
  };
  const levelOptions: (readonly [string, string])[] = [
    ['', t.levels.all],
    ...LOG_LEVELS.map((l) => [l, t.levels[l]] as const),
  ];
  if (page !== null && !page.enabled) return <EmptyLine testId="dy-logs-off">{t.off}</EmptyLine>;
  return (
    <div className="flex flex-col gap-4" data-testid="dy-system-logs">
      <form onSubmit={submit} aria-label={t.filters} className="grid gap-3 sm:grid-cols-3">
        <DySelect
          label={t.level}
          value={draft.level ?? ''}
          options={levelOptions}
          onChange={(v) => {
            setDraft((d) => ({ ...d, level: v === '' ? undefined : (v as LogLevelName) }));
          }}
        />
        <DyField
          label={t.component}
          value={draft.component ?? ''}
          onChange={set('component')}
          hint={t.componentHint}
          mono
        />
        <DyField label={t.text} value={draft.q ?? ''} onChange={set('q')} hint={t.textHint} maxLength={200} />
        <DyField label={t.jobId} value={draft.jobId ?? ''} onChange={set('jobId')} mono />
        <DyField label={t.reqId} value={draft.reqId ?? ''} onChange={set('reqId')} mono />
        <DyField label={t.traceId} value={draft.traceId ?? ''} onChange={set('traceId')} mono />
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <DyButton type="submit" variant="primary" icon="search" busy={loader.busy}>
            {t.search}
          </DyButton>
          <DyButton
            variant="ghost"
            onClick={() => {
              apply({});
            }}
          >
            {t.clear}
          </DyButton>
        </div>
      </form>
      <ErrorLine
        error={loader.error}
        what={t.what}
        onRetry={() => {
          run(applied, null);
        }}
      />
      {page === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {page.since === null || page.until === null
            ? null
            : t.window({
                since: fmt.dateWith(page.since, DATE_TIME_NUMERIC),
                until: fmt.dateWith(page.until, DATE_TIME_NUMERIC),
              })}{' '}
          {t.retention({ days: page.retentionDays })}
        </p>
      )}
      <Panel title={all.systemStatus.tabs.logs} flush>
        {page === null && loader.busy ? (
          <SkeletonRows label={t.loading} rows={5} />
        ) : lines.length === 0 ? (
          <EmptyLine testId="dy-logs-empty">{t.empty}</EmptyLine>
        ) : (
          <ul className="m-0 list-none p-0">
            {lines.map((l) => (
              <LogRow
                key={l.id}
                line={l}
                onTrace={props.onTrace}
                onFilter={(f) => {
                  apply({ ...applied, ...f });
                }}
              />
            ))}
          </ul>
        )}
      </Panel>
      {page?.nextBefore == null ? null : (
        <div>
          <DyButton
            busy={loader.busy}
            onClick={() => {
              run(applied, page.nextBefore);
            }}
          >
            {t.older}
          </DyButton>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ traces

function depthOf(spans: TraceDetail['spans']): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const out = new Map<string, number>();
  const depth = (id: string, guard: number): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const s = byId.get(id);
    const parent = s?.parentSpanId ?? null;
    const d = parent === null || !byId.has(parent) || guard > 32 ? 0 : depth(parent, guard + 1) + 1;
    out.set(id, d);
    return d;
  };
  for (const s of spans) depth(s.spanId, 0);
  return out;
}

function TraceView(props: {
  readonly traceId: string;
  readonly onBack: () => void;
  readonly onLogs: (traceId: string) => void;
}): ReactNode {
  const all = useT();
  const t = all.systemStatus.traces;
  const fmt = useFormat();
  const loader = useSubmit();
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  useEffect(() => {
    void loader.run(async () => {
      setTrace(await getTrace(props.traceId));
    });
  }, [props.traceId]);
  const spans = [...(trace?.spans ?? [])].sort((a, b) => a.startMs - b.startMs);
  const start = spans[0]?.startMs ?? 0;
  const total = Math.max(1, trace?.durationMs ?? 1);
  const depth = depthOf(spans);
  return (
    <div className="flex flex-col gap-3" data-testid="dy-trace-detail">
      <div className="flex flex-wrap gap-2">
        <DyButton variant="ghost" icon="back" onClick={props.onBack}>
          {t.back}
        </DyButton>
        <DyButton
          variant="ghost"
          icon="search"
          onClick={() => {
            props.onLogs(props.traceId);
          }}
        >
          {t.logs}
        </DyButton>
      </div>
      {loader.error !== null && trace === null ? (
        <EmptyLine>{t.gone}</EmptyLine>
      ) : trace === null ? (
        <SkeletonRows label={t.loading} rows={4} />
      ) : (
        <Panel
          title={trace.root}
          sub={`${t.started({ at: fmt.dateWith(trace.startedAt, DATE_TIME_NUMERIC) })} · ${t.duration({ ms: trace.durationMs.toFixed(1) })} · ${t.spans({ n: trace.spanCount })}`}
          aside={
            trace.error ? (
              <Pill tone="red" icon="xc">
                {t.error}
              </Pill>
            ) : (
              <Pill tone="amber" icon="clock">
                {t.slow}
              </Pill>
            )
          }
          flush
        >
          <ol className="m-0 list-none p-0" aria-label={t.detail}>
            {spans.map((s) => {
              const left = ((s.startMs - start) / total) * 100;
              const width = Math.max(0.5, (s.durationMs / total) * 100);
              return (
                <li
                  key={s.spanId}
                  className="border-t border-dy-line px-4 py-2 first:border-t-0"
                  data-testid="dy-trace-span"
                >
                  <div
                    className="flex flex-wrap items-center gap-2 text-[0.8125rem]"
                    style={{ paddingLeft: `${String(Math.min(8, depth.get(s.spanId) ?? 0) * 12)}px` }}
                  >
                    <span className={cx('min-w-0 flex-1 truncate font-dy-mono', s.error && INK.red)}>
                      {s.name}
                    </span>
                    <span className="font-dy-mono text-dy-muted tabular-nums">
                      {t.duration({ ms: s.durationMs.toFixed(1) })}
                    </span>
                  </div>
                  <div className="relative mt-1 h-1.5 rounded-full bg-dy-line" aria-hidden="true">
                    <span
                      className={cx(
                        'absolute top-0 h-1.5 rounded-full',
                        s.error ? 'bg-dy-red' : 'bg-dy-teal',
                      )}
                      style={{
                        left: `${String(Math.min(99.5, left))}%`,
                        width: `${String(Math.min(100, width))}%`,
                      }}
                    />
                  </div>
                  {Object.keys(s.attributes).length === 0 ? null : (
                    <p className="m-0 mt-1 font-dy-mono text-[0.75rem] text-dy-muted [overflow-wrap:anywhere]">
                      {Object.entries(s.attributes)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join('  ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </Panel>
      )}
    </div>
  );
}

function TracesTab(props: {
  readonly open: string | null;
  readonly onOpen: (traceId: string | null) => void;
  readonly onLogs: (traceId: string) => void;
}): ReactNode {
  const all = useT();
  const t = all.systemStatus.traces;
  const fmt = useFormat();
  const loader = useSubmit();
  const [kind, setKind] = useState<'all' | 'slow' | 'error'>('all');
  const [list, setList] = useState<{ enabled: boolean; traces: readonly TraceSummary[] } | null>(null);
  useEffect(() => {
    void loader.run(async () => {
      setList(await listTraces(kind));
    });
  }, [kind]);
  if (props.open !== null)
    return (
      <TraceView
        traceId={props.open}
        onBack={() => {
          props.onOpen(null);
        }}
        onLogs={props.onLogs}
      />
    );
  if (list !== null && !list.enabled) return <EmptyLine testId="dy-traces-off">{t.off}</EmptyLine>;
  return (
    <div className="flex flex-col gap-3" data-testid="dy-system-traces">
      <div className="flex flex-wrap items-end gap-3">
        <DySelect
          label={t.kind}
          value={kind}
          options={[
            ['all', t.kinds.all],
            ['slow', t.kinds.slow],
            ['error', t.kinds.error],
          ]}
          onChange={(v) => {
            setKind(v === 'slow' || v === 'error' ? v : 'all');
          }}
          className="min-w-48"
        />
        <p className="m-0 flex-1 text-[0.8125rem] text-dy-muted">{t.note}</p>
      </div>
      <ErrorLine error={loader.error} what={t.what} />
      <Panel title={all.systemStatus.tabs.traces} flush>
        {list === null ? (
          <SkeletonRows label={t.loading} rows={4} />
        ) : list.traces.length === 0 ? (
          <EmptyLine testId="dy-traces-empty">{t.empty}</EmptyLine>
        ) : (
          <ul className="m-0 list-none p-0">
            {list.traces.map((x) => (
              <li
                key={x.traceId}
                className="border-t border-dy-line first:border-t-0"
                data-testid="dy-trace-row"
              >
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-[0.875rem] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-thread"
                  onClick={() => {
                    props.onOpen(x.traceId);
                  }}
                >
                  {x.error ? (
                    <Pill tone="red" icon="xc">
                      {t.error}
                    </Pill>
                  ) : (
                    <Pill tone="amber" icon="clock">
                      {t.slow}
                    </Pill>
                  )}
                  <span className="min-w-0 flex-1 truncate font-dy-mono">{x.root}</span>
                  <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                    {t.duration({ ms: x.durationMs.toFixed(1) })} · {t.spans({ n: x.spanCount })}
                    {x.droppedSpans > 0 ? ` ${t.dropped({ n: x.droppedSpans })}` : ''}
                  </span>
                  <span className="text-[0.8125rem] text-dy-muted">
                    {fmt.dateWith(x.startedAt, DATE_TIME_NUMERIC)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ page

export function SystemView(): ReactNode {
  const t = useT().systemStatus;
  const [params, setParams] = useSearchParams();
  const go = (next: Tab, extra: Record<string, string> = {}): void => {
    setParams(next === 'status' ? { ...extra } : { tab: next, ...extra });
  };
  const initialLogs: LogFilters = {
    ...(params.get('traceId') === null ? {} : { traceId: params.get('traceId') ?? undefined }),
    ...(params.get('jobId') === null ? {} : { jobId: params.get('jobId') ?? undefined }),
    ...(params.get('level') !== null && LOG_LEVELS.includes(params.get('level') as LogLevelName)
      ? { level: params.get('level') as LogLevelName }
      : {}),
  };
  useEffect(() => {
    document.title = t.page.docTitle;
  }, [t]);
  return (
    <div className="flex flex-col gap-4" data-testid="dy-system">
      {/* p17-settings-tabs: the shared tab row (URL `?tab=`, arrow keys, the guard, phones scroll it sideways); the
          links between the tabs (errors → logs, a trace → its logs) still set their filters through `go`. */}
      <DyTabs
        label={t.tabs.label}
        items={TABS.map((k) => ({ id: k, label: t.tabs[k] }))}
        clearParams={TAB_FILTERS}
        testId="dy-system-tabs"
      >
        {(active) =>
          active === 'status' ? (
            <StatusTab
              onShowLogs={() => {
                go('logs', { level: 'error' });
              }}
            />
          ) : active === 'logs' ? (
            <LogsTab
              key={params.toString()}
              initial={initialLogs}
              onTrace={(id) => {
                go('traces', { trace: id });
              }}
            />
          ) : (
            <TracesTab
              open={params.get('trace')}
              onOpen={(id) => {
                go('traces', id === null ? {} : { trace: id });
              }}
              onLogs={(id) => {
                go('logs', { traceId: id });
              }}
            />
          )
        }
      </DyTabs>
    </div>
  );
}
