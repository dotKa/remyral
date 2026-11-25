// p19-ide W3 (docs/design/p19-ide.md §4, "Implementation (W3)"): the user's extension picker on the Tam IDE panel
// (required locked, recommended marked, blocked notice, save, settings reset), the workspace's install report,
// Ayarlar → Geliştirme ortamı (search Open VSX through the master, allow with the step-up, policy save) and the
// project's "IDE eklentileri" policy card (marks per allowed extension, enforced settings JSON).
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthApi, AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { IdePanel } from '../src/diyalog/code/IdePanel';
import { IdeExtensionsPolicyPanel } from '../src/diyalog/screens/projects/tabs/policy-ide';
import { IdeExtensionsView } from '../src/diyalog/screens/settings/IdeExtensionsView';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = '2026-10-29T10:00:00.000Z';
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

const allowed = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  version: '1.0.0',
  pinned: false,
  displayName: `Name ${id}`,
  description: '',
  publisherVerified: true,
  license: 'MIT',
  engine: '^1.90.0',
  dependencies: [],
  registryUrl: 'https://open-vsx.org',
  targets: [{ target: 'universal', sha256: 'a'.repeat(64), size: 10, keyId: 'k', keyPinned: true }],
  approvedBy: 'alex',
  approvedAt: NOW,
  ...over,
});

function fakeApi(): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: vi.fn(() =>
      Promise.resolve({ stepUpValidUntil: '2030-01-01T00:00:00.000Z', stepUpScope: 'window' as const }),
    ),
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.reject(new Error('offline')),
  };
}

function mount(node: ReactNode, handlers: Record<string, Handler>): ReturnType<typeof fakeFetch> {
  stubCookies('__Host-ras-csrf=csrf-token');
  const f = fakeFetch(handlers);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <AuthProvider api={fakeApi()} initialState={owner}>
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const workspace = {
  id: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003',
  project: 'alpha',
  userId: 'u1',
  username: 'ayse',
  workerId: 'wrk_a',
  workerName: 'linux-1',
  workerConnected: true,
  name: 'main',
  source: 'files',
  branch: null,
  baseRef: null,
  desired: 'running',
  state: 'running',
  detail: null,
  stopReason: null,
  head: null,
  memoryMb: 4096,
  idleMinutes: 30,
  memoryBytes: null,
  pullRequestUrl: null,
  startedAt: NOW,
  lastActivityAt: NOW,
  lastPushedAt: null,
  createdAt: NOW,
  stoppedAt: null,
  extensions: {
    skipped: [{ id: 'acme.denied', reason: 'denied' }],
    installed: ['acme.req'],
    failed: [{ id: 'acme.broken', reason: 'the downloaded VSIX has another SHA-256' }],
  },
};

describe('p19-ide W3: extensions and settings', { timeout: 30_000 }, () => {
  it('the user picks from the allowed set; required are locked; save sends the list; settings reset', async () => {
    const user = userEvent.setup();
    let reset = false;
    const f = mount(<IdePanel project="alpha" />, {
      'GET /api/projects/alpha/code': ok({
        project: 'alpha',
        kind: 'workspace',
        provider: null,
        repositoryUrl: null,
        defaultBranch: null,
        supported: true,
        reason: null,
        branches: [],
        workfiles: [],
      }),
      'GET /api/projects/alpha/ide': ok({
        configured: true,
        canUse: true,
        limits: { perMachine: 2, memoryMb: 4096, idleMinutes: 30, perUserProject: 3 },
        machines: [],
        workspaces: [workspace],
      }),
      'GET /api/projects/alpha/ide/extensions': () =>
        ok({
          available: [
            { ...allowed('acme.req'), required: true, recommended: false },
            { ...allowed('acme.rec'), required: false, recommended: true },
            { ...allowed('acme.free'), required: false, recommended: false },
          ],
          mine: ['acme.free'],
          required: ['acme.req'],
          recommended: ['acme.rec'],
          blocked: [{ id: 'acme.gone', reason: 'not_allowed' }],
          settings: reset
            ? { settingsBytes: null, keybindingsBytes: null, updatedAt: null }
            : { settingsBytes: 2048, keybindingsBytes: 100, updatedAt: NOW },
        })(undefined as never),
      'PUT /api/me/ide/extensions': (req) => ({
        status: 200,
        body: { extensions: (req.body as { extensions: string[] }).extensions },
      }),
      'DELETE /api/me/ide/settings': () => {
        reset = true;
        // (the fake fetch cannot build a 204 with a body; the client ignores the body of this answer)
        return { status: 200, body: {} };
      },
    });
    const report = await screen.findByTestId('ide-ext-report');
    expect(report.textContent).toContain('acme.broken');
    expect(report.textContent).toContain('acme.denied (bu eklenti yönetici tarafından engellendi)');
    const picker = await screen.findByTestId('ide-extensions');
    await user.click(within(picker).getByText('Eklentilerim'));
    expect((await within(picker).findByTestId('ide-ext-acme.req')).hasAttribute('disabled')).toBe(true);
    expect(within(picker).getByTestId<HTMLInputElement>('ide-ext-acme.req').checked).toBe(true);
    expect(within(picker).getByTestId('ide-ext-required').textContent).toBe(
      'Proje bu eklentiyi zorunlu tutuyor',
    );
    expect(within(picker).getByTestId('ide-ext-recommended').textContent).toBe('Proje öneriyor');
    expect(within(picker).getByTestId('ide-ext-blocked').textContent).toContain('acme.gone');
    expect(within(picker).getByTestId('ide-ext-save').hasAttribute('disabled')).toBe(true);
    await user.click(within(picker).getByTestId('ide-ext-acme.rec'));
    await user.click(within(picker).getByTestId('ide-ext-acme.free'));
    await user.click(within(picker).getByTestId('ide-ext-save'));
    await waitFor(() => {
      expect(f.requests.find((r) => r.method === 'PUT')?.body).toEqual({ extensions: ['acme.rec'] });
    });
    expect(within(picker).getByTestId('ide-settings-sync').textContent).toContain('settings.json 2 KiB');
    await user.click(within(picker).getByTestId('ide-settings-reset'));
    await waitFor(() => {
      expect(within(picker).getByTestId('ide-settings-sync').textContent).toContain(
        'Henüz eşitlenmiş ayar yok',
      );
    });
  });

  it('Geliştirme ortamı: search Open VSX, allow through the step-up, save the policy', async () => {
    const user = userEvent.setup();
    const f = mount(<IdeExtensionsView />, {
      'GET /api/ide/extension-policy': ok({
        registryUrl: 'https://open-vsx.org',
        verifiedOnly: false,
        deny: ['acme.bad'],
        updatedAt: null,
      }),
      'GET /api/ide/extensions': ok({
        extensions: [allowed('acme.base', { dependencies: ['acme.missing'] })],
      }),
      'GET /api/ide/extensions/search?q=yaml': ok({
        results: [
          {
            id: 'redhat.vscode-yaml',
            version: '2.1.0',
            displayName: 'YAML',
            description: 'YAML support',
            verified: true,
            deprecated: false,
            downloadCount: 10,
            allowedVersion: null,
            denied: false,
          },
        ],
      }),
      'POST /api/ide/extensions': () => ({
        status: 201,
        body: { extension: allowed('redhat.vscode-yaml', { version: '2.1.0', displayName: 'YAML' }) },
      }),
      'PUT /api/ide/extension-policy': (req) => ({
        status: 200,
        body: { registryUrl: 'https://open-vsx.org', updatedAt: NOW, ...(req.body as object) },
      }),
    });
    expect(await screen.findByTestId('ide-ext-missing-deps')).toBeTruthy();
    await user.type(screen.getByTestId('ide-ext-query'), 'yaml');
    await user.click(screen.getByTestId('ide-ext-search-run'));
    const hit = await screen.findByTestId('ide-ext-hit');
    await user.click(within(hit).getByTestId('ide-ext-allow'));
    await waitFor(() => {
      expect(screen.getAllByTestId('ide-ext-allowed')).toHaveLength(2);
    });
    expect(f.requests.find((r) => r.method === 'POST')?.body).toEqual({ id: 'redhat.vscode-yaml' });
    await user.clear(screen.getByTestId('ide-ext-deny'));
    await user.type(screen.getByTestId('ide-ext-deny'), 'acme.bad\nacme.worse');
    await user.click(screen.getByTestId('ide-ext-policy-save'));
    await waitFor(() => {
      expect(f.requests.find((r) => r.method === 'PUT')?.body).toEqual({
        registryUrl: 'https://open-vsx.org',
        verifiedOnly: false,
        deny: ['acme.bad', 'acme.worse'],
      });
    });
  });

  it('project policy: marks per allowed extension and enforced settings JSON', async () => {
    const user = userEvent.setup();
    const f = mount(<IdeExtensionsPolicyPanel project="alpha" canEdit />, {
      'GET /api/projects/alpha/ide/extension-policy': ok({
        required: ['acme.req'],
        recommended: [],
        deny: [],
        enforcedSettings: {},
        updatedAt: null,
      }),
      'GET /api/ide/extensions': ok({ extensions: [allowed('acme.req'), allowed('acme.other')] }),
      'PUT /api/projects/alpha/ide/extension-policy': (req) => ({
        status: 200,
        body: { updatedAt: NOW, ...(req.body as object) },
      }),
    });
    const select = await screen.findByTestId<HTMLSelectElement>('ide-ext-mark-acme.other');
    expect(screen.getByTestId<HTMLSelectElement>('ide-ext-mark-acme.req').value).toBe('required');
    await user.selectOptions(select, 'deny');
    const enforced = screen.getByTestId('ide-ext-enforced');
    await user.type(enforced, 'not json');
    await user.click(screen.getByText('Kaydet'));
    expect(await screen.findByText('Zorunlu ayarlar bir JSON nesnesi olmalı.')).toBeTruthy();
    await user.clear(enforced);
    await user.click(enforced);
    await user.paste('{"editor.tabSize": 2}');
    await user.click(screen.getByText('Kaydet'));
    await waitFor(() => {
      expect(f.requests.find((r) => r.method === 'PUT')?.body).toEqual({
        required: ['acme.req'],
        recommended: [],
        deny: ['acme.other'],
        enforcedSettings: { 'editor.tabSize': 2 },
      });
    });
  });
});
