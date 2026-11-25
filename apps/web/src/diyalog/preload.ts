import { isValidElement, useEffect } from 'react';
import { lazyScreen } from '../lib/lazyScreen';
import { chatRouteId } from './chat/route';
import { diyalogScreen } from './screens/routes';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §2): the Diyalog shell's own screens (home, Sohbet, job control panel) as
 * lazy chunks, and "load this route's code now" for intent — a rail link hovered, focused or touched, and the entry's
 * first route (main.tsx starts it while the session check is still in flight, so the screen's chunk never waits for
 * it).
 */
export const DIYALOG_HOME = lazyScreen(() => import('./DiyalogHome'), 'DiyalogHome');
export const DIYALOG_SOHBET = lazyScreen(() => import('./chat/SohbetScreen'), 'SohbetScreen');
export const DIYALOG_JOB = lazyScreen(() => import('./job/DiyalogJob'), 'DiyalogJob');

const JOB_SCREENS = new Set(['new', 'templates', 'schedules', 'workflows']);

function isJobThread(pathname: string): boolean {
  const m = /^\/jobs\/([^/]+)\/?$/.exec(pathname);
  return m !== null && !JOB_SCREENS.has(m[1] ?? '');
}

interface Preloadable {
  readonly preload: () => Promise<void>;
}

function isPreloadable(t: unknown): t is Preloadable {
  return typeof t === 'function' && typeof (t as Partial<Preloadable>).preload === 'function';
}

/**
 * Starts loading the code of the Diyalog screen at `pathname` (no-op for a path without one, or already loaded).
 * Never throws and never rejects: a failed preload is retried by the real render, which shows the error.
 */
export function preloadDiyalogPath(pathname: string): void {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const quiet = (s: Preloadable): void => {
    s.preload().catch(() => undefined);
  };
  const own =
    path === '/'
      ? DIYALOG_HOME
      : chatRouteId(path) !== undefined
        ? DIYALOG_SOHBET
        : isJobThread(path)
          ? DIYALOG_JOB
          : null;
  if (own !== null) {
    quiet(own);
    return;
  }
  let el: unknown;
  try {
    el = diyalogScreen(path);
  } catch {
    return;
  }
  // A matcher answers with the screen element, sometimes inside a lazy frame, a Fragment or a Suspense: preload every
  // lazy component on the way down (the settings frame and the settings page, say).
  for (let depth = 0; depth < 4 && isValidElement(el); depth++) {
    if (isPreloadable(el.type)) quiet(el.type);
    el = (el.props as { readonly children?: unknown }).children;
  }
}

/** The rail's main destinations, loaded once the shell is idle (the likely next navigation never waits). */
export const MAIN_ROUTES = ['/chat', '/needs', '/jobs', '/machines', '/jobs/_'] as const;

/**
 * p14-web-perf: after the first screen is drawn and the browser is idle, the code of the main destinations (Sohbet,
 * Senden bekleyen, İşler, Makineler, a job) is fetched in the background — a few hundred KB the service worker precaches anyway — so a
 * first visit to them is a cache read instead of a download. Only on a fast enough connection without data saver.
 */
export function usePreloadMainRoutes(also: readonly (() => Promise<void>)[] = []): void {
  useEffect(() => {
    const nav = navigator as Navigator & {
      readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string };
    };
    if (nav.connection?.saveData === true || /(^|-)2g$/.test(nav.connection?.effectiveType ?? '')) return;
    const run = (): void => {
      for (const path of MAIN_ROUTES) preloadDiyalogPath(path);
      // p14-web-perf-2: other lazy shell parts (the command palette body).
      for (const p of also) p().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => {
        window.cancelIdleCallback(id);
      };
    }
    const t = setTimeout(run, 2000);
    return () => {
      clearTimeout(t);
    };
  }, [also]);
}
