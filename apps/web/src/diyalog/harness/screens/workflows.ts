import { HARNESS_RUN } from './jobs';
import type { ScreenRoutes } from './types';

/**
 * p13-workflows-ui harness: the workflow list (`/workflows`), a medium graph (`/workflows/wf-release`, 8 steps), one
 * with validation errors (`/workflows/wf-bad?dogrula=1`), a new one (`/workflows/new`) and a viewer-only one. The
 * list body also carries the recent runs (İşler and the composer read the same route).
 */

const MIN = 60_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const DEFAULTS = {
  runtime: 'claude-code',
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  sourceTrust: 'untrusted',
  limits: { maxDurationSec: 3600 },
};

const RELEASE = {
  name: 'release-check',
  description: 'Planla, paralel uygula, test et, incele, birleştir ve önizlemeye yayınla.',
  inputs: { task: { required: true, description: 'Sürümde ne var' } },
  defaults: DEFAULTS,
  nodes: [
    { id: 'plan', role: 'planner', prompt: 'Sürümü planla: {{inputs.task}}', dynamic: { maxNodes: 4 } },
    { id: 'api', role: 'executor', prompt: 'API değişikliklerini uygula.', runtime: 'codex' },
    { id: 'web', role: 'executor', prompt: 'Web arayüzünü güncelle.' },
    { id: 'docs', role: 'executor', prompt: 'Belgeleri güncelle.', runtime: 'pi' },
    { id: 'test', role: 'verifier', prompt: 'Testleri çalıştır: {{upstream.api.summary}}' },
    { id: 'review', role: 'reviewer', prompt: 'Değişiklikleri incele.' },
    {
      id: 'gate',
      role: 'executor',
      prompt: 'Sürüm notlarını yaz.',
      approval: { approverRole: 'admin' },
    },
    {
      id: 'integrate',
      role: 'integrator',
      prompt: 'Dalları birleştir.',
      deploy: { kind: 'coolify.deploy', env: 'preview' },
    },
  ],
  edges: [
    { from: 'plan', to: 'api' },
    { from: 'plan', to: 'web' },
    { from: 'plan', to: 'docs' },
    { from: 'api', to: 'test' },
    { from: 'web', to: 'test' },
    { from: 'docs', to: 'review' },
    { from: 'test', to: 'review' },
    { from: 'review', to: 'gate' },
    { from: 'gate', to: 'integrate' },
  ],
};

const BAD = {
  name: 'hotfix-flow',
  inputs: {},
  defaults: DEFAULTS,
  nodes: [
    { id: 'fix', role: 'executor', prompt: 'Düzelt: {{inputs.issue}}' },
    { id: 'verify', role: 'verifier', prompt: 'Doğrula {{upstream.ship.summary}}' },
    { id: 'ship', role: 'integrator', prompt: 'Birleştir.' },
  ],
  edges: [
    { from: 'fix', to: 'verify' },
    { from: 'fix', to: 'verify' },
  ],
};

function summary(
  id: string,
  over: Partial<Record<string, unknown>> & { name: string; project: string },
): Record<string, unknown> {
  return {
    id,
    version: 1,
    nodes: 3,
    edges: 2,
    description: null,
    createdAt: iso(3 * 60 * MIN),
    createdBy: 'alex',
    archived: false,
    archivedAt: null,
    runs: 0,
    succeeded: 0,
    failed: 0,
    lastRun: null,
    ...over,
  };
}

const DEFINITIONS = [
  summary('wf-release', {
    name: 'release-check',
    project: 'vitrin-web',
    version: 3,
    nodes: 8,
    edges: 9,
    description: RELEASE.description,
    runs: 14,
    succeeded: 11,
    failed: 2,
    lastRun: { id: HARNESS_RUN, state: 'running', createdAt: iso(22 * MIN) },
    createdAt: iso(26 * 60 * MIN),
  }),
  summary('wf1', {
    name: 'planla-uygula-dogrula',
    project: 'vitrin-web',
    version: 2,
    description: 'Üç adımlı akış: plan, uygulama, doğrulama kapısı.',
    runs: 6,
    succeeded: 6,
    lastRun: {
      id: 'wr-5f6a7b8c-0000-4000-8000-000000000003',
      state: 'succeeded',
      createdAt: iso(5 * 60 * MIN),
    },
  }),
  summary('wf-nightly', {
    name: 'nightly-deps',
    project: 'mobil-app',
    nodes: 2,
    edges: 1,
    runs: 30,
    succeeded: 24,
    failed: 6,
    createdBy: 'ayse',
    lastRun: { id: 'wr-5f6a7b8c-0000-4000-8000-000000000002', state: 'failed', createdAt: iso(9 * 60 * MIN) },
    createdAt: iso(9 * 24 * 60 * MIN),
  }),
  summary('wf-bad', { name: 'hotfix-flow', project: 'vitrin-web', createdAt: iso(40 * MIN) }),
  summary('wf-old', {
    name: 'legacy-migrate',
    project: 'odeme-api',
    archived: true,
    archivedAt: iso(60 * MIN),
  }),
];

const RUNS = [
  {
    id: HARNESS_RUN,
    project: 'vitrin-web',
    name: 'release-check',
    version: 3,
    state: 'running',
    createdAt: iso(22 * MIN),
    endedAt: null,
  },
  {
    id: 'wr-5f6a7b8c-0000-4000-8000-000000000004',
    project: 'vitrin-web',
    name: 'release-check',
    version: 2,
    state: 'succeeded',
    createdAt: iso(26 * 60 * MIN),
    endedAt: iso(25 * 60 * MIN),
  },
  {
    id: 'wr-5f6a7b8c-0000-4000-8000-000000000002',
    project: 'mobil-app',
    name: 'nightly-deps',
    version: 1,
    state: 'failed',
    createdAt: iso(9 * 60 * MIN),
    endedAt: iso(8 * 60 * MIN),
  },
];

function doc(id: string, project: string, version: number, definition: Record<string, unknown>) {
  return {
    id,
    project,
    name: String(definition.name),
    version,
    latestVersion: version,
    latestId: id,
    archived: false,
    createdBy: 'alex',
    createdAt: iso(3 * 60 * MIN),
    hash: `h-${id}`,
    promptsHidden: false,
    definition,
  };
}

export const ROUTES: ScreenRoutes = {
  '/workflows': (_u, method) => (method === 'GET' ? { definitions: DEFINITIONS, runs: RUNS } : undefined),
  '/workflows/wf-release/definition': () => doc('wf-release', 'vitrin-web', 3, RELEASE),
  '/workflows/wf-bad/definition': () => doc('wf-bad', 'vitrin-web', 1, BAD),
  '/workflows/wf-release/versions': () => ({
    versions: [3, 2, 1].map((v) => ({
      id: v === 3 ? 'wf-release' : `wf-release-v${String(v)}`,
      version: v,
      createdBy: v === 1 ? 'ayse' : 'alex',
      createdAt: iso((4 - v) * 24 * 60 * MIN),
      hash: `h${String(v)}`,
      nodes: 5 + v,
      edges: 6 + v,
    })),
  }),
  '/workflows/validate': (_u, method) =>
    method === 'POST'
      ? {
          ok: false,
          issues: [
            { path: 'edges.1', code: 'duplicate' },
            { path: 'nodes.0.prompt', code: 'undeclared_input:issue' },
            { path: 'nodes.1.prompt', code: 'not_upstream:ship' },
          ],
        }
      : undefined,
};
