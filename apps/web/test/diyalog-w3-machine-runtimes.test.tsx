// p12-diyalog wave 2 (W3) — machine page → Runtime’lar and Etkinlik in the Diyalog language (flag on): managed
// runtimes with every classic action (install / upgrade / roll back / reinstall / restart / remove, confirmations,
// step-up), the subscription login dialog (provider link only, code relay), log out confirmed, the bounded reload
// after an install, viewers read only; history, logs, diagnostics and the remote-operation history.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  HISTORY_FIXTURE,
  opFixture,
  opsStatusFixture,
} from '../src/diyalog/harness/screens/w3-machine-runtimes';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const OP = '00000000-0000-4000-8000-0000000000a1';

const W2 = {
  id: 'w2',
  name: 'kestrel-mac',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:w2',
  os: 'darwin',
  arch: 'arm64',
  osVersion: '15',
  hostname: 'kestrel-mac',
  workerVersion: '1.0.41',
  runningJobs: 0,
  lastSeenAt: iso(1000),
  createdAt: iso(86_400_000),
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [
    {
      runtime: 'codex',
      version: '0.161.0',
      installed: true,
      authenticated: 'yes',
      pinnedVersion: '0.162.1',
      pinStatus: 'mismatch',
      present: true,
    },
  ],
  credentials: [],
};

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [W2] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/usage-limits/overview': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/usage-limits/overview?history=1': ok({
      generatedAt: iso(0),
      settings: { nearThreshold: 80, notifyNear: true },
      entries: [],
      otherLimits: [],
    }),
    'GET /api/workers/w2': ok(W2),
    'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/workers/w2/history': ok(HISTORY_FIXTURE),
    'GET /api/workers/w2/ops': ok(opsStatusFixture('w2')),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Makine → Runtime’lar (Diyalog)', () => {
  it('shows every runtime with its versions, the classic action set in Turkish, and no classic texts', async () => {
    renderApp({ path: '/machines/w2?tab=runtimes', initialState: owner, routes: routes() });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    expect(within(claude).getByRole('button', { name: '2.1.290 sürümüne geri al' })).toBeTruthy();
    expect(within(claude).getByRole('button', { name: '2.1.296 kaldır' })).toBeTruthy();
    expect(within(claude).getByTestId('login-status-claude-code').textContent).toBe('Oturumun süresi doldu');
    expect(within(claude).getByTestId('login-expired-claude-code').textContent).toContain(
      'abonelik oturumunu yenileyemedi',
    );
    expect(within(claude).getByRole('button', { name: 'Yeniden oturum aç' })).toBeTruthy();
    const codex = screen.getByTestId('runtime-card-codex');
    expect(within(codex).getByRole('button', { name: '0.162.1 sürümüne yükselt' })).toBeTruthy();
    const opencode = screen.getByTestId('runtime-card-opencode');
    expect(within(opencode).getByRole('button', { name: '1.14.2 yeniden kur' })).toBeTruthy();
    expect(opencode.textContent).toContain('değiştirilmiş, kullanılmıyor');
    expect(
      within(screen.getByTestId('runtime-card-pi')).getByTestId('runtime-unsupported').textContent,
    ).toContain('Node.js >= 24');
    // The Diyalog panel replaced the classic one.
    expect(screen.queryByText(/Upgrade to|Roll back to|Subscription login/)).toBeNull();
  });

  it('removing a version is confirmed first, then runs through the classic request', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/runtimes/claude-code/remove': ok(
          opFixture(OP, 'w2', { kind: 'runtime.remove', state: 'sent', finishedAt: null }),
        ),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: ok(
          opFixture(OP, 'w2', {
            kind: 'runtime.remove',
            params: { runtime: 'claude-code', version: '2.1.290' },
            state: 'running',
            finishedAt: null,
          }),
        ),
      }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    await user.click(within(claude).getByRole('button', { name: '2.1.290 kaldır' }));
    expect(requests.some((r) => r.url.endsWith('/runtimes/claude-code/remove'))).toBe(false);
    // p18-confirm-dialog: the question is a confirm dialog.
    const ask = await screen.findByRole('dialog', { name: 'Claude Code 2.1.290 kaldırılsın mı?' });
    await user.click(within(ask).getByRole('button', { name: '2.1.290 kaldır' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url.endsWith('/runtimes/claude-code/remove'))?.body).toEqual({
        version: '2.1.290',
      });
    });
    const post = requests.find((r) => r.url.endsWith('/runtimes/claude-code/remove'));
    expect(post?.headers['x-csrf-token']).toBe('csrf-token');
    expect(await screen.findByTestId('op-line')).toBeTruthy();
  });

  it('asks for a code (step-up) and retries the install', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const status = opsStatusFixture('w2');
    const report = status.report as { runtimes: Record<string, unknown>[] };
    report.runtimes[1] = { ...report.runtimes[1], installed: [], active: null };
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2/ops': ok(status),
        'POST /api/workers/w2/runtimes/codex/install': () => {
          calls += 1;
          return calls === 1
            ? {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with your authenticator.' },
              }
            : { status: 200, body: opFixture(OP, 'w2', { state: 'sent', finishedAt: null }) };
        },
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: ok(
          opFixture(OP, 'w2', { state: 'running', finishedAt: null }),
        ),
      }),
    });
    const codex = await screen.findByTestId('runtime-card-codex');
    await user.click(within(codex).getByRole('button', { name: '0.162.1 kur' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('güncel doğrulama kodunu girin');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(calls).toBe(2);
    });
  });

  it('login dialog: provider link only (noopener), relays the pasted code, then reports success', async () => {
    const user = userEvent.setup();
    const signIn = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s';
    let sent = false;
    let polls = 0;
    const loginOp = (over: Record<string, unknown>) =>
      opFixture(OP, 'w2', {
        kind: 'login.start',
        params: { runtime: 'claude-code' },
        finishedAt: null,
        ...over,
      });
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/runtimes/claude-code/login': ok(loginOp({ state: 'sent' })),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: () => {
          polls += 1;
          if (sent && polls > 3) return { status: 200, body: loginOp({ state: 'succeeded' }) };
          return {
            status: 200,
            body: loginOp({
              state: 'waiting_for_user',
              login: {
                runtime: 'claude-code',
                url: signIn,
                userCode: null,
                expectsCode: true,
                codeSent: sent,
              },
            }),
          };
        },
        [`POST /api/workers/w2/ops/${OP}/input`]: () => {
          sent = true;
          return { status: 200, body: loginOp({ state: 'waiting_for_user' }) };
        },
      }),
    });
    const claude = await screen.findByTestId('runtime-card-claude-code');
    await user.click(within(claude).getByRole('button', { name: 'Yeniden oturum aç' }));
    const dialog = await screen.findByTestId('login-dialog');
    const link = await within(dialog).findByRole('link', { name: /Giriş sayfasını aç/ });
    expect(link.getAttribute('href')).toBe(signIn);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    await user.type(within(dialog).getByLabelText('Giriş sayfasındaki kod'), 'abc123#s');
    await user.click(within(dialog).getByRole('button', { name: 'Kodu gönder' }));
    expect(requests.find((r) => r.url.endsWith('/input'))?.body).toEqual({ code: 'abc123#s' });
    expect(await within(dialog).findByTestId('login-done', {}, { timeout: 8_000 })).toBeTruthy();
  });

  it('log out is confirmed before the request', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/runtimes/codex/logout': ok(
          opFixture(OP, 'w2', { kind: 'login.logout', state: 'sent', finishedAt: null }),
        ),
        [`GET /api/workers/w2/ops/${OP}?after=0`]: ok(opFixture(OP, 'w2', { kind: 'login.logout' })),
      }),
    });
    const codex = await screen.findByTestId('runtime-card-codex');
    await user.click(within(codex).getByRole('button', { name: 'Oturumu kapat' }));
    expect(requests.some((r) => r.url.endsWith('/logout'))).toBe(false);
    const ask = await screen.findByRole('dialog', { name: /Codex bu makinede oturumu kapatsın mı/ });
    await user.click(within(ask).getByRole('button', { name: 'Oturumu kapat' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/runtimes/codex/logout'))).toBe(
        true,
      );
    });
  });

  it('an old worker build says so and still lists what the machine reports', async () => {
    renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: routes({
        'GET /api/workers/w2/ops': ok(opsStatusFixture('w2', { supported: false, report: null })),
      }),
    });
    expect(await screen.findByTestId('remote-ops-unsupported')).toBeTruthy();
    expect(screen.getByTestId('runtime-row').getAttribute('data-runtime')).toBe('codex');
  });

  it('viewers see what the machine reports, without actions or the ops request', async () => {
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: viewer,
      routes: routes(),
    });
    const row = await screen.findByTestId('runtime-row');
    expect(row.textContent).toContain('Sürüm 0.161.0');
    expect(screen.queryByRole('button', { name: /kur|kaldır|Oturum aç/ })).toBeNull();
    expect(requests.some((r) => r.url === '/api/workers/w2/ops')).toBe(false);
  });
});

describe('Makine → Etkinlik (Diyalog)', () => {
  it('history in words; logs and diagnostics on demand; the remote-operation history', async () => {
    const user = userEvent.setup();
    const LOGS = '00000000-0000-4000-8000-0000000000b1';
    const DIAG = '00000000-0000-4000-8000-0000000000c1';
    const { requests } = renderApp({
      path: '/machines/w2?tab=activity',
      initialState: owner,
      routes: routes({
        'POST /api/workers/w2/logs': ok(opFixture(LOGS, 'w2', { kind: 'logs.tail', state: 'sent' })),
        [`GET /api/workers/w2/ops/${LOGS}?after=0`]: ok(
          opFixture(LOGS, 'w2', {
            kind: 'logs.tail',
            params: { lines: 300, source: 'boot' },
            logs: {
              lines: ['{"msg":"worker daemon starting"}', '{"msg":"[REDACTED]"}'],
              next: 2,
              complete: true,
              truncated: true,
            },
          }),
        ),
        'POST /api/workers/w2/diagnostics': ok(
          opFixture(DIAG, 'w2', { kind: 'diagnostics.run', state: 'sent' }),
        ),
        [`GET /api/workers/w2/ops/${DIAG}?after=0`]: ok(
          opFixture(DIAG, 'w2', {
            kind: 'diagnostics.run',
            params: {},
            result: {
              diagnostics: {
                collectedAt: iso(0),
                workerVersion: '1.0.41',
                node: { version: '24.11.0', ok: true, requiredMajor: 24 },
                os: { platform: 'darwin', release: '25.0', arch: 'arm64' },
                uptimeSec: 100,
                memory: { freeBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
                disk: [{ name: 'dataDir', freeBytes: 300 * 1024 ** 2, totalBytes: 32 * 1024 ** 3 }],
                sandbox: [{ profile: 'container', ready: false, reason: 'docker not found' }],
                runtimes: [],
                service: { manager: 'launchd', state: 'running' },
                problems: [{ code: 'disk.low', severity: 'error', message: 'dataDir: 300 MiB free' }],
              },
            },
          }),
        ),
      }),
    });
    const history = await screen.findByTestId('worker-history');
    expect(history.textContent).toContain('Bağlandı');
    expect(history.textContent).toContain('Yeni anahtar onaylandı');
    expect(history.textContent).toContain('(başarısız)');

    const ops = await screen.findByTestId('ops-history');
    expect(ops.textContent).toContain('Kurulum');
    expect(ops.textContent).toContain('checksum_mismatch');

    await user.selectOptions(screen.getByLabelText('Günlük'), 'boot');
    await user.click(screen.getByRole('button', { name: 'Günlüğü al' }));
    await waitFor(() => {
      expect(screen.getByTestId('log-viewer').textContent).toContain('worker daemon starting');
    });
    expect(requests.find((r) => r.method === 'POST' && r.url.endsWith('/logs'))?.body).toEqual({
      lines: 300,
      source: 'boot',
    });
    expect(screen.getByText(/Eski satırlar dışarıda kaldı/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Tanılamayı çalıştır' }));
    const diag = await screen.findByTestId('diagnostics');
    expect(within(diag).getByTestId('diagnostics-problems').textContent).toContain('disk.low');
    expect(diag.textContent).toContain('docker not found');
    expect(screen.queryByText(/Fetch logs|Run diagnostics|Remote operations/)).toBeNull();
  });

  it('viewers get the history only', async () => {
    const { requests } = renderApp({
      path: '/machines/w2?tab=activity',
      initialState: viewer,
      routes: routes(),
    });
    expect(await screen.findByTestId('worker-history')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Günlüğü al' })).toBeNull();
    expect(requests.some((r) => r.url === '/api/workers/w2/ops')).toBe(false);
  });
});
