import { createContext, type ReactNode, use, useEffect, useMemo, useRef } from 'react';
import { dialogOpen, isTyping } from '../../shell/keys';

/**
 * p12-diyalog Faz 1: keyboard in the operations thread.
 *   j / k   next / previous card (focus moves, the card scrolls into view without animation)
 *   a / d   approve / deny the focused card: opens its decision row with the code field
 * Ignored while typing, with a modifier held and while a dialog is open. Cards register what `a` / `d` do for them.
 *
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §3.3): these stay single letters because they are list
 * keys, not page keys — they only work while the keyboard is in the thread (a card or anything inside the thread
 * has focus) or nowhere yet (nothing focused: the page just opened), never with focus in the rail, a top-bar menu or
 * another panel; they never change the page, and `a` / `d` only open the decision row (the decision itself still
 * needs its button and, where asked, a code).
 */
export interface CardKeyHandlers {
  readonly approve?: (() => void) | undefined;
  readonly deny?: (() => void) | undefined;
}

type Registry = Map<string, CardKeyHandlers>;

const KeysContext = createContext<Registry | null>(null);

export function CardKeysProvider(props: { readonly children: ReactNode }): ReactNode {
  const registry = useMemo<Registry>(() => new Map(), []);
  return <KeysContext value={registry}>{props.children}</KeysContext>;
}

/** Registers `a` / `d` for the card `key` while it is mounted (latest handlers win, no re-registration churn). */
export function useCardKeys(key: string, handlers: CardKeyHandlers): void {
  const registry = use(KeysContext);
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (registry === null) return;
    registry.set(key, {
      approve: () => ref.current.approve?.(),
      deny: () => ref.current.deny?.(),
    });
    return () => {
      registry.delete(key);
    };
  }, [registry, key]);
}

function cards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-card]')];
}

/** Moves focus to a card without smooth scrolling (keyboard actions never animate). */
export function focusCard(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

/** The keyboard is in the thread (focus inside it) or nowhere (the document body): the list keys apply. */
export function keyboardInThread(root: HTMLElement): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || root.contains(active);
}

/** Installs j / k / a / d on the document for the thread rooted at `rootRef`. */
export function useThreadKeys(rootRef: React.RefObject<HTMLElement | null>): void {
  const registry = use(KeysContext);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (dialogOpen()) return;
      const key = e.key;
      const root = rootRef.current;
      if (root === null) return;
      if (!keyboardInThread(root)) return;
      const list = cards(root);
      if (list.length === 0) return;
      const active = document.activeElement;
      const current = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-card]') : null;
      const at = current === null ? -1 : list.indexOf(current);
      if (key === 'j' || key === 'k') {
        e.preventDefault();
        const next =
          key === 'j'
            ? list[at < 0 ? 0 : Math.min(list.length - 1, at + 1)]
            : list[at < 0 ? list.length - 1 : Math.max(0, at - 1)];
        if (next !== undefined) focusCard(next);
        return;
      }
      if ((key === 'a' || key === 'd') && current !== null) {
        const handlers = registry?.get(current.dataset.card ?? '');
        const fn = key === 'a' ? handlers?.approve : handlers?.deny;
        if (fn === undefined) return;
        e.preventDefault();
        fn();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [rootRef, registry]);
}
