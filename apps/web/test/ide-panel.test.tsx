// p19-ide W2 (docs/design/p19-ide.md §8, "Implementation (W2)"): the Kod tab's "Tam IDE" — the clear states (not
// configured, no usable machine (per-OS reasons, W2b), capacity full, viewer), the start dialog through the step-up, the workspace list
// (open in a new tab with the master's ticket URL, stop, start, delete with the unsent-changes warning) and the
// inbox that turns "Sohbete ekle" in the IDE into a pending chat reference.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthApi, AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { drainIdeReferences, ideActive, markIdeActive } from '../src/diyalog/code/ideInbox';
import { IdePanel } from '../src/diyalog/code/IdePanel';
import { clearPendingCodeRefs, codeRefLabel, parseCodeRef, pendingCodeRefs } from '../src/diyalog/code/refs';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const WS = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
const NOW = '2026-10-28T10:00:00.000Z';
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

const limits = { perMachine: 2, memoryMb: 4096, idleMinutes: 30, perUserProject: 3 };
const machine = (over: Record<string, unknown> = {}) => ({
  id: 'wrk_a',
  name: 'linux-1',
  online: true,
  available: true,
  reason: null,
  detail: null,
  running: 0,
  max: 2,
  ...over,
});
const workspace = (over: Record<string, unknown> = {}) => ({
  id: WS,
  project: 'alpha',
  userId: 'u1',
  username: 'ayse',
  workerId: 'wrk_a',
  workerName: 'linux-1',
  workerConnected: true,
  name: 'main',
  source: 'repository',
  branch: 'remyral/ide/ayse/main',
  baseRef: 'main',
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
  ...over,
});
const SOURCE = {
  project: 'alpha',
  kind: 'repository',
  provider: 'github',
  repositoryUrl: 'https://github.com/acme/alpha',
  defaultBranch: 'main',
  supported: true,
  reason: null,
  branches: [],
  workfiles: [],
};

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

function mount(handlers: Record<string, Handler>): ReturnType<typeof fakeFetch> {
  stubCookies('__Host-ras-csrf=csrf-token');
  const f = fakeFetch({ 'GET /api/projects/alpha/code': ok(SOURCE), ...handlers });
  vi.stubGlobal('fetch', f.fetch);
  const node: ReactNode = (
    <MemoryRouter>
      <AuthProvider api={fakeApi()} initialState={owner}>
        <StepUpProvider>
          <IdePanel project="alpha" />
        </StepUpProvider>
      </AuthProvider>
    </MemoryRouter>
  );
  render(node);
  return f;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearPendingCodeRefs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearPendingCodeRefs();
});

describe('p19-ide W2: Tam IDE on the Kod tab', { timeout: 30_000 }, () => {
  it('shows nothing to a viewer, and says when the server has no IDE address', async () => {
    mount({
      'GET /api/projects/alpha/ide': ok({
        configured: true,
        canUse: false,
        limits,
        machines: [],
        workspaces: [],
      }),
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ide-panel')).toBeNull();
    });
  });

  it('not configured: a clear notice, no start button', async () => {
    mount({
      'GET /api/projects/alpha/ide': ok({
        configured: false,
        canUse: true,
        limits,
        machines: [],
        workspaces: [],
      }),
    });
    expect((await screen.findByTestId('ide-not-configured')).textContent).toContain('ide.<alan adı>');
    expect(screen.queryByTestId('ide-new')).toBeNull();
    expect(screen.getByTestId('ide-desktop-only').textContent).toBe('Tam IDE masaüstünde açılır.');
  });

  it('no usable machine: each machine names its reason, with its OS where the machine says why (W2b)', async () => {
    mount({
      'GET /api/projects/alpha/ide': ok({
        configured: true,
        canUse: true,
        limits,
        machines: [
          machine({
            id: 'w1',
            name: 'mac-1',
            available: false,
            reason: 'platform_update',
            platform: 'darwin',
          }),
          machine({ id: 'w2', name: 'linux-2', online: false, available: false, reason: 'offline' }),
          machine({
            id: 'w3',
            name: 'win-arm',
            available: false,
            reason: 'unavailable',
            platform: 'win32',
            detailCode: 'platform_unsupported',
            detail: 'Windows on arm64: no IDE server build (code-server publishes windows-amd64 only)',
          }),
          machine({
            id: 'w4',
            name: 'win-1',
            available: false,
            reason: 'unavailable',
            platform: 'win32',
            detailCode: 'windows_accounts_required',
          }),
          machine({
            id: 'w5',
            name: 'mac-old',
            available: false,
            reason: 'unavailable',
            platform: 'darwin',
            detailCode: null,
            detail: 'something the console has no word for',
          }),
        ],
        workspaces: [],
      }),
    });
    const notice = await screen.findByTestId('ide-no-machine');
    expect(notice.textContent).toContain('Tam IDE için uygun makine yok.');
    expect(notice.textContent).toContain(
      'mac-1: macOS: bu işletim sisteminde Tam IDE için makine yazılımı güncellenmeli',
    );
    expect(notice.textContent).toContain('linux-2: çevrim dışı');
    expect(notice.textContent).toContain(
      'win-arm: Windows: henüz desteklenmiyor — bu işlemci için IDE sunucusu derlemesi yayımlanmıyor',
    );
    expect(notice.textContent).toContain('win-1: Windows: iş başına Windows hesapları hazır değil');
    expect(notice.textContent).toContain('mac-old: macOS: something the console has no word for');
    expect(screen.getByTestId('ide-new').hasAttribute('disabled')).toBe(true);
  });

  it('capacity full', async () => {
    mount({
      'GET /api/projects/alpha/ide': ok({
        configured: true,
        canUse: true,
        limits,
        machines: [machine({ available: false, reason: 'capacity', running: 2 })],
        workspaces: [],
      }),
    });
    expect((await screen.findByTestId('ide-capacity')).textContent).toBe(
      'Kapasite dolu: makine başına en fazla 2 IDE çalışır.',
    );
  });

  it('creates a workspace through the step-up and lists it', async () => {
    const user = userEvent.setup();
    let created = false;
    let calls = 0;
    const f = mount({
      'GET /api/projects/alpha/ide': () =>
        ok({
          configured: true,
          canUse: true,
          limits,
          machines: [machine()],
          workspaces: created ? [workspace({ state: 'preparing' })] : [],
        })({} as never),
      'POST /api/projects/alpha/ide/workspaces': () => {
        calls++;
        if (calls === 1)
          return {
            status: 403,
            body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
          };
        created = true;
        return { status: 201, body: { workspace: workspace({ state: 'pending' }) } };
      },
    });
    await user.click(await screen.findByTestId('ide-new'));
    const dialog = await screen.findByRole('dialog', { name: 'Tam IDE çalışma alanı' });
    expect(within(dialog).getByTestId<HTMLInputElement>('ide-name').value).toBe('main');
    expect(within(dialog).getByText('Değişiklikler remyral/ide/…/main branch’inde tutulur.')).toBeTruthy();
    expect(within(dialog).getByText(/Bellek 4 GB; 30 dakika boşta kalınca durur/)).toBeTruthy();
    await user.clear(within(dialog).getByTestId('ide-name'));
    await user.type(within(dialog).getByTestId('ide-name'), 'Bad Name');
    expect(within(dialog).getByTestId('ide-create').hasAttribute('disabled')).toBe(true);
    await user.clear(within(dialog).getByTestId('ide-name'));
    await user.type(within(dialog).getByTestId('ide-name'), 'fix-login');
    await user.selectOptions(within(dialog).getByTestId('ide-machine'), 'wrk_a');
    await user.type(within(dialog).getByTestId('ide-base'), 'develop');
    await user.click(within(dialog).getByTestId('ide-create'));
    // The master asked for a code: the step-up dialog, then the same request again.
    const code = await screen.findByRole('dialog', { name: /onayla|Confirm/i });
    await user.type(within(code).getByLabelText(/kod|code/i), '123456');
    await user.click(within(code).getByRole('button', { name: /^(onayla|confirm)$/i }));
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    const posts = f.requests.filter(
      (r) => r.method === 'POST' && r.url === '/api/projects/alpha/ide/workspaces',
    );
    expect(posts[1]?.body).toEqual({ name: 'fix-login', worker: 'wrk_a', baseRef: 'develop' });
    expect((await screen.findByTestId('ide-state')).textContent).toBe(
      'Çalışma alanı hazırlanıyor… (depo, IDE)',
    );
  });

  it('opens a running workspace in a new tab with the ticket URL, stops it, warns before deleting unsent work', async () => {
    const user = userEvent.setup();
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let state = 'running';
    const f = mount({
      'GET /api/projects/alpha/ide': () =>
        ok({
          configured: true,
          canUse: true,
          limits,
          machines: [machine({ running: 1 })],
          workspaces: [
            workspace({
              state,
              desired: state === 'running' ? 'running' : 'stopped',
              stopReason: state === 'stopped' ? 'idle' : null,
            }),
          ],
        })({} as never),
      [`POST /api/ide/workspaces/${WS}/open`]: ok({
        url: `https://ide.example.com/_ide/enter?w=${WS}&t=${'T'.repeat(43)}`,
        expiresAt: NOW,
      }),
      [`POST /api/ide/workspaces/${WS}/stop`]: () => {
        state = 'stopped';
        return { status: 200, body: { workspace: workspace({ state: 'stopped', desired: 'stopped' }) } };
      },
      [`GET /api/ide/workspaces/${WS}/git`]: ok({
        status: 'ok',
        reason: null,
        detail: null,
        branch: 'remyral/ide/ayse/main',
        head: 'a'.repeat(40),
        committed: false,
        pushed: false,
        changedFiles: 3,
        ahead: 1,
        pullRequest: null,
      }),
      [`DELETE /api/ide/workspaces/${WS}`]: () => ({ status: 204 }),
    });
    await user.click(await screen.findByTestId('ide-open'));
    await waitFor(() => {
      expect(tab.location.href).toBe(`https://ide.example.com/_ide/enter?w=${WS}&t=${'T'.repeat(43)}`);
    });
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    // Opening an IDE turns the reference inbox on.
    expect(ideActive()).toBe(true);
    await user.click(screen.getByTestId('ide-stop'));
    await waitFor(() => {
      expect(screen.getByTestId('ide-state').textContent).toBe('Durdu');
    });
    expect(screen.getByText('Boşta kaldığı için durduruldu. Dosyalar duruyor.')).toBeTruthy();
    expect(screen.getByTestId('ide-start')).toBeTruthy();
    await user.click(screen.getByTestId('ide-remove'));
    const confirm = await screen.findByTestId('ide-remove-dialog');
    expect(within(confirm).getByTestId('ide-dirty').textContent).toBe(
      'Gönderilmemiş değişiklikler var: 3 dosya, 1 commit. Önce IDE’de Gönder’i kullan.',
    );
    await user.click(within(confirm).getByTestId('ide-remove-confirm'));
    await waitFor(() => {
      expect(f.requests.some((r) => r.method === 'DELETE' && r.url === `/api/ide/workspaces/${WS}`)).toBe(
        true,
      );
    });
  });
});

describe('p19-ide W2: IDE references reach the composer', () => {
  it('parses ide references, labels them, and the inbox adds claimed ones once', async () => {
    const id = `ide:${WS}:4-9:src/app.ts`;
    const r = parseCodeRef(id, 'alpha');
    expect(r).toEqual({
      project: 'alpha',
      source: 'ide',
      ref: WS,
      path: 'src/app.ts',
      startLine: 4,
      endLine: 9,
    });
    expect(r === null ? '' : codeRefLabel(r)).toBe('src/app.ts:4-9 · IDE');
    expect(ideActive()).toBe(false);
    markIdeActive(Date.now() - 9 * 60 * 60_000);
    expect(ideActive()).toBe(false);
    markIdeActive();
    expect(ideActive()).toBe(true);
    stubCookies('__Host-ras-csrf=csrf-token');
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'POST /api/me/ide/references/claim': ok({
          references: [
            { project: 'alpha', id, label: 'src/app.ts:4-9 · IDE' },
            { project: 'alpha', id: 'ide:nope', label: 'bad' },
          ],
        }),
      }).fetch,
    );
    const words = { added: (p: { label: string }) => `added ${p.label}`, goChat: 'chat' };
    expect(await drainIdeReferences(words)).toBe(1);
    expect(pendingCodeRefs().map((p) => p.source)).toEqual(['ide']);
    // The same reference again is not added twice.
    expect(await drainIdeReferences(words)).toBe(0);
  });
});
