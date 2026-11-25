import type { KeyboardEvent } from 'react';

/**
 * p22-classic-removal (docs/design/p22-classic-removal.md §3): arrow keys in the conversation list. Tab still
 * walks every row and its "⋯" button (nothing is taken away); ↑ / ↓ move between the conversations themselves,
 * Home / End jump to the first / last one, and ↓ in the search field enters the list. A row is a link marked
 * `data-row-link`; only those take part (the row menus, group heads and tool buttons keep their own keys).
 */
const ROW = 'a[data-row-link]'; // i18n-ignore: CSS selector

function rows(root: ParentNode): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>(ROW)];
}

/** The row link a key moves to from `from` (null: the key is not a list move, or there is nowhere to go). */
export function rowTarget(root: ParentNode, from: Element | null, key: string): HTMLAnchorElement | null {
  const all = rows(root);
  if (all.length === 0) return null;
  const i = from === null ? -1 : all.indexOf(from as HTMLAnchorElement);
  switch (key) {
    case 'ArrowDown':
      return i < 0 ? (all[0] ?? null) : (all[i + 1] ?? null);
    case 'ArrowUp':
      return i <= 0 ? null : (all[i - 1] ?? null);
    case 'Home':
      return i < 0 ? null : (all[0] ?? null);
    case 'End':
      return i < 0 ? null : (all[all.length - 1] ?? null);
    default:
      return null;
  }
}

/** onKeyDown of the list's scroll box: moves between row links (other targets are left alone). */
export function onRowKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target as Element;
  if (!target.matches(ROW)) return;
  const next = rowTarget(e.currentTarget, target, e.key);
  if (next === null) {
    // At the first / last row the arrow stays put (no page scroll under the list).
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault();
    return;
  }
  e.preventDefault();
  next.focus();
}

/** onKeyDown of the search field: ↓ enters the list at its first conversation. */
export function onSearchKeys(e: KeyboardEvent<HTMLInputElement>, list: ParentNode | null): void {
  if (e.key !== 'ArrowDown' || list === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const first = rowTarget(list, null, 'ArrowDown'); // i18n-ignore: key name
  if (first === null) return;
  e.preventDefault();
  first.focus();
}
