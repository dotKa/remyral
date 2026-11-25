import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { dialogOpen, isAltCombo, isTyping } from '../../shell/keys';
import { DICTATION_LETTER } from '../../shell/shortcuts';

/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §3.4–3.5): the Sohbet composer's keyboard and focus.
 *
 *   useDictationShortcut  Option / Alt + D starts / stops dictation while the composer is on screen — also with the
 *                         caret in the composer (the one combo meant for it); never while another field has the
 *                         keyboard or a dialog is open.
 *   useComposerFocus      the caret goes to the composer when the chat screen opens, a conversation opens or
 *                         "Yeni sohbet" is pressed: always with a fine pointer (desktop); on touch only after an
 *                         explicit "Yeni sohbet" tap (a route change alone must not pop the on-screen keyboard). Never
 *                         from a dialog, another text field or a menu that has the keyboard.
 *   useDockHeight         the composer dock's height as `--dy-dock-h` on <html>, so the toasts sit above it.
 */

export function useDictationShortcut(
  field: RefObject<HTMLTextAreaElement | null>,
  dictation: { readonly listening: boolean; readonly start: () => void; readonly stop: () => void },
  enabled: boolean,
): void {
  const live = useRef(dictation);
  live.current = dictation;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!isAltCombo(e, DICTATION_LETTER)) return;
      if (dialogOpen()) return;
      const el = field.current;
      if (el === null) return;
      if (isTyping(e.target) && e.target !== el) return;
      e.preventDefault();
      if (live.current.listening) live.current.stop();
      else {
        live.current.start();
        // What is said appears in the field: the caret goes there (an explicit key press, never a surprise).
        if (document.activeElement !== el) el.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [enabled, field]);
}

/**
 * A mouse / trackpad is the main pointer. Unknown (no matchMedia — jsdom; every browser has it) counts as not fine:
 * when in doubt the caret is not moved on a route change.
 */
export function finePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: fine)').matches;
}

/** Whether the composer may take the keyboard now (nothing else the person is using has it). */
export function mayTakeFocus(field: HTMLElement): boolean {
  if (dialogOpen()) return false;
  const active = document.activeElement;
  if (active === null || active === document.body || active === field) return true;
  if (isTyping(active)) return false;
  // An open menu / listbox / popover keeps the keyboard.
  if (
    active instanceof HTMLElement &&
    active.closest('[role="menu"],[role="listbox"],[role="dialog"]') !== null
  )
    return false;
  return true;
}

/** How long after a request the composer may still take the keyboard (it may be locked while loading). */
export const FOCUS_WINDOW_MS = 4_000;

/** Router state of an explicit "Yeni sohbet" (the caret goes to the composer on touch screens too). */
export const FOCUS_COMPOSER_STATE = 'dyFocusComposer';

/** Whether the router state carries the explicit "Yeni sohbet" flag. */
export function wantsComposerFocus(state: unknown): boolean {
  return (
    state !== null &&
    typeof state === 'object' &&
    (state as Record<string, unknown>)[FOCUS_COMPOSER_STATE] === true
  );
}

export interface FocusRequest {
  /** Changes on every navigation that asks for the caret (the router location key). */
  readonly key: string;
  /** An explicit "Yeni sohbet": the caret goes there on touch screens too. */
  readonly explicit: boolean;
}

export function useComposerFocus(
  field: RefObject<HTMLTextAreaElement | null>,
  request: FocusRequest | undefined,
  locked: boolean,
): void {
  const pending = useRef<{ at: number; explicit: boolean } | null>(null);
  const handled = useRef<string | null>(null);
  const key = request?.key;
  const explicit = request?.explicit === true;
  useEffect(() => {
    if (key !== undefined && handled.current !== key) {
      handled.current = key;
      pending.current = { at: Date.now(), explicit };
    }
    const p = pending.current;
    if (p === null || locked) return;
    pending.current = null;
    const el = field.current;
    if (el === null || el.disabled) return;
    if (Date.now() - p.at > FOCUS_WINDOW_MS) return;
    if (!p.explicit && !finePointer()) return;
    if (!mayTakeFocus(el)) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [key, explicit, locked, field]);
}

export const DOCK_HEIGHT_VAR = '--dy-dock-h';

export function useDockHeight(dock: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = dock.current;
    const root = document.documentElement;
    if (el === null) return;
    const set = (): void => {
      root.style.setProperty(DOCK_HEIGHT_VAR, `${String(Math.round(el.getBoundingClientRect().height))}px`);
    };
    set();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(DOCK_HEIGHT_VAR);
    };
  }, [dock]);
}
