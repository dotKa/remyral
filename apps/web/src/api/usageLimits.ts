import { apiRequest, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p11-usage-limit-fallback: what happens when a runtime hits its provider's usage limit — wait for the reset (the job
 * resumes by itself), continue on a fallback runtime / credential, or fail — per project with a workspace default,
 * and the limits known now (machine login stores, provider accounts, API credentials).
 */

export type UsageLimitMode = 'auto' | 'wait' | 'fallback' | 'fail';

export interface UsageLimitFallback {
  readonly runtime: string;
  /** A model catalog profile id (e.g. an API-key profile of the same runtime). */
  readonly model?: string;
}

export interface UsageLimitPolicy {
  readonly mode: UsageLimitMode;
  readonly maxWaitHours: number;
  readonly fallbacks: readonly UsageLimitFallback[];
  readonly allowPaidFallback: boolean;
}

export interface FallbackFacts {
  readonly runtime: string;
  readonly model: string | null;
  readonly profile: string | null;
  /** `credential`: the profile brings an API key; `machine`: it depends on the machine's runtime login. */
  readonly paid: 'credential' | 'machine';
  /** Left out at dispatch (paid, and paid fallbacks are not allowed). */
  readonly blocked: boolean;
  readonly estimate: {
    readonly avgCostUsdPerJob: number;
    readonly jobs: number;
    readonly basis: 'project' | 'all_projects';
  } | null;
}

export interface ProjectUsageLimitPolicy {
  readonly project: string;
  readonly own: UsageLimitPolicy | null;
  readonly effective: UsageLimitPolicy;
  readonly source: 'project' | 'default';
  readonly defaults: UsageLimitPolicy;
  readonly fallbacks: readonly FallbackFacts[];
  readonly updatedAt: string | null;
}

export interface UsageLimitEpisode {
  readonly id: string;
  readonly scope: string;
  readonly pauseScope: string;
  readonly workerId: string | null;
  readonly workerName: string | null;
  readonly runtime: string;
  readonly accountId: string | null;
  readonly credential: string | null;
  readonly store: string | null;
  readonly model: string | null;
  readonly kind: string | null;
  readonly resetAt: string | null;
  readonly resumeAt: string;
  readonly since: string;
  readonly hits: number;
}

type Opts = Omit<RequestOptions, 'body'>;

const MODES: readonly UsageLimitMode[] = ['auto', 'wait', 'fallback', 'fail'];

export const DEFAULT_USAGE_LIMIT_POLICY: UsageLimitPolicy = {
  mode: 'auto',
  maxWaitHours: 6,
  fallbacks: [],
  allowPaidFallback: false,
};

export function parsePolicy(v: unknown): UsageLimitPolicy {
  const o = obj(v);
  const mode = MODES.find((m) => m === o.mode) ?? 'auto';
  const fallbacks = Array.isArray(o.fallbacks)
    ? o.fallbacks.map((f) => {
        const x = obj(f);
        return {
          runtime: str(x, 'runtime'),
          ...(typeof x.model === 'string' ? { model: x.model } : {}),
        };
      })
    : [];
  return {
    mode,
    maxWaitHours: typeof o.maxWaitHours === 'number' ? o.maxWaitHours : 6,
    fallbacks,
    allowPaidFallback: o.allowPaidFallback === true,
  };
}

function parseFacts(v: unknown): FallbackFacts {
  const o = obj(v);
  const e = o.estimate === null || o.estimate === undefined ? null : obj(o.estimate);
  return {
    runtime: str(o, 'runtime'),
    model: nullableStr(o, 'model'),
    profile: nullableStr(o, 'profile'),
    paid: o.paid === 'credential' ? 'credential' : 'machine',
    blocked: o.blocked === true,
    estimate:
      e === null
        ? null
        : {
            avgCostUsdPerJob: typeof e.avgCostUsdPerJob === 'number' ? e.avgCostUsdPerJob : 0,
            jobs: typeof e.jobs === 'number' ? e.jobs : 0,
            basis: e.basis === 'project' ? 'project' : 'all_projects',
          },
  };
}

export function parseProjectPolicy(v: unknown): ProjectUsageLimitPolicy {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    own: o.own === null || o.own === undefined ? null : parsePolicy(o.own),
    effective: parsePolicy(o.effective),
    source: o.source === 'project' ? 'project' : 'default',
    defaults: parsePolicy(o.defaults),
    fallbacks: Array.isArray(o.fallbacks) ? o.fallbacks.map(parseFacts) : [],
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

const projectPath = (project: string): string =>
  `/projects/${encodeURIComponent(project)}/usage-limit-policy`;

export function getProjectUsageLimitPolicy(
  project: string,
  opts: Opts = {},
): Promise<ProjectUsageLimitPolicy> {
  return apiRequest('GET', projectPath(project), parseProjectPolicy, opts);
}

/** Project admin + step-up (the caller wraps it in the step-up dialog). `null` = inherit the workspace default. */
export function putProjectUsageLimitPolicy(
  project: string,
  policy: UsageLimitPolicy | null,
  opts: Opts = {},
): Promise<ProjectUsageLimitPolicy> {
  return apiRequest('PUT', projectPath(project), parseProjectPolicy, { ...opts, body: { policy } });
}

export function getUsageLimitDefaults(opts: Opts = {}): Promise<UsageLimitPolicy> {
  return apiRequest('GET', '/usage-limits/defaults', (v) => parsePolicy(obj(v).policy), opts);
}

/** Admin + step-up. */
export function putUsageLimitDefaults(policy: UsageLimitPolicy, opts: Opts = {}): Promise<UsageLimitPolicy> {
  return apiRequest('PUT', '/usage-limits/defaults', (v) => parsePolicy(obj(v).policy), {
    ...opts,
    body: { policy },
  });
}

/** p19-limit-clear: ends a usage limit before its reset time (waiting jobs continue now). */
export function clearUsageLimit(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('POST', `/usage-limits/${encodeURIComponent(id)}/clear`, () => undefined, {
    ...opts,
    body: {},
  });
}

export function parseEpisode(v: unknown): UsageLimitEpisode {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    scope: str(o, 'scope'),
    pauseScope: str(o, 'pauseScope'),
    workerId: nullableStr(o, 'workerId'),
    workerName: nullableStr(o, 'workerName'),
    runtime: str(o, 'runtime'),
    accountId: nullableStr(o, 'accountId'),
    credential: nullableStr(o, 'credential'),
    store: nullableStr(o, 'store'),
    model: nullableStr(o, 'model'),
    kind: nullableStr(o, 'kind'),
    resetAt: nullableStr(o, 'resetAt'),
    resumeAt: str(o, 'resumeAt'),
    since: str(o, 'since'),
    hits: typeof o.hits === 'number' ? o.hits : 1,
  };
}

export function getUsageLimitStatus(opts: Opts = {}): Promise<readonly UsageLimitEpisode[]> {
  return apiRequest(
    'GET',
    '/usage-limits/status',
    (v) => {
      const o = obj(v);
      return Array.isArray(o.limits) ? o.limits.map(parseEpisode) : [];
    },
    opts,
  );
}

/** Client-side check (the master validates again). */
export function usageLimitPolicyProblem(p: UsageLimitPolicy): string | null {
  if (!Number.isFinite(p.maxWaitHours) || p.maxWaitHours < 0.25 || p.maxWaitHours > 168) {
    return 'Wait at most between 0.25 and 168 hours.';
  }
  if (p.fallbacks.length > 4) return 'At most four fallbacks.';
  const seen = new Set<string>();
  for (const f of p.fallbacks) {
    const k = `${f.runtime}/${f.model ?? ''}`;
    if (seen.has(k)) return 'Each fallback (runtime and profile) once.';
    seen.add(k);
    if (f.model !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(f.model)) {
      return 'A fallback profile is a model catalog id such as anthropic-api.';
    }
  }
  return null;
}

const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function runtimeLabel(runtime: string): string {
  return RUNTIME_LABELS[runtime] ?? runtime;
}

/** What the policy does, in one sentence (cards, chat drafts). */
export function describeUsageLimitPolicy(p: UsageLimitPolicy): string {
  const chain = p.fallbacks.map(
    (f) => `${runtimeLabel(f.runtime)}${f.model === undefined ? '' : ` (${f.model})`}`,
  );
  const fb = chain.length === 0 ? 'no fallback' : `fallbacks ${chain.join(' → ')}`;
  switch (p.mode) {
    case 'fail':
      return 'The job fails (the old behaviour).';
    case 'wait':
      return 'The job waits for the reset and continues by itself in the same workspace.';
    case 'fallback':
      return chain.length === 0
        ? 'No fallback is set, so the job waits for the reset.'
        : `The job continues on ${fb.replace('fallbacks ', '')}; it waits for the reset only when none can run.`;
    case 'auto':
      return `The job waits when the limit resets within ${String(p.maxWaitHours)} h, else it continues on a fallback (${fb}); without one it waits.`;
  }
}
