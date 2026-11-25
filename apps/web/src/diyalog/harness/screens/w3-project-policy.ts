import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Projeler → Politika (`?path=/projects/mobil-app?tab=policy`) — approval
 * waits, queue limits, off-peak window, usage-limit policy with a blocked paid fallback, runtime advice, package
 * caches and routing rules (one global, one project override). Also used by apps/web/test/diyalog-w3-project-policy.
 * The execution policy itself comes from harness/screens/projects.ts.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

export const POLICY_APPROVAL_PAUSE = {
  project: 'mobil-app',
  staleAfterSec: 900,
  pauseAfterSec: 3600,
  retentionSec: 604_800,
  defaults: { staleAfterSec: 900, pauseAfterSec: 3600, retentionSec: 604_800 },
  limits: {
    minStaleAfterSec: 60,
    maxStaleAfterSec: 86_400,
    minPauseAfterSec: 120,
    maxPauseAfterSec: 172_800,
    minRetentionSec: 3600,
    maxRetentionSec: 2_592_000,
  },
};

export const POLICY_QUEUE = {
  project: 'mobil-app',
  maxPerUser: 3,
  maxPerAutomation: null,
  waitNotifyMinutes: 15,
};

export const POLICY_OFF_PEAK = {
  window: { start: '22:00', end: '07:00', timeZone: 'Europe/Istanbul' },
  open: false,
  nextStart: new Date(NOW + 5 * 3_600_000).toISOString(),
  updatedBy: 'alex',
  updatedAt: iso(3 * 86_400_000),
};

const policy = {
  mode: 'auto',
  maxWaitHours: 2,
  fallbacks: [{ runtime: 'codex' }, { runtime: 'claude-code', model: 'anthropic-api' }],
  allowPaidFallback: false,
};

export const POLICY_USAGE_LIMIT = {
  project: 'mobil-app',
  own: policy,
  effective: policy,
  source: 'project',
  defaults: { mode: 'wait', maxWaitHours: 4, fallbacks: [], allowPaidFallback: false },
  fallbacks: [
    { runtime: 'codex', model: null, profile: null, paid: 'machine', blocked: false, estimate: null },
    {
      runtime: 'claude-code',
      model: 'anthropic-api',
      profile: 'anthropic-api',
      paid: 'credential',
      blocked: true,
      estimate: { avgCostUsdPerJob: 0.84, jobs: 12, basis: 'project' },
    },
  ],
  updatedAt: iso(86_400_000),
};

export const POLICY_ADVICE = {
  settings: {
    mode: 'advice',
    explorationPct: 10,
    minSamples: 5,
    allowedRuntimes: [],
    allowPaid: false,
    halfLifeDays: 30,
    rerunWindowDays: 3,
    areaRules: [{ area: 'frontend', globs: ['apps/mobile/**'] }],
  },
};

export const POLICY_CACHES = {
  project: 'mobil-app',
  enabled: true,
  updatedBy: null,
  updatedAt: null,
};

export const POLICY_ROUTING = {
  rules: [
    { project: null, role: 'plan', modelProfile: null, runtimes: ['claude-code', 'codex'] },
    { project: null, role: 'verify', modelProfile: null, runtimes: ['codex'] },
    { project: 'mobil-app', role: 'execute', modelProfile: null, runtimes: ['opencode', 'codex'] },
  ],
};

/** p19-project-env: one credential given to the jobs (on two machines), one more that could be added. */
export const POLICY_ENV = {
  project: 'mobil-app',
  credentials: [
    {
      credentialId: 'dev-database-url',
      name: 'Geliştirme veritabanı',
      env: 'DEV_DATABASE_URL',
      machines: ['mac-studio', 'linux-01'],
    },
  ],
  available: [{ id: 'redis-url', name: 'Redis', env: 'REDIS_URL' }],
};

const get =
  (body: unknown) =>
  (_u: URL, method: string): unknown =>
    method === 'GET' ? body : undefined;

export const ROUTES: ScreenRoutes = {
  '/projects/mobil-app/approval-pause': get(POLICY_APPROVAL_PAUSE),
  '/projects/mobil-app/queue-settings': get(POLICY_QUEUE),
  '/projects/mobil-app/off-peak': get(POLICY_OFF_PEAK),
  '/projects/mobil-app/usage-limit-policy': get(POLICY_USAGE_LIMIT),
  '/projects/mobil-app/runtime-advice': get(POLICY_ADVICE),
  '/projects/mobil-app/package-caches': get(POLICY_CACHES),
  '/projects/mobil-app/env-credentials': get(POLICY_ENV),
  '/routing/rules': get(POLICY_ROUTING),
};
