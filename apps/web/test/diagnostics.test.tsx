// p16-doctor: Ayarlar → Tanılama — run the doctor (findings in Turkish with their fix and link), the machines'
// results, the support report (sections without job prompts by default, unticking, preview of the exact files and the
// summary, send by e-mail with a copy) and the support settings (owners only, the password never shown).
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorRun, ReportPreview } from '../src/api/doctor';
import type { AuthState } from '../src/auth/AuthProvider';
import { findingText } from '../src/diyalog/screens/settings/DiagnosticsView';
import { type Handler, renderApp, sessionBody, USER } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 8_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const admin: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'admin' },
  session: null,
  remainingRecoveryCodes: null,
};
const ok =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body });
const empty = ok({ items: [], nextCursor: null });

const RUN: DoctorRun = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'manual',
  scope: 'full',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  requestedBy: USER.id,
  summary: { ok: 1, info: 0, warning: 1, error: 1 },
  findings: [
    {
      check: 'queue.approval_orphan',
      code: 'nothing_to_decide',
      severity: 'error',
      message: 'Job j1 waits for an approval for 120 min, but no approval request is open',
      fix: 'Open the job',
      docs: '/jobs/j1',
      params: { minutes: 120 },
      subject: 'j1',
    },
    {
      check: 'workers.offline',
      code: 'offline',
      severity: 'warning',
      message: 'Machine pi-5 is offline',
      docs: '/machines/wrk_a',
      params: { name: 'pi-5', minutes: 60 },
      subject: 'wrk_a',
    },
    {
      check: 'db.reachable',
      code: 'ok',
      severity: 'ok',
      message: 'Postgres answers (2 ms)',
      params: { ms: 2 },
    },
  ],
  workers: [
    {
      workerId: 'wrk_b',
      name: 'mac-mini',
      state: 'done',
      source: 'doctor',
      opId: 'op-1',
      reason: null,
      report: {
        schemaVersion: 1,
        collectedAt: new Date().toISOString(),
        mode: 'remote',
        workerVersion: '1.0.75',
        host: { platform: 'darwin', release: '25.6', arch: 'arm64', node: 'v24.11.0' },
        master: 'https://remyral.example.com',
        summary: { ok: 0, info: 0, warning: 0, error: 1 },
        findings: [
          {
            check: 'clock',
            code: 'skew',
            severity: 'error',
            message: "This machine's clock is 300 s ahead",
            params: { seconds: 300 },
          },
        ],
      },
    },
  ],
  newProblems: 0,
};

const PREVIEW: ReportPreview = {
  id: '22222222-2222-4222-8222-222222222222',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  sections: ['doctor', 'workers', 'status', 'versions', 'config', 'failed_jobs'],
  logHours: 24,
  files: [
    { path: 'report.md', section: 'summary', bytes: 900, sha256: 'a'.repeat(64) },
    { path: 'doctor.json', section: 'doctor', bytes: 4000, sha256: 'b'.repeat(64), items: 3 },
    { path: 'manifest.json', section: 'manifest', bytes: 500, sha256: 'c'.repeat(64) },
  ],
  sizeBytes: 2400,
  sha256: 'd'.repeat(64),
  filename: 'remyral-support-20261023-1200-22222222.zip',
  overCap: false,
  attachmentMaxBytes: 10 * 1024 * 1024,
  summary: '# Remyral support report\n\n- **ERROR** `queue.approval_orphan` — Job j1 waits',
  description: 'Jobs fail',
  recipient: 'support@vendor.example',
  ccAddress: 'owner@customer.example',
  smtpReady: true,
  sent: null,
};

const SETTINGS = {
  email: 'support@vendor.example',
  defaultEmail: null,
  smtpSource: 'settings',
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls',
    from: 'remyral@customer.example',
    username: 'mailer',
    passwordSet: true,
  },
  updatedAt: null,
  updatedBy: null,
};

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/doctor': ok({
      latest: null,
      latestDaily: { ...RUN, kind: 'daily', scope: 'light', newProblems: 2 },
      runs: [],
    }),
    'GET /api/support/settings': ok(SETTINGS),
    'POST /api/doctor/runs': ok(RUN),
    'POST /api/support/reports': ok(PREVIEW, 201),
    [`POST /api/support/reports/${PREVIEW.id}/send`]: ok({
      to: 'support@vendor.example',
      cc: 'owner@customer.example',
      attached: true,
      sizeBytes: 2400,
      sha256: 'd'.repeat(64),
      sentAt: new Date().toISOString(),
    }),
    'PUT /api/support/settings': ok({ ...SETTINGS, email: 'destek@vendor.example' }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Tanılama (p16-doctor)', () => {
  it('runs the doctor: problems first in Turkish with the fix and the link; the machines below', async () => {
    const user = userEvent.setup();
    const r = renderApp({ path: '/settings/diagnostics', initialState: owner, routes: routes() });
    expect((await screen.findByTestId('dy-doctor-daily')).textContent).toContain('2 yeni sorun');
    await user.click(screen.getByTestId('dy-doctor-run-button'));
    const list = await screen.findByTestId('dy-doctor-findings');
    const rows = within(list).getAllByTestId('dy-doctor-finding');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Karar bekleyen işler');
    expect(rows[0]?.textContent).toContain('120 dakikadır onay bekliyor');
    expect(rows[1]?.textContent).toContain('pi-5 çevrimdışı');
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: 'Aç' })
        .getAttribute('href'),
    ).toBe('/jobs/j1');
    // The machines' check box was on: the request asked for them.
    expect(r.requests.find((q) => q.url === '/api/doctor/runs')?.body).toEqual({ machines: true });
    const machine = await screen.findByTestId('dy-doctor-machine');
    expect(machine.textContent).toContain('mac-mini');
    expect(machine.textContent).toContain('300 sn');
    // Passed checks on request.
    await user.click(within(list).getByRole('button', { name: 'Geçen kontrolleri de göster' }));
    expect(within(list).getAllByTestId('dy-doctor-finding')).toHaveLength(3);
  });

  it('p17-settings-tabs: Doktor (run + machines) is the clean URL; the report and the settings are tabs', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/settings/diagnostics', initialState: owner, routes: routes() });
    await screen.findByTestId('dy-doctor-run');
    expect(
      within(screen.getByTestId('diagnostics-tabs'))
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Doktor', 'Destek raporu', 'Destek ayarları']);
    expect(screen.getByTestId('dy-doctor-machines-panel')).toBeTruthy();
    expect(screen.queryByTestId('dy-doctor-report')).toBeNull();
    expect(screen.queryByTestId('dy-doctor-settings')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Destek raporu' }));
    expect(await screen.findByTestId('dy-doctor-report')).toBeTruthy();
    expect(screen.queryByTestId('dy-doctor-run')).toBeNull();
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByTestId('dy-doctor-settings')).toBeTruthy();
  });

  it('the support report: job prompts off by default, unticking, preview of the files and summary, send with a copy', async () => {
    const user = userEvent.setup();
    const r = renderApp({ path: '/settings/diagnostics?tab=report', initialState: owner, routes: routes() });
    await screen.findByTestId('dy-doctor-report');
    expect(screen.getByTestId<HTMLInputElement>('dy-doctor-section-job_prompts').checked).toBe(false);
    await user.type(screen.getByTestId('dy-doctor-description'), 'Jobs fail');
    await user.click(screen.getByTestId('dy-doctor-section-logs'));
    await user.click(screen.getByTestId('dy-doctor-preview'));
    const body = await screen.findByTestId('dy-doctor-preview-body');
    const req = r.requests.find((q) => q.method === 'POST' && q.url === '/api/support/reports');
    expect(req?.body).toEqual({
      sections: ['doctor', 'workers', 'status', 'versions', 'config', 'failed_jobs'],
      hours: 24,
      description: 'Jobs fail',
    });
    expect(within(screen.getByTestId('dy-doctor-files')).getAllByRole('row')).toHaveLength(4);
    expect(body.textContent).toContain('doctor.json');
    expect(screen.getByTestId('dy-doctor-summary-text').textContent).toContain('# Remyral support report');
    expect(screen.getByTestId('dy-doctor-recipient').textContent).toContain('support@vendor.example');
    await user.click(screen.getByTestId('dy-doctor-ccme'));
    await user.click(screen.getByTestId('dy-doctor-send'));
    const sent = await screen.findByTestId('dy-doctor-sent');
    expect(sent.textContent).toContain('support@vendor.example, owner@customer.example');
    expect(r.requests.find((q) => q.url === `/api/support/reports/${PREVIEW.id}/send`)?.body).toEqual({
      ccMe: true,
    });
  });

  it('a bundle over the cap says the mail carries only the summary; no SMTP disables sending', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/diagnostics?tab=report',
      initialState: owner,
      routes: routes({
        'POST /api/support/reports': ok({ ...PREVIEW, overCap: true, smtpReady: false }, 201),
      }),
    });
    await user.click(await screen.findByTestId('dy-doctor-preview'));
    expect((await screen.findByTestId('dy-doctor-overcap')).textContent).toContain('yalnızca özet gider');
    expect(screen.getByTestId<HTMLButtonElement>('dy-doctor-send').disabled).toBe(true);
  });

  it('support settings: owners save (password only when typed); admins see them read-only', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/diagnostics?tab=settings',
      initialState: owner,
      routes: routes(),
    });
    const email = await screen.findByTestId('dy-doctor-support-email');
    await user.clear(email);
    await user.type(email, 'destek@vendor.example');
    await user.click(screen.getByTestId('dy-doctor-settings-save'));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'PUT' && q.url === '/api/support/settings')).toBe(true);
    });
    const put = r.requests.find((q) => q.method === 'PUT')?.body as {
      email: string;
      smtp: Record<string, unknown>;
    };
    expect(put.email).toBe('destek@vendor.example');
    expect(put.smtp).not.toHaveProperty('password');
    expect(put.smtp).toMatchObject({ host: 'smtp.example.com', port: 587, username: 'mailer' });
    // p17-toasts-rest: the save result is a toast.
    expect(await findToast('Destek ayarları kaydedildi.')).toBeDefined();
  });

  it('no support address (a fresh install): the report is only downloaded; an empty field saves null', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/settings/diagnostics?tab=report',
      initialState: owner,
      routes: routes({
        'GET /api/support/settings': ok({ ...SETTINGS, email: null }),
        'POST /api/support/reports': ok({ ...PREVIEW, recipient: null }, 201),
        'PUT /api/support/settings': ok({ ...SETTINGS, email: null }),
      }),
    });
    await user.click(await screen.findByTestId('dy-doctor-preview'));
    expect((await screen.findByTestId('dy-doctor-recipient-missing')).textContent).toContain(
      'Destek adresi ayarlı değil',
    );
    expect(screen.queryByTestId('dy-doctor-recipient')).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>('dy-doctor-send').disabled).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'Destek ayarları' }));
    const email = await screen.findByTestId<HTMLInputElement>('dy-doctor-support-email');
    expect(email.value).toBe('');
    expect(screen.getByText(/Varsayılan bir adres yok/)).toBeTruthy();
    await user.click(screen.getByTestId('dy-doctor-settings-save'));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'PUT' && q.url === '/api/support/settings')).toBe(true);
    });
    expect((r.requests.find((q) => q.method === 'PUT')?.body as { email: unknown }).email).toBeNull();
  });

  it('admins: the settings are read-only', async () => {
    renderApp({ path: '/settings/diagnostics?tab=settings', initialState: admin, routes: routes() });
    expect((await screen.findByTestId<HTMLInputElement>('dy-doctor-support-email')).disabled).toBe(true);
    expect(screen.queryByTestId('dy-doctor-settings-save')).toBeNull();
  });

  it('finding texts: by check and code with parameters, the English text for an unknown code', () => {
    const t = messagesFor('tr').doctor;
    expect(
      findingText(
        t,
        {
          check: 'workers.clock',
          code: 'skew',
          severity: 'error',
          message: 'x',
          params: { name: 'pi', seconds: 90 },
        },
        'master',
      ).text,
    ).toBe('pi saatinde ana sunucuya göre 90 sn fark var.');
    expect(
      findingText(
        t,
        {
          check: 'backups',
          code: 'backup_overdue',
          severity: 'warning',
          message: 'The last backup is 3 days old',
          fix: 'Run it',
        },
        'master',
      ),
    ).toEqual({
      text: 'The last backup is 3 days old',
      fix: 'Run it',
    });
    expect(
      findingText(
        t,
        { check: 'db.reachable', code: 'ok', severity: 'ok', message: 'x', params: { ms: 3 } },
        'master',
      ).fix,
    ).toBeNull();
  });
});
