import type { PaletteItem } from './sources';

/**
 * p12-diyalog-cmdk: the palette's "Son kullanılanlar" — the last 8 places opened from it, per user and per browser
 * (`localStorage['remyral.dy.palette.recent.<userId>']`). Only navigations are kept (label, hint, icon, a console path);
 * never a query or a search result's snippet. Storage errors are ignored (private mode: nothing is remembered).
 */

export const RECENT_MAX = 8;

const key = (userId: string): string => `remyral.dy.palette.recent.${userId}`;

const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

export function readRecent(userId: string): PaletteItem[] {
  try {
    const raw = window.localStorage.getItem(key(userId));
    if (raw === null) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.flatMap((x): PaletteItem[] => {
      if (x === null || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.to !== 'string') return [];
      if (!SAFE_PATH.test(o.to)) return [];
      return [
        {
          id: o.id,
          section: 'recent',
          label: o.label.slice(0, 200),
          hint: typeof o.hint === 'string' ? o.hint.slice(0, 200) : undefined,
          icon: typeof o.icon === 'string' ? (o.icon as PaletteItem['icon']) : 'search',
          to: o.to,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function rememberRecent(userId: string, item: PaletteItem): void {
  if (item.to === undefined || !SAFE_PATH.test(item.to) || item.section === 'ai') return;
  try {
    const next = [
      { id: item.id, label: item.label, hint: item.hint, icon: item.icon, to: item.to },
      ...readRecent(userId)
        .filter((r) => r.id !== item.id)
        .map((r) => ({ id: r.id, label: r.label, hint: r.hint, icon: r.icon, to: r.to })),
    ].slice(0, RECENT_MAX);
    window.localStorage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Storage unavailable: nothing is remembered.
  }
}
