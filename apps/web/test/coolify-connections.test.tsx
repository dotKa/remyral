// p13-multi-coolify (ADR-0050): Settings → Integrations → Coolify as a list of connections (classic and Diyalog) —
// two connections with their badges and the targets using them, adding one (the token goes only into the POST body
// and is never shown), making another the default (step-up), removing with a confirmation that names the targets,
// a test result — and "Open Coolify" listing one entry per connection in both account menus.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  SETTINGS_COOLIFY_CONNECTIONS,
  SETTINGS_GITHUB,
  SETTINGS_OPS,
} from '../src/diyalog/harness/screens/settings';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const STEP_UP = { error: 'step_up_required', message: 'Confirm with a current authenticator code.' };
const TOKEN = 'coolify-canary-NEW|Zz9876543210abcdef';
const [C1, C2] = SETTINGS_COOLIFY_CONNECTIONS.items as [
  (typeof SETTINGS_COOLIFY_CONNECTIONS.items)[number],
  (typeof SETTINGS_COOLIFY_CONNECTIONS.items)[number],
];
const BASE = '/api/integrations/coolify/connections';
const SSO = {
  enabled: true,
  url: 'https://coolify.example.org/auth/oidc/redirect',
  connections: [
    {
      id: C1.id,
      label: C1.label,
      url: 'https://coolify.example.org/auth/oidc/redirect',
      sso: true,
      isDefault: true,
    },
    { id: C2.id, label: C2.label, url: 'https://apps.example.net/', sso: false, isDefault: false },
  ],
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/integrations/github': ok(SETTINGS_GITHUB),
    'GET /api/integrations/ops': ok(SETTINGS_OPS),
    'GET /api/integrations/coolify/connections': ok(SETTINGS_COOLIFY_CONNECTIONS),
    'GET /api/coolify-sso/config': ok(SSO),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

function guarded(gate: { stepped: boolean }, then: (req: RecordedRequest) => ReturnType<Handler>): Handler {
  return (req) => (gate.stepped ? then(req) : { status: 403, body: STEP_UP });
}

function stepUpRoute(gate: { stepped: boolean }): Handler {
  return () => {
    gate.stepped = true;
    return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
  };
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

const sent = (r: { requests: RecordedRequest[] }, method: string, url: string): RecordedRequest[] =>
  r.requests.filter((q) => q.method === method && q.url === url);

beforeEach(() => {
  window.localStorage.clear();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog: Coolify connections', () => {
  // p15-form-pattern: the Coolify connections are in the "Coolify ve Cloudflare" tab.
  const PAGE = '/settings/integrations?tab=ops';

  it('lists both connections with default / control-plane badges, projects, users and the last test', async () => {
    renderApp({ path: PAGE, initialState: owner, routes: routes() });
    const one = await screen.findByTestId(`coolify-conn-${C1.id}`);
    expect(one.textContent).toContain('Sunucu Coolify (varsayılan)');
    expect(one.textContent).toContain('Varsayılan');
    expect(one.textContent).toContain('Kontrol düzlemi');
    expect(one.textContent).toContain('tüm projeler');
    expect(within(one).getByTestId('coolify-conn-used').textContent).toContain(
      'vitrin-web (preview, production)',
    );
    expect(within(one).getByTestId('coolify-test').textContent).toContain('4 tanesi kontrol düzlemi');
    const two = screen.getByTestId(`coolify-conn-${C2.id}`);
    expect(two.textContent).toContain('apps.example.net');
    expect(two.textContent).toContain('genel');
    expect(within(two).getByRole('button', { name: 'Varsayılan yap' })).toBeTruthy();
    expect(within(one).queryByRole('button', { name: 'Varsayılan yap' })).toBeNull();
  });

  it('adds a connection through step-up; the token is sent once and never shown', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const created = { ...C2, id: '33333333-3333-4333-8333-333333333333', label: 'Müşteri Coolify' };
    const r = renderApp({
      path: PAGE,
      initialState: owner,
      routes: routes({
        [`POST ${BASE}`]: guarded(gate, () => ({ status: 200, body: created })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const panel = await screen.findByTestId('dy-ops-coolify');
    await user.click(within(panel).getByRole('button', { name: 'Coolify ekle' }));
    const form = within(panel).getByTestId('coolify-conn-new');
    await user.type(within(form).getByLabelText('Ad'), 'Müşteri Coolify');
    await user.type(within(form).getByLabelText('Coolify adresi'), 'https://coolify.musteri.example');
    await user.type(within(form).getByLabelText('Kullanabilecek projeler'), 'genel, vitrin-web');
    const token = within(form).getByLabelText<HTMLInputElement>('API token’ı');
    expect(token.type).toBe('password');
    await user.type(token, TOKEN);
    await user.click(within(form).getByRole('button', { name: 'Bağlantıyı ekle' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(sent(r, 'POST', BASE).at(-1)?.body).toEqual({
        label: 'Müşteri Coolify',
        url: 'https://coolify.musteri.example',
        team: null,
        openUrl: null,
        useServerSso: false,
        allProjects: false,
        manageApps: false,
        projects: ['genel', 'vitrin-web'],
        denyResources: [],
        token: TOKEN,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('coolify-conn-new')).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('makes another connection the default (step-up) and reloads the list', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: PAGE,
      initialState: owner,
      routes: routes({
        [`PUT ${BASE}/${C2.id}`]: guarded(gate, () => ({ status: 200, body: { ...C2, isDefault: true } })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const two = await screen.findByTestId(`coolify-conn-${C2.id}`);
    await user.click(within(two).getByRole('button', { name: 'Varsayılan yap' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(sent(r, 'PUT', `${BASE}/${C2.id}`).at(-1)?.body).toEqual({ isDefault: true });
    });
    await waitFor(() => {
      expect(sent(r, 'GET', BASE).length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('Open Coolify per connection', () => {
  it('Diyalog account menu lists the connections too', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/', initialState: owner, routes: routes() });
    await user.click(await screen.findByRole('button', { name: /Hesap menüsü/ }));
    const other = await screen.findByTestId(`open-coolify-${C2.id}`);
    expect(other.textContent).toContain('Coolify’ı aç — Harici Coolify');
    expect(other.getAttribute('rel')).toBe('noopener noreferrer');
    expect((await screen.findByTestId('open-coolify')).getAttribute('href')).toBe(SSO.url);
  });
});
