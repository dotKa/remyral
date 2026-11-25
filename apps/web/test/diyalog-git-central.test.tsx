// p15-git-central: Makine → Araçlar → Git card (readiness + one-click Düzelt through step-up), Projeler → Depo →
// repository credential (validation, request body) and the git identity note.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { RepoCredentialPanel } from '../src/diyalog/screens/projects/tabs/repo-credential';
import { configTools } from '../src/diyalog/harness/screens/w3-machine-config';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };
const W = 'w9';
const B = `/api/workers/${W}`;
const OP = '00000000-0000-4000-8000-0000000000c1';
const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

const WORKER = {
  id: W,
  name: 'desktop-pc',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:x',
  os: 'win32',
  arch: 'x64',
  osVersion: '11',
  hostname: 'desktop-pc',
  workerVersion: '1.0.60',
  runningJobs: 0,
  lastSeenAt: new Date().toISOString(),
  createdAt: '2026-10-01T10:00:00.000Z',
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [],
  credentials: [],
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

const GIT = {
  workerId: W,
  displayName: 'desktop-pc',
  connected: true,
  supported: true,
  readiness: {
    checkedAt: '2026-10-22T10:00:00.000Z',
    git: { present: true, version: '2.47.1.windows.2', source: 'managed' },
    problems: [
      { code: 'global_credential_helper', severity: 'info', count: 1, helpers: ['manager'] },
      { code: 'os_store_github', severity: 'warning', fix: 'erase_github_credentials', count: 2 },
      { code: 'a_future_code', severity: 'warning' },
    ],
    jobsIsolated: true,
  },
  readinessAt: '2026-10-22T10:00:00.000Z',
  fixable: ['erase_github_credentials'],
};

function op(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OP,
    workerId: W,
    kind: 'git.fix',
    params: { fixes: ['erase_github_credentials'] },
    state: 'sent',
    reason: null,
    detail: null,
    progress: null,
    result: null,
    requestedBy: 'u1',
    requestedAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: null,
    login: null,
    logs: null,
    ...over,
  };
}

function stepUpGate(): { gate: (h: Handler) => Handler; route: Record<string, Handler> } {
  let done = false;
  return {
    gate: (h) => (req) =>
      done
        ? h(req)
        : {
            status: 403,
            body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
          },
    route: {
      'POST /api/auth/step-up': () => {
        done = true;
        return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
      },
    },
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [WORKER] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/approvals?status=pending': ok({ items: [], nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    [`GET ${B}`]: ok(WORKER),
    [`GET /api/jobs?worker=${W}&state=RUNNING&limit=20`]: ok({ items: [], nextCursor: null }),
    [`GET ${B}/tools`]: ok(configTools(W)),
    [`GET ${B}/git`]: ok(GIT),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Makine → Araçlar → Git (p15-git-central)', () => {
  it('shows git, isolation and problems (unknown codes left out); Düzelt goes through step-up', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({
        ...s.route,
        [`POST ${B}/git/fix`]: s.gate(ok({ id: OP, state: 'sent' })),
        [`GET ${B}/ops/${OP}?after=0`]: ok(
          op({
            state: 'succeeded',
            result: { gitFix: { results: [{ fix: 'erase_github_credentials', outcome: 'applied' }] } },
          }),
        ),
      }),
    });
    const panel = await screen.findByTestId('git-readiness');
    expect(await within(panel).findByText('git 2.47.1.windows.2')).toBeTruthy();
    expect(within(panel).getByTestId('git-isolation').textContent).toContain(
      'İşler makinenin git ayarlarını',
    );
    expect(within(panel).getByTestId('git-problem-os_store_github').textContent).toContain(
      '2 eski GitHub girişi',
    );
    expect(within(panel).getByTestId('git-problem-global_credential_helper').textContent).toContain(
      'manager',
    );
    expect(within(panel).queryByTestId('git-problem-a_future_code')).toBeNull();
    await user.click(within(panel).getByTestId('git-fix'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST' && r.url === `${B}/git/fix`)?.body).toEqual({});
    });
    expect((await within(panel).findByTestId('git-fix-results')).textContent).toContain(
      'Eski GitHub girişlerini sil: yapıldı',
    );
  });

  it('viewers read the card without a button; an older worker build says so', async () => {
    renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: viewer,
      routes: routes(),
    });
    const panel = await screen.findByTestId('git-readiness');
    expect(await within(panel).findByText('git 2.47.1.windows.2')).toBeTruthy();
    expect(within(panel).queryByTestId('git-fix')).toBeNull();
  });

  it('an unsupported worker gets the update hint', async () => {
    renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({ [`GET ${B}/git`]: ok({ ...GIT, supported: false, readiness: null, fixable: [] }) }),
    });
    const panel = await screen.findByTestId('git-readiness');
    expect(await within(panel).findByText(/makineyi güncelleyin/)).toBeTruthy();
    expect(within(panel).queryByTestId('git-fix')).toBeNull();
  });
});

describe('Projeler → Depo → Depo erişimi (p15-git-central)', () => {
  function mount(extra: Record<string, Handler>) {
    const f = fakeFetch({
      'GET /api/projects/demo/git/credential': ok({ project: 'demo', credential: null, workers: [] }),
      'GET /api/vault/credentials': ok({
        items: [],
      }),
      ...extra,
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <AuthProvider initialState={owner}>
          <StepUpProvider>
            <RepoCredentialPanel project="demo" canEdit />
          </StepUpProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    return f.requests;
  }

  it('refuses bad known_hosts in the browser and sends a valid SSH deploy key reference', async () => {
    const user = userEvent.setup();
    const requests = mount({
      'PUT /api/projects/demo/git/credential': ok({
        project: 'demo',
        credential: {
          kind: 'ssh-key',
          credentialId: 'deploy-key',
          credentialName: 'Deploy key',
          username: null,
          knownHosts: `git.example.com ssh-ed25519 ${ED25519}`,
          access: 'read',
          version: 1,
          updatedAt: '2026-10-22T10:00:00.000Z',
          updatedBy: 'alex',
        },
        workers: [{ id: W, name: 'desktop-pc', supported: true }],
      }),
    });
    const panel = await screen.findByTestId('dy-project-repo-credential');
    expect((await within(panel).findByTestId('repo-credential-none')).textContent).toBe('Tanımlı değil.');
    await user.click(within(panel).getByTestId('repo-credential-edit'));
    await user.type(within(panel).getByLabelText('Kimlik bilgisi'), 'deploy-key');
    await user.type(
      within(panel).getByLabelText('Sabitlenmiş known_hosts satırları'),
      '*.example.com ssh-ed25519 AAAA',
    );
    await user.click(within(panel).getByTestId('repo-credential-save'));
    expect((await within(panel).findByRole('alert')).textContent).toContain('Bir satır geçerli değil');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    const kh = within(panel).getByLabelText('Sabitlenmiş known_hosts satırları');
    await user.clear(kh);
    await user.type(kh, `git.example.com ssh-ed25519 ${ED25519}`);
    await user.selectOptions(within(panel).getByLabelText('Depodaki yetkisi'), 'read');
    await user.click(within(panel).getByTestId('repo-credential-save'));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        kind: 'ssh-key',
        credentialId: 'deploy-key',
        access: 'read',
        knownHosts: `git.example.com ssh-ed25519 ${ED25519}`,
      });
    });
    expect((await within(panel).findByTestId('repo-credential-current')).textContent).toContain('Deploy key');
  });
});
