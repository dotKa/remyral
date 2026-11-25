import { ApiError } from '../api/client';
import {
  type NotificationKind,
  registerPushSubscription,
  type SubscriptionJson,
  unsubscribePushEndpoint,
} from '../api/notifications';

/** Kinds turned on for push when a user enables push for the first time (decisions and failures). */
export const RECOMMENDED_PUSH_KINDS: readonly NotificationKind[] = [
  'approval.requested',
  'approval.expiring',
  'job.failed',
  'deploy.waiting',
  'automation.waiting',
];

/**
 * p8-pwa (docs/design/p8-pwa.md §3): this browser's push subscription. The browser holds it (PushManager
 * on the service worker registration); the master holds a copy bound to the signed-in user. Turning push on
 * asks for the notification permission (only from a tap), subscribes with the master's VAPID key and
 * registers the subscription (a new device needs a step-up — the caller wraps the call).
 *
 * iOS/iPadOS: Web Push only works for a web app added to the Home Screen (iOS 16.4+); in Safari tabs
 * PushManager is missing, so `pushSupport` reports `ios-needs-install`.
 */
export type PushSupport =
  /** PushManager + Notification available. */
  | 'supported'
  /** iPhone/iPad in a browser tab: install to the Home Screen first. */
  | 'ios-needs-install'
  /** No Web Push in this browser. */
  | 'unsupported';

export interface PushEnv {
  readonly win: Window;
  readonly nav: Navigator;
}

function env(): PushEnv {
  return { win: window, nav: navigator };
}

/** iPhone, iPod, iPad — including iPadOS, which reports a Mac user agent but has touch. */
export function isIos(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>): boolean {
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
  );
}

/** Running as an installed app (home-screen / standalone window). */
export function isStandalone(win: Window, nav: Navigator): boolean {
  const iosStandalone = (nav as Navigator & { standalone?: boolean }).standalone === true;
  return (
    iosStandalone ||
    (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches)
  );
}

export function pushSupport(e: PushEnv = env()): PushSupport {
  const has = 'serviceWorker' in e.nav && 'PushManager' in e.win && 'Notification' in e.win;
  if (has) return 'supported';
  if (isIos(e.nav) && !isStandalone(e.win, e.nav)) return 'ios-needs-install';
  return 'unsupported';
}

export function permission(e: PushEnv = env()): NotificationPermission | 'unsupported' {
  return 'Notification' in e.win ? Notification.permission : 'unsupported';
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesEqual(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (a === null) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export function subscriptionJson(sub: PushSubscription): SubscriptionJson {
  const j = sub.toJSON();
  const p256dh = j.keys?.p256dh;
  const auth = j.keys?.auth;
  if (!j.endpoint || !p256dh || !auth) throw new Error('incomplete push subscription');
  return { endpoint: j.endpoint, keys: { p256dh, auth } };
}

async function registration(e: PushEnv): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in e.nav)) return null;
  // `ready` never resolves without a registration (dev server); do not wait forever.
  const reg = await e.nav.serviceWorker.getRegistration('/');
  return reg ?? null;
}

export async function currentSubscription(e: PushEnv = env()): Promise<PushSubscription | null> {
  const reg = await registration(e);
  return reg ? reg.pushManager.getSubscription() : null;
}

export class PushSetupError extends Error {
  override readonly name = 'PushSetupError';
}

/**
 * Turns push on for this browser. Must run from a user gesture (the permission prompt). A subscription made
 * with another VAPID key (the operator rotated it) is replaced. `register` sends it to the master (wrapped
 * in the step-up flow by the caller).
 */
export async function enablePush(
  publicKey: string,
  register: (sub: SubscriptionJson) => Promise<unknown>,
  e: PushEnv = env(),
): Promise<void> {
  const reg = await registration(e);
  if (!reg) throw new PushSetupError('The app is still starting. Reload the page and try again.');
  const result = await Notification.requestPermission();
  if (result !== 'granted') {
    throw new PushSetupError(
      result === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser or system settings, then try again.'
        : 'Notifications were not allowed.',
    );
  }
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !bytesEqual(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await register(subscriptionJson(sub));
}

/** Turns push off here: the master forgets the subscription and the browser drops it. */
export async function disablePush(reason: 'user' | 'logout' = 'user', e: PushEnv = env()): Promise<void> {
  const sub = await currentSubscription(e);
  if (!sub) return;
  try {
    await unsubscribePushEndpoint(sub.endpoint, reason);
  } finally {
    await sub.unsubscribe().catch(() => false);
  }
}

/**
 * On every start of a signed-in console: refresh the master's copy (keeps it from going stale after 30
 * days). If the master does not know this subscription any more (revoked from the Devices page, every
 * session revoked, another account on this browser), a refresh would need a step-up — then the browser's
 * subscription is dropped instead, so the device stops showing as "on" here.
 */
export async function syncPush(publicKey: string | null, e: PushEnv = env()): Promise<'on' | 'off'> {
  if (pushSupport(e) !== 'supported' || permission(e) !== 'granted') return 'off';
  const sub = await currentSubscription(e);
  if (!sub) return 'off';
  if (publicKey === null || !bytesEqual(sub.options.applicationServerKey, base64UrlToBytes(publicKey))) {
    await sub.unsubscribe().catch(() => false);
    return 'off';
  }
  try {
    await registerPushSubscription(subscriptionJson(sub));
    return 'on';
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'step_up_required' || err.code === 'channel_unavailable')) {
      await sub.unsubscribe().catch(() => false);
      return 'off';
    }
    throw err;
  }
}
