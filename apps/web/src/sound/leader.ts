/**
 * p9-notification-sound (docs/design/p9-notification-sound.md §3): one console tab per browser plays sounds.
 *
 * Only a tab whose audio is unlocked (it had a gesture) competes, so the leader can always actually play. With the
 * Web Locks API (all current browsers) the leader holds an exclusive lock for as long as it wants to lead; when it
 * closes or stops, the browser hands the lock to the next waiting tab at once. Without Web Locks a localStorage
 * lease (renewed every 2 s, valid 6 s) does the same, with a short gap after a leader tab is closed.
 */

export interface LeaderElection {
  /** Starts competing; `onChange(true)` when this tab leads, `onChange(false)` when it stops leading. */
  start(onChange: (leader: boolean) => void): () => void;
}

export const LOCK_NAME = 'remyral-sound-leader';

interface LockManagerLike {
  request(name: string, options: { signal: AbortSignal }, cb: () => Promise<void>): Promise<unknown>;
}

export function webLocksElection(locks: LockManagerLike, name: string = LOCK_NAME): LeaderElection {
  return {
    start(onChange) {
      const abort = new AbortController();
      let release: (() => void) | null = null;
      let stopped = false;
      locks
        .request(name, { signal: abort.signal }, () => {
          if (stopped) return Promise.resolve();
          onChange(true);
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => undefined); // AbortError when stopped while waiting
      return () => {
        if (stopped) return;
        stopped = true;
        if (release) {
          release();
          onChange(false);
        } else abort.abort();
      };
    },
  };
}

export const LEASE_KEY = 'remyral.sound.leader';
export const LEASE_RENEW_MS = 2_000;
export const LEASE_TTL_MS = 6_000;

interface Lease {
  readonly tab: string;
  readonly until: number;
}

function readLease(storage: Storage): Lease | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(LEASE_KEY) ?? 'null');
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    return typeof o.tab === 'string' && typeof o.until === 'number' ? { tab: o.tab, until: o.until } : null;
  } catch {
    return null;
  }
}

export function storageLeaseElection(
  storage: Storage,
  tabId: string,
  now: () => number = Date.now,
): LeaderElection {
  return {
    start(onChange) {
      let leader = false;
      const tick = (): void => {
        const t = now();
        const lease = readLease(storage);
        if (lease === null || lease.until < t || lease.tab === tabId) {
          try {
            storage.setItem(LEASE_KEY, JSON.stringify({ tab: tabId, until: t + LEASE_TTL_MS }));
          } catch {
            // storage unavailable: nobody can coordinate, so this tab does not lead
          }
        }
        // Read back: of two tabs writing at once, the last write wins and only that tab leads.
        const mine = readLease(storage)?.tab === tabId;
        if (mine !== leader) {
          leader = mine;
          onChange(mine);
        }
      };
      tick();
      const timer = setInterval(tick, LEASE_RENEW_MS);
      return () => {
        clearInterval(timer);
        if (readLease(storage)?.tab === tabId) {
          try {
            storage.removeItem(LEASE_KEY);
          } catch {
            // expires on its own
          }
        }
        if (leader) {
          leader = false;
          onChange(false);
        }
      };
    },
  };
}

/** No Web Locks and no storage: nothing to coordinate with, so this tab leads (a rare double sound beats none). */
const alone: LeaderElection = {
  start(onChange) {
    onChange(true);
    return () => {
      onChange(false);
    };
  },
};

export function browserElection(): LeaderElection {
  const locks =
    typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockManagerLike }).locks;
  if (locks && typeof locks.request === 'function') return webLocksElection(locks);
  try {
    if (typeof localStorage !== 'undefined') {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());
      return storageLeaseElection(localStorage, id);
    }
  } catch {
    // blocked storage
  }
  return alone;
}
