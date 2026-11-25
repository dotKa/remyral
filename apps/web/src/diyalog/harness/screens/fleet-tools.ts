import type { ScreenRoutes } from './types';

/**
 * p17-ui-review harness fixtures: Makineler → Araçlar ve sürümler (`?path=/machines/tools`). Two machines — the
 * Windows one with two runtimes off their pinned version and an update waiting, the Linux one current — the four
 * runtimes and three tools in the catalog, one finished bulk action, no custom tools, the git readiness of both.
 */

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function item(id: string, kind: string, label: string, pinned: string, latest: string | null) {
  return {
    id,
    kind,
    label,
    ...(kind === 'tool' ? { recipe: id } : {}),
    pinned,
    latest,
    latestState: latest === null ? 'none' : 'ok',
    latestCheckedAt: iso(40 * MIN),
    sourceUrl: null,
  };
}

const CATALOG = [
  item('claude-code', 'runtime', 'Claude Code', '2.1.296', '2.1.300'),
  item('codex', 'runtime', 'Codex', '0.162.1', '0.162.1'),
  item('opencode', 'runtime', 'OpenCode', '1.14.2', '1.14.4'),
  item('pi', 'runtime', 'Pi', '0.9.3', '0.9.3'),
  item('git', 'tool', 'git', '2.56.0', '2.56.0'),
  item('node', 'tool', 'Node.js', '24.12.0', '24.12.0'),
  item('python', 'tool', 'Python', '3.13.2', '3.13.2'),
];

function cell(
  id: string,
  installed: string | null,
  pinned: string,
  status: string,
  action: Record<string, unknown> | null = null,
) {
  return {
    item: id,
    installed,
    source: installed === null ? null : 'managed',
    pinned,
    latest: CATALOG.find((c) => c.id === id)?.latest ?? null,
    status,
    action,
  };
}

function machine(id: string, name: string, os: string, cells: unknown[], over: Record<string, unknown> = {}) {
  return {
    workerId: id,
    name,
    os,
    arch: 'x64',
    connected: true,
    state: 'online',
    canary: false,
    policy: 'default',
    machineAdminEnabled: false,
    features: { remoteOps: true, tools: true, customTools: true, machineAdmin: true },
    inventoryAt: iso(12 * MIN),
    cells,
    ...over,
  };
}

const MACHINES = [
  machine(
    'w1',
    'atlas-win-01',
    'win32',
    [
      cell('claude-code', '2.1.296', '2.1.296', 'update_available'),
      cell('codex', '0.162.1', '0.162.1', 'current'),
      cell('opencode', '1.14.0', '1.14.2', 'pin_differs', { kind: 'runtime.install', version: '1.14.2' }),
      cell('pi', '0.9.1', '0.9.3', 'pin_differs', { kind: 'runtime.install', version: '0.9.3' }),
      cell('git', '2.56.0', '2.56.0', 'current'),
      cell('node', '24.11.0', '24.12.0', 'update_available', { kind: 'tool.install', version: '24.12.0' }),
      cell('python', null, '3.13.2', 'not_found', { kind: 'tool.install', version: '3.13.2' }),
    ],
    { canary: true },
  ),
  machine('w3', 'ridge-lnx-01', 'linux', [
    cell('claude-code', '2.1.296', '2.1.296', 'update_available'),
    cell('codex', '0.162.1', '0.162.1', 'current'),
    cell('opencode', '1.14.2', '1.14.2', 'current'),
    cell('pi', '0.9.3', '0.9.3', 'current'),
    cell('git', '2.56.0', '2.56.0', 'current'),
    cell('node', '24.12.0', '24.12.0', 'current'),
    cell('python', '3.13.2', '3.13.2', 'current'),
  ]),
];

const TOOLS = {
  generatedAt: iso(0),
  feed: { enabled: true, checkedAt: iso(40 * MIN) },
  catalog: CATALOG,
  machines: MACHINES,
  summary: { updates: 4, actionable: 3, machinesWithUpdates: 1, notFound: 1 },
};

const ACTIONS = {
  actions: [
    {
      id: 'a1',
      kind: 'runtime.install',
      item: 'codex',
      version: '0.162.1',
      rollout: 'canary-first',
      state: 'done',
      createdAt: iso(26 * 60 * MIN),
      createdBy: 'u1',
      expiresAt: iso(2 * 60 * MIN),
      finishedAt: iso(25 * 60 * MIN),
      counts: { succeeded: 2 },
      targets: [
        {
          workerId: 'w1',
          name: 'atlas-win-01',
          phase: 1,
          state: 'succeeded',
          version: '0.162.1',
          attempts: 1,
          reason: null,
          detail: null,
          opId: 'op1',
          jobId: null,
          updatedAt: iso(25 * 60 * MIN),
        },
        {
          workerId: 'w3',
          name: 'ridge-lnx-01',
          phase: 2,
          state: 'succeeded',
          version: '0.162.1',
          attempts: 1,
          reason: null,
          detail: null,
          opId: 'op2',
          jobId: null,
          updatedAt: iso(25 * 60 * MIN),
        },
      ],
    },
  ],
};

function git(id: string, name: string, problems: unknown[]) {
  return {
    workerId: id,
    displayName: name,
    connected: true,
    supported: true,
    readiness: {
      checkedAt: iso(9 * MIN),
      git: { present: true, version: '2.56.0', source: 'managed' },
      problems,
      jobsIsolated: true,
    },
    readinessAt: iso(9 * MIN),
    fixable: problems.length === 0 ? [] : ['erase_github_credentials'],
  };
}

export const ROUTES: ScreenRoutes = {
  '/fleet/tools': (url, method) => (method === 'GET' && !url.searchParams.has('worker') ? TOOLS : undefined),
  '/fleet/tools/actions': (_u, method) => (method === 'GET' ? ACTIONS : undefined),
  '/fleet/tools/recipes': (_u, method) =>
    method === 'GET'
      ? {
          recipes: [],
          limits: { hosts: ['github.com', 'objects.githubusercontent.com'], reservedNames: ['git', 'node'] },
        }
      : undefined,
  '/fleet/tools/settings': (_u, method) =>
    method === 'GET' ? { digestEnabled: true, lastDigestAt: iso(20 * 60 * MIN) } : undefined,
  '/fleet/git': (_u, method) =>
    method === 'GET'
      ? {
          machines: [
            git('w1', 'atlas-win-01', [
              { code: 'os_store_github', severity: 'warning', fix: 'erase_github_credentials' },
            ]),
            git('w3', 'ridge-lnx-01', []),
          ],
        }
      : undefined,
};
