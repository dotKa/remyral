// p14-workflow-engine 14.1: the editor with the new engine — the node palette (only when the master reports the
// engine), the config panel generated from the catalog, the expression editor's live preview (debounced, error with
// its position), the single-node test, saving a v2 document; the run view's node runs (iterations, input / output,
// approve through step-up). In Turkish and in English.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthState } from '../src/auth/AuthProvider';
import type { SessionInfo } from '../src/api/auth';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { CATALOG } from './workflow-catalog-fixture';

configure({ asyncUtilTimeout: 5_000 });

const WF = 'aaaaaaaa-1111-4111-8111-111111111111';
const RUN = 'dddddddd-4444-4444-8444-444444444444';
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

const DEFINITION = {
  name: 'triage',
  inputs: { task: { required: true } },
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
  nodes: [{ id: 'plan', role: 'planner', prompt: 'Plan {{inputs.task}}' }],
  edges: [],
  layout: { positions: { plan: { x: 0, y: 0 } } },
};

function routes(
  engine: boolean,
  locale: Locale,
  over: Record<string, Handler> = {},
): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({
      status: 200,
      body: {
        ...(sessionBody() as object),
        locale,
        ...(engine ? { features: { workflowEngineV2: true } } : {}),
      },
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
            myRole: 'operator',
          },
        ],
      },
    }),
    'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
    'GET /api/workflows/catalog': () => ({ status: 200, body: CATALOG }),
    [`GET /api/workflows/${WF}/definition`]: () => ({
      status: 200,
      body: {
        id: WF,
        project: 'acme',
        name: 'triage',
        version: 2,
        latestVersion: 2,
        latestId: WF,
        archived: false,
        createdBy: 'ayse',
        createdAt: iso(3_600_000),
        hash: 'h2',
        promptsHidden: false,
        definition: DEFINITION,
      },
    }),
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

const WORDS = {
  tr: {
    add: 'Düğüm ekle',
    control: 'Akış kontrolü',
    later: 'Sonraki bir aşamada gelecek; şimdilik eklenemez.',
    search: 'Düğüm ara',
    ifLabel: 'Eğer / değilse',
    result: 'Sonuç (boolean)',
    errorAt: 'Sözdizimi hatalı — konum 7',
    tryIt: 'Dene',
    valueOn: '“true” çıkışına değer (3 ms)',
    save: 'Yeni sürüm kaydet',
  },
  en: {
    add: 'Add node',
    control: 'Flow control',
    later: 'Arrives in a later phase; cannot be added yet.',
    search: 'Search nodes',
    ifLabel: 'If / else',
    result: 'Result (boolean)',
    errorAt: 'Syntax error — position 7',
    tryIt: 'Try it',
    valueOn: 'A value on “true” (3 ms)',
    save: 'Yeni sürüm kaydet',
  },
} as const;

describe('workflow editor with the new engine (p14-workflow-engine 14.1)', { timeout: 30_000 }, () => {
  it('without the engine capability the editor stays v1: no palette, no catalog request', async () => {
    const r = renderApp({ path: `/workflows/${WF}`, initialState: state('tr'), routes: routes(false, 'tr') });
    expect(await screen.findByTestId('toolbar-add')).toBeTruthy();
    expect(screen.queryByTestId('toolbar-palette')).toBeNull();
    expect(r.requests.some((q) => q.url === '/api/workflows/catalog')).toBe(false);
  });

  it.each(['tr', 'en'] as const)(
    '%s: palette by category, config panel, expression preview, single-node test, saves v2',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      const r = renderApp({
        path: `/workflows/${WF}`,
        initialState: state(locale),
        i18n: true,
        routes: routes(true, locale, {
          'POST /api/workflows/expressions/evaluate': (req) => {
            const body = req.body as { expression: string };
            return body.expression.includes('!!')
              ? { status: 200, body: { ok: false, error: { code: 'expr_syntax', position: 7 } } }
              : { status: 200, body: { ok: true, value: true, type: 'boolean', bytes: 4 } };
          },
          [`POST /api/workflows/${WF}/nodes/if/test`]: () => ({
            status: 200,
            body: { ok: true, outcome: 'value', ports: { true: { n: 1 } }, port: 'true', durationMs: 3 },
          }),
          [`PUT /api/workflows/${WF}`]: () => ({
            status: 200,
            body: { id: 'ffffffff-6666-4666-8666-666666666666', name: 'triage', version: 3 },
          }),
          'GET /api/workflows/ffffffff-6666-4666-8666-666666666666/definition': () => ({
            status: 404,
            body: {},
          }),
        }),
      });
      const open = await screen.findByTestId('toolbar-palette');
      expect(open.textContent).toContain(w.add);
      await user.click(open);
      const palette = await screen.findByTestId('workflow-palette');
      expect(within(palette).getByRole('region', { name: w.control })).toBeTruthy();
      // A later-phase node is listed, disabled, with the reason.
      const http = within(palette).getByTestId('palette-http.request');
      expect((http as HTMLButtonElement).disabled).toBe(true);
      expect(http.textContent).toContain(w.later);
      // Search narrows; Enter adds the first match.
      await user.type(within(palette).getByLabelText(w.search), w.ifLabel.slice(0, 4));
      expect(within(palette).getByTestId('palette-control.if')).toBeTruthy();
      await user.click(within(palette).getByTestId('palette-control.if'));
      await waitFor(() => {
        expect(document.querySelector('[data-node="if"]')).not.toBeNull();
      });
      // The typed inspector: config form from the schema; the condition is an expression (fx).
      const inspector = await screen.findByTestId('typed-inspector');
      expect(inspector.getAttribute('data-type')).toBe('control.if');
      expect(inspector.textContent).toContain(w.ifLabel);
      const field = within(inspector).getByTestId('expr-condition');
      const area = within(field).getByRole('combobox');
      // Live preview: debounced, the master's result under the field.
      fireEvent.change(area, { target: { value: '$input.n > 0' } });
      expect(r.requests.some((q) => q.url === '/api/workflows/expressions/evaluate')).toBe(false);
      await waitFor(() => {
        expect(within(field).getByTestId('expression-preview').textContent).toContain(w.result);
      });
      const evals = r.requests.filter((q) => q.url === '/api/workflows/expressions/evaluate');
      expect(evals).toHaveLength(1);
      expect(evals[0]?.body).toMatchObject({ project: 'acme', expression: '$input.n > 0', mode: 'expr' });
      // An error shows its code and position.
      fireEvent.change(area, { target: { value: '$input !! 1' } });
      await waitFor(() => {
        expect(within(field).getByTestId('expression-error').textContent).toContain(w.errorAt);
      });
      // Autocomplete from upstream / inputs.
      fireEvent.change(area, { target: { value: '$inp', selectionStart: 4 } });
      // Single-node test with the unsaved node and the sample.
      await user.click(within(inspector).getByRole('button', { name: w.tryIt }));
      await waitFor(() => {
        expect(within(inspector).getByTestId('node-test-result').textContent).toContain(w.valueOn);
      });
      const test = r.requests.find((q) => q.url === `/api/workflows/${WF}/nodes/if/test`);
      expect(test?.body).toMatchObject({
        node: { type: 'control.if', id: 'if', config: { condition: { $expr: '$inp' } } },
        input: null,
        sample: { inputs: { task: '' } },
      });
      // Saving writes the v2 document.
      await user.click(screen.getByTestId('workflow-save'));
      await waitFor(() => {
        const put = r.requests.find((q) => q.method === 'PUT' && q.url === `/api/workflows/${WF}`);
        expect(put).toBeTruthy();
        const def = (put?.body as { definition: Record<string, unknown> }).definition;
        expect(def.schemaVersion).toBe(2);
        expect(def.nodes).toEqual([
          { type: 'ai.step', id: 'plan', role: 'planner', prompt: 'Plan {{inputs.task}}' },
          expect.objectContaining({ type: 'control.if', id: 'if' }),
        ]);
      });
    },
  );

  it('the expression editor suggests upstream outputs and inputs as you type', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/workflows/${WF}`,
      initialState: state('tr'),
      routes: routes(true, 'tr', {
        'POST /api/workflows/expressions/evaluate': () => ({
          status: 200,
          body: { ok: true, value: 1, type: 'number', bytes: 1 },
        }),
      }),
    });
    // Select the planner, add a Set node after it: its fields see $node.plan.
    const plan = await screen.findByText('plan');
    fireEvent.click(plan.closest('.react-flow__node') as HTMLElement);
    await user.click(await screen.findByTestId('toolbar-palette'));
    await user.click(within(await screen.findByTestId('workflow-palette')).getByTestId('palette-data.set'));
    const inspector = await screen.findByTestId('typed-inspector');
    const record = within(inspector).getByTestId('record-fields');
    const area = within(record).getByRole('combobox');
    await user.clear(area);
    await user.type(area, '$node.pl');
    // The list floats over the inspector (portalled, p17-ui-batch): it is not inside the record box.
    const list = await screen.findByRole('listbox');
    expect(record.contains(list)).toBe(false);
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining('$node.plan.out')]));
    await user.keyboard('{Enter}');
    expect((area as HTMLTextAreaElement).value).toBe('$node.plan.out');
  });
});

function runBody(): Record<string, unknown> {
  const node = (id: string, type: string, st: string, over: Record<string, unknown> = {}) => ({
    id,
    role: type === 'ai.step' ? 'executor' : null,
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
      name: 'triage',
      version: 3,
      state: 'running',
      engine: 2,
      createdAt: iso(600_000),
      endedAt: null,
      reason: null,
      files: [],
    },
    nodes: [
      node('check', 'control.if', 'succeeded', { outputPort: 'true' }),
      node('each', 'control.forEach', 'queued', { nodeRunState: 'running' }),
      node('later', 'control.delay', 'queued', {
        nodeRunState: 'waiting',
        waitKind: 'timer',
        dueAt: '2030-01-01T23:00:00.000Z',
      }),
      node('ok', 'control.approval', 'awaiting_approval', {
        nodeRunState: 'waiting',
        waitKind: 'approval',
        gate: { approverRole: 'operator', decision: null, decidedBy: null },
        iterations: 2,
      }),
    ],
    edges: [
      { from: 'check', to: 'each', fromPort: 'true', toPort: 'in', state: 'value' },
      { from: 'check', to: 'later', fromPort: 'false', toPort: 'in', state: 'skip' },
      { from: 'each', to: 'ok', fromPort: 'results', toPort: 'in', state: 'pending' },
    ],
    mergeRequests: [],
  };
}

const nodeRun = (scope: string, state: string, over: Record<string, unknown> = {}) => ({
  id: `nr-ok-${scope.replace(/[^a-z0-9]/g, '')}`,
  node: 'ok',
  type: 'control.approval',
  scope,
  attempt: 1,
  state,
  waitKind: state === 'waiting' ? 'approval' : null,
  dueAt: null,
  placement: 'master',
  outputPort: state === 'succeeded' ? 'approved' : null,
  input: { title: 'Ship?' },
  output: state === 'succeeded' ? { approved: true } : null,
  error: null,
  reason: null,
  startedAt: iso(60_000),
  endedAt: state === 'succeeded' ? iso(30_000) : null,
  createdAt: iso(60_000),
  gate: { approverRole: 'operator', decision: null, decidedBy: null },
  jobId: null,
  ...over,
});

function fakeApi(): AuthApi {
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
    getSession: () => Promise.resolve(session('tr')),
  } as unknown as AuthApi;
}

describe('run view of the new engine (p14-workflow-engine 14.1)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: typed nodes, waits, skipped paths; node runs per iteration; approve through step-up',
    async (locale) => {
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      let stepped = false;
      const r = renderApp({
        path: `/jobs/workflows/${RUN}`,
        initialState: state(locale),
        api: fakeApi(),
        i18n: true,
        routes: routes(true, locale, {
          [`GET /api/workflows/runs/${RUN}`]: () => ({ status: 200, body: runBody() }),
          [`GET /api/workflows/runs/${RUN}/integration`]: () => ({
            status: 200,
            body: { integration: null },
          }),
          [`GET /api/workflows/runs/${RUN}/node-runs?node=ok&limit=100`]: () => ({
            status: 200,
            body: {
              nodeRuns: [nodeRun('each[0]', 'succeeded'), nodeRun('each[1]', 'waiting')],
              nextCursor: null,
            },
          }),
          [`POST /api/workflows/runs/${RUN}/node-runs/nr-ok-each1/approve`]: () =>
            stepped
              ? { status: 200, body: { state: 'succeeded' } }
              : {
                  status: 403,
                  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
                },
        }),
      });
      const steps = await screen.findByTestId('workflow-steps');
      // Typed nodes by their catalog names; a timer's due time; the run graph's skipped path is dashed.
      expect(steps.textContent).toContain(locale === 'tr' ? 'Onay bekle' : 'Approval');
      expect(steps.textContent).toContain(locale === 'tr' ? 'devam edecek' : 'Resumes at');
      const graph = screen.getByTestId('workflow-graph');
      await waitFor(() => {
        expect(graph.querySelector('[data-skipped-edges]')?.getAttribute('data-skipped-edges')).toBe(
          'check:false->later:in',
        );
      });
      await user.click(within(steps).getByRole('button', { name: 'ok' }));
      const runs = await screen.findByTestId('node-runs');
      // Iterations: the latest first; the selector switches.
      const select = within(runs).getByTestId<HTMLSelectElement>('node-run-scope');
      expect([...select.options].map((o) => o.textContent)).toEqual(
        locale === 'tr' ? ['each · 1. tur', 'each · 2. tur'] : ['each · iteration 1', 'each · iteration 2'],
      );
      expect(within(runs).getByTestId('node-run').getAttribute('data-state')).toBe('waiting');
      await user.selectOptions(select, 'each[0]');
      expect(within(runs).getByTestId('node-run').getAttribute('data-state')).toBe('succeeded');
      expect(
        within(runs)
          .getAllByTestId('node-run-data')
          .map((d) => d.textContent),
      ).toEqual([expect.stringContaining('"title": "Ship?"'), expect.stringContaining('"approved": true')]);
      await user.selectOptions(select, 'each[1]');
      await user.click(within(runs).getByTestId('node-run-approve'));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
      stepped = true;
      await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
      await waitFor(() => {
        const posts = r.requests.filter(
          (q) => q.method === 'POST' && q.url.endsWith('/node-runs/nr-ok-each1/approve'),
        );
        expect(posts).toHaveLength(2);
      });
    },
  );
});
