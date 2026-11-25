import { type ReactNode, useEffect, useId, useState } from 'react';
import {
  getEarlierPlans,
  getPlanDiff,
  getPlanVersions,
  type Plan,
  type PlanDiffItem,
  type PlanItemShape,
  type PlanSummary,
  type PlanVersion,
  type PlanVersionDiff,
} from '../../api/plans';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyTime } from '../common/time';
import { SmoothHeight } from '../motionKit';
import { StateBadge } from '../StateBadge';
import { estimateText, planChip } from './planModel';

/**
 * p18-plan-mode W3 (docs/design/p18-plan-mode.md §3 "Geçmiş", §4 "version diff"): the plan's history in the panel — its
 * kept versions (who made each, when, why, what changed against the one before; the approved and the current one
 * marked), the difference between any two of them (items added / removed / changed — with both sides — / moved, the
 * decisions asked or answered between them) and the conversation's earlier plans (read only).
 */

export interface HistoryPick {
  readonly from: number;
  readonly to: number;
}

const select =
  'min-h-11 min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-2 text-base text-dy-ink outline-none focus-visible:border-dy-teal sm:min-h-8 sm:text-[0.8125rem]';

export function PlanHistory(props: {
  readonly plan: Plan;
  readonly threadId: string;
  /** Open on this pair (e.g. "Farkları gör": the latest change). */
  readonly initial?: HistoryPick | undefined;
}): ReactNode {
  const t = useT().plan;
  const h = t.history;
  const p = props.plan;
  const [versions, setVersions] = useState<readonly PlanVersion[] | null>(null);
  const [earlier, setEarlier] = useState<readonly PlanSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<HistoryPick | null>(props.initial ?? null);
  const [draft, setDraft] = useState<HistoryPick | null>(props.initial ?? null);
  const [diff, setDiff] = useState<PlanVersionDiff | null>(null);
  const [diffFailed, setDiffFailed] = useState(false);
  const fromId = useId();
  const toId = useId();

  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    getPlanVersions(p.id, { signal: ctl.signal }).then(
      (v) => {
        setVersions(v);
        const newest = v[0];
        const prev = v[1];
        if (newest !== undefined && prev !== undefined) {
          setDraft((d) => d ?? { from: prev.version, to: newest.version });
        }
      },
      () => {
        if (!ctl.signal.aborted) setFailed(true);
      },
    );
    getEarlierPlans(props.threadId, { signal: ctl.signal }).then(setEarlier, () => undefined);
    return () => {
      ctl.abort();
    };
    // The history is read again when the plan gets a new version (or the person retries).
  }, [p.id, p.version, props.threadId, attempt]);

  useEffect(() => {
    if (pick === null) {
      setDiff(null);
      return;
    }
    const ctl = new AbortController();
    setDiffFailed(false);
    getPlanDiff(p.id, pick.from, pick.to, { signal: ctl.signal }).then(setDiff, () => {
      if (!ctl.signal.aborted) setDiffFailed(true);
    });
    return () => {
      ctl.abort();
    };
  }, [p.id, pick]);

  if (failed)
    return (
      <div className="grid gap-2" data-testid="plan-history">
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {h.failed}
        </p>
        <button
          type="button"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
          className="dy-press inline-flex min-h-11 items-center self-start rounded-[9px] border border-dy-line-2 px-3 text-[0.8125rem] font-bold sm:min-h-8"
        >
          {h.retry}
        </button>
      </div>
    );
  if (versions === null)
    return (
      <div className="grid gap-1.5" data-testid="plan-history" aria-busy="true">
        <span className="sr-only">{h.loading}</span>
        {[0, 1, 2].map((n) => (
          <span key={n} className="h-12 animate-pulse rounded-[10px] bg-dy-sunk" aria-hidden="true" />
        ))}
      </div>
    );
  const asc = [...versions].sort((a, b) => a.version - b.version);
  return (
    <div className="grid min-w-0 gap-4" data-testid="plan-history">
      <section aria-labelledby={`${fromId}-v`} className="grid gap-1.5">
        <h3 id={`${fromId}-v`} className="m-0 text-[0.8125rem] font-extrabold">
          {h.versions}
        </h3>
        <ul role="list" className="m-0 grid list-none gap-1 p-0">
          {versions.map((v) => {
            const prev = asc[asc.findIndex((x) => x.version === v.version) - 1];
            const selected = pick?.to === v.version && pick.from === prev?.version;
            return (
              <li key={v.version}>
                <button
                  type="button"
                  disabled={prev === undefined}
                  aria-pressed={prev === undefined ? undefined : selected}
                  aria-label={prev === undefined ? undefined : h.pick({ v: v.version })}
                  onClick={() => {
                    if (prev === undefined) return;
                    const next = { from: prev.version, to: v.version };
                    setDraft(next);
                    setPick(next);
                  }}
                  className={cx(
                    'dy-press grid min-h-11 w-full min-w-0 gap-0.5 rounded-[10px] border px-2.5 py-1.5 text-left disabled:cursor-default',
                    selected ? 'border-dy-teal bg-dy-teal-soft' : 'border-dy-line bg-dy-card',
                  )}
                  data-testid="plan-version"
                  data-version={v.version}
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.8125rem]">
                    <span className="font-dy-mono font-extrabold">{t.version({ v: v.version })}</span>
                    <span
                      className={cx(
                        'rounded-full px-1.5 text-[0.6875rem] font-bold',
                        v.author === 'user' ? 'bg-dy-violet-soft text-dy-ink' : 'bg-dy-sunk text-dy-muted',
                      )}
                    >
                      {h.author[v.author]}
                    </span>
                    {v.version === p.approvedVersion ? (
                      <span className="rounded-full bg-dy-green-soft px-1.5 text-[0.6875rem] font-bold text-dy-ink">
                        {h.approved}
                      </span>
                    ) : null}
                    {v.version === p.version ? (
                      <span className="rounded-full border border-dy-line-2 px-1.5 text-[0.6875rem] font-bold text-dy-muted">
                        {h.current}
                      </span>
                    ) : null}
                    <DyTime iso={v.createdAt} className="ml-auto text-[0.75rem] text-dy-muted" />
                  </span>
                  <span className="truncate text-[0.75rem] text-dy-muted">
                    {h.counts(v)}
                    {' · '}
                    {h.items({ n: v.items })}
                  </span>
                  {v.reason === null ? null : (
                    <span className="text-[0.75rem] text-dy-muted [overflow-wrap:anywhere]">
                      {h.reason({ reason: v.reason })}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {asc.length < 2 ? null : (
        <form
          className="flex min-w-0 flex-wrap items-end gap-1.5"
          aria-label={h.compare}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft !== null && draft.from !== draft.to) setPick(draft);
          }}
        >
          <label className="grid min-w-0 gap-0.5 text-[0.75rem] font-bold text-dy-muted" htmlFor={fromId}>
            {h.from}
            <select
              id={fromId}
              value={draft?.from ?? ''}
              onChange={(e) => {
                const from = Number(e.target.value);
                setDraft((d) => ({ from, to: d?.to ?? p.version }));
              }}
              className={select}
              data-testid="plan-compare-from"
            >
              {asc.map((v) => (
                <option key={v.version} value={v.version}>
                  {t.version({ v: v.version })}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-0.5 text-[0.75rem] font-bold text-dy-muted" htmlFor={toId}>
            {h.to}
            <select
              id={toId}
              value={draft?.to ?? ''}
              onChange={(e) => {
                const to = Number(e.target.value);
                setDraft((d) => ({ from: d?.from ?? 1, to }));
              }}
              className={select}
              data-testid="plan-compare-to"
            >
              {asc.map((v) => (
                <option key={v.version} value={v.version}>
                  {t.version({ v: v.version })}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={draft === null || draft.from === draft.to}
            className="dy-press inline-flex min-h-11 items-center rounded-[9px] bg-dy-ink px-3 text-[0.8125rem] font-bold text-dy-card disabled:opacity-50 sm:min-h-8"
            data-testid="plan-compare"
          >
            {h.showDiff}
          </button>
        </form>
      )}
      <SmoothHeight>
        {pick === null ? null : diffFailed ? (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {h.failed}
          </p>
        ) : diff === null ? (
          <span className="block h-16 animate-pulse rounded-[10px] bg-dy-sunk" aria-hidden="true" />
        ) : (
          <DiffView key={`${String(diff.from.version)}-${String(diff.to.version)}`} diff={diff} />
        )}
      </SmoothHeight>
      {earlier.length === 0 ? null : (
        <section aria-labelledby={`${toId}-e`} className="grid gap-1.5">
          <h3 id={`${toId}-e`} className="m-0 text-[0.8125rem] font-extrabold">
            {h.earlier}
          </h3>
          <ul role="list" className="m-0 grid list-none gap-1 p-0" data-testid="plan-earlier">
            {earlier.map((e) => (
              <li
                key={e.id}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[10px] border border-dy-line px-2.5 py-1.5 text-[0.8125rem]"
              >
                <span className="min-w-0 flex-1 truncate font-bold">{e.title}</span>
                <StateBadge state={planChip(e.state)} label={t.states[e.state]} />
                <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                  {h.earlierItem({ done: e.done, total: e.total })}
                </span>
                <DyTime iso={e.closedAt ?? e.createdAt} className="text-[0.75rem] text-dy-muted" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The difference of two versions: what was added, removed, changed (field by field) and moved; decisions. */
export function DiffView(props: { readonly diff: PlanVersionDiff }): ReactNode {
  const t = useT().plan;
  const h = t.history;
  const d = props.diff;
  const value = (field: string, s: PlanItemShape | null): string => {
    if (s === null) return h.none;
    switch (field) {
      case 'title':
        return s.title;
      case 'owner':
        return t.owners[s.owner];
      case 'estimate':
        return estimateText(s.estimate, t) ?? h.none;
      case 'project':
        return s.project ?? h.none;
      case 'dependsOn':
        return s.dependsOn.length === 0 ? h.none : s.dependsOn.join(', ');
      default:
        return '…';
    }
  };
  const fieldName = (f: string): string => (h.fields as Readonly<Record<string, string>>)[f] ?? f;
  const groups: { readonly change: PlanDiffItem['change']; readonly label: string }[] = [
    { change: 'added', label: h.added },
    { change: 'removed', label: h.removed },
    { change: 'changed', label: h.changed },
    { change: 'moved', label: h.moved },
  ];
  const moveLine = (x: PlanDiffItem): string =>
    h.movedTo({ from: x.before?.phaseTitle ?? '', to: x.after?.phaseTitle ?? '' });
  const empty = d.items.length === 0 && d.decisions.length === 0 && !d.goalChanged && !d.titleChanged;
  return (
    <section
      className="dy-reveal grid gap-2 rounded-[12px] border border-dy-line bg-dy-card p-2.5"
      aria-label={h.diffTitle({ from: d.from.version, to: d.to.version })}
      data-testid="plan-diff"
    >
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
        <span className="font-dy-mono font-extrabold">
          {h.diffTitle({ from: d.from.version, to: d.to.version })}
        </span>
        <span className="text-[0.75rem] text-dy-muted">
          {h.author[d.to.author]} · <DyTime iso={d.to.createdAt} />
        </span>
      </p>
      {d.to.reason === null ? null : (
        <p className="m-0 text-[0.75rem] text-dy-muted [overflow-wrap:anywhere]">
          {h.reason({ reason: d.to.reason })}
        </p>
      )}
      {d.titleChanged ? <p className="m-0 text-[0.8125rem]">{h.titleChanged}</p> : null}
      {d.goalChanged ? <p className="m-0 text-[0.8125rem]">{h.goalChanged}</p> : null}
      {empty ? <p className="m-0 text-[0.8125rem] text-dy-muted">{h.empty}</p> : null}
      {groups.map((g) => {
        const items = d.items.filter((x) => x.change === g.change);
        if (items.length === 0) return null;
        return (
          <div key={g.change} className="grid gap-1">
            <h4 className="m-0 text-[0.6875rem] font-extrabold tracking-[0.04em] text-dy-muted uppercase">
              {`${g.label} (${String(items.length)})`}
            </h4>
            <ul role="list" className="m-0 grid list-none gap-1 p-0">
              {items.map((x) => {
                const s = x.after ?? x.before;
                return (
                  <li
                    key={x.key}
                    className={cx(
                      'dy-plan-diff grid gap-0.5 rounded-[8px] px-2 py-1 text-[0.8125rem] [overflow-wrap:anywhere]',
                      x.change === 'added' && 'bg-dy-teal-soft',
                      x.change === 'removed' && 'opacity-50',
                    )}
                    data-change={x.change}
                    data-testid="plan-diff-item"
                  >
                    <span className={cx('font-bold', x.change === 'removed' && 'line-through')}>
                      <span aria-hidden="true">
                        {x.change === 'added' ? '+ ' : x.change === 'removed' ? '− ' : ''}
                      </span>
                      {s?.title ?? x.key}
                    </span>
                    {x.change === 'changed'
                      ? x.fields.map((f) => (
                          <span key={f} className="text-[0.75rem] text-dy-muted">
                            {f === 'detail' || f === 'activeTitle'
                              ? fieldName(f)
                              : h.fieldChange({
                                  field: fieldName(f),
                                  from: value(f, x.before),
                                  to: value(f, x.after),
                                })}
                          </span>
                        ))
                      : null}
                    {x.change === 'moved' || (x.change === 'changed' && x.moved) ? (
                      <span className="text-[0.75rem] text-dy-muted">{`${h.moved}: ${moveLine(x)}`}</span>
                    ) : null}
                    {x.change === 'added' || x.change === 'removed' ? (
                      <span className="text-[0.75rem] text-dy-muted">{s?.phaseTitle}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {d.decisions.length === 0 ? null : (
        <div className="grid gap-1">
          <h4 className="m-0 text-[0.6875rem] font-extrabold tracking-[0.04em] text-dy-muted uppercase">
            {h.decisions}
          </h4>
          <ul role="list" className="m-0 grid list-none gap-0.5 p-0">
            {d.decisions.map((x) => (
              <li
                key={`${x.id}:${x.change}`}
                className="text-[0.8125rem] [overflow-wrap:anywhere]"
                data-testid="plan-diff-decision"
              >
                {x.change === 'asked'
                  ? h.asked({ prompt: x.prompt })
                  : h.answered({ prompt: x.prompt, answer: x.answer ?? h.none })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
