// p14-workflow-engine 14.2: the editor's "Tetikleyiciler" (activation through step-up, the webhook secret once, status
// per trigger, out-of-date nodes), saving a privileged version through step-up, the run view's trigger facts, side
// effects with their links and the manual resume of a webhook wait, and bound automations in Otomasyonlar. In
// Turkish and in English.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthState } from '../src/auth/AuthProvider';
import type { SessionInfo } from '../src/api/auth';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { CATALOG } from './workflow-catalog-fixture';

configure({ asyncUtilTimeout: 5_000 });

const WF = 'aaaaaaaa-1111-4111-8111-111111111111';
const RUN = 'dddddddd-4444-4444-8444-444444444444';
const AUTO = 'bbbbbbbb-2222-4222-8222-222222222222';
const JOB = 'cccccccc-3333-4333-8333-333333333333';
const empty = { status: 200, body: { items: [], nextCursor: null } };
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const STEP_UP_REQUIRED = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

type Locale = 'tr' | 'en';

function session(locale: Locale): SessionInfo {
  return {
    user: USER,
    createdAt: iso(1e6),
    expiresAt: iso(-1e6),
    idleExpiresAt: iso(-1e5),
    mfaAt: iso(1e6),
    stepUpValidUntil: null,
    stepUpScope: 'window',
    alwaysFreshValidUntil: null,
    type: 'standard',
    locale,
    features: { workflowEngineV2: true },
  };
}
const state = (locale: Locale): AuthState => ({
  kind: 'signedIn',
  user: USER,
  session: session(locale),
  remainingRecoveryCodes: null,
});

function fakeApi(locale: Locale): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: () => Promise.resolve({ stepUpValidUntil: '2099-01-01T00:00:00.000Z', stepUpScope: 'window' }),
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.resolve(session(locale)),
  } as unknown as AuthApi;
}

const triggerType = (type: string) => ({
  type,
  category: 'trigger',
  placement: 'trigger',
  phase: '14.2',
  icon: 'webhook',
  group: false,
  sideEffect: false,
  requires: 'workflows.define',
  untrustedOutput: true,
  testable: false,
  fields: {},
  config: { type: 'object', properties: {}, additionalProperties: false },
  ports: [{ name: 'out', direction: 'out' }],
});
const catalog = {
  ...CATALOG,
  executable: [...CATALOG.executable, 'trigger.webhook', 'trigger.schedule'],
  types: [...CATALOG.types, triggerType('trigger.webhook'), triggerType('trigger.schedule')],
};

const DEFINITION = {
  schemaVersion: 2,
  name: 'hooked',
  inputs: {},
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
  nodes: [
    { id: 'hook', type: 'trigger.webhook', config: {} },
    { id: 'nightly', type: 'trigger.schedule', config: { cron: '0 3 * * *' } },
    { id: 'set', type: 'data.set', config: { fields: { a: 1 } } },
  ],
  edges: [{ from: 'hook', to: 'set' }],
  layout: { positions: { hook: { x: 0, y: 0 }, nightly: { x: 0, y: 120 }, set: { x: 300, y: 0 } } },
};

function routes(locale: Locale, over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), locale, features: { workflowEngineV2: true } },
    }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: '2099-01-01T00:00:00.000Z' } }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'acme',
            kind: 'repository',
            createdAt: iso(1e9),
            createdBy: null,
            members: 2,
            myRole: 'admin',
          },
        ],
      },
    }),
    'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
    'GET /api/workflows/catalog': () => ({ status: 200, body: catalog }),
    [`GET /api/workflows/${WF}/definition`]: () => ({
      status: 200,
      body: {
        id: WF,
        project: 'acme',
        name: 'hooked',
        version: 1,
        latestVersion: 1,
        latestId: WF,
        archived: false,
        createdBy: 'ayse',
        createdAt: iso(3_600_000),
        hash: 'h1',
        promptsHidden: false,
        definition: DEFINITION,
      },
    }),
    ...over,
  };
}

const activation = (over: Record<string, unknown> = {}) => ({
  workflowId: WF,
  project: 'acme',
  name: 'hooked',
  latestVersion: 1,
  enabled: false,
  pinnedVersion: null,
  needsExternal: true,
  triggers: [
    {
      nodeId: 'hook',
      type: 'trigger.webhook',
      binding: 'automation',
      status: 'inactive',
      automationId: null,
      automationState: null,
      upToDate: true,
      webhookUrl: null,
      lastRun: null,
    },
    {
      nodeId: 'nightly',
      type: 'trigger.schedule',
      binding: 'automation',
      status: 'inactive',
      automationId: null,
      automationState: null,
      upToDate: true,
      webhookUrl: null,
      lastRun: null,
    },
  ],
  orphans: [],
  webhookSecrets: [],
  ...over,
});

const WORDS = {
  tr: {
    open: 'Tetikleyiciler',
    enable: 'Etkinleştir',
    inactive: 'Etkin değil',
    active: 'Etkin',
    secretOnce: 'Bu anahtar yalnızca şimdi gösterilir; güvenli bir yere kopyala.',
    enabled: 'Tetikleyiciler etkinleştirildi.',
    stale: 'Bu tetikleyici son etkinleştirmeden sonra değişti; uygulamak için yeniden etkinleştir.',
    started: 'Tetikleyen: webhook',
    untrusted: 'Güvenilmeyen kaynak',
    sideEffects: 'Yan etkiler',
    done: 'Tamam',
    openJob: 'İşi aç',
    waiting: 'Webhook bekliyor',
    resume: 'Elle devam ettir',
    resumeConfirm: 'Devam ettir',
    bound: 'Workflow’a bağlı',
    canvas: 'Kanvasta düzenle',
  },
  en: {
    open: 'Triggers',
    enable: 'Activate',
    inactive: 'Not active',
    active: 'Active',
    secretOnce: 'This secret is shown only now; copy it somewhere safe.',
    enabled: 'Triggers activated.',
    stale: 'This trigger changed since the last activation; activate again to apply it.',
    started: 'Started by: webhook call',
    untrusted: 'Untrusted source',
    sideEffects: 'Side effects',
    done: 'Done',
    openJob: 'Open the job',
    waiting: 'Waiting for a webhook',
    resume: 'Resume by hand',
    resumeConfirm: 'Resume',
    bound: 'Bound to a workflow',
    canvas: 'Edit on the canvas',
  },
} as const;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialogs = await screen.findAllByRole('dialog');
  const dialog = dialogs.at(-1) as HTMLElement;
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

describe('trigger activation in the editor (p14-workflow-engine 14.2)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: Tetikleyiciler → Etkinleştir through step-up; the webhook secret once; status per trigger',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      let puts = 0;
      const r = renderApp({
        path: `/workflows/${WF}`,
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {
          [`GET /api/workflows/${WF}/activation`]: () => ({
            status: 200,
            body: activation({
              triggers: activation().triggers.map((t, i) => (i === 1 ? { ...t, upToDate: false } : t)),
            }),
          }),
          [`PUT /api/workflows/${WF}/activation`]: () => {
            puts += 1;
            if (puts === 1) return STEP_UP_REQUIRED;
            return {
              status: 200,
              body: activation({
                enabled: true,
                triggers: activation().triggers.map((t) => ({
                  ...t,
                  status: 'active',
                  automationId: AUTO,
                  automationState: 'active',
                  webhookUrl: t.nodeId === 'hook' ? `https://remyral.example/v1/hooks/${AUTO}` : null,
                })),
                webhookSecrets: [{ nodeId: 'hook', secret: 'rwh_secret-shown-once' }],
              }),
            };
          },
        }),
      });
      const open = await screen.findByTestId('toolbar-activation');
      expect(open.textContent).toContain(w.open);
      await user.click(open);
      const dialog = await screen.findByTestId('workflow-activation');
      await waitFor(() => {
        expect(within(dialog).getAllByTestId('workflow-trigger')).toHaveLength(2);
      });
      expect(dialog.textContent).toContain(w.inactive);
      expect(within(dialog).getByTestId('workflow-trigger-stale').textContent).toBe(w.stale);
      await user.click(within(dialog).getByTestId('workflow-activate'));
      await confirmStepUp(user);
      await waitFor(() => {
        expect(within(dialog).getByTestId('workflow-activation-done').textContent).toBe(w.enabled);
      });
      expect(puts).toBe(2);
      const put = r.requests
        .filter((q) => q.method === 'PUT' && q.url === `/api/workflows/${WF}/activation`)
        .at(-1);
      expect(put?.body).toEqual({ enabled: true, pinnedVersion: null });
      const secret = within(dialog).getByTestId('workflow-secret');
      expect(secret.textContent).toContain('rwh_secret-shown-once');
      expect(secret.textContent).toContain(w.secretOnce);
      expect(dialog.textContent).toContain(w.active);
      expect(dialog.textContent).toContain(`https://remyral.example/v1/hooks/${AUTO}`);
    },
  );

  it('saving a version with privileged nodes asks for a step-up and retries', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    let calls = 0;
    const r = renderApp({
      path: `/workflows/${WF}`,
      initialState: state('tr'),
      api: fakeApi('tr'),
      routes: routes('tr', {
        [`PUT /api/workflows/${WF}`]: () => {
          calls += 1;
          return calls === 1
            ? STEP_UP_REQUIRED
            : {
                status: 200,
                body: { id: 'ffffffff-6666-4666-8666-666666666666', name: 'hooked', version: 2 },
              };
        },
        'GET /api/workflows/ffffffff-6666-4666-8666-666666666666/definition': () => ({
          status: 404,
          body: {},
        }),
      }),
    });
    await screen.findByTestId('toolbar-activation');
    // Any change makes the version dirty (the master decides whether it is privileged).
    await user.click(await screen.findByTestId('toolbar-settings'));
    const desc = await screen.findByLabelText(/Açıklama/);
    await user.type(desc, 'x');
    await user.click(screen.getByTestId('workflow-save'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(r.requests.filter((q) => q.method === 'PUT' && q.url === `/api/workflows/${WF}`)).toHaveLength(
        2,
      );
    });
  });
});

function runBody(): Record<string, unknown> {
  const node = (id: string, type: string, st: string, over: Record<string, unknown> = {}) => ({
    id,
    role: null,
    type,
    state: st,
    parent: null,
    jobId: null,
    jobState: null,
    workerId: null,
    attempts: 1,
    reason: null,
    outputs: null,
    gate: null,
    nodeRunId: `nr-${id}`,
    nodeRunState: 'succeeded',
    ...over,
  });
  return {
    run: {
      id: RUN,
      project: 'acme',
      name: 'hooked',
      version: 1,
      state: 'running',
      engine: 2,
      createdAt: iso(600_000),
      endedAt: null,
      reason: null,
      files: [],
      triggerKind: 'webhook',
      sourceTrust: 'untrusted',
      triggerNode: 'hook',
    },
    nodes: [
      node('hook', 'trigger.webhook', 'succeeded'),
      node('mk', 'jobs.create', 'succeeded'),
      node('w', 'control.waitWebhook', 'queued', {
        nodeRunState: 'waiting',
        waitKind: 'webhook',
        dueAt: '2030-01-01T23:00:00.000Z',
      }),
    ],
    edges: [
      { from: 'hook', to: 'mk', fromPort: 'out', toPort: 'in', state: 'value' },
      { from: 'mk', to: 'w', fromPort: 'out', toPort: 'in', state: 'value' },
    ],
    mergeRequests: [],
    sideEffects: [
      {
        nodeId: 'mk',
        scope: '',
        nodeRunId: 'nr-mk',
        kind: 'jobs.create',
        state: 'succeeded',
        externalRef: JOB,
        detail: { jobId: JOB },
        createdAt: iso(60_000),
        updatedAt: iso(50_000),
      },
    ],
  };
}

describe(
  'run view: triggers, side effects, webhook waits (p14-workflow-engine 14.2)',
  { timeout: 30_000 },
  () => {
    it.each(['tr', 'en'] as const)('%s: trigger facts, side effect link, manual resume', async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      const r = renderApp({
        path: `/jobs/workflows/${RUN}`,
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {
          [`GET /api/workflows/runs/${RUN}`]: () => ({ status: 200, body: runBody() }),
          [`GET /api/workflows/runs/${RUN}/integration`]: () => ({
            status: 200,
            body: { integration: null },
          }),
          [`GET /api/workflows/runs/${RUN}/node-runs?node=mk&limit=100`]: () => ({
            status: 200,
            body: { nodeRuns: [], nextCursor: null },
          }),
          [`GET /api/workflows/runs/${RUN}/node-runs?node=w&limit=100`]: () => ({
            status: 200,
            body: { nodeRuns: [], nextCursor: null },
          }),
          [`POST /api/workflows/runs/${RUN}/node-runs/nr-w/resume`]: () => ({
            status: 200,
            body: { state: 'succeeded' },
          }),
        }),
      });
      expect((await screen.findByTestId('workflow-run-trigger')).textContent).toBe(w.started);
      expect(screen.getByTestId('workflow-run-untrusted').textContent).toBe(w.untrusted);
      const steps = await screen.findByTestId('workflow-steps');
      expect(steps.textContent).toContain(w.waiting);
      await user.click(within(steps).getByRole('button', { name: 'mk' }));
      const effects = await screen.findByTestId('workflow-node-side-effects');
      expect(effects.textContent).toContain(w.sideEffects);
      expect(effects.textContent).toContain('jobs.create');
      expect(effects.textContent).toContain(w.done);
      expect(within(effects).getByTestId('side-effect-job').getAttribute('href')).toBe(`/jobs/${JOB}`);
      expect(within(effects).getByTestId('side-effect-job').textContent).toBe(w.openJob);
      await user.click(within(steps).getByRole('button', { name: 'w' }));
      const resume = await screen.findByTestId('workflow-resume');
      expect(resume.textContent).toContain(w.resume);
      await user.click(resume);
      const form = await screen.findByTestId('workflow-resume-form');
      await user.type(within(form).getByRole('textbox'), '{{"answer": "yes"}');
      await user.click(within(form).getByTestId('workflow-resume-confirm'));
      await waitFor(() => {
        const post = r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/node-runs/nr-w/resume'));
        expect(post?.body).toEqual({ data: { answer: 'yes' } });
      });
    });
  },
);

const automation = (over: Record<string, unknown> = {}) => ({
  id: AUTO,
  project: 'acme',
  name: 'hooked · hook',
  description: null,
  state: 'active',
  enabled: true,
  trigger: { kind: 'webhook' },
  triggerSummary: 'Signed webhook',
  target: {
    kind: 'workflow',
    runtime: null,
    workflowId: WF,
    title: null,
    approvalPolicy: null,
    sandboxProfile: null,
    deployAction: null,
  },
  approvalTimeoutMinutes: 60,
  reuseWithinHours: null,
  waiting: null,
  concurrency: 'skip',
  catchUp: 'once',
  maxRunsPerHour: 30,
  notifyOnFailure: true,
  nextRunAt: null,
  lastRun: null,
  runCount: 0,
  successRate: null,
  webhook: null,
  runAs: USER.id,
  createdBy: USER.id,
  createdAt: iso(1e6),
  updatedAt: iso(1e6),
  workflowBinding: { workflowId: WF, project: 'acme', name: 'hooked', triggerNode: 'hook' },
  ...over,
});

describe('bound automations in Otomasyonlar (p14-workflow-engine 14.2)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: the list marks them; the automation links to the canvas, no delete',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      renderApp({
        path: '/automations',
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {
          'GET /api/automations': () => ({ status: 200, body: { items: [automation()] } }),
          'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
          [`GET /api/automations/${AUTO}`]: () => ({
            status: 200,
            body: {
              ...automation(),
              targetSpec: { spec: null, priority: 0, workflowInputs: {}, workflowRepository: null },
              stats: { finished: 0, succeeded: 0, failed: 0, skipped: 0, lastFailure: null },
              chainSource: null,
              chainedBy: [],
              github: null,
            },
          }),
          [`GET /api/automations/${AUTO}/runs`]: () => empty,
        }),
      });
      const row = await screen.findByTestId('automation-row');
      expect(within(row).getByTestId('automation-bound').textContent).toBe(w.bound);
      await user.click(within(row).getByRole('link', { name: 'hooked · hook' }));
      const link = await screen.findByTestId('automation-open-canvas');
      expect(within(link).getByRole('link').getAttribute('href')).toBe(`/workflows/${WF}`);
      expect(link.textContent).toContain(w.canvas);
      expect(screen.getByTestId('automation-binding').textContent).toContain('hook');
      expect(screen.queryByTestId('delete-automation')).toBeNull();
    },
  );
});
