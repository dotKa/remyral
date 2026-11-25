import { useEffect } from 'react';
import { getChatUnread } from '../api/chat';
import { listNotifications } from '../api/notifications';
import { onInvalidate } from '../lib/invalidate';
import { publishNotificationPage } from '../lib/notificationFeed';
import { OWN_ACTION_EVENT } from '../lib/ownActions';
import { setPushSoundHandler } from '../pwa/serviceWorker';
import { browserSoundChannel, type SoundChannel } from './channel';
import { type SeenNotification, SoundGate, SoundWatcher } from './controller';
import { browserElection, type LeaderElection } from './leader';
import { type SoundOutput, soundOutput } from './output';
import { CATEGORY_VARIANT, categoryOn, readSoundSettings } from './settings';

/**
 * p9-notification-sound (docs/design/p9-notification-sound.md): wires the sound into the signed-in console.
 *
 * Every tab arms its audio on the first gesture and forwards hints (a chat change seen here, the user's own action,
 * user activity) to the other tabs. The tab whose audio runs and that wins the election (one per browser) is the
 * leader: it checks the notifications and the chat unread count every `POLL_MS` — also while hidden, that is the
 * point, but only while the user used the console within `ACTIVE_WINDOW_MS` (hidden-tab checks must not keep an
 * idle session alive for ever) — and answers the service worker's push question.
 */

export const POLL_MS = 30_000;
export const ACTIVE_WINDOW_MS = 15 * 60_000;
const ACTIVITY_POST_MS = 10_000;
const NOTIFICATION_PAGE = 20;
/** Notification checks after the user's own action (inside OWN_ACTION_GRACE_MS). */
export const ECHO_CHECKS_MS: readonly number[] = [3_000, 8_000];

export interface SoundEnv {
  readonly output: SoundOutput;
  readonly election: LeaderElection;
  readonly channel: SoundChannel;
  readonly notifications: () => Promise<readonly SeenNotification[]>;
  readonly chatUnread: () => Promise<number>;
  readonly now?: () => number;
}

export function browserSoundEnv(): SoundEnv {
  return {
    output: soundOutput(),
    election: browserElection(),
    channel: browserSoundChannel(),
    notifications: async () => {
      const { items } = await listNotifications({ limit: NOTIFICATION_PAGE });
      // p17-toasts-shortcuts: the toast preview sees the leader's checks too.
      publishNotificationPage(items);
      return items;
    },
    chatUnread: async () => (await getChatUnread()).total,
  };
}

/** Starts the sound for `userId` in this tab; returns the stop function. */
export function startNotificationSound(userId: string, env: SoundEnv): () => void {
  const now = env.now ?? Date.now;
  const settings = (): ReturnType<typeof readSoundSettings> => readSoundSettings(userId);
  const { output, channel } = env;
  let lastActivity = now();
  let lastActivityPost = Number.NEGATIVE_INFINITY;
  let lastOwnAction: number | null = null;
  let leader: { watcher: SoundWatcher; timer: ReturnType<typeof setInterval> } | null = null;
  let stopElection: (() => void) | null = null;
  let stopped = false;

  const shouldCheck = (): boolean =>
    document.visibilityState !== 'hidden' || now() - lastActivity < ACTIVE_WINDOW_MS;

  const check = (): void => {
    if (!leader || !shouldCheck()) return;
    const s = settings();
    if (categoryOn(s, 'notifications') || categoryOn(s, 'approvals'))
      void leader.watcher.checkNotifications();
    if (categoryOn(s, 'chat')) void leader.watcher.checkChat();
  };

  const lead = (isLeader: boolean): void => {
    if (isLeader && !leader && !stopped) {
      const gate = new SoundGate({
        settings,
        ready: () => output.ready(),
        play: (c) => output.play(CATEGORY_VARIANT[c], settings().volume),
        now,
      });
      const watcher = new SoundWatcher(
        gate,
        { notifications: env.notifications, chatUnread: env.chatUnread },
        now,
      );
      if (lastOwnAction !== null) watcher.noteOwnAction(lastOwnAction);
      leader = { watcher, timer: setInterval(check, POLL_MS) };
      check(); // the baseline: nothing sounds for what was already there
    } else if (!isLeader && leader) {
      clearInterval(leader.timer);
      leader.watcher.dispose();
      leader = null;
    }
  };

  const compete = (): void => {
    if (stopElection || stopped) return;
    stopElection = env.election.start(lead);
  };

  // After the user acts, look at the notifications again soon, so that the echo of the action is seen (and stays
  // silent) inside the grace window rather than at the next 30 s check.
  let echoTimers: ReturnType<typeof setTimeout>[] = [];
  const ownAction = (at: number): void => {
    lastOwnAction = at;
    if (!leader) return;
    leader.watcher.noteOwnAction(at);
    for (const t of echoTimers) clearTimeout(t);
    echoTimers = ECHO_CHECKS_MS.map((ms) =>
      setTimeout(() => {
        if (leader) void leader.watcher.checkNotifications();
      }, ms),
    );
  };

  const onActivity = (): void => {
    const t = now();
    lastActivity = t;
    if (t - lastActivityPost >= ACTIVITY_POST_MS) {
      lastActivityPost = t;
      channel.post('activity');
    }
  };

  const onLocalOwnAction = (): void => {
    ownAction(now());
    channel.post('own-action');
  };

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') check();
  };

  const offChannel = channel.subscribe((signal) => {
    if (signal === 'activity') lastActivity = now();
    else if (signal === 'own-action') ownAction(now());
    else if (leader && categoryOn(settings(), 'chat')) void leader.watcher.checkChat();
  });
  const offChat = onInvalidate(['chat'], () => {
    if (leader) {
      if (categoryOn(settings(), 'chat')) void leader.watcher.checkChat();
    } else channel.post('chat');
  });
  setPushSoundHandler((info) => (leader ? leader.watcher.onPush(info) : false));
  window.addEventListener(OWN_ACTION_EVENT, onLocalOwnAction);
  document.addEventListener('pointerdown', onActivity, { capture: true, passive: true });
  document.addEventListener('keydown', onActivity, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisible);

  // Only a tab that can play competes for leadership.
  const offReady = output.onReady(compete);
  output.arm();
  if (output.ready()) compete();

  return () => {
    stopped = true;
    offReady();
    offChannel();
    offChat();
    setPushSoundHandler(null);
    window.removeEventListener(OWN_ACTION_EVENT, onLocalOwnAction);
    document.removeEventListener('pointerdown', onActivity, { capture: true });
    document.removeEventListener('keydown', onActivity, { capture: true });
    document.removeEventListener('visibilitychange', onVisible);
    for (const t of echoTimers) clearTimeout(t);
    stopElection?.();
    stopElection = null;
    lead(false);
  };
}

/** Mounted once in the signed-in shell. */
export function useNotificationSound(userId: string | null): void {
  useEffect(() => {
    if (userId === null) return;
    return startNotificationSound(userId, browserSoundEnv());
  }, [userId]);
}
