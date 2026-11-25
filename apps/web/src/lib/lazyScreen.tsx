import { type ComponentType, createElement, lazy, type ReactNode } from 'react';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §2): a route-level screen in its own chunk.
 *
 * Like `React.lazy`, but for a named export and with an explicit `preload()`:
 * - `preload()` starts the chunk download (rail hover/focus/touch, the entry's first-route preload) and is idempotent;
 * - once the module has loaded, the component renders synchronously (no Suspense round-trip on a revisit, and a
 *   preloaded screen never shows its fallback);
 * - before that, it suspends (React.lazy on the shared load promise), so the nearest `<Suspense>` shows its fallback —
 *   or, inside a router transition, React keeps the previous screen on screen until the chunk is there;
 * - a failed load (a deploy replaced the chunk, the network dropped) goes to the nearest error boundary
 *   (lib/RouteBoundary.tsx) and is not cached forever: the next `preload()` (link intent) tries again.
 */
export type LazyScreen<C> = C & {
  readonly preload: () => Promise<void>;
  /** True once the chunk has loaded (the component then renders synchronously). */
  readonly loaded: () => boolean;
};

const registry = new Set<() => Promise<void>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a component of any props
type AnyComponent = ComponentType<any>;

export function lazyScreen<M, K extends keyof M>(
  load: () => Promise<M>,
  key: K,
): M[K] extends AnyComponent ? LazyScreen<M[K]> : never {
  let mod: M | undefined;
  let pending: Promise<M> | undefined;
  let failed = false;
  const start = (): Promise<M> => {
    if (failed) {
      // A new attempt after a failed one (an explicit preload: hover, focus, the next navigation's intent).
      failed = false;
      pending = undefined;
      inner = makeInner();
    }
    pending ??= load().then(
      (m) => {
        mod = m;
        return m;
      },
      (e: unknown) => {
        failed = true;
        throw e;
      },
    );
    return pending;
  };
  // React.lazy does the suspending. Once the chunk is here its factory answers with a thenable that resolves
  // synchronously, so React renders the screen in the same pass (no fallback, no extra commit) — React reads a
  // thenable's result right after calling `then` (react/cjs lazyInitializer).
  const makeInner = (): ComponentType<Record<string, unknown>> =>
    lazy(() => {
      if (mod !== undefined) {
        const ready = { default: (mod as M)[key] as AnyComponent };
        const sync = {
          then: (resolve: (v: typeof ready) => void) => {
            resolve(ready);
          },
        };
        return sync as unknown as Promise<typeof ready>;
      }
      return start().then((m) => ({ default: m[key] as AnyComponent }));
    });
  let inner = makeInner();
  const preload = (): Promise<void> => start().then(() => undefined);
  function Lazy(props: Record<string, unknown>): ReactNode {
    return createElement(inner, props);
  }
  Lazy.displayName = `Lazy(${String(key)})`;
  registry.add(preload);
  return Object.assign(Lazy, { preload, loaded: () => mod !== undefined }) as never;
}

/**
 * Tests: loads every lazy screen registered so far, then the ones those modules registered in turn, so a test can
 * render a whole shell synchronously as before (test/setup.ts calls this before each test).
 */
export async function preloadAllLazyScreens(): Promise<void> {
  const done = new Set<() => Promise<void>>();
  for (;;) {
    const next = [...registry].filter((p) => !done.has(p));
    if (next.length === 0) return;
    for (const p of next) done.add(p);
    // A screen that cannot load fails where it renders (its test sees the error there), not here.
    await Promise.all(
      next.map((p) =>
        Promise.resolve()
          .then(p)
          .catch(() => undefined),
      ),
    );
  }
}
