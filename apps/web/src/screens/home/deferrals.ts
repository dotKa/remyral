import { useEffect, useSyncExternalStore } from 'react';
import {
  type DeferralInput,
  type DeferralMode,
  deleteDeferrals,
  listDeferrals,
  putDeferrals,
} from '../../api/deferrals';
import { POLL_MS } from '../../shell/notificationPoll';

/**
 * p20-decisions (docs/design/p20-decisions.md): one store of the person's put-off
 * ("Ertele", a day) and ignored ("Yoksay", a week) decisions for every surface of this tab — the sidebar badge, the
 * home and /needs read the same set, so they count the same, and the master keeps it, so the phone and the desktop
 * agree (until p19 each browser had its own localStorage list). A deferral leaves the set when its time is up (a timer
 * at the earliest end), so the decision comes back without a reload.
 *
 * The p19 browser lists (`remyral.needs.snoozed`, `remyral.home.dismissed`) are moved to the master once, silently, on
 * the first answer of the master, then removed; nothing reads them afterwards.
 */

/** How long each lasts (the master decides; these are for the optimistic entry until it answers). */
export const SNOOZE_MS = 24 * 3600_000;
export const IGNORE_MS = 7 * 24 * 3600_000;

export const LEGACY_SNOOZED_KEY = 'remyral.needs.snoozed';
export const LEGACY_DISMISSED_KEY = 'remyral.home.dismissed';

interface Entry {
  readonly mode: DeferralMode;
  readonly until: number;
}

export interface DeferralState {
  /** Every deferral still in force, by key. */
  readonly entries: ReadonlyMap<string, Entry>;
  /** The keys put off (snooze) / ignored. */
  readonly snoozed: ReadonlySet<string>;
  readonly ignored: ReadonlySet<string>;
  /** The master answered at least once (or cannot: an older master). */
  readonly loaded: boolean;
}

function stateOf(entries: ReadonlyMap<string, Entry>, loaded: boolean): DeferralState {
  const snoozed = new Set<string>();
  const ignored = new Set<string>();
  for (const [k, e] of entries) (e.mode === 'snooze' ? snoozed : ignored).add(k);
  return { entries, snoozed, ignored, loaded };
}

const EMPTY = stateOf(new Map(), false);
let state: DeferralState = EMPTY;
const listeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let migrated = false;

function set(entries: ReadonlyMap<string, Entry>, loaded = state.loaded): void {
  const now = Date.now();
  const live = new Map([...entries].filter(([, e]) => e.until > now));
  state = stateOf(live, loaded);
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const next = Math.min(...[...live.values()].map((e) => e.until));
  // At the earliest end the decision comes back (a setTimeout cannot wait longer than ~24.8 days; a week is fine).
  if (Number.isFinite(next))
    expiryTimer = setTimeout(
      () => {
        set(state.entries);
      },
      Math.max(0, next - now) + 50,
    );
  for (const l of listeners) l();
}

/** The p19 browser lists as master writes (`key|ms` entries; old failed-job keys are plain). */
export function legacyDeferrals(now: number, storage: Storage): DeferralInput[] {
  const out: DeferralInput[] = [];
  const read = (name: string, mode: DeferralMode, lasts: number): void => {
    let list: unknown;
    try {
      const raw = storage.getItem(name);
      list = raw === null ? [] : JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (typeof e !== 'string') continue;
      const bar = e.lastIndexOf('|');
      const key = bar < 0 ? e : e.slice(0, bar);
      const at = bar < 0 ? now : Number(e.slice(bar + 1));
      if (!Number.isFinite(at) || !/^[a-z][a-z0-9-]{0,39}:\S{1,200}$/.test(key)) continue;
      const until = at + lasts;
      if (until > now) out.push({ key, mode, until: new Date(until).toISOString() });
    }
  };
  read(LEGACY_SNOOZED_KEY, 'snooze', SNOOZE_MS);
  read(LEGACY_DISMISSED_KEY, 'ignore', IGNORE_MS);
  return out.slice(-200);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Once per page load: the browser's p19 lists go to the master, then leave the browser (silently; a failure retries). */
async function migrateLegacy(): Promise<boolean> {
  if (migrated) return false;
  const s = storage();
  if (s === null) {
    migrated = true;
    return false;
  }
  const items = legacyDeferrals(Date.now(), s);
  try {
    if (items.length > 0) await putDeferrals(items);
    s.removeItem(LEGACY_SNOOZED_KEY);
    s.removeItem(LEGACY_DISMISSED_KEY);
    migrated = true;
    return items.length > 0;
  } catch {
    return false;
  }
}

/** Reads the master's list (a write in between wins: its answer is newer). */
export async function refreshDeferrals(): Promise<void> {
  const g = ++generation;
  try {
    const moved = await migrateLegacy();
    if (moved && g !== generation) return;
    const items = await listDeferrals();
    if (g !== generation) return;
    set(new Map(items.map((d) => [d.key, { mode: d.mode, until: Date.parse(d.until) }] as const)), true);
  } catch {
    // An older master (404), no session or a failed poll: keep what is shown; nothing is put off by error.
    if (!state.loaded) set(state.entries, true);
  }
}

/** Puts a decision off / ignores it: shown at once, then stored on the master (a failure re-reads the master's list). */
export function deferDecision(key: string, mode: DeferralMode): void {
  generation++;
  const until = Date.now() + (mode === 'snooze' ? SNOOZE_MS : IGNORE_MS);
  set(new Map([...state.entries, [key, { mode, until }] as const]));
  putDeferrals([{ key, mode }]).then(
    () => undefined,
    () => void refreshDeferrals(),
  );
}

/** "Göster": every put-off decision comes back. */
export function undeferAll(mode: DeferralMode): void {
  generation++;
  set(new Map([...state.entries].filter(([, e]) => e.mode !== mode)));
  deleteDeferrals({ mode }).then(
    () => undefined,
    () => void refreshDeferrals(),
  );
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

let polling = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const onVisible = (): void => {
  if (document.visibilityState === 'visible') void refreshDeferrals();
};

/**
 * The person's deferrals (one store for the tab). Mounting starts the shared poll (every {@link POLL_MS} while the
 * page is visible, and when it becomes visible again — a deferral made on the phone reaches the desktop).
 */
export function useDeferrals(): DeferralState {
  useEffect(() => {
    polling++;
    if (polling === 1) {
      void refreshDeferrals();
      pollTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden') void refreshDeferrals();
      }, POLL_MS);
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      polling--;
      if (polling === 0) {
        if (pollTimer !== null) clearInterval(pollTimer);
        pollTimer = null;
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Tests: forget everything (and move the browser lists again on the next read). */
export function resetDeferrals(): void {
  generation++;
  migrated = false;
  set(new Map(), false);
}
