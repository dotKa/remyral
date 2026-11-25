// p16-git-providers: Ayarlar → Entegrasyonlar → GitLab ve Bitbucket (test before saving, write-only tokens, step-up)
// and Projeler → Depo with a GitLab / Bitbucket provider (connection, "Bağlantıyı test et", repository picker, the
// exact PUT body), plus the MR wording of a GitLab job's changes.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const CONN_ID = '6f1f6c1e-1111-4222-8333-944444444444';
const TOKEN = 'glpat-secret-0123456789';

const CONNECTION = {
  id: CONN_ID,
  kind: 'gitlab',
  label: 'Şirket GitLab',
  baseUrl: 'https://git.example.com',
  webHost: 'git.example.com',
  tokenKind: 'group',
  scope: 'acme',
  tokenFingerprint: 'abcdef012345',
  pushTokenFingerprint: null,
  separatePushToken: false,
  expiresAt: '2027-06-30T23:59:59.000Z',
  pushExpiresAt: null,
  rotatable: true,
  tokenUpdatedAt: '2026-10-23T10:00:00.000Z',
  lastTest: {
    ok: true,
    code: 'ok',
    detail: null,
    tokenName: 'remyral',
    scopes: ['api'],
    expiresAt: '2027-06-30',
    missingScopes: [],
    checkedAt: '2026-10-23T10:00:00.000Z',
  },
  usable: true,
  projects: [],
  version: 1,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
};

const GIT = {
  project: 'mobil-app',
  version: 2,
  provider: 'github',
  repositoryUrl: 'https://github.com/remyral/mobil-app.git',
  baseBranch: 'main',
  mergeMethod: 'merge',
  requireCi: false,
  ciTimeoutSec: 3600,
  github: { appId: '1', installationId: 77, keyRef: 'default' },
  hostConnectionId: null,
  updatedAt: '2026-10-01T10:00:00.000Z',
};

const stepUpRequired = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () =>
      ok({
        items: [
          {
            id: 'mobil-app',
            name: 'Mobil uygulama',
            kind: 'repository',
            createdAt: '2026-10-01T10:00:00.000Z',
            createdBy: null,
            members: 1,
            myRole: 'owner',
          },
        ],
      }),
    'GET /api/approvals': () => ok({ items: [] }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/notifications': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    'GET /api/models': () => ok({ items: [], defaults: [] }),
    'GET /api/projects/mobil-app/workers': () => ok({ items: [] }),
    'GET /api/projects/mobil-app/git': () => ok({ config: GIT }),
    'GET /api/projects/mobil-app/git/protection': () =>
      ok({
        project: 'mobil-app',
        provider: 'github',
        branch: 'main',
        state: 'protected',
        classic: true,
        rules: [],
        reason: null,
      }),
    'GET /api/projects/mobil-app/integration-settings': () =>
      ok({
        settings: { mode: 'master', order: 'dependency', maxResolutions: 3, maxFixes: 2 },
        canEdit: true,
      }),
    'GET /api/projects/mobil-app/git-identity': () => ok({ identity: null, effective: null, canEdit: false }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      if (t[k] !== undefined) return t[k];
      const bare = k.split('?')[0] ?? k;
      return (
        t[bare] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler)
      );
    },
  });
}

async function stepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await waitFor(() => {
    const d = screen.getAllByRole('dialog').find((x) => within(x).queryByLabelText(/code|kod/i) !== null);
    if (d === undefined) throw new Error('no step-up dialog');
    return d;
  });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitLab / Bitbucket (p16-git-providers)', { timeout: 30_000 }, () => {
  it('Entegrasyonlar: tests a token before saving, saves through step-up, never shows the token', async () => {
    let stepped = false;
    let saved = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/settings/integrations?tab=git-hosts',
      initialState: owner,
      routes: routes({
        'GET /api/integrations/git-hosts': () => ok({ connections: saved ? [CONNECTION] : [] }),
        'POST /api/integrations/git-hosts/test': () =>
          ok({
            test: {
              ok: false,
              code: 'scope_mismatch',
              detail: null,
              tokenName: 'remyral',
              scopes: ['api'],
              expiresAt: null,
              missingScopes: [],
              checkedAt: '2026-10-23T10:00:00.000Z',
            },
          }),
        'POST /api/integrations/git-hosts': () => {
          if (!stepped) return stepUpRequired;
          saved = true;
          return { status: 201, body: { connection: CONNECTION } };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const panel = await screen.findByTestId('dy-git-hosts');
    expect(await within(panel).findByText('Henüz GitLab ya da Bitbucket bağlantısı yok.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'GitLab / Bitbucket bağla' }));
    const form = within(panel).getByTestId('git-host-add');
    await user.type(within(form).getByLabelText('Ad'), 'Şirket GitLab');
    const address = within(form).getByLabelText('GitLab adresi');
    await user.clear(address);
    await user.type(address, 'https://git.example.com');
    await user.type(within(form).getByLabelText('Anahtarın kapsamı'), 'acme');
    await user.type(within(form).getByLabelText('Erişim anahtarı'), TOKEN);
    await user.click(within(form).getByRole('button', { name: 'Bağlantıyı test et' }));
    expect((await within(form).findByTestId('git-host-test')).textContent).toContain(
      'verilen projeye, gruba, depoya ya da çalışma alanına erişemiyor',
    );
    const tested = requests.find((r) => r.method === 'POST' && r.url === '/api/integrations/git-hosts/test');
    expect(tested?.body).toEqual({
      kind: 'gitlab',
      label: 'Şirket GitLab',
      baseUrl: 'https://git.example.com',
      tokenKind: 'group',
      scope: 'acme',
      token: TOKEN,
    });
    await user.click(within(form).getByRole('button', { name: 'Bağlantıyı kaydet' }));
    await stepUp(user);
    const card = await within(panel).findByTestId(`git-host-${CONN_ID}`);
    expect(card.textContent).toContain('git.example.com');
    expect(card.textContent).toContain('Grup erişim anahtarı');
    expect(within(card).getByTestId('git-host-push-shared').textContent).toContain('API anahtarını alır');
    expect(within(card).getByRole('button', { name: 'Anahtarı GitLab’da yenile' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
    const posts = requests.filter((r) => r.method === 'POST' && r.url === '/api/integrations/git-hosts');
    expect(posts).toHaveLength(2);
  });

  it('Depo: GitLab provider with a connection, connection test, repository picker and the exact body', async () => {
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=repository',
      initialState: owner,
      routes: routes({
        'GET /api/integrations/git-hosts': () => ok({ connections: [CONNECTION] }),
        [`POST /api/integrations/git-hosts/${CONN_ID}/test`]: () => ok({ test: CONNECTION.lastTest }),
        [`GET /api/integrations/git-hosts/${CONN_ID}/repositories`]: () =>
          ok({
            repositories: [
              {
                fullPath: 'acme/mobil',
                cloneUrl: 'https://git.example.com/acme/mobil.git',
                webUrl: 'https://git.example.com/acme/mobil',
                defaultBranch: 'develop',
                private: true,
                archived: false,
              },
            ],
          }),
        'PUT /api/projects/mobil-app/git': () =>
          stepped
            ? ok({
                config: {
                  ...GIT,
                  version: 3,
                  provider: 'gitlab',
                  github: null,
                  hostConnectionId: CONN_ID,
                  repositoryUrl: 'https://git.example.com/acme/mobil.git',
                  baseBranch: 'develop',
                },
              })
            : stepUpRequired,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const repo = await screen.findByTestId('dy-repository');
    await user.click(await within(repo).findByRole('button', { name: 'Depoyu düzenle' }));
    const form = within(repo).getByRole('form', { name: 'mobil-app deposunu düzenle' });
    await user.selectOptions(within(form).getByLabelText('Sağlayıcı'), 'gitlab');
    const conn = await within(form).findByLabelText('Bağlantı');
    await user.selectOptions(conn, CONN_ID);
    await user.click(within(form).getByRole('button', { name: 'Bağlantıyı test et' }));
    expect((await within(form).findByTestId('repo-host-test')).textContent).toContain('Bağlantı çalışıyor');
    const picker = await within(form).findByTestId('repo-host-picker');
    await user.click(await within(picker).findByRole('button', { name: /acme\/mobil/ }));
    await user.click(screen.getByTestId('dy-form-save'));
    await stepUp(user);
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect(puts[1]?.body).toEqual({
        expectedVersion: 2,
        provider: 'gitlab',
        repositoryUrl: 'https://git.example.com/acme/mobil.git',
        baseBranch: 'develop',
        mergeMethod: 'merge',
        requireCi: false,
        hostConnectionId: CONN_ID,
      });
    });
    // p17-toasts-rest: saved from the tab's bar, the result is the bar's toast; no line in the panel.
    expect(await findToast('Kaydedildi')).toBeTruthy();
    expect(within(repo).queryByText(/Depo kaydedildi/)).toBeNull();
    expect(within(repo).getByText('Şirket GitLab · git.example.com')).toBeTruthy();
  });

  it('Depo: Bitbucket without a connection points to Entegrasyonlar', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/projects/mobil-app?tab=repository',
      initialState: owner,
      routes: routes({ 'GET /api/integrations/git-hosts': () => ok({ connections: [CONNECTION] }) }),
    });
    const repo = await screen.findByTestId('dy-repository');
    await user.click(await within(repo).findByRole('button', { name: 'Depoyu düzenle' }));
    const form = within(repo).getByRole('form', { name: 'mobil-app deposunu düzenle' });
    await user.selectOptions(within(form).getByLabelText('Sağlayıcı'), 'bitbucket');
    expect((await within(form).findByTestId('repo-no-connections')).textContent).toContain(
      'Henüz Bitbucket Cloud bağlantısı yok',
    );
  });
});
