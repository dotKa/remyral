// p14-workflow-engine 14.4 (design §20): run operations on the run page — Duraklat / Devam ettir behind a
// confirmation, the queued / paused / pruned bands and the re-run lineage, the re-run dialog with the master's dry-run
// plan (copied, runs again, side effects, "en son sürümle") and its confirmation, copied node runs marked; in the
// editor the run settings written into the saved definition, the Metrikler tab, and the 14.4 node types in the
// palette. In Turkish and in English.
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
const SRC = 'eeeeeeee-5555-4555-8555-555555555555';
const NEW_RUN = 'ffffffff-7777-4777-8777-777777777777';
const empty = { status: 200, body: { items: [], nextCursor: null } };
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

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

const t14 = (type: string, category: string, over: Record<string, unknown> = {}) => ({
  type,
  category,
  placement: category === 'trigger' ? 'trigger' : 'master',
  phase: '14.4',
  icon: 'branch',
  group: false,
  sideEffect: false,
  requires: 'workflows.define',
  untrustedOutput: category === 'trigger',
  testable: false,
  fields: {},
  config: { type: 'object', properties: {}, additionalProperties: false },
  ports: [{ name: 'out', direction: 'out' }],
  ...over,
});
const catalog = {
  ...CATALOG,
  executable: [...CATALOG.executable, 'trigger.error', 'control.respond'],
  types: [
    ...CATALOG.types,
    t14('trigger.error', 'trigger'),
    t14('control.respond', 'control', {
      fields: { status: 'static', body: 'expr', headers: 'expr' },
      config: {
        type: 'object',
        properties: {
          status: { type: 'integer', minimum: 200, maximum: 599, default: 200 },
          body: {},
          headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 1000 } },
        },
        additionalProperties: false,
      },
      ports: [
        { name: 'in', direction: 'in', required: true },
        { name: 'out', direction: 'out' },
        { name: 'error', direction: 'out' },
      ],
    }),
  ],
};

const DEFINITION = {
  schemaVersion: 2,
  name: 'billing',
  inputs: {},
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'set', type: 'data.set', config: { fields: { a: 1 } } },
  ],
  edges: [{ from: 'start', to: 'set' }],
  layout: { positions: { start: { x: 0, y: 0 }, set: { x: 300, y: 0 } } },
};

function routes(locale: Locale, over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), locale, features: { workflowEngineV2: true } },
    }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
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
    'GET /api/workflows': () => ({
      status: 200,
      body: {
        definitions: [
          {
            id: WF,
            project: 'acme',
            name: 'billing',
            version: 1,
            nodes: 2,
            edges: 1,
            description: null,
            createdAt: iso(1e6),
            createdBy: 'ayse',
            archived: false,
            archivedAt: null,
            runs: 0,
            succeeded: 0,
            failed: 0,
            lastRun: null,
          },
          {
            id: 'bbbbbbbb-2222-4222-8222-222222222222',
            project: 'acme',
            name: 'notify-oncall',
            version: 1,
            nodes: 2,
            edges: 1,
            description: null,
            createdAt: iso(1e6),
            createdBy: 'ayse',
            archived: false,
            archivedAt: null,
            runs: 0,
            succeeded: 0,
            failed: 0,
            lastRun: null,
          },
        ],
        runs: [],
      },
    }),
    'GET /api/workflows/catalog': () => ({ status: 200, body: catalog }),
    [`GET /api/workflows/${WF}/definition`]: () => ({
      status: 200,
      body: {
        id: WF,
        project: 'acme',
        name: 'billing',
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
    [`GET /api/workflows/runs/${RUN}/integration`]: () => ({ status: 200, body: { integration: null } }),
    [`GET /api/workflows/runs/${RUN}/node-runs?node=set&limit=100`]: () => ({
      status: 200,
      body: {
        nodeRuns: [
          {
            id: 'nr-set',
            node: 'set',
            type: 'data.set',
            scope: '',
            attempt: 1,
            state: 'succeeded',
            placement: 'master',
            input: { $pruned: true },
            output: { $pruned: true },
            error: null,
            reason: null,
            createdAt: iso(60_000),
            copiedFrom: 'nr-src-set',
          },
        ],
        nextCursor: null,
      },
    }),
    ...over,
  };
}

function runBody(ops: Record<string, unknown>, publicState: string): Record<string, unknown> {
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
    nodeRunState: st,
    scope: '',
    copiedFrom: null,
    ...over,
  });
  return {
    run: {
      id: RUN,
      definitionId: WF,
      project: 'acme',
      name: 'billing',
      version: 1,
      state: publicState,
      engine: 2,
      createdAt: iso(600_000),
      endedAt: ['succeeded', 'failed', 'cancelled'].includes(publicState) ? iso(60_000) : null,
      reason: null,
      files: [],
      triggerKind: 'rerun',
      sourceTrust: 'trusted',
      triggerNode: null,
      engineState: publicState === 'running' ? 'active' : publicState === 'starting' ? 'queued' : publicState,
      pausedAt: null,
      pausedBy: null,
      rerunOf: null,
      rerunFromNode: null,
      errorOf: null,
      concurrencyKey: null,
      activatedAt: null,
      dataPrunedAt: null,
      queuePosition: null,
      ...ops,
    },
    nodes: [
      node('start', 'trigger.manual', 'succeeded', { copiedFrom: 'nr-src-start' }),
      node('set', 'data.set', 'succeeded', { copiedFrom: 'nr-src-set' }),
    ],
    edges: [{ from: 'start', to: 'set', fromPort: 'out', toPort: 'in', state: 'value' }],
    mergeRequests: [],
    sideEffects: [],
  };
}

const WORDS = {
  tr: {
    pause: 'Duraklat',
    pauseConfirm: 'Duraklatmayı onayla',
    resume: 'Devam ettir',
    paused: 'Duraklatıldı',
    queued: 'Sırada · 2.',
    pruned: 'saklama süresi dolduğu için',
    rerun: 'Yeniden çalıştır',
    fromHere: 'Buradan yeniden çalıştır',
    copied: 'önceki çalıştırmadan',
    runsAgain: 'Bu düğümler yeniden çalışacak (yan etkiler tekrar olur): ping',
    confirm: 'Yeniden çalıştırmayı başlat',
    latest: 'En son sürümle',
    rerunOf: 'Yeniden çalıştırılan çalıştırma',
    settings: 'Çalıştırma ayarları',
    max: 'En çok kaç çalıştırma aynı anda',
    alerts: 'Art arda kaç hatada uyarı gönderilsin',
    retention: 'Veri saklama süresi (gün)',
    onFailure: 'Hata workflow’u',
    metricsTab: 'Metrikler',
    streak: 'Art arda 2 başarısız çalıştırma (uyarı eşiği: 3)',
    failures: 'Son başarısız çalıştırmalar',
  },
  en: {
    pause: 'Pause',
    pauseConfirm: 'Confirm pause',
    resume: 'Resume',
    paused: 'Paused',
    queued: 'Queued · position 2.',
    pruned: 'after the retention period',
    rerun: 'Re-run',
    fromHere: 'Re-run from here',
    copied: 'from the previous run',
    runsAgain: 'These nodes run again (their side effects repeat): ping',
    confirm: 'Start the re-run',
    latest: 'With the latest version',
    rerunOf: 'Re-run of',
    settings: 'Run settings',
    max: 'At most this many runs at once',
    alerts: 'Alert after this many failures in a row',
    retention: 'Data retention (days)',
    onFailure: 'Error workflow',
    metricsTab: 'Metrics',
    streak: '2 failed runs in a row (alert threshold: 3)',
    failures: 'Recent failed runs',
  },
} as const;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('run operations (p14-workflow-engine 14.4)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)('%s: pause an active run behind a confirmation', async (locale) => {
    const w = WORDS[locale];
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: `/jobs/workflows/${RUN}`,
      initialState: state(locale),
      api: fakeApi(locale),
      i18n: true,
      routes: routes(locale, {
        [`GET /api/workflows/runs/${RUN}`]: () => ({ status: 200, body: runBody({}, 'running') }),
        [`POST /api/workflows/runs/${RUN}/pause`]: () => ({ status: 200, body: { state: 'paused' } }),
      }),
    });
    const pause = await screen.findByTestId('workflow-pause');
    expect(pause.textContent).toBe(w.pause);
    await user.click(pause);
    const confirm = await screen.findByTestId('workflow-pause-confirm');
    expect(confirm.textContent).toBe(w.pauseConfirm);
    await user.click(confirm);
    await waitFor(() => {
      const post = r.requests.find(
        (q) => q.method === 'POST' && q.url === `/api/workflows/runs/${RUN}/pause`,
      );
      expect(post?.body).toEqual({});
    });
  });

  it.each(['tr', 'en'] as const)('%s: a paused run shows its band and resumes', async (locale) => {
    const w = WORDS[locale];
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: `/jobs/workflows/${RUN}`,
      initialState: state(locale),
      api: fakeApi(locale),
      i18n: true,
      routes: routes(locale, {
        [`GET /api/workflows/runs/${RUN}`]: () => ({
          status: 200,
          body: runBody({ pausedAt: iso(120_000), pausedBy: 'ayse' }, 'paused'),
        }),
        [`POST /api/workflows/runs/${RUN}/resume`]: () => ({ status: 200, body: { state: 'active' } }),
      }),
    });
    const band = await screen.findByTestId('workflow-paused');
    expect(band.textContent).toContain('ayse');
    expect(screen.getByTestId('workflow-run-state').textContent).toBe(w.paused);
    await user.click(screen.getByTestId('workflow-resume'));
    await user.click(await screen.findByTestId('workflow-resume-confirm'));
    await waitFor(() => {
      expect(
        r.requests.some((q) => q.method === 'POST' && q.url === `/api/workflows/runs/${RUN}/resume`),
      ).toBe(true);
    });
    // A paused run can still be cancelled.
    expect(screen.getByTestId('workflow-cancel')).toBeTruthy();
  });

  it.each(['tr', 'en'] as const)('%s: a queued run shows its place in the queue', async (locale) => {
    const w = WORDS[locale];
    renderApp({
      path: `/jobs/workflows/${RUN}`,
      initialState: state(locale),
      api: fakeApi(locale),
      i18n: true,
      routes: routes(locale, {
        [`GET /api/workflows/runs/${RUN}`]: () => ({
          status: 200,
          body: runBody({ queuePosition: 2, concurrencyKey: 'cust-7' }, 'starting'),
        }),
      }),
    });
    const band = await screen.findByTestId('workflow-queued');
    expect(band.textContent).toContain(w.queued);
    expect(band.textContent).toContain('cust-7');
    expect(screen.queryByTestId('workflow-pause')).toBeNull();
  });

  it.each(['tr', 'en'] as const)(
    '%s: a finished re-run: lineage, pruned band, copied marks; the re-run dialog with the dry-run plan',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      const plan = (latest: boolean) => ({
        fromNode: null,
        version: latest ? 2 : 1,
        copied: [],
        fresh: ['start', 'set', 'ping'],
        sideEffects: ['ping'],
        aiSteps: [],
      });
      const r = renderApp({
        path: `/jobs/workflows/${RUN}`,
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {
          [`GET /api/workflows/runs/${RUN}`]: () => ({
            status: 200,
            body: runBody({ rerunOf: SRC, rerunFromNode: 'set', dataPrunedAt: iso(30_000) }, 'succeeded'),
          }),
          [`POST /api/workflows/runs/${RUN}/rerun`]: (q) => {
            const b = q.body as { dryRun?: boolean; latestVersion?: boolean; fromNode?: string };
            return b.dryRun === true
              ? {
                  status: 200,
                  body: { plan: { ...plan(b.latestVersion === true), fromNode: b.fromNode ?? null } },
                }
              : { status: 201, body: { runId: NEW_RUN, plan: plan(b.latestVersion === true) } };
          },
          [`GET /api/workflows/runs/${NEW_RUN}`]: () => ({ status: 200, body: runBody({}, 'running') }),
          [`GET /api/workflows/runs/${NEW_RUN}/integration`]: () => ({
            status: 200,
            body: { integration: null },
          }),
        }),
      });
      const lineage = await screen.findByTestId('workflow-rerun-of');
      expect(lineage.textContent).toContain(w.rerunOf);
      expect(within(lineage).getByRole('link').getAttribute('href')).toBe(`/jobs/workflows/${SRC}`);
      expect(screen.getByTestId('workflow-pruned').textContent).toContain(w.pruned);
      const steps = screen.getByTestId('workflow-steps');
      expect(within(steps).getAllByTestId('node-copied')[0]?.textContent).toBe(w.copied);
      // Re-run from a node (selected in the list).
      await user.click(within(steps).getByRole('button', { name: 'set' }));
      const from = await screen.findByTestId('workflow-rerun-from');
      expect(from.textContent).toBe(w.fromHere);
      await user.click(from);
      await waitFor(() => {
        const dry = r.requests.find(
          (q) =>
            q.url === `/api/workflows/runs/${RUN}/rerun` &&
            (q.body as { fromNode?: string }).fromNode === 'set',
        );
        expect(dry?.body).toEqual({ fromNode: 'set', dryRun: true });
      });
      await user.keyboard('{Escape}');
      // The whole run.
      await user.click(screen.getByTestId('workflow-rerun'));
      const dialog = await screen.findByTestId('workflow-rerun-dialog');
      expect((await within(dialog).findByTestId('workflow-rerun-effects')).textContent).toBe(w.runsAgain);
      expect(within(dialog).getByTestId('workflow-rerun-fresh').textContent).toContain('ping');
      await user.click(within(dialog).getByLabelText(w.latest));
      await waitFor(() => {
        expect(
          r.requests.some(
            (q) =>
              q.url === `/api/workflows/runs/${RUN}/rerun` &&
              (q.body as { latestVersion?: boolean; dryRun?: boolean }).latestVersion === true &&
              (q.body as { dryRun?: boolean }).dryRun === true,
          ),
        ).toBe(true);
      });
      const confirm = within(dialog).getByTestId('workflow-rerun-confirm');
      expect(confirm.textContent).toBe(w.confirm);
      await waitFor(() => {
        expect((confirm as HTMLButtonElement).disabled).toBe(false);
      });
      await user.click(confirm);
      await waitFor(() => {
        const started = r.requests.find(
          (q) =>
            q.method === 'POST' &&
            q.url === `/api/workflows/runs/${RUN}/rerun` &&
            (q.body as { dryRun?: boolean }).dryRun === undefined,
        );
        expect(started?.body).toEqual({ latestVersion: true });
      });
      await waitFor(() => {
        expect(r.requests.some((q) => q.url === `/api/workflows/runs/${NEW_RUN}`)).toBe(true);
      });
    },
  );

  it('shows a refusal of the plan in words (rerun_upstream_incomplete)', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    renderApp({
      path: `/jobs/workflows/${RUN}`,
      initialState: state('en'),
      api: fakeApi('en'),
      i18n: true,
      routes: routes('en', {
        [`GET /api/workflows/runs/${RUN}`]: () => ({ status: 200, body: runBody({}, 'failed') }),
        [`POST /api/workflows/runs/${RUN}/rerun`]: () => ({
          status: 409,
          body: {
            error: 'rerun_upstream_incomplete',
            message: 'Node start did not end well; re-run from it.',
          },
        }),
      }),
    });
    await user.click(await screen.findByTestId('workflow-rerun'));
    const dialog = await screen.findByTestId('workflow-rerun-dialog');
    expect((await within(dialog).findByTestId('api-error')).textContent.length).toBeGreaterThan(0);
    expect(within(dialog).getByTestId<HTMLButtonElement>('workflow-rerun-confirm').disabled).toBe(true);
  });
});

describe(
  'run settings, metrics and 14.4 nodes in the editor (p14-workflow-engine 14.4)',
  { timeout: 30_000 },
  () => {
    it.each(['tr', 'en'] as const)('%s: the run settings go into the saved definition', async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      const r = renderApp({
        path: `/workflows/${WF}`,
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {
          [`PUT /api/workflows/${WF}`]: () => ({
            status: 200,
            body: { id: 'cccccccc-3333-4333-8333-333333333333', name: 'billing', version: 2 },
          }),
          'GET /api/workflows/cccccccc-3333-4333-8333-333333333333/definition': () => ({
            status: 404,
            body: {},
          }),
        }),
      });
      await user.click(await screen.findByTestId('toolbar-settings'));
      const fields = await screen.findByTestId('workflow-run-settings');
      expect(screen.getByText(w.settings)).toBeTruthy();
      await user.type(within(fields).getByLabelText(w.max), '3');
      await user.type(within(fields).getByLabelText(w.retention), '14');
      await user.type(within(fields).getByLabelText(w.alerts), '5');
      await user.selectOptions(within(fields).getByLabelText(w.onFailure), 'notify-oncall');
      // The workflow itself is not offered as its own error workflow.
      expect(
        within(within(fields).getByLabelText(w.onFailure)).queryByRole('option', {
          name: 'billing',
        }),
      ).toBeNull();
      await user.click(screen.getByTestId('workflow-save'));
      await waitFor(() => {
        const put = r.requests.find((q) => q.method === 'PUT' && q.url === `/api/workflows/${WF}`);
        expect(
          (put?.body as { definition: { settings?: unknown } } | undefined)?.definition.settings,
        ).toEqual({
          concurrency: { onLimit: 'queue', max: 3 },
          retentionDays: 14,
          alerts: { failuresInARow: 5 },
          onFailure: { workflow: 'notify-oncall' },
        });
      });
    });

    it.each(['tr', 'en'] as const)('%s: the Metrikler tab', async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      renderApp({
        path: `/workflows/${WF}`,
        initialState: state(locale),
        api: fakeApi(locale),
        i18n: true,
        routes: routes(locale, {
          [`GET /api/workflows/${WF}/metrics?days=30`]: () => ({
            status: 200,
            body: {
              days: 30,
              runs: { queued: 1, active: 0, paused: 0, succeeded: 8, failed: 2, cancelled: 0 },
              failureStreak: 2,
              alertAfter: 3,
              nodes: [
                { node: 'set', type: 'data.set', runs: 10, failed: 2, p50Ms: 120, p95Ms: 900, maxMs: 1500 },
              ],
              recentFailures: [{ runId: RUN, endedAt: iso(10_000), reason: 'node set failed' }],
            },
          }),
        }),
      });
      const tab = await screen.findByRole('tab', { name: w.metricsTab });
      await user.click(tab);
      expect((await screen.findByTestId('workflow-metrics-streak')).textContent).toBe(w.streak);
      expect(screen.getAllByTestId('workflow-metrics-node')).toHaveLength(1);
      const failures = screen.getByTestId('workflow-metrics-failures');
      expect(failures.textContent).toContain(w.failures);
      expect(within(failures).getByRole('link').getAttribute('href')).toBe(`/jobs/workflows/${RUN}`);
    });

    it('the palette offers the error trigger and Respond to webhook', async () => {
      const user = userEvent.setup();
      renderApp({
        path: `/workflows/${WF}`,
        initialState: state('tr'),
        api: fakeApi('tr'),
        i18n: true,
        routes: routes('tr'),
      });
      await user.click(await screen.findByTestId('toolbar-palette'));
      const palette = await screen.findByTestId('workflow-palette');
      const err = within(palette).getByTestId('palette-trigger.error');
      expect((err as HTMLButtonElement).disabled).toBe(false);
      expect(err.textContent).toContain('Hata tetikleyicisi');
      const respond = within(palette).getByTestId('palette-control.respond');
      expect((respond as HTMLButtonElement).disabled).toBe(false);
      await user.click(respond);
      const inspector = await screen.findByTestId('typed-inspector');
      expect(inspector.getAttribute('data-type')).toBe('control.respond');
    });
  },
);
