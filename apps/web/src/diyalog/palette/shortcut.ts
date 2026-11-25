import { useEffect } from 'react';

/**
 * p14-web-perf-2: the command palette's keyboard shortcut and its label — in the shell's initial JS; the palette body
 * (CommandPalette.tsx: search, sources, the settings groups) is loaded lazily on idle or at the first open.
 */

/** Opens / closes the palette on ⌘K (macOS) / Ctrl+K — also while typing; not over another modal dialog. */
export function usePaletteShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== 'k') return;
      const other = document.querySelector('dialog[open]:not(.dy-palette)');
      if (other !== null) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [toggle]);
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function paletteKeyLabel(): string {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(p) ? '⌘K' : 'Ctrl K'; // i18n-ignore: key names
}
