// p17-host-actions part 3: Ayarlar → Yedekler → Yedekleri yönet (owners) — without an applier (no dead buttons: the
// lines the operator writes), a backup now with its reason and its progress, the encryption recipients (at least two),
// and a restore that shows what is lost and needs the backup id typed before anything is sent.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '@remyral/i18n';
import { HOST_POLL } from '../src/diyalog/screens/settings/host-request';
import { decisionRows } from '../src/diyalog/ops/NeedsSummary';
import { buildNeedsYou } from '../src/screens/home/needsYou';
import { type Handler, renderApp, sessionBody } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const NOW = new Date().toISOString();
const R1 = `age1${'q'.repeat(58)}`;
const R2 = `age1${'p'.repeat(58)}`;
const BACKUP = 'remana-prod-20261026T020000Z';
const KINDS = [
  'domain-change',
  'upgrade',
  'rollback',
  'backup-run',
  'backup-drill',
  'backup-restore',
  'backup-config',
  'backup-offsite',
];

const overview = {
  configured: true,
  checkedAt: NOW,
  health: { state: 'ok', reasons: [] },
  problems: [],
  env: 'prod',
  heartbeat: {
    at: NOW,
    startedAt: NOW,
    nextBackupAt: NOW,
    nextDrillAt: null,
    schedule: { mode: 'daily', intervalMinutes: null, timeOfDay: '02:30', drill: 'weekly sun 04:00' },
    retention: { daily: 7, weekly: 4, monthly: 6, keepRecentHours: 0 },
  },
  storage: { backups: 1, bytes: 2048, freeBytes: 1_000_000 },
  encryption: { configured: true, recipients: 1 },
  offsite: { configured: false, target: null, lastUploadAt: null, lastError: null },
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
      schemaVersion: '0161',
      dbBytes: 4096,
      dbSha256: null,
      secrets: 'ok',
      offsite: { status: 'not_configured', target: null, error: null },
      warnings: [],
      error: null,
    },
  ],
  lastDrill: null,
  lastSuccessfulDrill: null,
  drills: [
    {
      runId: 'remana-prod-20261026T040000Z',
      backupId: BACKUP,
      startedAt: NOW,
      finishedAt: NOW,
      outcome: 'passed',
      restoreMs: 100,
      totalMs: 200,
      dumpBytes: 1,
      restoredBytes: 1,
      checks: [],
      error: null,
    },
  ],
};
const manage = (managed: boolean, over: Record<string, unknown> = {}) => ({
  applier: {
    managed,
    lastSeen: managed ? NOW : null,
    version: '1.1.0',
    kinds: managed ? KINDS : [],
    current: '1.1.0',
    previous: null,
    releases: ['1.1.0'],
  },
  settings: managed
    ? {
        time: '02:30',
        intervalMinutes: '',
        keepDaily: '7',
        keepWeekly: '',
        keepMonthly: '',
        keepRecentHours: '',
        drillEnabled: 'true',
        drillWeekday: 'sun',
        drillTime: '04:00',
        walArchive: 'off',
        recipients: [R1, R2],
        offsite: '',
      }
    : null,
  offsite: {
    config: null,
    keyIdHint: null,
    keyFingerprint: null,
    lastTest: null,
    lastTestAt: null,
    updatedAt: null,
    storageKeysAvailable: false,
  },
  open: null,
  recent: [],
  ...over,
});
const action = (over: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'backup-run',
  params: {},
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
    'GET /api/backups/status': ok(overview),
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

describe('Ayarlar → Yedekler → Yedekleri yönet', () => {
  it('without a host applier: no request buttons; the stack.env lines and the offsite.env lines (no secret)', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/backups',
      routes: routes({ 'GET /api/backups/manage': ok(manage(false)) }),
    });
    const notice = await screen.findByTestId('dy-backup-no-applier');
    expect(notice.textContent).toContain('Bu kurulumda host uygulayıcısı yok');
    expect(notice.textContent).toContain('sudo remyral-ctl backup --reason manual');
    const panel = screen.getByTestId('dy-backup-manage');
    expect(within(panel).queryByRole('button', { name: 'Şimdi yedek al' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Kaydet ve sunucuya uygula' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Geri yükle' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Satırları göster' }));
    const lines = screen.getByTestId('dy-backup-env-lines');
    expect(lines.textContent).toContain('BACKUP_TIME=02:30');
    expect(lines.textContent).toContain('BACKUP_KEEP_DAILY=7');
    expect(lines.textContent).toContain('PG_WAL_ARCHIVE=off');
    const off = screen.getByTestId('dy-offsite-operator');
    expect(off.textContent).toContain('BACKUP_S3_SECRET_ACCESS_KEY=<gizli erişim anahtarı>');
  });

  it('backup now with a reason; its progress until the result', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const r = renderApp({
      path: '/settings/backups',
      routes: routes({
        'GET /api/backups/manage': ok(manage(true)),
        'POST /api/backups/run': ok(action()),
        'GET /api/host-actions/requests/22222222-2222-4222-8222-222222222222': () => {
          polls += 1;
          return {
            status: 200,
            body:
              polls < 2
                ? action({ state: 'applying', step: 'backup' })
                : action({ state: 'applied', step: 'backup', detail: `backup ${BACKUP}: ok` }),
          };
        },
      }),
    });
    const now = await screen.findByTestId('dy-backup-now');
    await user.type(within(now).getByLabelText('Neden (denetim kaydına yazılır)'), 'güncelleme öncesi');
    await user.click(within(now).getByRole('button', { name: 'Şimdi yedek al' }));
    const sent = r.requests.find((q) => q.method === 'POST' && q.url === '/api/backups/run');
    expect(sent?.body).toEqual({ reason: 'güncelleme öncesi' });
    await waitFor(() => {
      expect(screen.getByTestId('dy-host-request').textContent).toContain(`backup ${BACKUP}: ok`);
    });
    expect(screen.getByTestId('dy-host-request').textContent).toContain('Tamamlandı');
  });

  it('recipients: at least two to save; the new list goes to the host', async () => {
    const user = userEvent.setup();
    const R3 = `age1${'z'.repeat(58)}`;
    const r = renderApp({
      path: '/settings/backups',
      routes: routes({
        'GET /api/backups/manage': ok(manage(true)),
        'PUT /api/backups/settings': ok(action({ kind: 'backup-config' })),
        'GET /api/host-actions/requests/22222222-2222-4222-8222-222222222222': ok(
          action({ kind: 'backup-config', state: 'applying' }),
        ),
      }),
    });
    const box = await screen.findByTestId('dy-backup-settings');
    const save = within(box).getByRole('button', { name: 'Kaydet ve sunucuya uygula' });
    await user.click(within(box).getByRole('button', { name: `${R2.slice(0, 12)} anahtarını çıkar` }));
    expect(within(box).getByTestId('dy-recipients-few')).toBeDefined();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const add = within(box).getByLabelText('Açık anahtar ekle (age1…)');
    await user.type(add, 'AGE-SECRET-KEY-1XYZ');
    expect(
      within(box).getByText('Bu bir age açık anahtarı değil (age1 ile başlar, 62 karakter).'),
    ).toBeDefined();
    await user.clear(add);
    await user.type(add, R3);
    await user.click(within(box).getByRole('button', { name: 'Ekle' }));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    const sent = r.requests.find((q) => q.method === 'PUT' && q.url === '/api/backups/settings');
    expect(sent?.body).toMatchObject({
      time: '02:30',
      keepDaily: 7,
      walArchive: false,
      recipients: [R1, R3],
    });
  });

  it('restore: what is lost, the id typed, then the request', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/backups',
      routes: routes({
        'GET /api/backups/manage': ok(manage(true)),
        'POST /api/backups/restore': ok(action({ kind: 'backup-restore' })),
        'GET /api/host-actions/requests/22222222-2222-4222-8222-222222222222': ok(
          action({ kind: 'backup-restore', state: 'applying', step: 'restore backup' }),
        ),
      }),
    });
    const list = await screen.findByTestId('dy-backup-list');
    expect(list.textContent).toContain('Tatbikatta doğrulandı');
    await user.click(within(list).getByRole('button', { name: 'Geri yükle' }));
    const dialog = await screen.findByTestId('dy-restore-dialog');
    expect(within(dialog).getByTestId('dy-restore-lost').textContent).toMatch(/sonrasında yapılan her şey/);
    const confirm = within(dialog).getByRole('button', { name: 'Evet, geri yükle' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(`Onay için yedeğin kimliğini yaz: ${BACKUP}`), BACKUP);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(r.requests.some((q) => q.url === '/api/backups/restore')).toBe(false);
    await user.click(confirm);
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/backups/restore')).toBe(true);
    });
    expect(r.requests.find((q) => q.url === '/api/backups/restore')?.body).toEqual({
      backupId: BACKUP,
      confirm: BACKUP,
    });
    await waitFor(() => {
      expect(screen.getByTestId('dy-host-request').textContent).toContain('restore backup');
    });
  });
  it('time lock (p17-panel-settings Part 0): waiting changes shown first with "İptal et"; the waiting key stays marked', async () => {
    const user = userEvent.setup();
    const R3 = `age1${'z'.repeat(58)}`;
    const pending = [
      {
        change: 'recipients',
        id: '33333333-3333-4333-8333-333333333333',
        since: '2026-10-27T10:00:00Z',
        until: '2026-10-30T10:00:00Z',
        added: [R3],
        target: '',
      },
      {
        change: 'offsite',
        id: '44444444-4444-4444-8444-444444444444',
        since: '2026-10-27T11:00:00Z',
        until: '2026-10-30T11:00:00Z',
        added: [],
        target: 's3://evil/x/ @ evil.example.com',
      },
    ];
    const base = manage(true);
    const r = renderApp({
      path: '/settings/backups',
      routes: routes({
        'GET /api/backups/manage': ok({
          ...base,
          applier: { ...base.applier, kinds: [...KINDS, 'backup-change-cancel'] },
          settings: { ...base.settings, pending, changes: [] },
        }),
        'POST /api/backups/changes/cancel': ok(action({ kind: 'backup-change-cancel' })),
        'GET /api/host-actions/requests/22222222-2222-4222-8222-222222222222': ok(
          action({ kind: 'backup-change-cancel', state: 'applied', detail: 'cancelled: offsite' }),
        ),
      }),
    });
    const box = await screen.findByTestId('dy-backup-pending');
    expect(box.textContent).toContain('Bekleyen yedek değişiklikleri');
    expect(within(box).getByTestId('dy-backup-pending-recipients').textContent).toContain(R3);
    expect(within(box).getByTestId('dy-backup-pending-offsite').textContent).toContain(
      's3://evil/x/ @ evil.example.com',
    );
    expect(box.textContent).toContain('sudo remyral-ctl status');
    // The waiting key stays in the recipients list (saving the schedule keeps it waiting), marked.
    const rec = screen.getByTestId('dy-backup-recipients');
    expect(rec.textContent).toContain(R3);
    expect(rec.textContent).toContain('bekliyor');
    await user.click(
      within(within(box).getByTestId('dy-backup-pending-offsite')).getByRole('button', { name: 'İptal et' }),
    );
    await waitFor(() => {
      expect(r.requests.find((q) => q.url === '/api/backups/changes/cancel')?.body).toEqual({
        change: 'offsite',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('dy-host-request').textContent).toContain('cancelled: offsite');
    });
  });

  it('time lock: a "scheduled" request result is shown as accepted with a waiting part', async () => {
    renderApp({
      path: '/settings/backups',
      routes: routes({
        'GET /api/backups/manage': ok(
          manage(true, {
            open: action({ kind: 'backup-config', state: 'applying' }),
          }),
        ),
        'GET /api/host-actions/requests/22222222-2222-4222-8222-222222222222': ok(
          action({
            kind: 'backup-config',
            state: 'scheduled',
            detail: 'adding 1 encryption recipient(s) waits until 2026-10-30T10:00:00Z',
          }),
        ),
      }),
    });
    await waitFor(() => {
      expect(screen.getByTestId('dy-host-request').textContent).toContain(
        'Kabul edildi; bir kısmı 72 saat bekliyor',
      );
    });
  });
  it('time lock: "Senden bekleyen" lists a waiting backup change (never dismissible), with its countdown', () => {
    const R3 = `age1${'z'.repeat(58)}`;
    const items = buildNeedsYou(
      {
        approvals: [],
        failed: [],
        blocked: [],
        workers: [],
        overview: [],
        backupChanges: [
          {
            change: 'recipients',
            id: 'x',
            since: '2026-10-27T10:00:00Z',
            until: '2026-10-30T10:00:00Z',
            added: [R3],
            target: '',
          },
        ],
        dismissed: new Set(['backup-change:recipients:2026-10-27T10:00:00Z']),
      },
      Date.parse('2026-10-27T12:00:00Z'),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'backup-change',
      tone: 'danger',
      action: { href: '/settings/backups' },
    });
    const rows = decisionRows([], items, false, messagesFor('tr'), 'tr');
    expect(rows[0]).toMatchObject({
      href: '/settings/backups',
      until: '2026-10-30T10:00:00Z',
      text: 'Yedek değişikliği bekliyor: Yeni şifreleme anahtarı, 2026-10-30 10:00 UTC tarihinde uygulanacak.',
    });
  });
});
