import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p6-smart-routing (docs/design/p6-smart-routing.md): routing rules (job kind → preferred model profile and runtime
 * order, global and per project) and the job outcome statistics (`GET /usage/job-stats`).
 */

/** Job kinds (JobSpec.role); mirrors @remyral/protocol JOB_ROLES. */
export const JOB_ROLES = ['plan', 'execute', 'verify', 'summarise', 'research', 'chore'] as const;
export type JobRole = (typeof JOB_ROLES)[number];

export const ROLE_LABEL: Record<JobRole, string> = {
  plan: 'Plan',
  execute: 'Execute',
  verify: 'Verify / review',
  summarise: 'Summarise',
  research: 'Research',
  chore: 'Chore',
};

/** How much of the prompt the master's kind heuristic reads (ROLE_HINT_CHARS). */
export const ROLE_HINT_CHARS = 400;

export interface RoutingRule {
  readonly project: string | null;
  readonly role: JobRole;
  readonly modelProfile: string | null;
  readonly runtimes: readonly string[];
}

type Opts = Omit<RequestOptions, 'body'>;

function isRole(v: string): v is JobRole {
  return (JOB_ROLES as readonly string[]).includes(v);
}

function parseRules(v: unknown): RoutingRule[] {
  const o = obj(v);
  if (!Array.isArray(o.rules)) throw new ShapeError('expected rules');
  return o.rules.flatMap((x: unknown) => {
    const r = obj(x);
    const role = str(r, 'role');
    if (!isRole(role)) return [];
    return [
      {
        project: nullableStr(r, 'project'),
        role,
        modelProfile: nullableStr(r, 'modelProfile'),
        runtimes: strArray(r, 'runtimes'),
      },
    ];
  });
}

export function listRoutingRules(project: string | null, opts: Opts = {}): Promise<RoutingRule[]> {
  const q = project === null ? '' : `?project=${encodeURIComponent(project)}`;
  return apiRequest('GET', `/routing/rules${q}`, parseRules, opts);
}

/** Sets a rule, or clears it with no model profile and no runtimes (admin, step-up). */
export function putRoutingRule(
  body: {
    project: string | null;
    role: JobRole;
    modelProfile: string | null;
    runtimes: readonly string[];
  },
  opts: Opts = {},
): Promise<RoutingRule[]> {
  return apiRequest('PUT', '/routing/rules', parseRules, { ...opts, body });
}

/** The rule in force for a project and kind: the project's own, else the global one. */
export function effectiveRule(
  rules: readonly RoutingRule[],
  project: string | null,
  role: JobRole,
): (RoutingRule & { scope: 'project' | 'global' }) | null {
  const own = project === null ? undefined : rules.find((r) => r.project === project && r.role === role);
  if (own !== undefined) return { ...own, scope: 'project' };
  const global = rules.find((r) => r.project === null && r.role === role);
  return global === undefined ? null : { ...global, scope: 'global' };
}

export interface JobStatsRow {
  readonly runtime: string | null;
  readonly model: string | null;
  readonly kind: string | null;
  readonly project: string | null;
  readonly workerId: string | null;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly successRate: number | null;
  readonly p50DurationSec: number | null;
  readonly p90DurationSec: number | null;
  readonly meanDurationSec: number | null;
  readonly costUsd: number;
  readonly costPerAttemptUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastAt: string;
}

export const STATS_GROUPS = ['runtime', 'model', 'kind', 'project', 'worker'] as const;
export type StatsGroup = (typeof STATS_GROUPS)[number];

export function listJobStats(
  q: { groupBy: readonly StatsGroup[]; project?: string },
  opts: Opts = {},
): Promise<JobStatsRow[]> {
  const params = new URLSearchParams({ groupBy: q.groupBy.join(',') });
  if (q.project !== undefined && q.project !== '') params.set('project', q.project);
  return apiRequest(
    'GET',
    `/usage/job-stats?${params.toString()}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('expected items');
      return o.items.map((x: unknown) => {
        const r = obj(x);
        if (typeof r.attempts !== 'number') throw new ShapeError('expected attempts');
        return r as unknown as JobStatsRow;
      });
    },
    opts,
  );
}

/** `4m 10s`, `1h 5m`, `42s` (same as the scheduler's explanation). */
export function durationText(sec: number | null): string {
  if (sec === null) return '–';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${String(m)}m` : `${String(m)}m ${String(r)}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${String(h)}h` : `${String(h)}h ${String(m)}m`;
}
