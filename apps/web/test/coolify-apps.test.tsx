// p15-coolify-create (ADR-0057): Projeler → Deploy → "Coolify uygulamaları" — the "Coolify’da yeni uygulama" wizard
// (pickers loaded from Coolify, defaults from the repository suggestion), the variables editor (keys only, values
// write-only) and the domains editor of a linked application.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { createFormatter, messagesFor } from '@remyral/i18n';
import { summarizeDraft } from '../src/diyalog/drafts/summary';
import { DEPLOY_OPS, DEPLOY_TARGETS } from '../src/diyalog/harness/screens/w3-project-deploy';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewer: AuthState = { ...owner, user: { ...USER, role: 'viewer' } };
const CONN = 'c0000000-0000-4000-8000-0000000000c1';
const APP = 'uapi0001';

function project(myRole: string): Record<string, unknown> {
  return {
    id: 'alpha',
    name: 'Alpha app',
    kind: 'repository',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: null,
    members: 2,
    myRole,
  };
}

function options(url: string): Record<string, unknown> {
  const q = new URL(url, 'http://x').searchParams;
  return {
    connection: { id: CONN, label: 'Ana Coolify', manageApps: true },
    connections: [{ id: CONN, label: 'Ana Coolify', isDefault: true }],
    servers: [{ uuid: 'srv00001', name: 'home', ip: '10.0.0.5' }],
    projects: [
      { uuid: 'cpalpha1', name: 'alpha' },
      { uuid: 'cpother1', name: 'other' },
    ],
    environments:
      q.get('coolifyProject') === 'cpalpha1'
        ? [
            { name: 'production', uuid: null },
            { name: 'staging', uuid: null },
          ]
        : null,
    destinations: null,
    githubApps: [{ uuid: 'gh000001', name: 'remyral-gh' }],
    privateKeys: [],
    repository: { url: 'https://github.com/acme/alpha', branch: 'main' },
    targets: {},
    notes: [],
  };
}

function routes(
  role: string,
  over: Record<string, Handler> = {},
  seen: RecordedRequest[] = [],
): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () => ok({ items: [project(role)] }),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    'GET /api/deploy/actions?project=alpha&limit=8': () => ok({ items: [], nextCursor: null }),
    'GET /api/projects/alpha/deploy-targets': () =>
      ok({ project: 'alpha', targets: DEPLOY_TARGETS, version: 4, updatedAt: null }),
    'GET /api/integrations/ops': () => ok(DEPLOY_OPS),
    'GET /api/projects/alpha/site-uploads': () => ok({ items: [] }),
    'GET /api/uptime/settings?project=alpha': () =>
      ok({ project: 'alpha', autoMonitor: false, updatedAt: null }),
    'GET /api/projects/alpha/coolify/apps': () =>
      ok({
        items: [
          {
            env: 'production',
            uuid: APP,
            connection: { id: CONN, label: 'Ana Coolify' },
            manageApps: true,
            name: 'alpha-api',
            fqdn: 'https://api.alpha.example',
            status: 'running:healthy',
            problem: null,
          },
        ],
        creations: [],
      }),
    'GET /api/projects/alpha/coolify/suggestion': () =>
      ok({
        buildPack: 'dockerfile',
        ports: '8080',
        isStatic: false,
        publishDirectory: null,
        dockerfileLocation: '/Dockerfile',
        composeLocation: null,
        basis: ['Dockerfile'],
        source: 'repository',
      }),
    [`GET /api/projects/alpha/coolify/apps/${APP}`]: () =>
      ok({
        env: 'production',
        connection: { id: CONN, label: 'Ana Coolify', manageApps: true },
        application: { uuid: APP, name: 'alpha-api' },
        domains: ['https://api.alpha.example'],
        envs: [
          { key: 'NODE_ENV', preview: false, buildtime: true, runtime: true, shared: null },
          {
            key: 'DATABASE_URL',
            preview: false,
            buildtime: false,
            runtime: true,
            shared: 'project.DATABASE_URL',
          },
        ],
      }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      const h = t[k];
      if (h !== undefined) {
        return ((req: RecordedRequest) => {
          seen.push(req);
          return h(req);
        }) as Handler;
      }
      if (k.startsWith('GET /api/projects/alpha/coolify/options')) {
        return ((req: RecordedRequest) => {
          seen.push(req);
          return ok(options(req.url));
        }) as Handler;
      }
      return (() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler;
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Projeler → Deploy → Coolify uygulamaları (p15-coolify-create)', { timeout: 30_000 }, () => {
  it('the wizard loads pickers from Coolify, takes the repository suggestion and creates the app', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let sent: Record<string, unknown> | null = null;
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        'POST /api/projects/alpha/coolify/apps': (req) => {
          sent = req.body as Record<string, unknown>;
          return {
            status: 201,
            body: {
              id: 'a0000000-0000-4000-8000-0000000000a1',
              project: 'alpha',
              env: 'production',
              connection: { id: CONN, label: 'Ana Coolify' },
              state: 'created',
              appUuid: 'unew0001',
              name: 'alpha-web',
              request: {},
              result: {
                appUuid: 'unew0001',
                linked: true,
                envs: { created: ['NODE_ENV'], failed: [] },
                deployActionId: '55555555-5555-4555-8555-555555555555',
                deployState: 'awaiting_approval',
                warnings: [],
              },
              error: null,
              createdAt: '2026-10-21T10:00:00.000Z',
              updatedAt: '2026-10-21T10:00:00.000Z',
              replayed: false,
            },
          };
        },
      }),
    });
    const panel = await screen.findByTestId('dy-coolify-apps');
    expect(await within(panel).findByText('alpha-api')).toBeTruthy();
    await user.click(within(panel).getByTestId('coolify-new-app'));
    const form = await screen.findByTestId('coolify-new-app-form');
    // The only server and the Coolify project named like the project are preselected; the environment named like
    // the target follows once the project's environments are loaded.
    await waitFor(() => {
      expect(within(form).getByLabelText<HTMLSelectElement>('Coolify ortamı').value).toBe('production');
    });
    expect(within(form).getByLabelText<HTMLSelectElement>('Sunucu').value).toBe('srv00001');
    expect(within(form).getByLabelText<HTMLSelectElement>('Coolify projesi').value).toBe('cpalpha1');
    // Defaults from the repository: Dockerfile → dockerfile build pack, port 8080.
    await waitFor(() => {
      expect(within(form).getByLabelText<HTMLSelectElement>('Derleme yöntemi').value).toBe('dockerfile');
    });
    expect(within(form).getByLabelText<HTMLInputElement>('Portlar').value).toBe('8080');
    expect(within(form).getByTestId('coolify-suggestion').textContent).toContain('Dockerfile');
    expect(within(form).getByText('Depo: https://github.com/acme/alpha')).toBeTruthy();

    await user.type(within(form).getByLabelText('Uygulama adı'), 'alpha-web');
    await user.type(within(form).getByLabelText('Alan adları'), 'https://alpha.example');
    await user.click(within(form).getByTestId('coolify-env-add'));
    const row = within(form).getByTestId('coolify-env-row');
    await user.type(within(row).getByLabelText('Ad'), 'NODE_ENV');
    const value = within(row).getByLabelText<HTMLInputElement>('Değer');
    expect(value.type).toBe('password');
    await user.type(value, 'production');
    await user.click(within(form).getByTestId('coolify-create-submit'));

    const result = await within(form).findByTestId('coolify-create-result');
    expect(result.textContent).toContain('alpha-web oluşturuldu.');
    expect(result.textContent).toContain('Üretim hedefine bağlandı.');
    expect(result.textContent).toContain('İlk deploy istendi (awaiting_approval).');
    expect(within(result).getByRole('link', { name: 'Deploy’u izle' }).getAttribute('href')).toBe(
      '/deploys/55555555-5555-4555-8555-555555555555',
    );
    expect(sent).toMatchObject({
      env: 'production',
      connection: CONN,
      server: 'srv00001',
      coolifyProject: 'cpalpha1',
      environment: 'production',
      name: 'alpha-web',
      source: { type: 'repository', access: 'public', branch: 'main' },
      buildPack: 'dockerfile',
      ports: '8080',
      dockerfileLocation: '/Dockerfile',
      domains: ['https://alpha.example'],
      envs: [{ key: 'NODE_ENV', value: 'production' }],
      link: 'add',
      deploy: true,
    });
    expect(typeof (sent as unknown as { idempotencyKey: unknown }).idempotencyKey).toBe('string');
  });

  it('the variables editor shows keys only, sends new values once and removes on request', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let sent: unknown = null;
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        [`PUT /api/projects/alpha/coolify/apps/${APP}/envs`]: (req) => {
          sent = req.body;
          return ok({
            created: ['LOG_LEVEL'],
            updated: [],
            removed: ['NODE_ENV'],
            unchanged: [],
            failed: [],
            deployActionId: null,
            deployState: null,
            warnings: [],
          });
        },
      }),
    });
    const panel = await screen.findByTestId('dy-coolify-apps');
    await user.click(await within(panel).findByTestId(`coolify-envs-${APP}`));
    const editor = await screen.findByTestId('coolify-env-editor');
    expect(await within(editor).findByText('NODE_ENV')).toBeTruthy();
    expect(within(editor).getByText(/paylaşılan: project\.DATABASE_URL/)).toBeTruthy();
    expect(within(editor).getAllByText(/değer gizli/).length).toBe(1);
    await user.click(within(editor).getByTestId('coolify-env-remove-NODE_ENV'));
    await user.click(within(editor).getByTestId('coolify-env-add'));
    const row = within(editor).getByTestId('coolify-env-row');
    await user.type(within(row).getByLabelText('Ad'), 'LOG_LEVEL');
    await user.type(within(row).getByLabelText('Değer'), 'debug');
    await user.selectOptions(within(row).getByLabelText('Kapsam'), 'runtime');
    await user.click(within(editor).getByTestId('coolify-env-save'));
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    const done = await screen.findByTestId('coolify-env-done');
    expect(done.textContent).toContain('1 eklendi, 0 güncellendi, 1 kaldırıldı.');
    expect(done.textContent).toContain('bir sonraki deploy');
    expect(sent).toEqual({
      changes: [
        { key: 'LOG_LEVEL', value: 'debug', scope: 'runtime' },
        { key: 'NODE_ENV', remove: true },
      ],
      deploy: false,
    });
  });

  it('the domains editor replaces the list and can redeploy', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let sent: unknown = null;
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        [`PUT /api/projects/alpha/coolify/apps/${APP}/domains`]: (req) => {
          sent = req.body;
          return ok({
            domains: ['https://api.alpha.example', 'https://www.alpha.example'],
            previous: ['https://api.alpha.example'],
            deployActionId: '66666666-6666-4666-8666-666666666666',
            deployState: 'deploying',
            warnings: [],
          });
        },
      }),
    });
    const panel = await screen.findByTestId('dy-coolify-apps');
    await user.click(await within(panel).findByTestId(`coolify-domains-${APP}`));
    const editor = await screen.findByTestId('coolify-domains-editor');
    const box = await within(editor).findByLabelText<HTMLTextAreaElement>('Alan adları');
    expect(box.value).toBe('https://api.alpha.example');
    await user.type(box, '{enter}https://www.alpha.example');
    await user.click(within(editor).getByRole('button', { name: 'Kaydet ve deploy et' }));
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    const done = await screen.findByTestId('coolify-domains-done');
    expect(done.textContent).toContain('Deploy istendi (deploying).');
    expect(sent).toEqual({
      domains: ['https://api.alpha.example', 'https://www.alpha.example'],
      deploy: true,
    });
  });

  it('is not shown to viewers (no Coolify call)', async () => {
    const seen: RecordedRequest[] = [];
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: viewer,
      routes: routes('viewer', {}, seen),
    });
    await screen.findByTestId('project-deploy');
    expect(screen.queryByTestId('dy-coolify-apps')).toBeNull();
    expect(seen.some((r) => r.url.includes('/coolify/'))).toBe(false);
  });

  // p15-coolify-dedupe: fix the existing application (settings), delete duplicates, and no silent second application.
  it('the settings editor sends only what changed and can redeploy', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let sent: unknown = null;
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        [`GET /api/projects/alpha/coolify/apps/${APP}`]: () =>
          ok({
            env: 'production',
            connection: { id: CONN, label: 'Ana Coolify', manageApps: true },
            application: {
              uuid: APP,
              name: 'alpha-api',
              buildPack: 'nixpacks',
              portsExposes: '3000',
              gitBranch: 'main',
              baseDirectory: '/',
              startCommand: null,
              isStatic: false,
              healthCheck: { enabled: false, path: null },
            },
            domains: [],
            envs: [],
          }),
        [`PATCH /api/projects/alpha/coolify/apps/${APP}`]: (req) => {
          sent = req.body;
          return ok({
            appUuid: APP,
            changed: ['ports_exposes', 'start_command'],
            deployActionId: '77777777-7777-4777-8777-777777777777',
            deployState: 'deploying',
            warnings: [],
          });
        },
      }),
    });
    const panel = await screen.findByTestId('dy-coolify-apps');
    await user.click(await within(panel).findByTestId(`coolify-settings-${APP}`));
    const editor = await screen.findByTestId('coolify-settings-editor');
    const ports = await within(editor).findByLabelText<HTMLInputElement>('Portlar');
    expect(ports.value).toBe('3000');
    expect(within(editor).getByLabelText<HTMLSelectElement>('Derleme yöntemi').value).toBe('nixpacks');
    await user.clear(ports);
    await user.type(ports, '8080');
    await user.type(within(editor).getByLabelText('Başlatma komutu'), 'node server.js');
    await user.click(within(editor).getByRole('button', { name: 'Kaydet ve deploy et' }));
    // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
    const done = await screen.findByTestId('coolify-settings-done');
    expect(done.textContent).toContain('Deploy istendi (deploying).');
    expect(sent).toEqual({ ports: '8080', startCommand: 'node server.js', deploy: true });
  });

  it('deletes a linked application after a confirmation (volumes only when ticked) and an unlinked duplicate', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const seen: RecordedRequest[] = [];
    const deleted = (name: string) => () =>
      ok({ appUuid: 'x', name, unlinked: [], creations: 1, warnings: [] });
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes(
        'owner',
        {
          'GET /api/projects/alpha/coolify/apps': () =>
            ok({
              items: [
                {
                  env: 'production',
                  uuid: APP,
                  connection: { id: CONN, label: 'Ana Coolify' },
                  manageApps: true,
                  name: 'alpha-api',
                  fqdn: null,
                  status: 'exited',
                  problem: null,
                },
              ],
              creations: [
                {
                  id: 'a0000000-0000-4000-8000-0000000000b1',
                  project: 'alpha',
                  env: 'production',
                  connection: { id: CONN, label: 'Ana Coolify' },
                  state: 'created',
                  appUuid: 'udup0001',
                  name: 'alpha-api-deploy',
                  request: {},
                  result: null,
                  error: null,
                  createdAt: '2026-10-22T10:00:00.000Z',
                  updatedAt: '2026-10-22T10:00:00.000Z',
                  replayed: false,
                  deletedAt: null,
                },
              ],
            }),
          // p17-coolify-full: the typed name goes along.
          [`DELETE /api/projects/alpha/coolify/apps/${APP}?deleteVolumes=true&confirm=alpha-api`]:
            deleted('alpha-api'),
          'DELETE /api/projects/alpha/coolify/apps/udup0001?deleteVolumes=false&confirm=alpha-api-deploy':
            deleted('alpha-api-deploy'),
        },
        seen,
      ),
    });
    const panel = await screen.findByTestId('dy-coolify-apps');
    await user.click(await within(panel).findByTestId(`coolify-delete-${APP}`));
    let confirm = await screen.findByTestId('coolify-delete-confirm');
    expect(confirm.textContent).toContain('alpha-api silinsin mi?');
    expect(seen.some((r) => r.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByLabelText('Birimlerini de sil (saklanan veriler)'));
    // p17-coolify-full: the delete button waits for the application's name.
    expect(within(confirm).getByTestId<HTMLButtonElement>('coolify-delete-submit').disabled).toBe(true);
    await user.type(within(confirm).getByLabelText('Uygulamanın adı'), 'alpha-api');
    await user.click(within(confirm).getByTestId('coolify-delete-submit'));
    await waitFor(() => {
      expect(seen.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual([
        `/api/projects/alpha/coolify/apps/${APP}?deleteVolumes=true&confirm=alpha-api`,
      ]);
    });
    await user.click(await within(panel).findByTestId('coolify-delete-udup0001'));
    confirm = await screen.findByTestId('coolify-delete-confirm');
    await user.type(within(confirm).getByLabelText('Uygulamanın adı'), 'alpha-api-deploy');
    await user.click(within(confirm).getByTestId('coolify-delete-submit'));
    await waitFor(() => {
      expect(
        seen
          .filter((r) => r.method === 'DELETE')
          .map((r) => r.url)
          .at(-1),
      ).toBe('/api/projects/alpha/coolify/apps/udup0001?deleteVolumes=false&confirm=alpha-api-deploy');
    });
  });

  it('a duplicate refusal offers "create a second one anyway", sent only when ticked', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    renderApp({
      path: '/projects/alpha?tab=deploy',
      initialState: owner,
      routes: routes('owner', {
        'POST /api/projects/alpha/coolify/apps': (req) => {
          bodies.push(req.body as Record<string, unknown>);
          return {
            status: 409,
            body: {
              error: 'coolify_app_exists',
              message: 'exists',
              params: { uuid: APP, name: 'alpha-api', environment: 'production' },
            },
          };
        },
      }),
    });
    const panel = await screen.findByTestId('dy-coolify-apps');
    await user.click(await within(panel).findByTestId('coolify-new-app'));
    const form = await screen.findByTestId('coolify-new-app-form');
    await waitFor(() => {
      expect(within(form).getByLabelText<HTMLSelectElement>('Coolify ortamı').value).toBe('production');
    });
    expect(within(form).queryByLabelText('Yine de ikinci bir uygulama oluştur')).toBeNull();
    await user.click(within(form).getByTestId('coolify-create-submit'));
    expect(await within(form).findByText(/bu uygulama zaten var: alpha-api/)).toBeTruthy();
    await user.click(within(form).getByLabelText('Yine de ikinci bir uygulama oluştur'));
    await user.click(within(form).getByTestId('coolify-create-submit'));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[0]?.allowDuplicate).toBeUndefined();
    expect(bodies[1]?.allowDuplicate).toBe(true);
  });
});

describe('Coolify cards (p15-coolify-dedupe)', () => {
  const TR = messagesFor('tr');
  const TRF = createFormatter('tr');
  it('a delete card is a warning with the application and whether volumes go', () => {
    const s = summarizeDraft(
      {
        kind: 'coolify_change',
        payload: {
          op: 'delete_app',
          destructive: true,
          project: 'alpha',
          appUuid: 'udup0001',
          name: 'alpha-api-deploy',
          request: {},
        },
      },
      TR,
      TRF,
    );
    expect(s.key.map((f) => [f.k, f.v])).toEqual([
      ['İşlem', 'Uygulamayı sil'],
      ['Uygulama', 'alpha-api-deploy · udup0001'],
      ['Birimler', 'korunur'],
    ]);
    expect(s.warnings.map((w) => w.text)).toEqual([TR.coolifyApps.card.destructive]);
  });
  it('a settings card lists the changes (commands not shown)', () => {
    const s = summarizeDraft(
      {
        kind: 'coolify_change',
        payload: {
          op: 'update_app',
          project: 'alpha',
          appUuid: APP,
          request: { ports: '8080', startCommand: 'node s.js', deploy: true },
        },
      },
      TR,
      TRF,
    );
    const settings = s.key.find((f) => f.k === 'Ayarlar')?.v ?? '';
    expect(settings).toBe('ports: 8080\nstartCommand: …');
    expect(JSON.stringify(s)).not.toContain('node s.js');
  });
});
