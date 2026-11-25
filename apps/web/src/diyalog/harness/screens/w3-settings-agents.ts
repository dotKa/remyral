import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Ayarlar → Runtime’lar and Modeller. Two runtime policies ("default"
 * active v2, "gpu" with a canary v4), the pins template, a model catalog with one disabled profile and a policy still
 * carrying an older copy, defaults for all projects and one project. Also used by
 * apps/web/test/diyalog-w3-settings-agents.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 60 * 60_000;

function rule(version: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    authModes: ['secret-ref', 'local-login'],
    allowUnpinned: false,
    allowUnverified: false,
    modelProfiles: [],
    defaultProfile: null,
    ...over,
  };
}

export const W3_TEMPLATE = {
  runtimes: {
    'claude-code': rule('2.1.296'),
    codex: rule('0.162.1'),
    pi: rule('1.1.0'),
    opencode: rule('1.19.0'),
  },
  projectProfiles: {},
};

const DEFAULT_DOC = {
  runtimes: {
    'claude-code': rule('2.1.296', {
      modelProfiles: [
        { name: 'sonnet-balanced', provider: 'anthropic', model: 'claude-sonnet-4-5', params: {} },
      ],
      defaultProfile: 'sonnet-balanced',
    }),
    codex: rule('0.162.1', { allowUnverified: true }),
    opencode: rule('1.19.0', { authModes: ['secret-ref'] }),
  },
  projectProfiles: {},
};

function version(n: number, document: unknown, note: string | null, ago: number): Record<string, unknown> {
  return {
    version: n,
    documentHash: 'a'.repeat(64),
    document,
    changeNote: note,
    createdAt: iso(ago),
    createdBy: null,
  };
}

export const W3_POLICIES = [
  {
    name: 'default',
    description: null,
    activeVersion: 2,
    canaryVersion: null,
    previousVersion: 1,
    active: version(2, DEFAULT_DOC, 'Codex için ilk canlı çalıştırma', 3 * DAY),
    canary: null,
    workers: 5,
    canaryWorkers: 0,
    updatedAt: iso(3 * DAY),
  },
  {
    name: 'gpu',
    description: null,
    activeVersion: 3,
    canaryVersion: 4,
    previousVersion: 2,
    active: version(3, W3_TEMPLATE, null, 9 * DAY),
    canary: version(4, DEFAULT_DOC, 'Sonnet profili', DAY),
    workers: 2,
    canaryWorkers: 1,
    updatedAt: iso(DAY),
  },
];

function model(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    displayName: id,
    runtimes: ['claude-code'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    params: {},
    limits: { contextWindow: 200000 },
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    enabled: true,
    version: 1,
    createdAt: iso(20 * DAY),
    updatedAt: iso(2 * DAY),
    updatedBy: null,
    usedBy: { policies: [], workers: [] },
    ...over,
  };
}

export const W3_MODELS = {
  items: [
    model('sonnet-balanced', {
      displayName: 'Sonnet dengeli',
      credentialRef: { source: 'vault', id: 'anthropic-main' },
      usedBy: {
        policies: [
          { policy: 'default', version: 2, runtime: 'claude-code', inSync: true },
          { policy: 'gpu', version: 3, runtime: 'claude-code', inSync: false },
        ],
        workers: ['w1', 'w2'],
      },
    }),
    model('codex-high', {
      displayName: 'Codex yüksek akıl',
      runtimes: ['codex'],
      provider: 'openai',
      model: 'gpt-5-codex',
      params: { reasoningEffort: 'high' },
      pricing: {},
      enabled: false,
    }),
  ],
  defaults: [
    { project: null, runtime: 'claude-code', profileId: 'sonnet-balanced' },
    { project: 'mobil-app', runtime: 'codex', profileId: 'codex-high' },
  ],
};

export const ROUTES: ScreenRoutes = {
  '/runtime-policies': (_u, method) => (method === 'GET' ? { items: W3_POLICIES } : undefined),
  '/runtime-policies/template': () => ({ document: W3_TEMPLATE, documentHash: 'b'.repeat(64) }),
  '/runtime-policies/default/versions': () => ({ items: [W3_POLICIES[0]?.active] }),
  '/runtime-policies/gpu/versions': () => ({ items: [W3_POLICIES[1]?.canary, W3_POLICIES[1]?.active] }),
  '/models': (_u, method) => (method === 'GET' ? W3_MODELS : undefined),
  // p15-model-picker: no machine lists in the harness — the pickers show the built-in catalog.
  '/models/runtimes': (_u, method) =>
    method === 'GET' ? { catalogVersion: '2026.10.23-1', runtimes: [] } : undefined,
};
