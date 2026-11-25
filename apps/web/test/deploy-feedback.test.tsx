// p12-deploy-feedback (ADR-0048): the deploy detail's failure line, the Build / Runtime / Sağlık log tabs with search,
// live refresh and copy, "Düzeltme işi başlat" (the master's fix plan opened in the composer), the project's auto-fix
// setting and the shared log rows (text only).
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

const FAILED = action(D3, {
  kind: 'coolify.deploy',
  env: 'preview',
  state: 'failed',
  error: 'A Coolify deployment failed.',
  target: { resources: [{ name: 'api', uuid: 'u-1' }] },
  diff: { action: 'deploy', env: 'preview', resources: [{ name: 'api', uuid: 'u-1' }] },
  result: { deployments: [{ deploymentUuid: 'dep-1' }] },
});

const logs = (kind: string, text: string) =>
  ok({
    items: [],
    kind,
    provider: 'coolify',
    sources: [{ id: 'u-1', label: `api (${kind})`, status: 'failed', text, truncated: false }],
    health: null,
    note: null,
  });

describe('deploy feedback (p12-deploy-feedback)', { timeout: 20_000 }, () => {
  it('a failed deploy: the failure, the log tabs with search, and the fix job plan', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/deploys/${D3}`,
      initialState: state('admin'),
      routes: base({
        [`GET /api/deploy/actions/${D3}`]: () => ok(FAILED),
        [`GET /api/deploy/actions/${D3}/health`]: () => ok({ health: null }),
        [`GET /api/deploy/actions/${D3}/failure`]: () =>
          ok({
            actionId: D3,
            project: 'acme',
            kind: 'coolify.deploy',
            env: 'preview',
            state: 'failed',
            failure: 'deploy',
            error: 'A Coolify deployment failed.',
            sourceJobId: null,
            summary: 'The Coolify deploy (preview) failed: A Coolify deployment failed.',
          }),
        [`GET /api/deploy/actions/${D3}/logs?kind=build`]: () =>
          logs('build', 'npm run build\nError: Cannot find module x\ndone'),
        [`GET /api/deploy/actions/${D3}/logs?kind=runtime&lines=500`]: () =>
          logs('runtime', 'TypeError: boom at server.js'),
        [`GET /api/deploy/actions/${D3}/fix-plan`]: () =>
          ok({
            project: 'acme',
            projectKind: 'repository',
            title: 'Fix failed deploy: acme',
            spec: { runtime: 'claude-code', prompt: 'Fix it <<<deploy-report …' },
            continueFrom: null,
            deployOnSuccess: { target: 'coolify', env: 'preview' },
            failure: { summary: 'failed' },
          }),
      }),
    });
    expect((await screen.findByTestId('deploy-failure')).textContent).toContain(
      'Coolify deploy (preview) failed',
    );
    await user.click(screen.getByRole('button', { name: 'Loglar' }));
    const panel = await screen.findByTestId('ops-logs');
    expect(await within(panel).findByText('Error: Cannot find module x')).toBeTruthy();
    await user.type(within(panel).getByRole('searchbox'), 'module');
    await waitFor(() => {
      expect(within(panel).queryByText('npm run build')).toBeNull();
    });
    expect(within(panel).getByText('1 / 4 satır')).toBeTruthy();
    await user.click(within(panel).getByRole('radio', { name: 'Runtime' }));
    await user.clear(within(panel).getByRole('searchbox'));
    expect(await within(panel).findByText('TypeError: boom at server.js')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Canlı yenile' })).toBeTruthy();
    await user.click(screen.getByTestId('fix-job'));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === `/api/deploy/actions/${D3}/fix-plan`)).toBe(true);
    });
  });

  it('viewers see no logs button and no fix job', async () => {
    renderApp({
      path: `/deploys/${D3}`,
      initialState: state('viewer'),
      routes: base({
        [`GET /api/deploy/actions/${D3}`]: () => ok(FAILED),
        [`GET /api/deploy/actions/${D3}/health`]: () => ok({ health: null }),
      }),
    });
    expect(await screen.findByTestId('deploy-diff-coolify')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Loglar' })).toBeNull();
    expect(screen.queryByTestId('fix-job')).toBeNull();
  });
});

describe('deployLogRows', () => {
  it('turns sources into text rows with a heading, tones, timestamps and a filter', async () => {
    const { deployLogRows } = await import('../src/diyalog/screens/deploys/feedback');
    const rows = deployLogRows(
      {
        kind: 'runtime',
        provider: 'coolify',
        sources: [
          {
            id: 'a',
            label: 'api',
            status: 'running',
            text: '2026-10-19T10:00:00.000Z Error: \u001b[31mred\u001b[0m\nwarning: slow',
            truncated: true,
          },
        ],
        health: null,
        note: null,
      },
      '',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.segments[0]?.text).toContain('api [running] (son kısım)');
    expect(rows[1]).toMatchObject({ tone: 'danger', tsMs: Date.parse('2026-10-19T10:00:00.000Z') });
    expect(rows[1]?.segments[0]?.text).toBe('Error: red');
    expect(rows[2]?.tone).toBe('warn');
    expect(deployLogRows(null, '')).toEqual([]);
  });
});
