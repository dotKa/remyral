import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyIcon, type IconName } from '../../icons';
import { DyPopover } from '../../Popover';
import { ARRANGE_MODES, type ArrangeMode } from './layout';

/**
 * p17-workflow-canvas (docs/design/p17-workflow-canvas.md §4): the arrange split button of the workflow toolbar. The
 * main part runs the last used mode (and shows its icon); the chevron opens the menu of modes — left → right, top →
 * bottom, compact grid, branch spacing, align selection (only with a selection). The choice is remembered per browser
 * (`localStorage['remyral.dy.workflow.arrange']`, guarded: private windows and blocked storage fall back to left →
 * right). Keyboard: the menu button pattern — Enter / Space / ↓ open on the first mode, ↑ on the last; arrows, Home
 * and End move; Escape closes and returns focus to the chevron; Tab closes.
 */

export const ARRANGE_KEY = 'remyral.dy.workflow.arrange';

export const ARRANGE_ICON: Readonly<Record<ArrangeMode, IconName>> = {
  lr: 'layoutLr',
  tb: 'layoutTb',
  grid: 'grid',
  tree: 'tree',
  align: 'alignMid',
};

/** The remembered mode (left → right when none, unknown or storage is unavailable). */
export function loadArrangeMode(): ArrangeMode {
  try {
    const v = window.localStorage.getItem(ARRANGE_KEY);
    return (ARRANGE_MODES as readonly string[]).includes(v ?? '') ? (v as ArrangeMode) : 'lr';
  } catch {
    return 'lr';
  }
}

export function saveArrangeMode(mode: ArrangeMode): void {
  try {
    window.localStorage.setItem(ARRANGE_KEY, mode);
  } catch {
    // Storage blocked (private window, policy): the choice lasts for this page only.
  }
}

export function ArrangeMenu(props: {
  readonly disabled: boolean;
  /** Align needs a selection. */
  readonly canAlign: boolean;
  readonly onArrange: (mode: ArrangeMode) => void;
}): ReactNode {
  const a = useT().workflows.arrange;
  const menuId = useId();
  const [mode, setMode] = useState<ArrangeMode>(loadArrangeMode);
  const [open, setOpen] = useState<false | 'first' | 'last'>(false);
  const chevron = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The remembered mode may be align while nothing is selected: the main button then waits for a selection.
  const mainDisabled = props.disabled || (mode === 'align' && !props.canAlign);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) chevron.current?.focus();
  };

  useEffect(() => {
    if (open === false) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    (open === 'last' ? items.at(-1) : items[0])?.focus();
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && !menu.current?.contains(t) && !chevron.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const run = (m: ArrangeMode): void => {
    if (m === 'align' && !props.canAlign) return;
    setMode(m);
    saveArrangeMode(m);
    props.onArrange(m);
  };

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      close(false);
      return;
    }
    // The toolbar's own arrow keys must not move focus out of the menu.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation();
      return;
    }
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
  }

  return (
    <div className="relative inline-flex shrink-0 items-center" data-testid="arrange-split">
      <button
        type="button"
        disabled={mainDisabled}
        data-testid="toolbar-tidy"
        data-mode={mode}
        aria-label={a.run({ mode: a.modes[mode] })}
        title={a.run({ mode: a.modes[mode] })}
        onClick={() => {
          run(mode);
        }}
        className="dy-press relative inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-l-[8px] pr-1.5 pl-2 text-[0.8125rem] font-medium whitespace-nowrap text-dy-ink disabled:cursor-not-allowed disabled:opacity-40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
      >
        <DyIcon name={ARRANGE_ICON[mode]} className="size-4 shrink-0" />
        <span aria-hidden="true" className="sr-only xl:not-sr-only">
          {a.button}
        </span>
      </button>
      <button
        ref={chevron}
        type="button"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open !== false}
        aria-controls={open === false ? undefined : menuId}
        aria-label={a.choose}
        title={a.choose}
        data-testid="toolbar-arrange-menu"
        onClick={() => {
          if (open === false) setOpen('first');
          else close(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(e.key === 'ArrowUp' ? 'last' : 'first');
          }
        }}
        className="dy-press inline-flex min-h-9 w-6 shrink-0 items-center justify-center rounded-r-[8px] border-l border-dy-line text-dy-muted disabled:cursor-not-allowed disabled:opacity-40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
      >
        <DyIcon name="chev" className="size-3.5" />
      </button>
      <DyPopover
        open={open !== false}
        anchorRef={chevron}
        panelRef={menu}
        onDismiss={() => {
          close(true);
        }}
        id={menuId}
        role="menu"
        ariaLabel={a.choose}
        testId="arrange-menu"
        onKeyDown={onMenuKey}
        align="start"
        className="w-64 p-1"
        sheetClassName="p-2"
      >
        {ARRANGE_MODES.map((m) => {
          const off = m === 'align' && !props.canAlign;
          return (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              aria-disabled={off ? true : undefined}
              data-testid={`arrange-${m}`}
              onClick={() => {
                if (off) return;
                close(true);
                run(m);
              }}
              className={cx(
                'flex min-h-11 w-full items-start gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left outline-none sm:min-h-9 focus-visible:bg-dy-sunk',
                off
                  ? 'cursor-not-allowed opacity-50'
                  : '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
              )}
            >
              <DyIcon name={ARRANGE_ICON[m]} className="mt-0.5 size-4 shrink-0 text-dy-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.875rem] text-dy-ink">{a.modes[m]}</span>
                <span className="block text-[0.75rem] text-dy-muted">
                  {off ? a.alignNeedsSelection : a.hints[m]}
                </span>
              </span>
              {m === mode ? (
                <DyIcon name="check" className="mt-0.5 size-4 shrink-0 text-dy-teal-ink" />
              ) : null}
            </button>
          );
        })}
      </DyPopover>
    </div>
  );
}
