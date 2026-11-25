import { useEffect } from 'react';

/**
 * p12-diyalog-final: the classic full-height chat behaviour (p5-chat-ux) for the Diyalog Sohbet, which scrolls the
 * window with a sticky composer instead of a fixed frame:
 *
 *   - `--app-vh` follows the visual viewport (the shell's `useVisualViewportHeight`, as classic), so the Sohbet
 *     column is at least as tall as what the person sees — a short conversation keeps its composer at the bottom;
 *   - `--dy-kb` is the part of the layout viewport the on-screen keyboard covers. iOS Safari keeps the layout
 *     viewport (and `dvh`) when the keyboard opens and only the visual viewport shrinks; the sticky composer lifts by
 *     this inset so it stays above the keyboard. Android Chrome resizes the layout itself
 *     (`interactive-widget=resizes-content` in index.html), so the inset stays 0 there;
 *   - while the composer has focus on a phone the bottom bar steps aside (`[data-chat-composer]`, index.css) and the
 *     composer drops to the bottom edge (chat.css).
 */
export const KEYBOARD_INSET_VAR = '--dy-kb';

/** The covered height in CSS px: the layout viewport's bottom minus the visual viewport's bottom (never negative). */
export function keyboardInset(
  innerHeight: number,
  vv: { readonly height: number; readonly offsetTop: number },
): number {
  return Math.max(0, Math.round(innerHeight - (vv.height + vv.offsetTop)));
}

/** Keeps `--dy-kb` on <html> while `active` (removed otherwise and on unmount). */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    const root = document.documentElement;
    if (!active || vv === undefined || vv === null) {
      root.style.removeProperty(KEYBOARD_INSET_VAR);
      return;
    }
    const update = (): void => {
      root.style.setProperty(KEYBOARD_INSET_VAR, `${String(keyboardInset(window.innerHeight, vv))}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty(KEYBOARD_INSET_VAR);
    };
  }, [active]);
}
