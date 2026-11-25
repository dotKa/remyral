import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import {
  approvePlan,
  parsePlan,
  type Plan,
  planAction,
  type PlanItem,
  type PlanUserOp,
  requestPlanChanges,
  setPlanAutonomy,
} from '../../api/plans';
import { answerChatQuestion, type QuestionSet } from '../../api/questions';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { ChatIcon } from '../chat/icons';
import { RowMenu, type RowMenuItem } from '../chat/RowMenu';
import { DyIcon, type IconName } from '../icons';
import { motionOff, SmoothHeight, Swap, useArrivals, useFlip } from '../motionKit';
import { presenceProps, usePresence, useReducedMotion } from '../motion';
import { useScrollLock } from '../scrollLock';
import { QuestionCard } from '../questions/QuestionCard';
import { DySwitch } from '../screens/forms';
import { StateBadge } from '../StateBadge';
import { AddItemRow, AddPhaseRow, ItemEditor, MergeView, TitleField, UndoBar } from './PlanEditing';
import { type HistoryPick, PlanHistory } from './PlanHistory';
import {
  ACTIVE,
  announcements,
  applyLocal,
  canEditItem,
  canEditPlan,
  changedItems,
  currentItem,
  editSentence,
  estimateText,
  itemTitle,
  moveOp,
  openDecisions,
  type PhaseView,
  phaseCount,
  phasesOf,
  filterByProject,
  planProjects,
  planChip,
  progressRatio,
  progressText,
  stepMove,
} from './planModel';
import { focusPlanDecisions, putPlan, usePlanFocus } from './planStore';
import { usePlanEditor } from './usePlanEditor';
import { useReorder } from './useReorder';

/** The plan's limits the editor respects before asking (the master checks them too). */
const PLAN_ITEMS_MAX = 60;
const PLAN_PHASE_ITEMS_MAX = 20;

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §3, §4): the plan (roadmap) panel of a Sohbet conversation.
 *
 *  - PlanBody      the plan itself: header (title, state, version, ⋯), progress bar + "5/12 · ~2 sa kaldı", the
 *                  "Plana devam edeyim mi?" line, review actions (Onayla, Değişiklik iste, Vazgeç), decisions (the same
 *                  question rows as the chat's cards), Açık | Tümü, phases with their items, a polite live region.
 *  - PlanMini      one line: progress ring, title, the current item, "n karar bekliyor", a chevron.
 *  - PlanColumn    ≥ 64 rem with the details closed: a right column (`dy-m-column`, like the details panel).
 *  - PlanDock      ≥ 64 rem with the details open: under the details, a mini bar or expanded (≤ 45 % of the column,
 *                  resizable by a grip, remembered).
 *  - PlanBar / PlanDrawer   40–64 rem: a sticky bar under the context strip; a 360 px drawer from the right.
 *  - PlanPill / PlanSheet   < 40 rem: a pill above the composer; a modal bottom sheet (snaps 50 % / 90 %, drag handle,
 *                  Escape / swipe down closes, focus trap of the native dialog, focus back to the pill).
 *
 * Motion only through the tokens (motion.css `dy-plan-*`); nothing moves under reduced motion. Every text of a plan is
 * model / person text: rendered as text.
 */

export interface PlanPanelProps {
  readonly plan: Plan;
  readonly threadId: string;
  /** A shared reader: read only. */
  readonly readOnly: boolean;
  /** The conversation's question rows (plan decisions answered from the panel). */
  readonly questions: readonly QuestionSet[];
  /** After an answer / action: the conversation reloads (its cards follow). */
  readonly onChanged: () => void;
  /** The assistant answers in this conversation now (a change request waits). */
  readonly turnOpen: boolean;
  /** p18-multi-project W3: the conversation's working projects (item editor choices, the project filter). */
  readonly projects?: readonly string[] | undefined;
}

/* ------------------------------------------------------------------ small parts */

const RING = 2 * Math.PI * 9;

export function PlanRing(props: { readonly ratio: number; readonly className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 22 22"
      className={cx('size-[22px] shrink-0 -rotate-90', props.className)}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="9" fill="none" strokeWidth="3" className="stroke-dy-line" />
      <circle
        cx="11"
        cy="11"
        r="9"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="dy-plan-ring stroke-dy-teal"
        strokeDasharray={RING}
        strokeDashoffset={RING * (1 - props.ratio)}
      />
    </svg>
  );
}

function PlanBar(props: { readonly ratio: number; readonly label: string }): ReactNode {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-dy-sunk"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.ratio * 100)}
      data-testid="plan-progress"
    >
      <div
        className="dy-m-meter h-full w-full rounded-full bg-dy-teal"
        style={{ transform: `scaleX(${String(props.ratio)})` }}
      />
    </div>
  );
}

/** The status mark of an item; a change swaps through the short blur (Swap) — check / ring / warn. */
function StatusMark(props: { readonly item: PlanItem; readonly moved: boolean }): ReactNode {
  const s = props.item.status;
  return (
    <Swap k={s} className="mt-0.5 grid size-[18px] shrink-0 place-items-center">
      {s === 'done' ? (
        <span
          className={cx(
            'grid size-[18px] place-items-center rounded-full bg-dy-green text-dy-on-fill',
            props.moved && 'dy-m-check',
          )}
        >
          <DyIcon name="check" className="size-3" />
        </span>
      ) : s === 'in_progress' ? (
        <span className="dy-m-ping grid size-[18px] place-items-center rounded-full border-2 border-dy-teal text-dy-teal">
          <span className="size-1.5 rounded-full bg-current" />
        </span>
      ) : s === 'blocked' ? (
        <span className="grid size-[18px] place-items-center rounded-full bg-dy-amber-soft text-dy-amber-ink">
          <DyIcon name="warn" className="size-3" />
        </span>
      ) : s === 'skipped' ? (
        <span className="grid size-[18px] place-items-center rounded-full border border-dy-line-2 text-dy-faint">
          <span className="h-px w-2 bg-current" />
        </span>
      ) : (
        <span className="size-[14px] rounded-full border-2 border-dy-line-2" />
      )}
    </Swap>
  );
}

/** Where a link chip goes (a card scrolls the chat to it; jobs / runs open their pages). */
function linkTarget(kind: string, id: string): string | null {
  switch (kind) {
    case 'job':
      return `/jobs/${encodeURIComponent(id)}`;
    case 'workflow_run':
      return `/workflows/runs/${encodeURIComponent(id)}`;
    case 'workflow':
      return `/workflows/${encodeURIComponent(id)}`;
    case 'automation':
      return `/automations/${encodeURIComponent(id)}`;
    // p18-multi-project W5: the batch page.
    case 'batch':
      return `/jobs/batches/${encodeURIComponent(id)}`;
    default:
      return null;
  }
}

function scrollToCard(draftId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-card-key="draft:${CSS.escape(draftId)}"]`);
  if (el === null) return;
  const reduce =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof el.scrollIntoView === 'function')
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  el.setAttribute('data-jump', 'true');
  setTimeout(() => {
    el.removeAttribute('data-jump');
  }, 2000);
}

/** p18-plan-autonomy: the plan runs its steps by itself right now (approved autonomous, executing). */
export function autonomousNow(p: Plan): boolean {
  return p.autonomous && (p.state === 'executing' || p.state === 'approved');
}

/** p18-plan-autonomy: the "Otonom" chip next to the plan's state. */
export function AutonomousChip(): ReactNode {
  const t = useT().plan;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full border border-dy-teal/50 bg-dy-teal-soft px-1.5 py-px text-[0.6875rem] font-bold tracking-normal text-dy-teal-ink normal-case"
      title={t.autonomy.chipLabel}
      data-testid="plan-autonomous"
    >
      <DyIcon name="bolt" className="size-3" />
      <span aria-hidden="true">{t.autonomy.chip}</span>
      <span className="sr-only">{t.autonomy.chipLabel}</span>
    </span>
  );
}

const chip =
  'inline-flex max-w-[11rem] items-center gap-1 truncate rounded-full border border-dy-line px-1.5 py-px text-[0.6875rem] font-bold text-dy-muted';

/** What an item row can do while the plan is editable (null: read only — a shared reader, a closed plan). */
interface RowEdit {
  /** Edit mode: the handle and the title as a rename button show. */
  readonly editing: boolean;
  readonly renaming: boolean;
  readonly editorOpen: boolean;
  /** Lifted for a move: by the pointer (it follows it) or the keyboard. */
  readonly lifted: 'pointer' | 'keyboard' | null;
  readonly canRemove: boolean;
  readonly moves: {
    readonly up: PlanUserOp | null;
    readonly down: PlanUserOp | null;
    readonly prev: PlanUserOp | null;
    readonly next: PlanUserOp | null;
  };
  readonly projects: readonly string[];
  /** W4: the plan's items (the item editor's dependency choices). */
  readonly items: readonly PlanItem[];
  readonly hintId: string;
  readonly handle: ReturnType<ReturnType<typeof useReorder>['handleProps']>;
  readonly onRename: () => void;
  readonly onRenamed: (title: string | null) => void;
  readonly onEditor: (open: boolean) => void;
}

function ItemRow(props: {
  readonly item: PlanItem;
  readonly current: boolean;
  readonly changed: boolean;
  readonly arrival: number | undefined;
  readonly edit: RowEdit | null;
  readonly flip: boolean;
  readonly onOp: (ops: PlanUserOp[]) => void;
  /** W4: shown on request of a chat card's plan link (marked for a moment). */
  readonly focused?: boolean | undefined;
}): ReactNode {
  const t = useT().plan;
  const i = props.item;
  const e = props.edit;
  const open = canEditItem(i);
  const op = (o: PlanUserOp) => () => {
    props.onOp([o]);
  };
  const moveItem = (key: string, label: string, icon: IconName, o: PlanUserOp | null): RowMenuItem[] =>
    o === null ? [] : [{ key, label, icon, onSelect: op(o) }];
  const menu: RowMenuItem[] =
    e === null
      ? []
      : [
          ...(i.owner === 'user' && i.status !== 'done' && i.status !== 'skipped'
            ? [
                {
                  key: 'done',
                  label: t.actions.doneMine,
                  icon: 'check' as const,
                  onSelect: op({ op: 'done_mine', key: i.key }),
                },
              ]
            : []),
          ...(open
            ? [
                {
                  key: 'rename',
                  label: t.edit.rename,
                  icon: 'pen' as const,
                  returnFocus: false,
                  onSelect: e.onRename,
                },
                {
                  key: 'edit',
                  label: t.edit.editItem,
                  icon: 'gear' as const,
                  returnFocus: false,
                  onSelect: () => {
                    e.onEditor(true);
                  },
                },
              ]
            : []),
          ...(i.status === 'skipped'
            ? [
                {
                  key: 'unskip',
                  label: t.actions.unskip,
                  icon: 'retry' as const,
                  onSelect: op({ op: 'unskip', key: i.key }),
                },
              ]
            : open && !(i.status === 'in_progress' && i.statusBy === 'derived')
              ? [
                  {
                    key: 'skip',
                    label: t.actions.skip,
                    icon: 'xc' as const,
                    onSelect: op({ op: 'skip', key: i.key }),
                  },
                ]
              : []),
          ...(open
            ? [
                ...moveItem('up', t.edit.moveUp, 'up', e.moves.up),
                ...moveItem('down', t.edit.moveDown, 'down', e.moves.down),
                ...moveItem('prev', t.edit.movePrev, 'upbar', e.moves.prev),
                ...moveItem('next', t.edit.moveNext, 'downbar', e.moves.next),
                ...(i.owner === 'user'
                  ? []
                  : [
                      {
                        key: 'me',
                        label: t.edit.assignMe,
                        icon: 'flag' as const,
                        onSelect: op({ op: 'assign_me', key: i.key }),
                      },
                    ]),
                ...(e.canRemove
                  ? [
                      {
                        key: 'remove',
                        label: t.edit.remove,
                        icon: 'trash' as const,
                        danger: true,
                        onSelect: op({ op: 'remove', key: i.key }),
                      },
                    ]
                  : []),
              ]
            : []),
        ];
  const estimate = estimateText(i.estimate, t);
  return (
    <li
      className={cx(
        'dy-plan-row flex min-w-0 flex-col rounded-[10px] py-1.5 pr-1',
        e?.editing === true ? 'pl-0.5' : 'pl-3',
        props.arrival !== undefined && 'dy-m-line',
      )}
      style={props.arrival === undefined ? undefined : ({ '--dy-i': String(props.arrival) } as CSSProperties)}
      data-status={i.status}
      data-current={props.current ? '' : undefined}
      data-plan-item={i.key}
      data-plan-phase={i.phase}
      data-flip-key={props.flip ? i.key : undefined}
      data-lifted={e?.lifted ?? undefined}
      data-focused={props.focused === true ? '' : undefined}
      tabIndex={props.focused === true ? -1 : undefined}
      data-testid="plan-item"
      aria-current={props.current ? 'step' : undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        {e?.editing === true ? (
          open ? (
            <button
              type="button"
              {...e.handle}
              aria-label={t.edit.handle({ title: i.title })}
              aria-describedby={e.hintId}
              aria-pressed={e.lifted === 'keyboard'}
              data-plan-handle={i.key}
              data-testid="plan-item-handle"
              className="dy-plan-handle grid size-11 shrink-0 sm:-my-1 cursor-grab touch-none place-items-center rounded-[9px] text-dy-faint outline-none focus-visible:ring-2 focus-visible:ring-dy-teal active:cursor-grabbing sm:size-7 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-muted"
            >
              <DyIcon name="grip" className="size-4" />
            </button>
          ) : (
            <span className="size-11 shrink-0 sm:size-7" aria-hidden="true" />
          )
        ) : null}
        {/* In edit mode the title is a 44 px button below sm: the mark sits at its middle. */}
        <span className={cx('shrink-0', e?.editing === true && open ? 'mt-[11px] sm:mt-0' : '')}>
          <StatusMark item={i} moved={props.changed} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {e?.renaming === true ? (
            <TitleField item={i} onDone={e.onRenamed} />
          ) : (
            <span className="dy-plan-title text-[0.84375rem] leading-snug font-bold [overflow-wrap:anywhere]">
              {e?.editing === true && open ? (
                <button
                  type="button"
                  onClick={e.onRename}
                  aria-label={t.edit.titleButton({ title: i.title })}
                  className="dy-press -mx-1 inline-flex max-w-full items-center rounded-[6px] px-1 text-left [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
                  data-testid="plan-item-title"
                >
                  <Swap k={`${i.status}:${itemTitle(i)}`}>{itemTitle(i)}</Swap>
                </button>
              ) : (
                <Swap k={`${i.status}:${itemTitle(i)}`}>{itemTitle(i)}</Swap>
              )}
              <span className="sr-only">{` — ${t.status[i.status]}`}</span>
            </span>
          )}
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span className={chip} data-owner={i.owner}>
              <Swap k={i.owner}>{t.owners[i.owner]}</Swap>
            </span>
            {i.project === null ? null : <span className={chip}>{i.project}</span>}
            {estimate === null ? null : (
              <span className={cx(chip, 'font-dy-mono')} data-testid="plan-item-estimate">
                <DyIcon name="clock" className="size-3" />
                {estimate}
              </span>
            )}
            {i.decisionOpen ? (
              <span className={cx(chip, 'border-dy-amber/50 bg-dy-amber-soft text-dy-amber-ink')}>
                {t.decisions.needed}
              </span>
            ) : null}
            {/* p18-plan-autonomy: a step the plan could not run by itself waits for the person's card. */}
            {i.awaitsUser && i.status !== 'done' && i.status !== 'skipped' ? (
              <span
                className={cx(chip, 'border-dy-amber/50 bg-dy-amber-soft text-dy-amber-ink')}
                data-testid="plan-item-awaits"
              >
                {t.autonomy.awaitsUser}
              </span>
            ) : null}
            {i.failures > 0 && i.status !== 'done' ? (
              <span className={cx(chip, 'text-dy-red-ink')} data-testid="plan-item-failures">
                {t.autonomy.failures({ n: i.failures })}
              </span>
            ) : null}
            {i.links.map((l) => {
              const label = l.label ?? t.links[l.kind];
              const to = linkTarget(l.kind, l.id);
              if (l.kind === 'draft')
                return (
                  <button
                    key={`${l.kind}:${l.id}`}
                    type="button"
                    className={cx(chip, 'dy-press text-dy-teal-ink')}
                    onClick={() => {
                      scrollToCard(l.id);
                    }}
                  >
                    {t.links.draft}
                  </button>
                );
              if (to !== null)
                return (
                  <Link
                    key={`${l.kind}:${l.id}`}
                    to={to}
                    className={cx(chip, 'text-dy-teal-ink no-underline')}
                  >
                    {l.label === null ? t.links[l.kind] : label}
                    <DyIcon name="chev" className="size-3 -rotate-90" />
                  </Link>
                );
              if (l.kind === 'url' || l.kind === 'pr')
                return (
                  <a
                    key={`${l.kind}:${l.id}`}
                    href={l.id}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={cx(chip, 'text-dy-teal-ink no-underline')}
                  >
                    {label}
                  </a>
                );
              return (
                <span key={`${l.kind}:${l.id}`} className={chip}>
                  {label}
                </span>
              );
            })}
          </span>
          {i.note !== null && (i.status === 'blocked' || i.status === 'skipped') ? (
            <span
              className="text-[0.75rem] text-dy-amber-ink [overflow-wrap:anywhere]"
              data-testid="plan-item-note"
            >
              {i.note}
            </span>
          ) : null}
        </div>
        {menu.length === 0 ? null : <RowMenu label={t.actions.itemMenu({ title: i.title })} items={menu} />}
      </div>
      {e?.editorOpen === true ? (
        <ItemEditor
          item={i}
          projects={e.projects}
          items={e.items}
          onSave={(ops) => {
            e.onEditor(false);
            if (ops.length > 0) props.onOp(ops);
          }}
          onClose={() => {
            e.onEditor(false);
          }}
        />
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ live region */

/** Batches the plan's changes into one polite announcement per second ("Madde 4/12 tamamlandı …"). */
function useLiveAnnouncer(plan: Plan): string {
  const t = useT().plan;
  const prev = useRef<Plan | null>(null);
  const queue = useRef<string[]>([]);
  const [said, setSaid] = useState('');
  useEffect(() => {
    const lines = announcements(prev.current, plan, t);
    prev.current = plan;
    if (lines.length === 0) return;
    queue.current.push(...lines);
    const timer = window.setTimeout(() => {
      const text = queue.current.join(' ');
      queue.current = [];
      if (text !== '') setSaid(text);
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [plan, t]);
  return said;
}

/** Statuses that changed since the previous snapshot (for their one-time motion), kept for ARRIVAL-length. */
function useChanged(plan: Plan): ReadonlyMap<string, PlanItem['status']> {
  const prev = useRef<Plan | null>(null);
  const [changed, setChanged] = useState<ReadonlyMap<string, PlanItem['status']>>(new Map());
  useEffect(() => {
    const c = changedItems(prev.current, plan);
    prev.current = plan;
    if (c.size === 0) return;
    setChanged(c);
    const timer = window.setTimeout(() => {
      setChanged(new Map());
    }, 1500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [plan]);
  return changed;
}

/** The current item scrolls into view unless the person scrolled the panel in the last 5 s. */
function useFollowCurrent(scroller: RefObject<HTMLElement | null>, key: string | null): void {
  const touched = useRef(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const mark = (): void => {
      touched.current = Date.now();
    };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('keydown', mark);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('keydown', mark);
    };
  }, [scroller]);
  useEffect(() => {
    if (key === null || Date.now() - touched.current < 5_000) return;
    const row = scroller.current?.querySelector<HTMLElement>(`[data-plan-item="${CSS.escape(key)}"]`);
    if (row === null || row === undefined || typeof row.scrollIntoView !== 'function') return;
    row.scrollIntoView({ block: 'nearest', behavior: reduce || motionOff(row) ? 'auto' : 'smooth' });
  }, [key, scroller, reduce]);
}

/* ------------------------------------------------------------------ actions */

export function usePlanActions(
  props: PlanPanelProps,
  /** A 409 with the current plan: the panel shows its merge view (from the plan the person acted on). */
  onConflict?: (base: Plan) => void,
): {
  readonly busy: boolean;
  readonly error: string | null;
  readonly conflict: boolean;
  readonly run: (fn: () => Promise<unknown>) => void;
  readonly clear: () => void;
} {
  const sayError = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const { threadId, onChanged } = props;
  const seen = useRef(props.plan);
  seen.current = props.plan;
  const run = useCallback(
    (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setConflict(false);
      const base = seen.current;
      fn().then(
        (out) => {
          setBusy(false);
          const p = parsePlan(out);
          if (p !== null) putPlan(threadId, p);
          onChanged();
        },
        (err: unknown) => {
          setBusy(false);
          const cur = err instanceof ApiError ? parsePlan(err.details.plan) : null;
          if (cur !== null) {
            putPlan(threadId, cur);
            setConflict(true);
            onConflict?.(base);
          } else setError(sayError(err));
        },
      );
    },
    [threadId, onChanged, sayError, onConflict],
  );
  return {
    busy,
    error,
    conflict,
    run,
    clear: () => {
      setError(null);
      setConflict(false);
    },
  };
}

export function ReviewActions(
  props: PlanPanelProps & {
    readonly actions: ReturnType<typeof usePlanActions>;
    /** The chat's plan card: opens the plan panel before "Kalan N kararı göster" takes the person there. */
    readonly openPlan?: (() => void) | undefined;
  },
): ReactNode {
  const t = useT().plan;
  const p = props.plan;
  const a = props.actions;
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  // p18-plan-autonomy: "Otonom yürüt" (on by default) — approving lets the plan's steps run without a card each.
  const [autonomous, setAutonomous] = useState(true);
  const noteId = useId();
  const left = openDecisions(p);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (asking) field.current?.focus();
  }, [asking]);
  if (props.readOnly || (p.state !== 'in_review' && p.state !== 'drafting')) return null;
  return (
    <SmoothHeight>
      {asking ? (
        <form
          className="dy-reveal grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim() === '') return;
            a.run(async () => {
              await requestPlanChanges(p.id, p.version, note.trim());
              setAsking(false);
              setNote('');
              return null;
            });
          }}
        >
          <label htmlFor={noteId} className="text-[0.8125rem] font-bold">
            {t.actions.changeNote}
          </label>
          <textarea
            ref={field}
            id={noteId}
            rows={3}
            value={note}
            maxLength={2000}
            placeholder={t.actions.changePlaceholder}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setAsking(false);
              }
            }}
            className="min-h-11 w-full resize-y rounded-[10px] border border-dy-line-2 bg-dy-card px-3 py-2 text-base text-dy-ink outline-none focus-visible:border-dy-teal sm:text-[0.875rem]"
          />
          <span className="flex flex-wrap gap-1.5">
            <button
              type="submit"
              disabled={a.busy || note.trim() === '' || props.turnOpen}
              className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-dy-ink px-3 text-[0.8125rem] font-bold text-dy-card disabled:opacity-50 sm:min-h-8"
            >
              <DyIcon name="send" className="size-3.5" />
              {a.busy ? t.actions.sending : t.actions.send}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
              }}
              className="dy-press inline-flex min-h-11 items-center rounded-[9px] px-2.5 text-[0.8125rem] text-dy-muted sm:min-h-8"
            >
              {t.actions.back}
            </button>
          </span>
        </form>
      ) : (
        <div className="grid gap-2" data-testid="plan-review">
          <div className="rounded-[10px] border border-dy-line bg-dy-sunk px-2.5 py-1.5">
            <DySwitch
              label={t.autonomy.toggle}
              hint={t.autonomy.toggleHint}
              checked={autonomous}
              disabled={a.busy}
              onChange={setAutonomous}
              testId="plan-autonomous-toggle"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={a.busy || left > 0}
              aria-describedby={left > 0 ? `${noteId}-left` : undefined}
              onClick={() => {
                a.run(() => approvePlan(p.id, p.version, autonomous));
              }}
              className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-dy-teal px-3 text-[0.8125rem] font-bold text-dy-on-fill disabled:opacity-50 sm:min-h-8"
              data-testid="plan-approve"
            >
              <DyIcon name="check" className="size-3.5" />
              {left > 0 ? t.actions.approveLeft({ n: left }) : t.actions.approve}
            </button>
            {left > 0 ? (
              <span id={`${noteId}-left`} className="sr-only">
                {t.decisions.waiting({ n: left })}
              </span>
            ) : null}
            {/* p20-quick: the disabled Onayla leads to what keeps it disabled. */}
            {left > 0 ? (
              <button
                type="button"
                onClick={() => {
                  props.openPlan?.();
                  focusPlanDecisions(props.threadId);
                }}
                className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] border border-dy-amber/60 bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-amber-ink sm:min-h-8"
                data-testid="plan-show-left"
              >
                <DyIcon name="warn" className="size-3.5" />
                {t.actions.showLeft({ n: left })}
              </button>
            ) : null}
            <button
              type="button"
              disabled={a.busy}
              onClick={() => {
                a.clear();
                setAsking(true);
              }}
              className="dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.8125rem] font-bold disabled:opacity-50 sm:min-h-8"
              data-testid="plan-request-changes"
            >
              <DyIcon name="pen" className="size-3.5" />
              {t.actions.requestChanges}
            </button>
          </div>
        </div>
      )}
    </SmoothHeight>
  );
}

/* ------------------------------------------------------------------ the plan */

export function PlanBody(
  props: PlanPanelProps & {
    /** The scrolling element of the list (auto-scroll to the current item). */
    readonly scrollerRef: RefObject<HTMLElement | null>;
    /** Header controls of the container (close, collapse). */
    readonly controls?: ReactNode;
    readonly headingId?: string | undefined;
  },
): ReactNode {
  const t = useT().plan;
  const editor = usePlanEditor(props.plan, props.threadId);
  const actions = usePlanActions(props, editor.showConflict);
  // The plan as shown: the person's edits on their way already in it.
  const base = editor.plan;
  const canEdit = canEditPlan(base, props.readOnly);
  const [editMode, setEditMode] = useState(false);
  const editing = editMode && canEdit;
  const [view, setView] = useState<{ kind: 'plan' } | { kind: 'history'; pick?: HistoryPick }>({
    kind: 'plan',
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const changed = useChanged(props.plan);
  const recent = new Set([...changed.entries()].filter(([, s]) => s === 'done').map(([k]) => k));
  const list = useRef<HTMLDivElement>(null);
  const decisionsRef = useRef<HTMLElement>(null);
  // W4: a chat card's "Plan maddesi" link — show that item (unfold, scroll, mark, focus).
  const focusReq = usePlanFocus(props.threadId);
  const [focused, setFocused] = useState<string | null>(null);
  const focusN = focusReq?.n ?? 0;
  const shownRef = useRef<readonly PhaseView[]>([]);
  const reorder = useReorder({
    plan: base,
    shown: shownRef,
    list,
    scroller: props.scrollerRef,
    onDrop: (op) => {
      editor.edit([op]);
    },
    say: editor.say,
  });
  const target = reorder.target;
  // While an item is moved the list shows it at its new place (phases it empties stay as drop targets).
  const p =
    target === null
      ? base
      : applyLocal(base, [moveOp(base, target.key, target.phase, target.before)], { keepPhases: true });
  // p18-multi-project W3: the project filter (not while editing: moves need every row).
  const [projectFilter, setProjectFilter] = useState<string | null | undefined>(undefined);
  const phases = editing
    ? phasesOf(p, filter, recent, editing)
    : filterByProject(phasesOf(p, filter, recent, editing), projectFilter);
  shownRef.current = phases;
  useFlip(list);
  const cur = currentItem(p);
  const live = useLiveAnnouncer(props.plan);
  useFollowCurrent(props.scrollerRef, target === null ? (cur?.key ?? null) : null);
  const arrivals = useArrivals(p.items.map((i) => i.key));
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    if (focusReq === null) return;
    const key = focusReq.key;
    if (key === null) {
      // p20-quick: "Kalan N kararı göster" — the open decisions, the first one's first answer control focused.
      setView({ kind: 'plan' });
      const raf = requestAnimationFrame(() => {
        const box = decisionsRef.current;
        if (box === null) return;
        if (typeof box.scrollIntoView === 'function')
          box.scrollIntoView({ block: 'start', behavior: motionOff(box) ? 'auto' : 'smooth' });
        const first =
          box.querySelector<HTMLElement>(
            'input:not([disabled]), textarea:not([disabled]), button:not([disabled])',
          ) ?? box.querySelector<HTMLElement>('[data-plan-decision]');
        first?.focus({ preventScroll: true });
      });
      return () => {
        cancelAnimationFrame(raf);
      };
    }
    const item = base.items.find((i) => i.key === key);
    if (item === undefined) return;
    if (item.status === 'done' || item.status === 'skipped') setFilter('all');
    setFolded((prev) => {
      if (!prev.has(item.phase)) return prev;
      const next = new Set(prev);
      next.delete(item.phase);
      return next;
    });
    setView({ kind: 'plan' });
    setFocused(key);
    const raf = requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>(`[data-plan-item="${CSS.escape(key)}"]`);
      if (row === null || row === undefined) return;
      if (typeof row.scrollIntoView === 'function')
        row.scrollIntoView({ block: 'nearest', behavior: motionOff(row) ? 'auto' : 'smooth' });
      row.focus({ preventScroll: true });
    });
    const timer = window.setTimeout(() => {
      setFocused(null);
    }, 2_400);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // Only a new request (its number) runs this.
  }, [focusN]);
  const pending = props.questions.filter((q) => q.planId === p.id && q.state === 'pending');
  const decisionsOpen = openDecisions(p);
  const hintId = `${props.headingId ?? 'plan'}-handle-hint`;
  const projects = planProjects(base, props.projects ?? []);
  const projectChoices = [...new Set(base.items.map((i) => i.project))];
  const tm = useT().multiProject.plan;
  const full = base.items.length >= PLAN_ITEMS_MAX;
  const edit = (ops: PlanUserOp[]): void => {
    actions.clear();
    editor.edit(ops);
  };
  const historyItems: RowMenuItem[] = [
    {
      key: 'history',
      label: t.history.open,
      icon: 'history',
      returnFocus: false,
      onSelect: () => {
        setView({ kind: 'history' });
      },
    },
    ...(base.version > 1
      ? [
          {
            key: 'changes',
            label: t.history.showChanges,
            icon: 'branch' as const,
            returnFocus: false,
            onSelect: () => {
              setView({ kind: 'history', pick: { from: base.version - 1, to: base.version } });
            },
          },
        ]
      : []),
  ];
  const menu: RowMenuItem[] = props.readOnly
    ? historyItems
    : [
        ...(p.state === 'executing'
          ? [
              {
                key: 'pause',
                label: t.actions.pause,
                icon: 'pause' as const,
                onSelect: () => {
                  actions.run(() => planAction(p.id, 'pause'));
                },
              },
            ]
          : []),
        ...(p.state === 'paused' || (p.state === 'executing' && p.stalled !== null)
          ? [
              {
                key: 'resume',
                label: t.actions.resume,
                icon: 'retry' as const,
                onSelect: () => {
                  actions.run(() => planAction(p.id, 'resume'));
                },
              },
            ]
          : []),
        // p18-plan-autonomy: after approval the owner turns autonomous execution off / on.
        ...(p.state === 'executing' || p.state === 'paused' || p.state === 'approved'
          ? [
              {
                key: 'autonomy',
                label: p.autonomous ? t.autonomy.turnOff : t.autonomy.turnOn,
                icon: 'bolt' as const,
                onSelect: () => {
                  actions.run(() => setPlanAutonomy(p.id, !p.autonomous));
                },
              },
            ]
          : []),
        ...historyItems,
        ...(ACTIVE.has(p.state)
          ? [
              {
                key: 'cancel',
                label: t.actions.cancelPlan,
                icon: 'xc' as const,
                danger: true,
                confirm: { question: t.actions.cancelQuestion, yes: t.actions.cancelYes, no: t.actions.back },
                onSelect: () => {
                  actions.run(() => planAction(p.id, 'cancel'));
                },
              },
            ]
          : []),
      ];
  /** The menu's move operations of an item among the rows shown (null where it cannot go). */
  const movesOf = (key: string): RowEdit['moves'] => {
    const up = stepMove(phases, key, -1);
    const down = stepMove(phases, key, 1);
    const pi = phases.findIndex((ph) => ph.items.some((i) => i.key === key));
    const prev = phases[pi - 1];
    const next = phases[pi + 1];
    const asOp = (m: { phase: number; before: string | null } | null): PlanUserOp | null =>
      m === null ? null : moveOp(base, key, m.phase, m.before);
    const ph = phases[pi];
    const at = ph?.items.findIndex((i) => i.key === key) ?? -1;
    return {
      // Over a phase's edge: the phase moves are their own entries.
      up: at > 0 ? asOp(up) : null,
      down: ph !== undefined && at < ph.items.length - 1 ? asOp(down) : null,
      prev: prev === undefined ? null : moveOp(base, key, prev.index, null),
      next: next === undefined ? null : moveOp(base, key, next.index, next.items[0]?.key ?? null),
    };
  };
  const rowEdit = (i: PlanItem): RowEdit | null =>
    !canEdit
      ? null
      : {
          editing,
          renaming: renaming === i.key,
          editorOpen: editorKey === i.key,
          lifted: target?.key === i.key ? target.mode : null,
          canRemove: base.items.length > 1,
          moves: movesOf(i.key),
          projects,
          items: base.items,
          hintId,
          handle: reorder.handleProps(i.key),
          onRename: () => {
            setEditorKey(null);
            setRenaming(i.key);
          },
          onRenamed: (title) => {
            setRenaming(null);
            if (title !== null) edit([{ op: 'rename', key: i.key, title }]);
            requestAnimationFrame(() => {
              list.current
                ?.querySelector<HTMLElement>(
                  `[data-plan-item="${CSS.escape(i.key)}"] :is([data-testid="plan-item-title"], [aria-haspopup])`,
                )
                ?.focus();
            });
          },
          onEditor: (open) => {
            setRenaming(null);
            setEditorKey(open ? i.key : null);
          },
        };
  const yours =
    editor.conflict?.ops?.map((o) => editSentence(o, editor.conflict?.base ?? base, t, editor.removed)) ?? [];
  const header = (
    <header className="flex min-w-0 flex-col gap-1.5">
      {/* p18-plan-header: row 1 = meta (PLAN · v2 · state) and the actions, row 2 = the title at full width (at
          320–352 px the title no longer wraps into a narrow column beside Düzenle / ⋯ / ×). */}
      <div className="flex min-w-0 flex-nowrap items-center gap-1" data-testid="plan-header-top">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[0.6875rem] font-bold tracking-[0.04em] text-dy-muted uppercase">
          {t.region}
          <span className="font-dy-mono tracking-normal normal-case">
            <Swap k={String(p.version)}>{t.version({ v: p.version })}</Swap>
          </span>
          <StateBadge
            state={planChip(p.state)}
            label={t.states[p.state]}
            className="normal-case tracking-normal"
          />
          {autonomousNow(p) ? <AutonomousChip /> : null}
        </span>
        <div className="flex shrink-0 flex-nowrap items-center gap-1" data-testid="plan-header-actions">
          {canEdit && view.kind === 'plan' ? (
            <button
              type="button"
              aria-pressed={editing}
              aria-label={editing ? t.edit.finishLabel : t.edit.startLabel}
              onClick={() => {
                setEditMode(!editing);
                setRenaming(null);
                setEditorKey(null);
              }}
              // A 44 px target below sm around a compact pill (the header stays one line high).
              className="group dy-press inline-flex min-h-11 shrink-0 items-center sm:min-h-8"
              data-testid="plan-edit-toggle"
            >
              <span
                className={cx(
                  'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[0.75rem] font-bold',
                  editing
                    ? 'border-dy-teal bg-dy-teal text-dy-on-fill'
                    : 'border-dy-line-2 bg-dy-card text-dy-ink',
                )}
              >
                <DyIcon name={editing ? 'check' : 'pen'} className="size-3.5" />
                <Swap k={editing ? 'on' : 'off'}>{editing ? t.edit.finish : t.edit.start}</Swap>
              </span>
            </button>
          ) : null}
          {menu.length === 0 ? null : <RowMenu label={t.actions.menu} items={menu} />}
          {props.controls}
        </div>
      </div>
      <h2
        id={props.headingId}
        className="m-0 text-[0.9375rem] leading-snug font-extrabold [overflow-wrap:anywhere]"
      >
        {p.title}
      </h2>
      <PlanBar
        ratio={progressRatio(p)}
        label={t.progressLabel({ done: p.progress.done, total: p.progress.total })}
      />
      <p className="m-0 flex items-center justify-between gap-2 text-[0.75rem] text-dy-muted">
        <Swap k={progressText(p, t)} className="font-dy-mono">
          {progressText(p, t)}
        </Swap>
        {editor.saving ? (
          <span className="dy-reveal" data-testid="plan-saving">
            {t.edit.saving}
          </span>
        ) : p.lastChange === null ? null : (
          <span>
            {/* The version is already in the meta line above when the last change made this version. */}
            {p.lastChange.version === p.version
              ? t.changes({
                  n: p.lastChange.added + p.lastChange.removed + p.lastChange.changed + p.lastChange.moved,
                })
              : t.lastChange({
                  v: p.lastChange.version,
                  n: p.lastChange.added + p.lastChange.removed + p.lastChange.changed + p.lastChange.moved,
                })}
          </span>
        )}
      </p>
      {props.readOnly ? <p className="m-0 text-[0.75rem] text-dy-muted">{t.panel.readOnly}</p> : null}
    </header>
  );
  if (view.kind === 'history')
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="plan-body" data-plan-state={p.state}>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setView({ kind: 'plan' });
            }}
            className="dy-press inline-flex min-h-11 items-center gap-1 rounded-[9px] px-1.5 text-[0.8125rem] font-bold text-dy-teal-ink sm:min-h-8"
            data-testid="plan-history-back"
          >
            <DyIcon name="chev" className="size-3.5 rotate-90" />
            {t.history.back}
          </button>
          <h2 id={props.headingId} className="m-0 min-w-0 flex-1 truncate text-[0.9375rem] font-extrabold">
            {t.history.title}
          </h2>
          {props.controls}
        </div>
        <p className="m-0 truncate text-[0.8125rem] text-dy-muted">{p.title}</p>
        <div key="history" className="dy-reveal">
          <PlanHistory plan={p} threadId={props.threadId} initial={view.pick} />
        </div>
      </div>
    );
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="plan-body"
      data-plan-state={p.state}
      data-editing={editing ? '' : undefined}
    >
      {header}
      {p.state === 'executing' && p.stalled !== null && !props.readOnly ? (
        <div
          className="dy-reveal grid gap-1.5 rounded-[12px] border border-dy-amber/40 bg-dy-amber-soft px-3 py-2"
          data-testid="plan-stalled"
        >
          <p className="m-0 text-[0.8125rem] font-bold">{t.stalled.title}</p>
          <p className="m-0 text-[0.8125rem]">
            {(t.stalled.reasons as Readonly<Record<string, string>>)[p.stalled] ?? t.stalled.reasons.default}
          </p>
          <button
            type="button"
            disabled={actions.busy}
            onClick={() => {
              actions.run(() => planAction(p.id, 'resume'));
            }}
            className="dy-press inline-flex min-h-11 items-center gap-1.5 self-start rounded-[9px] bg-dy-ink px-3 text-[0.8125rem] font-bold text-dy-card sm:min-h-8"
          >
            {t.stalled.resume}
          </button>
        </div>
      ) : null}
      <ReviewActions {...props} actions={actions} />
      {editor.conflict === null ? null : (
        <MergeView
          key={`${String(editor.conflict.base.rev)}:${String(editor.conflict.ops?.length ?? 0)}`}
          conflict={editor.conflict}
          current={props.plan}
          yours={yours}
          onReapply={editor.reapply}
          onDiscard={() => {
            editor.discard();
            actions.clear();
          }}
        />
      )}
      {actions.error === null && editor.error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink" data-testid="plan-error">
          {editor.error ?? actions.error}
        </p>
      )}
      {decisionsOpen === 0 ? null : (
        <section
          ref={decisionsRef}
          aria-labelledby={`${props.headingId ?? 'plan'}-decisions`}
          className="grid scroll-mt-2 gap-2"
          data-testid="plan-decisions"
        >
          <h3
            id={`${props.headingId ?? 'plan'}-decisions`}
            className="m-0 flex items-center gap-1.5 text-[0.8125rem] font-extrabold text-dy-amber-ink"
          >
            <DyIcon name="warn" className="size-3.5" />
            <Swap k={String(decisionsOpen)}>{t.decisions.title({ n: decisionsOpen })}</Swap>
          </h3>
          {pending.length > 0
            ? pending.map((q) => (
                <SmoothHeight key={q.id}>
                  <QuestionCard
                    set={q}
                    from="assistant"
                    compact
                    heading={t.decisions.heading}
                    canAnswer={!props.readOnly}
                    onAnswer={async (answers) => {
                      await answerChatQuestion(props.threadId, q.id, answers);
                      props.onChanged();
                    }}
                  />
                </SmoothHeight>
              ))
            : p.decisions
                .filter((d) => d.state === 'pending')
                .map((d) => (
                  <p
                    key={d.id}
                    tabIndex={-1}
                    data-plan-decision={d.id}
                    className="m-0 rounded-[10px] border border-dy-amber/40 px-3 py-2 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-dy-amber"
                  >
                    {d.prompt}
                    {d.recommended === null ? null : (
                      <span className="ml-1 text-dy-muted">{`(${t.decisions.recommended}: ${d.recommended})`}</span>
                    )}
                  </p>
                ))}
        </section>
      )}
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label={t.filter.label} className="inline-flex rounded-full bg-dy-sunk p-0.5">
          {(['open', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
              }}
              className={cx(
                'dy-press min-h-9 rounded-full px-3 text-[0.75rem] font-bold sm:min-h-7',
                filter === f ? 'bg-dy-card text-dy-ink shadow-dy' : 'text-dy-muted',
              )}
            >
              {t.filter[f]}
            </button>
          ))}
        </div>
        {/* p18-multi-project W3: items of one project (when the plan's items name more than one). */}
        {projectChoices.length > 1 && !editing ? (
          <label className="inline-flex min-w-0 items-center gap-1.5 text-[0.75rem] font-bold text-dy-muted">
            <span className="sr-only sm:not-sr-only">{tm.filter}</span>
            <select
              aria-label={tm.filter}
              data-testid="plan-project-filter"
              value={projectFilter === undefined ? '*' : projectFilter === null ? '' : projectFilter}
              onChange={(e) => {
                const v = e.target.value;
                setProjectFilter(v === '*' ? undefined : v === '' ? null : v);
              }}
              className="min-h-9 max-w-[10rem] rounded-full border border-dy-line-2 bg-dy-card px-2 text-[0.75rem] text-dy-ink sm:min-h-7"
            >
              <option value="*">{tm.all}</option>
              {projectChoices.map((pr) => (
                <option key={pr ?? ''} value={pr ?? ''}>
                  {pr ?? tm.none}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {editing ? (
        <p id={hintId} className="sr-only">
          {t.edit.handleHint}
        </p>
      ) : null}
      <SmoothHeight>
        <div ref={list} className="relative flex flex-col gap-3" data-testid="plan-list">
          {phases.map((ph) => {
            const open = !folded.has(ph.index);
            const all = base.items.filter((i) => i.phase === ph.index);
            return (
              <section
                key={`${String(ph.index)}:${ph.title}`}
                aria-labelledby={`${props.headingId ?? 'plan'}-ph-${String(ph.index)}`}
                className="grid gap-1"
              >
                <h3 className="m-0">
                  <button
                    type="button"
                    id={`${props.headingId ?? 'plan'}-ph-${String(ph.index)}`}
                    aria-expanded={open}
                    onClick={() => {
                      setFolded((prev) => {
                        const next = new Set(prev);
                        if (next.has(ph.index)) next.delete(ph.index);
                        else next.add(ph.index);
                        return next;
                      });
                    }}
                    className="dy-press flex min-h-9 w-full items-center gap-1.5 rounded-[8px] px-1 text-left text-[0.8125rem] font-extrabold"
                  >
                    <DyIcon
                      name="chev"
                      className={cx('dy-plan-chev size-3.5 text-dy-muted', !open && '-rotate-90')}
                    />
                    <span className="min-w-0 flex-1 truncate">{ph.title}</span>
                    <span className="font-dy-mono text-[0.75rem] font-bold text-dy-muted">
                      {t.progress({ done: ph.done, total: ph.total })}
                    </span>
                  </button>
                </h3>
                {open ? (
                  <ul role="list" className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {ph.items.map((i) => (
                      <ItemRow
                        key={i.key}
                        item={i}
                        current={cur?.key === i.key}
                        changed={changed.has(i.key)}
                        arrival={arrivals.get(i.key)}
                        edit={rowEdit(i)}
                        flip={!(target?.key === i.key && target.mode === 'pointer')}
                        onOp={edit}
                        focused={focused === i.key}
                      />
                    ))}
                    {ph.folded === 0 ? null : (
                      <li className="pl-3">
                        <button
                          type="button"
                          onClick={() => {
                            setFilter('all');
                          }}
                          className="dy-press min-h-9 rounded-[8px] px-1 text-[0.75rem] font-bold text-dy-muted sm:min-h-7"
                          data-testid="plan-folded"
                        >
                          {t.folded({ n: ph.folded })}
                        </button>
                      </li>
                    )}
                    {editing ? (
                      <AddItemRow
                        phase={ph.index}
                        phaseTitle={ph.title}
                        after={all[all.length - 1]?.key ?? null}
                        full={full || all.length >= PLAN_PHASE_ITEMS_MAX}
                        onAdd={(op) => {
                          edit([op]);
                        }}
                      />
                    ) : null}
                  </ul>
                ) : null}
              </section>
            );
          })}
          {/* W4: a new phase from the panel (its name and first item). */}
          {editing ? (
            <AddPhaseRow
              phase={phaseCount(base)}
              full={full}
              onAdd={(op) => {
                edit([op]);
              }}
            />
          ) : null}
        </div>
      </SmoothHeight>
      {editor.undo === null ? null : (
        <UndoBar undo={editor.undo} onUndo={editor.undoNow} onExpire={editor.dismissUndo} />
      )}
      <p className="sr-only" role="status" aria-live="polite" data-testid="plan-live">
        {live}
      </p>
      <p className="sr-only" role="status" aria-live="polite" data-testid="plan-edit-live">
        {editor.said}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ mini line */

export function PlanMini(props: {
  readonly plan: Plan;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly controls?: string | undefined;
  readonly toggleRef?: RefObject<HTMLButtonElement | null> | undefined;
  readonly variant: 'dock' | 'bar' | 'pill';
}): ReactNode {
  const t = useT().plan;
  const p = props.plan;
  const cur = currentItem(p);
  const n = openDecisions(p);
  return (
    <button
      ref={props.toggleRef}
      type="button"
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-label={`${props.expanded ? t.panel.collapse : t.panel.expand}: ${p.title}`}
      onClick={props.onToggle}
      // The pill sits in the composer's sticky dock: a mouse press must not move the focus there (the dock would
      // re-lay out under the pointer and the click land elsewhere); the keyboard still reaches it.
      onMouseDown={
        props.variant === 'pill'
          ? (e) => {
              e.preventDefault();
            }
          : undefined
      }
      data-testid={`plan-mini-${props.variant}`}
      className={cx(
        'dy-press flex min-h-11 w-full min-w-0 items-center gap-2 text-left',
        props.variant === 'pill'
          ? 'rounded-full border border-dy-line-2 bg-dy-card px-3 py-1.5 shadow-dy-pop'
          : props.variant === 'bar'
            ? 'rounded-[12px] border border-dy-line bg-dy-card px-3 py-1.5 shadow-dy'
            : 'px-4 py-2',
      )}
    >
      <PlanRing ratio={progressRatio(p)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5 text-[0.8125rem] font-extrabold">
          <span className="truncate">{p.title}</span>
          <span className="shrink-0 font-dy-mono text-[0.75rem] font-bold text-dy-muted">
            {t.progress({ done: p.progress.done, total: p.progress.total })}
          </span>
        </span>
        <span className="truncate text-[0.75rem] text-dy-muted">
          <Swap k={cur?.key ?? p.state}>{cur === null ? t.states[p.state] : itemTitle(cur)}</Swap>
        </span>
      </span>
      {n === 0 ? null : (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[0.75rem] font-bold text-dy-amber-ink"
          data-testid="plan-mini-decisions"
        >
          <span className="size-2 rounded-full bg-dy-amber" aria-hidden="true" />
          <span className="hidden sm:inline">{t.decisions.waiting({ n })}</span>
          <span className="sm:hidden">{String(n)}</span>
        </span>
      )}
      <DyIcon
        name="chev"
        className={cx('dy-plan-chev size-4 shrink-0 text-dy-muted', props.expanded ? '' : 'rotate-180')}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ containers */

const closeBtn =
  'dy-press -mr-1 grid size-11 shrink-0 place-items-center rounded-[10px] text-dy-muted sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card';

function CloseButton(props: { readonly label: string; readonly onClick: () => void }): ReactNode {
  return (
    <button type="button" aria-label={props.label} onClick={props.onClick} className={closeBtn}>
      <ChatIcon name="close" className="size-5" />
    </button>
  );
}

/** ≥ 64 rem, details closed: the plan column on the right (the details panel's motion). */
export function PlanColumn(
  props: PlanPanelProps & {
    readonly state: 'open' | 'closed';
    readonly panelRef: RefObject<HTMLElement | null>;
    readonly onClose: () => void;
  },
): ReactNode {
  const t = useT().plan;
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useId();
  return (
    <aside
      ref={props.panelRef}
      {...presenceProps({ state: props.state })}
      data-side="right"
      aria-label={t.region}
      id="dy-plan"
      data-testid="plan-column"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onClose();
        }
      }}
      className="dy-surface dy-m-column sticky top-[var(--dy-sohbet-head,57px)] flex h-[calc(100dvh-var(--dy-sohbet-head,57px))] w-[320px] shrink-0 flex-col border-l border-dy-line bg-dy-bg xl:w-[352px]"
    >
      <div
        ref={scroller}
        className="dy-m-inner min-h-0 w-[320px] min-w-[320px] flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6 xl:w-[352px] xl:min-w-[352px]"
      >
        <PlanBody
          {...props}
          scrollerRef={scroller}
          headingId={heading}
          controls={<CloseButton label={t.panel.close} onClick={props.onClose} />}
        />
      </div>
    </aside>
  );
}

const DOCK_KEY = 'remyral.chat.planDock';

function readDock(): { expanded: boolean; share: number } {
  try {
    const v = JSON.parse(window.localStorage.getItem(DOCK_KEY) ?? 'null') as {
      expanded?: unknown;
      share?: unknown;
    } | null;
    return {
      expanded: v?.expanded === true,
      share: typeof v?.share === 'number' && v.share >= 0.2 && v.share <= 0.45 ? v.share : 0.45,
    };
  } catch {
    return { expanded: false, share: 0.45 };
  }
}

function writeDock(v: { expanded: boolean; share: number }): void {
  try {
    window.localStorage.setItem(DOCK_KEY, JSON.stringify(v));
  } catch {
    // Not remembered (private mode / blocked storage).
  }
}

/**
 * ≥ 64 rem, details open: the plan docked under the details — the mini line, or expanded up to 45 % of the column
 * (a grip resizes it: pointer drag or ↑ / ↓ when focused; remembered). Height moves through SmoothHeight.
 */
export function PlanDock(props: PlanPanelProps & { readonly expandRequest: number }): ReactNode {
  const t = useT().plan;
  const [dock, setDock] = useState(readDock);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const heading = useId();
  const bodyId = useId();
  const set = (v: { expanded: boolean; share: number }): void => {
    setDock(v);
    writeDock(v);
  };
  // Auto-expand (a plan created, a decision waiting, execution starting) — the screen asks by bumping the request.
  const first = useRef(props.expandRequest);
  useEffect(() => {
    if (props.expandRequest !== first.current) setDock((d) => ({ ...d, expanded: true }));
  }, [props.expandRequest]);
  const drag = useRef<{ y: number; h: number; col: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const col = box.current?.parentElement?.getBoundingClientRect().height ?? 0;
    drag.current = { y: e.clientY, h: box.current?.getBoundingClientRect().height ?? 0, col };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.col === 0) return;
    const share = Math.min(0.45, Math.max(0.2, (d.h + (d.y - e.clientY)) / d.col));
    setDock({ expanded: true, share });
  };
  const onPointerUp = (): void => {
    if (drag.current !== null) writeDock({ expanded: true, share: dock.share });
    drag.current = null;
  };
  const onGripKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const share = Math.min(0.45, Math.max(0.2, dock.share + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
    set({ expanded: true, share });
  };
  return (
    <section
      aria-label={t.region}
      className="flex min-h-0 shrink-0 flex-col border-t border-dy-line bg-dy-bg"
      data-testid="plan-dock"
      data-expanded={dock.expanded ? '' : undefined}
    >
      {dock.expanded ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t.panel.grip}
          aria-valuemin={20}
          aria-valuemax={45}
          aria-valuenow={Math.round(dock.share * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onGripKey}
          className="dy-plan-grip flex h-3 cursor-row-resize touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-dy-teal"
          data-testid="plan-grip"
        >
          <span className="h-1 w-10 rounded-full bg-dy-line-2" aria-hidden="true" />
        </div>
      ) : null}
      <PlanMini
        plan={props.plan}
        expanded={dock.expanded}
        controls={bodyId}
        variant="dock"
        onToggle={() => {
          set({ ...dock, expanded: !dock.expanded });
        }}
      />
      <SmoothHeight>
        {dock.expanded ? (
          <div
            ref={box}
            id={bodyId}
            className="dy-plan-dock-body"
            style={{ height: `calc((100dvh - var(--dy-sohbet-head, 57px)) * ${String(dock.share)})` }}
          >
            <div ref={scroller} className="h-full overflow-y-auto overscroll-contain px-4 pt-1 pb-4">
              <PlanBody {...props} scrollerRef={scroller} headingId={heading} />
            </div>
          </div>
        ) : null}
      </SmoothHeight>
    </section>
  );
}

/** 40–64 rem: the right drawer over the thread (360 px), the details panel's motion. */
export function PlanDrawer(
  props: PlanPanelProps & {
    readonly state: 'open' | 'closed';
    readonly panelRef: RefObject<HTMLElement | null>;
    readonly onClose: () => void;
  },
): ReactNode {
  const t = useT().plan;
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.state === 'open') closeRef.current?.focus();
  }, [props.state]);
  // p22-classic-removal §7: the thread behind the scrim stays where the reader left it.
  useScrollLock(props.state === 'open');
  return (
    <>
      <div
        {...presenceProps({ state: props.state })}
        aria-hidden="true"
        onClick={props.onClose}
        className="dy-m-fade fixed inset-0 z-30 bg-[var(--dy-scrim)]"
      />
      <aside
        ref={props.panelRef}
        {...presenceProps({ state: props.state })}
        aria-label={t.region}
        id="dy-plan"
        data-testid="plan-drawer"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            props.onClose();
          }
        }}
        className="dy-surface dy-m-drawer-right fixed inset-y-0 right-0 z-40 flex w-[360px] max-w-full flex-col border-l border-dy-line bg-dy-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-dy-pop"
      >
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-6">
          <PlanBody
            {...props}
            scrollerRef={scroller}
            headingId={heading}
            controls={
              <button
                ref={closeRef}
                type="button"
                aria-label={t.panel.close}
                onClick={props.onClose}
                className={closeBtn}
              >
                <ChatIcon name="close" className="size-5" />
              </button>
            }
          />
        </div>
      </aside>
    </>
  );
}

/**
 * < 40 rem: the bottom sheet — a modal native dialog (focus trap, Escape, focus back to the pill), snapping to 50 % /
 * 90 % of the screen; the handle drags it (down past half closes), ↑ / ↓ on the handle snap.
 */
export function PlanSheet(
  props: PlanPanelProps & {
    readonly open: boolean;
    readonly onClose: () => void;
  },
): ReactNode {
  const t = useT().plan;
  const ref = useRef<HTMLDialogElement>(null);
  // The sheet's panel moves (snap, drag, enter / leave); the dialog itself stays untransformed and fills the window, so
  // a menu of the panel (a fixed popover rendered into the dialog) is placed against the window, not the moved panel.
  const panel = useRef<HTMLDivElement>(null);
  const presence = usePresence(props.open, panel);
  // p22-classic-removal §7: a swipe on the dimmed thread above the sheet no longer scrolls the page behind it.
  useScrollLock(presence.mounted);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useId();
  const [snap, setSnap] = useState<'half' | 'full'>('half');
  const [dragY, setDragY] = useState<number | null>(null);
  const start = useRef<number | null>(null);
  useLayoutEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (presence.mounted && !d.open && typeof d.showModal === 'function') {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    if (!presence.mounted && d.open && typeof d.close === 'function') d.close();
  }, [presence.mounted]);
  useEffect(() => {
    if (props.open) setSnap('half');
  }, [props.open]);
  if (!presence.mounted) return null;
  const offset = dragY === null ? undefined : Math.max(0, dragY);
  const end = (): void => {
    const y = dragY ?? 0;
    start.current = null;
    setDragY(null);
    const h = window.innerHeight;
    if (y > h * 0.25 && snap === 'half') props.onClose();
    else if (y > h * 0.2) setSnap('half');
    else if (y < -h * 0.1) setSnap('full');
  };
  return (
    <dialog
      ref={ref}
      {...presenceProps({ state: presence.state })}
      aria-labelledby={heading}
      data-snap={snap}
      data-dragging={dragY === null ? undefined : ''}
      data-testid="plan-sheet"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose();
      }}
      style={
        offset === undefined ? undefined : ({ '--dy-sheet-drag': `${String(offset)}px` } as CSSProperties)
      }
      className="dy-plan-sheet fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-clip border-0 bg-transparent p-0 text-dy-ink backdrop:bg-[var(--dy-scrim)]"
    >
      <div
        ref={panel}
        {...presenceProps({ state: presence.state })}
        className="dy-plan-sheet-panel dy-surface absolute inset-x-0 bottom-0 flex h-[90dvh] flex-col rounded-t-[18px] border-t border-dy-line bg-dy-bg pb-[env(safe-area-inset-bottom)] shadow-dy-pop"
      >
        <div
          role="slider"
          tabIndex={0}
          aria-label={t.panel.sheet}
          aria-valuemin={50}
          aria-valuemax={90}
          aria-valuenow={snap === 'full' ? 90 : 50}
          onPointerDown={(e) => {
            start.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragY(0);
          }}
          onPointerMove={(e) => {
            if (start.current !== null) setDragY(e.clientY - start.current);
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSnap('full');
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (snap === 'full') setSnap('half');
              else props.onClose();
            }
          }}
          className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-dy-teal"
          data-testid="plan-sheet-handle"
        >
          <span className="h-1.5 w-10 rounded-full bg-dy-line-2" aria-hidden="true" />
        </div>
        <div
          ref={scroller}
          className="dy-plan-sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6"
        >
          <PlanBody
            {...props}
            scrollerRef={scroller}
            headingId={heading}
            controls={<CloseButton label={t.panel.close} onClick={props.onClose} />}
          />
        </div>
      </div>
    </dialog>
  );
}
