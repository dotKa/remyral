/**
 * Service worker decisions as pure functions (docs/design/p8-pwa.md §2), unit-tested in
 * test/sw-logic.test.ts and bundled into `/sw.js` by `pwa-plugin.ts`. This module must not import anything
 * (the worker is a classic script without imports), and the app bundle must not import it either.
 *
 * Caching rule: only the hashed static shell (JS/CSS/fonts under /assets/ from this build) and the offline
 * page are cached. Navigations always go to the network (the HTML references the current bundles);
 * `/api/*`, worker and hook paths, non-GET requests and other origins are never intercepted, so no
 * authenticated or session-bound response can ever end up in Cache Storage.
 */

export const CACHE_PREFIX = 'remyral-shell-';
export const OFFLINE_URL = '/offline.html';
export const DEFAULT_ICON = '/icon-192.png';
export const BADGE_ICON = '/badge-96.png';

/** Messages between page and worker. */
export const MSG_SKIP_WAITING = 'remyral:skip-waiting';
export const MSG_PUSH = 'remyral:push';
export const MSG_NAVIGATE = 'remyral:navigate';

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Caches of older builds (deleted when a new worker activates). Foreign caches are left alone. */
export function staleCaches(keys: readonly string[], version: string): string[] {
  return keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== cacheName(version));
}

export type RequestRoute =
  /** A page navigation: network first, the offline page when the network fails. */
  | 'navigate'
  /** A precached shell file: cache first. */
  | 'shell'
  /** Not ours to handle: the browser does what it would do without a worker. */
  | 'bypass';

/** Paths that belong to the master (or are not part of the static site) and are never intercepted. */
const NEVER = /^\/(api|v1)(\/|$)/;

export function routeRequest(
  req: { readonly method: string; readonly url: string; readonly mode: string },
  origin: string,
  precache: ReadonlySet<string>,
): RequestRoute {
  if (req.method !== 'GET') return 'bypass';
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return 'bypass';
  }
  if (u.origin !== origin || NEVER.test(u.pathname)) return 'bypass';
  if (req.mode === 'navigate') return 'navigate';
  // Query strings never select a precached file (e.g. cache-busting or tracking parameters).
  if (u.search === '' && precache.has(u.pathname)) return 'shell';
  return 'bypass';
}

/** Files of this build worth precaching: content-hashed bundles and fonts under /assets/ (no source maps). */
export function precacheList(files: readonly string[], shell: readonly string[]): string[] {
  const hashed = files.filter(
    (f) => /^assets\/[^/]+\.(js|css|woff2?|svg|png)$/.test(f) && !f.endsWith('.map'),
  );
  return [...new Set([...shell, ...hashed.map((f) => `/${f}`)])].sort();
}

// --------------------------------------------------------------------------------------------- push

export interface ShownNotification {
  readonly title: string;
  readonly options: {
    readonly body: string;
    readonly tag: string;
    readonly icon: string;
    readonly badge: string;
    readonly timestamp: number;
    readonly requireInteraction: boolean;
    readonly data: { readonly link: string };
  };
}

const LINK = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

/** Console-relative path or `/` — never another origin, a protocol-relative URL or a script URL. */
export function safeLink(value: unknown): string {
  return typeof value === 'string' && LINK.test(value) ? value : '/';
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/**
 * Turns a push message into the notification to show. Every push must show one (browsers revoke the
 * permission of sites that push silently — iOS after three), so an unreadable payload becomes a generic
 * notification that opens the console. The payload format is the master's PushPayload (v1).
 */
export function notificationFromPush(raw: string | null): ShownNotification {
  let p: Record<string, unknown> = {};
  if (raw !== null && raw.length <= 4096) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && (parsed as { v?: unknown }).v === 1) {
        p = parsed as Record<string, unknown>;
      }
    } catch {
      p = {};
    }
  }
  const id = typeof p.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(p.id) ? p.id : 'remyral';
  const ts = typeof p.ts === 'number' && Number.isFinite(p.ts) ? p.ts : Date.now();
  return {
    title: text(p.title, 80) || 'Remyral',
    options: {
      body: text(p.body, 180) || 'You have a new notification.',
      tag: id,
      icon: DEFAULT_ICON,
      badge: BADGE_ICON,
      timestamp: ts,
      // Decisions wait for the user (approvals), everything else may be dismissed by the system.
      requireInteraction: p.kind === 'approval.requested' || p.kind === 'deploy.waiting',
      data: { link: safeLink(p.link) },
    },
  };
}

/** The URL a notification click opens (same origin, console-relative path). */
export function clickTarget(data: unknown, origin: string): string {
  const link = safeLink(typeof data === 'object' && data !== null ? (data as { link?: unknown }).link : null);
  return new URL(link, origin).href;
}

// ------------------------------------------------------------------------------- p9-notification-sound

/** How long a push waits for an open console tab to say it plays the sound itself. */
export const PUSH_SOUND_TIMEOUT_MS = 400;

const KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The notification id and kind of a push (for the page's in-app sound); null fields when absent or malformed. */
export function pushSoundInfo(raw: string | null): {
  readonly id: string | null;
  readonly kind: string | null;
} {
  if (raw === null || raw.length > 4096) return { id: null, kind: null };
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null || (p as { v?: unknown }).v !== 1)
      return { id: null, kind: null };
    const o = p as Record<string, unknown>;
    return {
      id: typeof o.id === 'string' && ID.test(o.id) ? o.id : null,
      kind: typeof o.kind === 'string' && KIND.test(o.kind) ? o.kind : null,
    };
  } catch {
    return { id: null, kind: null };
  }
}

export interface PortLike {
  onmessage: ((e: { readonly data: unknown }) => void) | null;
  close(): void;
}

export interface SoundClient {
  postMessage(message: unknown, transfer: unknown[]): void;
}

/**
 * Tells every open console window about the push (the bell refreshes) and asks whether one of them plays the
 * in-app sound. Resolves true as soon as one answers `{ handled: true }`; false when all answered no, or nobody
 * answered within `timeoutMs` (an older console build) — then the system notification keeps its own sound.
 */
export function askClientsForSound(
  clients: readonly SoundClient[],
  message: { readonly type: string; readonly id: string | null; readonly kind: string | null },
  makeChannel: () => { readonly port1: PortLike; readonly port2: unknown },
  timeoutMs: number = PUSH_SOUND_TIMEOUT_MS,
): Promise<boolean> {
  if (clients.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let waiting = clients.length;
    const ports: PortLike[] = [];
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      for (const p of ports) {
        p.onmessage = null;
        p.close();
      }
      resolve(v);
    };
    const answered = (): void => {
      waiting--;
      if (waiting === 0) finish(false);
    };
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    for (const c of clients) {
      const ch = makeChannel();
      ports.push(ch.port1);
      ch.port1.onmessage = (e) => {
        const d = e.data;
        if (typeof d === 'object' && d !== null && (d as { handled?: unknown }).handled === true)
          finish(true);
        else answered();
      };
      try {
        c.postMessage(message, [ch.port2]);
      } catch {
        answered();
      }
    }
  });
}
