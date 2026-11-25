import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { cx } from '../../components/ui';
import { type TabItem, useTabParam } from '../../lib/tabs';
import { useChangeCount } from '../motionKit';
import { useLeaveGuard } from './guard';

/** The sticky top bar of a screen is ~53 px tall: a tab row scrolled under it counts as out of view. */
const BAR_PX = 60;

/**
 * p15-form-pattern: `DyTabs` — the segmented tabs of the Diyalog screens (the mockup's `.tabs`), URL-synced
 * (`?<param>=<id>`, default `tab`; the first tab is the clean URL, so classic deep links keep working) with the
 * WAI-ARIA tabs keyboard (← / → / Home / End; one tab stop). Before it switches it asks the unsaved-changes guard: a
 * tab whose form holds edits says "Kaydedilmemiş değişiklikler var — Kaydet / Kaydetmeden çık / Vazgeç" first.
 * `fallback` picks the tab when the URL names none (a `#personal-rules` link, for instance). `SegTabs` (p12) is this
 * component.
 *
 * p17-settings-tabs: only the active tab's body renders (lazy bodies). After a switch the body fades in (`dy-m-tab`,
 * motion.css; opacity only under reduced motion, never on the first render), each tab keeps its own scroll position
 * (going back to a tab returns to where it was read; a tab not seen yet starts with the tab row in view), and on phones
 * the selected tab is scrolled into the overflowing row (a deep link to the fifth tab shows it).
 */
export function DyTabs(props: {
  readonly label: string;
  readonly items: readonly TabItem[];
  readonly param?: string | undefined;
  /** The tab when the URL names none (default: the first). */
  readonly fallback?: string | undefined;
  /** URL parameters a switch drops (filters that belong to one tab, e.g. Sistem durumu's log filters). */
  readonly clearParams?: readonly string[] | undefined;
  readonly children: (active: string) => ReactNode;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const param = props.param ?? 'tab';
  const [urlActive, select] = useTabParam(props.items, param, props.clearParams);
  const [params] = useSearchParams();
  // p17-settings-tabs: once a tab is picked the anchor no longer decides (picking the first tab writes the clean URL,
  // which would otherwise fall back to the anchor's tab again).
  const [picked, setPicked] = useState(false);
  const active =
    !picked &&
    params.get(param) === null &&
    props.fallback !== undefined &&
    props.items.some((t) => t.id === props.fallback)
      ? props.fallback
      : urlActive;
  const guard = useLeaveGuard();
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const scrolls = useRef(new Map<string, number>());
  const swaps = useChangeCount(active);

  // The selected tab is inside the row's visible part (phones: the row scrolls sideways).
  useLayoutEffect(() => {
    const row = list.current;
    const tab = refs.current[props.items.findIndex((t) => t.id === active)];
    if (row === null || tab === undefined || tab === null || row.scrollWidth <= row.clientWidth) return;
    const left = tab.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + tab.offsetWidth > row.scrollLeft + row.clientWidth)
      row.scrollLeft = Math.max(0, left - 16);
  }, [active, props.items]);

  // Each tab keeps its scroll position; a tab opened for the first time starts with the tab row in view.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (typeof window.scrollTo !== 'function') return;
    const saved = scrolls.current.get(active);
    if (saved !== undefined) {
      if (Math.abs(window.scrollY - saved) > 1) window.scrollTo({ top: saved, behavior: 'instant' });
      return;
    }
    const top = list.current?.getBoundingClientRect().top;
    if (top !== undefined && top < BAR_PX)
      window.scrollTo({ top: Math.max(0, window.scrollY + top - BAR_PX), behavior: 'instant' });
  }, [active]);

  const go = (id: string, focus?: number): void => {
    if (id === active) return;
    const switchTo = (): void => {
      scrolls.current.set(active, window.scrollY);
      setPicked(true);
      select(id);
      if (focus !== undefined) refs.current[focus]?.focus();
    };
    if (guard === null || !guard.isDirty()) {
      switchTo();
      return;
    }
    void guard.confirmLeave().then((ok) => {
      if (ok) switchTo();
    });
  };

  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = props.items.findIndex((t) => t.id === active);
    const last = props.items.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i >= last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i <= 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    const item = props.items[next];
    if (item === undefined) return;
    go(item.id, next);
  };

  return (
    <div className={props.className} data-testid={props.testId}>
      <div
        ref={list}
        role="tablist"
        aria-label={props.label}
        onKeyDown={move}
        className="dy-noscrollbar dy-scroll-fade mb-5 flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] border border-dy-line bg-dy-sunk p-[3px] sm:inline-flex"
      >
        {props.items.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              data-tab-id={t.id}
              onClick={() => {
                go(t.id);
              }}
              className={cx(
                'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[7px] px-3 text-[0.84375rem] font-medium whitespace-nowrap transition-colors duration-150',
                selected
                  ? 'bg-dy-card text-dy-ink shadow-dy-seg'
                  : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
              )}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 ? (
                <span className="rounded-full bg-dy-amber-soft px-1.5 font-dy-mono text-[0.75rem] text-dy-amber-ink tabular-nums">
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${active}`}
        tabIndex={-1}
        className="outline-none"
      >
        <div key={swaps} className={swaps > 0 ? 'dy-m-tab' : undefined} data-tab-body={active}>
          {props.children(active)}
        </div>
      </div>
    </div>
  );
}
