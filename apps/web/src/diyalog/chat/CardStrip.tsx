import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import type { QuestionSet } from '../../api/questions';
import { cx } from '../../components/ui';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { draftKindText, summarizeDraft } from '../drafts/summary';
import { resultLink } from '../drafts/parts';
import { DyIcon } from '../icons';
import { DraftItemCard } from '../ops/DraftCard';
import type { StripCard } from '../ops/timeline';
import { ChatQuestion } from '../questions/ChatQuestion';
import {
  PlanCardBody,
  PlanProposalBody,
  planSummary,
  proposalSummary,
  usePlanContext,
} from '../plan/PlanCard';
import { STAGGER_MAX, useSmoothHeight } from '../motionKit';
import { type DyState, StateBadge } from '../StateBadge';
import { type AssistantCodeCard, assistantCodeCardHref } from '../code/refs';
import type { Messages } from '@remyral/i18n';

/**
 * p15-chat-cards-scroll: the cards one assistant turn produced, BELOW its answer, compact — several approval cards of
 * one message share a single swipeable row, each collapsed, because full cards took too much room in the thread.
 *
 * - Every card is collapsed by default: kind, title, a state chip and — when the card waits for the person — a visible
 *   primary action. "İncele ve onayla" / "Yanıtla" open the full card (a draft is never confirmed from its summary: its
 *   facts, checklist and step-up live on the full card). A decided card shows its result link instead.
 * - More than one card: one horizontally scrollable row (scroll-snap) with ‹ › buttons and a "1/4" position. Arrow
 *   keys, Home and End move between the cards (roving tab stop); Enter / Space opens one; Escape collapses it again.
 * - One card is open at a time, inline below the row.
 * - p17-panel-motion: the strip's height follows the open card (opening, deciding, collapsing) instead of jumping, and
 *   the opened card comes in from just above (`dy-reveal`); none under reduced motion.
 */

const DRAFT_STATE: Readonly<Record<string, DyState>> = {
  proposed: 'needs',
  confirmed: 'done',
  dismissed: 'cancelled',
  expired: 'stale',
};
const QUESTION_STATE: Readonly<Record<QuestionSet['state'], DyState>> = {
  pending: 'needs',
  answered: 'done',
  expired: 'stale',
  cancelled: 'cancelled',
};

interface Summary {
  readonly kind: string;
  readonly title: string;
  readonly state: DyState;
  readonly stateLabel: string;
  /** The card waits for the person (an open draft, an unanswered question). */
  readonly needsAction: boolean;
  readonly link: { readonly to: string; readonly label: string } | null;
  /** The card's key facts (project, runtime, machine …) so the collapsed card says what it is about. */
  readonly facts: readonly { readonly k: string; readonly v: string }[];
  /** p20-decisions: a folded card another one replaced — the key of the current card ("Güncel karta git"). */
  readonly goTo?: string | undefined;
}

/**
 * p20-decisions: a plan decision closed without its card being answered folds with why — settled in the conversation
 * (with what was settled), replaced by a new plan, or its plan ended. Null: any other question.
 */
function closedDecision(
  q: QuestionSet,
  w: Messages['chat']['cards'],
): Pick<Summary, 'state' | 'stateLabel' | 'facts'> | null {
  if (q.state !== 'cancelled') return null;
  switch (q.closeReason) {
    case 'settled_in_chat':
      return {
        state: 'done',
        stateLabel: w.settled,
        facts: q.closeNote === undefined ? [] : [{ k: w.settledAnswer, v: q.closeNote }],
      };
    case 'plan_superseded':
      return { state: 'stale', stateLabel: w.replaced, facts: [] };
    case 'plan_cancelled':
    case 'plan_done':
      return { state: 'cancelled', stateLabel: w.planClosed, facts: [] };
    default:
      return null;
  }
}

/**
 * p20-decisions: brings the current card of a folded one into view — scrolls to it (in its strip and in the
 * conversation), opens it and moves the focus to it.
 */
export function goToCard(key: string): void {
  const el = [...document.querySelectorAll<HTMLElement>('[data-testid="strip-card"]')].find(
    (e) => e.dataset.cardKey === key,
  );
  if (el === undefined) return;
  const reduce =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof el.scrollIntoView === 'function')
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  const toggle = el.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (toggle === null) return;
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  toggle.focus();
}

function useSummary(): (c: StripCard) => Summary {
  const t = useT();
  // p18-plan-mode: plan cards read the conversation's live plan.
  const plan = usePlanContext()?.plan ?? null;
  const f = useFormat();
  const w = t.chat.cards;
  return (c) => {
    if (c.kind === 'draft') {
      const d = c.d;
      return {
        kind: draftKindText(d.kind, t, d.payload),
        // p16-chat-complete: a shared reader may not see this card's project.
        title: d.restricted === true ? t.chatComplete.shared.restricted : d.title,
        state: DRAFT_STATE[d.state] ?? 'queued',
        stateLabel: Object.hasOwn(t.drafts.states, d.state)
          ? t.drafts.states[d.state as keyof typeof t.drafts.states]
          : d.state,
        needsAction: d.state === 'proposed',
        link: d.state === 'confirmed' && d.result !== null ? resultLink(d.result, t) : null,
        facts: draftFacts(d, t, f),
      };
    }
    if (c.kind === 'plan') return { ...planSummary(t, c, plan), link: null, goTo: c.newer };
    if (c.kind === 'proposal') return { ...proposalSummary(t, c.answered, c.reason), link: null };
    if (c.kind === 'code') return codeSummary(t, c.card);
    const q = c.q;
    return {
      kind: w.question,
      title: q.title ?? q.questions[0]?.prompt ?? w.question,
      state: QUESTION_STATE[q.state],
      stateLabel: w.questionStates[q.state],
      needsAction: q.state === 'pending',
      link: null,
      facts: [],
      ...closedDecision(q, w),
      goTo: c.newer,
    };
  };
}

/**
 * p19-ide W4: the assistant's "Aç" card (open_code / open_diff): what it opens and where. Nothing waits for the person
 * and nothing opens by itself — the link is the card's one action.
 */
function codeSummary(t: Messages, card: AssistantCodeCard): Summary {
  const w = t.code.assistant;
  if (card.kind === 'code') {
    const lines =
      card.startLine === undefined
        ? ''
        : `:${String(card.startLine)}${card.endLine === undefined || card.endLine === card.startLine ? '' : `-${String(card.endLine)}`}`;
    return {
      kind: w.kindCode,
      title: `${card.path}${lines}`,
      state: 'done',
      stateLabel: w.ready,
      needsAction: false,
      link: { to: assistantCodeCardHref(card), label: w.open },
      facts: [
        { k: w.project, v: card.project },
        { k: w.ref, v: card.refLabel },
      ],
    };
  }
  const title =
    card.title ??
    (card.job !== undefined
      ? w.job
      : card.pr !== undefined
        ? w.pr({ n: card.pr })
        : w.compare({ base: card.base ?? '', head: card.head ?? '' }));
  return {
    kind: w.kindDiff,
    title,
    state: 'done',
    stateLabel: w.ready,
    needsAction: false,
    link: { to: assistantCodeCardHref(card), label: w.open },
    facts: [
      { k: w.project, v: card.project },
      ...(card.path === undefined ? [] : [{ k: w.file, v: card.path }]),
      ...(card.files === undefined ? [] : [{ k: w.kindDiff, v: w.files({ n: card.files }) }]),
    ].slice(0, 3),
  };
}

/** p19-ide W4: the opened "Aç" card: the assistant's note, the plain words that nothing opens by itself, the link. */
function CodeCardBody(props: { readonly card: AssistantCodeCard }): ReactNode {
  const w = useT().code.assistant;
  const { card } = props;
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-dy-line bg-dy-card px-3 py-2"
      data-testid="code-card-body"
    >
      {card.note === undefined ? null : (
        <p className="m-0 text-[0.8125rem] [overflow-wrap:anywhere] text-dy-ink">
          <span className="text-dy-muted">{w.note}: </span>
          {card.note}
        </p>
      )}
      <p className="m-0 text-[0.75rem] text-dy-muted">{w.never}</p>
      <Link
        to={assistantCodeCardHref(card)}
        className="dy-press inline-flex min-h-11 items-center gap-1.5 self-start rounded-[9px] bg-dy-teal px-3 text-[0.8125rem] font-bold text-dy-on-fill no-underline sm:min-h-8"
        data-testid="code-card-open"
      >
        {card.kind === 'code' ? w.openCode : w.openDiff}
        <DyIcon name="chev" className="size-3.5 -rotate-90" />
      </Link>
    </div>
  );
}

/** Up to three short key facts of a draft's summary (no long values, never the title again). */
function draftFacts(
  d: Parameters<typeof summarizeDraft>[0] & { readonly title: string },
  t: Parameters<typeof summarizeDraft>[1],
  f: Parameters<typeof summarizeDraft>[2],
): { k: string; v: string }[] {
  try {
    return summarizeDraft(d, t, f)
      .key.map((x) => ({ k: x.k, v: x.v.split('\n')[0] ?? '' }))
      .filter((x) => x.v !== '' && x.v !== d.title && x.v.length <= 80)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** "n kart hazırlanıyor": the turn is still being written; its cards follow the finished answer. */
export function CardsPreparing(props: { readonly n: number }): ReactNode {
  const t = useT().chat.cards;
  return (
    <p
      className="m-0 mt-2 inline-flex items-center gap-1.5 text-[0.78125rem] text-dy-muted"
      data-testid="cards-preparing"
    >
      <DyIcon name="clock" className="dy-breathe size-3.5" />
      {t.preparing({ n: props.n })}
    </p>
  );
}

/** p19-autonomy-aware: a card the platform ran for the person without their click (`result.autoRun`). */
function isAutoRan(c: StripCard): boolean {
  return c.kind === 'draft' && c.d.state === 'confirmed' && c.d.result?.autoRun === true;
}

export function CardStrip(props: {
  readonly cards: readonly StripCard[];
  readonly threadId: string;
  readonly turnOpen: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT().chat.cards;
  const tp = useT().plan;
  const summarize = useSummary();
  const uid = useId();
  // Undecided cards are what the person has to act on, so the cards that still wait for the person come first;
  // otherwise the turn's order is kept (stable sort).
  // p19-autonomy-aware: cards that ran without the person's click fold into one small line.
  const autoRan = props.cards.filter(isAutoRan);
  const cards = props.cards
    .filter((c) => !isAutoRan(c))
    .sort((a, b) => Number(summarize(b).needsAction) - Number(summarize(a).needsAction));
  const many = cards.length > 1;
  const [open, setOpen] = useState<string | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLUListElement>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const panel = useRef<HTMLDivElement>(null);
  const focusPanel = useRef(false);
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useSmoothHeight(outer, inner);
  // A card that left the strip (a reload without it) cannot stay open.
  const openCard = props.cards.find((c) => c.key === open) ?? null;
  const at = Math.min(current, cards.length - 1);

  useEffect(() => {
    if (openCard === null || !focusPanel.current) return;
    focusPanel.current = false;
    // The full card's first control (its confirm / answer button) takes the focus.
    const first = panel.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, [openCard]);

  // The position follows a swipe / wheel scroll of the row (the card whose left edge is nearest the row's).
  useEffect(() => {
    const el = scroller.current;
    if (el === null || !many) return;
    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      const tick = (): void => {
        frame = 0;
        const items = [...el.children] as HTMLElement[];
        const left = el.scrollLeft;
        let best = 0;
        items.forEach((li, i) => {
          if (Math.abs(li.offsetLeft - left) < Math.abs((items[best]?.offsetLeft ?? 0) - left)) best = i;
        });
        setCurrent(best);
      };
      frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : (tick(), 0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }, [many]);

  const show = (i: number, focus: boolean): void => {
    const n = Math.max(0, Math.min(cards.length - 1, i));
    setCurrent(n);
    const card = cards[n];
    const li = scroller.current?.children[n] as HTMLElement | undefined;
    const el = scroller.current;
    if (el !== null && li !== undefined && typeof el.scrollTo === 'function') {
      const reduce =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ left: li.offsetLeft - el.offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
    }
    if (focus && card !== undefined) toggles.current.get(card.key)?.focus();
  };

  const toggle = (c: StripCard, focus: boolean): void => {
    if (open === c.key) {
      setOpen(null);
      return;
    }
    focusPanel.current = focus;
    setOpen(c.key);
  };

  const collapse = (): void => {
    const key = open;
    setOpen(null);
    if (key !== null) toggles.current.get(key)?.focus();
  };
  const autoToggle = useRef<HTMLButtonElement>(null);

  const onRowKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (!many) return;
    const i = cards.findIndex((c) => toggles.current.get(c.key) === document.activeElement);
    if (i < 0) return;
    const to =
      e.key === 'ArrowRight'
        ? i + 1
        : e.key === 'ArrowLeft'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? cards.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    show(to, true);
  };

  return (
    <section
      ref={outer}
      aria-label={t.region({ n: props.cards.length })}
      aria-roledescription={many ? 'carousel' : undefined}
      className="dy-m-height mt-1 min-w-0"
      data-testid="card-strip"
      data-count={props.cards.length}
    >
      <div ref={inner} className="flex min-w-0 flex-col gap-2">
        {autoRan.length === 0 ? null : (
          <div className="flex min-w-0 flex-col gap-1" data-testid="strip-auto">
            <button
              ref={autoToggle}
              type="button"
              aria-expanded={autoOpen}
              onClick={() => {
                setAutoOpen((v) => !v);
              }}
              className="dy-press inline-flex min-h-11 max-w-full min-w-0 items-center gap-1.5 self-start rounded-[9px] px-2 text-[0.8125rem] text-dy-muted sm:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              data-testid="strip-auto-toggle"
            >
              <DyIcon name="check" className="size-3.5 shrink-0 text-dy-teal-ink" />
              <span className="min-w-0 truncate">
                {autoRan.length === 1
                  ? t.autoRanOne({ title: summarize(autoRan[0] as StripCard).title })
                  : t.autoRanMany({ n: autoRan.length })}
              </span>
              <DyIcon
                name="chev"
                className={cx(
                  'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
                  autoOpen ? 'rotate-180' : '',
                )}
              />
            </button>
            {autoOpen ? (
              <ul className="dy-reveal m-0 flex min-w-0 list-none flex-col gap-1 p-0 pl-2">
                {autoRan.map((c) => {
                  const s = summarize(c);
                  const expanded = open === c.key;
                  return (
                    <li
                      key={c.key}
                      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.8125rem]"
                      data-testid="strip-auto-card"
                      data-card-key={c.key}
                    >
                      <span className="shrink-0 text-[0.6875rem] font-bold tracking-[0.04em] text-dy-muted uppercase">
                        {s.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-bold text-dy-ink">{s.title}</span>
                      {s.link === null ? null : (
                        <Link to={s.link.to} className="shrink-0 font-bold text-dy-teal-ink">
                          {s.link.label}
                        </Link>
                      )}
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => {
                          toggle(c, false);
                        }}
                        className="dy-press inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[9px] px-2 font-bold text-dy-teal-ink sm:min-h-8"
                      >
                        {expanded ? t.hideDetails : t.details}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        )}
        {cards.length === 0 ? null : (
          <div className="flex min-w-0 items-center gap-1.5">
            {many ? (
              <button
                type="button"
                aria-label={t.prev}
                disabled={at <= 0}
                onClick={() => {
                  show(at - 1, false);
                }}
                className="dy-press grid size-11 shrink-0 place-items-center rounded-full border border-dy-line bg-dy-card text-dy-muted disabled:opacity-40 sm:size-8"
              >
                <DyIcon name="chev" className="size-4 rotate-90" />
              </button>
            ) : null}
            <ul
              ref={scroller}
              onKeyDown={onRowKey}
              aria-describedby={many ? `${uid}-hint` : undefined}
              className="dy-noscrollbar m-0 flex min-w-0 flex-1 snap-x snap-mandatory list-none gap-2 overflow-x-auto scroll-smooth p-0 motion-reduce:scroll-auto"
            >
              {cards.map((c, i) => {
                const s = summarize(c);
                const expanded = open === c.key;
                return (
                  <li
                    key={c.key}
                    className={cx(
                      'dy-strip-card flex min-w-0 snap-start flex-col gap-1.5 rounded-[12px] border bg-dy-card px-3 py-2 shadow-dy',
                      many ? 'w-[min(20rem,82%)] shrink-0' : 'w-full max-w-[34rem]',
                      expanded ? 'border-dy-teal' : 'border-dy-line',
                    )}
                    data-testid="strip-card"
                    data-card-key={c.key}
                    // p19-chat-stream-motion: cards that arrive together tip up one after another (motion.css).
                    style={{ '--dy-ci': String(Math.min(i, STAGGER_MAX)) } as CSSProperties}
                  >
                    <button
                      ref={(el) => {
                        if (el === null) toggles.current.delete(c.key);
                        else toggles.current.set(c.key, el);
                      }}
                      type="button"
                      tabIndex={many && i !== at ? -1 : 0}
                      aria-expanded={expanded}
                      aria-controls={expanded ? `${uid}-panel` : undefined}
                      aria-label={t.expand({ title: s.title })}
                      onFocus={() => {
                        if (many) setCurrent(i);
                      }}
                      onClick={() => {
                        toggle(c, false);
                      }}
                      className="dy-press -mx-1 flex min-w-0 flex-col items-start gap-0.5 rounded-[8px] px-1 text-left"
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span className="shrink-0 text-[0.6875rem] font-bold tracking-[0.04em] text-dy-muted uppercase">
                          {s.kind}
                        </span>
                        <StateBadge state={s.state} label={s.stateLabel} className="ml-auto" />
                      </span>
                      <span className="line-clamp-2 w-full min-w-0 text-[0.875rem] font-bold [overflow-wrap:anywhere] text-dy-ink">
                        {s.title}
                      </span>
                      {s.facts.length === 0 ? null : (
                        <span
                          className="flex w-full min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[0.75rem] text-dy-muted"
                          data-testid="strip-facts"
                        >
                          {s.facts.map((x) => (
                            <span key={x.k} className="min-w-0 truncate">
                              <span className="text-dy-faint">{x.k}:</span>{' '}
                              <span className="text-dy-ink">{x.v}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                    <span className="flex min-h-8 items-center gap-2">
                      {s.needsAction ? (
                        <button
                          type="button"
                          tabIndex={many && i !== at ? -1 : 0}
                          onClick={() => {
                            if (open !== c.key) toggle(c, true);
                          }}
                          className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-dy-teal px-3 text-[0.8125rem] font-bold text-dy-on-fill sm:min-h-8"
                          data-testid="strip-primary"
                        >
                          {c.kind === 'question'
                            ? t.answer
                            : c.kind === 'proposal'
                              ? tp.proposal.kind
                              : t.review}
                        </button>
                      ) : s.link !== null ? (
                        <Link
                          to={s.link.to}
                          tabIndex={many && i !== at ? -1 : 0}
                          className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-ink no-underline sm:min-h-8"
                        >
                          {s.link.label}
                          <DyIcon name="chev" className="size-3.5 -rotate-90 text-dy-muted" />
                        </Link>
                      ) : s.goTo !== undefined ? (
                        // p20-decisions: a replaced card leads to the current one instead of acting itself.
                        <button
                          type="button"
                          tabIndex={many && i !== at ? -1 : 0}
                          onClick={() => {
                            if (s.goTo !== undefined) goToCard(s.goTo);
                          }}
                          className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-ink sm:min-h-8"
                          data-testid="strip-go-current"
                        >
                          {t.goCurrent}
                          <DyIcon name="chev" className="size-3.5 -rotate-90 text-dy-muted" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={() => {
                          toggle(c, false);
                        }}
                        className="dy-press ml-auto inline-flex min-h-11 items-center gap-1 rounded-[9px] px-2 text-[0.8125rem] font-bold text-dy-teal-ink sm:min-h-8"
                        data-testid="strip-details"
                      >
                        {expanded ? t.hideDetails : t.details}
                        <DyIcon
                          name="chev"
                          className={cx(
                            'size-4 transition-transform motion-reduce:transition-none',
                            expanded ? 'rotate-180' : '',
                          )}
                        />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {many ? (
              <button
                type="button"
                aria-label={t.next}
                disabled={at >= cards.length - 1}
                onClick={() => {
                  show(at + 1, false);
                }}
                className="dy-press grid size-11 shrink-0 place-items-center rounded-full border border-dy-line bg-dy-card text-dy-muted disabled:opacity-40 sm:size-8"
              >
                <DyIcon name="chev" className="size-4 -rotate-90" />
              </button>
            ) : null}
          </div>
        )}
        {many ? (
          <p className="m-0 flex items-center gap-2 text-[0.75rem] text-dy-muted">
            <span aria-label={t.positionLabel({ i: at + 1, n: cards.length })} data-testid="strip-position">
              <span aria-hidden="true">{t.position({ i: at + 1, n: cards.length })}</span>
            </span>
            <span id={`${uid}-hint`} className="sr-only">
              {t.hint}
            </span>
          </p>
        ) : null}
        {openCard === null ? null : (
          <div
            ref={panel}
            id={`${uid}-panel`}
            role="region"
            aria-label={summarize(openCard).title}
            data-testid="strip-panel"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.defaultPrevented) {
                e.preventDefault();
                collapse();
              }
            }}
            className="dy-reveal flex min-w-0 flex-col gap-1.5"
          >
            {openCard.kind === 'draft' ? (
              <DraftItemCard d={openCard.d} threadId={props.threadId} onChanged={props.onChanged} />
            ) : openCard.kind === 'plan' ? (
              <PlanCardBody
                planId={openCard.planId}
                version={openCard.version}
                newer={openCard.newer}
                onGoCurrent={goToCard}
              />
            ) : openCard.kind === 'proposal' ? (
              <PlanProposalBody reason={openCard.reason} answered={openCard.answered} />
            ) : openCard.kind === 'code' ? (
              <CodeCardBody card={openCard.card} />
            ) : (
              <ChatQuestion
                set={openCard.q}
                threadId={props.threadId}
                turnOpen={props.turnOpen}
                disabled={props.disabled}
                onAnswered={props.onChanged}
              />
            )}
            <button
              type="button"
              onClick={collapse}
              className="dy-press inline-flex min-h-11 items-center gap-1.5 self-start rounded-[9px] px-2 text-[0.8125rem] text-dy-muted sm:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              data-testid="strip-collapse"
            >
              <DyIcon name="chev" className="size-3.5 rotate-180" />
              {t.collapse}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
