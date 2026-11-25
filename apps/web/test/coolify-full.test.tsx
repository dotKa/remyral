// p17-coolify-full: the project's Coolify applications get Depolama (volumes with the "not persistent" warning, add,
// remove with the typed name, the manual step of an old Coolify), start / stop / restart and Loglar; Ayarlar →
// Entegrasyonlar → Coolify gets Kaynaklar (applications with the control plane read-only, databases with a new one
// and a typed-name delete, backups); a Coolify-wide card shows what it does and the volume notice.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import { summarizeDraft } from '../src/diyalog/drafts/summary';
import { DEPLOY_OPS, DEPLOY_TARGETS } from '../src/diyalog/harness/screens/w3-project-deploy';
import {
  SETTINGS_COOLIFY_CONNECTIONS,
  SETTINGS_GITHUB,
  SETTINGS_OPS,
} from '../src/diyalog/harness/screens/settings';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const CONN = 'c0000000-0000-4000-8000-0000000000c1';
const APP = 'webprev0001';
const TR = messagesFor('tr');

function shell(over: Record<string, Handler>, seen: RecordedRequest[]): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
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
      return (() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler;
    },
  });
}

function projectRoutes(over: Record<string, Handler>, seen: RecordedRequest[]): Record<string, Handler> {
  return shell(
    {
      'GET /api/projects': () =>
        ok({
          items: [
            {
              id: 'site',
              name: 'Site',
              kind: 'repository',
              createdAt: '2026-10-01T10:00:00.000Z',
              createdBy: null,
              members: 1,
              myRole: 'owner',
            },
          ],
        }),
      'GET /api/deploy/actions?project=site&limit=8': () => ok({ items: [], nextCursor: null }),
      'GET /api/projects/site/deploy-targets': () =>
        ok({ project: 'site', targets: DEPLOY_TARGETS, version: 4, updatedAt: null }),
      'GET /api/integrations/ops': () => ok(DEPLOY_OPS),
      'GET /api/projects/site/site-uploads': () => ok({ items: [] }),
      'GET /api/uptime/settings?project=site': () =>
        ok({ project: 'site', autoMonitor: false, updatedAt: null }),
      'GET /api/projects/site/coolify/apps': () =>
        ok({
          items: [
            {
              env: 'preview',
              uuid: APP,
              connection: { id: CONN, label: 'Ana Coolify' },
              manageApps: true,
              name: 'remyral-site-preview',
              fqdn: 'https://preview.remyral.test',
              status: 'running:healthy',
              problem: null,
            },
          ],
          creations: [],
        }),
      ...over,
    },
    seen,
  );
}

const noStorage = {
  kind: 'application',
  uuid: APP,
  name: 'remyral-site-preview',
  storages: [],
  dataWarnings: [{ path: '/data/site.db', source: 'env:DATABASE_PATH', message: 'x' }],
  features: { storages: 'full', volumeHostPath: false },
  unsupported: null,
  controlPlane: false,
  notes: [],
};
const withVolume = {
  ...noStorage,
  dataWarnings: [],
  storages: [
    {
      uuid: 'st000001',
      id: 1,
      type: 'persistent',
      mount: 'volume',
      name: `${APP}-remyral-data`,
      mountPath: '/data',
      hostPath: null,
      readOnly: false,
      basedOnGit: false,
      contentBytes: null,
      resourceUuid: null,
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(
  'Projeler → Deploy → Coolify uygulamaları: Depolama, durum, loglar (p17-coolify-full)',
  { timeout: 30_000 },
  () => {
    it('warns that /data is not persistent, adds a volume with the notice and removes it after the typed name', async () => {
      stubCookies('__Host-ras-csrf=csrf-1');
      const user = userEvent.setup();
      const seen: RecordedRequest[] = [];
      let view: unknown = noStorage;
      let posted: Record<string, unknown> | null = null;
      renderApp({
        path: '/projects/site?tab=deploy',
        initialState: owner,
        routes: projectRoutes(
          {
            [`GET /api/projects/site/coolify/apps/${APP}/storages`]: () => ok(view),
            [`POST /api/projects/site/coolify/apps/${APP}/storages`]: (req) => {
              posted = req.body as Record<string, unknown>;
              view = withVolume;
              return ok({
                resource: { kind: 'application', uuid: APP, name: 'remyral-site-preview' },
                storage: withVolume.storages[0],
                deploy: null,
                warnings: [
                  'The storage takes effect with the next deploy (redeploy) at /data. It starts empty.',
                ],
              });
            },
            [`DELETE /api/projects/site/coolify/apps/${APP}/storages/st000001?confirm=${encodeURIComponent(`${APP}-remyral-data`)}&deploy=false`]:
              () => {
                view = noStorage;
                return ok({ lost: 'The volume is no longer mounted at /data.', warnings: [] });
              },
          },
          seen,
        ),
      });
      const panel = await screen.findByTestId('dy-coolify-apps');
      await user.click(await within(panel).findByTestId(`coolify-storage-${APP}`));
      const st = await screen.findByTestId('coolify-storage');
      expect((await within(st).findByTestId('coolify-storage-warning')).textContent).toContain(
        '/data/site.db kalıcı değil',
      );
      expect(within(st).getByTestId('coolify-storage-empty').textContent).toContain('her deploy’da silinir');
      await user.click(within(st).getByTestId('coolify-storage-add'));
      const form = within(st).getByTestId('coolify-storage-form');
      expect(within(form).getByTestId('coolify-storage-notice').textContent).toContain('boş başlar');
      const name = within(form).getByLabelText<HTMLInputElement>('Volume adı');
      await user.clear(name);
      await user.type(name, 'remyral-data');
      await user.click(within(form).getByTestId('coolify-storage-save'));
      await waitFor(() => {
        expect(posted).toEqual({ mount: 'volume', mountPath: '/data', name: 'remyral-data', deploy: false });
      });
      expect(await within(st).findByText(/It starts empty/)).toBeTruthy();
      expect(await within(st).findByText('/data')).toBeTruthy();

      await user.click(within(st).getByTestId('coolify-storage-remove-st000001'));
      const rm = within(st).getByTestId('coolify-storage-remove');
      const submit = within(rm).getByTestId<HTMLButtonElement>('coolify-storage-remove-submit');
      expect(submit.disabled).toBe(true);
      await user.type(within(rm).getByLabelText('Onay'), `${APP}-remyral-data`);
      await user.click(submit);
      expect(await within(st).findByText('The volume is no longer mounted at /data.')).toBeTruthy();
      expect(seen.some((r) => r.method === 'DELETE')).toBe(true);
    });

    it('an old Coolify shows the exact manual step instead of the add button', async () => {
      stubCookies('__Host-ras-csrf=csrf-1');
      const user = userEvent.setup();
      renderApp({
        path: '/projects/site?tab=deploy',
        initialState: owner,
        routes: projectRoutes(
          {
            [`GET /api/projects/site/coolify/apps/${APP}/storages`]: () =>
              ok({
                ...noStorage,
                dataWarnings: [],
                features: { storages: 'none', volumeHostPath: true },
                unsupported:
                  'This Coolify (v4.0.0-beta.420) has no API for persistent storage. In Coolify: open … → Persistent Storage → + Add → Volume Mount',
              }),
          },
          [],
        ),
      });
      await user.click(await screen.findByTestId(`coolify-storage-${APP}`));
      const st = await screen.findByTestId('coolify-storage');
      expect((await within(st).findByTestId('coolify-storage-unsupported')).textContent).toContain(
        'Persistent Storage → + Add → Volume Mount',
      );
      expect(within(st).queryByTestId('coolify-storage-add')).toBeNull();
    });

    it('stops only after a confirmation, restarts at once, and shows the logs', async () => {
      stubCookies('__Host-ras-csrf=csrf-1');
      const user = userEvent.setup();
      const seen: RecordedRequest[] = [];
      renderApp({
        path: '/projects/site?tab=deploy',
        initialState: owner,
        routes: projectRoutes(
          {
            [`POST /api/projects/site/coolify/apps/${APP}/stop`]: () => ok({ action: 'stop', warnings: [] }),
            [`POST /api/projects/site/coolify/apps/${APP}/restart`]: () =>
              ok({ action: 'restart', warnings: [] }),
            [`GET /api/projects/site/coolify/apps/${APP}/logs?lines=200&kind=both`]: () =>
              ok({
                appUuid: APP,
                deployment: { uuid: 'dep1', text: 'Building image', truncated: false },
                runtime: { text: 'listening on 3000', truncated: false },
                notes: [],
              }),
          },
          seen,
        ),
      });
      await user.click(await screen.findByTestId(`coolify-status-${APP}`));
      const status = await screen.findByTestId('coolify-status');
      await user.click(within(status).getByTestId(`coolify-restart-${APP}`));
      await waitFor(() => {
        expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/restart'))).toBe(true);
      });
      await user.click(within(status).getByTestId(`coolify-stop-${APP}`));
      expect(seen.some((r) => r.url.endsWith('/stop'))).toBe(false);
      expect(within(status).getByText(/durdurulsun mu/)).toBeTruthy();
      await user.click(within(status).getByRole('button', { name: /^(Evet|Onayla|Durdur)/ }));
      await waitFor(() => {
        expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/stop'))).toBe(true);
      });
      await user.click(screen.getByTestId(`coolify-logs-${APP}`));
      const logs = await screen.findByTestId('coolify-logs-text');
      expect(logs.textContent).toContain('Building image');
      expect(logs.textContent).toContain('listening on 3000');
    });
  },
);

describe('Ayarlar → Entegrasyonlar → Coolify → Kaynaklar (p17-coolify-full)', { timeout: 30_000 }, () => {
  const C1 = SETTINGS_COOLIFY_CONNECTIONS.items[0];
  const BASE = `/api/integrations/coolify/connections/${C1?.id ?? ''}`;
  const overview = {
    connection: {
      id: C1?.id,
      label: C1?.label,
      manageApps: true,
      version: 'v4.5.0',
      permissions: { read: true, deploy: true, write: true, readSensitive: true },
      features: { storages: 'full', volumeHostPath: false },
    },
    applications: [
      {
        uuid: 'cpmaster01',
        name: 'remyral-master',
        status: 'running:healthy',
        fqdn: 'https://console.example',
        controlPlane: true,
      },
      {
        uuid: APP,
        name: 'remyral-site-preview',
        status: 'running:healthy',
        fqdn: null,
        controlPlane: false,
      },
    ],
    databases: [
      {
        uuid: 'db00000001',
        name: 'site-db',
        engine: 'postgresql',
        status: 'running:healthy',
        controlPlane: false,
      },
    ],
    services: [],
    servers: [{ uuid: 'srv0000001', name: 'main', ip: '203.0.113.10', controlPlane: false }],
    projects: [{ uuid: 'proj000001', name: 'site', description: null, controlPlane: false }],
    deployments: [],
    notes: [],
  };

  it('lists applications with the control plane read-only, creates a database and deletes one by its typed name', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const seen: RecordedRequest[] = [];
    let created: Record<string, unknown> | null = null;
    renderApp({
      path: '/settings/integrations?tab=ops',
      initialState: owner,
      routes: shell(
        {
          'GET /api/integrations/github': () => ok(SETTINGS_GITHUB),
          'GET /api/integrations/ops': () => ok(SETTINGS_OPS),
          'GET /api/integrations/coolify/connections': () => ok(SETTINGS_COOLIFY_CONNECTIONS),
          'GET /api/coolify-sso/config': () => ok({ enabled: false, url: null, connections: [] }),
          [`GET ${BASE}/resources`]: () => ok(overview),
          [`GET ${BASE}/projects/proj000001/environments`]: () =>
            ok({ items: [{ id: 7, uuid: 'e1', name: 'production' }] }),
          [`POST ${BASE}/databases`]: (req) => {
            created = req.body as Record<string, unknown>;
            return ok({ uuid: 'db00000002', warnings: [] });
          },
          [`DELETE ${BASE}/databases/db00000001?confirm=site-db&deleteVolumes=false`]: () =>
            ok({ uuid: 'db00000001', name: 'site-db', lost: ['Its volumes are kept on the server.'] }),
        },
        seen,
      ),
    });
    await user.click(await screen.findByTestId(`coolify-resources-${C1?.id ?? ''}`));
    const res = await screen.findByTestId('coolify-resources');
    const list = await within(res).findByTestId('coolify-list-applications');
    expect(within(list).getByText(/kontrol düzlemi \(salt okunur\)/)).toBeTruthy();
    expect(within(list).queryByTestId('coolify-status-cpmaster01')).toBeNull();
    expect(within(list).getByTestId(`coolify-status-${APP}`)).toBeTruthy();

    await user.selectOptions(within(res).getByLabelText('Kaynak türü'), 'databases');
    await user.click(within(res).getByTestId('coolify-new-databases'));
    const form = within(res).getByTestId('coolify-newDatabase');
    await waitFor(() => {
      expect(within(form).getByLabelText<HTMLSelectElement>('Ortam').value).toBe('production');
    });
    await user.type(within(form).getByLabelText('Ad'), 'cache');
    await user.type(within(form).getByLabelText('Parola'), 'panel-only-pass-123');
    await user.click(within(form).getByTestId('coolify-create-resource'));
    await waitFor(() => {
      expect(created).toEqual({
        engine: 'postgresql',
        server: 'srv0000001',
        coolifyProject: 'proj000001',
        environment: 'production',
        name: 'cache',
        password: 'panel-only-pass-123',
        instantDeploy: false,
      });
    });

    await user.click(within(res).getByTestId('coolify-delete-db00000001'));
    const del = within(res).getByTestId('coolify-delete-resource');
    const submit = within(del).getByTestId<HTMLButtonElement>('coolify-delete-resource-submit');
    expect(submit.disabled).toBe(true);
    await user.type(within(del).getByLabelText('Ad'), 'site-db');
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await waitFor(() => {
      expect(seen.some((r) => r.method === 'DELETE' && r.url.includes('confirm=site-db'))).toBe(true);
    });
  });
});

describe('Coolify-wide cards (p17-coolify-full)', () => {
  const TRF = createFormatter('tr');
  it('an add-volume card names the resource and carries the volume notice', () => {
    const s = summarizeDraft(
      {
        kind: 'coolify_change',
        payload: {
          op: 'resource',
          scope: 'connection',
          method: 'addStorage',
          kind: 'application',
          uuid: APP,
          name: 'remyral-site-preview',
          args: { mount: 'volume', name: 'remyral-data', mountPath: '/data', deploy: false },
        },
      },
      TR,
      TRF,
    );
    expect(s.key.map((f) => [f.k, f.v])).toEqual([
      ['İşlem', 'Depolama ekle'],
      ['Kaynak', `remyral-site-preview · ${APP}`],
      ['Nereye', 'Coolify genelinde'],
      ['Ayrıntı', 'mount: volume\nname: remyral-data\nmountPath: /data\ndeploy: false'],
    ]);
    expect(s.notice?.text).toBe(TR.coolifyApps.card.volumeNotice);
    expect(s.warnings).toEqual([]);
  });
  it('a destructive card warns and never shows a file content', () => {
    const s = summarizeDraft(
      {
        kind: 'coolify_change',
        payload: {
          op: 'resource',
          scope: 'project',
          project: 'site',
          method: 'removeStorage',
          uuid: APP,
          name: 'remyral-site-preview',
          destructive: true,
          args: { confirm: 'remyral-data', deploy: false, content: 'SECRET=canary' },
        },
      },
      TR,
      TRF,
    );
    expect(s.warnings.map((w) => w.text)).toEqual([TR.coolifyApps.card.destructiveResource]);
    expect(JSON.stringify(s)).not.toContain('canary');
    expect(s.key.find((f) => f.k === 'Nereye')?.v).toBe('site projesinin uygulaması');
  });
});
