// p13-workflows-ui: `/workflows` (list, filters, run / duplicate / archive) and the editor (`/workflows/new`,
// `/workflows/:id`): add / connect / delete / undo / redo, tidy, master validation on the steps, YAML sync, save as a
// new version, run link, read-only for viewers, the runs tab, the lazy editor chunk.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import * as layout from '../src/diyalog/screens/workflows/layout';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

vi.mock('../src/diyalog/screens/workflows/layout', async (orig) => {
  const m = await orig<typeof import('../src/diyalog/screens/workflows/layout')>();
  return { ...m, tidyPositions: vi.fn(m.tidyPositions), arrange: vi.fn(m.arrange) };
});

configure({ asyncUtilTimeout: 5_000 });

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const WF = 'aaaaaaaa-1111-4111-8111-111111111111';
const WF2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const WF_NEW = 'cccccccc-3333-4333-8333-333333333333';
const RUN = 'dddddddd-4444-4444-8444-444444444444';

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

const project = (id: string, myRole: string): Record<string, unknown> => ({
  id,
  name: id,
  kind: 'repository',
  createdAt: iso(1e9),
  createdBy: null,
  members: 2,
  myRole,
});

function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WF,
    project: 'acme',
    name: 'release-check',
    version: 3,
    nodes: 3,
    edges: 2,
    description: 'Ship a release',
    createdAt: iso(3_600_000),
    createdBy: 'ayse',
    archived: false,
    archivedAt: null,
    runs: 5,
    succeeded: 3,
    failed: 1,
    lastRun: { id: RUN, state: 'succeeded', createdAt: iso(600_000) },
    ...over,
  };
}

const DEFINITION = {
  name: 'release-check',
  description: 'Ship a release',
  inputs: { task: { required: true } },
  defaults: {
    runtime: 'codex',
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    sourceTrust: 'untrusted',
    limits: { maxDurationSec: 1800 },
  },
  nodes: [
    { id: 'plan', role: 'planner', prompt: 'Plan {{inputs.task}}' },
    { id: 'build', role: 'executor', prompt: 'Build it' },
    { id: 'verify', role: 'verifier', prompt: 'Verify {{upstream.build.summary}}' },
  ],
  edges: [
    { from: 'plan', to: 'build' },
    { from: 'build', to: 'verify' },
  ],
  layout: {
    positions: { plan: { x: 0, y: 0 }, build: { x: 300, y: 0 }, verify: { x: 600, y: 0 } },
  },
};

function documentBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WF,
    project: 'acme',
    name: 'release-check',
    version: 3,
    latestVersion: 3,
    latestId: WF,
    archived: false,
    createdBy: 'ayse',
    createdAt: iso(3_600_000),
    hash: 'h3',
    promptsHidden: false,
    definition: DEFINITION,
    ...over,
  };
}

function base(role = 'operator', over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({
      status: 200,
      body: { items: [project('acme', role), project('beta', 'viewer')] },
    }),
    'GET /api/workflows': () => ({
      status: 200,
      body: {
        definitions: [
          summary(),
          summary({
            id: WF2,
            project: 'beta',
            name: 'nightly',
            version: 1,
            runs: 0,
            succeeded: 0,
            failed: 0,
            lastRun: null,
            description: null,
          }),
          summary({ id: WF_NEW, name: 'old-flow', archived: true, archivedAt: iso(1000), lastRun: null }),
        ],
        runs: [
          {
            id: RUN,
            project: 'acme',
            name: 'release-check',
            version: 3,
            state: 'succeeded',
            createdAt: iso(600_000),
            endedAt: iso(300_000),
          },
          {
            id: 'eeeeeeee-5555-4555-8555-555555555555',
            project: 'beta',
            name: 'nightly',
            version: 1,
            state: 'failed',
            createdAt: iso(60_000),
            endedAt: null,
          },
        ],
      },
    }),
    [`GET /api/workflows/${WF}/definition`]: () => ({ status: 200, body: documentBody() }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(layout.tidyPositions).mockClear();
  vi.mocked(layout.arrange).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cards = async (): Promise<HTMLElement[]> =>
  within(await screen.findByTestId('workflow-canvas')).findAllByTestId('workflow-node');
const ids = (els: readonly HTMLElement[]): (string | null)[] => els.map((e) => e.getAttribute('data-node'));
const edgesOf = (): string[] =>
  (screen.getByTestId('workflow-canvas').getAttribute('data-edges') ?? '').split(' ').filter(Boolean);
const clickNode = (id: string): void => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no node ${id}`);
  fireEvent.click(el);
};

describe('Diyalog workflows list (p13-workflows-ui)', { timeout: 20_000 }, () => {
  it('lists workflows with last run, success rate, runs and actions; filters and archive in the URL', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: '/workflows',
      initialState: state('operator'),
      routes: base('operator', {
        [`POST /api/workflows/${WF}/archive`]: () => ({ status: 200, body: { archived: true } }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Workflow’lar' })).toBeTruthy();
    // The rail has the entry, active.
    expect(
      screen
        .getAllByRole('link', { name: 'Workflow’lar' })
        .some((l) => l.getAttribute('aria-current') === 'page'),
    ).toBe(true);
    const rows = await screen.findAllByTestId('workflow-row');
    expect(rows.map((x) => within(x).getAllByRole('link')[0]?.textContent)).toEqual([
      'release-check',
      'nightly',
    ]);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByTestId('workflow-rate').textContent).toBe('%75 başarılı · 5 çalıştırma');
    expect(first.textContent).toContain('Bitti');
    expect(first.textContent).toContain('güncelleyen ayse');
    expect(within(first).getByRole('link', { name: 'release-check: çalıştır' }).getAttribute('href')).toBe(
      `/jobs/new?mode=workflow&workflow=${WF}&project=acme`,
    );
    // p17-ui-polish: one primary action (Çalıştır); Aç, Kopyala and Arşivle are in the row's menu.
    expect(within(first).queryByRole('link', { name: 'release-check: aç' })).toBeNull();
    await user.click(within(first).getByRole('button', { name: 'release-check: diğer eylemler' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Aç', 'Kopyala', 'Arşivle']);
    await user.keyboard('{Escape}');
    // A project the user only views: open, nothing else.
    const second = rows[1] as HTMLElement;
    expect(within(second).getByRole('link', { name: 'nightly: aç' })).toBeTruthy();
    expect(within(second).queryByRole('link', { name: /çalıştır/ })).toBeNull();
    expect(within(second).queryByRole('button', { name: /diğer eylemler/ })).toBeNull();
    expect(second.textContent).toContain('Hiç çalışmadı');
    // Search and project filter.
    await user.type(screen.getByRole('searchbox', { name: 'Ara' }), 'night');
    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-row')).toHaveLength(1);
    });
    await user.clear(screen.getByRole('searchbox', { name: 'Ara' }));
    await user.selectOptions(screen.getByLabelText('Proje'), 'beta');
    await waitFor(() => {
      expect(screen.getAllByTestId('workflow-row')).toHaveLength(1);
    });
    await user.selectOptions(screen.getByLabelText('Proje'), '');
    // Archived ones behind the toggle.
    await user.click(screen.getByRole('button', { name: 'Arşiv (1)' }));
    expect((await screen.findAllByTestId('workflow-row')).map((x) => x.textContent)).toEqual([
      expect.stringContaining('old-flow'),
    ]);
    await user.click(screen.getByRole('button', { name: 'Arşiv (1)' }));
    // Arşivle.
    await user.click(await screen.findByRole('button', { name: 'release-check: diğer eylemler' }));
    await user.click(screen.getByRole('menuitem', { name: 'Arşivle' }));
    expect((await screen.findByRole('status')).textContent).toContain('release-check arşivlendi');
    const post = r.requests.find((q) => q.method === 'POST' && q.url === `/api/workflows/${WF}/archive`);
    expect(post?.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('duplicates under a new name and opens the copy', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: '/workflows',
      initialState: state('operator'),
      routes: base('operator', {
        [`POST /api/workflows/${WF}/duplicate`]: () => ({
          status: 201,
          body: { id: WF_NEW, name: 'release-two', version: 1 },
        }),
        [`GET /api/workflows/${WF_NEW}/definition`]: () => ({
          status: 200,
          body: documentBody({
            id: WF_NEW,
            latestId: WF_NEW,
            name: 'release-two',
            version: 1,
            latestVersion: 1,
          }),
        }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'release-check: diğer eylemler' }));
    await user.click(screen.getByRole('menuitem', { name: 'Kopyala' }));
    const dialog = await screen.findByTestId('workflow-duplicate');
    const input = within(dialog).getByLabelText('Yeni ad');
    expect((input as HTMLInputElement).value).toBe('release-check-kopya');
    await user.clear(input);
    await user.type(input, 'release-two');
    await user.click(within(dialog).getByRole('button', { name: 'Kopyala' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'release-two' })).toBeTruthy();
    expect(r.requests.find((q) => q.url === `/api/workflows/${WF}/duplicate`)?.body).toEqual({
      name: 'release-two',
    });
  });

  it('says when there is no workflow yet and offers the first one', async () => {
    renderApp({
      path: '/workflows',
      initialState: state('operator'),
      routes: base('operator', {
        'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
      }),
    });
    const emptyLine = await screen.findByTestId('workflow-list-empty');
    expect(within(emptyLine).getByRole('link', { name: 'İlk workflow’u oluştur' }).getAttribute('href')).toBe(
      '/workflows/new',
    );
  });
});

describe('Diyalog workflow editor (p13-workflows-ui)', { timeout: 30_000 }, () => {
  it('new: adds, connects, deletes, undoes and redoes steps on the canvas', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/workflows/new', initialState: state('operator'), routes: base() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni workflow' })).toBeTruthy();
    expect(await screen.findByTestId('workflow-empty')).toBeTruthy();
    // Add a planner from the empty state, then a step from the toolbar menu (after the selected planner).
    await user.click(
      within(screen.getByTestId('workflow-empty')).getByRole('button', { name: 'Planlayıcı' }),
    );
    expect(ids(await cards())).toEqual(['plan']);
    await user.click(screen.getByTestId('toolbar-add'));
    await user.click(screen.getByRole('menuitem', { name: 'İş adımı' }));
    await waitFor(async () => {
      expect(ids(await cards())).toEqual(['plan', 'step']);
    });
    expect(screen.getByTestId('workflow-status').textContent).toContain('plan adımından sonra');
    expect(edgesOf()).toEqual(['plan->step']);
    // The inspector shows the new (selected) step.
    expect(within(screen.getByTestId('node-inspector')).getByLabelText('Kimlik')).toHaveProperty(
      'value',
      'step',
    );
    // A verifier, then connect plan → verify with the toolbar's Bağla.
    await user.click(screen.getByTestId('toolbar-add'));
    await user.click(screen.getByRole('menuitem', { name: 'Doğrulama' }));
    await waitFor(async () => {
      expect(ids(await cards())).toHaveLength(3);
    });
    clickNode('plan');
    await user.click(screen.getByTestId('toolbar-connect'));
    expect(screen.getByTestId('workflow-status').textContent).toContain(
      'plan adımından sonra gelecek adımı seç',
    );
    clickNode('verify');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-status').textContent).toBe('plan → verify bağlandı.');
    });
    expect(edgesOf()).toHaveLength(3);
    // A link that would close a cycle is refused.
    clickNode('verify');
    await user.click(screen.getByTestId('toolbar-connect'));
    clickNode('plan');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-status').textContent).toContain('döngü');
    });
    expect(edgesOf()).toHaveLength(3);
    // Delete the selected step; undo brings it back with its links; redo removes it again.
    clickNode('step');
    await user.click(screen.getByTestId('toolbar-delete'));
    await waitFor(async () => {
      expect(ids(await cards())).toEqual(['plan', 'verify']);
    });
    await user.click(screen.getByTestId('toolbar-undo'));
    await waitFor(async () => {
      expect(ids(await cards())).toEqual(['plan', 'step', 'verify']);
    });
    expect(edgesOf()).toHaveLength(3);
    await user.click(screen.getByTestId('toolbar-redo'));
    await waitFor(async () => {
      expect(ids(await cards())).toEqual(['plan', 'verify']);
    });
    expect(screen.getByTestId('workflow-dirty')).toBeTruthy();
  });

  it('new: saves version 1 in the chosen project and opens it', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: '/workflows/new?project=acme',
      initialState: state('operator'),
      routes: base('operator', {
        'POST /api/workflows': () => ({ status: 201, body: { id: WF, name: 'release-check', version: 1 } }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'İş adımı' }));
    // Without a name, Kaydet opens the settings.
    await user.click(screen.getByTestId('workflow-save'));
    expect(screen.getByTestId('workflow-status').textContent).toContain('geçerli bir ad');
    const settings = await screen.findByTestId('workflow-settings');
    await user.type(within(settings).getByLabelText('Ad'), 'release-check');
    await user.click(screen.getByTestId('workflow-save'));
    expect(await screen.findByRole('heading', { level: 1, name: 'release-check' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('workflow-status').textContent).toBe('Kaydedildi: v1.');
    });
    const post = r.requests.find((q) => q.method === 'POST' && q.url === '/api/workflows');
    const body = post?.body as {
      project: string;
      definition: { name: string; nodes: unknown[]; layout: unknown };
    };
    expect(body.project).toBe('acme');
    expect(body.definition.name).toBe('release-check');
    expect(body.definition.nodes).toHaveLength(1);
    expect(body.definition.layout).toEqual({ positions: { step: { x: 0, y: 0 } } });
  });

  it('existing: tidy runs the auto-layout; Doğrula shows the master’s issues on steps and links', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: `/workflows/${WF}`,
      initialState: state('operator'),
      routes: base('operator', {
        'POST /api/workflows/validate': () => ({
          status: 200,
          body: {
            ok: false,
            issues: [
              { path: 'nodes.1.prompt', code: 'undeclared_input:goal' },
              { path: 'edges.1', code: 'duplicate' },
              { path: 'defaults.limits.maxDurationSec', code: 'too_big' },
            ],
          },
        }),
      }),
    });
    expect(ids(await cards())).toEqual(['plan', 'build', 'verify']);
    expect(screen.queryByTestId('workflow-dirty')).toBeNull();
    // p17-workflow-canvas: the arrange button runs its remembered mode (left → right by default).
    await user.click(screen.getByTestId('toolbar-tidy'));
    const call = vi.mocked(layout.arrange).mock.calls.at(-1);
    expect(call?.[0]).toBe('lr');
    expect(call?.[1].map((n) => n.id)).toEqual(['plan', 'build', 'verify']);
    expect(call?.[2]).toEqual(DEFINITION.edges);
    await user.click(screen.getByTestId('toolbar-validate'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-status').textContent).toBe('3 sorun bulundu; adımlarda işaretli.');
    });
    const [plan, build] = await cards();
    expect(plan?.getAttribute('data-issues')).toBeNull();
    expect(build?.getAttribute('data-issues')).toBe('1');
    expect(screen.getByTestId('workflow-canvas').getAttribute('data-invalid-edges')).toBe('build->verify');
    // General issues in the settings, the step's own in its inspector.
    expect(within(screen.getByTestId('workflow-settings')).getByTestId('inspector-issues').textContent).toBe(
      'defaults.limits.maxDurationSec: çok büyük',
    );
    clickNode('build');
    expect((await screen.findByTestId('inspector-issues')).textContent).toBe(
      'prompt: tanımsız girdi “goal” (Ayarlar → Girdiler’e ekle)',
    );
    const v = r.requests.find((q) => q.url === '/api/workflows/validate');
    expect((v?.body as { project: string }).project).toBe('acme');
  });

  it('existing: the YAML panel and the canvas stay in sync both ways', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/workflows/${WF}`, initialState: state('operator'), routes: base() });
    await cards();
    await user.click(screen.getByTestId('toolbar-text'));
    const text = await screen.findByTestId<HTMLTextAreaElement>('workflow-text');
    expect(text.value).toContain('name: release-check');
    expect(text.value).toContain('- id: verify');
    // Canvas → text: deleting a step rewrites the text.
    clickNode('verify');
    await user.click(screen.getByTestId('toolbar-delete'));
    await waitFor(() => {
      expect(text.value).not.toContain('- id: verify');
    });
    // Text → canvas: a step added in YAML appears (after the pause), with a position.
    const yaml = text.value.replace(
      'edges:',
      '  - id: ship\n    role: integrator\n    prompt: Merge\nedges:\n  - from: build\n    to: ship',
    );
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: yaml } });
    await waitFor(
      async () => {
        expect(ids(await cards())).toEqual(['plan', 'build', 'ship']);
      },
      { timeout: 3000 },
    );
    // Text that does not parse keeps the last good document and says why.
    fireEvent.change(text, { target: { value: 'name: [' } });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-text-status').textContent).toContain('YAML okunamadı');
    });
    expect(ids(await cards())).toEqual(['plan', 'build', 'ship']);
  });

  it('existing: saves a new version with the base version; a conflict is said plainly', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    let conflict = true;
    const r = renderApp({
      path: `/workflows/${WF}`,
      initialState: state('operator'),
      routes: base('operator', {
        [`PUT /api/workflows/${WF}`]: () =>
          conflict
            ? {
                status: 409,
                body: { error: 'version_conflict', message: 'A newer version (v4) was saved meanwhile.' },
              }
            : { status: 200, body: { id: WF2, name: 'release-check', version: 4 } },
        [`GET /api/workflows/${WF2}/definition`]: () => ({
          status: 200,
          body: documentBody({ id: WF2, latestId: WF2, version: 4, latestVersion: 4 }),
        }),
      }),
    });
    await cards();
    const run = screen.getByRole('link', { name: 'Çalıştır' });
    expect(run.getAttribute('href')).toBe(`/jobs/new?mode=workflow&workflow=${WF}&project=acme`);
    expect(screen.getByTestId<HTMLButtonElement>('workflow-save').disabled).toBe(true);
    clickNode('build');
    const prompt = await screen.findByTestId('inspector-prompt');
    await user.clear(prompt);
    await user.type(prompt, 'Build and test');
    expect(screen.getByTestId('workflow-dirty')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Çalıştır (kaydedilen son sürüm çalışır)' })).toBeTruthy();
    await user.click(screen.getByTestId('workflow-save'));
    expect((await screen.findByTestId('api-error')).textContent).toBe(
      'A newer version (v4) was saved meanwhile.',
    );
    conflict = false;
    await user.click(screen.getByTestId('workflow-save'));
    await waitFor(async () => {
      expect((await screen.findByTestId('workflow-status')).textContent).toBe('Kaydedildi: v4.');
    });
    const put = r.requests.filter((q) => q.method === 'PUT').at(-1);
    const body = put?.body as {
      baseVersion: number;
      definition: { nodes: { id: string; prompt: string }[] };
    };
    expect(body.baseVersion).toBe(3);
    expect(body.definition.nodes.find((n) => n.id === 'build')?.prompt).toBe('Build and test');
  });

  it('viewer: read only — no save, no add, no handles; the runs tab lists this workflow’s runs', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/workflows/${WF}`, initialState: state('viewer'), routes: base('viewer') });
    await cards();
    expect(screen.getByTestId('workflow-readonly')).toBeTruthy();
    expect(screen.queryByTestId('workflow-save')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Çalıştır' })).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>('toolbar-add').disabled).toBe(true);
    expect(document.querySelector('.react-flow__handle.connectable')).toBeNull();
    clickNode('build');
    expect((await screen.findByTestId('inspector-prompt')).hasAttribute('readonly')).toBe(true);
    expect(screen.queryByTestId('inspector-delete')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Çalıştırmalar' }));
    const runs = await screen.findAllByTestId('workflow-run-row');
    expect(runs).toHaveLength(1);
    expect(
      within(runs[0] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/jobs/workflows/${RUN}`);
  });

  it('versions: lists versions and diffs one against the canvas', async () => {
    const user = userEvent.setup();
    const v2 = '99999999-9999-4999-8999-999999999999';
    renderApp({
      path: `/workflows/${WF}`,
      initialState: state('operator'),
      routes: base('operator', {
        [`GET /api/workflows/${WF}/versions`]: () => ({
          status: 200,
          body: {
            versions: [
              {
                id: WF,
                version: 3,
                createdBy: 'ayse',
                createdAt: iso(3_600_000),
                hash: 'h3',
                nodes: 3,
                edges: 2,
              },
              {
                id: v2,
                version: 2,
                createdBy: 'ali',
                createdAt: iso(7_200_000),
                hash: 'h2',
                nodes: 2,
                edges: 1,
              },
            ],
          },
        }),
        [`GET /api/workflows/${v2}/definition`]: () => ({
          status: 200,
          body: documentBody({
            id: v2,
            version: 2,
            definition: {
              ...DEFINITION,
              nodes: DEFINITION.nodes.slice(0, 2),
              edges: DEFINITION.edges.slice(0, 1),
            },
          }),
        }),
      }),
    });
    await cards();
    await user.click(screen.getByTestId('toolbar-versions'));
    const dialog = await screen.findByTestId('workflow-versions');
    const items = await within(dialog).findAllByTestId('workflow-version');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('v3açık'),
      expect.stringContaining('v2'),
    ]);
    await user.click(items[1] as HTMLElement);
    const diff = await within(dialog).findByTestId('workflow-diff');
    expect(diff.textContent).toContain('Tuvalde eklenen adımlarverify');
    expect(diff.textContent).toContain('build->verify');
    await user.click(within(dialog).getByRole('button', { name: 'Bu sürümden devam et' }));
    await waitFor(async () => {
      expect(ids(await cards())).toEqual(['plan', 'build']);
    });
    expect(screen.getByTestId('workflow-dirty')).toBeTruthy();
  });
});
