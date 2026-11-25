import { loadCatalog } from '@remyral/i18n';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { preloadAllLazyScreens } from '../src/lib/lazyScreen';
import { forgetRemembered } from '../src/lib/remembered';
import { resetNotificationFeed } from '../src/lib/notificationFeed';
import { resetToasts } from '../src/diyalog/toast/store';
import { resetDeferrals } from '../src/screens/home/deferrals';

// The default 1 s find*/waitFor timeout flakes when the whole monorepo suite runs in parallel
// on a loaded machine; rendering is still asserted, only the wait budget is larger.
configure({ asyncUtilTimeout: 5000 });

// p14-web-perf: screens are lazy chunks (src/lib/lazyScreen.tsx). Loading the ones this test file's modules declared
// before each test keeps the suites' synchronous rendering (a loaded lazy screen renders without suspending); the
// Suspense fallback, the error boundary and the preloads themselves are tested in test/web-perf.test.tsx.
// Loading them is module transformation the static imports used to do at file import time (outside any hook
// timeout), so the hooks get a budget like the import phase has on a loaded machine; after the first test of a file
// the modules are cached and this returns at once.
const PRELOAD_BUDGET_MS = 300_000;
beforeAll(async () => {
  // p14-web-perf-2: English is a lazy chunk in the console (main.tsx loads it before the first frame when needed);
  // suites render both languages synchronously. The lazy load itself is tested in test/i18n-lazy.test.tsx.
  await loadCatalog('en');
  await preloadAllLazyScreens();
}, PRELOAD_BUDGET_MS);
beforeEach(async () => {
  await preloadAllLazyScreens();
}, PRELOAD_BUDGET_MS);

afterEach(() => {
  cleanup();
  // p14-web-perf: screens remember their last data per tab (src/lib/remembered.ts); every test starts without it.
  forgetRemembered();
  // p17-toasts-shortcuts: the toast queue and the shared notification page are per tab (module state).
  resetToasts();
  resetNotificationFeed();
  // p20-decisions: the person's put-off / ignored decisions are one store per tab.
  resetDeferrals();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// jsdom has no modal <dialog>; emulate the parts the step-up dialog uses.
if (typeof HTMLDialogElement !== 'undefined' && !('showModal' in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

// p13-workflows-ui: React Flow measures nodes with ResizeObserver and reads the viewport transform through
// DOMMatrixReadOnly; jsdom has neither (the shim of React Flow's testing guide, reactflow.dev/learn/advanced-use/testing).
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverShim {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      setTimeout(() => {
        const contentRect = { x: 0, y: 0, top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 };
        this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this);
      }, 0);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverShim;
}
if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class DOMMatrixReadOnlyShim {
    readonly m22: number;
    constructor(transform?: string) {
      const scale = /scale\(([0-9.]+)\)/.exec(transform ?? '')?.[1];
      this.m22 = scale === undefined ? 1 : Number(scale);
    }
  }
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyShim;
}
