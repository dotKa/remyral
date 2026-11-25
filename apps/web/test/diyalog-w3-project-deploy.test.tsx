// p12-diyalog wave 2 (W3): Projeler → Deploy natively in the Diyalog language — quick deploy, deploy targets (saved
// through step-up with the classic body), Pages project create / domain (review → request), site upload with recent
// uploads, uptime auto-monitor and verification & health; viewers read only; no classic English panels left.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  DEPLOY_OPS,
  DEPLOY_TARGETS,
  SITE_UPLOADS,
  VERIFY_SETTINGS,
} from '../src/diyalog/harness/screens/w3-project-deploy';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = { ...owner, user: { ...USER, role: 'viewer' } };

function project(myRole: string): Record<string, unknown> {
  return {
    id: 'alpha',
    name: 'Alpha app',
    kind: 'repository',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: null,
    members: 2,
    myRole,
  };
}

function action(kind: string, state: string, env: string | null): Record<string, unknown> {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    project: 'alpha',
    kind,
    env,
    params: {},
    target: {},
    diff: {},
    policy: { decision: state === 'awaiting_approval' ? 'approval' : 'auto', reason: '' },
    state,
    requestedBy: { type: 'user', id: 'u1', username: 'alex' },
    via: 'web',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    expiresAt: null,
    finishedAt: null,
  };
}

function routes(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () => ok({ items: [project(role)] }),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    'GET /api/deploy/actions?project=alpha&limit=8': () => ok({ items: [], nextCursor: null }),
    'GET /api/projects/alpha/deploy-targets': () =>
      ok({ project: 'alpha', targets: DEPLOY_TARGETS, version: 4, updatedAt: null }),
    'GET /api/integrations/ops': () => ok(DEPLOY_OPS),
    'GET /api/projects/alpha/site-uploads': () =>
      ok({ items: SITE_UPLOADS.items.map((u) => ({ ...u, project: 'alpha' })) }),
    'GET /api/uptime/settings?project=alpha': () =>
      ok({ project: 'alpha', autoMonitor: false, updatedAt: null }),
    'GET /api/projects/alpha/verify-settings': () => ok({ ...VERIFY_SETTINGS, project: 'alpha' }),
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

describe('Diyalog Projeler → Deploy (p12-diyalog wave 2, W3)', { timeout: 20_000 }, () => {
  it('renders every section natively (no classic panels) and a quick deploy reports the decision', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let sent: unknown = null;
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        'POST /api/deploy/actions': (req) => {
          sent = req.body;
          return ok(action('coolify.deploy', 'awaiting_approval', 'production'));
        },
      }),
    });
    const targets = await screen.findByTestId('dy-deploy-targets');
    expect(within(targets).getByRole('heading', { name: 'Deploy hedefleri' })).toBeTruthy();
    expect(within(targets).getByLabelText<HTMLInputElement>('Diğer Pages projeleri').value).toBe(
      'mobil-docs',
    );
    // The zones the Cloudflare token sees are offered to admins, allowed ones ticked.
    expect(within(targets).getByLabelText<HTMLInputElement>('mobil.example').checked).toBe(true);
    expect(within(targets).getByLabelText<HTMLInputElement>('vitrin.test').checked).toBe(false);
    expect(screen.getByTestId('site-upload-card')).toBeTruthy();
    expect(await screen.findByText('landing-v3')).toBeTruthy();
    expect(screen.getByTestId('pages-project-card')).toBeTruthy();
    expect(await screen.findByLabelText('Deploy edilen siteleri otomatik izle')).toBeTruthy();
    // p15-form-pattern: the verification card is a section of the Deploy tab's form (no own save button).
    expect(await screen.findByTestId('verify-settings')).toBeTruthy();
    expect(screen.queryByText('Doğrulama ayarlarını kaydet')).toBeNull();
    // Classic English panels are gone.
    for (const t of [
      'Deploy targets',
      'Upload a site',
      'Create a new Pages project',
      'Verification & health',
    ])
      expect(screen.queryByText(t)).toBeNull();
    expect(screen.getByTestId('project-deploy').closest('.dy-bridge')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Üretime deploy' }));
    await waitFor(() => {
      expect(sent).toMatchObject({ project: 'alpha', kind: 'coolify.deploy', params: { env: 'production' } });
    });
    expect(await screen.findByText(/Coolify deploy \(production\): Onay bekler/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Aç' }).getAttribute('href')).toBe(
      '/deploys/55555555-5555-4555-8555-555555555555',
    );
  });

  it('saves the deploy targets through step-up with the classic body', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let put: unknown = null;
    const r = renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        'PUT /api/projects/alpha/deploy-targets': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          put = req.body;
          return ok({ project: 'alpha', targets: DEPLOY_TARGETS, version: 5, updatedAt: null });
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' });
        },
      }),
    });
    const targets = await screen.findByTestId('dy-deploy-targets');
    await user.click(within(targets).getByLabelText('vitrin.test'));
    await user.selectOptions(within(targets).getByLabelText('DNS değişiklikleri'), 'approval_step_up');
    // p15-form-pattern: the Deploy tab's sticky bar saves the targets.
    await user.click(screen.getByTestId('dy-form-save'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(put).not.toBeNull();
    });
    expect(put).toMatchObject({
      targets: {
        pages: { projectName: 'mobil-landing' },
        pagesProjects: ['mobil-docs'],
        dns: {
          zones: [
            { id: 'z1', name: 'mobil.example' },
            { id: 'z2', name: 'vitrin.test' },
          ],
        },
        policy: { dnsChange: 'approval_step_up' },
        previews: { prefix: 'pr', maxActive: 5 },
      },
    });
    expect(await screen.findByText('Deploy hedefleri kaydedildi.')).toBeTruthy();
    expect(r.requests.filter((q) => q.method === 'PUT').length).toBe(2);
  });

  it('a new Pages project: review shows the master’s diff and policy, then the request', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const posted: unknown[] = [];
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        'POST /api/deploy/actions/preview': (req) => {
          posted.push(req.body);
          return ok({
            diff: {
              action: 'create project',
              project: 'alpha-site',
              productionBranch: 'main',
              subdomain: 'alpha-site.pages.dev',
              directUpload: true,
              pagesProjects: { targetUnchanged: 'mobil-landing' },
            },
            policy: { decision: 'approval', reason: '' },
          });
        },
        'POST /api/deploy/actions': (req) => {
          posted.push(req.body);
          return ok(action('pages.create_project', 'awaiting_approval', null));
        },
      }),
    });
    const card = await screen.findByTestId('pages-project-card');
    const request = within(card).getAllByRole('button', { name: 'İste' })[0] as HTMLButtonElement;
    await user.type(within(card).getByLabelText('Proje adı'), 'Bad_Name');
    expect(within(card).getByText(/1–58 küçük harf/)).toBeTruthy();
    await user.clear(within(card).getByLabelText('Proje adı'));
    await user.type(within(card).getByLabelText('Proje adı'), 'alpha-site');
    expect(request.disabled).toBe(true);
    await user.click(within(card).getAllByRole('button', { name: 'İncele' })[0] as HTMLElement);
    const review = await within(card).findByTestId('pages-review');
    expect(within(review).getByText('Pages projesini oluştur')).toBeTruthy();
    expect(within(review).getByText('Onay bekler')).toBeTruthy();
    await user.click(request);
    await waitFor(() => {
      expect(posted).toHaveLength(2);
    });
    expect(posted[1]).toMatchObject({
      project: 'alpha',
      kind: 'pages.create_project',
      params: { name: 'alpha-site' },
    });
    expect(await within(card).findByText(/Pages projesi: Onay bekler/)).toBeTruthy();
  });

  it('uptime auto-monitor saves at once; viewers read only and get no deploy actions', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let body: unknown = null;
    const first = renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        'PUT /api/uptime/settings': (req) => {
          body = req.body;
          return ok({ project: 'alpha', autoMonitor: true, updatedAt: null });
        },
      }),
    });
    await user.click(await screen.findByLabelText('Deploy edilen siteleri otomatik izle'));
    await waitFor(() => {
      expect(body).toEqual({ project: 'alpha', autoMonitor: true });
    });
    expect(await screen.findByText('Bu projenin yeni deploy’ları otomatik izlenir.')).toBeTruthy();
    first.unmount();

    renderApp({ path: '/projects/alpha?tab=deploy', initialState: viewer, routes: routes('viewer') });
    await screen.findByTestId('dy-deploy-targets');
    expect(screen.queryByTestId('dy-quick-deploy')).toBeNull();
    expect(screen.queryByTestId('site-upload-card')).toBeNull();
    expect(screen.queryByTestId('pages-project-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deploy hedeflerini kaydet' })).toBeNull();
    expect(screen.getByText('Deploy hedeflerini proje yöneticileri değiştirir.')).toBeTruthy();
    expect((await screen.findByTestId('uptime-settings-current')).textContent).toContain('Kapalı');
    expect(await screen.findByText('Bu ayarları proje yöneticileri değiştirir.')).toBeTruthy();
  });
});
