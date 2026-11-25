/**
 * p9-notification-sound: hints from the other console tabs of this browser to the tab that plays sounds (the
 * leader). Separate from the auth channel (`remyral-auth`). Messages carry no data — only "look again" hints and
 * "the user did something", so the leader re-asks the master instead of trusting a message.
 */
export type SoundSignal =
  /** A tab saw a chat change (`invalidate('chat')`): check the unread count now. */
  | 'chat'
  /** A tab sent a mutation (the user acted): notifications right after it are the echo of the user's own action. */
  | 'own-action'
  /** The user used a console tab (keeps the hidden-tab check alive, §5 of the design note). */
  | 'activity';

export interface SoundChannel {
  post(signal: SoundSignal): void;
  subscribe(fn: (signal: SoundSignal) => void): () => void;
}

export const SOUND_CHANNEL_NAME = 'remyral-sound';

const SIGNALS: readonly string[] = ['chat', 'own-action', 'activity'];

function isSignal(v: unknown): v is SoundSignal {
  return typeof v === 'string' && SIGNALS.includes(v);
}

/** The browser's BroadcastChannel (never delivers to the sending object), or a no-op without one. */
export function browserSoundChannel(): SoundChannel {
  if (typeof BroadcastChannel === 'undefined')
    return { post: () => undefined, subscribe: () => () => undefined };
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(SOUND_CHANNEL_NAME);
  } catch {
    ch = null;
  }
  return {
    post(signal) {
      try {
        ch?.postMessage({ type: signal });
      } catch {
        // best effort: the leader also polls
      }
    },
    subscribe(fn) {
      const onMessage = (e: MessageEvent<unknown>): void => {
        const d = e.data;
        if (typeof d === 'object' && d !== null && 'type' in d && isSignal(d.type)) fn(d.type);
      };
      ch?.addEventListener('message', onMessage);
      return () => {
        ch?.removeEventListener('message', onMessage);
        ch?.close();
        ch = null;
      };
    },
  };
}

/** Several "tabs" in one document (tests). */
export function memorySoundChannel(): { tab(): SoundChannel } {
  const listeners = new Set<{ owner: object; fn: (s: SoundSignal) => void }>();
  return {
    tab() {
      const owner = {};
      return {
        post(signal) {
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
