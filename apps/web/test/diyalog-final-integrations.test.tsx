// p12-diyalog final parity — Ayarlar → Entegrasyonlar, every feature of the classic Integrations page in the Diyalog
// screen: GitHub (refresh installations, install / configure links, missing permissions, webhook set-up, key rotation
// by .pem upload, disconnect with confirmation, PUBLIC_ORIGIN / key-file notices), the GitHub callback and installed
// redirect pages (missing code, cancelled step-up and retry, server refusal), Coolify / Cloudflare (write-only tokens,
// step-up, confirmed removal, "Bağlantıyı test et" incl. the DNS probe feeding the page summary, a 409 refusal), AWS
// Bedrock (keys, test failure, confirmed removal), the default git identity (clear) and the admin-only navigation.
// Queries go by role / label / test id; step-up and Retry-After wording is not asserted.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  SETTINGS_COOLIFY_CONNECTIONS,
  SETTINGS_GITHUB,
  SETTINGS_OPS,
} from '../src/diyalog/harness/screens/settings';
import {
  W3_BEDROCK,
  W3_GIT_IDENTITY,
  W3_PROTECTION,
  W3_REPOS,
} from '../src/diyalog/harness/screens/w3-settings-integrations';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const STEP_UP = { error: 'step_up_required', message: 'Confirm with a current authenticator code.' };
const PAGE = '/settings/integrations';
// p15-form-pattern: Genel bakış · GitHub · Coolify ve Cloudflare · Amazon Bedrock are tabs.
const PAGE_GITHUB = `${PAGE}?tab=github`;
const PAGE_OPS = `${PAGE}?tab=ops`;
const PAGE_BEDROCK = `${PAGE}?tab=bedrock`;

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
    'GET /api/integrations/bedrock': ok(W3_BEDROCK),
    'GET /api/settings/git-identity': ok(W3_GIT_IDENTITY),
    'GET /api/projects/vitrin-web/git/protection': ok(W3_PROTECTION),
    'GET /api/integrations/github/repositories?installationId=77&pageSize=100': ok(W3_REPOS),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

/** A handler that asks for step-up until the step-up POST went through, then answers with `then`. */
function guardedRoute(
  gate: { stepped: boolean },
  then: (req: RecordedRequest) => ReturnType<Handler>,
): Handler {
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

async function cancelStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.click(within(dialog).getByRole('button', { name: /^(cancel|vazgeç|iptal)$/i }));
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

describe('Diyalog Entegrasyonlar — GitHub connected view', () => {
  it('refreshes installations, links install (same tab), configure and App settings (new tab)', async () => {
    const user = userEvent.setup();
    const synced = {
      ...SETTINGS_GITHUB,
      app: { ...SETTINGS_GITHUB.app, missingPermissions: ['checks:read'] },
      installations: [
        { ...SETTINGS_GITHUB.installations[0], htmlUrl: 'https://github.com/settings/installations/77' },
      ],
    };
    const r = renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({ 'POST /api/integrations/github/installations/sync': ok(synced) }),
    });
    const gh = await screen.findByTestId('github-connected');
    const install = within(gh).getByRole('link', { name: /Depolara kur/ });
    expect(install.getAttribute('href')).toBe(SETTINGS_GITHUB.app.installUrl);
    expect(install.getAttribute('target')).toBeNull();
    await user.click(within(gh).getByRole('button', { name: 'Kurulumları yenile' }));
    await waitFor(() => {
      expect(sent(r, 'POST', '/api/integrations/github/installations/sync').length).toBe(1);
    });
    // p17-toasts-rest: the sync result is a toast.
    expect(await findToast('Kurulumlar GitHub’dan yenilendi.')).toBeTruthy();
    const after = await screen.findByTestId('github-connected');
    const configure = within(after).getByRole('link', { name: /GitHub’da yapılandır/ });
    expect(configure.getAttribute('href')).toBe('https://github.com/settings/installations/77');
    expect(configure.getAttribute('target')).toBe('_blank');
    expect(within(after).getByText(/checks:read/)).toBeTruthy();
    const settings = within(after).getByRole('link', { name: /App ayarlarını aç/ });
    expect(settings.getAttribute('href')).toBe(SETTINGS_GITHUB.app.settingsUrl);
    expect(settings.getAttribute('target')).toBe('_blank');
    // The summary (Genel bakış tab) follows the refreshed status.
    await user.click(screen.getByRole('tab', { name: 'Genel bakış' }));
    expect(within(await screen.findByTestId('dy-connections')).getByText(/1 kurulum, 1 proje/)).toBeTruthy();
  });

  it('sets up the automation webhook through step-up and names the events to tick', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'POST /api/integrations/github/webhook': guardedRoute(gate, () => ({
          status: 200,
          body: {
            url: 'https://remyral.example/api/hooks/github',
            settingsUrl: SETTINGS_GITHUB.app.settingsUrl,
            events: ['pull_request', 'push'],
          },
        })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const hook = await screen.findByTestId('github-webhook-setup');
    await user.click(within(hook).getByText('Otomasyonlar için webhook'));
    await user.click(within(hook).getByRole('button', { name: 'Webhook’u kur' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(within(hook).getByText(/https:\/\/remyral\.example\/api\/hooks\/github/)).toBeTruthy();
    });
    expect(hook.textContent).toContain('pull_request, push');
    const posts = sent(r, 'POST', '/api/integrations/github/webhook');
    expect(posts.length).toBe(2);
    expect(posts[1]?.body).toEqual({});
  });

  it('an unusable key offers "rotate now"; the .pem upload goes through step-up and updates the status', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const broken = { ...SETTINGS_GITHUB, app: { ...SETTINGS_GITHUB.app, keyUsable: false } };
    const r = renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'GET /api/integrations/github': ok(broken),
        'POST /api/integrations/github/key': guardedRoute(gate, () => ({
          status: 200,
          body: { ...SETTINGS_GITHUB, app: { ...SETTINGS_GITHUB.app, keyAgeDays: 0 } },
        })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const gh = await screen.findByTestId('github-connected');
    expect(within(screen.getByTestId('dy-github')).getByText('Anahtar kullanılamıyor')).toBeTruthy();
    await user.click(within(gh).getByRole('button', { name: 'Anahtarı şimdi yenile' }));
    const file = within(gh).getByLabelText<HTMLInputElement>('Özel anahtar dosyası');
    expect(file.closest('details')?.open).toBe(true);
    const upload = within(gh).getByRole('button', { name: 'Yeni anahtarı yükle' });
    expect((upload as HTMLButtonElement).disabled).toBe(true);
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n';
    await user.upload(file, new File([pem], 'remyral.pem', { type: 'application/x-pem-file' }));
    await waitFor(() => {
      expect((upload as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(upload);
    await confirmStepUp(user);
    expect(await screen.findByText(/Anahtar yenilendi/)).toBeTruthy();
    const posts = sent(r, 'POST', '/api/integrations/github/key');
    expect(posts.length).toBe(2);
    expect(posts[1]?.body).toEqual({ pem });
    expect(document.body.textContent).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(screen.getByTestId('github-key-age').textContent).toBe('bugün oluşturuldu');
    expect(within(screen.getByTestId('dy-github')).getByText('Bağlı')).toBeTruthy();
  });

  it('a key older than 180 days gets the rotation hint', async () => {
    renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'GET /api/integrations/github': ok({
          ...SETTINGS_GITHUB,
          app: { ...SETTINGS_GITHUB.app, keyAgeDays: 200 },
        }),
      }),
    });
    const gh = await screen.findByTestId('github-connected');
    expect(within(gh).getByText(/Anahtar 200 günlük/)).toBeTruthy();
    expect(within(gh).getByRole('button', { name: 'Anahtarı şimdi yenile' })).toBeTruthy();
  });

  it('disconnect asks first (cancel sends nothing), then needs step-up and reports what is left on GitHub', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    // p14-web-perf: keyed on the disconnect itself, not on how many GETs ran (identical GETs in flight are shared).
    let disconnected = false;
    const r = renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'GET /api/integrations/github': () => ({
          status: 200,
          body: disconnected
            ? { ...SETTINGS_GITHUB, app: null, installations: [], projects: [] }
            : SETTINGS_GITHUB,
        }),
        'DELETE /api/integrations/github': guardedRoute(gate, () => {
          disconnected = true;
          return {
            status: 200,
            body: { affectedProjects: ['vitrin-web'], settingsUrl: SETTINGS_GITHUB.app.settingsUrl },
          };
        }),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    // p17-github-apps-ui: removing is on the App's own card ("Bağlantıyı kaldır"); an older master's single App has
    // no id, so the DELETE addresses the first App as before.
    const gh = await screen.findByTestId('github-connected');
    await user.click(within(gh).getByRole('button', { name: 'Bağlantıyı kaldır' }));
    // p18-confirm-dialog: the question is a confirm dialog.
    const confirm = await screen.findByRole('dialog', { name: /kaldır/i });
    expect(confirm.getAttribute('data-testid')).toBe('github-disconnect-confirm');
    expect(confirm.textContent).toContain('vitrin-web');
    await user.click(within(confirm).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent(r, 'DELETE', '/api/integrations/github').length).toBe(0);

    await user.click(within(gh).getByRole('button', { name: 'Bağlantıyı kaldır' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Kaldır' }));
    await confirmStepUp(user);
    // The notice stays above the list (the removed App's card is gone; here it was the last App).
    const panel = screen.getByTestId('dy-github');
    const deleteTarget = await within(panel).findByRole('link', { name: 'orada silin' });
    expect(deleteTarget.getAttribute('href')).toBe(SETTINGS_GITHUB.app.settingsUrl);
    expect(within(panel).getByTestId('github-removed').textContent).toContain('vitrin-web');
    expect(sent(r, 'DELETE', '/api/integrations/github').length).toBe(2);
    expect(await screen.findByTestId('github-disconnected')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Tamam' }));
    expect(within(panel).queryByTestId('github-removed')).toBeNull();
  });
});

describe('Diyalog Entegrasyonlar — GitHub not connected', () => {
  it('without PUBLIC_ORIGIN there is no connect form; a key-file App is named', async () => {
    renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'GET /api/integrations/github': ok({
          ...SETTINGS_GITHUB,
          available: false,
          fileApps: [{ keyRef: 'github-app', appId: '42' }],
          app: null,
          installations: [],
          projects: [],
        }),
      }),
    });
    const view = await screen.findByTestId('github-disconnected');
    expect(view.textContent).toContain('PUBLIC_ORIGIN');
    expect(view.textContent).toContain('github-app: App 42');
    expect(within(view).queryByRole('form')).toBeNull();
    expect(within(view).queryByRole('button', { name: 'GitHub’ı bağla' })).toBeNull();
  });

  it('connect as the user account goes through step-up with the user target', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'GET /api/integrations/github': ok({
          ...SETTINGS_GITHUB,
          app: null,
          installations: [],
          projects: [],
        }),
        'POST /api/integrations/github/manifest': guardedRoute(gate, () => ({
          status: 200,
          body: { formPath: '/integrations/github/manifest/form?t=2' },
        })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const view = await screen.findByTestId('github-disconnected');
    await user.click(within(view).getByRole('button', { name: 'GitHub’ı bağla' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(sent(r, 'POST', '/api/integrations/github/manifest').length).toBe(2);
    });
    expect(sent(r, 'POST', '/api/integrations/github/manifest')[1]?.body).toEqual({ target: 'user' });
  });
});

describe('Diyalog GitHub redirect pages', () => {
  it('callback without a code says so and sends nothing', async () => {
    const r = renderApp({
      path: '/settings/integrations/github/callback',
      initialState: owner,
      routes: routes(),
    });
    const page = await screen.findByTestId('dy-github-callback');
    expect(await within(page).findByText(/GitHub bir kod döndürmedi/)).toBeTruthy();
    expect(sent(r, 'POST', '/api/integrations/github/manifest/complete').length).toBe(0);
  });

  it('callback: a cancelled step-up offers a retry that completes the exchange', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: '/settings/integrations/github/callback?code=c0de&state=st-1',
      initialState: owner,
      routes: routes({
        'POST /api/integrations/github/manifest/complete': guardedRoute(gate, () => ({
          status: 200,
          body: SETTINGS_GITHUB,
        })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    await cancelStepUp(user);
    const page = await screen.findByTestId('dy-github-callback');
    await user.click(await within(page).findByRole('button', { name: 'Yeniden dene' }));
    await confirmStepUp(user);
    expect(await within(page).findByText(/Remyral \(octo-org\) bağlandı/)).toBeTruthy();
    const install = within(page).getByRole('link', { name: /Depolara kur/ });
    expect(install.getAttribute('href')).toBe(SETTINGS_GITHUB.app.installUrl);
    expect(
      within(page)
        .getByRole('link', { name: /Entegrasyonlara dön/ })
        .getAttribute('href'),
    ).toBe('/settings/integrations');
    const posts = sent(r, 'POST', '/api/integrations/github/manifest/complete');
    expect(posts.at(-1)?.body).toEqual({ code: 'c0de', state: 'st-1' });
  });

  it('callback: a refused exchange (409, state already used) shows the error and the way back', async () => {
    renderApp({
      path: '/settings/integrations/github/callback?code=c0de&state=used',
      initialState: owner,
      routes: routes({
        'POST /api/integrations/github/manifest/complete': () => ({
          status: 409,
          body: { error: 'conflict', message: 'This GitHub code was already used.' },
        }),
      }),
    });
    const page = await screen.findByTestId('dy-github-callback');
    expect((await within(page).findByTestId('api-error')).textContent).toBe(
      'This GitHub code was already used.',
    );
    expect(within(page).getByRole('link', { name: /Entegrasyonlara dön/ })).toBeTruthy();
  });

  it('installed page ignores a malformed installation id (plain refresh)', async () => {
    const r = renderApp({
      path: '/settings/integrations/github/installed?installation_id=12x',
      initialState: owner,
      routes: routes({ 'POST /api/integrations/github/installations/sync': ok(SETTINGS_GITHUB) }),
    });
    const page = await screen.findByTestId('dy-github-installed');
    expect(await within(page).findByText(/Kurulumlar yenilendi\./)).toBeTruthy();
    const posts = sent(r, 'POST', '/api/integrations/github/installations/sync');
    expect(posts.length).toBe(1);
    expect(posts[0]?.body).not.toHaveProperty('installationId', expect.anything());
    expect(within(page).getByRole('link', { name: 'Projeler' }).getAttribute('href')).toBe('/projects');
  });
});

describe('Diyalog Entegrasyonlar — Coolify and Cloudflare', () => {
  it('Cloudflare: account id + new token through step-up; the field empties and the token is never shown', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: PAGE_OPS,
      initialState: owner,
      routes: routes({
        'PUT /api/integrations/ops/cloudflare': guardedRoute(gate, () => ({
          status: 200,
          body: SETTINGS_OPS.cloudflare,
        })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const panel = await screen.findByTestId('dy-ops-cloudflare');
    const account = within(panel).getByLabelText('Cloudflare hesap kimliği');
    await user.clear(account);
    await user.type(account, 'abc123');
    await user.type(within(panel).getByLabelText('API token’ı'), 'CF-SECRET-xyz');
    await user.click(within(panel).getByRole('button', { name: 'Kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(sent(r, 'PUT', '/api/integrations/ops/cloudflare').at(-1)?.body).toEqual({
        accountId: 'abc123',
        token: 'CF-SECRET-xyz',
      });
    });
    expect(document.body.textContent).not.toContain('CF-SECRET-xyz');
  });

  // p13-multi-coolify: Coolify is a list of connections; the external one (no last test) is exercised here.
  const C2 = SETTINGS_COOLIFY_CONNECTIONS.items[1] ?? { id: '', label: '' };
  const C2_URL = `/api/integrations/coolify/connections/${C2.id}`;

  it('Coolify: leaving the token empty keeps the stored one (no token in the body)', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: PAGE_OPS,
      initialState: owner,
      routes: routes({ [`PUT ${C2_URL}`]: ok(C2) }),
    });
    const card = await screen.findByTestId(`coolify-conn-${C2.id}`);
    await user.click(within(card).getByRole('button', { name: 'Düzenle' }));
    await user.type(within(card).getByLabelText('Ek kontrol düzlemi kaynakları (uuid)'), 'u1, u2');
    await user.click(within(card).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(sent(r, 'PUT', C2_URL)[0]?.body).toEqual({
        label: 'Harici Coolify',
        url: 'https://apps.example.net',
        team: 'Ajans',
        openUrl: null,
        useServerSso: false,
        allProjects: false,
        manageApps: false,
        projects: ['genel'],
        denyResources: ['u1', 'u2'],
      });
    });
  });

  it('Coolify: a 409 refusal on save shows the server message', async () => {
    const user = userEvent.setup();
    renderApp({
      path: PAGE_OPS,
      initialState: owner,
      routes: routes({
        [`PUT ${C2_URL}`]: () => ({
          status: 409,
          body: { error: 'label_taken', message: 'A Coolify connection named “Harici Coolify” exists.' },
        }),
      }),
    });
    const card = await screen.findByTestId(`coolify-conn-${C2.id}`);
    await user.click(within(card).getByRole('button', { name: 'Düzenle' }));
    await user.click(within(card).getByRole('button', { name: 'Kaydet' }));
    expect((await within(card).findByTestId('api-error')).textContent).toBe(
      'A Coolify connection named “Harici Coolify” exists.',
    );
  });

  it('Coolify: removing a connection asks first (naming the targets that use it), then needs step-up', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const C1 = SETTINGS_COOLIFY_CONNECTIONS.items[0] ?? { id: '' };
    const C1_URL = `/api/integrations/coolify/connections/${C1.id}`;
    const r = renderApp({
      path: PAGE_OPS,
      initialState: owner,
      routes: routes({
        [`DELETE ${C1_URL}`]: guardedRoute(gate, () => ({ status: 204 })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const card = await screen.findByTestId(`coolify-conn-${C1.id}`);
    await user.click(within(card).getByRole('button', { name: /^Kaldır/ }));
    expect(sent(r, 'DELETE', C1_URL).length).toBe(0);
    const armed = await screen.findByRole('dialog');
    expect(armed.textContent).toContain('vitrin-web (preview, production)');
    await user.click(within(armed).getByRole('button', { name: 'Kaldır' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(sent(r, 'DELETE', C1_URL).length).toBe(2);
    });
  });

  it('Coolify test shows version, team and the read / deploy / write permissions', async () => {
    const user = userEvent.setup();
    renderApp({
      path: PAGE_OPS,
      initialState: owner,
      routes: routes({
        [`POST ${C2_URL}/test`]: ok({
          ok: true,
          version: '4.0.0',
          team: 'ops',
          applications: 3,
          controlPlaneResources: 0,
          permissions: { read: true, deploy: true, write: false },
          warnings: ['The token can write.'],
        }),
      }),
    });
    const card = await screen.findByTestId(`coolify-conn-${C2.id}`);
    await user.click(within(card).getByRole('button', { name: 'Bağlantıyı test et' }));
    const test = await within(card).findByTestId('coolify-test');
    expect(test.textContent).toContain('Coolify 4.0.0');
    expect(test.textContent).toContain('3 uygulama');
    expect(test.textContent).toContain('okuma: evet');
    expect(test.textContent).toContain('yazma: hayır');
    expect(test.textContent).toContain('The token can write.');
  });

  it('Cloudflare test: the DNS probe per allowed zone, and the page summary follows the fresh result', async () => {
    const user = userEvent.setup();
    renderApp({
      path: PAGE,
      initialState: owner,
      routes: routes({
        'POST /api/integrations/ops/cloudflare/test': ok({
          ok: true,
          tokenStatus: 'active',
          zones: [{ id: 'z1', name: 'example.org' }],
          pages: { access: true, projects: ['vitrin'] },
          dns: [
            { zone: 'example.org', zoneId: 'z1', ok: true, projects: ['vitrin-web'] },
            { zone: 'demo.test', zoneId: 'z2', ok: true, projects: ['sunum'] },
          ],
          previews: { tunnels: true, accessApps: true, serviceTokens: true, missing: [] },
        }),
      }),
    });
    // Before: the stored probe has one zone missing the permission.
    const summary = await screen.findByTestId('dy-dns-probe');
    await waitFor(() => {
      expect(within(summary).getAllByTestId('dy-dns-zone').length).toBe(2);
    });
    expect(summary.textContent).toContain('İzin eksik');
    // p15-form-pattern: the summary is on Genel bakış, the Cloudflare card on "Coolify ve Cloudflare".
    await user.click(screen.getByRole('tab', { name: 'Coolify ve Cloudflare' }));
    const panel = await screen.findByTestId('dy-ops-cloudflare');
    await user.click(within(panel).getByRole('button', { name: 'Bağlantıyı test et' }));
    const probe = await within(panel).findByTestId('cloudflare-dns-probe');
    await waitFor(() => {
      expect(probe.textContent).not.toContain('Zone → DNS → Edit eksik');
    });
    expect(within(probe).queryByTestId('cloudflare-dns-hint')).toBeNull();
    expect(within(panel).getByTestId('preview-tunnel-health').textContent).toContain('hazır');
    await user.click(screen.getByRole('tab', { name: 'Genel bakış' }));
    await waitFor(() => {
      expect(screen.getByTestId('dy-dns-probe').textContent).not.toContain('İzin eksik');
    });
  });
});

describe('Diyalog Entegrasyonlar — AWS Bedrock and git identity', () => {
  it('Bedrock: keys saved through step-up, a failed test with its hint, removal asks first', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: PAGE_BEDROCK,
      initialState: owner,
      routes: routes({
        'PUT /api/integrations/bedrock': guardedRoute(gate, () => ({
          status: 200,
          body: W3_BEDROCK.integration,
        })),
        'POST /api/integrations/bedrock/test': ok({
          ok: false,
          error: 'AccessDeniedException',
          httpStatus: 403,
          hint: 'Enable model access.',
        }),
        'DELETE /api/integrations/bedrock': () => ({ status: 204 }),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const panel = await screen.findByTestId('dy-bedrock');
    await user.type(within(panel).getByLabelText('Erişim anahtarı kimliği'), 'AKIAEXAMPLE');
    await user.type(within(panel).getByLabelText('Gizli erişim anahtarı'), 'SECRET-AWS');
    await user.click(within(panel).getByRole('button', { name: 'Kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(sent(r, 'PUT', '/api/integrations/bedrock').at(-1)?.body).toEqual({
        region: 'eu-central-1',
        model: 'cohere.embed-multilingual-v3',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'SECRET-AWS',
      });
    });
    expect(document.body.textContent).not.toContain('SECRET-AWS');

    const after = await screen.findByTestId('dy-bedrock');
    await user.click(within(after).getByRole('button', { name: 'Bağlantıyı test et' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('dy-bedrock')).getByTestId('bedrock-test').textContent).toContain(
        'AccessDeniedException',
      );
    });
    const test = within(screen.getByTestId('dy-bedrock')).getByTestId('bedrock-test');
    expect(test.textContent).toContain('HTTP 403');
    expect(test.textContent).toContain('Enable model access.');

    const live = screen.getByTestId('dy-bedrock');
    await user.click(within(live).getByRole('button', { name: 'Kaldır' }));
    expect(sent(r, 'DELETE', '/api/integrations/bedrock').length).toBe(0);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Kaldır' }));
    await waitFor(() => {
      expect(sent(r, 'DELETE', '/api/integrations/bedrock').length).toBe(1);
    });
  });

  it('default git identity: "Varsayılanı kaldır" sends identity null through step-up', async () => {
    const user = userEvent.setup();
    const gate = { stepped: false };
    const r = renderApp({
      path: PAGE_GITHUB,
      initialState: owner,
      routes: routes({
        'PUT /api/settings/git-identity': guardedRoute(gate, () => ({
          status: 200,
          body: {
            identity: null,
            effective: {
              identity: { name: 'Remyral Agent', email: 'agent@remyral.invalid' },
              source: 'default',
            },
            updatedAt: null,
            updatedBy: null,
          },
        })),
        'POST /api/auth/step-up': stepUpRoute(gate),
      }),
    });
    const card = await screen.findByTestId('default-git-identity');
    await user.click(await within(card).findByRole('button', { name: 'Varsayılanı kaldır' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(within(card).getByTestId('git-identity-effective').textContent).toContain('yerleşik varsayılan');
    });
    expect(sent(r, 'PUT', '/api/settings/git-identity').at(-1)?.body).toEqual({ identity: null });
  });
});

describe('Diyalog Entegrasyonlar — role gating', () => {
  it('the settings navigation offers Entegrasyonlar to owners only (admin-only like classic)', async () => {
    const member = { ...USER, role: 'member' };
    const memberState: AuthState = {
      kind: 'signedIn',
      user: member,
      session: null,
      remainingRecoveryCodes: null,
    };
    const session = { ...(sessionBody() as Record<string, unknown>), user: member };
    renderApp({
      path: '/settings/profile',
      initialState: memberState,
      routes: routes({ 'GET /api/auth/session': ok(session) }),
    });
    const nav = await screen.findByRole('navigation', { name: 'Ayarlar' });
    expect(within(nav).getByRole('link', { name: 'Profil ve güvenlik' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Entegrasyonlar' })).toBeNull();
  });

  it('owners see Entegrasyonlar in the settings navigation', async () => {
    renderApp({ path: '/settings/profile', initialState: owner, routes: routes() });
    const nav = await screen.findByRole('navigation', { name: 'Ayarlar' });
    // p17-ui-polish: Ajanlar is folded while another group's page is open.
    await userEvent.setup().click(within(nav).getByRole('button', { name: 'Ajanlar' }));
    expect(within(nav).getByRole('link', { name: 'Entegrasyonlar' }).getAttribute('href')).toBe(
      '/settings/integrations',
    );
  });
});
