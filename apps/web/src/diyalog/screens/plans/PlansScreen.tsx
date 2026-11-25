import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  getPlanList,
  type PlanListCounts,
  type PlanListFilter,
  type PlanListItem,
  type PlanListScope,
} from '../../../api/plans';
import { cx, toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { onInvalidate } from '../../../lib/invalidate';
import { planHref } from '../../chat/route';
import { DyTime } from '../../common/time';
import { DyIcon } from '../../icons';
import { AutonomousChip, PlanRing } from '../../plan/PlanPanel';
import { durationText, planChip } from '../../plan/planModel';
import { StateBadge } from '../../StateBadge';
import { DyButton, DySearch, DySelect, EmptyLine, ErrorLine, Pill, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';

/**
 * p18-plans-ui (docs/design/p18-plan-mode.md, "Plans UI"): `/plans` — every plan of the person across their
 * conversations (and, by choice, the ones shared with them, read only), to follow them together: the overview line on
 * top ("3 yürütülüyor · 2 senden bekliyor …"), filters by state (each with its count), project and title, whose plans;
 * newest change first. One card per plan: title, conversation, projects, state with the Otonom chip, progress n/m with
 * a bar and the time left, open decisions / items waiting for the person, last update; the card opens the conversation
 * with the plan shown (`/chat/:id?plan=`). Read again every 30 s while the tab is visible, on focus and when a
 * question / conversation changes elsewhere. Phones: the cards stack. Plan texts are model / person text: text only.
 */

export const PLANS_PATH = '/plans';
const REFRESH_MS = 30_000;
const PAGE = 30;
const FILTERS: readonly PlanListFilter[] = ['active', 'executing', 'review', 'paused', 'done', 'cancelled'];
const SCOPES: readonly PlanListScope[] = ['mine', 'shared', 'all'];

const isFilter = (v: string | null): v is PlanListFilter => FILTERS.includes(v as PlanListFilter);
const isScope = (v: string | null): v is PlanListScope => SCOPES.includes(v as PlanListScope);

/** The overview line's parts: only what is there, the most pressing first. Pure. */
export function overviewParts(c: PlanListCounts, t: ReturnType<typeof useT>['plan']['screen']): string[] {
  return [
    c.executing > 0 ? t.executing({ n: c.executing }) : null,
    c.needsYou > 0 ? t.needsYou({ n: c.needsYou }) : null,
    c.review > 0 ? t.review({ n: c.review }) : null,
    c.paused > 0 ? t.paused({ n: c.paused }) : null,
    c.done > 0 ? t.done({ n: c.done }) : null,
  ].filter((x): x is string => x !== null);
}

export function PlansScreen(): ReactNode {
  const all = useT();
  const t = all.plan;
  const s = t.screen;
  const [params, setParams] = useSearchParams();
  const filterParam = params.get('durum');
  const filter = isFilter(filterParam) ? filterParam : null;
  const scopeParam = params.get('kimin');
  const scope = isScope(scopeParam) ? scopeParam : 'mine';
  const project = params.get('proje') ?? '';
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const [items, setItems] = useState<readonly PlanListItem[] | null>(null);
  const [counts, setCounts] = useState<PlanListCounts | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [more, setMore] = useState(false);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [tick, setTick] = useState(0);
  // How many rows are shown (a refresh reads them all again, so "Daha fazla yükle" is not undone by the timer).
  const shownRef = useRef(PAGE);

  const set = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (cur) => {
          const n = new URLSearchParams(cur);
          if (value === null || value === '') n.delete(key);
          else n.set(key, value);
          return n;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The search field writes the URL a moment after typing stops.
  useEffect(() => {
    if (search === q) return;
    const id = setTimeout(() => {
      set('q', search.trim());
    }, 300);
    return () => {
      clearTimeout(id);
    };
  }, [search, q, set]);

  useEffect(() => {
    listProjects().then(setProjects, () => undefined);
  }, []);

  // A filter change starts from the first page.
  useEffect(() => {
    shownRef.current = PAGE;
    setItems(null);
  }, [filter, scope, project, q]);

  useEffect(() => {
    const ctl = new AbortController();
    // The master's page is PAGE rows by default; after "Daha fazla yükle" the refresh reads every shown row again.
    const shownRows = Math.min(shownRef.current, 100);
    getPlanList(
      { filter, scope, project, q, ...(shownRows === PAGE ? {} : { limit: shownRows }) },
      { signal: ctl.signal },
    ).then(
      (page) => {
        setItems(page.items);
        setCounts(page.counts);
        setNext(page.next);
        setError(null);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(toApiError(e));
        setItems((cur) => cur ?? []);
      },
    );
    return () => {
      ctl.abort();
    };
  }, [filter, scope, project, q, tick]);

  // Live enough: every 30 s while visible, on focus, when questions / conversations change elsewhere.
  useEffect(() => {
    const again = (): void => {
      setTick((n) => n + 1);
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') again();
    }, REFRESH_MS);
    window.addEventListener('focus', again);
    const off = onInvalidate(['questions', 'chat'], again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
      off();
    };
  }, []);

  const loadMore = (): void => {
    if (next === null) return;
    setMore(true);
    getPlanList({ filter, scope, project, q, offset: next }).then(
      (page) => {
        setItems((cur) => [
          ...(cur ?? []),
          ...page.items.filter((p) => !(cur ?? []).some((c) => c.id === p.id)),
        ]);
        setNext(page.next);
        shownRef.current = next + PAGE;
        setMore(false);
      },
      (e: unknown) => {
        setError(toApiError(e));
        setMore(false);
      },
    );
  };

  const names = new Map(projects.map((p) => [p.id, p.name] as const));
  const filtered = filter !== null || project !== '' || q !== '' || scope !== 'mine';
  const parts = counts === null ? null : overviewParts(counts, s);
  const countOf = (f: PlanListFilter | null): number | null =>
    counts === null ? null : f === null ? counts.total : counts[f];

  return (
    <ScreenFrame
      title={s.title}
      purpose={s.purpose}
      width="wide"
      testId="dy-plans"
      live={error === null ? 'live' : 'error'}
      facts={
        parts === null ? null : (
          <p
            className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem] text-dy-muted"
            aria-label={s.summaryLabel}
            data-testid="plans-overview"
          >
            <span className="font-bold text-dy-ink">{s.total({ n: counts?.total ?? 0 })}</span>
            {parts.map((x) => (
              <span key={x} className="inline-flex items-center gap-2">
                <span aria-hidden="true">·</span>
                {x}
              </span>
            ))}
          </p>
        )
      }
    >
      <div className="grid gap-4">
        <div
          role="group"
          aria-label={s.filterLabel}
          className="flex flex-wrap gap-1.5"
          data-testid="plans-filters"
        >
          {[null, ...FILTERS].map((f) => {
            const on = f === filter;
            const n = countOf(f);
            return (
              <button
                key={f ?? 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  set('durum', f);
                }}
                className={cx(
                  'dy-press inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[0.84375rem] font-bold sm:min-h-9',
                  on
                    ? 'border-dy-ink bg-dy-ink text-dy-card'
                    : 'border-dy-line-2 bg-dy-card text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                )}
              >
                {s.filters[f ?? 'all']}
                {n === null ? null : (
                  <span className={cx('font-dy-mono text-[0.75rem] tabular-nums', on ? '' : 'text-dy-faint')}>
                    {String(n)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <DySearch label={s.search} value={search} placeholder={s.searchPlaceholder} onChange={setSearch} />
          <DySelect
            label={s.project}
            value={project}
            options={[
              ['', s.allProjects],
              ...[...projects]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => [p.id, p.name] as const),
              ...(project !== '' && !names.has(project) ? [[project, project] as const] : []),
            ]}
            onChange={(v) => {
              set('proje', v);
            }}
          />
          <DySelect
            label={s.scope}
            value={scope}
            options={SCOPES.map((x) => [x, s.scopes[x]] as const)}
            onChange={(v) => {
              set('kimin', v === 'mine' ? null : v);
            }}
          />
        </div>
        <p className="m-0 text-[0.78125rem] text-dy-faint">{s.sorted}</p>
        <ErrorLine
          error={error}
          what={s.what}
          onRetry={() => {
            setTick((n) => n + 1);
          }}
        />
        {items === null ? (
          <div className="overflow-hidden rounded-[12px] border border-dy-line bg-dy-card">
            <SkeletonRows label={s.loading} rows={4} />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-[12px] border border-dy-line bg-dy-card">
            <EmptyLine
              testId="plans-empty"
              action={
                filtered ? (
                  <DyButton
                    onClick={() => {
                      setSearch('');
                      setParams(new URLSearchParams(), { replace: true });
                    }}
                  >
                    {s.clear}
                  </DyButton>
                ) : undefined
              }
            >
              {filtered ? s.emptyFiltered : s.empty}
            </EmptyLine>
          </div>
        ) : (
          <ul
            role="list"
            aria-label={s.list}
            className="m-0 grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3"
            data-testid="plans-list"
          >
            {items.map((p) => (
              <li key={p.id} className="min-w-0">
                <PlanCardLink plan={p} names={names} />
              </li>
            ))}
          </ul>
        )}
        {items !== null && next !== null ? (
          <DyButton busy={more} onClick={loadMore} className="justify-self-center">
            {s.more}
          </DyButton>
        ) : null}
      </div>
    </ScreenFrame>
  );
}

function PlanCardLink(props: {
  readonly plan: PlanListItem;
  readonly names: ReadonlyMap<string, string>;
}): ReactNode {
  const t = useT().plan;
  const s = t.screen;
  const p = props.plan;
  const ratio = p.progress.total === 0 ? 0 : Math.min(1, p.progress.done / p.progress.total);
  const remaining = p.progress.remainingMinutes;
  // p18-plan-autonomy: the plan runs its steps by itself right now.
  const running = p.autonomous && (p.state === 'executing' || p.state === 'approved');
  return (
    <Link
      to={planHref(p.threadId, p.id)}
      aria-label={s.open({ title: p.title })}
      data-testid="plans-card"
      data-plan={p.id}
      className={cx(
        'dy-press grid h-full min-w-0 content-start gap-2.5 rounded-[14px] border bg-dy-card p-3.5 text-dy-ink no-underline shadow-dy-edge [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2',
        p.needsYou ? 'border-dy-amber/60' : 'border-dy-line',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <PlanRing ratio={ratio} className="mt-0.5" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h3 className="m-0 text-[0.9375rem] leading-snug font-extrabold [overflow-wrap:anywhere]">
            {p.title}
          </h3>
          <p className="m-0 truncate text-[0.8125rem] text-dy-muted" title={p.threadTitle}>
            {s.conversation({ title: p.threadTitle })}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StateBadge state={planChip(p.state)} label={t.states[p.state]} />
        {running ? <AutonomousChip /> : null}
        {p.needsYou ? (
          <Pill tone="amber" icon="shield">
            {s.needsYouChip}
          </Pill>
        ) : null}
        {p.role === 'reader' ? <Pill tone="neutral">{s.shared}</Pill> : null}
        {p.archived ? <Pill tone="neutral">{s.archived}</Pill> : null}
      </div>
      <div className="grid gap-1">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-dy-sunk"
          role="progressbar"
          aria-label={t.progressLabel({ done: p.progress.done, total: p.progress.total })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <div
            className="dy-m-meter h-full w-full origin-left rounded-full bg-dy-teal"
            style={{ transform: `scaleX(${String(ratio)})` }}
          />
        </div>
        <p className="m-0 flex flex-wrap items-center gap-x-2 font-dy-mono text-[0.75rem] text-dy-muted">
          <span data-testid="plans-progress">
            {t.progress({ done: p.progress.done, total: p.progress.total })}
          </span>
          {remaining === null || remaining === 0 ? null : (
            <span>{t.remaining({ time: durationText(remaining, t) })}</span>
          )}
        </p>
      </div>
      {p.openDecisions === 0 && p.waiting === 0 ? null : (
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] font-bold text-dy-amber-ink">
          {p.openDecisions === 0 ? null : (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-dy-amber" aria-hidden="true" />
              {t.decisions.waiting({ n: p.openDecisions })}
            </span>
          )}
          {p.waiting === 0 ? null : <span>{s.waiting({ n: p.waiting })}</span>}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.75rem] text-dy-muted">
        {p.projects.map((id) => (
          <span
            key={id}
            className="inline-flex max-w-[12rem] items-center gap-1 truncate rounded-full border border-dy-line px-1.5 py-px font-bold"
          >
            <DyIcon name="folder" className="size-3 shrink-0" />
            <span className="truncate">{props.names.get(id) ?? id}</span>
          </span>
        ))}
        <DyTime iso={p.updatedAt} className="ml-auto shrink-0" />
      </div>
    </Link>
  );
}
