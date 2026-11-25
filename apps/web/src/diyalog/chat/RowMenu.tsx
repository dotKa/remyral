import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../components/ui';
import { DyIcon, type IconName } from '../icons';
import { DyPopover } from '../Popover';
import { DyConfirmDialog } from '../common/actions';
import { ChatIcon, type ChatIconName } from './icons';

/**
 * p12-diyalog-parity: a small action menu for a conversation (list row, conversation header, group header).
 * Keyboard: arrows move, Home / End jump, Escape closes and returns focus, Tab closes. p12-diyalog-cmdk: a DyPopover —
 * flips up / shifts sideways to stay inside the window (8 px), scrolls inside when tall, follows scroll / resize, is a
 * bottom sheet on phones, and opens / closes with motion. p18-confirm-dialog: a destructive item asks for a
 * confirmation in a small confirm dialog (the menu closes first; focus returns to the menu button).
 */
export interface RowMenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName | undefined;
  readonly chatIcon?: ChatIconName | undefined;
  readonly danger?: boolean | undefined;
  /** Asks again in a confirm dialog before running `onSelect`. */
  readonly confirm?: { readonly question: string; readonly yes: string; readonly no: string } | undefined;
  /** Keep focus on the button after selecting (false when the action moves focus itself, e.g. rename). */
  readonly returnFocus?: boolean | undefined;
  readonly onSelect: () => void;
}

export function RowMenu(props: {
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  readonly className?: string | undefined;
}): ReactNode {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<RowMenuItem | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && !menu.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
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
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  }

  const item =
    'flex min-h-11 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[0.875rem] outline-none sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk focus-visible:bg-dy-sunk';
  return (
    <div className={cx('relative', props.className)}>
      <button
        ref={button}
        type="button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) close(false);
          else setOpen(true);
        }}
        className="dy-press grid size-11 place-items-center rounded-[8px] text-dy-muted sm:size-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
      >
        <DyIcon name="more" className="size-[18px]" />
      </button>
      <DyPopover
        open={open}
        anchorRef={button}
        panelRef={menu}
        onDismiss={() => {
          close(true);
        }}
        id={menuId}
        role="menu"
        ariaLabel={props.label}
        onKeyDown={onKey}
        className="w-56 p-1"
        sheetClassName="p-2"
      >
        {props.items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={cx(item, it.danger === true && 'text-dy-red-ink')}
            onClick={() => {
              if (it.confirm !== undefined) {
                close(true);
                setConfirm(it);
                return;
              }
              close(it.returnFocus !== false);
              it.onSelect();
            }}
          >
            {it.icon !== undefined ? (
              <DyIcon name={it.icon} />
            ) : it.chatIcon !== undefined ? (
              <ChatIcon name={it.chatIcon} />
            ) : (
              <span className="size-4" aria-hidden="true" />
            )}
            {it.label}
          </button>
        ))}
      </DyPopover>
      <DyConfirmDialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
        }}
        title={confirm?.confirm?.question}
        confirmLabel={confirm?.confirm?.yes ?? ''}
        cancelLabel={confirm?.confirm?.no}
        variant="danger"
        testId="row-menu-confirm"
        onConfirm={() => {
          const run = confirm?.onSelect;
          setConfirm(null);
          run?.();
        }}
      />
    </div>
  );
}
