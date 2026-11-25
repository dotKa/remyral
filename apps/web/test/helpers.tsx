import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../src/App';
import { type AuthApi, AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { SessionI18nProvider } from '../src/i18n/SessionI18nProvider';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type Handler = (req: RecordedRequest) => {
  status: number;
  body?: unknown;
  /** Sent as is instead of JSON (file downloads). */
  raw?: string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
};

/** A fetch stub routing `METHOD /api/path` to handlers and recording every request. */
export function fakeFetch(routes: Record<string, Handler>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const req = { method, url, headers, body };
    requests.push(req);
    const handler = routes[`${method} ${url}`];
    if (!handler) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'unauthorized', message: 'Authentication required.' }), {
          status: 401,
        }),
      );
    }
    const r = handler(req);
    return Promise.resolve(
      new Response(r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body)), {
        status: r.status,
        headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
      }),
    );
  };
  return { fetch: vi.fn(impl), requests };
}

export const USER = { id: '00000000-0000-4000-8000-000000000001', username: 'alex', role: 'owner' };

export function sessionBody(over: Partial<Record<string, string | null>> = {}): unknown {
  return {
    user: USER,
    session: {
      createdAt: '2026-10-12T10:00:00.000Z',
      expiresAt: '2026-10-12T22:00:00.000Z',
      idleExpiresAt: '2026-10-12T10:30:00.000Z',
      mfaAt: '2026-10-12T10:00:00.000Z',
      stepUpValidUntil: null,
      ...over,
    },
  };
}

export const INVALID = { error: 'invalid_credentials', message: 'Invalid credentials.' };

export const QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="white" width="10" height="10"/></svg>';

/** Renders the whole app at `path` with the real API module over a stubbed fetch. */
export function renderApp(opts: {
  routes: Record<string, Handler>;
  path?: string;
  api?: AuthApi;
  initialState?: AuthState;
  /**
   * p14-i18n-foundation: wrap the app in the app-root language provider as main.tsx does (session → this browser →
   * browser language → Turkish). Without it every screen renders the Turkish default.
   */
  i18n?: boolean;
}): RenderResult & { requests: RecordedRequest[] } {
  const f = fakeFetch(opts.routes);
  vi.stubGlobal('fetch', f.fetch);
  const ui: ReactNode = (
    <MemoryRouter initialEntries={[opts.path ?? '/login']}>
      <AuthProvider
        {...(opts.api ? { api: opts.api } : {})}
        {...(opts.initialState ? { initialState: opts.initialState } : {})}
      >
        {opts.i18n === true ? (
          <SessionI18nProvider>
            <App />
          </SessionI18nProvider>
        ) : (
          <App />
        )}
      </AuthProvider>
    </MemoryRouter>
  );
  return { ...render(ui), requests: f.requests };
}

/** Makes `document.cookie` return `value` (jsdom refuses `__Host-` cookies on its http origin). */
export function stubCookies(value: string): void {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);
}
