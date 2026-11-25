// p19-project-env: Projeler → Politika → "Ortam değişkenleri" — vault credentials of kind "generic" given to the
// project's jobs as environment variables (add / remove with step-up; viewers read; the machines holding each).
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = { ...owner, user: { ...USER, role: 'viewer' } };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };

const PROJECTS = {
  items: [
    {
      id: 'alpha',
      name: 'Alpha app',
      kind: 'repository',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: null,
      members: 1,
      myRole: 'owner',
    },
  ],
};

const EMPTY = {
  project: 'alpha',
  credentials: [],
  available: [
    { id: 'dev-database-url', name: 'DEV_DATABASE_URL', env: 'DEV_DATABASE_URL' },
    { id: 'redis-url', name: 'Redis', env: 'REDIS_URL' },
  ],
};
const BOUND = {
  project: 'alpha',
  credentials: [
    {
      credentialId: 'dev-database-url',
      name: 'DEV_DATABASE_URL',
      env: 'DEV_DATABASE_URL',
      machines: ['windows-worker-1', 'linux-worker-1'],
    },
    { credentialId: 'redis-url', name: 'Redis', env: 'REDIS_URL', machines: [] },
  ],
  available: [],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': ok({ items: [] }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/projects': ok(PROJECTS),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Projeler → Politika → Ortam değişkenleri (p19-project-env)', { timeout: 30_000 }, () => {
  it('an owner adds a credential with step-up; the list shows the machines holding it', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/projects/alpha?tab=policy',
      initialState: owner,
      routes: routes({
        'GET /api/projects/alpha/env-credentials': ok(EMPTY),
        'PUT /api/projects/alpha/env-credentials': (req) => {
          if (!stepped) return STEP_UP;
          body = req.body;
          return { status: 200, body: { ...BOUND, credentials: BOUND.credentials.slice(0, 1) } };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const panel = await screen.findByTestId('project-env-panel');
    expect(await within(panel).findByTestId('project-env-none')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Ekle' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Ortam değişkenlerini değiştirmek için doğrulama kodunu gir.');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
    await waitFor(() => {
      expect(body).toEqual({ credentialIds: ['dev-database-url'] });
    });
    expect(await findToast('Ortam değişkenleri kaydedildi.')).toBeTruthy();
    const list = await within(panel).findByTestId('project-env-list');
    expect(list.textContent).toContain('DEV_DATABASE_URL');
    expect(list.textContent).toContain('Makinelerde: windows-worker-1, linux-worker-1');
  });

  it('viewers read the list (no add, no remove); a credential on no machine says jobs wait', async () => {
    renderApp({
      path: '/projects/alpha?tab=policy',
      initialState: viewer,
      routes: routes({ 'GET /api/projects/alpha/env-credentials': ok(BOUND) }),
    });
    const panel = await screen.findByTestId('project-env-panel');
    const list = await within(panel).findByTestId('project-env-list');
    expect(list.textContent).toContain('REDIS_URL');
    expect(list.textContent).toContain('Hiçbir makinede yok — işler bekler.');
    expect(within(panel).queryByTestId('project-env-add')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Kaldır' })).toBeNull();
  });
});
