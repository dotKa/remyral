import type { ScreenRoutes } from './types';

/**
 * p12-diyalog-w2 harness fixtures for /approvals and /approvals/:id (`?path=/approvals/<A_CMD>`). Return undefined to
 * fall through to the base fixtures.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

export const A_CMD = 'a0000000-0000-4000-8000-0000000000a1';
const A_GATE = 'a0000000-0000-4000-8000-0000000000a2';
const A_PAUSED = 'a0000000-0000-4000-8000-0000000000a3';
const A_DONE = 'a0000000-0000-4000-8000-0000000000a4';
const A_DENIED = 'a0000000-0000-4000-8000-0000000000a5';

const LONG_CMD = [
  'rm -rf node_modules ~/Library/pnpm/store/v3 && pnpm install --no-frozen-lockfile',
  '&& pnpm -r --filter ./packages/** build && pnpm vitest run --reporter=dot | tee /tmp/vitest.log',
].join(' ');

function request(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    jobId: '7c1e09ab-4d2f-4b8a-9c3e-1f2a3b4c5d6e',
    project: 'mobil-app',
    jobState: 'RUNNING',
    kind: 'in_run',
    action: 'fs.delete_outside_workspace',
    requestedAction: 'fs.delete',
    risk: 'high',
    summary: `Bash: ${LONG_CMD}`,
    requestedBy: { type: 'worker', id: 'kestrel-mac-0001' },
    workerId: 'kestrel-mac-0001',
    approverRole: 'admin',
    requiredApprovals: 1,
    approvals: 0,
    stepUp: true,
    status: 'pending',
    epoch: 1,
    createdAt: iso(18 * MIN),
    expiresAt: iso(-42 * MIN),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    staleAt: iso(4 * MIN),
    pauseRequestedAt: null,
    jobPaused: false,
    details: {
      tool: 'Bash',
      description:
        'Kilit dosyası eski vite 5 sürümünü sabitliyor; node_modules ve pnpm store önbelleğini silip yeniden kurmam gerekiyor.',
      command: LONG_CMD,
      shell: 'posix',
      cwd: '/Users/remyral/work/mobil-app',
      paths: ['node_modules', '~/Library/pnpm/store/v3'],
    },
    hints: {
      runs: ['rm', 'pnpm', 'tee'],
      reaches: ['registry.npmjs.org'],
      writes: ['/tmp/vitest.log'],
      deletes: ['node_modules', '~/Library/pnpm/store/v3'],
      installs: ['pnpm install'],
      envVars: [],
      outside: ['~/Library/pnpm/store/v3', '/tmp/vitest.log'],
      elevated: false,
      safeVerdict: null,
      partial: false,
    },
    headline: {
      text: 'Vitest 5’e geç: kilit dosyası için önbelleği silip yeniden kur',
      source: 'agent',
    },
    ...over,
  };
}

const PENDING = [
  request(A_CMD),
  request(A_GATE, {
    kind: 'gate',
    action: 'git.merge',
    requestedAction: 'git.merge',
    risk: 'critical',
    project: 'vitrin-web',
    jobState: 'AWAITING_APPROVAL',
    summary: 'Merge int/7c1e09ab into main (PR #218)',
    requestedBy: { type: 'system', id: 'integrator' },
    workerId: null,
    approverRole: 'owner',
    requiredApprovals: 2,
    approvals: 1,
    staleAt: null,
    createdAt: iso(6 * MIN),
    expiresAt: iso(-180 * MIN),
    details: null,
    hints: null,
    headline: { text: 'Merge int/7c1e09ab into main (PR #218)', source: 'summary' },
  }),
  request(A_PAUSED, {
    action: 'network.egress_non_allowlisted',
    requestedAction: 'network.egress',
    risk: 'medium',
    jobState: 'PAUSED',
    jobPaused: true,
    pauseRequestedAt: iso(30 * MIN),
    staleAt: iso(30 * MIN),
    stepUp: false,
    createdAt: iso(55 * MIN),
    expiresAt: iso(-5 * MIN),
    summary: 'curl https://api.stripe.com/v1/charges',
    details: {
      tool: 'Bash',
      command: 'curl -s https://api.stripe.com/v1/charges -o charges.json',
      url: 'https://api.stripe.com/v1/charges',
    },
    hints: null,
    headline: { text: 'curl -s https://api.stripe.com/v1/charges -o charges.json', source: 'command' },
  }),
];

const DECIDED = [
  request(A_DONE, {
    status: 'approved',
    action: 'deploy',
    requestedAction: 'deploy',
    risk: 'high',
    project: 'vitrin-web',
    decidedAt: iso(90 * MIN),
    decidedBy: { id: 'u1', username: 'alex' },
    decisionReason: 'Sürüm notları tamam.',
    staleAt: null,
    createdAt: iso(120 * MIN),
    details: null,
    hints: null,
    summary: 'Deploy vitrin-web to production',
    headline: { text: 'Deploy vitrin-web to production', source: 'summary' },
  }),
  request(A_DENIED, {
    status: 'denied',
    action: 'secret.read',
    requestedAction: 'secret.read',
    risk: 'critical',
    decidedAt: iso(200 * MIN),
    decidedBy: { id: 'u2', username: 'derya' },
    decisionReason: 'Prod anahtarı bu iş için gerekmiyor; test anahtarını kullan.',
    staleAt: null,
    createdAt: iso(240 * MIN),
  }),
];

const ALL = [...PENDING, ...DECIDED];

function detail(id: string): Record<string, unknown> | undefined {
  const r = ALL.find((x) => x.id === id);
  if (r === undefined) return undefined;
  const decisions =
    r.status === 'approved'
      ? [
          {
            decision: 'approve',
            user: { username: 'alex' },
            role: 'owner',
            reason: 'Sürüm notları tamam.',
            decidedAt: iso(90 * MIN),
          },
        ]
      : id === A_GATE
        ? [
            {
              decision: 'approve',
              user: { username: 'derya' },
              role: 'owner',
              reason: null,
              decidedAt: iso(3 * MIN),
            },
          ]
        : [];
  return { request: r, decisions };
}

export const ROUTES: ScreenRoutes = {
  '/approvals': (u, method) => {
    if (method !== 'GET') return undefined;
    const status = u.searchParams.get('status');
    return { items: status === 'pending' ? PENDING : ALL, nextCursor: null };
  },
  ...Object.fromEntries(
    ALL.map((r) => [
      `/approvals/${String(r.id)}`,
      (_u: URL, method: string) => (method === 'GET' ? detail(String(r.id)) : undefined),
    ]),
  ),
};
