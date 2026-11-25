import type { Messages } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  cleanupUsage,
  getUsageRefreshStatus,
  orderedWindows,
  startUsageRefresh,
  type UsageGroup,
  type UsageRefreshTarget,
  type UsageWindow,
} from '../../../api/runtimeUsage';
import type { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { reloadRuntimeUsage, useRuntimeUsage } from '../../../screens/usage/runtimeUsage';
import { DyIcon } from '../../icons';
import { runtimeCode, runtimeDisplayName, RuntimeMark } from '../../RuntimeMark';
import { DyApiError } from '../kit';
import { DyButton, EmptyLine, Meter, Panel, Pill, Rows, SkeletonRows, Sparkline } from '../parts';
import { useGuarded } from './common';
import { toast } from '../../toast/store';
import { type LimitTexts, useLimitTexts } from './limitText';

/**
 * p12-diyalog Faz 4: runtime usage-limit windows — a meter per window in the runtime's colour (amber near, red at the
 * limit, the near-limit threshold as a mark) and its last 24 hours as a sparkline. Same shared, polled overview as the
 * classic table (`useRuntimeUsage({ history: true })`); the settings stay on the enforcement tab. p14-i18n-screens-b:
 * words from the `usage.limits` catalog.
 *
 * p15-usage-refresh (docs/design/p15-usage-refresh.md): **one row per provider account** (the same Claude / ChatGPT
 * account on several machines is one limit — the newest reading wins, "Kullanıldığı makineler" lists them); "Tümünü
 * yenile" and "Şimdi kontrol et" read the windows now on the machines (one remote operation each, progress shown);
 * "sınıra yakın" only at or above the threshold; `—` (unknown) is never shown as 0 %; an expired window says it was
 * reset; logins that no longer exist are flagged and can be cleaned up (admins, step-up).
 */

const FILL: Readonly<Record<string, string>> = {
  cc: 'bg-dy-cc',
  cx: 'bg-dy-cx',
  pi: 'bg-dy-pi',
  oc: 'bg-dy-oc',
};
const STROKE: Readonly<Record<string, string>> = {
  cc: 'text-dy-cc',
  cx: 'text-dy-cx',
  pi: 'text-dy-pi',
  oc: 'text-dy-oc',
};
/** How often a running refresh is polled, and for how long at most. */
const REFRESH_POLL_MS = 1_200;
const REFRESH_MAX_MS = 120_000;
const ALL = '*';

function fillFor(w: UsageWindow, runtime: string): string {
  if (w.level === 'limited') return 'bg-dy-red';
  if (w.level === 'near') return 'bg-dy-amber';
  const c = runtimeCode(runtime);
  return c === null ? 'bg-dy-teal' : (FILL[c] ?? 'bg-dy-teal');
}

function strokeFor(w: UsageWindow, runtime: string): string {
  if (w.level === 'limited') return 'text-dy-red';
  if (w.level === 'near') return 'text-dy-amber';
  const c = runtimeCode(runtime);
  return c === null ? 'text-dy-teal' : (STROKE[c] ?? 'text-dy-teal');
}

function levelWord(t: Messages['usage']['limits'], level: string): string {
  return level === 'near' || level === 'limited' || level === 'unknown' ? t.levelWord[level] : '';
}

export function windowSpark(
  w: UsageWindow,
  t: Messages['usage']['limits'],
  lt: LimitTexts,
): { points: number[]; summary: string } {
  const points = w.history.map((p) => p.usedPercent);
  if (points.length < 2) return { points, summary: t.noHistory({ window: lt.windowName(w) }) };
  const min = Math.round(Math.min(...points));
  const max = Math.round(Math.max(...points));
  return {
    points,
    summary: t.history({ window: lt.windowName(w), min: lt.percentText(min), max: lt.percentText(max) }),
  };
}

/** The used share in words: "%86 sınıra yakın", "%0", "— bilinmiyor", "sıfırlandı — yeni okuma bekleniyor". */
export function windowValueText(w: UsageWindow, t: Messages['usage']['limits'], lt: LimitTexts): string {
  if (w.usedPercent === null && w.restarted) return t.restarted;
  const word = levelWord(t, w.level);
  return `${lt.percentText(w.usedPercent)}${word === '' ? '' : ` ${word}`}`;
}

/** What "Şimdi kontrol et" reads for a row: every machine of an account, or the one login. */
export function refreshTarget(g: UsageGroup): UsageRefreshTarget | null {
  if (!g.canRefresh || g.auth !== 'subscription') return null;
  if (g.runtime !== 'claude-code' && g.runtime !== 'codex') return null;
  if (g.identity !== null) return { runtime: g.runtime, identity: g.identity.key };
  const m = g.machines[0];
  if (m === undefined) return null;
  return { workerId: m.workerId, runtime: g.runtime, account: m.account };
}

/** The name of a row: the people's labels of its logins, else the masked e-mail, else the machine. */
function groupTitle(g: UsageGroup, lt: LimitTexts): string | null {
  if (g.labels.length > 0) return g.labels.join(' · ');
  if (g.identity?.hint !== undefined && g.identity.hint !== null) return null;
  const m = g.machines[0];
  if (m === undefined || (m.account === 'default' && m.accountLabel === null)) return null;
  return lt.accountText(m);
}

interface RefreshRun {
  readonly done: number;
  readonly total: number;
}

/**
 * p15-usage-refresh: starts refresh operations, follows them, reloads the overview when they are done.
 * p17-toasts-shortcuts: the outcome ("N okundu", skipped machines) is a toast; a failure to start stays in the panel.
 */
function useUsageRefresh(): {
  readonly runs: Readonly<Record<string, RefreshRun>>;
  readonly error: ApiError | null;
  readonly start: (key: string, target: UsageRefreshTarget) => Promise<void>;
} {
  const t = useT().usage.limits;
  const [runs, setRuns] = useState<Readonly<Record<string, RefreshRun>>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const setRun = useCallback((key: string, run: RefreshRun | null) => {
    if (!alive.current) return;
    setRuns((cur) =>
      run === null
        ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== key))
        : { ...cur, [key]: run },
    );
  }, []);
  const start = useCallback(
    async (key: string, target: UsageRefreshTarget): Promise<void> => {
      setError(null);
      setRun(key, { done: 0, total: 0 });
      try {
        const started = await startUsageRefresh(target);
        const ids = started.ops.map((o) => o.opId);
        const skipped = started.skipped.map((s) =>
          t.skipped({
            machine: s.workerName,
            reason:
              s.reason === 'worker_offline' || s.reason === 'worker_update_required'
                ? t.skipReasons[s.reason]
                : t.skipReasons.other,
          }),
        );
        if (ids.length === 0) {
          if (alive.current)
            toast.info([t.refreshNothing, ...skipped].join(' '), {
              id: 'limit-refresh',
              testId: 'dy-limit-refresh-note',
            });
          return;
        }
        setRun(key, { done: 0, total: ids.length });
        const until = Date.now() + REFRESH_MAX_MS;
        let read = 0;
        let failed = 0;
        for (;;) {
          const states = await getUsageRefreshStatus(ids);
          const done = states.filter((s) => s.done);
          setRun(key, { done: done.length, total: ids.length });
          if (done.length >= ids.length || Date.now() >= until || !alive.current) {
            for (const s of states) {
              read += s.results.filter((r) => r.outcome === 'read').length;
              failed += s.results.filter((r) => r.outcome === 'failed').length;
              if (s.done && s.state !== 'succeeded' && s.results.length === 0) failed += 1;
            }
            break;
          }
          await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
        }
        reloadRuntimeUsage();
        if (alive.current)
          toast({
            tone: failed > 0 || skipped.length > 0 ? 'warning' : 'success',
            title: [t.refreshDone({ read, failed }), ...skipped].join(' '),
            id: 'limit-refresh',
            testId: 'dy-limit-refresh-note',
          });
      } catch (err) {
        if (alive.current) setError(toApiError(err));
      } finally {
        setRun(key, null);
      }
    },
    [setRun, t],
  );
  return { runs, error, start };
}

function GroupRow(props: {
  readonly g: UsageGroup;
  readonly near: number;
  readonly now: number;
  readonly canRefresh: boolean;
  readonly run: RefreshRun | undefined;
  readonly busyAll: boolean;
  readonly onRefresh: (target: UsageRefreshTarget) => void;
}): ReactNode {
  const { g, now } = props;
  const t = useT().usage.limits;
  const lt = useLimitTexts();
  const ws = orderedWindows(g.windows);
  const title = groupTitle(g, lt);
  const target = props.canRefresh ? refreshTarget(g) : null;
  const shared = g.identity !== null || g.machines.length > 1;
  const single = g.machines.length === 1 ? g.machines[0] : undefined;
  return (
    <li
      className="border-t border-dy-line px-4 py-3 first:border-t-0"
      data-testid="dy-limit-entry"
      data-group={g.key}
      data-orphan={g.orphan || undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <RuntimeMark runtime={g.runtime} />
        {!shared && single !== undefined ? (
          <span translate="no" className="font-dy-mono text-[0.84375rem]">
            {single.workerName}
          </span>
        ) : null}
        {title === null ? null : (
          <span className="text-[0.8125rem] font-semibold" data-testid="dy-limit-account">
            {title}
          </span>
        )}
        {g.identity?.hint === undefined || g.identity.hint === null ? null : (
          <span
            translate="no"
            className="font-dy-mono text-[0.75rem] text-dy-muted"
            data-testid="dy-limit-identity"
          >
            {g.identity.hint}
          </span>
        )}
        <span className="text-[0.8125rem] text-dy-muted">
          {g.auth === 'subscription' ? t.subscription : t.apiKey}
          {g.plan === null ? '' : ` · ${g.plan}`}
        </span>
        {g.orphan ? (
          <Pill tone="neutral" icon="xc">
            {t.orphan}
          </Pill>
        ) : g.limit !== null ? (
          <Pill tone="red" icon="pause">
            {t.limitedUntil({ when: lt.resetText(g.limit.resumeAt, now) })}
          </Pill>
        ) : g.stale ? (
          <span title={t.staleTitle} data-testid="dy-limit-stale">
            <Pill tone="neutral" icon="clock">
              {t.stale}
            </Pill>
          </span>
        ) : null}
        <span className="ml-auto text-[0.75rem] text-dy-faint" data-testid="dy-limit-source">
          {lt.sourceText(g, now)}
          {g.readOn !== null && shared ? ` · ${t.readOn({ machine: g.readOn.workerName })}` : ''}
        </span>
        {target === null || g.orphan ? null : (
          <DyButton
            variant="ghost"
            icon="retry"
            className="h-7 px-2 text-[0.75rem]"
            busy={props.run !== undefined}
            disabled={props.busyAll}
            data-testid="dy-limit-refresh"
            onClick={() => {
              props.onRefresh(target);
            }}
          >
            {props.run !== undefined && props.run.total > 0
              ? t.refreshing({ done: props.run.done, total: props.run.total })
              : t.refreshOne}
          </DyButton>
        )}
      </div>
      {shared ? (
        <p className="m-0 mt-1 text-[0.75rem] text-dy-muted" data-testid="dy-limit-machines">
          {t.usedOn({
            machines: g.machines
              .map(
                (m) =>
                  `${m.workerName}${m.accountLabel !== null && !g.labels.includes(m.accountLabel) ? ` (${m.accountLabel})` : ''}`,
              )
              .join(', '),
          })}
        </p>
      ) : null}
      {g.orphan ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted">{t.orphanHint}</p>
      ) : ws.length === 0 ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted">{t.noWindows}</p>
      ) : (
        <ul className="m-0 mt-2 grid list-none gap-2.5 p-0">
          {ws.map((w) => {
            const spark = windowSpark(w, t, lt);
            const reset = w.resetsAt === null ? '' : `, ${t.resets({ when: lt.resetText(w.resetsAt, now) })}`;
            const text = `${windowValueText(w, t, lt)}${reset}`;
            const name = lt.windowName(w);
            return (
              <li
                key={w.id}
                className="grid grid-cols-[minmax(0,1fr)] items-end gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_120px]"
                data-testid="dy-limit-window"
                data-level={w.level}
              >
                <div className="min-w-0">
                  {/* The runtime is named in the entry head: the line shows the window, and wraps instead of
                      truncating the window name when the reset text is long. */}
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[0.8125rem]">
                    <span className="font-medium">{name}</span>
                    <span
                      className="font-dy-mono text-dy-muted tabular-nums"
                      title={w.resetsAt === null ? undefined : lt.resetTitle(w.resetsAt)}
                    >
                      {text}
                    </span>
                  </div>
                  <Meter
                    label={`${runtimeDisplayName(g.runtime)} ${name}`}
                    value={w.usedPercent}
                    text={text}
                    fill={fillFor(w, g.runtime)}
                    mark={props.near}
                    showLabel={false}
                  />
                </div>
                <Sparkline
                  points={spark.points}
                  summary={spark.summary}
                  max={100}
                  stroke={strokeFor(w, g.runtime)}
                  width={120}
                  height={26}
                />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function LimitWindows(): ReactNode {
  const sayError = useErrorText();
  const t = useT().usage.limits;
  const fmt = useFormat();
  const lt = useLimitTexts();
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : 'viewer';
  const canRefresh = role !== 'viewer';
  const canCleanup = role === 'admin' || role === 'owner';
  const { data, error } = useRuntimeUsage({ history: true });
  const refresh = useUsageRefresh();
  const cleanup = useGuarded();
  const now = Date.now();
  const near = data?.nearThreshold ?? 80;
  const groups = data?.groups ?? [];
  const allRun = refresh.runs[ALL];
  const anyRefreshable = canRefresh && groups.some((g) => refreshTarget(g) !== null);
  const orphans = groups.filter((g) => g.orphan).length;
  return (
    <Panel
      title={t.title}
      testId="dy-limit-windows"
      sub={t.sub({ pct: fmt.percent(near / 100) })}
      flush
      aside={
        anyRefreshable ? (
          <DyButton
            variant="secondary"
            icon="retry"
            busy={allRun !== undefined}
            data-testid="dy-limit-refresh-all"
            onClick={() => {
              void refresh.start(ALL, {});
            }}
          >
            {allRun !== undefined && allRun.total > 0
              ? t.refreshing({ done: allRun.done, total: allRun.total })
              : t.refreshAll}
          </DyButton>
        ) : undefined
      }
    >
      {refresh.error === null && cleanup.error === null ? null : (
        <div className="grid gap-2 px-4 pt-3">
          {refresh.error === null ? null : (
            <p className="m-0 text-[0.8125rem] text-dy-red" role="alert">
              {t.refreshFailed({ error: sayError(refresh.error) })}
            </p>
          )}
          <DyApiError error={cleanup.error} />
        </div>
      )}
      {data === null ? (
        error === null ? (
          // p12-diyalog-default (visual tour): about one runtime's rows (title + two windows), not two thin lines.
          <SkeletonRows label={t.loading} rows={4} />
        ) : (
          <EmptyLine>{t.readFailed({ error: sayError(error) })}</EmptyLine>
        )
      ) : groups.length === 0 && data.otherLimits.length === 0 ? (
        <EmptyLine>{t.noLogins}</EmptyLine>
      ) : (
        <>
          <Rows label={t.rows}>
            {groups.map((g) => (
              <GroupRow
                key={g.key}
                g={g}
                near={near}
                now={now}
                canRefresh={canRefresh}
                run={refresh.runs[g.key]}
                busyAll={allRun !== undefined}
                onRefresh={(target) => {
                  void refresh.start(g.key, target);
                }}
              />
            ))}
          </Rows>
          {orphans > 0 && canCleanup ? (
            <div className="border-t border-dy-line px-4 py-2.5">
              <DyButton
                variant="ghost"
                icon="trash"
                busy={cleanup.busy}
                data-testid="dy-limit-cleanup"
                onClick={() => {
                  void cleanup
                    .run(async () => {
                      const r = await cleanupUsage();
                      reloadRuntimeUsage();
                      toast.success(t.cleaned({ n: r.removed }), { testId: 'dy-limit-cleaned' });
                    }, t.cleanupStepUp)
                    .catch(() => undefined);
                }}
              >
                {t.cleanup}
              </DyButton>
            </div>
          ) : null}
          {data.otherLimits.length === 0 ? null : (
            <ul
              className="m-0 grid list-none gap-1 border-t border-dy-line p-0 px-4 py-3 text-[0.8125rem]"
              aria-label={t.others}
              data-testid="dy-other-limits"
            >
              {data.otherLimits.map((l) => (
                <li key={l.id} className="flex items-center gap-1.5 text-dy-violet">
                  <DyIcon name="pause" className="size-3.5 shrink-0" />
                  <span className="text-dy-ink">
                    {t.otherLine({
                      runtime: `${runtimeDisplayName(l.runtime)}${l.model === null ? '' : ` (${l.model})`}`,
                      who:
                        l.pauseScope === 'credential'
                          ? t.credential({ id: l.credential ?? '' })
                          : l.pauseScope === 'account'
                            ? t.account({ id: l.accountId ?? '' })
                            : (l.workerName ?? t.aMachine),
                      when: lt.resetText(l.resetAt ?? l.resumeAt, now),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
