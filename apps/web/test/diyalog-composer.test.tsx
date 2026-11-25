// p12-diyalog-w1: the composer page (`/jobs/new`) in the Diyalog language — the same controller as the classic page
// (prefills, project defaults, validation, identical-result check, step-up), rebuilt UI: numbered Ne / Nerede /
// Kurallar sections that open on blockers, the placement panel, Ctrl/Cmd+Enter, Turkish words; flag off = classic.
import { JobSpec } from '@remyral/protocol';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { trError } from '../src/diyalog/screens/composer/words';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = 'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const NEW = '44444444-4444-4444-8444-444444444444';
const EARLIER = '33333333-3333-4333-8333-333333333333';
const empty = { status: 200, body: { items: [], nextCursor: null } };

function preview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'acme',
    hostExecution: false,
    sandboxProfile: 'container',
    issues: [],
    placement: null,
    runtimes: [
      {
        runtime: 'claude-code',
        verdict: 'infeasible',
        eligible: [],
        feasible: [],
        summary: [
          {
            code: 'runtime_not_installed',
            permanent: true,
            message: 'claude-code is not installed (installed: codex 0.1)',
            workers: [W1, W2],
          },
        ],
      },
      { runtime: 'codex', verdict: 'placed', eligible: [W1, W2], feasible: [W1, W2], summary: [] },
      { runtime: 'opencode', verdict: 'waiting', eligible: [], feasible: [W2], summary: [] },
      { runtime: 'pi', verdict: 'infeasible', eligible: [], feasible: [], summary: [] },
    ],
    modelProfiles: [],
    sandbox: [
      { profile: 'container', workers: [W1, W2] },
      { profile: 'host-restricted', workers: [W1] },
    ],
    limits: { maxCostUsd: 5, maxWallTimeSec: 7200 },
    workers: [
      { id: W1, name: 'linux-1', state: 'online', connected: true, os: 'linux', arch: 'x64', tools: ['git'] },
      { id: W2, name: 'mac-1', state: 'offline', connected: false, os: 'darwin', arch: 'arm64', tools: [] },
    ],
    ...over,
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'Acme',
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: null,
            members: 2,
            myRole: 'operator',
          },
          {
            id: 'ro',
            name: 'Read only',
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: null,
            members: 2,
            myRole: 'viewer',
          },
        ],
      },
    }),
    'GET /api/projects/acme/git': () => ({
      status: 200,
      body: {
        config: {
          project: 'acme',
          version: 1,
          provider: 'github',
          repositoryUrl: 'https://github.com/acme/app.git',
          baseBranch: 'main',
          mergeMethod: 'squash',
          requireCi: true,
          ciTimeoutSec: 600,
          github: null,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }),
    'GET /api/budgets': () => ({ status: 200, body: { items: [] } }),
    'POST /api/jobs/placement-preview': (req) => {
      const b = req.body as { runtime?: string };
      if (b.runtime === undefined) return { status: 200, body: preview() };
      return {
        status: 200,
        body: preview({
          placement: {
            runtime: b.runtime,
            verdict: 'placed',
            holds: [],
            candidates: [{ workerId: W1, score: 0.9, breakdown: {} }],
            rejected: [
              {
                workerId: W2,
                reasons: [{ code: 'offline', permanent: false, message: 'worker is offline' }],
              },
            ],
            summary: [],
          },
        }),
      };
    },
    'POST /api/jobs': () => ({
      status: 201,
      body: { job: { id: NEW, project: 'acme', state: 'QUEUED', version: 2, priority: 0 } },
    }),
    [`GET /api/jobs/${NEW}`]: () => ({ status: 404, body: { error: 'job_not_found', message: 'x' } }),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog composer (p12-diyalog-w1)', { timeout: 30_000 }, () => {
  it('composes a job in Ne / Nerede / Kurallar from the project defaults; placement beside; Ctrl+Enter submits', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/jobs/new', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni iş' })).toBeTruthy();
    expect(screen.getByTestId('dy-composer')).toBeTruthy();
    // Only operator projects; submitting without one says what is missing, in Turkish.
    const select = await screen.findByLabelText('Proje');
    expect(within(select).queryByText(/Read only/)).toBeNull();
    await user.click(screen.getByTestId('composer-submit'));
    expect(await screen.findByText('Bir proje seç.')).toBeTruthy();
    expect(screen.getByTestId('composer-status').textContent).toContain('proje');
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(false);
    await user.selectOptions(select, 'acme');
    // Repository from the project; its own repository defaults to trusted.
    expect(await screen.findByDisplayValue('https://github.com/acme/app.git')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(/^Güvenilir/).checked).toBe(true);
    });
    // Nerede starts as one line with the runtime a machine can run now.
    await waitFor(() => {
      expect(screen.getByTestId('where-summary').textContent).toBe(
        'Codex · kendi modeli · Konteyner, herhangi bir makinede',
      );
    });
    expect(screen.getByTestId('composer-section-where').getAttribute('data-open')).toBe('false');
    await user.click(screen.getByTestId('composer-toggle-where'));
    // Readiness with the reason in plain words; unavailable runtimes are disabled.
    expect(screen.getByTestId('runtime-reason-claude-code').textContent).toContain(
      'Claude Code bu makinede kurulu değil.',
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Claude Code/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^Codex/ }).checked).toBe(true);
    // The placement panel: verdict, first choice and why the other machine is out.
    const panel = await screen.findByTestId('placement-panel');
    await waitFor(() => {
      expect(within(panel).getByTestId('placement-verdict').getAttribute('data-verdict')).toBe('placed');
    });
    expect(within(panel).getByText('Hemen başlar')).toBeTruthy();
    expect(within(panel).getAllByTestId('placement-candidate')[0]?.textContent).toContain(
      'İlk tercih: linux-1',
    );
    expect(within(panel).getAllByTestId('placement-rejected')[0]?.textContent).toContain('mac-1');
    // Kurallar: limits from the project's run limits, Turkish summary.
    await waitFor(() => {
      expect(screen.getByTestId('rules-summary').textContent).toBe(
        'Hassas adımlarda sor · 60 dk · en çok $5 · hemen başlar',
      );
    });
    await user.click(screen.getByTestId('composer-toggle-rules'));
    expect(screen.getByTestId('project-limits').textContent).toContain('maliyet 5 USD');
    expect(screen.getByLabelText<HTMLInputElement>('En yüksek maliyet (USD)').value).toBe('5');
    // The task is the one thing left: its field gets focus; Ctrl+Enter submits.
    await user.click(screen.getByTestId('composer-submit'));
    expect(await screen.findByText('Ajanın ne yapacağını yaz.')).toBeTruthy();
    expect(screen.getByTestId('composer-status').textContent).toBe('Eksik: görev.');
    const task = screen.getByLabelText('Ajanın görevi');
    await waitFor(() => {
      expect(document.activeElement).toBe(task);
    });
    await user.type(task, 'Fix the flaky test');
    expect(screen.getByTestId('dy-composer-bytes').textContent).toContain('18 /');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(true);
    });
    const sent = requests.find((r) => r.method === 'POST' && r.url === '/api/jobs')?.body as {
      project: string;
      spec: unknown;
    };
    expect(sent.project).toBe('acme');
    expect(JobSpec.safeParse(sent.spec).success).toBe(true);
    expect(sent.spec).toMatchObject({
      runtime: 'codex',
      sourceTrust: 'trusted',
      sandboxProfile: 'container',
      prompt: 'Fix the flaky test',
      limits: { maxDurationSec: 3600, maxCostUsd: 5 },
    });
    // Navigates to the new job.
    await waitFor(() => {
      expect(requests.some((r) => r.url === `/api/jobs/${NEW}`)).toBe(true);
    });
  });

  it('p12-diyalog-final: Cmd+Enter (macOS) submits from anywhere on the page, like Ctrl+Enter', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/jobs/new', initialState: signedIn, routes: routes() });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    expect(await screen.findByDisplayValue('https://github.com/acme/app.git')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('where-summary').textContent).toContain('Codex');
    });
    const task = screen.getByLabelText('Ajanın görevi');
    await user.type(task, 'Fix the flaky test');
    // Plain Enter in the task adds a line; it never submits.
    await user.keyboard('{Enter}');
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(false);
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(true);
    });
  });

  it('Nerede opens by itself and cannot be collapsed while no runtime can run the job; Enter never submits', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const none = (preview().runtimes as { runtime: string }[]).map((r) => ({
      runtime: r.runtime,
      verdict: 'infeasible',
      eligible: [],
      feasible: [],
      summary: [
        {
          code: 'sandbox_profile_unavailable',
          permanent: true,
          message: 'sandbox profile container is not ready',
          workers: [W1],
        },
      ],
    }));
    const { requests } = renderApp({
      path: '/jobs/new?project=acme',
      initialState: signedIn,
      routes: routes({
        'POST /api/jobs/placement-preview': () => ({ status: 200, body: preview({ runtimes: none }) }),
      }),
    });
    const where = await screen.findByTestId('composer-section-where');
    await waitFor(() => {
      expect(where.getAttribute('data-open')).toBe('true');
    });
    expect(within(where).getByText('düzeltilecek alan var')).toBeTruthy();
    expect(within(where).queryByTestId('composer-toggle-where')).toBeNull();
    // The fix links the machine's sandbox.
    const fix = within(screen.getByTestId('runtime-fix-codex')).getByRole('link', {
      name: 'Sandbox’ı hazırla',
    });
    expect(fix.getAttribute('href')).toBe(`/machines?worker=${W1}&section=sandbox`);
    await user.type(await screen.findByLabelText('Temel dal'), '{Enter}');
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(false);
  });

  it('prefills from a finished job (?from=) and keeps its own settings; a fresh work branch', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const OLD = '66666666-6666-4666-8666-666666666666';
    renderApp({
      path: `/jobs/new?from=${OLD}`,
      initialState: signedIn,
      routes: routes({
        [`GET /api/jobs/${OLD}`]: () => ({
          status: 200,
          body: {
            job: {
              id: OLD,
              project: 'acme',
              state: 'FAILED',
              version: 5,
              leaseEpoch: 1,
              createdBy: { type: 'user', id: USER.id },
              createdAt: '2026-10-14T09:00:00.000Z',
              stateChangedAt: '2026-10-14T09:30:00.000Z',
              spec: {
                runtime: 'codex',
                prompt: 'Fix the flaky login test',
                repository: {
                  url: 'https://github.com/acme/fork.git',
                  baseRef: 'develop',
                  workBranch: 'agent/old',
                },
                sandboxProfile: 'container',
                approvalPolicy: 'deny-sensitive',
                sourceTrust: 'untrusted',
                limits: { maxDurationSec: 1200, maxTurns: 40 },
              },
            },
            transitions: [],
            attempts: [],
            leases: [],
            approvals: [],
            dependsOn: [],
            dependents: [],
          },
        }),
      }),
    });
    expect((await screen.findByTestId('composer-prefill')).textContent).toContain(
      '66666666… işinden dolduruldu',
    );
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Proje').value).toBe('acme');
    });
    expect(screen.getByLabelText<HTMLInputElement>('Depo adresi').value).toBe(
      'https://github.com/acme/fork.git',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Temel dal').value).toBe('develop');
    await user.click(screen.getByText('Çalışma dalı', { selector: 'summary' }));
    expect(screen.getByLabelText<HTMLInputElement>('Çalışma dalı').value).not.toBe('agent/old');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Ajanın görevi').value).toBe(
      'Fix the flaky login test',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/^Güvenilmeyen/).checked).toBe(true);
    expect(screen.getByTestId('rules-summary').textContent).toBe(
      'Hassas adımları reddet · 20 dk · 40 tur · hemen başlar',
    );
  });

  it('prefills from router state (a template run) and from ?project= / ?continueFrom=', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const f = fakeFetch(routes());
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/jobs/new',
            state: {
              prefill: {
                project: 'acme',
                spec: { runtime: 'codex', prompt: 'Audit {{url}}', approvalPolicy: 'ask-all' },
                template: { id: '77777777-7777-4777-8777-777777777777', version: 3, title: 'SEO denetimi' },
              },
            },
          },
        ]}
      >
        <AuthProvider initialState={signedIn}>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('composer-prefill')).textContent).toContain(
      '“SEO denetimi” şablonunun v3 sürümünden dolduruldu',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Ajanın görevi').value).toBe('Audit {{url}}');
  });

  it('offers an identical recent success before submitting; Sonucu aç links it, Yine de çalıştır submits', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/jobs/new?project=acme',
      initialState: signedIn,
      routes: routes({
        'POST /api/jobs/reuse-check': () => ({
          status: 200,
          body: {
            match: {
              jobId: EARLIER,
              finishedAt: '2026-10-16T08:00:00.000Z',
              age: '2 h ago',
              runtime: 'codex',
              modelProfile: null,
              baseCommit: 'a'.repeat(40),
            },
            reason: null,
            windowHours: 72,
          },
        }),
      }),
    });
    expect(await screen.findByDisplayValue('https://github.com/acme/app.git')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('where-summary').textContent).toContain('Codex');
    });
    await user.type(screen.getByLabelText('Ajanın görevi'), 'Fix the flaky test');
    await user.click(screen.getByTestId('composer-submit'));
    const offer = await screen.findByTestId('composer-identical');
    expect(offer.textContent).toContain('Aynı iş 2 h ago başarıyla bitti.');
    expect(offer.textContent).toContain(`aynı temel commit (${'a'.repeat(12)})`);
    expect(within(offer).getByRole('link', { name: 'Sonucu aç' }).getAttribute('href')).toBe(
      `/jobs/${EARLIER}`,
    );
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(false);
    await user.click(within(offer).getByRole('button', { name: 'Yine de çalıştır' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(true);
    });
    expect(requests.filter((r) => r.url === '/api/jobs/reuse-check')).toHaveLength(1);
  });

  // p15-classic-removal: the classic workspace.test "starts a workflow run", on the Diyalog composer.
  it('starts a workflow run now with its inputs (POST /workflows/:id/runs)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const WF = '22222222-2222-4222-8222-222222222222';
    const RUN = '44444444-4444-4444-8444-444444444444';
    const { requests } = renderApp({
      path: '/jobs/new',
      initialState: signedIn,
      routes: routes({
        'GET /api/workflows': () => ({
          status: 200,
          body: {
            definitions: [
              {
                id: WF,
                project: 'acme',
                name: 'fanout',
                version: 3,
                nodes: 2,
                createdAt: '2026-10-01T00:00:00.000Z',
              },
            ],
            runs: [],
          },
        }),
        [`GET /api/workflows/${WF}`]: () => ({
          status: 200,
          body: {
            id: WF,
            project: 'acme',
            name: 'fanout',
            version: 3,
            description: 'Plan and build.',
            inputs: [{ name: 'task', required: true, description: 'What to build' }],
            nodes: [{ id: 'plan', role: 'planner', runtime: 'codex', gate: false, dynamic: true }],
            edges: [],
            defaults: {
              runtime: 'codex',
              sandboxProfile: 'container',
              approvalPolicy: 'ask-sensitive',
              limits: {},
              repository: { url: 'https://github.com/acme/app.git', baseRef: 'main' },
            },
          },
        }),
        [`POST /api/workflows/${WF}/runs`]: () => ({ status: 201, body: { runId: RUN } }),
      }),
    });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    await user.click(screen.getByRole('radio', { name: /Bir iş akışı/ }));
    await user.selectOptions(await screen.findByLabelText('İş akışı'), WF);
    await user.type(await screen.findByLabelText('task (gerekli)'), 'Add dark mode');
    await user.click(screen.getByRole('button', { name: 'Çalıştırmayı başlat' }));
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'POST' && r.url === `/api/workflows/${WF}/runs`),
      ).toHaveLength(1);
    });
    expect(
      requests.find((r) => r.method === 'POST' && r.url === `/api/workflows/${WF}/runs`)?.body,
    ).toMatchObject({ inputs: { task: 'Add dark mode' } });
  });

  it('schedules a workflow run on a cron after step-up (code → retried), with its steps and required inputs', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepUp = false;
    const WF = '22222222-2222-4222-8222-222222222222';
    const { requests } = renderApp({
      path: '/jobs/new',
      initialState: signedIn,
      routes: routes({
        'GET /api/workflows': () => ({
          status: 200,
          body: {
            definitions: [
              {
                id: WF,
                project: 'acme',
                name: 'fanout',
                version: 3,
                nodes: 2,
                createdAt: '2026-10-01T00:00:00.000Z',
              },
            ],
            runs: [],
          },
        }),
        [`GET /api/workflows/${WF}`]: () => ({
          status: 200,
          body: {
            id: WF,
            project: 'acme',
            name: 'fanout',
            version: 3,
            description: 'Plan and build.',
            inputs: [{ name: 'task', required: true, description: 'What to build' }],
            nodes: [
              { id: 'plan', role: 'planner', runtime: 'codex', gate: false, dynamic: true },
              { id: 'check', role: 'verifier', runtime: 'codex', gate: true, dynamic: false },
            ],
            edges: [{ from: 'plan', to: 'check' }],
            defaults: {
              runtime: 'codex',
              sandboxProfile: 'container',
              approvalPolicy: 'ask-sensitive',
              limits: {},
              repository: { url: 'https://github.com/acme/app.git', baseRef: 'main' },
            },
          },
        }),
        'GET /api/schedules/cron-preview?cron=0%203%20*%20*%201-5': () => ({
          status: 200,
          body: { cron: '0 3 * * 1-5', nextRuns: ['2026-10-14T03:00:00.000Z', '2026-10-15T03:00:00.000Z'] },
        }),
        'POST /api/schedules': () =>
          stepUp
            ? {
                status: 201,
                body: {
                  id: '33333333-3333-4333-8333-333333333333',
                  automationId: '55555555-5555-4555-8555-555555555555',
                  project: 'acme',
                  name: 'Nightly fanout',
                  target: { kind: 'workflow', runtime: null, workflowId: WF },
                  when: { kind: 'cron', cron: '0 3 * * 1-5' },
                  state: 'active',
                  nextRunAt: '2026-10-14T03:00:00.000Z',
                  lastRunAt: null,
                  lastStatus: null,
                  lastJobId: null,
                  lastRunId: null,
                  lastError: null,
                  runCount: 0,
                  createdBy: USER.id,
                  createdAt: '2026-10-13T10:00:00.000Z',
                },
              }
            : {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
              },
        'POST /api/auth/step-up': () => {
          stepUp = true;
          return { status: 200, body: { stepUpValidUntil: '2026-10-13T10:10:00.000Z' } };
        },
      }),
    });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    await user.click(screen.getByRole('radio', { name: /Bir iş akışı/ }));
    // A workflow brings its own runtime and sandbox: no Nerede section, no placement panel.
    expect(screen.queryByTestId('composer-section-where')).toBeNull();
    expect(screen.queryByTestId('placement-panel')).toBeNull();
    await user.selectOptions(await screen.findByLabelText('İş akışı'), WF);
    const steps = await screen.findByTestId('workflow-preview');
    expect(within(steps).getByText('onay kapısı')).toBeTruthy();
    expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Çalıştırmayı başlat' }));
    expect(await screen.findByText('Gerekli.')).toBeTruthy();
    expect(screen.getByTestId('composer-status').textContent).toContain('iş akışı girdileri');
    await user.type(screen.getByLabelText('task (gerekli)'), 'Add dark mode');
    expect(screen.getByTestId('rules-summary').textContent).toBe('Hemen başlar');
    await user.click(screen.getByTestId('composer-toggle-rules'));
    await user.click(screen.getByRole('radio', { name: /Tekrarla/ }));
    await user.type(screen.getByLabelText('Zamanlama adı'), 'Nightly fanout');
    expect((await screen.findByTestId('cron-runs')).textContent).toContain('Sonraki çalışmalar');
    await user.click(screen.getByRole('button', { name: 'Zamanlamayı oluştur' }));
    await user.type(await screen.findByLabelText('6 haneli kod'), '123456');
    await user.click(screen.getByRole('button', { name: 'Onayla' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/schedules')).toHaveLength(2);
    });
    expect(requests.filter((r) => r.method === 'POST' && r.url === '/api/schedules').at(-1)?.body).toEqual({
      project: 'acme',
      name: 'Nightly fanout',
      target: { kind: 'workflow', workflowId: WF, inputs: { task: 'Add dark mode' } },
      when: { kind: 'cron', cron: '0 3 * * 1-5' },
    });
  });
});

describe('composer words (p12-diyalog-w1)', () => {
  it('translates the classic validation messages; unknown ones stay as they are', () => {
    expect(trError('Choose a project.')).toBe('Bir proje seç.');
    expect(trError('Max turns must be a whole number.')).toBe('En çok tur bir tam sayı olmalı.');
    expect(trError('Max duration must be at most 10080.')).toBe('En uzun süre en çok 10080 olabilir.');
    expect(trError('A brand new rule.')).toBe('A brand new rule.');
  });
});
