// p17-panel-settings: Ayarlar → Sunucu ayarları (settings that used to be environment variables, key rotation,
// maintenance jobs) and the account recovery in Ayarlar → Kullanıcılar.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_POLL } from '../src/diyalog/screens/settings/server-maintenance';
import { type Handler, renderApp, sessionBody } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      k in t
        ? t[k]
        : ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

const field = (over: Record<string, unknown>) => ({
  kind: 'int',
  env: 'X',
  value: null,
  envValue: null,
  source: 'env',
  options: null,
  min: null,
  max: null,
  restart: false,
  sensitive: false,
  secretSet: false,
  generated: null,
  ...over,
});

const logs = (over: Record<string, unknown> = {}) => ({
  section: 'logs',
  version: 3,
  updatedAt: null,
  info: {},
  fields: [
    field({ key: 'logs.retentionDays', env: 'LOG_STORE_RETENTION_DAYS', value: 7, envValue: 7 }),
    field({
      key: 'logs.level',
      kind: 'enum',
      env: 'LOG_STORE_LEVEL',
      value: 'warn',
      envValue: 'info',
      source: 'panel',
      options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    }),
  ],
  ...over,
});

const notifications = (over: Record<string, unknown> = {}) => ({
  section: 'notifications',
  version: 1,
  updatedAt: null,
  info: {},
  fields: [
    field({
      key: 'notify.webhook.allowlist',
      kind: 'list',
      env: 'NOTIFY_WEBHOOK_ALLOWLIST',
      value: ['https://hooks.example.com/'],
      envValue: ['https://hooks.example.com/'],
    }),
    field({
      key: 'notify.webhook.secret',
      kind: 'secret',
      env: 'NOTIFY_WEBHOOK_SECRET_FILE',
      secretSet: true,
      generated: 'random',
    }),
    field({ key: 'push.subject', kind: 'string', env: 'PUSH_VAPID_SUBJECT' }),
  ],
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  MAINTENANCE_POLL.ms = 20;
});
afterEach(() => {
  MAINTENANCE_POLL.ms = 2000;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ayarlar → Sunucu ayarları', () => {
  it('a section shows the effective value, the environment variable and the source; a save sends only changes', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/server-settings?tab=logs',
      routes: routes({
        'GET /api/panel-settings/logs': ok(logs()),
        'PUT /api/panel-settings/logs': ok({ ...logs(), generated: {} }),
      }),
    });
    const box = await screen.findByTestId('dy-panel-logs');
    const retention = within(box).getByTestId('dy-field-logs.retentionDays');
    expect(retention.textContent).toContain('Kaynak: ortam değişkeni (LOG_STORE_RETENTION_DAYS)');
    expect(within(box).getByTestId('dy-field-logs.level').textContent).toContain(
      'Kaynak: panel (LOG_STORE_LEVEL)',
    );
    const save = within(box).getByRole('button', { name: 'Kaydet' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const input = within(retention).getByLabelText('Saklama (gün)');
    await user.clear(input);
    await user.type(input, '3');
    // "Ortam değişkenine dön" for the panel value.
    await user.click(
      within(within(box).getByTestId('dy-field-logs.level')).getByRole('button', {
        name: 'Ortam değişkenine dön',
      }),
    );
    await user.click(save);
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'PUT')?.body).toEqual({
        values: { 'logs.retentionDays': 3, 'logs.level': null },
        version: 3,
      });
    });
    expect(await within(box).findByText('Kaydedildi.')).toBeDefined();
  });

  it('secrets are write-only; a generated one is shown once after the save', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/server-settings',
      routes: routes({
        'GET /api/panel-settings/notifications': ok(notifications()),
        'GET /api/panel-settings/mail': ok({
          source: 'env',
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          from: 'remyral@example.com',
          username: null,
          passwordSet: false,
        }),
        'PUT /api/panel-settings/notifications': ok({
          ...notifications(),
          generated: { 'notify.webhook.secret': 'NEW-SECRET-SHOWN-ONCE-0123456789012345678901234567' },
        }),
      }),
    });
    const box = await screen.findByTestId('dy-panel-notifications');
    const secret = within(box).getByTestId('dy-field-notify.webhook.secret');
    expect(secret.textContent).toContain('Ayarlı');
    expect(secret.querySelector('input[type=password]')).toBeNull();
    await user.click(within(secret).getByRole('checkbox', { name: 'Yeniden üret' }));
    await user.click(within(box).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'PUT')?.body).toMatchObject({
        values: {},
        generate: ['notify.webhook.secret'],
      });
    });
    const shown = await screen.findByTestId('dy-panel-generated');
    expect(shown.textContent).toContain('NEW-SECRET-SHOWN-ONCE');
    expect(shown.textContent).toContain('yalnız şimdi gösteriliyor');
    // The one SMTP configuration is shown next to it, from the environment.
    expect(screen.getByTestId('dy-mail-current').textContent).toContain('ortam değişkeni');
  });

  it('a change that moves this request to another IP asks first, then saves with the confirmation', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const network = {
      section: 'network',
      version: 1,
      updatedAt: null,
      info: { clientIp: '198.51.100.10', socketAddress: '10.0.0.2', forwardedFor: '203.0.113.5' },
      fields: [field({ key: 'net.trustProxyHops', env: 'TRUST_PROXY_HOPS', value: 0, envValue: 0 })],
    };
    const r = renderApp({
      path: '/settings/server-settings?tab=network',
      routes: routes({
        'GET /api/panel-settings/network': ok(network),
        'PUT /api/panel-settings/network': () => {
          calls += 1;
          return calls === 1
            ? {
                status: 409,
                body: {
                  error: 'client_ip_would_change',
                  message: 'x',
                  details: { current: '198.51.100.10', after: '203.0.113.5' },
                },
              }
            : { status: 200, body: { ...network, generated: {} } };
        },
      }),
    });
    expect((await screen.findByTestId('dy-panel-client-ip')).textContent).toContain('198.51.100.10');
    const box = screen.getByTestId('dy-panel-network');
    const input = within(box).getByLabelText('Güvenilen proxy sayısı');
    await user.clear(input);
    await user.type(input, '1');
    await user.click(within(box).getByRole('button', { name: 'Kaydet' }));
    const dialog = await screen.findByTestId('dy-panel-confirm');
    expect(dialog.textContent).toContain('203.0.113.5');
    await user.click(within(dialog).getByRole('button', { name: 'Evet, kaydet' }));
    await waitFor(() => {
      expect(r.requests.filter((q) => q.method === 'PUT').at(-1)?.body).toMatchObject({
        values: { 'net.trustProxyHops': 1 },
        confirm: ['client_ip_change'],
      });
    });
  });

  it('keys: the lease key shows the host procedure; a webhook rotation step shows its effect, then the key once', async () => {
    const user = userEvent.setup();
    const items = [
      {
        item: 'webhookHmac',
        online: true,
        source: 'panel',
        keyId: null,
        publicKey: null,
        pending: false,
        retired: [],
        actions: ['prepare', 'activate', 'cancel'],
        procedure: [],
      },
      {
        item: 'leaseSigning',
        online: false,
        source: 'env',
        keyId: 'abc123',
        publicKey: null,
        pending: false,
        retired: [],
        actions: [],
        procedure: ['sudo openssl genpkey -algorithm ed25519 -out lease-signing.pem.new'],
      },
    ];
    const r = renderApp({
      path: '/settings/server-settings?tab=keys',
      routes: routes({
        'GET /api/panel-settings/keys': ok({ items }),
        'GET /api/panel-settings/keys/webhookHmac/dry-run?action=prepare': ok({
          effect: ['A new signing key is generated and shown once.'],
        }),
        'POST /api/panel-settings/keys/webhookHmac/prepare': ok({
          secret: 'NEXT-KEY-0123456789',
          publicKey: null,
        }),
      }),
    });
    const lease = await screen.findByTestId('dy-key-leaseSigning');
    expect(lease.textContent).toContain('lease-signing.pem.new');
    expect(within(lease).queryByRole('button')).toBeNull();
    const hook = screen.getByTestId('dy-key-webhookHmac');
    await user.click(within(hook).getAllByRole('button')[0] as HTMLElement);
    const preview = await screen.findByTestId('dy-key-preview-webhookHmac');
    expect(preview.textContent).toContain('shown once');
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    await user.click(within(preview).getAllByRole('button')[0] as HTMLElement);
    expect((await screen.findByTestId('dy-key-shown-webhookHmac')).textContent).toContain(
      'NEXT-KEY-0123456789',
    );
  });

  it('maintenance: the real run waits for a dry run of the same choice; progress shows while it runs', async () => {
    const user = userEvent.setup();
    const job = (over: Record<string, unknown>) => ({
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'blobs-migrate',
      params: { mode: 'to-store' },
      dryRun: true,
      state: 'running',
      progress: { done: 2, total: 10, step: 'artifact', lines: ['artifact: 10 rows'] },
      report: null,
      error: null,
      startedAt: '2026-10-27T10:00:00Z',
      finishedAt: null,
      startedBy: 'alex',
      ...over,
    });
    let jobs: unknown[] = [];
    const r = renderApp({
      path: '/settings/server-settings?tab=maintenance',
      routes: routes({
        'GET /api/maintenance/jobs': () => ({ status: 200, body: { items: jobs } }),
        'POST /api/maintenance/jobs': (q) => {
          jobs = [job({ dryRun: (q.body as { dryRun: boolean }).dryRun })];
          return { status: 200, body: jobs[0] };
        },
        'GET /api/maintenance/jobs/33333333-3333-4333-8333-333333333333': () => ({
          status: 200,
          body: job({
            state: 'done',
            progress: { done: 10, total: 10, step: 'artifact', lines: [] },
            report: [{ kind: 'artifact' }],
          }),
        }),
      }),
    });
    const card = await screen.findByTestId('dy-maint-blobs-migrate');
    const start = within(card).getByRole('button', { name: 'Başlat' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(card).getByRole('button', { name: 'Kuru çalıştır' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'POST')?.body).toEqual({
        kind: 'blobs-migrate',
        dryRun: true,
        params: { mode: 'to-store' },
      });
    });
    expect((await within(card).findByTestId('dy-maint-job-blobs-migrate')).textContent).toMatch(
      /2 \/ 10|10 \/ 10/,
    );
    jobs = [job({ state: 'done', progress: { done: 10, total: 10, step: '', lines: [] } })];
    await waitFor(() => {
      expect(within(card).getByRole<HTMLButtonElement>('button', { name: 'Başlat' }).disabled).toBe(false);
    });
  });

  it('workflows: the pre-check report is shown', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/server-settings?tab=workflows',
      routes: routes({
        'GET /api/panel-settings/workflows': ok({
          section: 'workflows',
          version: 1,
          updatedAt: null,
          info: {},
          fields: [
            field({
              key: 'workflow.engineV2',
              kind: 'bool',
              env: 'WORKFLOW_ENGINE_V2',
              value: false,
              envValue: false,
            }),
          ],
        }),
        'POST /api/panel-settings/workflows/check': ok({
          total: 3,
          v1: 2,
          v2: 1,
          v1Workflows: 2,
          openRuns: { engine1: 0, engine2: 0 },
          failures: [],
          lines: ['3 definitions checked', '0 failed'],
        }),
      }),
    });
    const panel = await screen.findByTestId('dy-workflow-check');
    await user.click(within(panel).getByRole('button', { name: 'Ön kontrolü çalıştır' }));
    const report = await screen.findByTestId('dy-workflow-check-report');
    expect(report.textContent).toContain('Ön kontrol geçti.');
    expect(report.textContent).toContain('3 definitions checked');
  });
});

describe('Ayarlar → Kullanıcılar → Hesap kurtarma', () => {
  const op = {
    id: '22222222-2222-4222-8222-222222222222',
    username: 'op1',
    role: 'operator',
    totpEnrolled: true,
    disabled: false,
    disabledAt: null,
    lockedUntil: '2026-10-27T11:00:00Z',
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    memberships: [],
  };

  it('owner: a password reset shows the one-time password; an unlock is offered for a locked account', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/users',
      routes: routes({
        'GET /api/users?limit=500&offset=0': ok({ items: [op], total: 1 }),
        'GET /api/users': ok({ items: [op], total: 1 }),
        'GET /api/users/recovery-requests': ok({ items: [] }),
        'POST /api/users/22222222-2222-4222-8222-222222222222/recover': ok({
          status: 'applied',
          temporaryPassword: 'TempPass-0123456789AB',
          revokedSessions: 1,
          requestId: null,
        }),
      }),
    });
    const row = await screen.findByTestId('user-row');
    await user.click(within(row).getByRole('button', { name: /op1/ }));
    const section = await screen.findByTestId('user-recovery');
    expect(within(section).getByTestId('user-unlock')).toBeDefined();
    await user.click(within(section).getByRole('button', { name: 'Parolayı sıfırla' }));
    await user.click(await within(section).findByRole('button', { name: 'Evet, uygula' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.url.endsWith('/recover'))?.body).toEqual({ action: 'reset-password' });
    });
    expect((await screen.findByTestId('user-recovery-password')).textContent).toContain(
      'TempPass-0123456789AB',
    );
  });
});
