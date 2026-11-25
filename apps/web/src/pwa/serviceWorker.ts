import { useSyncExternalStore } from 'react';

/**
 * p8-pwa (docs/design/p8-pwa.md §2): registers `/sw.js` in production builds and drives the update flow —
 * a new build installs in the background and waits; the page shows "new version available"; Reload asks the
 * waiting worker to take over and reloads once it controls the page. Never auto-reloads on its own (a form
 * or a step-up dialog may be open).
 *
 * The message types mirror src/sw/logic.ts (the app bundle must not import worker code; a unit test keeps
 * both in sync).
 */
export const SW_URL = '/sw.js';
export const MSG_SKIP_WAITING = 'remyral:skip-waiting';
export const MSG_PUSH = 'remyral:push';
export const MSG_NAVIGATE = 'remyral:navigate';
/** Window event fired when the worker received a push (the bell refreshes on it). */
export const PUSH_EVENT = 'remyral:push';
/** How often an open console checks for a new build. */
export const UPDATE_CHECK_MS = 60 * 60_000;

type Listener = () => void;

let waiting: ServiceWorker | null = null;
const listeners = new Set<Listener>();
let navigateHandler: ((path: string) => void) | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function setWaiting(w: ServiceWorker | null): void {
  waiting = w;
  emit();
}

export function updateReady(): boolean {
  return waiting !== null;
}

/** True while a new version is installed and waiting for the user's reload. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    updateReady,
    () => false,
  );
}

/** The router's navigate (a notification click focuses this window and asks it to open the link). */
export function setNavigateHandler(fn: ((path: string) => void) | null): void {
  navigateHandler = fn;
}

const PATH = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

/** p9-notification-sound: what the push was about (validated by the worker; re-checked here). */
export interface PushSoundInfo {
  readonly id: string | null;
  readonly kind: string | null;
}

/** Returns true when this tab plays the in-app sound for the push (the system notification is then silent). */
let pushSoundHandler: ((info: PushSoundInfo) => boolean) | null = null;

export function setPushSoundHandler(fn: ((info: PushSoundInfo) => boolean) | null): void {
  pushSoundHandler = fn;
}

const PUSH_ID = /^[A-Za-z0-9-]{1,64}$/;
const PUSH_KIND = /^[a-z][a-z0-9._-]{0,63}$/;

function answerSound(m: { id?: unknown; kind?: unknown }, port: MessagePort | undefined): void {
  if (!port) return;
  const ask = (): boolean => {
    try {
      return (
        pushSoundHandler?.({
          id: typeof m.id === 'string' && PUSH_ID.test(m.id) ? m.id : null,
          kind: typeof m.kind === 'string' && PUSH_KIND.test(m.kind) ? m.kind : null,
        }) ?? false
      );
    } catch {
      return false;
    }
  };
  const handled = ask();
  try {
    port.postMessage({ handled });
    port.close();
  } catch {
    // the worker stopped waiting
  }
}

/** Handles a message from the worker (exported for tests). `ports`: the reply port of a push (sound question). */
export function handleWorkerMessage(
  data: unknown,
  win: Window = window,
  ports: readonly MessagePort[] = [],
): void {
  if (typeof data !== 'object' || data === null) return;
  const m = data as { type?: unknown; link?: unknown; id?: unknown; kind?: unknown };
  if (m.type === MSG_PUSH) {
    win.dispatchEvent(new Event(PUSH_EVENT));
    answerSound(m, ports[0]);
  } else if (m.type === MSG_NAVIGATE && typeof m.link === 'string' && PATH.test(m.link))
    navigateHandler?.(m.link);
}

export interface RegisterEnv {
  readonly container: ServiceWorkerContainer | undefined;
  readonly doc: Document;
  readonly reload: () => void;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
}

function browserEnv(): RegisterEnv {
  return {
    container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    doc: document,
    reload: () => {
      window.location.reload();
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
  };
}

let reloadOnControllerChange = false;
/** Reload anyway when the waiting worker never takes over (it went redundant, or the browser ignored the ask). */
export const UPDATE_FALLBACK_MS = 4000;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

function clearFallback(): void {
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

export async function registerServiceWorker(
  env: RegisterEnv = browserEnv(),
): Promise<ServiceWorkerRegistration | null> {
  const c = env.container;
  if (!c) return null;
  c.addEventListener('message', (e: MessageEvent) => {
    handleWorkerMessage(e.data, window, e.ports);
  });
  c.addEventListener('controllerchange', () => {
    if (reloadOnControllerChange) {
      reloadOnControllerChange = false;
      clearFallback();
      env.reload();
    }
  });
  let reg: ServiceWorkerRegistration;
  try {
    // updateViaCache 'none': the browser always revalidates sw.js itself (nginx also sends no-cache).
    reg = await c.register(SW_URL, { scope: '/', updateViaCache: 'none' });
  } catch {
    return null; // e.g. private mode / disabled by policy: the console works without it.
  }
  // A worker that installed while no page was open is waiting already.
  if (reg.waiting && c.controller) setWaiting(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      // `installed` with an existing controller = an update (the very first install activates directly).
      if (w.state === 'installed' && c.controller) setWaiting(w);
    });
  });
  const check = (): void => {
    void reg.update().catch(() => undefined);
  };
  env.setInterval(check, UPDATE_CHECK_MS);
  env.doc.addEventListener('visibilitychange', () => {
    if (env.doc.visibilityState === 'visible') check();
  });
  return reg;
}

/**
 * "Reload": the waiting worker takes over, then the page reloads on `controllerchange`. The button must always
 * reload: a worker that is already redundant (a newer build replaced it after the banner showed) or never takes
 * over leaves the page as it was, so the page reloads itself after UPDATE_FALLBACK_MS.
 */
export function applyUpdate(env: Pick<RegisterEnv, 'reload'> = browserEnv()): void {
  const w = waiting;
  if (!w || w.state === 'redundant') {
    env.reload();
    return;
  }
  reloadOnControllerChange = true;
  clearFallback();
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (!reloadOnControllerChange) return;
    reloadOnControllerChange = false;
    env.reload();
  }, UPDATE_FALLBACK_MS);
  w.postMessage({ type: MSG_SKIP_WAITING });
}

/** Test seam: forget module state. */
export function resetServiceWorkerState(): void {
  waiting = null;
  reloadOnControllerChange = false;
  clearFallback();
  navigateHandler = null;
  pushSoundHandler = null;
  emit();
}
