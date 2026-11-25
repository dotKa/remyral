// p13-multi-coolify (ADR-0050): Project → Deploy picks the Coolify connection per environment (classic + Diyalog),
// deploy diffs name the Coolify, and Coolify uptime monitors pick their connection (classic + Diyalog).
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthApi, type AuthState, AuthProvider } from '../src/auth/AuthProvider';
import {
  DEPLOY_OPS,
  DEPLOY_TARGETS,
  VERIFY_SETTINGS,
} from '../src/diyalog/harness/screens/w3-project-deploy';
import { MonitorFormDialog } from '../src/diyalog/screens/uptime/MonitorFormDialog';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = '2026-10-20T08:00:00.000Z';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const CONNECTIONS = {
  items: [
    { id: C1, label: 'Sunucu Coolify (varsayılan)', host: 'coolify.example.org', isDefault: true },
    { id: C2, label: 'Harici Coolify', host: 'coolify.example.com', isDefault: false },
  ],
};
const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

function fakeApi(): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: unused,
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.reject(new Error('offline')),
  };
}

function mount(node: ReactNode, routes: Record<string, Handler>) {
  stubCookies('__Host-ras-csrf=csrf-token');
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <AuthProvider api={fakeApi()} initialState={owner}>
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f.requests;
}

const project = (id: string) => ({
  id,
  name: id,
  kind: 'repository' as const,
  createdAt: NOW,
  createdBy: null,
  members: 1,
  myRole: 'owner' as const,
});

function monitorBody(config: Record<string, unknown>) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    project: 'shop',
    name: 'App',
    type: 'coolify',
    config,
    outputKey: null,
    intervalSec: 300,
    timeoutMs: 10_000,
    retries: 1,
    paused: false,
    status: 'pending',
    flapping: false,
    consecutiveFailures: 0,
    statusChangedAt: NOW,
    lastCheck: null,
    tls: null,
    uptime: { h24: null, d7: null, d30: null },
    latencyAvg24h: null,
    sparkline: [],
    openIncident: null,
    nextCheckAt: NOW,
    createdBy: { type: 'user', id: USER.id },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Projeler → Deploy: Coolify bağlantısı', { timeout: 20_000 }, () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('picks the second connection for production and saves it through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let put: unknown = null;
    const base: Record<string, Handler> = {
      'GET /api/auth/session': () => ok(sessionBody()),
      'GET /api/projects': () => ok({ items: [{ ...project('alpha'), name: 'Alpha app' }] }),
      'GET /api/approvals?status=pending': () => ok({ items: [] }),
      'GET /api/workers': () => ok({ workers: [] }),
      'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
      'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
      'GET /api/notifications/unread-count': () => ok({ count: 0 }),
      'GET /api/deploy/actions?project=alpha&limit=8': () => ok({ items: [], nextCursor: null }),
      'GET /api/projects/alpha/deploy-targets': () =>
        ok({ project: 'alpha', targets: DEPLOY_TARGETS, version: 4, updatedAt: null }),
      'GET /api/projects/alpha/coolify-connections': () => ok(CONNECTIONS),
      'GET /api/integrations/ops': () => ok(DEPLOY_OPS),
      'GET /api/projects/alpha/site-uploads': () => ok({ items: [] }),
      'GET /api/uptime/settings?project=alpha': () =>
        ok({ project: 'alpha', autoMonitor: false, updatedAt: null }),
      'GET /api/projects/alpha/verify-settings': () => ok({ ...VERIFY_SETTINGS, project: 'alpha' }),
      'PUT /api/projects/alpha/deploy-targets': (req) => {
        if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
        put = req.body;
        return ok({ project: 'alpha', targets: DEPLOY_TARGETS, version: 5, updatedAt: null });
      },
      'POST /api/auth/step-up': () => {
        stepped = true;
        return ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' });
      },
    };
    const routes = new Proxy(base, {
      get: (t, k: string) =>
        t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
    });
    renderApp({ path: '/projects/alpha?tab=deploy', initialState: owner, routes });
    const targets = await screen.findByTestId('dy-deploy-targets');
    const prod = await within(targets).findByTestId<HTMLSelectElement>('dy-coolify-connection-production');
    await waitFor(() => {
      expect(prod.value).toBe(C1);
    });
    await user.selectOptions(prod, C2);
    // p15-form-pattern: the Deploy tab's sticky bar saves the targets.
    await user.click(screen.getByTestId('dy-form-save'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(put).not.toBeNull();
    });
    expect(put).toMatchObject({
      targets: { coolify: { preview: { connection: null }, production: { connection: C2 } } },
    });
  });
});

describe('Coolify uptime monitors pick their connection', { timeout: 20_000 }, () => {
  const routes = (sent: unknown[]): Record<string, Handler> => ({
    'GET /api/projects/shop/coolify-connections': () => ok(CONNECTIONS),
    'POST /api/uptime/monitors': (req) => {
      sent.push(req.body);
      return { status: 201, body: monitorBody((req.body as { config: Record<string, unknown> }).config) };
    },
  });

  it('Diyalog dialog sends config.connection (automatic leaves it out)', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    mount(
      <MonitorFormDialog
        open
        monitor={null}
        projects={[project('shop')]}
        defaultProject="shop"
        onSaved={() => undefined}
        onClose={() => undefined}
      />,
      routes(sent),
    );
    await user.selectOptions(screen.getByLabelText('Tür'), 'coolify');
    await user.type(screen.getByLabelText('Ad'), 'App');
    await user.type(screen.getByLabelText('Coolify uygulama uuid’i'), 'shopprod01');
    const pick = screen.getByLabelText<HTMLSelectElement>('Coolify bağlantısı');
    expect(pick.value).toBe('');
    await within(pick).findByText('Harici Coolify (coolify.example.com)');
    await user.selectOptions(pick, C2);
    await user.click(screen.getByRole('button', { name: 'Monitörü oluştur' }));
    await waitFor(() => {
      expect(sent.length).toBe(1);
    });
    expect(sent[0]).toMatchObject({ type: 'coolify', config: { uuid: 'shopprod01', connection: C2 } });
  });
});
