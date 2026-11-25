import type { ScreenRoute, ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: machine-config — the machine page's Araçlar, Sandbox ve politika and
 * Yapılandırma tabs (`?path=/machines/w1?tab=tools|sandbox|configuration`). Every machine of the harness answers
 * the same tool inventory, sandbox status (one profile ready, one needing Prepare), runtime policy (a canary
 * version staged) and a panel-managed configuration with a local ceiling, a blocked project and three generations.
 * Also used by apps/web/test/diyalog-w3-machine-config.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

export function configTools(workerId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId,
    supported: true,
    machineAdminEnabled: true,
    reportedAt: iso(2 * HOUR),
    inventory: {
      detectedAt: iso(2 * HOUR),
      ttlSec: 21_600,
      tools: [
        { name: 'git', found: true, version: '2.47.1', source: 'system', path: '/usr/bin/git' },
        { name: 'node', found: true, version: '24.11.0', source: 'system', path: '/usr/local/bin/node' },
        { name: 'python', found: false, source: 'system' },
        {
          name: 'playwright-chromium',
          found: true,
          version: '1248',
          source: 'managed',
          path: '/var/lib/remyral/tools/chromium-1248/chrome',
        },
      ],
      recipes: [
        {
          tool: 'browser',
          version: '1248',
          elevated: false,
          supported: true,
          installed: true,
          sizeBytes: 207_073_013,
        },
        {
          tool: 'ffmpeg',
          version: '7.1',
          elevated: false,
          supported: true,
          installed: false,
          sizeBytes: 81_000_000,
        },
        { tool: 'python', version: 'distro', elevated: true, supported: true, installed: false },
        {
          tool: 'cloudflared',
          version: '2025.9.1',
          elevated: false,
          supported: false,
          installed: false,
          unsupportedReason: 'bu mimari için paket yok',
        },
      ],
    },
    ...over,
  };
}

export function configSandbox(workerId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId,
    displayName: workerId,
    state: 'online',
    connected: true,
    supported: true,
    statusAt: iso(30 * 60_000),
    readyProfiles: ['runtime-sandbox'],
    unconfined: { allowed: false, generation: 1 },
    localLogin: true,
    lastPrepare: null,
    status: {
      checkedAt: iso(30 * 60_000),
      platform: 'linux',
      workerUser: { running: 'remyral', expected: 'remyral', source: 'configured' },
      privilegedPrepare: { available: true },
      profiles: [
        {
          profile: 'container',
          ready: false,
          code: 'container_engine_missing',
          reason: 'rootless Podman bulunamadı (container_engine_missing)',
          remedy: 'Makine → Sandbox ve politika → Hazırla (yetkili yardımcıyla)',
          fix: 'prepare_privileged',
          checks: ['container_engine', 'container_rootless', 'disk_space'],
        },
        {
          profile: 'runtime-sandbox',
          ready: true,
          runtimes: ['claude-code', 'codex'],
          confinement: { filesystem: 'os_user', egress: 'proxy_env_only', limits: 'cgroup' },
          concurrency: 3,
          checks: ['bubblewrap'],
        },
        {
          profile: 'host-restricted',
          ready: true,
          confinement: { filesystem: 'os_user', egress: 'none', limits: 'rlimits' },
          concurrency: 1,
          concurrencyNote: 'abonelik girişleri tek oturum paylaşır',
          checks: ['worker_identity'],
        },
        {
          profile: 'unconfined',
          ready: false,
          code: 'unconfined_not_enabled',
          fix: 'panel',
          checks: ['unconfined_policy'],
        },
      ],
      checks: [
        { id: 'worker_identity', status: 'ok' },
        { id: 'bubblewrap', status: 'ok' },
        {
          id: 'container_engine',
          status: 'failed',
          code: 'container_engine_missing',
          fix: 'prepare_privileged',
        },
        { id: 'container_rootless', status: 'warning', code: 'subuid_missing' },
        { id: 'disk_space', status: 'ok' },
        { id: 'unconfined_policy', status: 'not_applicable', code: 'unconfined_not_enabled' },
      ],
    },
    ...over,
  };
}

export function configPolicy(workerId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId,
    assignedPolicy: null,
    canary: true,
    effective: { policy: 'default', version: 4, stage: 'canary', documentHash: 'a'.repeat(64), document: {} },
    delivered: {
      policy: 'default',
      version: 4,
      stage: 'canary',
      hash: 'a'.repeat(64),
      at: iso(HOUR),
      generation: 9,
    },
    applied: { policy: 'default', version: 3, hash: 'b'.repeat(64), at: iso(3 * HOUR) },
    inSync: false,
    runtimes: [
      {
        runtime: 'claude-code',
        pinned: '2.1.0',
        installed: '2.1.0',
        status: 'match',
        allowUnpinned: false,
        authModes: ['local-login', 'secret-ref'],
        defaultProfile: 'sonnet',
        profiles: ['sonnet', 'opus'],
      },
      {
        runtime: 'codex',
        pinned: '0.163.0',
        installed: '0.162.1',
        status: 'mismatch',
        allowUnpinned: false,
        authModes: ['secret-ref'],
        defaultProfile: null,
        profiles: [],
      },
      {
        runtime: 'opencode',
        pinned: '1.19.0',
        installed: null,
        status: 'not-installed',
        allowUnpinned: true,
        authModes: ['secret-ref'],
        defaultProfile: null,
        profiles: [],
      },
    ],
    ...over,
  };
}

export const CONFIG_POLICIES = {
  items: [
    { name: 'default', activeVersion: 3, canaryVersion: 4, previousVersion: 2, workers: 5, canaryWorkers: 1 },
    {
      name: 'gpu',
      activeVersion: 1,
      canaryVersion: null,
      previousVersion: null,
      workers: 0,
      canaryWorkers: 0,
    },
  ],
};

const SPEC = {
  projects: ['mobil-app', 'vitrin-web'],
  allowedRuntimes: ['claude-code', 'codex'],
  maxParallelJobs: 3,
  sandboxProfiles: ['runtime-sandbox', 'host-restricted'],
  workspace: { retainFailed: 2, packageCacheMaxBytes: 10 * 1024 ** 3 },
  labels: { site: 'ev', disk: 'nvme' },
  runtimes: {
    'claude-code': { auth: { mode: 'local-login' }, modelProfile: 'sonnet' },
    codex: {
      auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'cred-openai' } },
      model: 'gpt-5.1',
    },
  },
};

function version(
  generation: number,
  cause: string,
  ago: number,
  note: string | null,
): Record<string, unknown> {
  return {
    generation,
    documentHash: String(generation).repeat(64).slice(0, 64),
    spec: generation === 3 ? SPEC : { ...SPEC, maxParallelJobs: 2, projects: ['mobil-app'] },
    document: {},
    cause,
    rollbackOf: null,
    changeNote: note,
    createdAt: iso(ago),
    createdBy: 'u1',
  };
}

export function configView(workerId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId,
    displayName: workerId,
    state: 'online',
    connected: true,
    supported: true,
    desired: version(3, 'edit', 2 * HOUR, 'vitrin-web eklendi'),
    delivered: { generation: 3, at: iso(2 * HOUR - 5_000) },
    report: {
      source: 'panel',
      generation: 3,
      documentHash: '3'.repeat(64),
      effective: {
        projects: ['mobil-app', 'vitrin-web'],
        allowedRuntimes: ['claude-code', 'codex'],
        maxParallelJobs: 3,
        sandboxProfiles: ['runtime-sandbox', 'host-restricted'],
        runtimeAuth: { 'claude-code': 'local-login', codex: 'secret-ref' },
        labels: { site: 'ev', disk: 'nvme' },
        runtimes: {
          'claude-code': { auth: { mode: 'local-login' }, modelProfile: 'sonnet' },
          codex: {
            auth: {
              mode: 'secret-ref',
              source: 'vault',
              credential: 'openai',
              env: 'OPENAI_API_KEY',
              present: true,
            },
            model: 'gpt-5.1',
          },
        },
      },
      ceiling: {
        projects: null,
        repoHosts: ['github.com'],
        allowedRuntimes: null,
        maxParallelJobs: 4,
        sandboxProfiles: null,
        pinnedRuntimes: [],
      },
      blocked: [
        { path: 'projects.ops-scripts', code: 'blocked_by_local_ceiling', detail: 'gitlab.com izinli değil' },
      ],
    },
    reportedAt: iso(2 * HOUR - 3_000),
    status: 'applied',
    drift: [],
    suggested: SPEC,
    projectOptions: [
      {
        id: 'mobil-app',
        name: 'Mobil uygulama',
        repositoryUrl: 'https://github.com/octo-org/mobil-app.git',
        kind: 'repository',
      },
      {
        id: 'vitrin-web',
        name: 'vitrin-web',
        repositoryUrl: 'https://github.com/octo-org/vitrin-web.git',
        kind: 'repository',
      },
      { id: 'arastirma', name: 'Araştırma', repositoryUrl: null, kind: 'workspace' },
      { id: 'ops-scripts', name: 'ops-scripts', repositoryUrl: null, kind: 'repository' },
    ],
    credentialOptions: [
      {
        id: 'cred-openai',
        name: 'openai',
        kind: 'api-key',
        env: 'OPENAI_API_KEY',
        sharedWithWorker: true,
        version: 2,
        state: 'active',
      },
      {
        id: 'cred-anthropic',
        name: 'anthropic',
        kind: 'api-key',
        env: 'ANTHROPIC_API_KEY',
        sharedWithWorker: false,
        version: 1,
        state: 'active',
      },
    ],
    modelOptions: [
      {
        id: 'sonnet',
        displayName: 'Sonnet',
        runtimes: ['claude-code'],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        enabled: true,
      },
      {
        id: 'gpt5',
        displayName: 'GPT-5.1',
        runtimes: ['codex', 'opencode'],
        provider: 'openai',
        model: 'gpt-5.1',
        enabled: true,
      },
    ],
    vault: { supported: true, keyFingerprint: 'SHA256:vK3x9Qm2LrT0aV7bK4nE1sW8yH3cJ6dF5gP' },
    ...over,
  };
}

export function configHistory(): Record<string, unknown> {
  return {
    items: [
      version(3, 'edit', 2 * HOUR, 'vitrin-web eklendi'),
      version(2, 'edit', 30 * HOUR, null),
      version(1, 'adopt', 200 * HOUR, 'yerel dosyadan devralındı'),
    ],
  };
}

const IDS = ['w1', 'w2', 'w3', 'w4', 'w5'];
const get =
  (body: (id: string) => unknown, id: string): ScreenRoute =>
  (_u, method) =>
    method === 'GET' ? body(id) : undefined;

const routes: Record<string, ScreenRoute> = { '/runtime-policies': get(() => CONFIG_POLICIES, '') };
for (const id of IDS) {
  routes[`/workers/${id}/tools`] = get(configTools, id);
  routes[`/workers/${id}/sandbox`] = get(configSandbox, id);
  routes[`/workers/${id}/runtime-policy`] = get(configPolicy, id);
  routes[`/workers/${id}/config`] = get(configView, id);
  routes[`/workers/${id}/config/history`] = get(configHistory, id);
}

export const ROUTES: ScreenRoutes = routes;
