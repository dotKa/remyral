import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import type { Messages } from '@remyral/i18n';
import { type AppNotification, listNotifications, markRead } from '../../api/notifications';
import { useT } from '../../i18n/I18nProvider';
import {
  lastNotificationPageAt,
  onNotificationPage,
  openBell,
  publishNotificationPage,
} from '../../lib/notificationFeed';
import { OWN_ACTION_EVENT } from '../../lib/ownActions';
import { PUSH_EVENT } from '../../pwa/serviceWorker';
import { POLL_MS } from '../../shell/notificationPoll';
import { browserSoundChannel, type SoundChannel } from '../../sound/channel';
import { APPROVAL_KINDS, OWN_ACTION_GRACE_MS } from '../../sound/controller';
import { readSoundSettings } from '../../sound/settings';
import { getToasts, toast, type ToastTone } from './store';

/**
 * p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §2.5): a toast preview when a new notification arrives —
 * its title, a short line and "Aç" to its target; several at once become one "3 yeni bildirim" toast (a later burst
 * while it is still on screen adds to it).
 *
 * Source: the notification pages this tab reads anyway (lib/notificationFeed — the bell's 30 s poll while visible, on
 * becoming visible and on a push; the sound leader's checks); the preview reads a page itself only when none arrived
 * for a poll interval (a screen without a bell). The "Senden bekleyenler" stream (`/ops-thread`) needs no source of
 * its own: every card that waits for the person (approval, deploy, question…) comes with its notification, and the
 * needs screen marks the ones it shows as read — a read notification is never previewed.
 *
 * Never previewed: the first page (the baseline: what was there before), notifications already read, the echo of the
 * person's own action (anything new within OWN_ACTION_GRACE_MS of a mutation sent from this browser — the same rule
 * and the same hints as the notification sound, apps/web/src/sound), a notification whose link is the page the person
 * is on, and everything while "Yeni bildirimleri önizle" is off (Settings → Bildirimler, per browser).
 */

export const PREVIEW_TOAST_ID = 'notification-preview';
/** Checks after the person's own action, so its echo is seen (and stays silent) inside the grace window. */
export const PREVIEW_ECHO_CHECKS_MS: readonly number[] = [3_000, 8_000];
/** A shared page this recent makes the preview's own check unnecessary. */
const FRESH_MS = 1_500;
const SEEN_CAP = 500;

export interface PreviewDeps {
  /** Whether previews are on (read at each arrival: a settings change applies at once). */
  readonly enabled: () => boolean;
  /** The path the person is looking at (a notification that links there is not previewed). */
  readonly here: () => string;
  readonly show: (fresh: readonly AppNotification[]) => void;
  readonly now?: () => number;
}

/** What is new on a page of notifications, and whether it may be previewed. Pure; one per tab. */
export class PreviewWatcher {
  private readonly seen = new Set<string>();
  private baseline = false;
  private lastOwnAction = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: PreviewDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  noteOwnAction(at: number = this.now()): void {
    this.lastOwnAction = Math.max(this.lastOwnAction, at);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_CAP) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }

  /** A page arrived; returns what was previewed (oldest first). */
  see(items: readonly AppNotification[]): readonly AppNotification[] {
    const fresh = items.filter((n) => !this.seen.has(n.id) && n.readAt === null);
    for (const n of items) this.remember(n.id);
    if (!this.baseline) {
      this.baseline = true;
      return [];
    }
    if (fresh.length === 0) return [];
    if (this.now() - this.lastOwnAction < OWN_ACTION_GRACE_MS) return [];
    if (!this.deps.enabled()) return [];
    const here = this.deps.here();
    const shown = fresh
      .filter((n) => n.link === null || n.link.split(/[?#]/)[0] !== here)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (shown.length > 0) this.deps.show(shown);
    return shown;
  }
}

function toneOf(n: AppNotification): ToastTone {
  if (n.severity === 'critical') return 'error';
  if (n.severity === 'warning' || APPROVAL_KINDS.has(n.kind)) return 'warning';
  return 'info';
}

const RANK: Readonly<Record<ToastTone, number>> = { info: 0, success: 0, warning: 1, error: 2 };

function firstLine(s: string, max = 140): string {
  const line = (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function readThen(n: AppNotification): void {
  if (n.readAt === null) void markRead(n.id).catch(() => undefined);
}

/**
 * Shows (or grows) the preview toast. `previous`: the notifications the preview toast on screen already counts (they
 * add up while it is open); returns what it counts now.
 */
export function showPreview(
  fresh: readonly AppNotification[],
  previous: readonly AppNotification[],
  w: Messages['shell']['toast']['preview'],
): readonly AppNotification[] {
  const all = [...previous.filter((p) => !fresh.some((f) => f.id === p.id)), ...fresh];
  const newest = all[all.length - 1];
  if (newest === undefined) return previous;
  const tone = all.map(toneOf).reduce<ToastTone>((a, b) => (RANK[b] > RANK[a] ? b : a), 'info');
  if (all.length === 1) {
    toast({
      id: PREVIEW_TOAST_ID,
      tone,
      icon: 'bell',
      title: newest.title,
      description: firstLine(newest.body),
      testId: 'dy-notification-preview',
      actions:
        newest.link === null
          ? []
          : [
              {
                label: w.open,
                to: newest.link,
                testId: 'dy-notification-preview-open',
                onClick: () => {
                  readThen(newest);
                },
              },
            ],
    });
    return all;
  }
  const links = new Set(all.map((n) => n.link));
  const oneLink = links.size === 1 ? newest.link : null;
  toast({
    id: PREVIEW_TOAST_ID,
    tone,
    icon: 'bell',
    title: w.many({ n: all.length }),
    description: w.latest({ title: newest.title }),
    testId: 'dy-notification-preview',
    actions: [
      oneLink !== null
        ? {
            label: w.open,
            to: oneLink,
            testId: 'dy-notification-preview-open',
            onClick: () => {
              for (const n of all) readThen(n);
            },
          }
        : {
            label: w.showAll,
            testId: 'dy-notification-preview-all',
            onClick: openBell,
          },
    ],
  });
  return all;
}

export interface PreviewEnv {
  readonly fetchPage: () => Promise<readonly AppNotification[]>;
  readonly channel: SoundChannel;
}

function browserPreviewEnv(): PreviewEnv {
  return {
    fetchPage: async () => (await listNotifications({ limit: 20 })).items,
    channel: browserSoundChannel(),
  };
}

/** Mounted once in the Diyalog shell for the signed-in user. */
export function useNotificationPreview(userId: string | null, env?: PreviewEnv): void {
  const w = useT().shell.toast.preview;
  const words = useRef(w);
  words.current = w;
  const { pathname } = useLocation();
  const here = useRef(pathname);
  here.current = pathname;
  const envRef = useRef(env);

  useEffect(() => {
    if (userId === null) return;
    const e = envRef.current ?? browserPreviewEnv();
    let counted: readonly AppNotification[] = [];
    const watcher = new PreviewWatcher({
      enabled: () => readSoundSettings(userId).previews,
      here: () => here.current,
      show: (fresh) => {
        const open = getToasts().some((t) => t.id === PREVIEW_TOAST_ID && t.open);
        counted = showPreview(fresh, open ? counted : [], words.current);
      },
    });
    let busy = false;
    const fetchIfStale = (maxAge: number): void => {
      if (busy || Date.now() - lastNotificationPageAt() < maxAge) return;
      busy = true;
      e.fetchPage().then(
        (items) => {
          busy = false;
          publishNotificationPage(items);
        },
        () => {
          busy = false; // a background check: silent, the next one catches up
        },
      );
    };
    const off = onNotificationPage((items) => {
      watcher.see(items);
    });
    // Its own check only when no bell (or sound leader) shared a page for a poll interval.
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchIfStale(POLL_MS - FRESH_MS);
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') fetchIfStale(FRESH_MS);
    };
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    const onPush = (): void => {
      // The bell re-reads at once on a push; look only if it did not.
      if (pushTimer !== null) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        fetchIfStale(FRESH_MS);
      }, FRESH_MS);
    };
    let echoTimers: ReturnType<typeof setTimeout>[] = [];
    const ownAction = (): void => {
      watcher.noteOwnAction(Date.now());
      for (const t of echoTimers) clearTimeout(t);
      echoTimers = PREVIEW_ECHO_CHECKS_MS.map((ms) =>
        setTimeout(() => {
          fetchIfStale(FRESH_MS);
        }, ms),
      );
    };
    const offChannel = e.channel.subscribe((signal) => {
      if (signal === 'own-action') ownAction();
    });
    window.addEventListener(OWN_ACTION_EVENT, ownAction);
    window.addEventListener(PUSH_EVENT, onPush);
    document.addEventListener('visibilitychange', onVisible);
    // The baseline: what is there now is history.
    fetchIfStale(FRESH_MS);
    return () => {
      off();
      offChannel();
      clearInterval(timer);
      if (pushTimer !== null) clearTimeout(pushTimer);
      for (const t of echoTimers) clearTimeout(t);
      window.removeEventListener(OWN_ACTION_EVENT, ownAction);
      window.removeEventListener(PUSH_EVENT, onPush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);
}
