// p12-diyalog-w2: Onaylar (`/approvals`, `/approvals/:id`) in the Diyalog language — Bekleyen / Karar verilen tabs with
// their own keyset pages in the URL, Bayat / İş duraklatıldı pills, the readable call (agent's words, command with
// copy / collapse / split, what it touches, raw text), approve with the code in place (and the master's
// step_up_required retry), deny with a required reason, "thread'de aç", Klasik görünüm and flag off unchanged.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';
import { invalidate } from '../src/lib/invalidate';

configure({ asyncUtilTimeout: 5_000 });

const A1 = 'a0000000-0000-4000-8000-0000000000a1';
const A2 = 'a0000000-0000-4000-8000-0000000000a2';
const A3 = 'a0000000-0000-4000-8000-0000000000a3';
const JOB = '7c1e09ab-4d2f-4b8a-9c3e-1f2a3b4c5d6e';
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

const LONG = Array.from({ length: 20 }, (_, i) => `echo line-${String(i)}`).join('\n');

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A1,
    jobId: JOB,
    project: 'acme',
    jobState: 'RUNNING',
    kind: 'in_run',
    action: 'fs.delete_outside_workspace',
    requestedAction: 'fs.delete',
    risk: 'high',
    summary: 'Bash: rm -rf node_modules && pnpm install',
    requestedBy: { type: 'worker', id: 'w-1' },
    workerId: 'w-1',
    approverRole: 'admin',
    requiredApprovals: 1,
    approvals: 0,
    stepUp: true,
    status: 'pending',
    epoch: 1,
    createdAt: iso(18 * MIN),
    expiresAt: iso(-42 * MIN),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    staleAt: iso(MIN),
    pauseRequestedAt: null,
    jobPaused: false,
    details: {
      tool: 'Bash',
      description: 'Clear the cache and reinstall',
      command: 'rm -rf node_modules && pnpm install',
      shell: 'posix',
      cwd: '/work/acme',
    },
    hints: {
      runs: ['rm', 'pnpm'],
      reaches: [],
      writes: [],
      deletes: ['node_modules'],
      installs: ['pnpm install'],
      envVars: [],
      outside: [],
      elevated: false,
      safeVerdict: null,
      partial: false,
    },
    headline: { text: 'Clear the cache and reinstall', source: 'agent' },
    ...over,
  };
}

const PAUSED = request({
  id: A2,
  action: 'network.egress_non_allowlisted',
  risk: 'medium',
  jobState: 'PAUSED',
  jobPaused: true,
  staleAt: null,
  stepUp: false,
  details: null,
  hints: null,
  summary: 'curl https://example.com',
  headline: { text: 'curl https://example.com', source: 'summary' },
});

const DENIED = request({
  id: A3,
  status: 'denied',
  decidedAt: iso(5 * MIN),
  decidedBy: { id: 'u2', username: 'derya' },
  decisionReason: 'Not needed',
  staleAt: null,
});

const page = (items: unknown[], nextCursor: string | null = null) => ({
  status: 200,
  body: { items, nextCursor },
});

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => page([]),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/approvals?status=pending&limit=25': () => page([request(), PAUSED]),
    'GET /api/approvals?limit=25': () => page([request(), DENIED]),
    [`GET /api/approvals/${A1}`]: () => ({ status: 200, body: { request: request(), decisions: [] } }),
    [`GET /api/approvals/${A3}`]: () => ({
      status: 200,
      body: {
        request: DENIED,
        decisions: [
          {
            decision: 'deny',
            user: { username: 'derya' },
            role: 'admin',
            reason: 'Not needed',
            decidedAt: iso(5 * MIN),
          },
        ],
      },
    }),
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

describe('Diyalog Onaylar (p12-diyalog-w2)', { timeout: 20_000 }, () => {
  it('lists pending requests with risk, Bayat / İş duraklatıldı pills, the agent line and the tab count', async () => {
    const r = renderApp({ path: '/approvals', initialState: state('admin'), routes: base() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Onaylar' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    const rows = await screen.findAllByTestId('approval-row');
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(within(first).getByTestId('risk-badge').textContent).toContain('Yüksek risk');
    expect(within(first).getByTestId('badge-stale')).toBeTruthy();
    expect(within(first).getByText('Çalışma alanı dışında silme')).toBeTruthy();
    expect(within(first).getByTestId('approval-headline').textContent).toContain(
      '“Clear the cache and reinstall”',
    );
    expect(within(first).getByTestId('approval-command-preview').textContent).toBe('rm -rf node_modules');
    expect(within(second).getByTestId('badge-job-paused')).toBeTruthy();
    expect(within(first).getByTestId('approval-card').getAttribute('href')).toBe(`/approvals/${A1}`);
    const tab = screen.getByRole('tab', { name: /Bekleyen/ });
    await waitFor(() => {
      expect(tab.textContent).toContain('2');
    });
    // The classic page is not mounted.
    expect(screen.queryByRole('heading', { level: 1, name: 'Approvals' })).toBeNull();
  });

  it('a request that arrives while the screen is open shows without leaving the page', async () => {
    let calls = 0;
    renderApp({
      path: '/approvals',
      initialState: state('admin'),
      routes: base({
        'GET /api/approvals?status=pending&limit=25': () => {
          calls += 1;
          return calls === 1 ? page([request()]) : page([request(), PAUSED]);
        },
      }),
    });
    expect(await screen.findAllByTestId('approval-row')).toHaveLength(1);
    invalidate('approvals');
    await waitFor(() => {
      expect(screen.getAllByTestId('approval-row')).toHaveLength(2);
    });
  });

  it('Karar verilen tab: its own URL state, the decided rows only, and a next page by cursor', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/approvals',
      initialState: state('admin'),
      routes: base({
        'GET /api/approvals?limit=25': () => page([request(), DENIED], 'c-2'),
        'GET /api/approvals?limit=25&cursor=c-2': () => page([DENIED]),
      }),
    });
    await screen.findAllByTestId('approval-row');
    await user.click(screen.getByRole('tab', { name: 'Karar verilen' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('approval-row')).toHaveLength(1);
    });
    const row = screen.getByTestId('approval-row');
    expect(within(row).getByText('Reddedildi')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Onayla/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/approvals?limit=25&cursor=c-2')).toBe(true);
    });
    expect(screen.getByRole('navigation', { name: 'Karar verilen istek sayfaları' }).textContent).toContain(
      'Sayfa 2',
    );
  });

  it('detail: the readable call with copy, split and collapse, the fields and the thread links', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp({
      path: `/approvals/${A1}`,
      initialState: state('admin'),
      routes: base({
        [`GET /api/approvals/${A1}`]: () => ({
          status: 200,
          body: {
            request: request({ details: { tool: 'Bash', command: LONG, shell: 'posix' } }),
            decisions: [],
          },
        }),
      }),
    });
    const detail = await screen.findByTestId('approval-detail');
    expect(within(detail).getByRole('heading', { name: 'Çalışma alanı dışında silme' })).toBeTruthy();
    expect(within(detail).getByText('fs.delete')).toBeTruthy();
    const cmd = within(detail).getByTestId('request-command');
    expect(cmd.getAttribute('data-collapsed')).toBe('true');
    await user.click(within(detail).getByTestId('command-toggle'));
    expect(cmd.getAttribute('data-collapsed')).toBe('false');
    await user.click(within(detail).getByRole('button', { name: 'Kopyala' }));
    expect(writeText).toHaveBeenCalledWith(LONG);
    // p17-toasts-shortcuts: the copy result is a toast (bottom right), not a line next to the button.
    expect(await findToast('Kopyalandı.')).toBeTruthy();
    expect(within(detail).getByTestId('request-effect').textContent).toBe('Çalışan ajan bu kararı bekliyor.');
    expect(within(detail).getByTestId('thread-link').getAttribute('href')).toBe(`/needs#kart=approval:${A1}`);
    expect(within(detail).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe(`/jobs/${JOB}`);
    expect(within(detail).getByTestId('request-summary')).toBeTruthy();
  });

  it('p17-worker-1-1-1: an elevated command shows the agent’s purpose above the command, labelled unverified', async () => {
    renderApp({
      path: `/approvals/${A1}`,
      initialState: state('admin'),
      routes: base({
        [`GET /api/approvals/${A1}`]: () => ({
          status: 200,
          body: {
            request: request({
              action: 'machine.admin',
              requestedAction: 'machine.admin',
              summary: '[sh] id -u',
              details: {
                tool: 'admin_exec',
                description: 'Kök yardımcının çalıştığını denetle',
                command: 'id -u',
                shell: 'posix',
              },
            }),
            decisions: [],
          },
        }),
      }),
    });
    const detail = await screen.findByTestId('approval-detail');
    const says = within(detail).getByTestId('agent-says');
    expect(says.textContent).toBe(
      'Amaç (ajanın açıklaması, doğrulanmadı)“Kök yardımcının çalıştığını denetle”',
    );
    const call = within(detail).getByTestId('approval-call');
    // The purpose comes first, the exact command after it.
    expect(call.firstElementChild).toBe(says);
    expect(within(call).getByTestId('request-command').textContent).toBe('id -u');
  });

  it('detail: split view for a chained command; what it touches', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/approvals/${A1}`, initialState: state('admin'), routes: base() });
    const detail = await screen.findByTestId('approval-detail');
    const split = within(detail).getByTestId('command-formatted');
    expect(split.getAttribute('aria-pressed')).toBe('false');
    await user.click(split);
    expect(split.getAttribute('aria-pressed')).toBe('true');
    expect(within(detail).getByTestId('request-command').textContent).toContain('\n');
    const touches = within(detail).getByTestId('touch-hints');
    expect(within(touches).getByText('Siler')).toBeTruthy();
    expect(within(touches).getByText('node_modules')).toBeTruthy();
  });

  it('approve from the detail: the code is asked in place, then the step-up and the decision', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let decided = false;
    const r = renderApp({
      path: `/approvals/${A1}`,
      initialState: state('admin'),
      routes: base({
        [`GET /api/approvals/${A1}`]: () => ({
          status: 200,
          body: {
            request: decided
              ? request({
                  status: 'approved',
                  decidedAt: iso(0),
                  decidedBy: { id: USER.id, username: 'alex' },
                })
              : request(),
            decisions: [],
          },
        }),
        'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
        [`POST /api/approvals/${A1}/approve`]: () => {
          decided = true;
          return {
            status: 200,
            body: {
              request: request({ status: 'approved', approvals: 1 }),
              final: true,
              jobState: 'RUNNING',
            },
          };
        },
      }),
    });
    const detail = await screen.findByTestId('approval-detail');
    await user.click(within(detail).getByRole('button', { name: 'Onayla' }));
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    await user.type(within(detail).getByLabelText('Authenticator kodu'), '123456');
    await user.click(within(detail).getByRole('button', { name: 'Kodu gönder ve onayla' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('approval-detail')).getByTestId('request-status').textContent).toBe(
        'Onaylandı',
      );
    });
    const posts = r.requests.filter((q) => q.method === 'POST').map((q) => q.url);
    expect(posts).toEqual(['/api/auth/step-up', `/api/approvals/${A1}/approve`]);
    expect(await findToast('Onaylandı: Çalışma alanı dışında silme.')).toBeTruthy();
  });

  it('approve from a row without a code; the master asks for one and the field opens (step-up retry)', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    let calls = 0;
    const r = renderApp({
      path: '/approvals',
      initialState: state('admin'),
      routes: base({
        'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
        [`POST /api/approvals/${A2}/approve`]: () => {
          calls += 1;
          return calls === 1
            ? {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with your authenticator.' },
              }
            : {
                status: 200,
                body: { request: { ...PAUSED, status: 'approved' }, final: true, jobState: 'RUNNING' },
              };
        },
      }),
    });
    const rows = await screen.findAllByTestId('approval-row');
    const paused = rows[1] as HTMLElement;
    await user.click(within(paused).getByRole('button', { name: 'Onayla: İzin listesi dışında ağ erişimi' }));
    const field = await within(paused).findByLabelText('Authenticator kodu');
    await user.type(field, '654321');
    await user.click(within(paused).getByRole('button', { name: 'Kodu gönder ve onayla' }));
    await waitFor(() => {
      expect(screen.getByText('Onaylandı: İzin listesi dışında ağ erişimi.')).toBeTruthy();
    });
    const posts = r.requests.filter((q) => q.method === 'POST').map((q) => q.url);
    expect(posts).toEqual([
      `/api/approvals/${A2}/approve`,
      '/api/auth/step-up',
      `/api/approvals/${A2}/approve`,
    ]);
  });

  it('deny needs a reason; the reason is sent with the code', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: `/approvals/${A1}`,
      initialState: state('admin'),
      routes: base({
        'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
        [`POST /api/approvals/${A1}/deny`]: () => ({
          status: 200,
          body: { request: request({ status: 'denied' }), final: true, jobState: 'FAILED' },
        }),
      }),
    });
    const detail = await screen.findByTestId('approval-detail');
    await user.click(within(detail).getByRole('button', { name: 'Gerekçeyle reddet' }));
    await user.click(within(detail).getByRole('button', { name: 'Reddet' }));
    expect(
      await within(detail).findByText('Gerekçe yaz: karşı taraf neden reddedildiğini görür.'),
    ).toBeTruthy();
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    await user.type(within(detail).getByLabelText('Gerekçe'), 'Use the test key');
    await user.type(within(detail).getByLabelText('Authenticator kodu'), '123456');
    await user.click(within(detail).getByRole('button', { name: 'Reddet' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === `/api/approvals/${A1}/deny`)).toBe(true);
    });
    expect(r.requests.find((q) => q.url === `/api/approvals/${A1}/deny`)?.body).toEqual({
      reason: 'Use the test key',
    });
  });

  it('viewers see the request but no decision buttons', async () => {
    renderApp({ path: `/approvals/${A1}`, initialState: state('viewer'), routes: base() });
    const detail = await screen.findByTestId('approval-detail');
    expect(within(detail).getByTestId('cannot-decide')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Onayla' })).toBeNull();
  });

  it('a decided request shows its outcome and the decisions', async () => {
    renderApp({ path: `/approvals/${A3}?tab=decided`, initialState: state('admin'), routes: base() });
    const detail = await screen.findByTestId('approval-detail');
    expect(within(detail).getByTestId('request-outcome').textContent).toContain('Reddedildi, derya');
    expect(within(detail).getByText('Reddetti')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Onayla' })).toBeNull();
  });
});
