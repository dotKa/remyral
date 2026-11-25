import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ThreadDetail } from '../../api/chat';
import type { Plan } from '../../api/plans';
import { useT } from '../../i18n/I18nProvider';
import { altAria, altLabel, dialogOpen, isAltCombo } from '../../shell/keys';
import { PLAN_LETTER } from '../../shell/shortcuts';
import { cx } from '../../components/ui';
import { usePresence } from '../motion';
import {
  PlanColumn,
  PlanDock,
  PlanDrawer,
  PlanMini,
  type PlanPanelProps,
  PlanRing,
  PlanSheet,
} from './PlanPanel';
import { ACTIVE, openDecisions } from './planModel';
import { usePlan } from './planStore';

/**
 * p18-plan-mode (docs/design/p18-plan-mode.md §3 placement table): where the plan of the Sohbet conversation sits.
 *
 * | width            | details closed                         | details open                               |
 * | ≥ 64 rem (lg)    | a right column (PlanColumn)            | docked under the details (PlanDock)        |
 * | 40–64 rem        | a bar under the context strip + drawer | the same (the details are a full sheet)    |
 * | < 40 rem         | a pill above the composer + bottom sheet (snaps 50 % / 90 %)                       |
 *
 * No plan → nothing. Open / closed is the person's own choice (remembered per user); it opens by itself on desktop when
 * a plan is created, a decision starts waiting or execution starts (by design); the phone starts as the pill.
 * Option / Alt + L toggles it (Alt + P is "Projeler" since p17-toasts-shortcuts — kept).
 */

const OPEN_KEY = 'remyral.chat.plan.';

function useWidth(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const m = window.matchMedia(query);
      m.addEventListener('change', l);
      return () => {
        m.removeEventListener('change', l);
      };
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}

function readOpen(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${OPEN_KEY}${userId}`) !== 'closed';
  } catch {
    return true;
  }
}

function writeOpen(userId: string, open: boolean): void {
  try {
    window.localStorage.setItem(`${OPEN_KEY}${userId}`, open ? 'open' : 'closed');
  } catch {
    // Not remembered (private mode / blocked storage).
  }
}

export interface PlanSurface {
  readonly plan: Plan | null;
  /** Plan mode is on for the conversation (the header's "Planlama" badge). */
  readonly planMode: boolean;
  /** ≥ 64 rem, details closed. */
  readonly column: ReactNode;
  /** ≥ 64 rem, details open: under the details. */
  readonly dock: ReactNode;
  /** 40–64 rem: the bar under the context strip. */
  readonly bar: ReactNode;
  /** < 40 rem: the pill above the composer. */
  readonly pill: ReactNode;
  /** The drawer / sheet (rendered at the screen's end). */
  readonly overlays: ReactNode;
  /** ≥ 64 rem: the header's button (the column opens / closes; with the details open the dock expands). */
  readonly toggle: ReactNode;
  /** Opens the plan where it is shown ("Planı incele"). */
  readonly open: () => void;
}

export function usePlanSurface(p: {
  readonly threadId: string | null;
  readonly detail: ThreadDetail | null;
  readonly userId: string;
  readonly detailsOpen: boolean;
  readonly onChanged: () => void;
}): PlanSurface {
  const t = useT().plan;
  const lg = useWidth('(min-width: 64rem)');
  const md = useWidth('(min-width: 40rem)');
  const fromDetail = p.detail === null ? undefined : (p.detail.plan?.active ?? null);
  const raw = usePlan(p.threadId, fromDetail);
  // Only a plan of this conversation that is still in play (a finished one stays until the view is read again).
  const plan = raw !== null && (ACTIVE.has(raw.state) || raw.state === 'done') ? raw : null;
  const planMode = p.detail?.plan?.mode != null;
  const [columnOpen, setColumnOpenState] = useState(() => readOpen(p.userId));
  const setColumnOpen = useCallback(
    (v: boolean) => {
      setColumnOpenState(v);
      writeOpen(p.userId, v);
    },
    [p.userId],
  );
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [dockRequest, setDockRequest] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  // Auto-open on desktop: a new plan, a decision starting to wait, execution starting.
  const seen = useRef<{ id: string; decisions: number; state: string } | null>(null);
  useEffect(() => {
    if (plan === null) return;
    const prev = seen.current;
    const now = { id: plan.id, decisions: openDecisions(plan), state: plan.state };
    seen.current = now;
    if (prev === null) return;
    const trigger =
      prev.id !== now.id ||
      now.decisions > prev.decisions ||
      (now.state === 'executing' && prev.state !== 'executing');
    if (!trigger) return;
    if (lg && !p.detailsOpen) setColumnOpen(true);
    if (lg && p.detailsOpen) setDockRequest((n) => n + 1);
  }, [plan, lg, p.detailsOpen, setColumnOpen]);

  const open = useCallback(() => {
    if (lg) {
      if (p.detailsOpen) setDockRequest((n) => n + 1);
      else setColumnOpen(true);
    } else if (md) setDrawer(true);
    else setSheet(true);
  }, [lg, md, p.detailsOpen, setColumnOpen]);

  // Option / Alt + L: the plan panel (not while typing elsewhere than the composer, not under a modal).
  const has = plan !== null;
  useEffect(() => {
    if (!has) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!isAltCombo(e, PLAN_LETTER) || dialogOpen()) return;
      e.preventDefault();
      if (lg) {
        if (p.detailsOpen) setDockRequest((n) => n + 1);
        else setColumnOpen(!columnOpen);
      } else if (md) setDrawer((v) => !v);
      else setSheet((v) => !v);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [has, lg, md, p.detailsOpen, columnOpen, setColumnOpen]);

  const columnPresence = usePresence(has && lg && !p.detailsOpen && columnOpen);
  const drawerPresence = usePresence(has && !lg && md && drawer);
  const base: PlanPanelProps | null =
    plan === null || p.threadId === null
      ? null
      : {
          plan,
          threadId: p.threadId,
          readOnly: p.detail?.access === 'reader',
          questions: p.detail?.questions ?? [],
          onChanged: p.onChanged,
          turnOpen: p.detail?.turn != null,
          // p18-multi-project W3: the working projects (item editor, project filter).
          projects: (p.detail?.knowledge?.projects ?? []).map((m) => m.project),
        };
  const keys = altLabel(PLAN_LETTER);
  return {
    plan,
    planMode,
    column:
      base !== null && columnPresence.mounted ? (
        <PlanColumn
          {...base}
          state={columnPresence.state}
          panelRef={columnPresence.ref}
          onClose={() => {
            setColumnOpen(false);
            toggleRef.current?.focus();
          }}
        />
      ) : null,
    dock: base !== null && lg && p.detailsOpen ? <PlanDock {...base} expandRequest={dockRequest} /> : null,
    bar:
      base !== null && !lg && md ? (
        <div className="mx-3 mt-2 sm:mx-4" title={`${t.panel.shortcut} (${keys})`}>
          <PlanMini
            plan={base.plan}
            expanded={drawer}
            variant="bar"
            controls="dy-plan"
            toggleRef={toggleRef}
            onToggle={() => {
              setDrawer(!drawer);
            }}
          />
        </div>
      ) : null,
    pill:
      base !== null && !md ? (
        <div className="mb-1" data-testid="plan-pill">
          <PlanMini
            plan={base.plan}
            expanded={sheet}
            variant="pill"
            toggleRef={pillRef}
            onToggle={() => {
              setSheet(true);
            }}
          />
        </div>
      ) : null,
    overlays:
      base === null ? null : (
        <>
          {drawerPresence.mounted ? (
            <PlanDrawer
              {...base}
              state={drawerPresence.state}
              panelRef={drawerPresence.ref}
              onClose={() => {
                setDrawer(false);
                toggleRef.current?.focus();
              }}
            />
          ) : null}
          {!md ? (
            <PlanSheet
              {...base}
              open={sheet}
              onClose={() => {
                setSheet(false);
                pillRef.current?.focus();
              }}
            />
          ) : null}
        </>
      ),
    toggle:
      base === null || !lg ? null : (
        <button
          ref={toggleRef}
          type="button"
          aria-label={columnOpen && !p.detailsOpen ? t.panel.close : t.panel.open}
          aria-pressed={columnOpen && !p.detailsOpen}
          aria-controls="dy-plan"
          aria-keyshortcuts={altAria(PLAN_LETTER)}
          title={`${t.panel.shortcut} (${keys})`}
          data-testid="plan-toggle"
          onClick={() => {
            if (p.detailsOpen) setDockRequest((n) => n + 1);
            else setColumnOpen(!columnOpen);
          }}
          className={cx(
            'dy-press relative grid size-11 shrink-0 place-items-center rounded-[10px] sm:size-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-card',
            columnOpen && !p.detailsOpen ? 'bg-dy-card text-dy-teal-ink shadow-dy' : 'text-dy-muted',
          )}
        >
          <PlanRing
            ratio={base.plan.progress.total === 0 ? 0 : base.plan.progress.done / base.plan.progress.total}
          />
          {openDecisions(base.plan) > 0 ? (
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-dy-amber" aria-hidden="true" />
          ) : null}
        </button>
      ),
    open,
  };
}
