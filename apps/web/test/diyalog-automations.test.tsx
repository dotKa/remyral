// p12-diyalog-w2: Otomasyonlar in the Diyalog language — the list (trigger, last / next run, success, waiting,
// project filter), the form (cron preset + preview, step-up retry on create, webhook one-time secret with curl), the
// automation (tabs, Run now, Decide now, replace secret with step-up, pause / resume / delete with confirmation),
// "Klasik görünüm" and flag off = the classic pages unchanged.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

// p16-workflow-quality: the form's default zone is the browser's; these suites pin it to UTC (zoned schedules are
// tested in diyalog-workflow-quality.test.tsx).
vi.mock('../src/lib/schedule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/schedule')>()),
  browserTimeZone: () => null,
}));

const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const AP = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-10-15T10:00:00.000Z';
const empty = { status: 200, body: { items: [], nextCursor: null } };
const STEP_UP_REQUIRED = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

function automation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A1,
    project: 'acme',
    name: 'Nightly tests',
    description: null,
    state: 'active',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 3 * * *' },
    triggerSummary: 'Every day at 03:00 UTC',
    target: {
      kind: 'job',
      runtime: 'codex',
      workflowId: null,
      title: 'Run the test suite',
      approvalPolicy: 'ask-sensitive',
      sandboxProfile: 'container',
    },
    approvalTimeoutMinutes: 60,
    waiting: null,
    concurrency: 'skip',
    catchUp: 'once',
    maxRunsPerHour: 30,
    notifyOnFailure: true,
    nextRunAt: '2026-10-16T03:00:00.000Z',
    lastRun: { id: RUN, state: 'failed', at: NOW },
    runCount: 4,
    successRate: 0.75,
    webhook: null,
    runAs: USER.id,
    createdBy: USER.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...automation(over),
    targetSpec: {
      spec: { runtime: 'codex', prompt: 'Run the test suite', sandboxProfile: 'container' },
      priority: 0,
      workflowInputs: null,
      workflowRepository: null,
    },
    stats: {
      finished: 4,
      succeeded: 3,
      failed: 1,
      skipped: 0,
      lastFailure: { runId: RUN, state: 'failed', reason: 'The job ended failed.', jobId: JOB, at: NOW },
    },
    chainSource: null,
    chainedBy: [{ id: A2, name: 'Deploy preview', on: ['succeeded'] }],
    github: null,
    ...over,
  };
}

const WEBHOOK = {
  url: 'https://remyral.example/hooks/automations/a1',
  secretHint: 'abcd1234',
  rotatedAt: NOW,
  previous: null,
  allowIps: null,
};

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } }),
    ...over,
  };
}

function formRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return base({
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'Acme',
            kind: 'repository',
            createdAt: NOW,
            createdBy: null,
            members: 1,
            myRole: 'owner',
          },
        ],
      },
    }),
    'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
    'GET /api/automations': () => ({ status: 200, body: { items: [automation()] } }),
    'GET /api/projects/acme/git': () => ({
      status: 200,
      body: {
        config: { repositoryUrl: 'https://github.com/acme/app.git', baseBranch: 'main', provider: 'github' },
      },
    }),
    'GET /api/automations/cron-preview?cron=0%203%20*%20*%20*': () => ({
      status: 200,
      body: { cron: '0 3 * * *', summary: 'Every day at 03:00 UTC', nextRuns: [NOW] },
    }),
    'GET /api/automations/cron-preview?cron=0%209%20*%20*%201-5': () => ({
      status: 200,
      body: { cron: '0 9 * * 1-5', summary: 'Weekdays at 09:00 UTC', nextRuns: [NOW] },
    }),
    ...over,
  });
}

const posts = (requests: readonly RecordedRequest[], url: string): RecordedRequest[] =>
  requests.filter((r) => r.method === 'POST' && r.url === url);

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
  await user.type(within(dialog).getByLabelText('6 haneli kod'), '123456');
  await user.click(within(dialog).getByRole('button', { name: 'Onayla' }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Otomasyonlar (p12-diyalog-w2)', { timeout: 30_000 }, () => {
  it('p16-workflow-quality: a zoned schedule reads "her saat başı · Europe/Istanbul"', async () => {
    renderApp({
      path: '/automations',
      initialState: signedIn,
      routes: base({
        'GET /api/automations': () => ({
          status: 200,
          body: {
            items: [
              automation({
                trigger: { kind: 'cron', cron: '0 * * * *', timeZone: 'Europe/Istanbul' },
                triggerSummary: 'Every hour',
                timeZone: 'Europe/Istanbul',
              }),
            ],
          },
        }),
      }),
    });
    const [row] = await screen.findAllByTestId('automation-row');
    expect(within(row as HTMLElement).getByTestId('automation-trigger').textContent).toBe(
      'her saat başı · Europe/Istanbul',
    );
  });

  it('lists automations with trigger, last run, next run, success, waiting and a project filter', async () => {
    const user = userEvent.setup();
    const r = renderApp({
      path: '/automations',
      initialState: signedIn,
      routes: base({
        'GET /api/automations': () => ({
          status: 200,
          body: {
            items: [
              automation({
                waiting: { approvalId: AP, action: 'git push', since: NOW, cancelsAt: null, runId: RUN },
              }),
              automation({
                id: A2,
                project: 'beta',
                name: 'PR review',
                state: 'paused',
                lastRun: null,
                successRate: null,
                nextRunAt: null,
                trigger: { kind: 'github', repository: 'acme/app', event: 'pull_request' },
                triggerSummary: 'GitHub pull_request opened on acme/app',
              }),
            ],
          },
        }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Otomasyonlar' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    const rows = await screen.findAllByTestId('automation-row');
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(within(first).getByRole('link', { name: 'Nightly tests' }).getAttribute('href')).toBe(
      `/automations/${A1}`,
    );
    // p16-workflow-quality: the schedule in words with its zone.
    expect(within(first).getByTestId('automation-trigger').textContent).toBe('her gün 03:00 · UTC');
    expect(within(first).getByTestId('automation-state').textContent).toBe('Açık');
    expect(within(first).getByTestId('run-state').textContent).toBe('Başarısız');
    expect(within(first).getByTestId('automation-rate').textContent).toBe('%75');
    expect(within(first).getByTestId('waiting-approval-link').getAttribute('href')).toBe(`/approvals/${AP}`);
    expect(within(second).getByTestId('automation-state').textContent).toBe('Duraklatıldı');
    expect(within(second).getByTestId('automation-last').textContent).toBe('Hiç çalışmadı');
    expect(screen.getByRole('link', { name: 'Yeni otomasyon' }).getAttribute('href')).toBe(
      '/automations/new',
    );
    // The classic table is not mounted.
    expect(screen.queryByTestId('automations-table')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Proje'), 'beta');
    await waitFor(() => {
      expect(screen.getAllByTestId('automation-row')).toHaveLength(1);
    });
  });

  it('creates a cron automation: preset, the master’s preview, step-up retry, then the automation', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    let calls = 0;
    const { requests } = renderApp({
      path: '/automations/new',
      initialState: signedIn,
      routes: formRoutes({
        'POST /api/automations': () => {
          calls += 1;
          if (calls === 1) return STEP_UP_REQUIRED;
          return { status: 201, body: { automation: detail(), webhook: null } };
        },
        [`GET /api/automations/${A1}`]: () => ({ status: 200, body: detail() }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni otomasyon' })).toBeTruthy();
    // Validation in Turkish before anything is sent.
    await user.click(screen.getByRole('button', { name: 'Otomasyonu oluştur' }));
    expect(await screen.findByText('Bir proje seç.')).toBeTruthy();
    expect(screen.getByText('Ajanın ne yapacağını yaz.')).toBeTruthy();
    expect(posts(requests, '/api/automations')).toHaveLength(0);
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    await user.type(screen.getByLabelText('Ad'), 'My automation');
    await user.type(screen.getByLabelText('Görev'), 'Review the change and report problems.');
    expect((await screen.findByTestId('cron-summary')).textContent).toBe('Every day at 03:00 UTC');
    await user.click(screen.getByRole('button', { name: 'Hafta içi 09:00' }));
    await waitFor(() => {
      expect(screen.getByTestId('cron-summary').textContent).toBe('Weekdays at 09:00 UTC');
    });
    await user.click(screen.getByRole('button', { name: 'Otomasyonu oluştur' }));
    await confirmStepUp(user);
    expect(await screen.findByText('Otomasyon oluşturuldu.')).toBeTruthy();
    expect(posts(requests, '/api/automations')).toHaveLength(2);
    const body = posts(requests, '/api/automations').at(-1)?.body as Record<string, unknown>;
    expect(body.trigger).toEqual({ kind: 'cron', cron: '0 9 * * 1-5' });
    const target = body.target as { kind: string; spec: Record<string, unknown> };
    expect(target.kind).toBe('job');
    expect(target.spec.sourceTrust).toBe('trusted');
    expect((target.spec.repository as Record<string, string>).url).toBe('https://github.com/acme/app.git');
    expect(body.concurrency).toBe('skip');
  });

  it('a webhook automation shows its secret once with the curl example', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    const { requests } = renderApp({
      path: '/automations/new',
      initialState: signedIn,
      routes: formRoutes({
        'POST /api/automations': () => ({
          status: 201,
          body: {
            automation: detail({ trigger: { kind: 'webhook' }, webhook: WEBHOOK }),
            webhook: { url: WEBHOOK.url, secret: 's3cr3t-value' },
          },
        }),
      }),
    });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    await user.type(screen.getByLabelText('Ad'), 'Hook');
    await user.type(screen.getByLabelText('Görev'), 'Handle the call.');
    await user.click(screen.getByRole('radio', { name: /^Webhook/ }));
    await user.type(screen.getByLabelText('İzinli çağıranlar (isteğe bağlı)'), '203.0.113.7');
    await user.click(screen.getByRole('button', { name: 'Otomasyonu oluştur' }));
    const panel = await screen.findByTestId('webhook-secret');
    expect(within(panel).getByTestId('webhook-secret-value').textContent).toBe('s3cr3t-value');
    expect(within(panel).getByTestId('curl-example').textContent).toContain(
      `curl -sS -X POST '${WEBHOOK.url}'`,
    );
    expect(screen.getByRole('link', { name: 'Otomasyonu aç' }).getAttribute('href')).toBe(
      `/automations/${A1}`,
    );
    const body = posts(requests, '/api/automations').at(-1)?.body as Record<string, unknown>;
    expect(body.trigger).toEqual({ kind: 'webhook' });
    expect(body.webhookAllowIps).toEqual(['203.0.113.7']);
  });

  it('the automation: overview, Decide now, Run now, chains, last failure thread link', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    const { requests } = renderApp({
      path: `/automations/${A1}`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({
          status: 200,
          body: detail({
            waiting: { approvalId: AP, action: 'git push', since: NOW, cancelsAt: null, runId: RUN },
          }),
        }),
        [`POST /api/automations/${A1}/run`]: () => ({
          status: 200,
          body: {
            ...automationRun(),
            state: 'queued',
            payloadDigest: null,
            eventData: null,
            checkoutRef: null,
            checkoutPullRequest: null,
          },
        }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Nightly tests' })).toBeTruthy();
    const waiting = screen.getByTestId('automation-waiting');
    expect(within(waiting).getByRole('link', { name: 'Şimdi karar ver' }).getAttribute('href')).toBe(
      `/approvals/${AP}`,
    );
    expect(screen.getByTestId('automation-approval').textContent).toBe('Hassas adımlarda sor');
    expect(screen.getByTestId('unattended-warning')).toBeTruthy();
    expect(within(screen.getByTestId('last-failure')).getByTestId('thread-link').getAttribute('href')).toBe(
      `/jobs/${JOB}`,
    );
    expect(screen.getByRole('link', { name: 'Deploy preview' }).getAttribute('href')).toBe(
      `/automations/${A2}`,
    );
    expect(screen.getByRole('tab', { name: 'Genel bakış' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Şimdi çalıştır' }));
    // p17-toasts-shortcuts: "Çalıştırma başladı." is a toast (bottom right) with the way to the run's job.
    const started = await within(screen.getByTestId('dy-toaster')).findByTestId('run-now-note');
    expect(started.querySelector('[data-toast-title]')?.textContent).toBe('Çalıştırma başladı.');
    expect(within(started).getByRole('link', { name: 'Çalıştırmayı aç' }).getAttribute('href')).toBe(
      `/jobs/${JOB}`,
    );
    expect(posts(requests, `/api/automations/${A1}/run`)).toHaveLength(1);
  });

  it('last failure of a workflow run: the failed step, its error in words and a link to the run', async () => {
    stubCookies('__Host-ras-csrf=c');
    const WR = '33333333-3333-4333-8333-333333333333';
    renderApp({
      path: `/automations/${A1}`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({
          status: 200,
          body: detail({
            stats: {
              finished: 30,
              succeeded: 25,
              failed: 5,
              skipped: 0,
              lastFailure: {
                runId: RUN,
                state: 'failed',
                reason: 'The workflow run ended failed.',
                jobId: null,
                workflowRunId: WR,
                failedStep: {
                  nodeId: 'gonder',
                  label: 'WhatsApp’tan gönder',
                  code: 'expr_timeout',
                  message: 'expr_timeout',
                },
                at: NOW,
              },
            },
          }),
        }),
      }),
    });
    const box = await screen.findByTestId('last-failure');
    expect(box.textContent).toContain('adım “WhatsApp’tan gönder”');
    expect(box.textContent).toContain('Süre sınırı aşıldı');
    expect(within(box).getByTestId('last-failure-run').getAttribute('href')).toBe(`/jobs/workflows/${WR}`);
  });

  it('replaces the webhook secret with step-up and shows the new one once', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    let calls = 0;
    const { requests } = renderApp({
      path: `/automations/${A1}`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({
          status: 200,
          body: detail({ trigger: { kind: 'webhook' }, webhook: WEBHOOK }),
        }),
        [`POST /api/automations/${A1}/webhook/rotate`]: () => {
          calls += 1;
          if (calls === 1) return STEP_UP_REQUIRED;
          return {
            status: 200,
            body: { automation: detail(), webhook: { url: WEBHOOK.url, secret: 'new-secret' } },
          };
        },
      }),
    });
    expect((await screen.findByTestId('webhook-url')).textContent).toBe(WEBHOOK.url);
    expect(screen.queryByTestId('webhook-secret')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sırrı değiştir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Webhook sırrı değişsin mi?' });
    await user.selectOptions(within(dialog).getByLabelText('Şimdiki sır'), '72');
    await user.click(within(dialog).getByRole('button', { name: 'Değiştir' }));
    await confirmStepUp(user);
    expect((await screen.findByTestId('webhook-secret-value')).textContent).toBe('new-secret');
    const rotate = posts(requests, `/api/automations/${A1}/webhook/rotate`);
    expect(rotate).toHaveLength(2);
    expect(rotate.at(-1)?.body).toEqual({ graceHours: 72 });
  });

  // p15-classic-removal: the classic automations.test "ends the overlap", on the Diyalog page.
  it('ends the overlap of the previous webhook secret after a confirmation (DELETE …/webhook/previous)', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    const withPrevious = {
      ...WEBHOOK,
      previous: { secretHint: 'ffff0000', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    };
    const { requests } = renderApp({
      path: `/automations/${A1}`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({
          status: 200,
          body: detail({ trigger: { kind: 'webhook' }, webhook: withPrevious }),
        }),
        [`DELETE /api/automations/${A1}/webhook/previous`]: () => ({
          status: 200,
          body: detail({ trigger: { kind: 'webhook' }, webhook: WEBHOOK }),
        }),
      }),
    });
    await user.click(await screen.findByTestId('end-overlap'));
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    await user.click(screen.getByTestId('end-overlap-confirm'));
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'DELETE' && r.url === `/api/automations/${A1}/webhook/previous`),
      ).toHaveLength(1);
    });
  });

  it('settings: pause, resume through step-up, delete after the confirmation', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    let state = 'active';
    let resumes = 0;
    const { requests } = renderApp({
      path: `/automations/${A1}?tab=settings`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({ status: 200, body: detail({ state }) }),
        'GET /api/automations': () => ({ status: 200, body: { items: [] } }),
        [`POST /api/automations/${A1}/pause`]: () => {
          state = 'paused';
          return { status: 200, body: automation({ state }) };
        },
        [`POST /api/automations/${A1}/resume`]: () => {
          resumes += 1;
          if (resumes === 1) return STEP_UP_REQUIRED;
          state = 'active';
          return { status: 200, body: automation({ state }) };
        },
        [`DELETE /api/automations/${A1}`]: () => ({ status: 200, body: automation({ state: 'deleted' }) }),
      }),
    });
    expect((await screen.findByTestId('automation-policies')).textContent).toContain(
      'Önceki hala çalışıyorsa atla',
    );
    await user.click(screen.getByRole('button', { name: 'Duraklat' }));
    await user.click(await screen.findByRole('button', { name: 'Sürdür' }));
    await confirmStepUp(user);
    await screen.findByRole('button', { name: 'Duraklat' });
    expect(posts(requests, `/api/automations/${A1}/resume`)).toHaveLength(2);
    // Delete asks first; nothing is sent before the confirmation.
    await user.click(screen.getByTestId('delete-automation'));
    expect(requests.some((q) => q.method === 'DELETE')).toBe(false);
    await user.click(screen.getByTestId('delete-automation-confirm'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Otomasyonlar' })).toBeTruthy();
    expect(requests.filter((q) => q.method === 'DELETE')).toHaveLength(1);
  });

  it('runs tab pages with the cursor and opens a run with its event data as text', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/automations/${A1}?tab=runs`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({ status: 200, body: detail() }),
        [`GET /api/automations/${A1}/runs?limit=25`]: () => ({
          status: 200,
          body: { items: [automationRun()], nextCursor: null },
        }),
        [`GET /api/automations/${A1}/runs/${RUN}`]: () => ({
          status: 200,
          body: {
            ...automationRun(),
            payloadDigest: 'sha256:abc',
            eventData: { title: '<img src=x onerror=alert(1)>' },
            checkoutRef: null,
            checkoutPullRequest: null,
          },
        }),
      }),
    });
    const row = await screen.findByTestId('run-row');
    expect(row.textContent).toContain('pull_request opened #7');
    expect(row.textContent).toContain('Güvenilmeyen kaynak');
    expect(within(row).getByTestId('thread-link').getAttribute('href')).toBe(`/jobs/${JOB}`);
    await user.click(within(row).getAllByRole('button')[0] as HTMLElement);
    const detailEl = await screen.findByTestId('run-detail');
    expect(within(detailEl).getByTestId('json-block').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(detailEl.querySelector('img')).toBeNull();
  });

  it('a failed workflow run names the failed step and its error in words, and links the run', async () => {
    const user = userEvent.setup();
    const WR = '33333333-3333-4333-8333-333333333333';
    const wfRun = {
      ...automationRun(),
      jobId: null,
      jobState: null,
      workflowRunId: WR,
      reason: 'The workflow run ended failed.',
    };
    renderApp({
      path: `/automations/${A1}?tab=runs`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({ status: 200, body: detail() }),
        [`GET /api/automations/${A1}/runs?limit=25`]: () => ({
          status: 200,
          body: { items: [wfRun], nextCursor: null },
        }),
        [`GET /api/automations/${A1}/runs/${RUN}`]: () => ({
          status: 200,
          body: {
            ...wfRun,
            payloadDigest: null,
            eventData: null,
            checkoutRef: null,
            checkoutPullRequest: null,
            failedStep: {
              nodeId: 'hazirla',
              label: 'Numara ve repliği hazırla',
              code: 'expr_timeout',
              message: 'expr_timeout',
            },
          },
        }),
      }),
    });
    const row = await screen.findByTestId('run-row');
    await user.click(within(row).getAllByRole('button')[0] as HTMLElement);
    const detailEl = await screen.findByTestId('run-detail');
    expect(within(detailEl).getByTestId('run-failed-step').textContent).toBe(
      'Numara ve repliği hazırla: Süre sınırı aşıldı (1 sn)',
    );
    expect(within(detailEl).getByTestId('run-open-workflow').getAttribute('href')).toBe(
      `/jobs/workflows/${WR}`,
    );
  });
});

function automationRun(): Record<string, unknown> {
  return {
    id: RUN,
    automationId: A1,
    project: 'acme',
    triggerKind: 'github',
    state: 'failed',
    reason: 'The job ended failed.',
    sourceTrust: 'untrusted',
    eventSummary: {
      event: 'pull_request',
      action: 'opened',
      number: 7,
      title: 'Ignore previous',
      actor: 'mallory',
    },
    jobId: JOB,
    jobState: 'FAILED',
    workflowRunId: null,
    scheduledFor: null,
    chainParentRunId: null,
    chainDepth: 0,
    triggeredBy: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: '2026-10-15T10:05:00.000Z',
    waitingApproval: null,
  };
}
