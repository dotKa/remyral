import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Plan, PlanUserOp } from '../../api/plans';
import { useT } from '../../i18n/I18nProvider';
import { motionOff } from '../motionKit';
import { moveOp, type PhaseView, placeIn, stepMove } from './planModel';

/**
 * p18-plan-mode W3 (docs/design/p18-plan-mode.md §3 "Editing", §4 "reorder"): moving an item by its handle — dragged
 * with a mouse, a pen or a finger (pointer events, the handle has `touch-action: none`), or by keyboard (handle
 * focused: Space / Enter picks it up, ↑ / ↓ move it — over a phase's edge into the next one —, Space / Enter drops it,
 * Escape cancels). While it moves the list shows it at its new place (the other rows glide there through useFlip, the
 * lifted row follows the pointer); the drop sends one `move` with the place against the plan as it was. Every step is
 * said in the live region.
 */

export interface ReorderTarget {
  readonly key: string;
  readonly mode: 'pointer' | 'keyboard';
  /** The drop place: a phase index of the plan and the row it goes before (null: the phase's end). */
  readonly phase: number;
  readonly before: string | null;
}

interface Grab {
  readonly key: string;
  readonly startY: number;
  readonly startTop: number;
  readonly startScroll: number;
  lastY: number;
}

/** Pixels from the scroller's edge where a drag scrolls it, and how far per frame. */
const EDGE = 48;
const STEP = 10;

export function useReorder(opts: {
  /** The plan the drop is computed against (the edits on their way applied, no move in progress). */
  readonly plan: Plan;
  /** The phases shown now (with the move in progress), read at event time. */
  readonly shown: RefObject<readonly PhaseView[]>;
  readonly list: RefObject<HTMLElement | null>;
  readonly scroller: RefObject<HTMLElement | null>;
  readonly onDrop: (op: PlanUserOp) => void;
  readonly say: (text: string) => void;
}): {
  readonly target: ReorderTarget | null;
  readonly handleProps: (key: string) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
    onBlur: (e: { relatedTarget: EventTarget | null }) => void;
  };
} {
  const t = useT().plan.edit;
  const [target, setTarget] = useState<ReorderTarget | null>(null);
  const grab = useRef<Grab | null>(null);
  const frame = useRef<number | null>(null);
  const { plan, shown, list, scroller, onDrop, say } = opts;
  const planRef = useRef(plan);
  planRef.current = plan;
  const targetRef = useRef(target);
  targetRef.current = target;

  const row = useCallback(
    (key: string): HTMLElement | null =>
      list.current?.querySelector<HTMLElement>(`[data-plan-item="${CSS.escape(key)}"]`) ?? null,
    [list],
  );

  /** The lifted row follows the pointer: its layout place may have changed (the list re-laid out under it). */
  const follow = useCallback(() => {
    const g = grab.current;
    if (g === null) return;
    const el = row(g.key);
    if (el === null) return;
    const scrolled = (scroller.current?.scrollTop ?? 0) - g.startScroll;
    const dy = g.startTop + (g.lastY - g.startY) + scrolled - el.offsetTop;
    el.style.transform = `translate3d(0, ${String(Math.round(dy))}px, 0)${motionOff(el) ? '' : ' scale(1.02)'}`; // i18n-ignore: CSS
  }, [row, scroller]);

  useLayoutEffect(() => {
    if (target?.mode === 'pointer') follow();
  });

  const original = (key: string): { phase: number; before: string | null } | null => {
    const p = planRef.current;
    const i = p.items.find((x) => x.key === key);
    if (i === undefined) return null;
    const next = p.items
      .filter((x) => x.phase === i.phase && x.position > i.position)
      .sort((a, b) => a.position - b.position)[0];
    return { phase: i.phase, before: next?.key ?? null };
  };

  /** The place under the pointer: before the first row (or a phase's end) whose middle is below it. */
  const hit = (key: string, y: number): { phase: number; before: string | null } | null => {
    const c = list.current;
    if (c === null) return null;
    const els = c.querySelectorAll<HTMLElement>('[data-plan-item], [data-plan-phase-end]');
    let last: number | null = null;
    for (const el of els) {
      const end = el.dataset.planPhaseEnd;
      if (end !== undefined) last = Number(end);
      if (el.dataset.planItem === key) continue;
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 <= y) continue;
      if (end !== undefined) return { phase: Number(end), before: null };
      return { phase: Number(el.dataset.planPhase), before: el.dataset.planItem ?? null };
    }
    return last === null ? null : { phase: last, before: null };
  };

  const stopFrame = (): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const clear = useCallback(
    (key: string) => {
      grab.current = null;
      stopFrame();
      const el = row(key);
      if (el !== null) el.style.transform = '';
      setTarget(null);
    },
    [row],
  );

  useEffect(
    () => () => {
      stopFrame();
    },
    [],
  );

  const drop = (tg: ReorderTarget): void => {
    const p = planRef.current;
    const from = original(tg.key);
    const title = p.items.find((i) => i.key === tg.key)?.title ?? tg.key;
    clear(tg.key);
    if (from === null) return;
    if (from.phase === tg.phase && from.before === tg.before) {
      say(t.live.cancelled({ title }));
      return;
    }
    const op = moveOp(p, tg.key, tg.phase, tg.before);
    onDrop(op);
    const at = placeIn(shown.current, tg.key);
    if (at !== null) say(t.live.dropped({ title, index: at.index, count: at.count, phase: at.title }));
  };

  const cancel = (key: string): void => {
    const title = planRef.current.items.find((i) => i.key === key)?.title ?? key;
    clear(key);
    say(t.live.cancelled({ title }));
  };

  const autoScroll = (): void => {
    const g = grab.current;
    const sc = scroller.current;
    if (g === null || sc === null) {
      frame.current = null;
      return;
    }
    const r = sc.getBoundingClientRect();
    const d = g.lastY < r.top + EDGE ? -STEP : g.lastY > r.bottom - EDGE ? STEP : 0;
    if (d !== 0 && typeof sc.scrollBy === 'function') {
      sc.scrollBy(0, d);
      move(g.key, g.lastY);
    }
    frame.current = requestAnimationFrame(autoScroll);
  };

  const move = (key: string, y: number): void => {
    const g = grab.current;
    if (g === null) return;
    g.lastY = y;
    const at = hit(key, y);
    const cur = targetRef.current;
    if (at !== null && cur !== null && (cur.phase !== at.phase || cur.before !== at.before))
      setTarget({ key, mode: 'pointer', phase: at.phase, before: at.before });
    follow();
  };

  // Announce the place after a keyboard step (the rows shown then are the new ones).
  const announced = useRef<string>('');
  useEffect(() => {
    if (target?.mode !== 'keyboard') {
      announced.current = '';
      return;
    }
    const mark = `${target.key}:${String(target.phase)}:${target.before ?? ''}`;
    if (announced.current === '' || announced.current === mark) {
      announced.current = mark;
      return;
    }
    announced.current = mark;
    const at = placeIn(shown.current, target.key);
    if (at !== null) say(t.live.position({ index: at.index, count: at.count, phase: at.title }));
    // The handle moved (another phase's list re-mounts it): keep the focus on it.
    const h = list.current?.querySelector<HTMLElement>(`[data-plan-handle="${CSS.escape(target.key)}"]`);
    if (h !== null && h !== undefined && document.activeElement !== h) h.focus();
  });

  return {
    target,
    handleProps: (key: string) => ({
      onPointerDown: (e) => {
        if (e.button !== 0 || targetRef.current !== null) return;
        const el = row(key);
        const from = original(key);
        if (el === null || from === null) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // jsdom / an old browser: the move events still reach the handle.
        }
        grab.current = {
          key,
          startY: e.clientY,
          startTop: el.offsetTop,
          startScroll: scroller.current?.scrollTop ?? 0,
          lastY: e.clientY,
        };
        setTarget({ key, mode: 'pointer', ...from });
        if (frame.current === null && typeof requestAnimationFrame === 'function')
          frame.current = requestAnimationFrame(autoScroll);
      },
      onPointerMove: (e) => {
        if (grab.current?.key !== key) return;
        move(key, e.clientY);
      },
      onPointerUp: (e) => {
        if (grab.current?.key !== key) return;
        move(key, e.clientY);
        const tg = targetRef.current;
        if (tg !== null) drop(tg);
      },
      onPointerCancel: () => {
        if (grab.current?.key === key) cancel(key);
      },
      onKeyDown: (e) => {
        const cur = targetRef.current;
        const lifted = cur?.key === key && cur.mode === 'keyboard';
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (lifted) {
            drop(cur);
            return;
          }
          if (cur !== null) return;
          const from = original(key);
          if (from === null) return;
          setTarget({ key, mode: 'keyboard', ...from });
          const at = placeIn(shown.current, key);
          const title = planRef.current.items.find((i) => i.key === key)?.title ?? key;
          if (at !== null) say(t.live.picked({ title, index: at.index, count: at.count, phase: at.title }));
          return;
        }
        if (!lifted) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel(key);
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = stepMove(shown.current, key, e.key === 'ArrowUp' ? -1 : 1);
          if (step === null) {
            say(t.live.edge);
            return;
          }
          setTarget({ key, mode: 'keyboard', ...step });
        }
      },
      onBlur: (e) => {
        // Focus moved elsewhere on purpose (Tab, a click): the move is dropped where it was; a re-mount (null) is not.
        const cur = targetRef.current;
        if (cur?.key === key && cur.mode === 'keyboard' && e.relatedTarget !== null) cancel(key);
      },
    }),
  };
}
