// p13-fleet-tools (docs/design/p13-fleet-tools.md): Makine → Araçlar split into "Etkin" + Sistem / Worker’ın
// kurdukları tabs with versions, the fleet screen Makineler → Araçlar ve sürümler (matrix, Toplu işlem, actions,
// Özel araçlar, digest switch) and the read-only viewer.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import type { ToolInventory } from '../src/api/machineAdmin';
import { effectiveRows } from '../src/diyalog/screens/machines/tabs/tools-inventory';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const W = 'w1';
const B = `/api/workers/${W}`;
const NOW = '2026-10-20T10:00:00.000Z';

const WORKER = {
  id: W,
  name: 'desktop-pc',
  state: 'online',
  quarantineReason: null,
  connected: true,
  fingerprint: 'SHA256:x',
  os: 'win32',
  arch: 'x64',
  osVersion: '11',
  hostname: 'desktop-pc',
  workerVersion: '1.0.60',
  runningJobs: 0,
  lastSeenAt: new Date().toISOString(),
  createdAt: '2026-10-01T10:00:00.000Z',
  pairingExpiresAt: null,
  pairingExpired: false,
  drainRequestedAt: null,
  revokedAt: null,
  archivedAt: null,
  runtimes: [],
  credentials: [],
};

const TOOLS = {
  workerId: W,
  supported: true,
  machineAdminEnabled: false,
  reportedAt: NOW,
  inventory: {
    detectedAt: NOW,
    ttlSec: 21_600,
    tools: [
      { name: 'git', found: false, source: 'system' },
      { name: 'node', found: true, version: '24.11.0', source: 'system', path: 'C:\\node\\node.exe' },
      { name: 'python', found: false, source: 'system' },
      { name: 'git', found: true, version: '2.56.0.2', source: 'managed', path: 'C:\\remyral\\tools\\git' },
      { name: 'jq', found: true, version: '1.7.1', source: 'managed', details: { custom: true } },
    ],
    recipes: [],
  },
};

const CATALOG = [
  {
    id: 'claude-code',
    kind: 'runtime',
    label: 'Claude Code',
    pinned: '2.1.296',
    latest: '2.1.300',
    latestState: 'ok',
    latestCheckedAt: NOW,
    sourceUrl: 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
  },
  {
    id: 'git',
    kind: 'tool',
    label: 'git',
    recipe: 'git',
    pinned: '2.56.0.2',
    latest: null,
    latestState: 'failed',
    latestCheckedAt: NOW,
    sourceUrl: null,
  },
  {
    id: 'node',
    kind: 'tool',
    label: 'Node.js',
    pinned: '24.12.0',
    latest: '24.12.0',
    latestState: 'ok',
    latestCheckedAt: NOW,
    sourceUrl: null,
  },
  {
    id: 'custom:jq',
    kind: 'custom',
    label: 'jq',
    pinned: '1.7.1',
    latest: null,
    latestState: 'none',
    latestCheckedAt: null,
    sourceUrl: null,
  },
];

function machine(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId: id,
    name,
    os: 'win32',
    arch: 'x64',
    connected: true,
    state: 'online',
    canary: false,
    policy: 'default',
    machineAdminEnabled: false,
    features: { remoteOps: true, tools: true, customTools: true, machineAdmin: true },
    inventoryAt: NOW,
    cells: [],
    ...over,
  };
}

const W1_CELLS = [
  {
    item: 'git',
    installed: '2.56.0.2',
    source: 'managed',
    shadowed: null,
    pinned: '2.56.0.2',
    latest: null,
    status: 'current',
    action: null,
  },
  {
    item: 'node',
    installed: '24.11.0',
    source: 'system',
    pinned: '24.12.0',
    latest: '24.12.0',
    status: 'update_available',
    action: { kind: 'tool.install', version: '24.12.0' },
  },
  {
    item: 'claude-code',
    installed: '2.1.296',
    source: 'managed',
    pinned: '2.1.296',
    latest: '2.1.300',
    status: 'update_available',
    action: null,
    blocked: 'release_update_required',
    available: ['2.1.296'],
  },
  {
    item: 'custom:jq',
    installed: '1.7.1',
    source: 'managed',
    pinned: '1.7.1',
    latest: null,
    status: 'current',
    action: null,
  },
];

function fleet(machines: Record<string, unknown>[]): Record<string, unknown> {
  return {
    generatedAt: NOW,
    feed: { enabled: true, checkedAt: NOW },
    catalog: CATALOG,
    machines,
    summary: { updates: 2, actionable: 1, machinesWithUpdates: 1, notFound: 1 },
  };
}

const FLEET_ONE = fleet([machine(W, 'desktop-pc', { canary: true, cells: W1_CELLS })]);
const FLEET_ALL = fleet([
  machine(W, 'desktop-pc', { canary: true, cells: W1_CELLS }),
  machine('w2', 'kestrel-mac', {
    os: 'darwin',
    arch: 'arm64',
    connected: false,
    state: 'offline',
    cells: [
      {
        item: 'git',
        installed: null,
        source: null,
        pinned: '2.56.0.2',
        latest: null,
        status: 'not_found',
        action: { kind: 'tool.install', version: '2.56.0.2' },
      },
      {
        item: 'claude-code',
        installed: '2.1.290',
        source: 'managed',
        pinned: '2.1.296',
        latest: '2.1.300',
        status: 'pin_differs',
        action: { kind: 'runtime.install', version: '2.1.296' },
        available: ['2.1.296', '2.1.290'],
      },
    ],
  }),
]);

function action(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    kind: 'runtime.install',
    item: 'claude-code',
    version: '2.1.296',
    rollout: 'canary-first',
    state: 'held',
    createdAt: NOW,
    createdBy: 'u1',
    expiresAt: '2026-10-21T10:00:00.000Z',
    finishedAt: null,
    counts: { succeeded: 1, held: 1, failed: 1 },
    targets: [
      {
        workerId: W,
        name: 'desktop-pc',
        phase: 1,
        state: 'succeeded',
        version: '2.1.296',
        attempts: 1,
        reason: null,
        detail: null,
        opId: 'op1',
        jobId: null,
        updatedAt: NOW,
      },
      {
        workerId: 'w2',
        name: 'kestrel-mac',
        phase: 2,
        state: 'held',
        version: '2.1.296',
        attempts: 0,
        reason: null,
        detail: null,
        opId: null,
        jobId: null,
        updatedAt: NOW,
      },
      {
        workerId: 'w3',
        name: 'nova-lnx',
        phase: 2,
        state: 'failed',
        version: '2.1.296',
        attempts: 1,
        reason: 'version_not_available',
        detail: 'version 2.1.296 is not in the pinned set',
        opId: null,
        jobId: 'job-7',
        updatedAt: NOW,
      },
    ],
    ...over,
  };
}

const ok =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body });

const STEP_UP = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

/** A write that asks for step-up until `POST /auth/step-up` succeeded once. */
function stepUpGate(): { gate: (h: Handler) => Handler; route: Record<string, Handler> } {
  let done = false;
  return {
    gate: (h) => (req) => (done ? h(req) : STEP_UP),
    route: {
      'POST /api/auth/step-up': () => {
        done = true;
        return { status: 200, body: { stepUpValidUntil: '2099-10-13T10:10:00.000Z' } };
      },
    },
  };
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [WORKER] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/approvals?status=pending': ok({ items: [], nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    [`GET ${B}`]: ok(WORKER),
    [`GET /api/jobs?worker=${W}&state=RUNNING&limit=20`]: ok({ items: [], nextCursor: null }),
    [`GET ${B}/tools`]: ok(TOOLS),
    [`GET /api/fleet/tools?worker=${W}`]: ok(FLEET_ONE),
    'GET /api/fleet/tools': ok(FLEET_ALL),
    'GET /api/fleet/tools/actions': ok({ actions: [] }),
    'GET /api/fleet/tools/recipes': ok({
      recipes: [],
      limits: { hosts: ['github.com', 'objects.githubusercontent.com'], reservedNames: ['git', 'node'] },
    }),
    'GET /api/fleet/tools/settings': ok({ digestEnabled: true, lastDigestAt: null }),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // "Claude Code seç" checkboxes also match /code/: take the text field inside the step-up dialog.
  const field = await waitFor(() => {
    const f = screen
      .getAllByLabelText(/code|kod/i)
      .find((x) => x.closest('dialog') !== null && (x as HTMLInputElement).type !== 'checkbox');
    if (f === undefined) throw new Error('no step-up field yet');
    return f;
  });
  const dialog = field.closest('dialog') ?? document.body;
  await user.type(field, '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

const posts = (requests: RecordedRequest[], url: string): RecordedRequest[] =>
  requests.filter((r) => r.method === 'POST' && r.url === url);

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  stubCookies('__Host-ras-csrf=csrf-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('effectiveRows', () => {
  const inv = (tools: ToolInventory['tools'], effective?: ToolInventory['effective']): ToolInventory => ({
    detectedAt: NOW,
    ttlSec: 1,
    tools,
    recipes: [],
    ...(effective === undefined ? {} : { effective }),
  });

  it('the worker’s install wins over the system’s; the system one is shadowed', () => {
    const [git] = effectiveRows(
      inv([
        { name: 'git', found: true, version: '2.40.0', source: 'system' },
        { name: 'git', found: true, version: '2.50.0', source: 'managed' },
        { name: 'git', found: true, version: '2.56.0.2', source: 'managed' },
      ]),
    );
    expect(git).toMatchObject({
      source: 'managed',
      version: '2.56.0.2',
      shadowed: { source: 'system', version: '2.40.0' },
    });
  });

  it('uses the reported effective list when present', () => {
    const [git] = effectiveRows(
      inv(
        [
          { name: 'git', found: true, version: '2.40.0', source: 'system' },
          { name: 'git', found: true, version: '2.56.0.2', source: 'managed' },
        ],
        [{ name: 'git', source: 'config', version: '2.30.0', path: 'D:\\git\\git.exe' }],
      ),
    );
    expect(git).toMatchObject({ source: 'config', version: '2.30.0' });
  });
});

describe('Makine → Araçlar: Etkin + Sistem / Worker’ın kurdukları', () => {
  it('says which install is effective, splits the lists into tabs and filters them', async () => {
    const user = userEvent.setup();
    renderApp({ path: `/machines/${W}?tab=tools`, initialState: owner, routes: routes() });
    const panel = await screen.findByTestId('tools-panel');
    const rows = await within(panel).findAllByTestId('tool-row');
    expect(rows.map((r) => r.getAttribute('data-tool'))).toEqual(['git', 'node', 'python', 'jq']);
    const git = rows[0] as HTMLElement;
    await waitFor(() => {
      expect(within(git).getByTestId('version-status').textContent).toBe('güncel');
    });
    expect(within(git).getByTestId('tool-effective').textContent).toContain(
      'Etkin: Remyral’ın kurduğu 2.56.0.2',
    );
    expect(within(git).getByTestId('tool-effective').textContent).toContain('sistemde bulunamadı');
    expect(git.textContent).toContain('en son kontrol edilemedi');
    const node = rows[1] as HTMLElement;
    expect(within(node).getByTestId('version-status').textContent).toBe('güncelleme var');
    expect(within(node).getByTestId('tool-effective').textContent).toContain('Etkin: sistemdeki 24.11.0');
    expect(within(rows[2] as HTMLElement).getByText('bulunamadı')).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText('özel')).toBeTruthy();

    const sys = within(panel).getByRole('tab', { name: /Sistem/ });
    const mine = within(panel).getByRole('tab', { name: /Remyral’ın kurdukları/ });
    expect(sys.textContent).toContain('3');
    expect(mine.textContent).toContain('2');
    expect(sys.getAttribute('aria-selected')).toBe('true');
    const entries = (): string[] =>
      within(screen.getByTestId('tools-tabpanel'))
        .queryAllByTestId('tool-entry')
        .map((e) => `${e.getAttribute('data-tool') ?? ''}:${e.getAttribute('data-source') ?? ''}`);
    expect(entries()).toEqual(['git:system', 'node:system', 'python:system']);

    await user.click(within(panel).getByRole('button', { name: 'Bulunamadı' }));
    expect(entries()).toEqual(['git:system', 'python:system']);
    await user.click(within(panel).getByRole('button', { name: 'Güncelleme var' }));
    expect(entries()).toEqual(['node:system']);
    await user.click(within(panel).getByRole('button', { name: 'Tümü' }));

    await user.click(mine);
    expect(mine.getAttribute('aria-selected')).toBe('true');
    expect(entries()).toEqual(['git:managed', 'jq:managed']);
    const jq = screen.getAllByTestId('tool-entry')[1] as HTMLElement;
    expect(within(jq).getByText('özel')).toBeTruthy();
  });

  it('Güncelle starts a fleet action for this machine through step-up and shows its progress', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const started = action({
      id: 'a2',
      kind: 'tool.install',
      item: 'node',
      version: '24.12.0',
      rollout: 'all',
      state: 'running',
      counts: { sent: 1 },
      targets: [{ ...(action().targets as object[])[0], state: 'sent', phase: 2 }],
    });
    const { requests } = renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({
        ...s.route,
        'POST /api/fleet/tools/actions': s.gate(ok(started, 201)),
        'GET /api/fleet/tools/actions/a2': ok({ ...started, state: 'done', counts: { succeeded: 1 } }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'node: 24.12.0 sürümüne güncelle' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions').length).toBe(2);
    });
    expect(posts(requests, '/api/fleet/tools/actions').at(-1)?.body).toEqual({
      kind: 'tool.install',
      item: 'node',
      version: '24.12.0',
      workers: [W],
    });
    const progress = await screen.findByTestId('tool-fleet-action');
    expect(within(progress).getByTestId('target-state').textContent).toBe('gönderildi');
    expect(
      within(progress)
        .getByRole('link', { name: /Araçlar ve sürümler/ })
        .getAttribute('href'),
    ).toBe('/machines/tools');
  });

  it('an older master without the fleet view: tabs still work, no versions', async () => {
    renderApp({
      path: `/machines/${W}?tab=tools`,
      initialState: owner,
      routes: routes({ [`GET /api/fleet/tools?worker=${W}`]: ok({ error: 'x' }, 404) }),
    });
    const rows = await screen.findAllByTestId('tool-row');
    expect(rows).toHaveLength(4);
    expect(screen.queryAllByTestId('version-status')).toHaveLength(0);
    expect(screen.getByRole('tab', { name: /Remyral’ın kurdukları/ })).toBeTruthy();
  });
});

describe('Makineler → Araçlar ve sürümler', () => {
  it('renders the matrix with statuses in words and "kontrol edilemedi"', async () => {
    renderApp({ path: '/machines/tools', initialState: owner, routes: routes() });
    const matrix = await screen.findByTestId('fleet-matrix');
    expect(screen.getByTestId('fleet-summary').textContent).toContain('2 güncelleme, 1 makinede');
    const cell = (item: string, w: string): HTMLElement =>
      within(matrix)
        .getAllByTestId('matrix-cell')
        .find(
          (c) => c.getAttribute('data-item') === item && c.getAttribute('data-worker') === w,
        ) as HTMLElement;
    expect(cell('git', W).textContent).toContain('güncel');
    expect(cell('git', W).textContent).toContain('Remyral');
    expect(cell('git', 'w2').textContent).toContain('bulunamadı');
    expect(cell('claude-code', W).textContent).toContain('güncelleme var');
    expect(cell('claude-code', W).textContent).toContain('Yeni sürüm makine yazılımı sürümüyle gelir');
    expect(cell('claude-code', 'w2').textContent).toContain('pin’den farklı');
    const gitRow = within(matrix)
      .getAllByTestId('matrix-row')
      .find((r) => r.getAttribute('data-item') === 'git') as HTMLElement;
    expect(within(gitRow).getByTestId('item-versions').textContent).toContain('kontrol edilemedi');
    expect(within(matrix).getByText('kanarya')).toBeTruthy();
    expect(within(matrix).getByText('Runtime’lar')).toBeTruthy();
    expect(within(matrix).getByText('Özel araçlar')).toBeTruthy();
  });

  it('p17-ui-review: a machine card lists what needs something and folds the current items into one line', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/machines/tools', initialState: owner, routes: routes() });
    const matrix = await screen.findByTestId('fleet-matrix');
    await user.click(within(matrix).getByRole('button', { name: 'Makine başına' }));
    const card = within(matrix)
      .getAllByTestId('matrix-card')
      .find((c) => c.getAttribute('data-worker') === W) as HTMLElement;
    const folded = within(card).getByTestId('matrix-card-current');
    // git and jq are current on desktop-pc; node and claude-code need something.
    expect(folded.querySelector('summary')?.textContent).toBe('2 öğe güncel');
    expect(
      within(folded)
        .getAllByTestId('matrix-cell')
        .map((c) => c.getAttribute('data-item')),
    ).toEqual(['git', 'custom:jq']);
    expect(folded.hasAttribute('open')).toBe(false);
  });

  it('Toplu işlem: a runtime goes to /actions (canary-first), a custom tool to /admin-actions', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({
        ...s.route,
        'POST /api/fleet/tools/actions': s.gate(ok(action({ state: 'running' }), 201)),
        'POST /api/fleet/tools/admin-actions': s.gate(
          ok(action({ id: 'a3', kind: 'custom.install', item: 'custom:jq', state: 'running' }), 201),
        ),
      }),
    });
    const matrix = await screen.findByTestId('fleet-matrix');
    await user.click(within(matrix).getByRole('checkbox', { name: 'kestrel-mac seç' }));
    await user.click(within(matrix).getByRole('checkbox', { name: 'Claude Code seç' }));
    await user.click(screen.getByRole('button', { name: /Toplu işlem/ }));
    const dialog = await screen.findByTestId('bulk-dialog');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Araç').value).toBe('claude-code');
    expect(within(dialog).getByTestId('bulk-runtime-note').textContent).toContain('Ayarlar → Runtime’lar');
    expect(within(dialog).getByRole('link', { name: 'Ayarlar → Runtime’lar' }).getAttribute('href')).toBe(
      '/settings/runtimes',
    );
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: /Önce kanarya/ }).checked).toBe(true);
    expect(within(dialog).getByTestId('bulk-offline').textContent).toContain('1 çevrimdışı');
    await user.selectOptions(within(dialog).getByLabelText('Sürüm'), '2.1.290');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions').length).toBe(2);
    });
    expect(posts(requests, '/api/fleet/tools/actions').at(-1)?.body).toEqual({
      kind: 'runtime.install',
      item: 'claude-code',
      version: '2.1.290',
      workers: ['w2'],
      rollout: 'canary-first',
      expiresInHours: 24,
    });
    expect(await screen.findAllByTestId('fleet-action')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^Toplu işlem(?! başladı)/ }));
    const again = await screen.findByTestId('bulk-dialog');
    await user.selectOptions(within(again).getByLabelText('Araç'), 'custom:jq');
    await user.click(within(again).getByRole('radio', { name: 'Tüm makineler' }));
    expect(
      within(again).getByRole<HTMLInputElement>('radio', { name: /Her yetkili komutu sor/ }).checked,
    ).toBe(true);
    await user.click(within(again).getByRole('button', { name: 'Başlat' }));
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/admin-actions').length).toBeGreaterThan(0);
    });
    expect(posts(requests, '/api/fleet/tools/admin-actions').at(-1)?.body).toEqual({
      kind: 'custom.install',
      item: 'custom:jq',
      workers: 'all',
      rollout: 'all',
      expiresInHours: 24,
      approvalPolicy: 'ask-all',
    });
  });

  it('actions list: Turkish states and reasons, continue and retry', async () => {
    const s = stepUpGate();
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({
        ...s.route,
        'GET /api/fleet/tools/actions': ok({ actions: [action()] }),
        'POST /api/fleet/tools/actions/a1/continue': s.gate(ok(action({ state: 'running' }))),
        'POST /api/fleet/tools/actions/a1/retry': s.gate(ok(action({ state: 'running' }))),
      }),
    });
    const card = await screen.findByTestId('fleet-action');
    const states = within(card)
      .getAllByTestId('target-state')
      .map((x) => x.textContent);
    expect(states).toEqual(['başarılı', 'beklemede (kanarya sonrası)', 'başarısız']);
    expect(within(card).getByTestId('target-reason').textContent).toBe(
      'Bu sürüm bu makine yazılımı sürümünde sabit değil; doğrulanmamış olarak kurulabilir',
    );
    expect(within(card).getByText('version 2.1.296 is not in the pinned set')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe('/jobs/job-7');
    await user.click(within(card).getByRole('button', { name: 'Tümüne devam et' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions/a1/continue').length).toBe(2);
    });
    await user.click(
      within(screen.getByTestId('fleet-action')).getByRole('button', { name: 'Başarısızları yeniden dene' }),
    );
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions/a1/retry').at(-1)?.body).toEqual({});
    });
  });

  it('custom recipe form: host allowlist and sha256 checked here; server issues in Turkish', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({
        'POST /api/fleet/tools/recipes': ok(
          {
            error: 'recipe_invalid',
            message: 'Recipe is invalid.',
            issues: [{ path: 'platforms.win32-x64.entry', code: 'windows_entry_not_executable' }],
          },
          400,
        ),
      }),
    });
    const panel = await screen.findByTestId('custom-tools');
    await user.click(await within(panel).findByRole('button', { name: 'Yeni özel araç' }));
    const dialog = await screen.findByTestId('recipe-dialog');
    expect(within(dialog).getByTestId('recipe-hosts').textContent).toContain('github.com');
    await user.type(within(dialog).getByLabelText('Ad'), 'jq');
    await user.type(within(dialog).getByLabelText('Başlık'), 'jq');
    await user.type(within(dialog).getByLabelText('Sürüm'), '1.7.1');
    await user.selectOptions(within(dialog).getByLabelText('Windows x64'), 'download');
    const win = within(dialog).getByTestId('platform-win32-x64');
    await user.type(within(win).getByLabelText('Adres (https)'), 'https://evil.example.com/jq.zip');
    await user.type(within(win).getByLabelText('sha256'), 'abc');
    await user.type(within(win).getByLabelText('Boyut (bayt)'), '1000');
    await user.type(within(win).getByLabelText('Giriş dosyası'), 'jq.exe');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    expect(win.textContent).toContain('evil.example.com: Bu adresten indirmeye izin verilmiyor');
    expect(win.textContent).toContain('sha256: 64 onaltılık karakter.');
    expect(posts(requests, '/api/fleet/tools/recipes')).toHaveLength(0);

    const url = within(win).getByLabelText('Adres (https)');
    await user.clear(url);
    await user.type(url, 'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq.zip');
    const sha = within(win).getByLabelText('sha256');
    await user.clear(sha);
    await user.type(sha, 'a'.repeat(64));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/recipes')).toHaveLength(1);
    });
    expect(posts(requests, '/api/fleet/tools/recipes')[0]?.body).toEqual({
      recipe: {
        name: 'jq',
        title: 'jq',
        version: '1.7.1',
        pinPackageVersion: false,
        platforms: {
          'win32-x64': {
            kind: 'download',
            url: 'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq.zip',
            sha256: 'a'.repeat(64),
            size: 1000,
            format: 'zip',
            entry: 'jq.exe',
          },
        },
        check: { args: ['--version'] },
      },
    });
    const issues = await within(dialog).findByTestId('recipe-issues');
    expect(issues.textContent).toContain('Windows’ta giriş dosyası .exe / .cmd / .bat olmalı');
  });

  it('a viewer reads everything but gets no buttons', async () => {
    renderApp({
      path: '/machines/tools',
      initialState: viewer,
      routes: routes({ 'GET /api/fleet/tools/actions': ok({ actions: [action()] }) }),
    });
    const matrix = await screen.findByTestId('fleet-matrix');
    await screen.findByTestId('fleet-action');
    expect(within(matrix).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Toplu işlem/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sürümleri şimdi kontrol et' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tümüne devam et' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yeni özel araç' })).toBeNull();
    const digest = await screen.findByTestId('digest-switch');
    expect((digest as HTMLButtonElement).disabled).toBe(true);
  });

  it('the machine list links here with the update count', async () => {
    renderApp({ path: '/machines', initialState: owner, routes: routes() });
    const link = await screen.findByTestId('fleet-tools-link');
    expect(link.getAttribute('href')).toBe('/machines/tools');
    await waitFor(() => {
      expect(within(link).getByTestId('fleet-updates-badge').textContent).toBe('2 güncelleme');
    });
  });
});

describe('Araçlar ve sürümler → Belirli bir sürüme yükselt (p17-update-channel)', () => {
  const upgrade = (state: string) => ({
    id: '00000000-0000-4000-8000-0000000000aa',
    kind: 'runtime',
    item: 'codex',
    version: '0.170.0',
    fromVersion: '0.164.0',
    state,
    canaryResult: state === 'done' ? 'passed' : null,
    actionId: null,
    policies: {},
    createdAt: '2026-10-26T08:00:00.000Z',
  });

  it('the owner starts an exact version on the canary, then confirms it', async () => {
    const user = userEvent.setup();
    let listed = [upgrade('canary')];
    const r = renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({
        'GET /api/owner-upgrades': () => ({ status: 200, body: { upgrades: listed } }),
        'POST /api/owner-upgrades': ok(upgrade('canary')),
        [`POST /api/owner-upgrades/${upgrade('canary').id}/confirm`]: () => {
          listed = [upgrade('done')];
          return { status: 200, body: upgrade('done') };
        },
      }),
    });
    const panel = await screen.findByTestId('owner-upgrades');
    await user.type(within(panel).getByLabelText('Tam sürüm'), '0.170.0');
    await user.click(within(panel).getByRole('button', { name: /Kanaryada başlat/ }));
    await waitFor(() => {
      const post = r.requests.find((q) => q.method === 'POST' && q.url === '/api/owner-upgrades');
      expect(post?.body).toEqual({ kind: 'runtime', item: 'codex', version: '0.170.0' });
    });
    await user.click(await within(panel).findByRole('button', { name: /Onayla ve tüm makinelere yay/ }));
    expect(await within(panel).findByText('Yayıldı')).toBeTruthy();
    expect(within(panel).getByText('kanarya doğruladı')).toBeTruthy();
  });
});
