// p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §2.7): Diyalog Yetenekler → "MCP sunucuları" with local
// (npm / PyPI) packages — the "Yerel paket" form with the registry lookup, publish as transport stdio + package behind
// a fresh step-up, the per-machine installs (canary first, fresh code for install / continue), and the placement
// reason `mcp_not_installed`.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { W3_SKILLS } from '../src/diyalog/harness/screens/w3-knowledge';
import { describeReason } from '../src/lib/reasons';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 15_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
const HASH = 'c'.repeat(64);
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

const SUMMARY = {
  id: 'files',
  title: 'Files',
  description: '',
  archived: false,
  latest: '1.0.0',
  transport: 'stdio',
  url: null,
  runtimes: ['claude-code', 'codex', 'opencode', 'pi'],
  toolCounts: { allow: 0, ask: 0, deny: 0 },
  toolsKnown: 0,
  assignments: 0,
  createdAt: '2026-10-21T10:00:00.000Z',
};

const VERSION = {
  version: '1.0.0',
  transport: 'stdio',
  url: null,
  headers: [],
  secretSlots: [],
  egressHosts: [],
  runtimes: SUMMARY.runtimes,
  limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
  signer: 'panel',
  keyId: '0123456789abcdef',
  specSha256: HASH,
  createdAt: '2026-10-21T10:00:00.000Z',
  createdBy: USER.id,
  package: {
    manager: 'npm',
    name: '@modelcontextprotocol/server-filesystem',
    version: '2026.1.14',
    integrity: INTEGRITY,
    bin: 'mcp-server-filesystem',
    args: ['/data'],
    env: [{ name: 'LOG_LEVEL', value: 'info', secret: null, format: null }],
  },
};

const ACTION_HELD = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'mcp.install',
  item: 'mcp:files',
  version: '1.0.0',
  rollout: 'canary-first',
  state: 'held',
  createdAt: '2026-10-21T10:10:00.000Z',
  createdBy: USER.id,
  expiresAt: '2026-10-22T10:10:00.000Z',
  finishedAt: null,
  counts: { succeeded: 1, held: 1 },
  targets: [
    {
      workerId: 'wrk_a',
      name: 'mac-1',
      phase: 1,
      state: 'succeeded',
      version: '1.0.0',
      attempts: 1,
      reason: null,
      detail: null,
      opId: null,
      jobId: null,
      updatedAt: '2026-10-21T10:11:00.000Z',
    },
    {
      workerId: 'wrk_b',
      name: 'linux-1',
      phase: 2,
      state: 'held',
      version: '1.0.0',
      attempts: 0,
      reason: null,
      detail: null,
      opId: null,
      jobId: null,
      updatedAt: '2026-10-21T10:10:00.000Z',
    },
  ],
};

function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: SUMMARY,
    versions: [VERSION],
    tools: [],
    policies: [],
    secrets: [],
    assignments: [],
    probes: [],
    installs: [
      {
        workerId: 'wrk_a',
        name: 'mac-1',
        version: '1.0.0',
        state: 'installed',
        digest: `sha256:${HASH}`,
        error: null,
        updatedAt: '2026-10-21T10:11:00.000Z',
        connected: true,
      },
    ],
    lockfiles: [
      {
        version: '1.0.0',
        manager: 'npm',
        sha256: HASH,
        bytes: 40960,
        producedOnWorker: 'wrk_a',
        createdAt: '2026-10-21T10:11:00.000Z',
      },
    ],
    installActions: [],
    stdioWorkers: [
      { id: 'wrk_a', name: 'mac-1', connected: true, canary: true, os: 'darwin', arch: 'arm64' },
      { id: 'wrk_b', name: 'linux-1', connected: true, canary: false, os: 'linux', arch: 'x64' },
    ],
    ...over,
  };
}

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': ok({ items: [] }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': ok({ items: [], nextCursor: null }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/skills': ok(W3_SKILLS),
    'GET /api/projects': ok({ items: [] }),
    'GET /api/mcp/servers': ok({
      servers: [SUMMARY],
      features: { workersWithMcp: 2 },
      mcpWorkers: [{ id: 'wrk_a', name: 'mac-1', connected: true }],
    }),
    'GET /api/mcp/servers/files': ok(detail()),
    'GET /api/vault/credentials': ok({ items: [] }),
    'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>, reason: string): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain(reason);
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog MCP sunucuları — yerel paketler (p14-mcp-stdio)', { timeout: 120_000 }, () => {
  it('local package form: lookup fills the integrity and bin, publish sends transport stdio + package', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let fresh = 0;
    let lookupBody: unknown = null;
    let body: unknown = null;
    renderApp({
      path: '/skills?tab=mcp',
      initialState: owner,
      routes: routes({
        'POST /api/mcp/packages/lookup': (req) => {
          lookupBody = req.body;
          return {
            status: 200,
            body: {
              manager: 'npm',
              name: '@modelcontextprotocol/server-filesystem',
              version: '2026.1.14',
              integrity: INTEGRITY,
              bins: ['mcp-server-filesystem'],
              file: 'server-filesystem-2026.1.14.tgz',
              license: 'MIT',
              description: 'Filesystem MCP server',
            },
          };
        },
        'POST /api/mcp/servers': (req) => {
          if (fresh === 0) return STEP_UP;
          body = req.body;
          return { status: 201, body: { server: SUMMARY, version: VERSION } };
        },
        'POST /api/auth/step-up': () => {
          fresh += 1;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Sunucu ekle' }));
    const form = await screen.findByTestId('mcp-server-form');
    await user.selectOptions(within(form).getByLabelText('Sunucu türü'), 'local');
    expect(within(form).queryByLabelText(/^Sunucu adresi/)).toBeNull();
    expect(within(form).getByTestId('mcp-scripts-note').textContent).toContain(
      'Kurulum script’leri çalıştırılmaz',
    );
    await user.type(within(form).getByLabelText(/^Kimlik/), 'files');
    await user.type(within(form).getByLabelText(/^Paket adı/), '@modelcontextprotocol/server-filesystem');
    await user.type(within(form).getByLabelText(/^Paket sürümü/), '2026.1.14');
    // Without integrity / bin the client refuses.
    await user.click(within(form).getByRole('button', { name: 'İmzala ve yayımla' }));
    expect(within(form).getByTestId('mcp-form-problem').textContent).toContain('Bütünlük özeti');

    await user.click(within(form).getByRole('button', { name: 'Paket bilgilerini getir' }));
    expect(await within(form).findByTestId('mcp-lookup-done')).toBeTruthy();
    expect(lookupBody).toEqual({
      manager: 'npm',
      name: '@modelcontextprotocol/server-filesystem',
      version: '2026.1.14',
    });
    expect(within(form).getByLabelText<HTMLInputElement>(/^Bütünlük özeti/).value).toBe(INTEGRITY);
    expect(within(form).getByLabelText<HTMLInputElement>(/^Çalıştırılacak komut/).value).toBe(
      'mcp-server-filesystem',
    );
    await user.type(within(form).getByLabelText(/^Sabit argümanlar/), '/data');
    await user.click(within(form).getByRole('button', { name: 'Değişken ekle' }));
    const env = within(form).getByTestId('mcp-env-row');
    await user.type(within(env).getByLabelText('Değişken adı'), 'API_TOKEN');
    await user.selectOptions(within(env).getByLabelText('Değer türü'), 'secret');
    await user.type(within(env).getByLabelText('Gizli yuva'), 'token');
    await user.type(within(env).getByLabelText(/^Ne konmalı/), 'service token');
    expect(within(form).getByTestId('mcp-pi-note')).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'İmzala ve yayımla' }));
    await confirmStepUp(user, 'Bir MCP sunucusu yayımlamak her seferinde yeni bir doğrulama kodu ister.');
    await waitFor(() => {
      expect(body).toEqual({
        id: 'files',
        title: 'files',
        version: '1.0.0',
        transport: 'stdio',
        package: {
          manager: 'npm',
          name: '@modelcontextprotocol/server-filesystem',
          version: '2026.1.14',
          integrity: INTEGRITY,
          bin: 'mcp-server-filesystem',
          args: ['/data'],
          env: { API_TOKEN: { secret: 'token' } },
        },
        secrets: [{ slot: 'token', why: 'service token' }],
        runtimes: ['claude-code', 'codex', 'opencode', 'pi'],
        limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
      });
    });
  });

  it('a reserved env name is refused on the client', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/skills?tab=mcp', initialState: owner, routes: routes() });
    await user.click(await screen.findByRole('button', { name: 'Sunucu ekle' }));
    const form = await screen.findByTestId('mcp-server-form');
    await user.selectOptions(within(form).getByLabelText('Sunucu türü'), 'local');
    await user.type(within(form).getByLabelText(/^Kimlik/), 'files');
    await user.type(within(form).getByLabelText(/^Paket adı/), 'server-x');
    await user.type(within(form).getByLabelText(/^Paket sürümü/), '1.2.3');
    await user.type(within(form).getByLabelText(/^Bütünlük özeti/), INTEGRITY);
    await user.type(within(form).getByLabelText(/^Çalıştırılacak komut/), 'server-x');
    await user.click(within(form).getByRole('button', { name: 'Değişken ekle' }));
    await user.type(
      within(within(form).getByTestId('mcp-env-row')).getByLabelText('Değişken adı'),
      'NODE_OPTIONS',
    );
    await user.click(within(form).getByRole('button', { name: 'İmzala ve yayımla' }));
    expect(within(form).getByTestId('mcp-form-problem').textContent).toContain('ayrılmış');
  });

  it('detail: package card, lockfile, installs; install sends workers + rollout after a fresh code', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let fresh = 0;
    let installBody: unknown = null;
    renderApp({
      path: '/skills?tab=mcp',
      initialState: owner,
      routes: routes({
        'POST /api/mcp/servers/files/versions/1.0.0/install': (req) => {
          if (fresh === 0) return STEP_UP;
          installBody = req.body;
          return { status: 201, body: { ...ACTION_HELD, state: 'running' } };
        },
        'POST /api/auth/step-up': () => {
          fresh += 1;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const row = await screen.findByTestId('mcp-server');
    expect(row.textContent).toContain('Yerel paket');
    await user.click(within(row).getByRole('button', { name: 'Ayrıntı' }));
    const d = await screen.findByTestId('mcp-server-detail');
    expect(within(d).getByTestId('mcp-package').textContent).toContain(
      'npm · @modelcontextprotocol/server-filesystem@2026.1.14',
    );
    expect(within(d).getByTestId('mcp-package').textContent).toContain('LOG_LEVEL');
    const installs = within(d).getByTestId('mcp-installs');
    expect(within(installs).getByTestId('mcp-lockfile').textContent).toContain('wrk_a');
    expect(within(installs).getByTestId('mcp-install').textContent).toContain('kurulu');
    expect(installs.textContent).toContain('salt okunur');
    expect(installs.textContent).toContain('yalnız okuyabilir');
    // The probe picks only machines where this version is installed.
    expect(within(d).getByTestId('mcp-probe').textContent).toContain('mac-1');

    await user.click(within(installs).getByRole('button', { name: 'Kur' }));
    expect(installs.textContent).toContain('En az bir makine seç.');
    await user.click(within(installs).getByTestId('mcp-install-worker-wrk_a'));
    await user.click(within(installs).getByTestId('mcp-install-worker-wrk_b'));
    await user.click(within(installs).getByRole('button', { name: 'Kur' }));
    await confirmStepUp(
      user,
      'Bir MCP paketini makinelere kurmak her seferinde yeni bir doğrulama kodu ister.',
    );
    await waitFor(() => {
      expect(installBody).toEqual({ workers: ['wrk_a', 'wrk_b'], rollout: 'canary-first' });
    });
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    expect(await findToast('Kurulum başladı; ilerleme aşağıda görünür.')).toBeTruthy();
  });

  it('a held action (canary done) shows "continue", which needs a fresh code', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let fresh = 0;
    let continued = false;
    renderApp({
      path: '/skills?tab=mcp',
      initialState: owner,
      routes: routes({
        'GET /api/mcp/servers/files': ok(detail({ installActions: [ACTION_HELD] })),
        'POST /api/mcp/install-actions/33333333-3333-4333-8333-333333333333/continue': () => {
          if (fresh === 0) return STEP_UP;
          continued = true;
          return { status: 200, body: { ...ACTION_HELD, state: 'running' } };
        },
        'POST /api/auth/step-up': () => {
          fresh += 1;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const row = await screen.findByTestId('mcp-server');
    await user.click(within(row).getByRole('button', { name: 'Ayrıntı' }));
    const action = await screen.findByTestId('mcp-install-action');
    expect(within(action).getByTestId('mcp-install-held').textContent).toContain('aynı kilit dosyasıyla');
    const targets = within(action).getAllByTestId('mcp-install-target');
    expect(targets[0]?.textContent).toContain('canary');
    expect(targets[1]?.textContent).toContain('diğerleri');
    await user.click(within(action).getByRole('button', { name: 'Diğer makinelere devam et' }));
    await confirmStepUp(user, 'Diğer makinelere kurmak her seferinde yeni bir doğrulama kodu ister.');
    await waitFor(() => {
      expect(continued).toBe(true);
    });
  });

  it('placement reason mcp_not_installed in Turkish and English, with the MCP servers fix', () => {
    const raw = 'mcp_not_installed: files@1.0.0 is not installed on this machine';
    const tr = describeReason(raw, { workerName: 'mac-1' }, { locale: 'tr' });
    expect(tr.known).toBe(true);
    expect(tr.sentence).toBe(
      'Bu işin yerel MCP paketi mac-1 makinesinde kurulu değil. Yetenekler → MCP sunucuları → Kur.',
    );
    expect(tr.action).toEqual({ label: 'MCP sunucularını aç', href: '/skills?tab=mcp' });
    const en = describeReason(raw, { workerName: 'mac-1' });
    expect(en.sentence).toBe(
      "This job's local MCP package is not installed on mac-1. Skills → MCP servers → Install.",
    );
    expect(en.action).toEqual({ label: 'Open MCP servers', href: '/skills?tab=mcp' });
  });
});
