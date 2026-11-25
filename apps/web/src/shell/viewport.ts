import { useEffect } from 'react';

// p14-web-perf: a module of its own so the shell loads it without the chat screens (p15-classic-removal: one shell).

/** p5-chat-ux: the chat fills the viewport; the page itself never grows (its panes scroll on their own). */
export function isFullHeightRoute(pathname: string): boolean {
  return pathname === '/chat' || pathname.startsWith('/chat/');
}

/**
 * iOS Safari keeps the layout viewport (and `dvh`) when the on-screen keyboard opens; the visual viewport
 * shrinks. In full-height mode the frame follows the visual viewport (`--app-vh`) so the composer stays above
 * the keyboard. Elsewhere (and without visualViewport) `100dvh` applies.
 */
export function useVisualViewportHeight(active: boolean): void {
  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    const root = document.documentElement;
    if (!active || vv === undefined || vv === null) {
      root.style.removeProperty('--app-vh');
      return;
    }
    const update = (): void => {
      root.style.setProperty('--app-vh', `${String(Math.round(vv.height))}px`);
    };
    update();
    vv.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      root.style.removeProperty('--app-vh');
    };
  }, [active]);
}
