import { createContext, type ReactNode, useContext, useState } from 'react';
import type { Plan } from '../../api/plans';
import type { QuestionSet } from '../../api/questions';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { useChatActions } from '../chat/chatActions';
import { DyIcon } from '../icons';
import type { DyState } from '../StateBadge';
import { AutonomousChip, autonomousNow, ReviewActions, usePlanActions } from './PlanPanel';
import { openDecisions, planChip, progressText } from './planModel';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §7.4): the plan's cards in the chat strip — the plan card (title, goal,
 * phases and items, the change against the previous version, open decisions, assumptions / risks, Planı incele /
 * Değişiklik iste / Onayla) and the planning proposal ("Bu iş büyük görünüyor — önce planlayayım mı?" [Planla]
 * [Hemen yap]). The plan card reads the live plan of the conversation (one row: the panel and the card show the same).
 */

export interface PlanThreadContext {
  readonly plan: Plan | null;
  readonly threadId: string;
  readonly readOnly: boolean;
  readonly questions: readonly QuestionSet[];
  readonly turnOpen: boolean;
  readonly onChanged: () => void;
}

export const PlanContext = createContext<PlanThreadContext | null>(null);

export function usePlanContext(): PlanThreadContext | null {
  return useContext(PlanContext);
}

export interface PlanCardSummary {
  readonly kind: string;
  readonly title: string;
  readonly state: DyState;
  readonly stateLabel: string;
  readonly needsAction: boolean;
  readonly facts: readonly { readonly k: string; readonly v: string }[];
}

/** The collapsed strip card of a plan (`current`: the conversation's live plan when it is this one). */
export function planSummary(
  t: ReturnType<typeof useT>,
  card: { readonly planId: string; readonly version: number; readonly newer?: string | undefined },
  current: Plan | null,
): PlanCardSummary {
  const tp = t.plan;
  const live = current !== null && current.id === card.planId ? current : null;
  // p20-decisions: a later turn wrote the same plan again — this card folds ("Yerine geçti"); the newer one acts.
  if (card.newer !== undefined)
    return {
      kind: `${tp.card.kind} · ${tp.version({ v: card.version })}`,
      title: live?.title ?? tp.version({ v: card.version }),
      state: 'stale',
      stateLabel: t.chat.cards.replaced,
      needsAction: false,
      facts: [],
    };
  if (live === null)
    return {
      kind: tp.card.kind,
      title: tp.version({ v: card.version }),
      state: 'stale',
      stateLabel: tp.states.superseded,
      needsAction: false,
      facts: [],
    };
  const phases = new Set(live.items.map((i) => i.phase)).size;
  const n = openDecisions(live);
  return {
    kind: `${tp.card.kind} · ${tp.version({ v: live.version })}`,
    title: live.title,
    state: planChip(live.state),
    // p18-plan-autonomy: "Yürütülüyor · Otonom" while the plan runs its steps by itself.
    stateLabel: autonomousNow(live)
      ? `${tp.states[live.state]} · ${tp.autonomy.chip}`
      : tp.states[live.state],
    needsAction: (live.state === 'in_review' || live.state === 'drafting') && card.version === live.version,
    facts: [
      { k: tp.card.counts({ phases, items: live.items.length }), v: progressText(live, tp) },
      ...(n === 0 ? [] : [{ k: tp.decisions.needed, v: tp.decisions.waiting({ n }) }]),
    ],
  };
}

/** p18-multi-project W3: the distinct projects a plan's items name (in item order). */
export function planItemProjects(p: Plan): string[] {
  return [...new Set(p.items.flatMap((i) => (i.project === null ? [] : [i.project])))];
}

export function proposalSummary(
  t: ReturnType<typeof useT>,
  answered: boolean,
  reason: string,
): PlanCardSummary {
  return {
    kind: t.plan.proposal.kind,
    title: t.plan.proposal.title,
    state: answered ? 'done' : 'needs',
    stateLabel: answered ? t.plan.proposal.answered : t.questions.card.fromAssistant,
    needsAction: !answered,
    facts: reason === '' ? [] : [{ k: t.plan.proposal.why, v: reason }],
  };
}

const button =
  'dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] px-3 text-[0.8125rem] font-bold disabled:opacity-50 sm:min-h-8';

/** The open plan card: goal, counts, the version change, assumptions / risks, the review actions. */
export function PlanCardBody(props: {
  readonly planId: string;
  readonly version: number;
  /** p20-decisions: a newer card of the same plan replaced this one (its key): no review actions here, a way there. */
  readonly newer?: string | undefined;
  readonly onGoCurrent?: ((key: string) => void) | undefined;
}): ReactNode {
  const t = useT().plan;
  const tc = useT().chat.cards;
  const ctx = usePlanContext();
  const chat = useChatActions();
  const plan = ctx?.plan ?? null;
  const live = plan !== null && plan.id === props.planId ? plan : null;
  const [more, setMore] = useState(false);
  const newer = props.newer;
  if (newer !== undefined)
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="plan-card-replaced">
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.card.replaced}</p>
        {props.onGoCurrent === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              props.onGoCurrent?.(newer);
            }}
            className={cx(button, 'border border-dy-line-2 bg-dy-card text-dy-ink')}
            data-testid="plan-card-go-current"
          >
            {tc.goCurrent}
            <DyIcon name="chev" className="size-3.5 -rotate-90 text-dy-muted" />
          </button>
        )}
      </div>
    );
  if (ctx === null || live === null)
    return (
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="plan-card-old">
        {t.card.old}
      </p>
    );
  return (
    <PlanCardLive
      plan={live}
      ctx={ctx}
      old={props.version !== live.version}
      more={more}
      onMore={() => {
        setMore((v) => !v);
      }}
      {...(chat?.openPlan === undefined ? {} : { openPlan: chat.openPlan })}
    />
  );
}

function PlanCardLive(props: {
  readonly plan: Plan;
  readonly ctx: PlanThreadContext;
  readonly old: boolean;
  readonly more: boolean;
  readonly onMore: () => void;
  readonly openPlan?: () => void;
}): ReactNode {
  const t = useT().plan;
  const p = props.plan;
  const panelProps = {
    plan: p,
    threadId: props.ctx.threadId,
    readOnly: props.ctx.readOnly,
    questions: props.ctx.questions,
    onChanged: props.ctx.onChanged,
    turnOpen: props.ctx.turnOpen,
  };
  const actions = usePlanActions(panelProps);
  const phases = new Set(p.items.map((i) => i.phase)).size;
  return (
    <section
      className="grid min-w-0 gap-2 rounded-[14px] border border-dy-violet/40 bg-dy-card px-3.5 py-3 shadow-dy"
      data-testid="plan-card"
      data-plan-state={p.state}
    >
      <p className="m-0 text-[0.9375rem] font-extrabold [overflow-wrap:anywhere]">{p.title}</p>
      {/* p18-multi-project W3: the projects the plan's items name, as chips. */}
      {planItemProjects(p).length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0" data-testid="plan-card-projects">
          {planItemProjects(p).map((pr) => (
            <li
              key={pr}
              className="inline-flex min-h-6 items-center gap-1 rounded-full border border-dy-line px-2 text-[0.75rem] font-bold text-dy-muted"
            >
              <DyIcon name="folder" className="size-3" />
              {pr}
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-[0.84375rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
        <span className="font-bold text-dy-muted">{`${t.card.goal}: `}</span>
        {p.goal}
      </p>
      <p className="m-0 flex flex-wrap gap-x-2 text-[0.8125rem] text-dy-muted">
        <span>{t.card.counts({ phases, items: p.items.length })}</span>
        <span className="font-dy-mono">{progressText(p, t)}</span>
        {autonomousNow(p) ? <AutonomousChip /> : null}
        {p.lastChange === null ? null : (
          <span data-testid="plan-card-diff">
            {t.diff({ added: p.lastChange.added, removed: p.lastChange.removed, moved: p.lastChange.moved })}
          </span>
        )}
      </p>
      {props.old ? <p className="m-0 text-[0.75rem] text-dy-amber-ink">{t.card.old}</p> : null}
      {p.assumptions.length + p.risks.length === 0 ? null : (
        <div className="grid gap-1">
          <button
            type="button"
            aria-expanded={props.more}
            onClick={props.onMore}
            className="dy-press inline-flex min-h-9 items-center gap-1.5 self-start rounded-[8px] px-1 text-[0.8125rem] font-bold text-dy-teal-ink"
          >
            <DyIcon name="chev" className={cx('dy-plan-chev size-3.5', props.more ? '' : '-rotate-90')} />
            {[
              p.assumptions.length === 0 ? null : t.card.assumptions({ n: p.assumptions.length }),
              p.risks.length === 0 ? null : t.card.risks({ n: p.risks.length }),
            ]
              .filter((x) => x !== null)
              .join(' · ')}
          </button>
          {props.more ? (
            <ul className="dy-reveal m-0 grid list-disc gap-0.5 pl-5 text-[0.8125rem]">
              {[...p.assumptions, ...p.risks].map((x) => (
                <li key={x} className="[overflow-wrap:anywhere]">
                  {x}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {props.openPlan === undefined ? null : (
          <button
            type="button"
            onClick={props.openPlan}
            className={cx(button, 'border border-dy-line-2 bg-dy-card text-dy-ink')}
            data-testid="plan-card-open"
          >
            <DyIcon name="flag" className="size-3.5" />
            {t.actions.review}
          </button>
        )}
      </div>
      {props.old ? null : <ReviewActions {...panelProps} actions={actions} openPlan={props.openPlan} />}
      {actions.error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {actions.error}
        </p>
      )}
      {actions.conflict ? (
        <p role="status" className="m-0 text-[0.8125rem] text-dy-amber-ink">
          {t.conflict}
        </p>
      ) : null}
    </section>
  );
}

/** The planning proposal: [Planla] turns plan mode on with the message; [Hemen yap] goes on without a plan. */
export function PlanProposalBody(props: { readonly reason: string; readonly answered: boolean }): ReactNode {
  const t = useT().plan;
  const chat = useChatActions();
  const sayError = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = chat?.send;
  const go = (plan: boolean): void => {
    if (send === undefined) return;
    setBusy(true);
    setError(null);
    send(plan ? t.proposal.planMessage : t.proposal.nowMessage, { plan }).then(
      () => {
        setBusy(false);
      },
      (err: unknown) => {
        setBusy(false);
        setError(sayError(err));
      },
    );
  };
  return (
    <section
      className="grid min-w-0 gap-2 rounded-[14px] border border-dy-violet/40 bg-dy-card px-3.5 py-3 shadow-dy"
      data-testid="plan-proposal"
    >
      <p className="m-0 text-[0.9375rem] font-extrabold">{t.proposal.title}</p>
      {props.reason === '' ? null : (
        <p className="m-0 text-[0.84375rem] [overflow-wrap:anywhere]">{props.reason}</p>
      )}
      {props.answered || send === undefined ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.proposal.answered}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy || chat?.planReady === false}
            title={chat?.planReady === false ? t.mode.unavailable : undefined}
            onClick={() => {
              go(true);
            }}
            className={cx(button, 'bg-dy-violet text-dy-on-fill')}
            data-testid="plan-proposal-plan"
          >
            <DyIcon name="flag" className="size-3.5" />
            {t.proposal.plan}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              go(false);
            }}
            className={cx(button, 'border border-dy-line-2 bg-dy-card text-dy-ink')}
            data-testid="plan-proposal-now"
          >
            {t.proposal.now}
          </button>
        </div>
      )}
      {chat?.planReady === false && !props.answered ? (
        <p className="m-0 text-[0.75rem] text-dy-muted">{t.mode.unavailable}</p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </section>
  );
}
