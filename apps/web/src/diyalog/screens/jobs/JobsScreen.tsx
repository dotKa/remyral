import { type ReactNode, type SubmitEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { JOB_STATES, type JobFilter, type JobSummary, listJobs, RUNTIMES } from '../../../api/jobs';
import { listUsageCosts } from '../../../api/usage';
import { useAuth } from '../../../auth/AuthProvider';
import { machineName, useMachineNames } from '../../../lib/machineDirectory';
import { useNow } from '../../../lib/now';
import { useCursorList, withoutPage } from '../../../lib/pager';
import { isRetiredRuntime, runtimeName } from '../../../lib/reasons';
import {
  costByJob,
  type JobCost,
  costText,
  firstLine,
  jobDurationMs,
  RERUNNABLE,
  runAgainHref,
} from '../../../screens/job/format';
import { GENEL } from '../../../screens/genelProject';
import { Chip } from '../../Chip';
import { DyIcon } from '../../icons';
import { jobStatePill } from '../../job/JobHeader';
import { PlatformBadge, platformPill, platformTitle } from '../../job/platform';
import { RuntimeMark } from '../../RuntimeMark';
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
  ThreadLink,
} from '../parts';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import { DySortBar } from '../../common/sort';
import { DyPager } from './DyPager';
import { QueueView } from './QueueView';
import {
  activePreset,
  FILTER_KEYS,
  filterOf,
  localViewOf,
  type JobSort,
  narrow,
  paramsFor,
  PRESETS,
  type Preset,
  rememberedPreset,
  rememberPreset,
  SORT_KEYS,
  sortJobs,
  sortLabels,
  sortOf,
  spanText,
  VIEW_PARAM,
  withSort,
} from './views';
import { WorkflowRunsPanel } from './WorkflowRuns';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { DyWizardHint } from '../../onboarding/nudge';

/**
 * p12-diyalog Faz 4 (docs/design/p12-diyalog.md §12): `/jobs` in the Diyalog language — "Tüm işler" (the classic
 * list's data: keyset pages, URL filters, cost per job) and "Kuyruk" (dispatch order per pool, by class). The tab
 * ids and the filter parameters are the classic ones, so `?tab=queue` and `?state=FAILED` links work in both consoles.
 * Titles are prompt text: rendered as text only.
 */

/** How often the first page is re-read while the tab is visible (as the classic list). */
const LIST_REFRESH_MS = 15_000;

function useCosts(items: readonly JobSummary[]): ReadonlyMap<string, JobCost> {
  const [costs, setCosts] = useState<ReadonlyMap<string, JobCost>>(new Map());
  const from = useMemo(() => {
    let min: string | null = null;
    for (const j of items) if (min === null || j.createdAt < min) min = j.createdAt;
    return min;
  }, [items]);
  const key = items.map((j) => `${j.id}:${j.state}`).join(',');
  // p14-web-perf-2: only the listed jobs' records (was: every record since the oldest listed job, 500 at most).
  const ids = useMemo(() => items.slice(0, 200).map((j) => j.id), [items]);
  useEffect(() => {
    if (from === null) return;
    let live = true;
    // Operator+ only on the master; a viewer simply sees no cost (as the classic list).
    listUsageCosts({ from, jobs: ids, limit: 500 }).then(
      (records) => {
        if (live) setCosts(costByJob(records));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [from, key]);
  return costs;
}

/** The classic cost text in the console's words ("Subscription" → "Abonelik"). */
function costWords(c: JobCost | undefined, t: Messages): string {
  const text = costText(c);
  return text === 'Subscription' ? t.jobs.cost.subscription : text === 'Unknown' ? t.jobs.cost.unknown : text;
}

function stateOptions(t: Messages): (readonly [string, string])[] {
  return [
    ['', t.jobs.filters.all],
    ...JOB_STATES.map((s) => [s, `${jobStatePill(s, false, false, t).label} (${s.toLowerCase()})`] as const),
  ];
}

/** Filter row: selects apply at once, project / machine text on Enter or "Uygula". */
function Filters(props: {
  readonly value: JobFilter;
  readonly onApply: (f: JobFilter) => void;
  readonly machines: ReadonlyMap<string, string>;
}): ReactNode {
  const t = useT();
  const w = t.jobs.filters;
  const [d, setD] = useState<JobFilter>(props.value);
  useEffect(() => {
    setD(props.value);
  }, [props.value]);
  const set = (k: (typeof FILTER_KEYS)[number], v: string, apply: boolean): void => {
    const next = { ...d, [k]: v };
    setD(next);
    if (apply) props.onApply(next);
  };
  const submit = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    props.onApply(d);
  };
  const machineOptions = [...props.machines].sort((a, b) => a[1].localeCompare(b[1]));
  const active = FILTER_KEYS.some((k) => (props.value[k] ?? '') !== '');
  return (
    <form
      role="search"
      aria-label={w.label}
      onSubmit={submit}
      className="grid grid-cols-2 items-end gap-2 px-4 pt-1 pb-3 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
    >
      <DySelect
        label={w.state}
        value={d.state ?? ''}
        options={stateOptions(t)}
        onChange={(v) => {
          set('state', v, true);
        }}
      />
      <DySearch
        label={w.project}
        value={d.project ?? ''}
        placeholder={w.projectPlaceholder}
        onChange={(v) => {
          set('project', v, false);
        }}
      />
      <DySelect
        label="Runtime" // i18n-ignore: glossary term, the same in both languages
        value={d.runtime ?? ''}
        options={[['', w.all], ...RUNTIMES.map((r) => [r, runtimeName(r)] as const)]}
        onChange={(v) => {
          set('runtime', v, true);
        }}
      />
      {machineOptions.length > 0 ? (
        <DySelect
          label={w.machine}
          value={d.worker ?? ''}
          options={[
            ['', w.all],
            ...machineOptions,
            ...(d.worker && !props.machines.has(d.worker) ? [[d.worker, d.worker] as const] : []),
          ]}
          onChange={(v) => {
            set('worker', v, true);
          }}
        />
      ) : (
        <DySearch
          label={w.machine}
          value={d.worker ?? ''}
          placeholder={w.machinePlaceholder}
          onChange={(v) => {
            set('worker', v, false);
          }}
        />
      )}
      <div className="col-span-2 flex gap-2 sm:col-span-1">
        <DyButton type="submit">{w.apply}</DyButton>
        {active ? (
          <DyButton
            variant="ghost"
            onClick={() => {
              props.onApply({});
            }}
          >
            {w.reset}
          </DyButton>
        ) : null}
      </div>
    </form>
  );
}

function Presets(props: {
  readonly active: Preset | null;
  readonly custom: boolean;
  readonly onPick: (p: Preset | null) => void;
}): ReactNode {
  const w = useT().jobs.presets;
  return (
    <nav
      aria-label={w.label}
      className="dy-noscrollbar dy-scroll-fade flex gap-1.5 overflow-x-auto px-4 pt-1 pb-2"
    >
      <PresetChip
        label={w.all}
        pressed={props.active === null && !props.custom}
        onClick={() => {
          props.onPick(null);
        }}
      />
      {PRESETS.map((p) => (
        <PresetChip
          key={p.id}
          label={w[p.id]}
          pressed={props.active?.id === p.id}
          onClick={() => {
            props.onPick(props.active?.id === p.id ? null : p);
          }}
        />
      ))}
    </nav>
  );
}

function PresetChip(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={
        props.pressed
          ? 'dy-press inline-flex min-h-8 shrink-0 items-center rounded-full border border-dy-ink bg-dy-ink px-3 text-[0.8125rem] font-bold whitespace-nowrap text-dy-card'
          : 'dy-press inline-flex min-h-8 shrink-0 items-center rounded-full border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] whitespace-nowrap text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink'
      }
    >
      {props.label}
    </button>
  );
}

function JobRow(props: {
  readonly job: JobSummary;
  readonly names: ReadonlyMap<string, string>;
  readonly cost: JobCost | undefined;
  readonly now: number;
}): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.jobs.row;
  const j = props.job;
  // p19-verifier-jobs: a platform verifier shows the checked job's verification outcome and a "Doğrulama" badge.
  const title = firstLine(platformTitle(j.platform, j.title, t)) || w.untitled;
  const pill = platformPill(j.platform, t) ?? jobStatePill(j.state, false, false, t);
  // p19-verifier-jobs: a platform verifier is never run again as ordinary work.
  const rerun = RERUNNABLE.has(j.state) && !isRetiredRuntime(j.runtime) && (j.platform ?? null) === null;
  return (
    <Row
      testId="job-row"
      flipKey={j.id}
      compact
      lead={
        <DyIcon
          name={pill.icon}
          className={j.state === 'RUNNING' ? 'dy-breathe size-[18px]' : 'size-[18px]'}
        />
      }
      tone={pill.tone}
      title={
        <Link
          to={`/jobs/${encodeURIComponent(j.id)}`}
          className="line-clamp-2 text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          title={j.title}
        >
          {title}
        </Link>
      }
      meta={
        <>
          <Pill tone={pill.tone} icon={pill.icon}>
            <span data-testid="job-state">{pill.label}</span>
          </Pill>
          {j.platform === null || j.platform === undefined ? null : <PlatformBadge platform={j.platform} />}
          <span className="inline-flex items-center gap-1">
            {j.project}
            {j.projectKind === 'workspace' ? <span className="text-dy-faint">{w.workspace}</span> : null}
          </span>
          {j.runtime === null ? null : <RuntimeMark runtime={j.runtime} />}
          {j.workerId === null ? null : (
            <span className="font-dy-mono" title={j.workerId} translate="no">
              {machineName(props.names, j.workerId)}
              {j.attempts > 1 ? (
                <span className="font-dy text-dy-faint">{w.attempt({ n: j.attempts })}</span>
              ) : null}
            </span>
          )}
          <time dateTime={j.createdAt} title={fmt.dateWith(j.createdAt, DATE_TIME_NUMERIC)}>
            {agoText(j.createdAt, props.now, t.screenKit.time)}
          </time>
        </>
      }
      trail={
        <span className="flex items-center gap-3 font-dy-mono text-[0.8125rem] whitespace-nowrap text-dy-muted tabular-nums">
          <span aria-label={w.duration({ span: spanText(jobDurationMs(j, props.now), t) })}>
            {spanText(jobDurationMs(j, props.now), t)}
          </span>
          <span aria-label={w.cost({ cost: costWords(props.cost, t) })} data-testid="job-cost">
            {costWords(props.cost, t)}
          </span>
        </span>
      }
      actions={
        <>
          {rerun ? (
            <DyButtonLink
              to={runAgainHref(j.id)}
              variant="ghost"
              icon="retry"
              aria-label={w.rerunLabel({ title })}
              className="min-h-8 px-2 text-[0.8125rem] max-sm:min-w-8 max-sm:justify-center"
            >
              {/* p17-ui-polish: an icon button on phones (the name stays in aria-label). */}
              <span className="max-sm:sr-only">{w.rerun}</span>
            </DyButtonLink>
          ) : null}
          <ThreadLink target={{ kind: 'job', id: j.id }} about={title} />
        </>
      }
    />
  );
}

/**
 * Column sorting (the classic table's sortable columns: created, state, project, duration) over the loaded page, kept
 * in the URL. A toolbar of toggle buttons — the rows are a list, not a table, so the order is spoken in each button's
 * name ("Durum, artan") and in the polite line after it rather than through `aria-sort`.
 */
function SortBar(props: {
  readonly sort: JobSort | null;
  readonly onSort: (s: JobSort | null) => void;
}): ReactNode {
  const t = useT();
  return (
    <DySortBar
      keys={SORT_KEYS}
      labels={sortLabels(t)}
      sort={props.sort}
      onSort={props.onSort}
      defaultNote={t.jobs.sort.defaultNote}
      sortedNote={t.jobs.sort.sortedNote}
      testId="job-sort"
      noteTestId="job-sort-note"
      className="border-t border-dy-line"
    />
  );
}

function JobList(props: { readonly filter: JobFilter }): ReactNode {
  const [params, setParams] = useSearchParams();
  const t = useT();
  const w = t.jobs.list;
  const { filter } = props;
  const list = useCursorList<JobSummary>({
    key: JSON.stringify(filter),
    label: w.pages,
    defaultSize: 50,
    refreshMs: LIST_REFRESH_MS,
    // p14-web-perf: a revisit shows the last page at once while it is re-read.
    remember: 'jobs',
    fetchPage: (cursor, limit) => listJobs(filter, cursor, { limit }),
  });
  const names = useMachineNames();
  const costs = useCosts(list.items);
  const now = useNow();
  const { state: auth } = useAuth();
  const me = auth.kind === 'signedIn' ? auth.user.id : null;
  const view = localViewOf(params);
  const sort = sortOf(params);
  const shown = sortJobs(narrow(list.items, view, me, now), sort, (j) => jobDurationMs(j, now));
  const preset = activePreset(params);
  const custom = preset === null && (FILTER_KEYS.some((k) => params.get(k)) || view !== null);

  const pick = (p: Preset | null): void => {
    rememberPreset(p);
    setParams((prev) => paramsFor(prev, p), { replace: true });
  };
  const apply = (f: JobFilter): void => {
    setParams(
      (prev) => {
        const next = withoutPage(prev);
        next.delete(VIEW_PARAM);
        for (const k of FILTER_KEYS) {
          const v = (f[k] ?? '').trim();
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  };

  const filtered = Object.keys(filter).length > 0 || view !== null;
  return (
    <>
      {/* p12-diyalog-default (visual tour): workflow runs come after the list — the panel exists only when runs do,
          and above the list its late arrival pushed every job row down (layout shift). */}
      <Panel
        title={w.title}
        count={list.loaded ? String(shown.length) : undefined}
        countLabel={w.countLabel({ n: shown.length })}
        flush
        testId="job-list"
      >
        <Presets active={preset} custom={custom} onPick={pick} />
        <Filters value={filter} onApply={apply} machines={names} />
        {view !== null ? (
          <p className="m-0 px-4 pb-2 text-[0.8125rem] text-dy-muted" data-testid="local-view-note">
            {w.viewNote({ today: view === 'today' })}
          </p>
        ) : null}
        <SortBar
          sort={sort}
          onSort={(s) => {
            setParams((prev) => withSort(prev, s), { replace: true });
          }}
        />
        <div className="border-t border-dy-line">
          {list.error !== null ? (
            <div className="px-4 pt-3">
              <ErrorLine error={list.error} what={w.title} onRetry={list.reload} />
            </div>
          ) : !list.loaded ? (
            <SkeletonRows label={w.loading} rows={5} />
          ) : shown.length === 0 ? (
            <EmptyLine
              testId="jobs-empty"
              action={
                filtered ? (
                  <DyButton
                    variant="ghost"
                    onClick={() => {
                      pick(null);
                    }}
                  >
                    {w.clearFilters}
                  </DyButton>
                ) : (
                  <DyButtonLink to="/jobs/new" variant="primary" icon="plus">
                    {t.jobs.screen.newJob}
                  </DyButtonLink>
                )
              }
            >
              {filtered ? w.emptyFiltered : w.empty}
              {filtered ? null : (
                <span className="ml-2">
                  <DyWizardHint step="sample_job" />
                </span>
              )}
            </EmptyLine>
          ) : (
            <Rows label={w.title} testId="job-rows">
              {shown.map((j) => (
                <JobRow key={j.id} job={j} names={names} cost={costs.get(j.id)} now={now} />
              ))}
            </Rows>
          )}
        </div>
        <DyPager {...list.pagination} className="border-t border-dy-line px-4 py-3" />
      </Panel>
      {/* …and only once the list is drawn: before that the list's placeholder is shorter than the list. */}
      {list.loaded || list.error !== null ? <WorkflowRunsPanel /> : null}
    </>
  );
}

export function JobsScreen(): ReactNode {
  const [params, setParams] = useSearchParams();
  const w = useT().jobs.screen;
  const mp = useT().multiProject.batch;
  const paramKey = FILTER_KEYS.map((k) => params.get(k) ?? '').join('\u0000');
  const filter = useMemo(
    () => filterOf(new URLSearchParams(FILTER_KEYS.map((k, i) => [k, paramKey.split('\u0000')[i] ?? '']))),
    [paramKey],
  );

  // The last preset this browser used, when the list opens with no filter, view, page or tab in the URL.
  useEffect(() => {
    const bare = [...FILTER_KEYS, VIEW_PARAM, 'cursor', 'page', 'tab'].every((k) => params.get(k) === null);
    if (!bare) return;
    const p = rememberedPreset();
    if (p !== null) setParams((prev) => paramsFor(prev, p), { replace: true });
    // Once, on arrival.
  }, []);

  return (
    <ScreenFrame
      title={w.title}
      purpose={w.purpose}
      testId="dy-jobs"
      live="live"
      actions={
        <>
          <DyButtonLink to="/jobs/new" variant="primary" icon="plus">
            {w.newJob}
          </DyButtonLink>
          {/* p17-ui-polish: one primary button; the other three are the same quiet kind (it was one bordered
              button and two links). */}
          <DyButtonLink to={`/jobs/new?project=${GENEL}`} variant="ghost">
            {w.generalJob}
          </DyButtonLink>
          <DyButtonLink to="/jobs/templates" variant="ghost">
            {w.templates}
          </DyButtonLink>
          {/* p18-multi-project W5: the same job in several projects. */}
          <DyButtonLink to="/jobs/batches" variant="ghost">
            {mp.title}
          </DyButtonLink>
          <DyButtonLink to="/automations" variant="ghost">
            {w.automations}
          </DyButtonLink>
        </>
      }
      facts={
        filter.project === undefined ? undefined : (
          <Chip icon="folder" label={w.projectFilter({ project: filter.project })}>
            {filter.project}
          </Chip>
        )
      }
    >
      <SegTabs
        label={w.title}
        items={[
          { id: 'jobs', label: w.tabs.jobs },
          { id: 'queue', label: w.tabs.queue },
        ]}
      >
        {(tab) =>
          tab === 'queue' ? <QueueView project={filter.project ?? null} /> : <JobList filter={filter} />
        }
      </SegTabs>
    </ScreenFrame>
  );
}
