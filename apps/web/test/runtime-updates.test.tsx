// p16-runtime-updates (docs/design/p16-runtime-updates.md §4): runtime versions above the release pin in the console —
// the matrix offer and the "Doğrulanmamış sürüm (pin: X)" badge, the split counter, Toplu işlem's unverified option,
// a 409 nothing_to_do listed per machine in Turkish (never swallowed), Makine → Runtime’lar's "Doğrulanmamış olarak
// kur" / "Pin’e geri dön", the verification candidates panel, Ayarlar → Güvenlik → Filo, and the chat card.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import type { ChatDraft } from '../src/api/chat';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { opsStatusFixture } from '../src/diyalog/harness/screens/w3-machine-runtimes';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const viewer: AuthState = { ...owner, user: { id: 'u2', username: 'viewer', role: 'viewer' } };

const NOW = '2026-10-23T10:00:00.000Z';
const PIN = '0.162.1';
const NEXT = '0.164.0';

const CATALOG = [
  {
    id: 'codex',
    kind: 'runtime',
    label: 'Codex',
    pinned: PIN,
    latest: NEXT,
    latestState: 'ok',
    latestCheckedAt: NOW,
    sourceUrl: 'https://www.npmjs.com/package/@openai/codex',
  },
];

function machine(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId: id,
    name,
    os: 'linux',
    arch: 'x64',
    connected: true,
    state: 'online',
    canary: false,
    policy: 'default',
    machineAdminEnabled: false,
    features: {
      remoteOps: true,
      tools: true,
      customTools: true,
      machineAdmin: true,
      runtimeUnverified: true,
    },
    inventoryAt: NOW,
    cells: [],
    ...over,
  };
}

const OFFER_CELL = {
  item: 'codex',
  installed: PIN,
  source: 'managed',
  pinned: PIN,
  latest: NEXT,
  status: 'update_available',
  action: null,
  available: [PIN],
  unverifiedAction: { kind: 'runtime.install', version: NEXT },
  unverifiedSupported: true,
};
const ACTIVE_CELL = {
  item: 'codex',
  installed: NEXT,
  source: 'managed',
  pinned: PIN,
  latest: NEXT,
  status: 'current',
  action: null,
  available: [PIN],
  unverifiedActive: { version: NEXT, pin: PIN },
  rollback: { kind: 'runtime.install', version: PIN },
};
const OLD_CELL = {
  item: 'codex',
  installed: PIN,
  source: 'managed',
  pinned: PIN,
  latest: NEXT,
  status: 'update_available',
  action: null,
  blocked: 'worker_update_required',
  available: [PIN],
};

const CANDIDATE = {
  runtime: 'codex',
  version: NEXT,
  pin: PIN,
  package: '@openai/codex',
  packageVersion: NEXT,
  integrity: `sha512-${'a'.repeat(86)}==`,
  resolvedAt: NOW,
  verifyState: 'passed',
  verifiedAt: NOW,
  lock: { sha256: 'b'.repeat(64), bytes: 1200, workerId: 'w1' },
  lastRun: {
    id: 'r1',
    workerId: 'w1',
    workerName: 'nova-lnx',
    os: 'linux',
    arch: 'x64',
    trigger: 'feed',
    state: 'passed',
    checks: [
      { id: 'integrity', status: 'passed', required: true },
      { id: 'version', status: 'passed', required: true },
      { id: 'adapter_probe', status: 'passed', required: true },
      { id: 'headless_prompt', status: 'skipped', required: false },
      { id: 'contract_suite', status: 'skipped', required: false },
    ],
    reason: null,
    detail: null,
    startedAt: NOW,
    finishedAt: NOW,
  },
};

function fleet(
  machines: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    generatedAt: NOW,
    feed: { enabled: true, checkedAt: NOW },
    catalog: CATALOG,
    machines,
    summary: {
      updates: 3,
      actionable: 1,
      installable: 1,
      releaseRequired: 1,
      unverified: 1,
      unverifiedActive: 1,
      machinesWithUpdates: 2,
      notFound: 0,
    },
    policy: { unverifiedRuntimeUpdates: true },
    candidates: [
      CANDIDATE,
      { ...CANDIDATE, version: '0.165.0', verifyState: 'none', lock: null, lastRun: null },
    ],
    ...over,
  };
}

const FLEET = fleet([
  machine('w1', 'nova-lnx', { canary: true, cells: [OFFER_CELL] }),
  machine('w2', 'kestrel-mac', { cells: [ACTIVE_CELL] }),
  machine('w3', 'old-box', {
    features: {
      remoteOps: true,
      tools: true,
      customTools: true,
      machineAdmin: true,
      runtimeUnverified: false,
    },
    cells: [OLD_CELL],
  }),
]);

const ok =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body });

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/quotas/status': ok({ pauses: [] }),
    'GET /api/approvals?status=pending': ok({ items: [], nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/fleet/tools': ok(FLEET),
    'GET /api/fleet/tools/actions': ok({ actions: [] }),
    'GET /api/fleet/tools/recipes': ok({ recipes: [], limits: { hosts: [], reservedNames: [] } }),
    'GET /api/fleet/tools/settings': ok({ digestEnabled: true, lastDigestAt: null }),
    'POST /api/auth/step-up': ok({ stepUpValidUntil: '2099-10-13T10:10:00.000Z' }),
    ...extra,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

function action(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a9',
    kind: 'runtime.install',
    item: 'codex',
    version: NEXT,
    rollout: 'all',
    state: 'running',
    createdAt: NOW,
    createdBy: 'u1',
    expiresAt: NOW,
    finishedAt: null,
    counts: { sent: 1 },
    targets: [],
    ...over,
  };
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

const cellOf = (matrix: HTMLElement, w: string): HTMLElement =>
  within(matrix)
    .getAllByTestId('matrix-cell')
    .find(
      (c) => c.getAttribute('data-item') === 'codex' && c.getAttribute('data-worker') === w,
    ) as HTMLElement;

describe('Araçlar ve sürümler: unverified runtime versions', () => {
  it('the matrix offers the newer version, shows the badge and splits the counter', async () => {
    renderApp({ path: '/machines/tools', initialState: owner, routes: routes() });
    const matrix = await screen.findByTestId('fleet-matrix');
    expect(within(cellOf(matrix, 'w1')).getByTestId('cell-unverified-offer').textContent).toBe(
      `Doğrulanmamış olarak kurulabilir: ${NEXT}`,
    );
    // The offer replaces the old "comes with a release" line.
    expect(within(cellOf(matrix, 'w1')).queryByTestId('cell-blocked')).toBeNull();
    expect(within(cellOf(matrix, 'w2')).getByTestId('unverified-badge').textContent).toBe(
      `Doğrulanmamış sürüm (pin: ${PIN})`,
    );
    expect(within(cellOf(matrix, 'w3')).getByTestId('cell-blocked').textContent).toBe(
      'Makine yazılımı güncellenmeli',
    );
    expect(screen.getByTestId('fleet-summary-split').textContent).toBe(
      '1 kurulabilir · 1 makine yazılımı sürümü gerektirir · 1 doğrulanmamış sürüm çalışıyor',
    );
  });

  it('Toplu işlem installs the newer version as unverified', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({ 'POST /api/fleet/tools/actions': ok(action(), 201) }),
    });
    await screen.findByTestId('fleet-matrix');
    await user.click(screen.getByRole('button', { name: /Toplu işlem/ }));
    const dialog = await screen.findByTestId('bulk-dialog');
    const box = within(dialog).getByTestId('bulk-unverified');
    expect(box.textContent).toContain(`Kaynakta pin’den yeni bir sürüm var (${NEXT})`);
    // An update takes the newer version by default (the pin alone is already installed: nothing to do).
    expect(within(box).getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(within(dialog).getByTestId('bulk-unverified-version').textContent).toContain(NEXT);
    expect(within(dialog).queryByLabelText('Sürüm')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions').at(-1)?.body).toEqual({
        kind: 'runtime.install',
        item: 'codex',
        version: NEXT,
        unverified: true,
        workers: 'all',
        rollout: 'canary-first',
        expiresInHours: 24,
      });
    });
    // The owner sees that it started and can jump to its progress (the panel sits below the matrix).
    const started = await screen.findByTestId('fleet-action-started');
    expect(started.textContent).toContain('Toplu işlem başladı');
    expect(within(started).getByTestId('fleet-action-see')).toBeTruthy();
  });

  it('a 409 nothing_to_do lists every machine with its reason in Turkish', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({
        'POST /api/fleet/tools/actions': ok(
          {
            error: 'nothing_to_do',
            message: 'None of the chosen machines can take this action now.',
            skipped: [
              { workerId: 'w1', reason: 'version_not_available' },
              { workerId: 'w2', reason: 'already_current' },
              { workerId: 'w3', reason: 'worker_update_required' },
            ],
          },
          409,
        ),
      }),
    });
    await screen.findByTestId('fleet-matrix');
    await user.click(screen.getByRole('button', { name: /Toplu işlem/ }));
    const dialog = await screen.findByTestId('bulk-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));
    const list = await within(dialog).findByTestId('skipped-reasons');
    const lines = within(list)
      .getAllByTestId('skipped-reason')
      .map((x) => x.textContent);
    expect(lines).toEqual([
      'nova-lnx: Bu sürüm bu makine yazılımı sürümünde sabit değil; doğrulanmamış olarak kurulabilir',
      'kestrel-mac: Zaten bu sürüm kurulu',
      'old-box: Makine yazılımı güncellenmeli',
    ]);
  });

  it('verification candidates: honest wording, checks in words, "Şimdi doğrula" through step-up', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({
        'POST /api/fleet/tools/runtime-candidates/verify': ok({ id: 'r2', workerId: 'w1' }, 202),
      }),
    });
    const panel = await screen.findByTestId('runtime-candidates');
    expect(within(panel).getByTestId('candidates-honest').textContent).toContain(
      'Model istemi ve sözleşme testi otomatik değildir',
    );
    const [passed, fresh] = within(panel).getAllByTestId('runtime-candidate');
    expect(passed?.getAttribute('data-state')).toBe('passed');
    expect(passed?.textContent).toContain('doğrulanmış aday');
    const checks = within(passed as HTMLElement)
      .getAllByTestId('candidate-check')
      .map((x) => x.textContent);
    expect(checks).toContain('Model istemi: otomatik değil');
    expect(checks).toContain('Bütünlük (sha512): geçti');
    // A passed candidate is final: no "verify now"; it offers the lock for the promotion.
    expect(within(passed as HTMLElement).queryByRole('button', { name: 'Şimdi doğrula' })).toBeNull();
    expect(within(passed as HTMLElement).getByRole('button', { name: /Kilit dosyası/ })).toBeTruthy();
    await user.click(within(fresh as HTMLElement).getByRole('button', { name: 'Şimdi doğrula' }));
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/runtime-candidates/verify').at(-1)?.body).toEqual({
        runtime: 'codex',
        version: '0.165.0',
      });
    });
    expect((await within(fresh as HTMLElement).findByTestId('candidate-started')).textContent).toContain(
      'w1',
    );
  });

  it('a viewer sees the candidates and the badge but no buttons', async () => {
    renderApp({ path: '/machines/tools', initialState: viewer, routes: routes() });
    const panel = await screen.findByTestId('runtime-candidates');
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByTestId('unverified-badge')).toHaveLength(1);
  });

  it('policy off: the bulk dialog says why the newer version cannot be installed', async () => {
    const user = userEvent.setup();
    const off = fleet(
      [machine('w1', 'nova-lnx', { cells: [{ ...OLD_CELL, blocked: 'release_update_required' }] })],
      {
        policy: { unverifiedRuntimeUpdates: false },
      },
    );
    renderApp({
      path: '/machines/tools',
      initialState: owner,
      routes: routes({ 'GET /api/fleet/tools': ok(off) }),
    });
    await screen.findByTestId('fleet-matrix');
    await user.click(screen.getByRole('button', { name: /Toplu işlem/ }));
    const dialog = await screen.findByTestId('bulk-dialog');
    expect(within(dialog).queryByTestId('bulk-unverified')).toBeNull();
    expect(within(dialog).getByTestId('bulk-unverified-off').textContent).toContain(
      'Ayarlar → Güvenlik → Filo',
    );
  });
});

describe('Makine → Runtime’lar: unverified install and back to the pin', () => {
  const W2 = {
    id: 'w2',
    name: 'kestrel-mac',
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: 'SHA256:w2',
    os: 'darwin',
    arch: 'arm64',
    osVersion: '15',
    hostname: 'kestrel-mac',
    workerVersion: '1.0.70',
    runningJobs: 0,
    lastSeenAt: NOW,
    createdAt: NOW,
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    archivedAt: null,
    runtimes: [],
    credentials: [],
  };
  const machineRoutes = (cell: Record<string, unknown>, extra: Record<string, Handler> = {}) =>
    routes({
      'GET /api/workers': ok({ workers: [W2] }),
      'GET /api/workers/w2': ok(W2),
      'GET /api/jobs?worker=w2&state=RUNNING&limit=20': ok({ items: [], nextCursor: null }),
      'GET /api/workers/w2/ops': ok(opsStatusFixture('w2')),
      'GET /api/fleet/tools?worker=w2': ok(fleet([machine('w2', 'kestrel-mac', { cells: [cell] })])),
      'GET /api/usage-limits/overview': ok({
        generatedAt: NOW,
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      }),
      ...extra,
    });

  it('"Doğrulanmamış olarak kur" is confirmed, then one fleet action on this machine', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes(OFFER_CELL, { 'POST /api/fleet/tools/actions': ok(action(), 201) }),
    });
    const codex = await screen.findByTestId('runtime-card-codex');
    const button = await within(codex).findByRole('button', { name: `Doğrulanmamış olarak kur (${NEXT})` });
    await user.click(button);
    expect(posts(requests, '/api/fleet/tools/actions')).toHaveLength(0);
    expect(codex.textContent).toContain(`pin (${PIN}) dışında bir sürüm`);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: `Doğrulanmamış olarak kur (${NEXT})`,
      }),
    );
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions').at(-1)?.body).toEqual({
        kind: 'runtime.install',
        item: 'codex',
        version: NEXT,
        unverified: true,
        workers: ['w2'],
        rollout: 'all',
      });
    });
    expect(await within(codex).findByTestId('runtime-update-started')).toBeTruthy();
  });

  it('an unverified version shows the badge and goes back to the pin', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/machines/w2?tab=runtimes',
      initialState: owner,
      routes: machineRoutes(ACTIVE_CELL, {
        'POST /api/fleet/tools/actions': ok(action({ version: PIN }), 201),
      }),
    });
    const codex = await screen.findByTestId('runtime-card-codex');
    expect((await within(codex).findByTestId('unverified-badge')).textContent).toBe(
      `Doğrulanmamış sürüm (pin: ${PIN})`,
    );
    await user.click(within(codex).getByRole('button', { name: `Pin’e geri dön (${PIN})` }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: `Pin’e geri dön (${PIN})` }),
    );
    await waitFor(() => {
      expect(posts(requests, '/api/fleet/tools/actions').at(-1)?.body).toEqual({
        kind: 'runtime.install',
        item: 'codex',
        version: PIN,
        workers: ['w2'],
        rollout: 'all',
      });
    });
  });
});

describe('Ayarlar → Güvenlik → Filo', () => {
  it('the switch is on by default and sends only the fleet part', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    const view = {
      version: 5,
      document: { preset: 'dengeli' },
      effective: {
        preset: 'dengeli',
        customized: false,
        stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
        events: { 'security.policy': false },
        autonomy: {
          newProjectsHostExecution: true,
          newProjectsAutoApprove: true,
          jobApproval: 'allow-all',
          autoApprove: {},
          chatDirect: true,
          maxJobMinutes: 10080,
          autoMode: false,
          autoRetryMax: 0,
        },
        apiTokens: { personal: true, maxDays: 365, eventGrants: false },
        fleet: { unverifiedRuntimeUpdates: true },
      },
      updatedAt: null,
      updatedBy: null,
      catalog: { events: [] },
    };
    renderApp({
      path: '/settings/security?tab=fleet',
      initialState: owner,
      routes: routes({
        'GET /api/security/policy': ok(view),
        'PUT /api/security/policy': (req) => {
          body = req.body;
          return {
            status: 200,
            body: {
              ...view,
              version: 6,
              effective: { ...view.effective, fleet: { unverifiedRuntimeUpdates: false } },
              changed: ['fleet.unverifiedRuntimeUpdates'],
            },
          };
        },
      }),
    });
    const panel = await screen.findByTestId('security-fleet');
    const sw = within(panel).getByTestId('fleet-unverified');
    expect(sw.getAttribute('aria-checked') ?? (sw as HTMLInputElement).checked.toString()).toBe('true');
    await user.click(sw);
    await user.click(await screen.findByRole('button', { name: /^Kaydet/ }));
    await waitFor(() => {
      expect(body).toEqual({ fleet: { unverifiedRuntimeUpdates: false }, expectedVersion: 5 });
    });
  });

  it('p16-zip-job-input: executables as job inputs are off unless the master says otherwise; the switch sends only its part', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    const effective = {
      preset: 'serbest',
      customized: false,
      stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
      events: { 'security.policy': false },
      autonomy: {
        newProjectsHostExecution: true,
        newProjectsAutoApprove: true,
        jobApproval: 'allow-all',
        autoApprove: {},
        chatDirect: true,
        maxJobMinutes: 10080,
        autoMode: false,
        autoRetryMax: 0,
      },
      apiTokens: { personal: true, maxDays: 365, eventGrants: false },
      fleet: { unverifiedRuntimeUpdates: true },
    };
    const view = {
      version: 5,
      document: { preset: 'serbest' },
      effective,
      updatedAt: null,
      updatedBy: null,
      catalog: { events: [] },
    };
    renderApp({
      path: '/settings/security?tab=fleet',
      initialState: owner,
      routes: routes({
        'GET /api/security/policy': ok(view),
        'PUT /api/security/policy': (req) => {
          body = req.body;
          return {
            status: 200,
            body: {
              ...view,
              version: 6,
              effective: { ...effective, inputs: { executables: true } },
              changed: ['inputs.executables'],
            },
          };
        },
      }),
    });
    const panel = await screen.findByTestId('security-inputs');
    const sw = within(panel).getByTestId('inputs-executables');
    expect(sw.getAttribute('aria-checked') ?? (sw as HTMLInputElement).checked.toString()).toBe('false');
    await user.click(sw);
    await user.click(await screen.findByRole('button', { name: /^Kaydet/ }));
    await waitFor(() => {
      expect(body).toEqual({ inputs: { executables: true }, expectedVersion: 5 });
    });
  });
});

describe('the chat card of draft_runtime_update', () => {
  const t = messagesFor('tr');
  const f = { dateTime: (x: string) => x } as unknown as Parameters<typeof summarizeDraft>[2];
  const draft = (payload: Record<string, unknown>): ChatDraft =>
    ({ id: 'd1', kind: 'runtime_update', payload, state: 'proposed' }) as unknown as ChatDraft;

  it('names the kind, the version, the machines, the skip reasons and the unverified label', () => {
    expect(draftKindText('runtime_update', t)).toBe('Runtime güncellemesi');
    const s = summarizeDraft(
      draft({
        runtime: 'codex',
        workers: 'all',
        unverified: true,
        rollback: false,
        rollout: 'canary-first',
        pin: PIN,
        targets: [
          { workerId: 'w1', name: 'nova-lnx', installed: PIN, version: NEXT, unverified: true, canary: true },
        ],
        skipped: [{ workerId: 'w3', name: 'old-box', reason: 'worker_update_required', version: NEXT }],
      }),
      t,
      f,
    );
    expect(s.key.map((x) => x.v)).toEqual(['codex', NEXT, '1', 'önce kanarya']);
    expect(s.details.map((x) => x.v)).toEqual([
      `nova-lnx: ${PIN} → ${NEXT}`,
      'old-box almaz: Makine yazılımı güncellenmeli',
    ]);
    expect(s.warnings[0]?.text).toContain(`Doğrulanmamış sürüm (pin: ${PIN})`);
  });

  it('a rollback says the pin and carries no unverified warning', () => {
    const s = summarizeDraft(
      draft({
        runtime: 'codex',
        rollback: true,
        unverified: false,
        rollout: 'all',
        pin: PIN,
        targets: [{ workerId: 'w2', name: 'kestrel-mac', installed: NEXT, version: PIN }],
        skipped: [],
      }),
      t,
      f,
    );
    expect(s.key[1]?.v).toBe(`Pin ${PIN} sürümüne geri dönüş`);
    expect(s.warnings).toHaveLength(0);
  });
});
