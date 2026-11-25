// p12-diyalog wave 2 (W3): Ayarlar → Entegrasyonlar editing panels in the Diyalog language — GitHub connect flow and
// connected view, the GitHub redirect pages, default git identity, Coolify / Cloudflare (write-only token, step-up,
// "Bağlantıyı test et") and AWS Bedrock. Same requests and step-up as the classic cards; tokens never echoed.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthApi, AuthProvider, type AuthState } from '../src/auth/AuthProvider';
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
import { GitHubPanel } from '../src/diyalog/screens/settings/integrations-github';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const STEP_UP = { error: 'step_up_required', message: 'Confirm with a current authenticator code.' };

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

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

const stepUpRoute = (onStep: () => void): Handler => {
  return () => {
    onStep();
    return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
  };
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Entegrasyonlar — editing panels', () => {
  it('renders every panel natively (no classic cards): GitHub, git identity, Coolify, Cloudflare, Bedrock', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/integrations?tab=github',
      initialState: owner,
      routes: routes(),
    });
    // p15-form-pattern: Genel bakış · GitHub · Coolify ve Cloudflare · Amazon Bedrock are tabs.
    const gh = await screen.findByTestId('github-connected');
    expect(within(gh).getByTestId('github-key-age').textContent).toBe('40 günlük');
    expect((await within(gh).findByTestId('protection-vitrin-web')).textContent).toContain(
      'koruma kuralı yok',
    );
    await user.click(within(gh).getByRole('button', { name: 'Depoları göster' }));
    const repos = await within(gh).findByRole('list', { name: 'octo-org depoları' });
    expect(repos.textContent).toContain('octo-org/eski-site');
    expect(repos.textContent).toContain('arşivde');
    expect((await screen.findByTestId('git-identity-effective')).textContent).toContain(
      'çalışma alanı varsayılanı',
    );
    await user.click(screen.getByRole('tab', { name: 'Coolify ve Cloudflare' }));
    expect(await screen.findByTestId('dy-ops-coolify')).toBeTruthy();
    expect(screen.getByTestId('dy-ops-cloudflare')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Amazon Bedrock' }));
    expect((await screen.findByTestId('bedrock-active')).textContent).toContain(
      'panel (Ayarlar → Entegrasyonlar)',
    );
    expect(screen.getByTestId('bedrock-iam-policy').textContent).toContain('bedrock:InvokeModel');
    for (const classic of [
      'Test connection',
      'Default git identity',
      'Refresh installations',
      'Always protected',
    ])
      expect(screen.queryByText(classic)).toBeNull();
  });

  it('Coolify: a replaced token is saved through step-up and never shown (p13-multi-coolify connection)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    const conn = SETTINGS_COOLIFY_CONNECTIONS.items[0];
    const url = `/api/integrations/coolify/connections/${conn?.id ?? ''}`;
    const r = renderApp({
      path: '/settings/integrations?tab=ops',
      initialState: owner,
      routes: routes({
        [`PUT ${url}`]: (req) => {
          if (!stepped) return { status: 403, body: STEP_UP };
          body = req.body;
          return { status: 200, body: conn };
        },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    const card = await screen.findByTestId(`coolify-conn-${conn?.id ?? ''}`);
    await user.click(within(card).getByRole('button', { name: 'Düzenle' }));
    const token = within(card).getByLabelText<HTMLInputElement>('Yeni API token’ı (isteğe bağlı)');
    expect(token.type).toBe('password');
    await user.type(token, 'cf-SECRET-token-123');
    await user.click(within(card).getByRole('button', { name: 'Kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(body).toMatchObject({
        label: 'Sunucu Coolify (varsayılan)',
        url: 'https://coolify.example',
        team: null,
        allProjects: true,
        token: 'cf-SECRET-token-123',
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('coolify-conn-edit')).toBeNull();
    });
    expect(document.body.textContent).not.toContain('cf-SECRET-token-123');
    expect(r.requests.filter((q) => q.method === 'PUT').length).toBe(2);
  });

  it('Cloudflare: "Bağlantıyı test et" shows zones, the DNS probe and the missing preview permissions', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/integrations?tab=ops',
      initialState: owner,
      routes: routes({
        'POST /api/integrations/ops/cloudflare/test': ok({
          ok: true,
          tokenStatus: 'active',
          zones: [{ id: 'z1', name: 'example.org' }],
          pages: { access: false },
          dns: [
            {
              zone: 'example.org',
              zoneId: 'z1',
              ok: false,
              error: 'Authentication error',
              projects: ['vitrin-web'],
            },
          ],
          previews: {
            tunnels: true,
            accessApps: false,
            serviceTokens: false,
            missing: ['Account → Access: Apps and Policies → Edit'],
          },
        }),
      }),
    });
    const panel = await screen.findByTestId('dy-ops-cloudflare');
    await user.click(within(panel).getByRole('button', { name: 'Bağlantıyı test et' }));
    const test = await within(panel).findByTestId('cloudflare-test');
    expect(test.textContent).toContain('Token etkin.');
    expect(test.textContent).toContain('erişim yok');
    expect(within(test).getByTestId('cloudflare-dns-probe').textContent).toContain('Zone → DNS → Edit eksik');
    expect(within(test).getByTestId('preview-missing-scope').textContent).toBe(
      'Account → Access: Apps and Policies → Edit',
    );
  });

  it('default git identity: Turkish validation, then a save through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/settings/integrations?tab=github',
      initialState: owner,
      routes: routes({
        'PUT /api/settings/git-identity': (req) => {
          if (!stepped) return { status: 403, body: STEP_UP };
          body = req.body;
          return { status: 200, body: W3_GIT_IDENTITY };
        },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    const card = await screen.findByTestId('default-git-identity');
    // p15-form-pattern: in the GitHub tab's form the identity fields are open; the tab's bar saves them.
    const email = await within(card).findByLabelText('E-posta');
    expect(within(card).queryByRole('button', { name: 'Git kimliğini düzenle' })).toBeNull();
    await user.clear(email);
    await user.type(email, 'not-an-email');
    await user.click(screen.getByTestId('dy-form-save'));
    expect(within(card).getByText('ad@ornek.example gibi bir e-posta adresi girin.')).toBeTruthy();
    await user.clear(email);
    await user.type(email, 'bots@acme.example');
    await user.click(screen.getByTestId('dy-form-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(body).toEqual({ identity: { name: 'Remyral Bot', email: 'bots@acme.example' } });
    });
  });

  it('GitHub installed page records the installation natively', async () => {
    renderApp({
      path: '/settings/integrations/github/installed?installation_id=77&setup_action=install',
      initialState: owner,
      routes: routes({ 'POST /api/integrations/github/installations/sync': ok(SETTINGS_GITHUB) }),
    });
    const page = await screen.findByTestId('dy-github-installed');
    expect(await within(page).findByText(/octo-org hesabına kuruldu \(seçili depolar\)/)).toBeTruthy();
  });

  it('GitHub callback exchanges the code once with step-up and strips it from the address', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    const r = renderApp({
      path: '/settings/integrations/github/callback?code=abc123&state=st-9',
      initialState: owner,
      routes: routes({
        'POST /api/integrations/github/manifest/complete': (req) => {
          if (!stepped) return { status: 403, body: STEP_UP };
          body = req.body;
          return { status: 200, body: SETTINGS_GITHUB };
        },
        'POST /api/auth/step-up': stepUpRoute(() => {
          stepped = true;
        }),
      }),
    });
    await confirmStepUp(user);
    const page = await screen.findByTestId('dy-github-callback');
    expect(await within(page).findByText(/GitHub App Remyral \(octo-org\) bağlandı/)).toBeTruthy();
    expect(body).toEqual({ code: 'abc123', state: 'st-9' });
    expect(r.requests.filter((q) => q.url === '/api/integrations/github/manifest/complete').length).toBe(2);
  });
});

function fakeApi(stepUp: AuthApi['stepUp']): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp,
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.reject(new Error('offline')),
  };
}

function mount(node: ReactNode, handlers: Record<string, Handler>, api: AuthApi): void {
  stubCookies('__Host-ras-csrf=csrf-token');
  vi.stubGlobal('fetch', fakeFetch(handlers).fetch);
  render(
    <MemoryRouter>
      <AuthProvider api={api} initialState={owner}>
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('Diyalog GitHub panel — connect', () => {
  it('connects an organization through step-up and navigates to the manifest form', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    let posts = 0;
    let body: unknown = null;
    const stepUp = vi.fn(() =>
      Promise.resolve({ stepUpValidUntil: '2030-01-01T00:00:00.000Z', stepUpScope: 'window' as const }),
    );
    mount(
      <GitHubPanel navigate={navigate} />,
      {
        'GET /api/integrations/github': ok({
          ...SETTINGS_GITHUB,
          app: null,
          installations: [],
          projects: [],
        }),
        'POST /api/integrations/github/manifest': (req) => {
          if (++posts === 1) return { status: 403, body: STEP_UP };
          body = req.body;
          return {
            status: 200,
            body: { formPath: '/integrations/github/manifest/form?t=1' },
          };
        },
      },
      fakeApi(stepUp),
    );
    const view = await screen.findByTestId('github-disconnected');
    await user.click(within(view).getByLabelText('Bir organizasyonda'));
    const connect = within(view).getByRole('button', { name: 'GitHub’ı bağla' });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(view).getByLabelText('Organizasyon'), 'acme');
    await user.click(connect);
    await confirmStepUp(user);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/api/integrations/github/manifest/form?t=1');
    });
    expect(body).toEqual({ target: 'organization', organization: 'acme' });
  });
});
