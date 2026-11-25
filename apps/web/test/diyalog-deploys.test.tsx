// p12-diyalog-w2: Yayınlar (`/deploys`, `/deploys/:id`) in the Diyalog language — rows with state and health pills,
// source links and keyset pages; the detail with the DNS / Coolify / Pages diff, "Onayla ve çalıştır" with the code
// in place (policy approval_step_up), refresh, logs, roll back behind a confirmation, the health panel with
// "Yeniden kontrol et"; Klasik görünüm and flag off unchanged.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const D1 = 'd0000000-0000-4000-8000-0000000000d1';
const D2 = 'd0000000-0000-4000-8000-0000000000d2';
const D3 = 'd0000000-0000-4000-8000-0000000000d3';
const D4 = 'd0000000-0000-4000-8000-0000000000d4';
const AUTO = 'e0000000-0000-4000-8000-0000000000e1';
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

function action(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project: 'acme',
    kind: 'pages.deploy',
    env: 'production',
    params: {},
    target: { project: 'acme-site', branch: 'main' },
    diff: { action: 'deploy', project: 'acme-site', files: [{ path: 'index.html', bytes: 2048 }] },
    policy: { decision: 'approval_step_up', reason: 'production needs a code' },
    state: 'succeeded',
    requestedBy: { type: 'user', id: USER.id, username: 'alex' },
    via: 'api',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(30 * MIN),
    updatedAt: iso(30 * MIN),
    expiresAt: null,
    finishedAt: null,
    ...over,
  };
}

const DNS = action(D1, {
  kind: 'dns.upsert',
  env: null,
  state: 'awaiting_approval',
  target: { type: 'CNAME', name: 'shop.acme.example' },
  diff: {
    action: 'update',
    type: 'CNAME',
    name: 'shop.acme.example',
    zone: 'acme.example',
    before: { content: 'old.pages.dev', ttl: 1, proxied: true },
    after: { content: 'new.pages.dev', ttl: 1, proxied: true },
  },
  expiresAt: iso(-60 * MIN),
});
const PAGES = action(D2, { rollbackAvailable: true, source: { automationId: AUTO } });
const COOLIFY = action(D3, {
  kind: 'coolify.deploy',
  state: 'deploying',
  target: { resources: [{ name: 'api', uuid: 'u-1' }] },
  diff: {
    action: 'deploy',
    env: 'production',
    resources: [{ name: 'api', uuid: 'u-1', currentCommit: 'abc', to: 'def' }],
  },
  result: { deployments: [{ deploymentUuid: 'dep-1' }] },
});

const HEALTH = {
  id: 'h-1',
  opsActionId: D2,
  previewId: null,
  kind: 'pages',
  env: 'production',
  url: 'https://acme.example/',
  protected: false,
  state: 'failed',
  probe: { ok: false, statusCode: 502, latencyMs: 90, error: null, detail: null, tlsExpiresAt: null },
  links: {
    pages: 3,
    assets: 4,
    external: 1,
    truncated: false,
    broken: [{ url: 'https://acme.example/x.png', kind: 'asset', status: 404, error: null, from: '/' }],
  },
  findings: [],
  browserJobId: null,
  browserNote: null,
  screenshots: [],
  rollbackActionId: D4,
  rollbackNote: 'Rolled back automatically.',
  attempts: 1,
  createdAt: iso(29 * MIN),
  finishedAt: iso(28 * MIN),
};

const ok = (body: unknown) => ({ status: 200, body });

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/approvals?status=pending': () => ok({ items: [], nextCursor: null }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/deploy/actions?limit=25': () => ok({ items: [DNS, COOLIFY, PAGES], nextCursor: null }),
    'GET /api/deploy/actions?state=awaiting_approval&limit=100': () => ok({ items: [DNS], nextCursor: null }),
    [`GET /api/deploy-health?project=acme&actions=${D2}`]: () => ok({ items: [HEALTH] }),
    [`GET /api/deploy/actions/${D1}`]: () => ok(DNS),
    [`GET /api/deploy/actions/${D2}`]: () => ok(PAGES),
    [`GET /api/deploy/actions/${D3}`]: () => ok(COOLIFY),
    [`GET /api/deploy/actions/${D2}/health`]: () => ok({ health: HEALTH }),
    [`GET /api/deploy/actions/${D1}/health`]: () => ok({ health: null }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Yayınlar (p12-diyalog-w2)', { timeout: 20_000 }, () => {
  it('lists ops actions with state and health pills, the waiting count, source and thread links', async () => {
    const r = renderApp({ path: '/deploys', initialState: state('admin'), routes: base() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yayınlar' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    const rows = await screen.findAllByTestId('ops-row');
    expect(rows).toHaveLength(3);
    const [dns, coolify, pages] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(dns).getByTestId('ops-state').textContent).toBe('Onay bekliyor');
    expect(within(dns).getByRole('link', { name: 'DNS değişikliği' }).getAttribute('href')).toBe(
      `/deploys/${D1}`,
    );
    expect(within(dns).getByTestId('thread-link').getAttribute('href')).toBe(`/needs#kart=deploy:${D1}`);
    expect(within(coolify).getByTestId('ops-state').textContent).toBe('Yayınlanıyor');
    expect(within(pages).getByTestId('ops-source').getAttribute('href')).toBe(
      `/automations/${AUTO}?tab=runs`,
    );
    expect(within(pages).queryByTestId('thread-link')).toBeNull();
    expect(await within(pages).findByText('Sağlıksız')).toBeTruthy();
    expect(screen.getByTestId('deploys-waiting').textContent).toBe('1 eylem onay bekliyor');
  });

  it('keyset pages in the URL', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/deploys',
      initialState: state('admin'),
      routes: base({
        'GET /api/deploy/actions?limit=25': () => ok({ items: [DNS, COOLIFY, PAGES], nextCursor: 'n-2' }),
        'GET /api/deploy/actions?limit=25&cursor=n-2': () => ok({ items: [PAGES], nextCursor: null }),
      }),
    });
    await screen.findAllByTestId('ops-row');
    await user.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('ops-row')).toHaveLength(1);
    });
    expect(r.requests.some((q) => q.url === '/api/deploy/actions?limit=25&cursor=n-2')).toBe(true);
  });

  it('a waiting DNS change: the before / after diff, approve and run with the code in place', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/deploys/${D1}`,
      initialState: state('admin'),
      routes: base({
        'POST /api/auth/step-up': () => ok({ stepUpValidUntil: iso(-10 * MIN) }),
        [`POST /api/deploy/actions/${D1}/approve`]: () =>
          ok({
            ...DNS,
            state: 'succeeded',
            decidedBy: { id: USER.id, username: 'alex' },
            decidedAt: iso(0),
          }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'DNS değişikliği' })).toBeTruthy();
    const diff = screen.getByTestId('deploy-diff-dns');
    expect(within(diff).getByText('old.pages.dev')).toBeTruthy();
    expect(within(diff).getByText('new.pages.dev')).toBeTruthy();
    expect(screen.getByTestId('ops-policy').textContent).toBe('Onay ve authenticator kodu bekliyor');
    const decision = screen.getByTestId('ops-decision');
    await user.click(within(decision).getByRole('button', { name: 'Onayla ve çalıştır' }));
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    await user.type(within(decision).getByLabelText('Not (isteğe bağlı)'), 'ok to move');
    await user.type(within(decision).getByLabelText('Authenticator kodu'), '123456');
    await user.click(within(decision).getByRole('button', { name: 'Kodu gönder ve çalıştır' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('ops-state')[0]?.textContent).toBe('Başarılı');
    });
    const posts = r.requests.filter((q) => q.method === 'POST');
    expect(posts.map((q) => q.url)).toEqual(['/api/auth/step-up', `/api/deploy/actions/${D1}/approve`]);
    expect(posts[1]?.body).toEqual({ reason: 'ok to move' });
    expect(screen.queryByTestId('ops-decision')).toBeNull();
  });

  it('deny sends the optional reason', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/deploys/${D1}`,
      initialState: state('admin'),
      routes: base({ [`POST /api/deploy/actions/${D1}/deny`]: () => ok({ ...DNS, state: 'denied' }) }),
    });
    const decision = await screen.findByTestId('ops-decision');
    await user.click(within(decision).getByRole('button', { name: 'Reddet' }));
    await user.type(within(decision).getByLabelText('Not (isteğe bağlı)'), 'not now');
    await user.click(within(decision).getAllByRole('button', { name: 'Reddet' })[1] as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByTestId('ops-state')[0]?.textContent).toBe('Reddedildi');
    });
    expect(r.requests.find((q) => q.url === `/api/deploy/actions/${D1}/deny`)?.body).toEqual({
      reason: 'not now',
    });
  });

  it('a deploying Coolify action: refresh status and logs', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/deploys/${D3}`,
      initialState: state('admin'),
      routes: base({
        [`POST /api/deploy/actions/${D3}/refresh`]: () => ok({ ...COOLIFY, state: 'succeeded' }),
        // p12-deploy-feedback: the logs panel asks for one kind (build first).
        [`GET /api/deploy/actions/${D3}/logs?kind=build`]: () =>
          ok({
            items: [{ deploymentUuid: 'dep-1', logs: 'built ok' }],
            kind: 'build',
            provider: 'coolify',
            sources: [
              {
                id: 'dep-1',
                label: 'Coolify deployment dep-1',
                status: 'finished',
                text: 'built ok',
                truncated: false,
              },
            ],
            health: null,
            note: null,
          }),
        [`GET /api/deploy/actions/${D3}/health`]: () => ok({ health: null }),
      }),
    });
    expect(await screen.findByTestId('deploy-diff-coolify')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Loglar' }));
    expect(await screen.findByText('built ok')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Durumu yenile' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === `/api/deploy/actions/${D3}/refresh`)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('ops-state')[0]?.textContent).toBe('Başarılı');
    });
  });

  it('roll back asks first, then lands on the new action', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/deploys/${D2}`,
      initialState: state('admin'),
      routes: base({
        [`POST /api/deploy/actions/${D2}/rollback`]: () =>
          ok(action(D4, { kind: 'pages.rollback', rollbackOf: D2, state: 'executing' })),
        [`GET /api/deploy/actions/${D4}`]: () =>
          ok(action(D4, { kind: 'pages.rollback', rollbackOf: D2, state: 'executing' })),
        [`GET /api/deploy/actions/${D4}/health`]: () => ok({ health: null }),
      }),
    });
    await user.click(await screen.findByTestId('rollback'));
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    expect(screen.getByText('Önceki sürüme geri dönülsün mü?')).toBeTruthy();
    await user.click(screen.getByTestId('rollback-confirm'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pages geri alma · production' }),
    ).toBeTruthy();
    const post = r.requests.find((q) => q.url === `/api/deploy/actions/${D2}/rollback`);
    expect(typeof (post?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    expect(screen.getByRole('link', { name: 'Geri aldığı eylemi aç' }).getAttribute('href')).toBe(
      `/deploys/${D2}`,
    );
  });

  it('the health panel: probe, broken links, auto-rollback, check again', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/deploys/${D2}`,
      initialState: state('admin'),
      routes: base({
        'POST /api/deploy-health/h-1/recheck': () => ok({ health: { ...HEALTH, state: 'passed' } }),
      }),
    });
    const health = await screen.findByTestId('deploy-health');
    expect(within(health).getByText('Sağlıksız')).toBeTruthy();
    expect(within(health).getByTestId('deploy-health-probe').textContent).toContain('HTTP 502');
    expect(within(health).getByTestId('deploy-health-broken').textContent).toContain(
      'https://acme.example/x.png',
    );
    expect(within(health).getByTestId('deploy-health-rollback').textContent).toBe(
      'Rolled back automatically.',
    );
    expect(within(health).getByRole('link', { name: 'Geri almayı aç' }).getAttribute('href')).toBe(
      `/deploys/${D4}`,
    );
    await user.click(within(health).getByRole('button', { name: 'Yeniden kontrol et' }));
    expect(await within(health).findByText('Sağlıklı')).toBeTruthy();
    expect(r.requests.some((q) => q.url === '/api/deploy-health/h-1/recheck')).toBe(true);
  });
});
