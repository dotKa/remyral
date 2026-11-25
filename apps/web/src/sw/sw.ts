/**
 * The console's service worker (`/sw.js`, docs/design/p8-pwa.md §2). Built by pwa-plugin.ts as a classic
 * script with the build's manifest (version + precache list) injected in place of the placeholder below.
 *
 * - install: precache the hashed shell of this build (no skipWaiting: an update waits until the page asks);
 * - activate: delete the caches of older builds;
 * - fetch: navigations network-first with the offline page as fallback; precached files cache-first;
 *   everything else — above all `/api/*` — is not intercepted;
 * - push: show the notification (every push shows one), tell open pages to refresh their bell; silent when an
 *   open page plays the in-app sound instead (p9-notification-sound);
 * - notificationclick: focus an open console window on the notification's link, or open one.
 */
import {
  askClientsForSound,
  cacheName,
  clickTarget,
  MSG_NAVIGATE,
  MSG_PUSH,
  MSG_SKIP_WAITING,
  notificationFromPush,
  OFFLINE_URL,
  type PortLike,
  pushSoundInfo,
  routeRequest,
  staleCaches,
} from './logic';

// Minimal service-worker typings (the app's tsconfig uses the DOM lib, not WebWorker).
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Promise<Response>): void;
}
interface PushEvent extends ExtendableEvent {
  readonly data: { text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification;
}
interface MessageEventLike extends ExtendableEvent {
  readonly data: unknown;
}
interface WindowClientLike {
  readonly url: string;
  focus(): Promise<WindowClientLike>;
  postMessage(message: unknown, transfer?: unknown[]): void;
}
interface WorkerScope {
  readonly location: Location;
  readonly registration: {
    showNotification(title: string, options: NotificationOptions & Record<string, unknown>): Promise<void>;
  };
  readonly clients: {
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<WindowClientLike | null>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: never) => void): void;
}

declare const self: WorkerScope;

interface Manifest {
  readonly version: string;
  readonly precache: readonly string[];
}

// Replaced at build time by pwa-plugin.ts with the JSON of the build's Manifest.
const MANIFEST = JSON.parse('__REMYRAL_SW_MANIFEST__') as Manifest;
const CACHE = cacheName(MANIFEST.version);
const PRECACHE = new Set(MANIFEST.precache);

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    // `cache: 'reload'` bypasses the HTTP cache so the shell is exactly this build's.
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(
          [...PRECACHE].map((path) => new Request(path, { cache: 'reload', credentials: 'omit' })),
        ),
      ),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(staleCaches(keys, MANIFEST.version).map((k) => caches.delete(k)))),
  );
});

self.addEventListener('message', (event: MessageEventLike) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    (event.data as { type?: unknown }).type === MSG_SKIP_WAITING
  ) {
    event.waitUntil(self.skipWaiting());
  }
});

async function navigate(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    return offline ?? new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

async function shell(request: Request): Promise<Response> {
  const hit = await caches.match(request, { cacheName: CACHE });
  return hit ?? fetch(request);
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const route = routeRequest(event.request, self.location.origin, PRECACHE);
  if (route === 'navigate') event.respondWith(navigate(event.request));
  else if (route === 'shell') event.respondWith(shell(event.request));
  // 'bypass': no respondWith — the request goes to the network exactly as without a worker.
});

self.addEventListener('push', (event: PushEvent) => {
  let raw: string | null;
  try {
    raw = event.data?.text() ?? null;
  } catch {
    raw = null;
  }
  const n = notificationFromPush(raw);
  const info = pushSoundInfo(raw);
  // p9-notification-sound: open console windows refresh their bell, and the one that plays sounds answers that it
  // plays the in-app chime — then the system notification is shown silently (no double sound). No answer within
  // PUSH_SOUND_TIMEOUT_MS (no window, sound off, audio not unlocked, an older build): the system sound stays.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) =>
        askClientsForSound(
          list,
          { type: MSG_PUSH, id: info.id, kind: info.kind },
          () => new MessageChannel() as unknown as { port1: PortLike; port2: unknown },
        ),
      )
      .catch(() => false)
      .then((handled) => self.registration.showNotification(n.title, { ...n.options, silent: handled })),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const target = clickTarget(event.notification.data, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        // The page routes itself (works for windows this worker does not control yet, unlike navigate()).
        open.postMessage({ type: MSG_NAVIGATE, link: new URL(target).pathname + new URL(target).search });
        await open.focus();
        return;
      }
      await self.clients.openWindow(target);
    }),
  );
});
