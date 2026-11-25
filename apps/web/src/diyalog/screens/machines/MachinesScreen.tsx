import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { getFleetOverview, type WorkerOverview } from '../../../api/fleet';
import { getQuotaStatus, type QuotaPause } from '../../../api/quotas';
import { listWorkers, type WorkerSummary } from '../../../api/workers';
import { useAuth } from '../../../auth/AuthProvider';
import { DyPager } from '../../common/pager';
import { toApiError } from '../../../components/ui';
import { useResetPageOn } from '../../../lib/pageReset';
import { useClientPage } from '../../../lib/pager';
import { machinePath, sectionTab } from '../../../screens/fleet/machineLinks';
import { machineReasons } from '../../../screens/fleet/machineTabs';
import { requestedParallelism } from '../../../screens/fleet/capacityAdvice';
import { updateTrouble } from '../../../screens/fleet/releaseVersion';
import {
  type FleetFilter,
  filterWorkers,
  RUNTIMES,
  type SortKey,
  sortWorkers,
  STATE_ORDER,
} from '../../../screens/fleet/parts';
import { reserveKept } from '../../../api/fleet-queue';
import { useRuntimeUsage } from '../../../screens/usage/runtimeUsage';
import { runtimeDisplayName } from '../../RuntimeMark';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import {
  agoText,
  DyButton,
  DyButtonLink,
  DySearch,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  SlotCells,
  StatTile,
  StatTiles,
} from '../parts';
import { machineLook, MachineStateMark, platformText, ReadyRuntimes, slotsOf } from './shared';
import { BulkConfig } from './BulkConfig';
import { FleetToolsLink } from './fleet-tools-parts';
import { CompatView, FleetMap } from './FleetViews';
import { PairingCard } from './Pairing';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { useRememberedState } from '../../../lib/remembered';
import { DyWizardHint } from '../../onboarding/nudge';

/** The pairing command (a shell command, the same in every language). */
const PAIR_COMMAND = 'remyral-worker pair --master <url>'; // i18n-ignore: shell command

/**
 * p12-diyalog Faz 4 — `/machines` in the Diyalog language (docs/design/p12-diyalog.md §12): machines waiting to pair
 * first (the classic PendingCard: fingerprint, code, step-up), headline tiles (online, slots, runtimes near their
 * limit), filters, then one row per machine — state as word + icon, slot cells, ready runtimes, last seen. Map and
 * compatibility views are the classic parts (`?view=`). Same requests as the classic list, polled every 5 s.
 */

const POLL_MS = 5_000;

type MachineWords = Messages['machines'];

/** The state filter's words (the states `STATE_ORDER` lists). */
function stateWord(state: string, t: MachineWords): string {
  return Object.hasOwn(t.state, state) ? t.state[state as keyof MachineWords['state']] : state;
}

interface FleetData {
  readonly workers: WorkerSummary[] | null;
  readonly archived: WorkerSummary[] | null;
  readonly overview: ReadonlyMap<string, WorkerOverview>;
  readonly pauses: readonly QuotaPause[];
  readonly error: ApiError | null;
  readonly reload: () => void;
}

type FleetState = Omit<FleetData, 'reload'>;

const NO_FLEET: FleetState = { workers: null, archived: null, overview: new Map(), pauses: [], error: null };

/** Keeps the previous value when the new one has the same content (an unchanged poll re-renders nothing). */
function keep<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  const json = (v: unknown): string => JSON.stringify(v instanceof Map ? [...v.entries()] : v);
  return json(prev) === json(next) ? prev : next;
}

/**
 * The list and its additions, polled every 5 s. p14-web-perf (docs/design/p14-web-perf.md §4): the four reads are
 * independent and run in parallel (they ran one after the other); the answer lands in one state update (one render
 * per poll instead of four), unchanged parts keep their identity, and a revisit starts from the last answer
 * (lib/remembered.ts) instead of the skeleton.
 */
function useFleet(showArchived: boolean): FleetData {
  const [state, setState] = useRememberedState<FleetState>(
    `machines:fleet:${showArchived ? 'archived' : 'live'}`,
    NO_FLEET,
  );
  const load = useCallback(async () => {
    const [workers, archived, quota, overview] = await Promise.allSettled([
      listWorkers(),
      showArchived ? listWorkers({ archived: true }) : Promise.resolve(null),
      getQuotaStatus(),
      getFleetOverview(),
    ]);
    setState((prev) => {
      const error =
        workers.status === 'rejected'
          ? toApiError(workers.reason)
          : archived.status === 'rejected'
            ? toApiError(archived.reason)
            : null;
      return {
        workers: workers.status === 'fulfilled' ? keep(prev.workers, workers.value) : prev.workers,
        archived:
          archived.status === 'fulfilled'
            ? keep(prev.archived, archived.value)
            : showArchived
              ? prev.archived
              : null,
        // Additions to the list: the screen works without them (as the classic list).
        pauses: keep(prev.pauses, quota.status === 'fulfilled' ? quota.value.pauses : []),
        overview: keep(
          prev.overview,
          overview.status === 'fulfilled'
            ? (new Map(overview.value.map((o) => [o.id, o])) as ReadonlyMap<string, WorkerOverview>)
            : new Map<string, WorkerOverview>(),
        ),
        error: keep(prev.error, error),
      };
    });
  }, [showArchived, setState]);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [load]);
  return { ...state, reload: () => void load() };
}

const SORT_KEYS: readonly SortKey[] = ['name', 'state', 'load', 'seen'];

function profileShort(profile: string, t: MachineWords['list']['profiles']): string {
  switch (profile) {
    case 'host-restricted':
      return t.hostRestricted;
    case 'runtime-sandbox':
      return t.runtimeSandbox;
    case 'container':
      return t.container;
    case 'unconfined':
      return t.unconfined;
    default:
      return profile;
  }
}

/**
 * The classic "Parallel jobs" column in words: what the machine runs and where that comes from (panel, the local
 * file's ceiling, not applied yet, auto mode), per-profile limits below the machine's slots, the Acil reserve, the
 * capacity-mode suggestion and the "above recommended" warning — the same facts as `ParallelCell` (FleetPage).
 */
function ParallelFacts(props: { readonly overview: WorkerOverview | undefined }): ReactNode {
  const tl = useT().machines.list;
  const t = tl.parallel;
  const o = props.overview;
  if (o === undefined) return null;
  const cm = o.capacityMode;
  const auto = cm?.mode === 'auto' && cm.slots !== null;
  const p = o.parallelism;
  let value: string;
  let note: string;
  if (auto) {
    value = String(cm.slots);
    note = t.auto({ min: cm.min, max: cm.max });
  } else if (p === null || p.state === 'unknown' || p.effective === null) {
    value = '—';
    note = t.notReported;
  } else {
    value = String(p.effective);
    note =
      p.state === 'panel'
        ? t.panel
        : p.state === 'local_ceiling'
          ? t.localCeiling({ configured: String(p.configured) })
          : p.state === 'pending'
            ? t.pending({ configured: String(p.configured) })
            : t.local;
  }
  const requested = requestedParallelism(p);
  const rec = o.advice?.recommended ?? null;
  const above = !auto && rec !== null && requested !== null && requested > rec;
  const suggested = cm?.mode === 'suggest' && cm.suggestion !== null ? cm.suggestion : null;
  const slots = auto ? cm.slots : o.capacity.max;
  const lower =
    o.queue && slots !== null && o.queue.profileSlots !== null
      ? Object.entries(o.queue.profileSlots)
          .filter(([, n]) => n < slots)
          .map(([k, n]) => `${profileShort(k, tl.profiles)}: ${String(n)}`)
      : [];
  const kept = o.queue ? reserveKept(o.queue.urgentReserve, o.queue.urgentReserveAuto, slots) : 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2" data-testid="parallel-jobs">
      <span>
        {t.word} <span className="font-dy-mono tabular-nums">{value}</span> ({note})
      </span>
      {lower.length > 0 ? <span data-testid="profile-slots">{lower.join(', ')}</span> : null}
      {kept > 0 ? <span data-testid="urgent-reserve">{t.urgent({ n: kept })}</span> : null}
      {suggested !== null && suggested !== requested ? (
        <span className="text-dy-teal-ink" data-testid="parallel-suggested">
          {t.suggested({ n: suggested })}
        </span>
      ) : null}
      {above ? (
        <span className="text-dy-amber-ink" data-testid="parallel-above">
          {t.above({ n: rec })}
        </span>
      ) : null}
    </span>
  );
}

function MachineRow(props: {
  readonly w: WorkerSummary;
  readonly overview: WorkerOverview | undefined;
  readonly pauses: readonly QuotaPause[];
  readonly hot: readonly { runtime: string; limited: boolean }[];
  readonly select?: { readonly on: boolean; readonly toggle: (on: boolean) => void } | undefined;
}): ReactNode {
  const fmt = useFormat();
  const tm = useT().machines;
  const t = tm.list;
  const { w, overview: o } = props;
  const slots = slotsOf(w, o);
  const off = !w.connected || w.archivedAt !== null;
  const look = machineLook(w, tm);
  const mm = useT().machineManaged.list;
  // p17-worker-managed: an update the updater rolled back (or that failed) is visible in the list, not only on the page.
  const last = o?.release.lastAttempt ?? null;
  const trouble = w.archivedAt === null ? updateTrouble(last) : null;
  // p17-ui-review: runtimes that need the user (pin mismatch, signed out, not allowed …) — the list said "Çalışıyor" for
  // a machine whose page opened on three attention cards. One pill, to the machine's overview.
  const runtimeIssues = machineReasons(w, o, props.pauses).filter(
    (r) => r.key.startsWith('rt-') && r.tone !== 'neutral',
  ).length;
  return (
    <Row
      testId="machine-row"
      flipKey={w.id}
      lead={
        props.select === undefined ? undefined : (
          <label className="-m-2 inline-flex size-9 items-center justify-center">
            <input
              type="checkbox"
              className="size-4 accent-[var(--dy-teal)]"
              aria-label={t.select({ name: w.name })}
              checked={props.select.on}
              onChange={(e) => {
                props.select?.toggle(e.target.checked);
              }}
            />
          </label>
        )
      }
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            to={machinePath(w.id)}
            translate="no"
            className="font-dy-mono text-[0.9375rem] font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            {w.name}
          </Link>
          <MachineStateMark worker={w} />
          {trouble !== null && last !== null ? (
            <Link
              to={machinePath(w.id, 'admin')}
              className="no-underline"
              data-testid="machine-update-trouble"
            >
              <Pill
                tone={trouble === 'rolled_back' ? 'red' : 'amber'}
                icon="retry"
                title={
                  trouble === 'rolled_back'
                    ? mm.rolledBackTitle({ version: last.toVersion })
                    : mm.updateFailedTitle({ version: last.toVersion })
                }
              >
                {trouble === 'rolled_back' ? mm.rolledBack : mm.updateFailed}
              </Pill>
            </Link>
          ) : null}
          {runtimeIssues > 0 ? (
            <Link to={machinePath(w.id)} className="no-underline" data-testid="machine-runtime-issues">
              <Pill tone="amber" icon="shield">
                {t.runtimeIssues({ n: runtimeIssues })}
              </Pill>
            </Link>
          ) : null}
          {props.hot.map((h) => (
            <Pill key={h.runtime} tone={h.limited ? 'red' : 'amber'} icon="gauge">
              {runtimeDisplayName(h.runtime)} {h.limited ? tm.shared.level.limited : tm.shared.level.near}
            </Pill>
          ))}
          {props.pauses.map((p) => (
            <Pill
              key={`${p.runtime}-${p.scope}-${p.accountId ?? ''}`}
              tone="violet"
              icon="pause"
              title={p.scope === 'account' ? t.account({ id: p.accountId ?? '' }) : undefined}
            >
              <span data-testid="worker-paused">
                {t.paused({
                  runtime: runtimeDisplayName(p.runtime),
                  when: fmt.dateWith(p.resumeAt, DATE_TIME_NUMERIC),
                  account: p.scope === 'account',
                })}
              </span>
            </Pill>
          ))}
        </span>
      }
      meta={
        <>
          <span>{platformText(w.os, w.arch, tm.shared.unknownOs)}</span>
          {w.hostname !== null && w.hostname !== w.name ? (
            <span className="font-dy-mono" translate="no">
              {w.hostname}
            </span>
          ) : null}
          <span>
            {t.version} <span className="font-dy-mono">{w.workerVersion}</span>
          </span>
          <span>{w.connected ? t.connected : t.lastSeen({ ago: agoText(w.lastSeenAt) })}</span>
          <ReadyRuntimes overview={o} />
          {w.archivedAt === null ? <ParallelFacts overview={o} /> : null}
        </>
      }
      trail={
        w.archivedAt !== null ? null : (
          <span className="flex items-center gap-2" data-testid="machine-slots">
            <SlotCells
              used={slots.used}
              max={slots.max}
              off={off}
              label={
                off
                  ? `${w.name}: ${look.label.toLocaleLowerCase(fmt.locale)}`
                  : t.slotsFull({ name: w.name, used: slots.used, max: slots.max })
              }
            />
            <span
              className="min-w-[3ch] font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums"
              aria-hidden="true"
            >
              {off ? '—' : `${String(slots.used)}/${String(slots.max)}`}
            </span>
          </span>
        )
      }
    />
  );
}

export function MachinesScreen(): ReactNode {
  const [params] = useSearchParams();
  const focus = params.get('worker');
  if (focus !== null && focus !== '') {
    // Older deep links (`/machines?worker=<id>&section=<card>`) open the machine page, as in the classic list.
    return <Navigate replace to={machinePath(focus, sectionTab(params.get('section')))} />;
  }
  return <MachineList />;
}

function MachineList(): ReactNode {
  const fmt = useFormat();
  const all = useT();
  const tm = all.machines;
  const t = tm.list;
  const [showArchived, setShowArchived] = useState(false);
  const fleet = useFleet(showArchived);
  const usage = useRuntimeUsage();
  const { state: auth } = useAuth();
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  const [filter, setFilter] = useState<FleetFilter>({ text: '', state: '', runtime: '' });
  const [sort, setSort] = useState<SortKey>('name');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  // p14-web-perf: derived once per answer (the memo below now hits between polls).
  const { pending, enrolled } = useMemo(() => {
    const all = fleet.workers ?? [];
    return {
      pending: all.filter((w) => w.state === 'pending'),
      enrolled: all.filter((w) => w.state !== 'pending'),
    };
  }, [fleet.workers]);
  const shown = useMemo(
    () => sortWorkers(filterWorkers(enrolled, fleet.overview, filter), fleet.overview, sort),
    [enrolled, fleet.overview, filter, sort],
  );
  const page = useClientPage(shown, { label: t.pages });
  const archivedPage = useClientPage(fleet.archived ?? [], { label: t.archivePages, prefix: 'archived' });
  const views = [
    { id: 'list', label: t.views.list },
    { id: 'map', label: t.views.map },
    { id: 'compat', label: t.views.compat },
  ] as const;
  const sorts = SORT_KEYS.map((k) => [k, t.sorts[k]] as const);
  useResetPageOn(JSON.stringify([filter, sort]));

  const hotBy = useMemo(() => {
    const m = new Map<string, { runtime: string; limited: boolean }[]>();
    for (const e of usage.data?.entries ?? []) {
      if (e.level !== 'near' && e.level !== 'limited') continue;
      const list = m.get(e.workerId) ?? [];
      list.push({ runtime: e.runtime, limited: e.level === 'limited' });
      m.set(e.workerId, list);
    }
    return m;
  }, [usage.data]);

  const online = enrolled.filter((w) => w.connected).length;
  let used = 0;
  let max = 0;
  for (const w of enrolled) {
    if (!w.connected) continue;
    const s = slotsOf(w, fleet.overview.get(w.id));
    used += s.used;
    max += s.max;
  }
  const hotCount = [...hotBy.values()].reduce((n, l) => n + l.length, 0);
  const attention = enrolled.filter((w) => !w.connected || w.state === 'quarantined').length;

  return (
    <ScreenFrame
      title={t.title}
      purpose={t.purpose}
      live={fleet.error !== null ? 'error' : 'live'}
      testId="dy-machines"
      actions={
        <>
          {/* p13-fleet-tools: tool / runtime versions across the fleet ("N güncelleme"). */}
          <FleetToolsLink variant="button" />
          {isAdmin ? (
            <DyButtonLink to="/machines/add" variant="primary" icon="plus">
              {t.add}
            </DyButtonLink>
          ) : null}
        </>
      }
    >
      <ErrorLine error={fleet.error} what={t.title} onRetry={fleet.reload} />
      {fleet.workers === null && fleet.error === null ? (
        <Panel title={t.title} flush>
          <SkeletonRows label={t.loading} rows={4} />
        </Panel>
      ) : null}

      {pending.length > 0 ? (
        <Panel
          title={t.pendingTitle}
          count={String(pending.length)}
          countLabel={t.pendingCount({ n: pending.length })}
          sub={t.pendingSub}
          className="mb-6"
          bare
          testId="pending-machines"
        >
          <div className="flex flex-col gap-3">
            {pending.map((w) => (
              <PairingCard key={w.id} worker={w} onChanged={fleet.reload} showLink />
            ))}
          </div>
        </Panel>
      ) : null}

      {fleet.workers !== null && fleet.workers.length === 0 ? (
        <Panel title={t.emptyTitle}>
          <p className="m-0 mb-3 text-[0.9375rem] text-dy-muted" data-testid="fleet-empty">
            {t.emptyBefore} <code className="rounded bg-dy-sunk px-1">{PAIR_COMMAND}</code> {t.emptyAfter}
          </p>
          {isAdmin ? (
            <DyButtonLink to="/machines/add" icon="plus">
              {t.add}
            </DyButtonLink>
          ) : null}
          <div className="mt-3">
            <DyWizardHint step="machine" />
          </div>
        </Panel>
      ) : null}

      {enrolled.length > 0 ? (
        <>
          <StatTiles label={t.summary} className="mb-5">
            <StatTile
              label={t.online}
              value={`${String(online)} / ${String(enrolled.length)}`}
              testId="stat-online"
            />
            <StatTile
              label={t.slotsTile}
              value={fleet.overview.size > 0 ? `${String(used)} / ${String(max)}` : '—'}
              note={max > 0 ? t.capacity({ percent: fmt.percent(used / max) }) : undefined}
              testId="stat-slots"
            />
            <StatTile
              label={t.hotTile}
              value={String(hotCount)}
              note={hotCount > 0 ? t.hotNote : t.allOk}
              tone={hotCount > 0 ? 'amber' : 'green'}
              to="/usage"
              testId="stat-limits"
            />
            <StatTile
              label={t.attentionTile}
              value={String(attention)}
              note={attention > 0 ? t.attentionNote : t.allConnected}
              tone={attention > 0 ? 'red' : 'green'}
              testId="stat-attention"
            />
          </StatTiles>

          <SegTabs label={t.viewLabel} param="view" items={views}>
            {(view) => (
              <div className="flex flex-col gap-4">
                <form
                  role="search"
                  aria-label={t.filterLabel}
                  onSubmit={(e) => {
                    e.preventDefault();
                  }}
                  className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]"
                >
                  <DySearch
                    label={t.search}
                    value={filter.text}
                    placeholder={t.searchPlaceholder}
                    onChange={(v) => {
                      setFilter({ ...filter, text: v });
                    }}
                    className="col-span-2 sm:col-span-1"
                  />
                  <DySelect
                    label={t.stateFilter}
                    value={filter.state}
                    options={[['', t.all], ...STATE_ORDER.map((s) => [s, stateWord(s, tm)] as const)]}
                    onChange={(v) => {
                      setFilter({ ...filter, state: v });
                    }}
                  />
                  <DySelect
                    label={t.runtimeFilter}
                    value={filter.runtime}
                    options={[['', t.all], ...RUNTIMES.map((r) => [r, runtimeDisplayName(r)] as const)]}
                    onChange={(v) => {
                      setFilter({ ...filter, runtime: v });
                    }}
                  />
                  <DySelect
                    label={t.sort}
                    value={sort}
                    options={sorts}
                    onChange={(v) => {
                      setSort(SORT_KEYS.find((k) => k === v) ?? 'name');
                    }}
                    className="col-span-2 sm:col-span-1"
                  />
                </form>
                {shown.length === 0 ? (
                  <Panel title={t.noMatchTitle}>
                    <p className="m-0 text-dy-muted" data-testid="fleet-no-match">
                      {t.noMatch}
                    </p>
                  </Panel>
                ) : view === 'map' ? (
                  <FleetMap workers={shown} overview={fleet.overview} pauses={fleet.pauses} />
                ) : view === 'compat' ? (
                  <CompatView workers={shown} overview={fleet.overview} />
                ) : (
                  <>
                    {isAdmin ? (
                      <div
                        className="flex flex-wrap items-center gap-3 text-[0.875rem]"
                        data-testid="bulk-bar"
                      >
                        <span className="text-dy-muted tabular-nums">{t.selected({ n: selected.size })}</span>
                        <DyButton
                          disabled={selected.size === 0}
                          onClick={() => {
                            setBulkOpen(true);
                          }}
                        >
                          {t.changeConfig}
                        </DyButton>
                      </div>
                    ) : null}
                    {bulkOpen && selected.size > 0 ? (
                      <BulkConfig
                        workerIds={[...selected]}
                        onDone={fleet.reload}
                        onCancel={() => {
                          setBulkOpen(false);
                        }}
                      />
                    ) : null}
                    <Panel
                      title={t.allTitle}
                      count={String(shown.length)}
                      countLabel={all.common.machineCount({ n: shown.length })}
                      flush
                    >
                      <Rows label={t.title} testId="machine-table">
                        {page.pageItems.map((w) => (
                          <MachineRow
                            key={w.id}
                            w={w}
                            overview={fleet.overview.get(w.id)}
                            pauses={fleet.pauses.filter((p) => p.workers.includes(w.id))}
                            hot={hotBy.get(w.id) ?? []}
                            select={
                              isAdmin
                                ? {
                                    on: selected.has(w.id),
                                    toggle: (on) => {
                                      setSelected((cur) => {
                                        const next = new Set(cur);
                                        if (on) next.add(w.id);
                                        else next.delete(w.id);
                                        return next;
                                      });
                                    },
                                  }
                                : undefined
                            }
                          />
                        ))}
                      </Rows>
                    </Panel>
                    <DyPager {...page.pagination} />
                  </>
                )}
              </div>
            )}
          </SegTabs>
        </>
      ) : null}

      {fleet.workers !== null ? (
        <section aria-label={t.archivedSection} className="mt-6 flex flex-col gap-3">
          <label className="flex min-h-11 items-center gap-2 self-start text-[0.875rem] md:min-h-0">
            <input
              type="checkbox"
              className="size-4 accent-[var(--dy-teal)]"
              checked={showArchived}
              onChange={(e) => {
                setShowArchived(e.target.checked);
              }}
            />
            {t.showArchived}
          </label>
          {showArchived ? (
            fleet.archived === null ? (
              <SkeletonRows label={t.archiveLoading} rows={2} />
            ) : fleet.archived.length === 0 ? (
              <EmptyLine testId="fleet-no-archived">{t.noArchived}</EmptyLine>
            ) : (
              <>
                <Panel
                  title={t.archivedTitle}
                  count={String(fleet.archived.length)}
                  flush
                  testId="archived-list"
                >
                  <Rows label={t.archivedSection}>
                    {archivedPage.pageItems.map((w) => (
                      <MachineRow key={w.id} w={w} overview={undefined} pauses={[]} hot={[]} />
                    ))}
                  </Rows>
                </Panel>
                <DyPager {...archivedPage.pagination} />
              </>
            )
          ) : null}
        </section>
      ) : null}
    </ScreenFrame>
  );
}
