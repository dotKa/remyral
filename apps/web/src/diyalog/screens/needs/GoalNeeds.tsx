import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { type Goal, goalAction, listGoals } from '../../../api/goals';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { onInvalidate } from '../../../lib/invalidate';
import { POLL_MS } from '../../../shell/notificationPoll';
import { DyIcon } from '../../icons';
import { arrivalStyle, useArrivals } from '../../motionKit';

/**
 * p20-outcome (docs/design/p20-outcome-contract.md, "The intervention card"): the goals that cannot move on by
 * themselves, on "Senden bekleyen" — ONE persistent card per goal (the goal row is the card): what was asked, what
 * happened (the coded reason in words plus the concrete detail), the next step and what the person has to do, with
 * "Devam ettir", "Vazgeç" (confirmed inline) and "Sohbete git". A plan goal whose plan already has its card in the plans
 * section is not drawn twice. Goal texts are model / person text: plain text only. Read on open and every POLL_MS.
 */
export function useGoalNeeds(): {
  readonly goals: readonly Goal[] | null;
  readonly reload: () => void;
} {
  const [goals, setGoals] = useState<readonly Goal[] | null>(null);
  const alive = useRef(true);
  const reload = useCallback(() => {
    listGoals('intervention').then(
      (g) => {
        if (alive.current) setGoals(g);
      },
      () => {
        // An older master (404) or no access: the section stays away.
        if (alive.current) setGoals((cur) => cur ?? []);
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
  return { goals, reload };
}

/** The reason code's family (`plan_stalled:budget` → `plan_stalled`), for the texts. */
function family(table: Readonly<Record<string, string>>, code: string | null): string {
  const key = (code ?? '').split(':')[0] ?? '';
  return key in table ? (table[key] ?? '') : (table.other ?? '');
}

function GoalCard(props: { readonly goal: Goal; readonly onDone: (said: string) => void }): ReactNode {
  const t = useT().goals;
  const g = props.goal;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn =
    'dy-press inline-flex min-h-11 items-center rounded-lg px-2.5 text-[0.84375rem] sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk';
  const act = (action: 'resume' | 'cancel'): void => {
    setBusy(true);
    setError(null);
    goalAction(g.id, action).then(
      () => {
        setBusy(false);
        setConfirming(false);
        props.onDone(action === 'resume' ? t.card.resumed : t.card.cancelled);
      },
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  const happened = family(t.reason, g.blockedReason);
  const todo = g.userAction ?? family(t.action, g.blockedReason);
  const next = g.nextNote ?? (g.nextAction === null ? null : family(t.nextAction, g.nextAction));
  const row = (label: string, body: ReactNode, testId: string): ReactNode => (
    <div className="grid gap-0.5" data-testid={testId}>
      <dt className="text-[0.75rem] font-bold tracking-[0.02em] text-dy-muted uppercase">{label}</dt>
      <dd className="m-0 text-[0.875rem] [overflow-wrap:anywhere]">{body}</dd>
    </div>
  );
  return (
    <article
      id={`hedef-${g.id}`}
      className="grid min-w-0 gap-2.5 rounded-[14px] border border-dy-line bg-dy-card p-3.5 shadow-dy"
      aria-labelledby={`goal-need-${g.id}`}
      data-testid="goal-need"
      data-goal={g.id}
      data-reason={g.blockedReason ?? ''}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <DyIcon name="warn" className="size-4 shrink-0 text-dy-amber-ink" />
        <span className="rounded-full bg-dy-sunk px-2 py-[1px] text-[0.75rem] font-bold text-dy-muted">
          {t.origin[g.origin.kind]}
        </span>
        <h3
          id={`goal-need-${g.id}`}
          className="m-0 min-w-0 flex-1 text-[0.9375rem] font-extrabold [overflow-wrap:anywhere]"
        >
          {g.title}
        </h3>
        {g.interventions > 1 ? (
          <span className="font-dy-mono text-[0.75rem] font-bold text-dy-amber-ink">
            {t.card.again({ n: g.interventions })}
          </span>
        ) : null}
      </header>
      {g.threadId === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
          {t.card.conversation({ title: g.threadTitle ?? t.card.untitledConversation })}
        </p>
      )}
      <dl className="m-0 grid gap-2">
        {row(t.card.asked, g.outcomeCondition, 'goal-need-asked')}
        {row(
          t.card.happened,
          <>
            {happened}
            {g.detail === null ? null : <span className="text-dy-muted"> — {g.detail}</span>}
          </>,
          'goal-need-happened',
        )}
        {next === null ? null : row(t.card.next, next, 'goal-need-next')}
        {row(t.card.you, <b className="font-bold">{todo}</b>, 'goal-need-you')}
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            act('resume');
          }}
          className={cx(btn, 'bg-dy-teal-soft font-bold text-dy-teal-ink')}
          data-testid="goal-need-resume"
        >
          <DyIcon name="retry" className="mr-1 size-3.5" />
          {t.card.resume}
        </button>
        {g.threadId === null ? null : (
          <Link
            to={`/chat/${encodeURIComponent(g.threadId)}`}
            className={cx(btn, 'gap-1 font-bold text-dy-teal-ink no-underline')}
            data-testid="goal-need-chat"
          >
            {t.card.toChat}
            <DyIcon name="chev" className="size-3.5 -rotate-90" />
          </Link>
        )}
        {confirming ? (
          <span role="group" className="flex flex-wrap items-center gap-1.5 text-[0.84375rem]">
            <span>{g.origin.kind === 'plan' ? t.card.cancelPlanConfirm : t.card.cancelConfirm}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                act('cancel');
              }}
              className={cx(btn, 'font-bold text-dy-red-ink')}
              data-testid="goal-need-cancel-yes"
            >
              {t.card.confirmYes}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
              className={cx(btn, 'text-dy-muted')}
            >
              {t.card.confirmNo}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            className={cx(btn, 'text-dy-red-ink')}
            data-testid="goal-need-cancel"
          >
            {t.card.cancel}
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

/** The intervention section of "Senden bekleyen" (nothing while no goal waits for the person). */
export function GoalNeeds(props: {
  readonly goals: readonly Goal[] | null;
  readonly onChanged: () => void;
  /** Plans the plans section shows already (their plan goal is not drawn twice). */
  readonly plansShown?: ReadonlySet<string> | undefined;
}): ReactNode {
  const t = useT().goals;
  const goals = (props.goals ?? []).filter(
    (g) => !(g.origin.kind === 'plan' && (props.plansShown?.has(g.origin.id) ?? false)),
  );
  const [said, setSaid] = useState('');
  // `/needs#hedef=<id>` (the notification's link) brings that card into view.
  const { hash } = useLocation();
  const loaded = props.goals !== null;
  useEffect(() => {
    if (!loaded || !hash.startsWith('#hedef=')) return;
    const card = document.getElementById(`hedef-${hash.slice('#hedef='.length)}`);
    // jsdom (the tests) has no scrollIntoView.
    if (card !== null && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center' });
  }, [hash, loaded]);
  const arrived = useArrivals(
    goals.map((g) => g.id),
    props.goals !== null,
  );
  return (
    <>
      {goals.length === 0 ? null : (
        <section aria-labelledby="goal-needs-title" className="grid gap-3" data-testid="dy-goal-needs">
          <h2
            id="goal-needs-title"
            className="m-0 flex items-center gap-2 text-[1.125rem] font-extrabold tracking-[-0.01em]"
          >
            <span
              className="grid size-7 place-items-center rounded-full bg-dy-amber-soft text-dy-amber-ink"
              aria-hidden="true"
            >
              <DyIcon name="warn" className="size-4" />
            </span>
            {t.section.title}
            <span className="text-[0.875rem] font-medium text-dy-muted">
              {t.section.count({ n: goals.length })}
            </span>
          </h2>
          <p className="m-0 text-[0.84375rem] text-dy-muted">{t.section.hint}</p>
          <ul role="list" className="m-0 grid list-none gap-3 p-0 min-[1180px]:grid-cols-2">
            {goals.map((g) => {
              const i = arrived.get(g.id);
              return (
                <li
                  key={g.id}
                  className={cx('min-w-0', i !== undefined && 'dy-m-arrive')}
                  style={arrivalStyle(i)}
                >
                  <GoalCard
                    goal={g}
                    onDone={(text) => {
                      setSaid(text);
                      props.onChanged();
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <p className="sr-only" role="status" aria-live="polite" data-testid="goal-needs-live">
        {said}
      </p>
    </>
  );
}
