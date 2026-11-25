/**
 * p9-stepup-rotation-logout: tells the other console tabs of this browser that the session changed.
 *
 * The cookies (`__Host-ras`, `__Host-ras-csrf`) are shared by every tab and the API client reads the CSRF
 * token from the cookie on each request, so after a step-up in tab A, tab B's next request already carries
 * the rotated session and token. What tab B does not know is its *state*: that it is now stepped up, or
 * that tab A signed out. This channel carries only that hint — never a token, a code or a user id — and the
 * receiving tab always asks the master (`GET /auth/session`) instead of trusting the message.
 */
export type AuthSignal = 'session-changed' | 'signed-out';

export interface AuthChannel {
  post(signal: AuthSignal): void;
  /** Returns the unsubscribe function. */
  subscribe(fn: (signal: AuthSignal) => void): () => void;
}

export const AUTH_CHANNEL_NAME = 'remyral-auth';

function isSignal(v: unknown): v is AuthSignal {
  return v === 'session-changed' || v === 'signed-out';
}

/** The browser's BroadcastChannel, or null where it does not exist (older browsers, some test setups). */
export function browserAuthChannel(): AuthChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  // One object per tab for sending and receiving: BroadcastChannel never delivers a message to the object
  // that posted it, so a tab does not react to its own signal.
  let ch: BroadcastChannel | null = null;
  const channel = (): BroadcastChannel => (ch ??= new BroadcastChannel(AUTH_CHANNEL_NAME));
  let subscribers = 0;
  return {
    post(signal) {
      try {
        if (ch) ch.postMessage({ type: signal });
        else {
          const once = new BroadcastChannel(AUTH_CHANNEL_NAME);
          once.postMessage({ type: signal });
          once.close();
        }
      } catch {
        // best effort: the other tabs re-check on their next 401 anyway
      }
    },
    subscribe(fn) {
      const c = channel();
      subscribers++;
      const onMessage = (e: MessageEvent<unknown>): void => {
        const d = e.data;
        if (typeof d === 'object' && d !== null && 'type' in d && isSignal(d.type)) fn(d.type);
      };
      c.addEventListener('message', onMessage);
      return () => {
        c.removeEventListener('message', onMessage);
        subscribers--;
        if (subscribers === 0 && ch === c) {
          c.close();
          ch = null;
        }
      };
    },
  };
}

/** An in-memory channel shared by several providers (tests: two "tabs" in one document). */
export function memoryAuthChannel(): { tab(): AuthChannel } {
  const listeners = new Set<{ owner: object; fn: (s: AuthSignal) => void }>();
  return {
    tab() {
      const owner = {};
      return {
        post(signal) {
          // Like BroadcastChannel: every subscriber except the sender, asynchronously.
          for (const l of [...listeners]) {
            if (l.owner !== owner)
              queueMicrotask(() => {
                l.fn(signal);
              });
          }
        },
        subscribe(fn) {
          const entry = { owner, fn };
          listeners.add(entry);
          return () => {
            listeners.delete(entry);
          };
        },
      };
    },
  };
}
