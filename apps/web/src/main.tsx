import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { preloadDiyalogPath } from './diyalog/preload';
import { DyLoginScreen } from './diyalog/auth/lazyScreens';
import { loadCatalog } from '@remyral/i18n';
import { initialLocale } from './i18n/I18nProvider';
import { SessionI18nProvider } from './i18n/SessionI18nProvider';
import { forgetLegacyUiChoice } from './lib/legacyUrl';
import { listenForInstallPrompt } from './pwa/install';
import { registerServiceWorker } from './pwa/serviceWorker';
import './fonts.css';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// p8-pwa: install prompt capture always; the service worker only in production builds (the dev server has no
// /sw.js, and a worker would interfere with Vite's module loading).
listenForInstallPrompt();
if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void registerServiceWorker();
  });
}

// p15-classic-removal: one UI — the old per-browser classic / Diyalog choice is forgotten.
forgetLegacyUiChoice();

// p14-web-perf: the first screen's chunk starts loading now, in parallel with the session check (the shell renders
// it only once the session is known, which would otherwise be a second round trip after it).
if (window.location.pathname === '/login') DyLoginScreen.preload().catch(() => undefined);
else preloadDiyalogPath(window.location.pathname);

// p14-web-perf-2: only the active language's catalog is in the initial JS. English (a chunk of its own) is loaded
// before the first frame when this browser last used it; a failed load renders Turkish, never nothing.
const catalogReady =
  initialLocale() === 'en'
    ? loadCatalog('en').then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();

void catalogReady.then(() => {
  render(root);
});

function render(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          {/* p14-i18n-foundation (ADR-0053): the console language (session → this browser → browser → Turkish). */}
          <SessionI18nProvider>
            <App />
          </SessionI18nProvider>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
