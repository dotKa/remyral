import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getWaitingPlans, type PlanNeed, planAction } from '../../../api/plans';
import { answerChatQuestion } from '../../../api/questions';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { invalidate, onInvalidate } from '../../../lib/invalidate';
import { POLL_MS } from '../../../shell/notificationPoll';
import { DyIcon } from '../../icons';
import { arrivalStyle, SmoothHeight, useArrivals } from '../../motionKit';
import { QuestionCard } from '../../questions/QuestionCard';
import { StateBadge } from '../../StateBadge';

/**
 * p18-plan-mode W4 (docs/design/p18-plan-mode.md, "Implementation (W4)"): the plans that wait for the person, on
 * "Senden bekleyen" — one card per plan with its open decisions (answered right here with the question card, through
 * the conversation's answer route: the same row as the plan panel and the chat card, so the plan updates live there)
 * and its items that wait for them (a card to confirm, a blocked item, their own item). Plan texts are model / person
 * text: plain text only. Read on open, every POLL_MS and when questions change elsewhere.
 */
export function usePlanNeeds(): {
  readonly plans: readonly PlanNeed[] | null;
  readonly reload: () => void;
} {
  const [plans, setPlans] = useState<readonly PlanNeed[] | null>(null);
  const alive = useRef(true);
  const reload = useCallback(() => {
    getWaitingPlans().then(
      (p) => {
        if (alive.current) setPlans(p);
      },
      () => {
        // An older master (404) or no access: the section stays away.
        if (alive.current) setPlans((cur) => cur ?? []);
      },
    );
  }, []);
  useEffect(() => {
    alive.current = true;
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload();
    }, POLL_MS);
    const off = onInvalidate(['questions'], reload);
    return () => {
      alive.current = false;
      clearInterval(timer);
      off();
    };
  }, [reload]);
  return { plans, reload };
}

const WHY_ICON = { card: 'shield', blocked: 'xc', mine: 'checkc' } as const;

function PlanNeedCard(props: {
  readonly need: PlanNeed;
  readonly onAnswered: () => void;
  /** p19-needs-snooze: put the plan off for a day (this browser). */
  readonly onSnooze?: (() => void) | undefined;
  /** p19-needs-snooze: the plan was cancelled here. */
  readonly onCancelled: () => void;
}): ReactNode {
  const all = useT();
  const t = all.plan;
  const p = props.need;
  const w = t.needs;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn =
    'dy-press inline-flex min-h-11 items-center rounded-lg px-2 text-[0.84375rem] sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk';
  const href = `/chat/${encodeURIComponent(p.threadId)}`;
  return (
    <article
      className="grid min-w-0 gap-2.5 rounded-[14px] border border-dy-line bg-dy-card p-3.5 shadow-dy"
      aria-labelledby={`plan-need-${p.planId}`}
      data-testid="plan-need"
      data-plan={p.planId}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <DyIcon name="flag" className="size-4 shrink-0 text-dy-violet" />
        <h3
          id={`plan-need-${p.planId}`}
          className="m-0 min-w-0 flex-1 text-[0.9375rem] font-extrabold [overflow-wrap:anywhere]"
        >
          {p.title}
        </h3>
        {p.state === 'in_review' ? <StateBadge state="needs" label={w.review} /> : null}
        {p.stalled !== null ? <StateBadge state="paused" label={w.stalled} /> : null}
        {p.questions.length === 0 ? null : (
          <span className="font-dy-mono text-[0.75rem] font-bold text-dy-amber-ink">
            {w.decisions({ n: p.questions.length })}
          </span>
        )}
      </header>
      <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
        {w.conversation({ title: p.threadTitle })}
      </p>
      {p.questions.length === 0 ? null : (
        <div className="grid gap-2" data-testid="plan-need-decisions">
          {p.questions.map((q) => (
            <SmoothHeight key={q.id}>
              <QuestionCard
                set={q}
                from="assistant"
                compact
                heading={t.decisions.heading}
                canAnswer
                onAnswer={async (answers) => {
                  await answerChatQuestion(p.threadId, q.id, answers);
                  invalidate('questions');
                  props.onAnswered();
                }}
              />
            </SmoothHeight>
          ))}
        </div>
      )}
      {p.waiting.length === 0 ? null : (
        <ul
          role="list"
          className="m-0 grid list-none gap-1 p-0"
          aria-label={w.title}
          data-testid="plan-need-items"
        >
          {p.waiting.map((i) => (
            <li
              key={i.key}
              className="flex min-w-0 items-start gap-2 rounded-[10px] bg-dy-sunk px-2.5 py-1.5 text-[0.84375rem]"
              data-why={i.why}
            >
              <DyIcon
                name={WHY_ICON[i.why]}
                className={cx(
                  'mt-0.5 size-3.5 shrink-0',
                  i.why === 'blocked' ? 'text-dy-red-ink' : 'text-dy-amber-ink',
                )}
              />
              <span className="grid min-w-0 flex-1">
                <span className="font-bold [overflow-wrap:anywhere]">{i.title}</span>
                <span className="text-[0.78125rem] text-dy-muted [overflow-wrap:anywhere]">
                  {w.why[i.why]}
                  {i.note === null ? '' : ` — ${i.note}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          to={href}
          className="dy-press inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-[0.84375rem] font-bold text-dy-teal-ink no-underline sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
          data-testid="plan-need-open"
        >
          {w.open}
          <DyIcon name="chev" className="size-3.5 -rotate-90" />
        </Link>
        {props.onSnooze === undefined ? null : (
          <button
            type="button"
            title={all.home.decisions.snoozeHint}
            onClick={props.onSnooze}
            className={cx(btn, 'text-dy-muted')}
            data-testid="plan-need-snooze"
          >
            {all.home.decisions.snooze}
          </button>
        )}
        {confirming ? (
          <span role="group" className="flex flex-wrap items-center gap-1.5 text-[0.84375rem]">
            <span>{w.cancelConfirm}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                planAction(p.planId, 'cancel').then(
                  () => {
                    setBusy(false);
                    setConfirming(false);
                    invalidate('questions');
                    props.onCancelled();
                  },
                  (err: unknown) => {
                    setBusy(false);
                    setError(err instanceof Error ? err.message : String(err));
                  },
                );
              }}
              className={cx(btn, 'font-bold text-dy-red-ink')}
              data-testid="plan-need-cancel-yes"
            >
              {w.confirmYes}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
              className={cx(btn, 'text-dy-muted')}
            >
              {w.confirmNo}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            className={cx(btn, 'text-dy-red-ink')}
            data-testid="plan-need-cancel"
          >
            {w.cancel}
          </button>
        )}
        {error === null ? null : (
          <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
            {error}
          </span>
        )}
      </div>
    </article>
  );
}

/** The plans section of "Senden bekleyen" (nothing while there is no plan waiting). */
export function PlanNeeds(props: {
  readonly plans: readonly PlanNeed[] | null;
  readonly onChanged: () => void;
  /** p19-needs-snooze: plans put off (`plan:<id>`) are not listed; `onSnooze` puts one off. */
  readonly snoozed?: ReadonlySet<string> | undefined;
  readonly onSnooze?: ((key: string) => void) | undefined;
}): ReactNode {
  const w = useT().plan.needs;
  const plans = (props.plans ?? []).filter((p) => !(props.snoozed?.has(`plan:${p.planId}`) ?? false));
  const [said, setSaid] = useState('');
  // A plan that starts waiting while the page is open tips up into place (never the first draw).
  const arrived = useArrivals(
    plans.map((p) => p.planId),
    props.plans !== null,
  );
  if (plans.length === 0) return null;
  return (
    <section aria-labelledby="plan-needs-title" className="grid gap-3" data-testid="dy-plan-needs">
      <h2
        id="plan-needs-title"
        className="m-0 flex items-center gap-2 text-[1.125rem] font-extrabold tracking-[-0.01em]"
      >
        <span
          className="grid size-7 place-items-center rounded-full bg-dy-violet-soft text-dy-violet"
          aria-hidden="true"
        >
          <DyIcon name="flag" className="size-4" />
        </span>
        {w.title}
        <span className="text-[0.875rem] font-medium text-dy-muted">{w.count({ n: plans.length })}</span>
      </h2>
      <ul role="list" className="m-0 grid list-none gap-3 p-0 min-[1180px]:grid-cols-2">
        {plans.map((p) => {
          const i = arrived.get(p.planId);
          return (
            <li
              key={p.planId}
              className={cx('min-w-0', i !== undefined && 'dy-m-arrive')}
              style={arrivalStyle(i)}
            >
              <PlanNeedCard
                need={p}
                onAnswered={() => {
                  setSaid(w.answered);
                  props.onChanged();
                }}
                onSnooze={
                  props.onSnooze === undefined
                    ? undefined
                    : () => {
                        props.onSnooze?.(`plan:${p.planId}`);
                      }
                }
                onCancelled={() => {
                  setSaid(w.cancelled);
                  props.onChanged();
                }}
              />
            </li>
          );
        })}
      </ul>
      <p className="sr-only" role="status" aria-live="polite" data-testid="plan-needs-live">
        {said}
      </p>
    </section>
  );
}
