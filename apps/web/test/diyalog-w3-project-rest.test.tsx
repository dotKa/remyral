// p12-diyalog wave 2 (W3) — Projeler leftovers in the Diyalog language: the "Yeni proje" dialog (classic rules, step-up),
// Depo (repository view / edit with step-up and the exact body, branch protection, integration settings; viewers read
// only), Çalışma alanı (network access allow-list check, storage meter), Makineler (assign + save body, blocked
// reason), Üyeler (add, two-step remove) and Hafıza (records by type, conflict resolve, suggestion accept, reject
// with reason). The classic English controls are gone from these Diyalog tabs.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  W3_CONFLICTS,
  W3_DECISIONS,
  W3_MEMBERS,
  W3_PROJECT_WORKERS,
  W3_RECORDS,
  W3_SUGGESTIONS,
  W3_USERS,
  W3_WORKSPACE,
} from '../src/diyalog/harness/screens/w3-project-rest';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast, toastByTestId } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewerAuth: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'viewer' },
  session: null,
  remainingRecoveryCodes: null,
};

function project(id: string, name: string, kind: string, myRole = 'owner'): Record<string, unknown> {
  return { id, name, kind, createdAt: '2026-10-01T10:00:00.000Z', createdBy: null, members: 2, myRole };
}

const GIT = {
  project: 'mobil-app',
  version: 2,
  provider: 'github',
  repositoryUrl: 'https://github.com/remyral/mobil-app.git',
  baseBranch: 'main',
  mergeMethod: 'squash',
  requireCi: true,
  ciTimeoutSec: 1800,
  github: { appId: '1', installationId: 77, keyRef: 'default' },
  updatedAt: '2026-10-01T10:00:00.000Z',
};

const stepUpRequired = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

/**
 * Exact `METHOD /api/path?query` first, then the same without the query; anything else 404 (never a 401 that would
 * sign the test user out).
 */
function routes(over: Record<string, Handler> = {}, myRole = 'owner'): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () =>
      ok({
        items: [
          project('mobil-app', 'Mobil uygulama', 'repository', myRole),
          project('arastirma', 'Pazar araştırması', 'workspace', myRole),
        ],
      }),
    'GET /api/approvals': () => ok({ items: [] }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/notifications': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    'GET /api/models': () => ok({ items: [], defaults: [] }),
    'GET /api/projects/mobil-app/workers': () => ok({ items: W3_PROJECT_WORKERS }),
    'GET /api/projects/arastirma/workers': () => ok({ items: [] }),
    'GET /api/projects/mobil-app/git': () => ok({ config: GIT }),
    'GET /api/projects/mobil-app/git/protection': () =>
      ok({
        project: 'mobil-app',
        provider: 'github',
        branch: 'main',
        state: 'unprotected',
        classic: false,
        rules: [],
        reason: null,
      }),
    'GET /api/projects/mobil-app/integration-settings': () =>
      ok({
        settings: { mode: 'master', order: 'dependency', maxResolutions: 3, maxFixes: 2 },
        canEdit: myRole === 'owner',
      }),
    'GET /api/projects/mobil-app/git-identity': () => ok({ identity: null, effective: null, canEdit: false }),
    'GET /api/projects/arastirma/workspace': () => ok(W3_WORKSPACE),
    'GET /api/projects/mobil-app/members': () => ok({ items: W3_MEMBERS }),
    'GET /api/users': () => ok({ items: W3_USERS }),
    'GET /api/memory-records': () => ok({ items: W3_RECORDS }),
    'GET /api/memory-records/conflicts': () => ok({ items: W3_CONFLICTS }),
    'GET /api/memory-records/decisions': () => ok({ items: W3_DECISIONS }),
    'GET /api/memory-records/untyped': () => ok({ items: [] }),
    'GET /api/memory-suggestions/settings': () =>
      ok({
        project: 'mobil-app',
        mode: 'rules',
        version: 3,
        enabledAt: null,
        semanticDedupe: false,
        pending: 2,
      }),
    'GET /api/memory-suggestions': () => ok({ items: W3_SUGGESTIONS, total: 2 }),
    'GET /api/context/defaults': () =>
      ok({ projectCapture: false, memoryMode: 'off', chatCapture: false, updatedAt: null, updatedBy: null }),
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Projeler leftovers (p12-diyalog wave 2, W3)', { timeout: 30_000 }, () => {
  it('Yeni proje: checks the id, then registers through step-up with the classic body', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects',
      initialState: owner,
      routes: routes({
        'POST /api/projects': () => (stepped ? { status: 201, body: {} } : stepUpRequired),
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Yeni proje' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni proje' });
    const form = within(dialog).getByRole('form', { name: 'Proje kaydet' });
    expect(within(form).queryByText('Register')).toBeNull();
    await user.type(within(form).getByLabelText('Proje kimliği'), 'kötü id');
    await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
    expect(within(form).getByText(/1–128 karakter/)).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/projects')).toBe(false);
    await user.clear(within(form).getByLabelText('Proje kimliği'));
    await user.type(within(form).getByLabelText('Proje kimliği'), 'yeni-proje');
    await user.selectOptions(within(form).getByLabelText('Tür'), 'workspace');
    await user.click(within(form).getByLabelText(/Yalnız izinli sunucular/));
    await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
    expect(within(form).getByText('En az bir sunucu yazın ya da “Ağ yok”u seçin.')).toBeTruthy();
    await user.type(within(form).getByLabelText('İzinli sunucular'), 'api.example.com');
    await user.click(within(form).getByRole('button', { name: 'Kaydet' }));
    await stepUp(user);
    await waitFor(() => {
      const posts = requests.filter((r) => r.method === 'POST' && r.url === '/api/projects');
      expect(posts).toHaveLength(2);
      expect(posts[1]?.body).toMatchObject({
        id: 'yeni-proje',
        name: 'yeni-proje',
        kind: 'workspace',
        egress: 'allowlist',
        allowHosts: ['api.example.com'],
      });
    });
  });

  it('Depo: repository facts, protection, edit with step-up and the exact body', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=repository',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/mobil-app/git': () =>
          stepped ? ok({ config: { ...GIT, baseBranch: 'develop', version: 3 } }) : stepUpRequired,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const repo = await screen.findByTestId('dy-repository');
    await within(repo).findByText('https://github.com/remyral/mobil-app.git');
    expect((await within(repo).findByTestId('protection-mobil-app')).textContent).toContain(
      'koruma kuralı yok',
    );
    expect(within(repo).queryByRole('button', { name: 'Edit repository' })).toBeNull();
    await user.click(within(repo).getByRole('button', { name: 'Depoyu düzenle' }));
    const form = within(repo).getByRole('form', { name: 'mobil-app deposunu düzenle' });
    const branch = within(form).getByLabelText('Temel branch');
    await user.clear(branch);
    await user.type(branch, 'develop');
    // p15-form-pattern: the Depo tab is one form; its sticky bar saves the open repository fields.
    expect(within(form).queryByRole('button', { name: 'Depoyu kaydet' })).toBeNull();
    await user.click(screen.getByTestId('dy-form-save'));
    await stepUp(user);
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect(puts[1]?.body).toMatchObject({
        expectedVersion: 2,
        provider: 'github',
        baseBranch: 'develop',
        mergeMethod: 'squash',
        requireCi: true,
        github: { installationId: 77, keyRef: 'default' },
      });
    });
    // p17-toasts-rest: saved from the tab's bar, the result is one toast (the bar's), no line in the panel.
    expect(await findToast('Kaydedildi')).toBeTruthy();
    expect(within(repo).queryByText(/Depo kaydedildi/)).toBeNull();
    expect(toastByTestId('repo-git-saved')).toBeUndefined();
    // Integration settings: editable for owners, rounds checked on the client.
    const integ = screen.getByTestId('dy-integration');
    const rounds = within(integ).getByLabelText('En çok düzeltme turu');
    await user.clear(rounds);
    await user.type(rounds, '9');
    expect(within(integ).getByText('0 ile 5 arasında bir tam sayı girin.')).toBeTruthy();
    // The bar refuses to save an invalid card (the error stays next to the field).
    const puts = requests.filter((r) => r.method === 'PUT').length;
    await user.click(screen.getByTestId('dy-form-save'));
    expect(await screen.findByTestId('dy-form-failed')).toBeTruthy();
    expect(requests.filter((r) => r.method === 'PUT').length).toBe(puts);
  });

  it('a viewer reads the repository, machines and members without any change control', async () => {
    renderApp({
      path: '/projects/mobil-app?tab=repository',
      initialState: viewerAuth,
      routes: routes({}, 'viewer'),
    });
    const repo = await screen.findByTestId('dy-repository');
    await within(repo).findByText('main');
    expect(within(repo).queryByRole('button', { name: 'Depoyu düzenle' })).toBeNull();
    expect(await screen.findByTestId('integration-settings-read')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Makineler' }));
    const tab = await screen.findByTestId('dy-project-machines-tab');
    await within(tab).findByText('atlas-win-01');
    for (const box of within(tab).getAllByRole<HTMLInputElement>('checkbox')) expect(box.disabled).toBe(true);
    expect(within(tab).queryByRole('button', { name: 'Makineleri kaydet' })).toBeNull();
  });

  it('Çalışma alanı: allow-list and storage, the allow-list is checked before saving', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/arastirma?tab=repository',
      initialState: owner,
      routes: routes(),
    });
    const ws = await screen.findByTestId('dy-workspace');
    expect(await within(ws).findByText('api.tuik.gov.tr, data.worldbank.org')).toBeTruthy();
    const meter = within(screen.getByTestId('workspace-storage')).getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('90');
    await user.click(within(ws).getByRole('button', { name: 'Ağ erişimini düzenle' }));
    const hosts = within(ws).getByLabelText('İzinli sunucular');
    await user.clear(hosts);
    await user.click(screen.getByTestId('dy-form-save'));
    expect(within(ws).getByText('En az bir sunucu yazın ya da “Ağ yok”u seçin.')).toBeTruthy();
    await user.click(within(ws).getByLabelText(/Açık web/));
    expect(within(ws).getByTestId('web-egress-risk')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('Depolama: the output limit (project lower than the server) and its fields; a save sends the override', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/arastirma?tab=repository',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/arastirma/workspace': () => (stepped ? ok(W3_WORKSPACE) : stepUpRequired),
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const box = await screen.findByTestId('workspace-storage');
    const row = await within(box).findByTestId('storage-output-limit');
    expect(row.textContent).toContain(
      'İş başına 200 dosya · depolamaya iş başına 5.00 GiB · bu projeye özel',
    );
    expect(row.textContent).toContain('Sunucunun değeri: 500 dosya, 5.00 GiB');
    await user.click(within(box).getByRole('button', { name: 'Depolama kuralını düzenle' }));
    const files = within(box).getByLabelText('İş başına en çok çıktı dosyası');
    expect((files as HTMLInputElement).value).toBe('200');
    await user.clear(files);
    await user.type(files, '2001');
    await user.click(screen.getByTestId('dy-form-save'));
    expect(within(box).getByText(/1 ile 2000 dosya arasında olmalı/)).toBeTruthy();
    await user.clear(files);
    await user.type(files, '150');
    await user.click(screen.getByTestId('dy-form-save'));
    await stepUp(user);
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts.length).toBeGreaterThan(0);
      expect(puts.at(-1)?.body).toMatchObject({ outputMaxFiles: 150, outputMaxJobBytes: null });
    });
  });

  it('Makineler: assigning a machine saves the chosen ids through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=machines',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/mobil-app/workers': () =>
          stepped ? ok({ items: W3_PROJECT_WORKERS }) : stepUpRequired,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
      }),
    });
    const tab = await screen.findByTestId('dy-project-machines-tab');
    // p15-form-pattern: no bar until something changes; then the tab's sticky bar saves the assignment.
    await within(tab).findByRole('checkbox', { name: 'ridge-lnx-03 makinesini ata' });
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    expect(within(tab).queryByRole('button', { name: 'Makineleri kaydet' })).toBeNull();
    await user.click(within(tab).getByRole('checkbox', { name: 'ridge-lnx-03 makinesini ata' }));
    await user.click(screen.getByTestId('dy-form-save'));
    await stepUp(user);
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect((puts[1]?.body as { workerIds: string[] }).workerIds.sort()).toEqual(['w1', 'w2', 'w3']);
    });
    expect(within(tab).getByText('Yerel dosyayla yapılandırılmış')).toBeTruthy();
    expect(within(tab).getByText('Henüz uygulanmadı')).toBeTruthy();
    // p17-toasts-rest: one "Kaydedildi" toast (the bar's); the per-machine state above is what lasts.
    expect(await findToast('Kaydedildi')).toBeTruthy();
    expect(toastByTestId('project-machines-saved')).toBeUndefined();
  });

  it('Üyeler: add an operator and remove a member after a confirmation', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=members',
      initialState: owner,
      routes: routes({
        'PUT /api/projects/mobil-app/members': () => ok({ items: W3_MEMBERS }),
        'DELETE /api/projects/mobil-app/members?userId=u-oper': () => ok({ items: [W3_MEMBERS[1]] }),
      }),
    });
    const panel = await screen.findByTestId('dy-project-members');
    await within(panel).findByText('oper1');
    expect(within(panel).getByText('izleyici olarak davranır (hesap rolü izleyici)')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Add member to mobil-app' })).toBeNull();
    const form = within(panel).getByRole('form', { name: 'mobil-app projesine üye ekle' });
    await user.selectOptions(within(form).getByLabelText('Kullanıcı'), 'u-new');
    await user.selectOptions(within(form).getByLabelText('Proje rolü'), 'operator');
    await user.click(within(form).getByRole('button', { name: 'Üye ekle' }));
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({ userId: 'u-new', role: 'operator' });
    });
    await user.click(within(panel).getByTestId('remove-member-oper1'));
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    await user.click(within(panel).getByTestId('remove-member-oper1-confirm'));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'DELETE')).toBe(true);
    });
    await waitFor(() => {
      expect(within(panel).queryByText('oper1')).toBeNull();
    });
  });

  it('Hafıza: records by type, a conflict resolved, a suggestion accepted, a record rejected with a reason', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=memory',
      initialState: owner,
      routes: routes({
        'POST /api/memory-records/conflicts/c1/resolve': () => ({ status: 204 }),
        'POST /api/memory-suggestions/s1/accept': () =>
          ok({ documentId: 'doc-12345678', record: W3_RECORDS[0] }),
        'POST /api/memory-records/r4/status': () => ok({ ...W3_RECORDS[3], status: 'rejected' }),
      }),
    });
    const records = await screen.findByTestId('dy-memory-records');
    const rules = await within(records).findByTestId('record-group-rule');
    expect(within(rules).getByText('Paket yöneticisi pnpm')).toBeTruthy();
    expect(within(rules).getByText('Proje · yalnız Codex')).toBeTruthy();
    expect(within(records).queryByRole('button', { name: 'Supersede' })).toBeNull();

    const conflicts = screen.getByTestId('dy-memory-conflicts');
    await user.click(await within(conflicts).findByRole('button', { name: 'Yerine koy' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/memory-records/conflicts/c1/resolve')?.body).toEqual({
        decision: 'supersede',
      });
    });

    const inbox = screen.getByTestId('dy-memory-inbox');
    const first = (await within(inbox).findAllByTestId('memory-suggestion'))[0] as HTMLElement;
    expect(within(first).getByTestId('memory-replaces').textContent).toContain('npm test');
    await user.click(within(first).getByRole('button', { name: 'Kabul et' }));
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/memory-suggestions/s1/accept')).toBe(true);
    });

    const fact = within(records).getByTestId('record-group-fact');
    await user.click(within(fact).getByRole('button', { name: 'Reddet' }));
    const group = within(fact).getByRole('group', { name: 'Marka rengi reddet' });
    await user.type(within(group).getByLabelText('Neden (isteğe bağlı)'), 'yanlış renk');
    await user.click(within(group).getByRole('button', { name: 'Reddet' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/memory-records/r4/status')?.body).toMatchObject({
        status: 'rejected',
        reason: 'yanlış renk',
      });
    });
  });

  // p15-classic-removal: the classic memory-layers / memory-suggestions tests' "give a type" and "backfill".
  it('Hafıza: an untyped document gets a type; an admin reads earlier jobs for suggestions', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=memory',
      initialState: owner,
      routes: routes({
        'GET /api/memory-records/untyped': () =>
          ok({
            items: [
              {
                id: 'd-legacy',
                kind: 'memory',
                title: 'Eski notlar: release süreci',
                namespace: 'project:mobil-app',
                updatedAt: '2026-08-01T10:00:00.000Z',
              },
            ],
          }),
        'POST /api/memory-records/type/d-legacy': () =>
          ok({ ...W3_RECORDS[3], title: 'Eski notlar: release süreci' }),
        'POST /api/memory-suggestions/backfill': () =>
          ok({ jobs: 4, proposed: 2, duplicates: 1, skippedSecrets: 0 }),
        'POST /api/memory-suggestions/s1/dismiss': () =>
          ok({ suggestion: { ...(W3_SUGGESTIONS[0] as Record<string, unknown>), state: 'dismissed' } }),
      }),
    });
    const untyped = await screen.findByTestId('untyped-docs');
    await user.click(within(untyped).getByRole('button', { name: 'Tür ver' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/memory-records/type/d-legacy')?.body).toMatchObject({
        type: 'fact',
      });
    });
    // A suggestion is turned down for good.
    const inbox = screen.getByTestId('dy-memory-inbox');
    const first = (await within(inbox).findAllByTestId('memory-suggestion'))[0] as HTMLElement;
    await user.click(within(first).getByRole('button', { name: 'Geri çevir' }));
    await waitFor(() => {
      expect(
        requests.some((r) => r.method === 'POST' && r.url === '/api/memory-suggestions/s1/dismiss'),
      ).toBe(true);
    });
    await user.click(await screen.findByRole('button', { name: 'Önceki işleri oku (30 gün)' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/memory-suggestions/backfill')?.body).toMatchObject({
        project: 'mobil-app',
        days: 30,
      });
    });
  });
});
