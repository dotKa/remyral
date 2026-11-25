/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §3): the console's modifier shortcuts.
 *
 * Page changes and page-level actions are Option + letter on macOS and Alt + letter elsewhere — never a bare letter,
 * which a stray key press outside a field used to turn into a page change. Matching is by `event.code` (the physical
 * key), because on macOS Option turns the letter into another character (`⌥D` types `∂`, `⌥N` is a dead key), so
 * `event.key` is useless there. Ctrl / Cmd must be up (AltGr on Windows is Ctrl + Alt: an AltGr character such as
 * the Turkish `@` never matches), and so must Shift.
 */

/** Apple platforms say ⌥ / ⌘; everyone else Alt / Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

/** `KeyD` for "d" — the physical key a combo letter sits on (US layout names, as `event.code` reports them). */
export function letterCode(letter: string): string {
  return `Key${letter.toUpperCase()}`;
}

/** Option / Alt + `letter`, nothing else held, not a held-down repeat. */
export function isAltCombo(e: KeyboardEvent, letter: string): boolean {
  return (
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.repeat &&
    !e.isComposing &&
    e.code === letterCode(letter)
  );
}

/** The letter of an Option / Alt combo being pressed (lower case), or null. */
export function altComboLetter(e: KeyboardEvent): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return null;
  const m = /^Key([A-Z])$/.exec(e.code);
  return m === null ? null : (m[1] ?? '').toLowerCase();
}

/** "⌥D" on Apple platforms, "Alt+D" elsewhere. */
export function altLabel(letter: string, apple: boolean = isApplePlatform()): string {
  return apple ? `⌥${letter.toUpperCase()}` : `Alt+${letter.toUpperCase()}`; // i18n-ignore: key names
}

/** The `aria-keyshortcuts` value of an Option / Alt combo ("Alt+D": Option is Alt in that attribute). */
export function altAria(letter: string): string {
  return `Alt+${letter.toUpperCase()}`;
}

/** A text field has the keyboard: shortcuts (except the composer's own combos) leave the key to it. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/** A modal dialog is open (its own keys win; shortcuts wait until it closes). */
export function dialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
}
