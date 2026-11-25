/**
 * p15-classic-removal (docs/design/p15-classic-removal.md §4): the console has one UI since the classic console was
 * removed. URLs from before that still carry the old view switch — `?ui=diyalog|classic` (the whole-UI choice) and
 * `?gorunum=klasik` (one screen's classic page). Bookmarks, notification and e-mail links with them must keep working:
 * the parameter is dropped and the same Diyalog screen opens (never a 404). The old per-browser choice
 * (`localStorage['remyral.ui']`) is forgotten.
 */
export const LEGACY_PARAMS: readonly string[] = ['ui', 'gorunum'];
export const LEGACY_UI_STORAGE_KEY = 'remyral.ui';

/** The query without the old view-switch parameters, or null when it has none (nothing to rewrite). */
export function withoutLegacyParams(search: string): string | null {
  const q = new URLSearchParams(search);
  if (!LEGACY_PARAMS.some((p) => q.has(p))) return null;
  for (const p of LEGACY_PARAMS) q.delete(p);
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

/** Drops this browser's stored classic / Diyalog choice (storage may be unavailable: then there is nothing to drop). */
export function forgetLegacyUiChoice(): void {
  try {
    window.localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage.
  }
}
