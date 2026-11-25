/**
 * p8-cost-efficiency §6: suggestions from deterministic rules. A one-click action goes through the existing route of
 * that mechanism (its own authorization, step-up and audit) — only after the person confirms; nothing is applied
 * automatically. Unknown action kinds render no button.
 */

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const DISMISSED_KEY = 'remyral.suggestions.dismissed';

export function readDismissed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : []);
  } catch {
    return new Set();
  }
}

export function writeDismissed(s: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    // per-browser convenience only
  }
}

/** A console-relative path (never another origin). */
export function safePath(p: string): string | null {
  return /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,300}$/.test(p) ? p : null;
}
