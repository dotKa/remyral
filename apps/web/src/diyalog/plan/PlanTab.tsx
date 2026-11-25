import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { getEarlierPlans, getPlan, type Plan, type PlanSummary } from '../../api/plans';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyTime } from '../common/time';
import { DyDialog } from '../DyDialog';
import { DyIcon } from '../icons';
import { StateBadge } from '../StateBadge';
import { AutonomousChip, autonomousNow, PlanRing } from './PlanPanel';
import { openDecisions, phasesOf, planChip, progressRatio, progressText, waitingFor } from './planModel';

/**
 * p18-plans-ui (docs/design/p18-plan-mode.md, "Plans UI"): the Planlar tab of the chat's details panel — the
 * conversation's active plan as a summary (title, state with the Otonom chip, progress ring and bar, remaining time, the
 * open decisions and the items that wait for the person, "Planı aç" opens the plan panel) and its earlier plans (title,
 * state, date, n/m; each opens read only in a dialog). The plan comes live from the plan store (the panel's own plan);
 * the earlier plans are read again when the active plan changes state. Plan texts are model / person text: text only.
 */

const WAITING_SHOWN = 4;
const DECISIONS_SHOWN = 3;

export function PlanTab(props: {
  readonly threadId: string | null;
  /** The conversation's active plan (null: none; undefined: the conversation is still loading). */
  readonly plan: Plan | null | undefined;
  readonly onOpen: () => void;
  /** A plan to show (the Planlar screen's link to a closed plan): its read-only view opens; `n` grows per request. */
  readonly request?: { readonly id: string; readonly n: number } | null | undefined;
}): ReactNode {
  const t = useT().plan;
  const tab = t.tab;
  const p = props.plan ?? null;
  const [earlier, setEarlier] = useState<readonly PlanSummary[] | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const headingId = useId();
  const earlierId = useId();
  const threadId = props.threadId;
  const planKey = p === null ? 'none' : `${p.id}:${p.state}`;
  useEffect(() => {
    if (threadId === null) {
      setEarlier([]);
      return;
    }
    const ctl = new AbortController();
    getEarlierPlans(threadId, { signal: ctl.signal }).then(setEarlier, () => {
      if (!ctl.signal.aborted) setEarlier([]);
    });
    return () => {
      ctl.abort();
    };
  }, [threadId, planKey]);
  const reqN = props.request?.n ?? 0;
  const reqId = props.request?.id ?? null;
  const activeId = p?.id ?? null;
  const { onOpen } = props;
  useEffect(() => {
    if (reqId === null) return;
    if (reqId === activeId) onOpen();
    else setShown(reqId);
    // One answer per request (`n`), not per re-render.
  }, [reqN]);

  if (props.plan === undefined)
    return (
      <div role="status" aria-busy="true" aria-label={t.panel.loading} className="dy-breathe grid gap-2">
        <span aria-hidden="true" className="block h-28 rounded-[12px] bg-dy-line/80" />
        <span aria-hidden="true" className="block h-10 rounded-[12px] bg-dy-line/80" />
      </div>
    );

  const decisions = p === null ? [] : p.decisions.filter((d) => d.state === 'pending');
  const waiting = p === null ? [] : waitingFor(p);
  return (
    <div className="grid gap-4" data-testid="details-plans">
      {p === null ? (
        <div
          data-testid="details-empty"
          data-dy-empty=""
          className="flex flex-col items-center gap-3 px-6 py-8 text-center"
        >
          <span
            aria-hidden="true"
            className="grid size-12 place-items-center rounded-full bg-dy-sunk text-dy-faint"
          >
            <DyIcon name="flag" className="size-6" />
          </span>
          <p className="m-0 max-w-[16rem] text-[0.8125rem] text-dy-muted">{tab.empty}</p>
        </div>
      ) : (
        <section
          aria-labelledby={headingId}
          className="grid gap-2.5 rounded-[12px] border border-dy-line bg-dy-card p-3"
          data-testid="details-plan-active"
          data-plan={p.id}
        >
          <p className="m-0 text-[0.6875rem] font-bold tracking-[0.04em] text-dy-faint uppercase">
            {tab.active}
          </p>
          <div className="flex min-w-0 items-start gap-2.5">
            <PlanRing ratio={progressRatio(p)} className="mt-0.5" />
            <div className="grid min-w-0 flex-1 gap-1">
              <h3
                id={headingId}
                className="m-0 text-[0.9375rem] leading-snug font-extrabold [overflow-wrap:anywhere]"
              >
                {p.title}
              </h3>
              <div className="flex flex-wrap items-center gap-1.5">
                <StateBadge state={planChip(p.state)} label={t.states[p.state]} />
                {autonomousNow(p) ? <AutonomousChip /> : null}
              </div>
            </div>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-dy-sunk"
            role="progressbar"
            aria-label={t.progressLabel({ done: p.progress.done, total: p.progress.total })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressRatio(p) * 100)}
          >
            <div
              className="dy-m-meter h-full w-full origin-left rounded-full bg-dy-teal"
              style={{ transform: `scaleX(${String(progressRatio(p))})` }}
            />
          </div>
          <p className="m-0 font-dy-mono text-[0.75rem] text-dy-muted" data-testid="details-plan-progress">
            {progressText(p, t)}
          </p>
          {decisions.length === 0 ? null : (
            <div className="grid gap-1" data-testid="details-plan-decisions">
              <p className="m-0 flex items-center gap-1.5 text-[0.8125rem] font-bold text-dy-amber-ink">
                <span className="size-2 rounded-full bg-dy-amber" aria-hidden="true" />
                {t.decisions.waiting({ n: openDecisions(p) })}
              </p>
              <ul role="list" className="m-0 grid list-none gap-1 p-0">
                {decisions.slice(0, DECISIONS_SHOWN).map((d) => (
                  <li
                    key={d.id}
                    className="truncate rounded-[8px] bg-dy-sunk px-2 py-1 text-[0.78125rem]"
                    title={d.prompt}
                  >
                    {d.prompt}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {waiting.length === 0 ? null : (
            <div className="grid gap-1" data-testid="details-plan-waiting">
              <p className="m-0 text-[0.8125rem] font-bold">{tab.waiting}</p>
              <ul role="list" className="m-0 grid list-none gap-1 p-0">
                {waiting.slice(0, WAITING_SHOWN).map((w) => (
                  <li key={w.item.key} className="flex min-w-0 items-start gap-1.5 text-[0.78125rem]">
                    <DyIcon
                      name={w.why === 'blocked' ? 'xc' : w.why === 'card' ? 'shield' : 'checkc'}
                      className={cx(
                        'mt-0.5 size-3.5 shrink-0',
                        w.why === 'blocked' ? 'text-dy-red-ink' : 'text-dy-amber-ink',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-bold [overflow-wrap:anywhere]">{w.item.title}</span>
                      <span className="text-dy-muted"> — {t.needs.why[w.why]}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {waiting.length > WAITING_SHOWN ? (
                <p className="m-0 text-[0.75rem] text-dy-muted">
                  {tab.more({ n: waiting.length - WAITING_SHOWN })}
                </p>
              ) : null}
            </div>
          )}
          <button
            type="button"
            onClick={props.onOpen}
            className="dy-press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[9px] border border-dy-ink bg-dy-ink px-3 text-[0.84375rem] font-bold text-dy-card sm:min-h-9"
            data-testid="details-plan-open"
          >
            <DyIcon name="flag" className="size-4" />
            {tab.open}
          </button>
        </section>
      )}
      <section aria-labelledby={earlierId} className="grid gap-1.5">
        <h3 id={earlierId} className="m-0 text-[0.8125rem] font-extrabold">
          {tab.earlier}
        </h3>
        {earlier === null ? (
          <span aria-hidden="true" className="dy-breathe block h-9 rounded-[10px] bg-dy-line/80" />
        ) : earlier.length === 0 ? (
          <p className="m-0 text-[0.78125rem] text-dy-muted">{tab.noEarlier}</p>
        ) : (
          <ul role="list" className="m-0 grid list-none gap-1 p-0" data-testid="details-plan-earlier">
            {earlier.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  aria-label={tab.earlierOpen({ title: e.title })}
                  onClick={() => {
                    setShown(e.id);
                  }}
                  className="dy-press flex min-h-11 w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[10px] border border-dy-line bg-dy-card px-2.5 py-1.5 text-left text-[0.8125rem] [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2"
                >
                  <span className="min-w-0 flex-1 basis-full truncate font-bold">{e.title}</span>
                  <StateBadge state={planChip(e.state)} label={t.states[e.state]} />
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                    {t.history.earlierItem({ done: e.done, total: e.total })}
                  </span>
                  <DyTime iso={e.closedAt ?? e.createdAt} className="ml-auto text-[0.75rem] text-dy-muted" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Link
        to="/plans"
        className="dy-press inline-flex min-h-11 items-center gap-1 justify-self-start rounded-lg px-1 text-[0.8125rem] font-bold text-dy-teal-ink no-underline sm:min-h-8"
        data-testid="details-plans-all"
      >
        {tab.all}
        <DyIcon name="chev" className="size-3.5 -rotate-90" />
      </Link>
      <EarlierPlanDialog
        id={shown}
        onClose={() => {
          setShown(null);
        }}
      />
    </div>
  );
}

/** A closed plan, read only: state, progress, goal and its phases with each item's status. */
function EarlierPlanDialog(props: { readonly id: string | null; readonly onClose: () => void }): ReactNode {
  const t = useT().plan;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);
  const { id } = props;
  useEffect(() => {
    setPlan(null);
    setFailed(false);
    if (id === null) return;
    const ctl = new AbortController();
    getPlan(id, { signal: ctl.signal }).then(setPlan, () => {
      if (!ctl.signal.aborted) setFailed(true);
    });
    return () => {
      ctl.abort();
    };
  }, [id]);
  return (
    <DyDialog
      open={id !== null}
      onClose={props.onClose}
      title={plan?.title ?? t.region}
      size="md"
      testId="details-plan-dialog"
    >
      {failed ? (
        <p role="alert" className="m-0 text-[0.875rem] text-dy-red-ink">
          {t.tab.loadFailed}
        </p>
      ) : plan === null ? (
        <p role="status" className="m-0 text-[0.875rem] text-dy-muted">
          {t.panel.loading}
        </p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={planChip(plan.state)} label={t.states[plan.state]} />
            <span className="font-dy-mono text-[0.8125rem] text-dy-muted">{progressText(plan, t)}</span>
            <span className="text-[0.8125rem] text-dy-muted">{t.version({ v: plan.version })}</span>
          </div>
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.tab.readOnly}</p>
          {plan.goal === '' ? null : (
            <p className="m-0 text-[0.875rem] [overflow-wrap:anywhere]">{plan.goal}</p>
          )}
          {plan.items.length === 0 ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{t.tab.noItems}</p>
          ) : (
            phasesOf(plan, 'all').map((ph) => (
              <section key={ph.index} className="grid gap-1">
                <h3 className="m-0 text-[0.8125rem] font-extrabold">
                  {t.phase({ title: ph.title, done: ph.done, total: ph.total })}
                </h3>
                <ul role="list" className="m-0 grid list-none gap-1 p-0">
                  {ph.items.map((i) => (
                    <li
                      key={i.key}
                      className="flex min-w-0 items-start gap-2 rounded-[8px] bg-dy-sunk px-2.5 py-1.5 text-[0.84375rem]"
                    >
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{i.title}</span>
                      <span className="shrink-0 text-[0.75rem] text-dy-muted">{t.status[i.status]}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </DyDialog>
  );
}
