// p17-host-actions: Ayarlar → Sürümler → Sunucu — the control plane's update / rollback through the remyral-ctl host
// applier: the state without an applier (no dead buttons, what the operator runs), an update's progress across the
// master's restart (reconnect, then the result), and the two-step confirmation of a rollback that restores a backup.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_POLL } from '../src/diyalog/screens/settings/host-request';
import { type Handler, renderApp, sessionBody } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

const NOW = new Date().toISOString();
const applier = (over: Record<string, unknown> = {}) => ({
  managed: true,
  lastSeen: NOW,
  version: '1.0.0',
  kinds: ['domain-change', 'upgrade', 'rollback'],
  current: '1.0.0',
  previous: null,
  releases: ['1.0.0'],
  ...over,
});
const release = (version: string, breaking: string[] = []) => ({
  version,
  publishedAt: NOW,
  minWorkerVersion: '1.0.75',
  migrationsHead: '0160',
  breaking,
  summary: `Remyral ${version}`,
  notes: `- notes of ${version}`,
});
const updates = (newer: ReturnType<typeof release>[]) => ({
  configured: true,
  currentVersion: '1.0.0',
  channel: 'stable',
  latest: newer[0] ?? null,
  updateAvailable: newer.length > 0,
  newer,
  checkedAt: NOW,
  source: 'file',
  error: null,
  command: newer[0] ? `sudo remyral-ctl upgrade --to ${newer[0].version}` : null,
});
const action = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'upgrade',
  params: { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: true },
  state: 'pending',
  step: null,
  detail: null,
  log: [],
  requestedAt: NOW,
  expiresAt: NOW,
  updatedAt: NOW,
  finishedAt: null,
  ...over,
});

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/onboarding': ok({
      visible: false,
      completedAt: NOW,
      organisationName: null,
      steps: [],
      progress: { done: 0, total: 0 },
      current: 'done',
    }),
    'GET /api/updates/status': ok(updates([])),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      k in t
        ? t[k]
        : ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  HOST_POLL.ms = 20;
});
afterEach(() => {
  HOST_POLL.ms = 3000;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ayarlar → Sürümler → Sunucu', () => {
  it('without a host applier: says so, shows what the operator runs, and offers no update button', async () => {
    renderApp({
      path: '/settings/releases?tab=server',
      routes: routes({
        'GET /api/host-actions': ok({
          applier: { ...applier({ managed: false, kinds: [], current: null, releases: [] }), lastSeen: null },
          open: null,
          recent: [],
        }),
        'GET /api/updates/status': ok(updates([release('1.1.0')])),
      }),
    });
    const notice = await screen.findByTestId('dy-no-applier');
    expect(notice.textContent).toContain('Bu kurulumda host uygulayıcısı yok');
    expect(notice.textContent).toContain('sudo remyral-ctl upgrade --to 1.1.0');
    expect(notice.textContent).toContain('Coolify');
    const panel = screen.getByTestId('dy-server-panel');
    expect(within(panel).queryByRole('button', { name: 'Şimdi güncelle' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Geri al' })).toBeNull();
  });

  it('an applier older than the request kinds: the one command that brings it up to date', async () => {
    renderApp({
      path: '/settings/releases?tab=server',
      routes: routes({
        'GET /api/host-actions': ok({
          applier: applier({ kinds: ['domain-change'] }),
          open: null,
          recent: [],
        }),
        'GET /api/updates/status': ok(updates([release('1.1.0')])),
      }),
    });
    const n = await screen.findByTestId('dy-applier-outdated');
    expect(n.textContent).toContain('sudo remyral-ctl upgrade');
    expect(n.textContent).not.toContain('--check');
  });

  it('update: breaking changes must be confirmed; progress survives the master restart and ends with the result', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const r = renderApp({
      path: '/settings/releases?tab=server',
      routes: routes({
        'GET /api/host-actions': ok({ applier: applier(), open: null, recent: [] }),
        'GET /api/updates/status': ok(updates([release('1.1.0', ['The API path /x moved'])])),
        'POST /api/host-actions/upgrade': ok(action()),
        'GET /api/host-actions/requests/11111111-1111-4111-8111-111111111111': () => {
          polls += 1;
          if (polls === 1)
            return {
              status: 200,
              body: action({
                state: 'applying',
                step: 'pre-upgrade backup (blocks; a failed backup stops the upgrade)',
                log: ['[ 5] pre-upgrade backup (blocks; a failed backup stops the upgrade)'],
              }),
            };
          // The master is stopped for the upgrade: the proxy answers 502 for a while.
          if (polls <= 4)
            return { status: 502, raw: 'Bad Gateway', headers: { 'content-type': 'text/plain' } };
          return {
            status: 200,
            body: action({
              state: 'applied',
              step: 'health gate',
              detail: 'OK: Remyral 1.1.0 runs at https://console.example.com',
              log: ['[ 8] health gate', 'OK: Remyral 1.1.0 runs at https://console.example.com'],
            }),
          };
        },
      }),
    });
    const upgrade = await screen.findByTestId('dy-server-upgrade');
    const button = within(upgrade).getByRole('button', { name: 'Şimdi güncelle' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(within(upgrade).getByTestId('dy-server-breaking').textContent).toContain('The API path /x moved');
    await user.click(within(upgrade).getByLabelText('Bu değişiklikleri okudum, güncellemeye devam et'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    const sent = r.requests.find((q) => q.method === 'POST' && q.url === '/api/host-actions/upgrade');
    expect(sent?.body).toEqual({ version: '1.1.0', acceptBreaking: true });
    const progress = await screen.findByTestId('dy-host-request');
    await waitFor(() => {
      expect(progress.textContent).toContain('pre-upgrade backup');
    });
    expect(await screen.findByTestId('dy-host-reconnecting')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('dy-host-request').textContent).toContain('Tamamlandı');
    });
    expect(screen.queryByTestId('dy-host-reconnecting')).toBeNull();
    expect(screen.getByTestId('dy-host-request').textContent).toContain('OK: Remyral 1.1.0 runs');
    expect(screen.getByTestId('dy-host-reload').textContent).toContain('Sayfayı yenile');
  });

  it('rollback with a restore: shows what is lost, needs the backup id typed and a second confirmation', async () => {
    const user = userEvent.setup();
    const BACKUP = 'remana-prod-20261026T020000Z';
    const r = renderApp({
      path: '/settings/releases?tab=server',
      routes: routes({
        'GET /api/host-actions': ok({
          applier: applier({ current: '1.1.0', previous: '1.0.0', releases: ['1.1.0', '1.0.0'] }),
          open: null,
          recent: [],
        }),
        'GET /api/backups/status': ok({
          configured: true,
          checkedAt: NOW,
          health: { state: 'ok', reasons: [] },
          problems: [],
          env: 'prod',
          heartbeat: null,
          storage: null,
          encryption: null,
          offsite: null,
          lastBackup: null,
          lastSuccessfulBackup: null,
          backups: [
            {
              runId: BACKUP,
              startedAt: '2026-10-26T02:00:00.000Z',
              finishedAt: '2026-10-26T02:01:00.000Z',
              durationMs: 60_000,
              outcome: 'ok',
              tier: 'daily',
              schemaVersion: '0160',
              dbBytes: 1000,
              dbSha256: null,
              secrets: 'ok',
              offsite: { status: 'not_configured', target: null, error: null },
              warnings: [],
              error: null,
            },
          ],
          lastDrill: null,
          lastSuccessfulDrill: null,
          drills: [],
        }),
        'POST /api/host-actions/rollback': ok(
          action({ kind: 'rollback', params: { version: '1.0.0', backupId: BACKUP, restoreDatabase: true } }),
        ),
        'GET /api/host-actions/requests/11111111-1111-4111-8111-111111111111': ok(
          action({ kind: 'rollback', state: 'applying', step: 'restore backup' }),
        ),
      }),
    });
    const panel = await screen.findByTestId('dy-server-rollback');
    await user.click(within(panel).getByTestId('dy-rollback-restore'));
    const box = await within(panel).findByTestId('dy-rollback-backup');
    const select = await within(box).findByRole('combobox');
    await user.selectOptions(select, BACKUP);
    expect(within(box).getByTestId('dy-rollback-lost').textContent).toMatch(/sonrasında yapılan her şey/);
    const button = within(panel).getByRole('button', { name: 'Geri al' });
    await user.click(button);
    // p18-confirm-dialog: the typed backup id is asked in the confirm dialog; nothing is sent before it.
    const dialog = await screen.findByTestId('dy-rollback-confirm');
    expect(r.requests.some((q) => q.url === '/api/host-actions/rollback')).toBe(false);
    expect(dialog.textContent).toContain(BACKUP);
    const confirm = within(dialog).getByRole('button', { name: 'Evet, geri yükle ve geri al' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const input = within(dialog).getByLabelText(`Onay için yedeğin kimliğini yaz: ${BACKUP}`);
    await user.type(input, 'remana-prod-wrong');
    expect(within(dialog).getByText('Yazılan kimlik seçilen yedekle aynı değil.')).toBeDefined();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.clear(input);
    await user.type(input, BACKUP);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Evet, geri yükle ve geri al' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/host-actions/rollback')).toBe(true);
    });
    const sent = r.requests.find((q) => q.method === 'POST' && q.url === '/api/host-actions/rollback');
    expect(sent?.body).toEqual({
      version: '1.0.0',
      backupId: BACKUP,
      restoreDatabase: true,
      confirm: BACKUP,
    });
    const progress = await screen.findByTestId('dy-host-request');
    await waitFor(() => {
      expect(progress.textContent).toContain('restore backup');
    });
  });
});
