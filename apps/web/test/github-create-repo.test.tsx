// p15-github-create-repo: Ayarlar → Entegrasyonlar → GitHub → "GitHub hesabı" (where repositories can be opened,
// "GitHub hesabını yetkilendir" through step-up, the token fallback), the callback for a `u.` state, and the
// "GitHub’da yeni private repo aç" dialog (validation, request body, result).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { GitHubCallbackScreen } from '../src/diyalog/screens/settings/integrations-github';
import {
  GitHubAccountsSection,
  NewGitHubRepoDialog,
  repoNameOk,
} from '../src/diyalog/screens/settings/integrations-github-repos';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, stubCookies } from './helpers';
import { toastByTestId } from './toasts';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

const OPTIONS = {
  connected: true,
  canAuthorize: true,
  owners: [
    {
      login: 'acme-labs',
      type: 'Organization',
      installationId: 888,
      repositorySelection: 'selected',
      method: 'installation',
      blocked: null,
    },
    {
      login: 'octoDev',
      type: 'User',
      installationId: 777,
      repositorySelection: 'selected',
      method: null,
      blocked: 'user_authorization_missing',
    },
  ],
  accounts: [],
  gitignoreTemplates: ['Node', 'Python'],
};
const ACCOUNT = {
  id: '00000000-0000-4000-8000-0000000000a1',
  kind: 'app_user',
  login: 'octoDev',
  appId: '4242',
  accessExpiresAt: '2026-10-22T20:00:00.000Z',
  refreshExpiresAt: '2027-04-22T12:00:00.000Z',
  createdAt: '2026-10-22T12:00:00.000Z',
  updatedAt: '2026-10-22T12:00:00.000Z',
  lastUsedAt: null,
  lastError: null,
  usable: true,
};
const STATE = `u.${'a'.repeat(43)}`;

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

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

function mount(routes: Record<string, Handler>, node: React.ReactNode, path = '/') {
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialState={owner}>
        <StepUpProvider>
          <Routes>
            <Route path="*" element={node} />
          </Routes>
        </StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f.requests;
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitHub hesabı (p15-github-create-repo)', () => {
  it('shows where repositories can be opened and authorizes the account through step-up', async () => {
    const s = stepUpGate();
    const navigate = vi.fn();
    const user = userEvent.setup();
    const requests = mount(
      {
        ...s.route,
        'GET /api/integrations/github/repo-options': ok(OPTIONS),
        'POST /api/integrations/github/accounts/authorize': s.gate(
          ok({
            authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=Iv1.x',
            expiresAt: '2026-10-22T12:15:00.000Z',
          }),
        ),
      },
      <GitHubAccountsSection navigate={navigate} />,
    );
    const owners = await screen.findByTestId('github-repo-owners');
    expect(owners.textContent).toContain('acme-labs');
    expect(owners.textContent).toContain('GitHub App kurulumu ile');
    expect(owners.textContent).toContain('önce “GitHub hesabını yetkilendir”');
    expect(screen.getByText('Henüz yetkilendirilmiş GitHub hesabı yok.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'GitHub hesabını yetkilendir' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=Iv1.x');
    });
    expect(
      requests.some((r) => r.method === 'POST' && r.url === '/api/integrations/github/accounts/authorize'),
    ).toBe(true);
  });

  it('the token fallback is write-only: sent once, the field is cleared', async () => {
    const user = userEvent.setup();
    const token = `github_pat_${'X1'.repeat(15)}`;
    const requests = mount(
      {
        'GET /api/integrations/github/repo-options': ok(OPTIONS),
        'PUT /api/integrations/github/accounts/token': ok({ ...ACCOUNT, kind: 'pat' }),
      },
      <GitHubAccountsSection navigate={vi.fn()} />,
    );
    await screen.findByTestId('github-repo-owners');
    await user.click(screen.getByText('Belirteçle bağla (yedek yol)'));
    const field = screen.getByLabelText('İnce ayarlı kişisel erişim belirteci');
    expect(field.getAttribute('type')).toBe('password');
    await user.type(field, token);
    await user.click(screen.getByRole('button', { name: 'Belirteci kaydet' }));
    // p17-toasts-rest: the save result is a toast (this render has no toaster: read the queue).
    await waitFor(() => {
      expect(toastByTestId('github-pat-saved')?.title).toBe('octoDev için belirteç kaydedildi.');
    });
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ token });
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('the callback with a u. state finishes the account authorization (not the App manifest)', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const requests = mount(
      {
        ...s.route,
        'POST /api/integrations/github/accounts/authorize/complete': s.gate(ok(ACCOUNT)),
      },
      <GitHubCallbackScreen />,
      `/settings/integrations/github/callback?code=oc-1&state=${STATE}`,
    );
    await confirmStepUp(user);
    expect(
      await screen.findByText('octoDev hesabı yetkilendirildi. Artık bu hesapta depo açılabilir.'),
    ).toBeTruthy();
    expect(
      requests.find(
        (r) => r.url === '/api/integrations/github/accounts/authorize/complete' && r.body !== undefined,
      )?.body,
    ).toEqual({ code: 'oc-1', state: STATE });
    expect(requests.some((r) => r.url.includes('/manifest/complete'))).toBe(false);
  });
});

describe('GitHub’da yeni private repo aç (p15-github-create-repo)', () => {
  it('validates the name in the browser, then opens and links the repository', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const requests = mount(
      {
        'GET /api/integrations/github/repo-options': ok(OPTIONS),
        'POST /api/integrations/github/repositories': () => ({
          status: 201,
          body: {
            id: 'x',
            created: true,
            replayed: false,
            owner: 'acme-labs',
            name: 'shop',
            fullName: 'acme-labs/shop',
            htmlUrl: 'https://github.com/acme-labs/shop',
            cloneUrl: 'https://github.com/acme-labs/shop.git',
            defaultBranch: 'main',
            private: true,
            method: 'installation',
            installationId: 888,
            project: 'shop',
            linked: true,
            warnings: [],
          },
        }),
      },
      <NewGitHubRepoDialog
        open
        project="shop"
        suggestedName="has space"
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    const dialog = await screen.findByTestId('github-new-repo');
    await within(dialog).findByLabelText('Sahip');
    await user.click(within(dialog).getByRole('button', { name: 'Depoyu aç' }));
    expect(await within(dialog).findByText(/Depo adı yalnızca harf/)).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
    const name = within(dialog).getByLabelText('Depo adı');
    await user.clear(name);
    await user.type(name, 'shop');
    await user.selectOptions(within(dialog).getByLabelText('.gitignore şablonu'), 'Node');
    await user.click(within(dialog).getByRole('button', { name: 'Depoyu aç' }));
    expect(await within(dialog).findByTestId('github-new-repo-done')).toBeTruthy();
    const body = requests.find((r) => r.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      owner: 'acme-labs',
      name: 'shop',
      private: true,
      autoInit: true,
      gitignoreTemplate: 'Node',
      project: 'shop',
    });
    expect(String(body.idempotencyKey)).toMatch(/^web-/);
    expect(onCreated).toHaveBeenCalled();
    expect(screen.getByText(/shop projesine bağlandı/)).toBeTruthy();
  });

  it('names what is missing when Remyral cannot open a repository anywhere', async () => {
    mount(
      {
        'GET /api/integrations/github/repo-options': ok({
          ...OPTIONS,
          owners: [OPTIONS.owners[1]],
        }),
      },
      <NewGitHubRepoDialog open project={null} onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/Remyral henüz hiçbir yerde depo açamıyor/)).toBeTruthy();
    expect(screen.getByText(/önce “GitHub hesabını yetkilendir”/)).toBeTruthy();
  });

  it('repository names follow GitHub’s rule', () => {
    expect(repoNameOk('shop-web_1.0')).toBe(true);
    for (const bad of ['', 'has space', '.', '..', 'x.git', 'a/b', 'ç']) expect(repoNameOk(bad)).toBe(false);
  });
});
