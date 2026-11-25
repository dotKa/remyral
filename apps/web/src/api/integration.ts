import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p11-merge-pipeline (master-managed integration): when a coordinator job has repository sub-jobs, or a workflow run
 * has an integrator step, the master merges every child branch into one integration branch `int/<root8>`, opens
 * conflict-resolution jobs, verifies the result, may open a bounded fix job and opens ONE pull request (GitHub) or
 * offers the existing protected merge (plain git).
 *
 * Every text here (titles, branch names, paths, file names, summaries, findings, log lines) may come from an agent or
 * a repository: render it as React text only. The only link built from the payload is the pull request URL, and only
 * after `safePullRequestUrl` accepted it (https, no credentials).
 */

type Opts = Omit<RequestOptions, 'body'>;

export const INTEGRATION_STATES = [
  'merging',
  'resolving',
  'verifying',
  'fixing',
  'publishing',
  'ready',
  'merged',
  'needs_human',
  'failed',
  'cancelled',
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

/** States the master accepts a cancel in. */
export const INTEGRATION_OPEN: ReadonlySet<IntegrationState> = new Set([
  'merging',
  'resolving',
  'verifying',
  'fixing',
  'publishing',
  'ready',
]);
/** The master is doing work right now (the UI polls). */
export const INTEGRATION_ACTIVE: ReadonlySet<IntegrationState> = new Set([
  'merging',
  'resolving',
  'verifying',
  'fixing',
  'publishing',
]);

export const BRANCH_STATES = ['pending', 'merged', 'conflict', 'resolved', 'skipped'] as const;
export type IntegrationBranchState = (typeof BRANCH_STATES)[number];

export const VERIFICATION_STATES = [
  'pending',
  'running',
  'passed',
  'warned',
  'failed',
  'error',
  'skipped',
] as const;
export type IntegrationVerificationState = (typeof VERIFICATION_STATES)[number];

export const JOB_KINDS = ['integrate', 'resolve', 'fix', 'verify'] as const;
export type IntegrationJobKind = (typeof JOB_KINDS)[number];

export type OrderMode = 'dependency' | 'completion';

export interface IntegrationBranch {
  readonly position: number;
  readonly jobId: string;
  readonly title: string;
  readonly branch: string;
  readonly sha: string;
  readonly paths: readonly string[];
  readonly state: IntegrationBranchState;
  readonly mergedSha: string | null;
  readonly conflictFiles: readonly string[];
  readonly resolutionJobId: string | null;
  readonly resolutionJobState: string | null;
  readonly detail: string | null;
}

export interface IntegrationJob {
  readonly jobId: string;
  readonly kind: IntegrationJobKind;
  readonly round: number;
  readonly state: string;
  readonly createdAt: string;
}

export interface IntegrationWarning {
  readonly kind: 'path_overlap';
  readonly message: string;
  readonly jobIds: readonly string[];
  readonly paths: readonly string[];
}

export interface IntegrationVerification {
  readonly state: IntegrationVerificationState;
  readonly jobId: string | null;
  readonly summary: string | null;
  readonly checks: readonly {
    readonly id: string;
    readonly status: string;
    readonly detail: string | null;
  }[];
  readonly findings: readonly {
    readonly severity: string;
    readonly kind: string;
    readonly message: string;
  }[];
}

export interface IntegrationView {
  readonly id: string;
  readonly project: string;
  readonly source: 'coordinator' | 'workflow';
  readonly rootJobId: string | null;
  readonly runId: string | null;
  readonly nodeId: string | null;
  readonly branch: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  readonly headSha: string | null;
  readonly orderMode: OrderMode;
  readonly state: IntegrationState;
  readonly reason: string | null;
  readonly resolutionRounds: number;
  readonly maxResolutions: number;
  readonly fixRounds: number;
  readonly maxFixes: number;
  readonly branches: readonly IntegrationBranch[];
  readonly jobs: readonly IntegrationJob[];
  readonly warnings: readonly IntegrationWarning[];
  readonly verification: IntegrationVerification | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly mergeJobId: string | null;
  readonly log: readonly { readonly at: string; readonly message: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = str(o, key);
  if (!(allowed as readonly string[]).includes(v)) throw new ShapeError(`unexpected value at ${key}`);
  return v as T;
}

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

function parseBranch(x: unknown): IntegrationBranch {
  const o = obj(x);
  return {
    position: int(o, 'position'),
    jobId: str(o, 'jobId'),
    title: str(o, 'title'),
    branch: str(o, 'branch'),
    sha: str(o, 'sha'),
    paths: strArray(o, 'paths'),
    state: oneOf(o, 'state', BRANCH_STATES),
    mergedSha: nullableStr(o, 'mergedSha'),
    conflictFiles: strArray(o, 'conflictFiles'),
    resolutionJobId: nullableStr(o, 'resolutionJobId'),
    resolutionJobState: nullableStr(o, 'resolutionJobState'),
    detail: nullableStr(o, 'detail'),
  };
}

function parseVerification(v: unknown): IntegrationVerification | null {
  if (v === null) return null;
  const o = obj(v);
  return {
    state: oneOf(o, 'state', VERIFICATION_STATES),
    jobId: nullableStr(o, 'jobId'),
    summary: nullableStr(o, 'summary'),
    checks: arr(o, 'checks').map((c) => {
      const x = obj(c);
      return { id: str(x, 'id'), status: str(x, 'status'), detail: nullableStr(x, 'detail') };
    }),
    findings: arr(o, 'findings').map((f) => {
      const x = obj(f);
      return { severity: str(x, 'severity'), kind: str(x, 'kind'), message: str(x, 'message') };
    }),
  };
}

export function parseIntegrationView(v: unknown): IntegrationView {
  const o = obj(v);
  const pr = o.pullRequest === null || o.pullRequest === undefined ? null : obj(o.pullRequest);
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    source: oneOf(o, 'source', ['coordinator', 'workflow'] as const),
    rootJobId: nullableStr(o, 'rootJobId'),
    runId: nullableStr(o, 'runId'),
    nodeId: nullableStr(o, 'nodeId'),
    branch: str(o, 'branch'),
    targetBranch: str(o, 'targetBranch'),
    baseSha: str(o, 'baseSha'),
    headSha: nullableStr(o, 'headSha'),
    orderMode: oneOf(o, 'orderMode', ['dependency', 'completion'] as const),
    state: oneOf(o, 'state', INTEGRATION_STATES),
    reason: nullableStr(o, 'reason'),
    resolutionRounds: int(o, 'resolutionRounds'),
    maxResolutions: int(o, 'maxResolutions'),
    fixRounds: int(o, 'fixRounds'),
    maxFixes: int(o, 'maxFixes'),
    branches: arr(o, 'branches')
      .map(parseBranch)
      .sort((a, b) => a.position - b.position),
    jobs: arr(o, 'jobs').map((j) => {
      const x = obj(j);
      return {
        jobId: str(x, 'jobId'),
        kind: oneOf(x, 'kind', JOB_KINDS),
        round: int(x, 'round'),
        state: str(x, 'state'),
        createdAt: str(x, 'createdAt'),
      };
    }),
    warnings: arr(o, 'warnings').map((w) => {
      const x = obj(w);
      return {
        kind: oneOf(x, 'kind', ['path_overlap'] as const),
        message: str(x, 'message'),
        jobIds: strArray(x, 'jobIds'),
        paths: strArray(x, 'paths'),
      };
    }),
    verification: parseVerification(o.verification ?? null),
    pullRequest: pr === null ? null : { number: int(pr, 'number'), url: str(pr, 'url') },
    mergeJobId: nullableStr(o, 'mergeJobId'),
    log: arr(o, 'log').map((l) => {
      const x = obj(l);
      return { at: str(x, 'at'), message: str(x, 'message') };
    }),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

/** `{ integration: IntegrationView | null }`. */
export function parseIntegrationEnvelope(body: unknown): IntegrationView | null {
  const b = obj(body);
  if (!('integration' in b)) throw new ShapeError('expected integration');
  return b.integration === null ? null : parseIntegrationView(b.integration);
}

function parseIntegrationRequired(body: unknown): IntegrationView {
  const v = parseIntegrationEnvelope(body);
  if (v === null) throw new ShapeError('expected integration');
  return v;
}

/** The pull request URL as a link target, or null (shown as text) unless it is https without credentials. */
export function safePullRequestUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === '' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

/** The integration of a coordinator job, or the one a member job (a merged child, a resolve/fix job) belongs to. */
export function getJobIntegration(jobId: string, opts: Opts = {}): Promise<IntegrationView | null> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/integration`, parseIntegrationEnvelope, opts);
}

export function getRunIntegration(runId: string, opts: Opts = {}): Promise<IntegrationView | null> {
  return apiRequest(
    'GET',
    `/workflows/runs/${encodeURIComponent(runId)}/integration`,
    parseIntegrationEnvelope,
    opts,
  );
}

/** Operator: stops an open integration (409 `not_open` when it already ended). */
export function cancelIntegration(id: string, reason?: string, opts: Opts = {}): Promise<IntegrationView> {
  return apiRequest('POST', `/integrations/${encodeURIComponent(id)}/cancel`, parseIntegrationRequired, {
    ...opts,
    body: reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
  });
}

/** Operator: from `needs_human`, starts a new round from the current head (409 `not_retryable` otherwise). */
export function retryIntegration(id: string, opts: Opts = {}): Promise<IntegrationView> {
  return apiRequest('POST', `/integrations/${encodeURIComponent(id)}/retry`, parseIntegrationRequired, {
    ...opts,
    body: {},
  });
}

// ------------------------------------------------------------------ project settings

export interface IntegrationSettings {
  readonly mode: 'master' | 'off';
  readonly order: OrderMode;
  /** 0..10 */
  readonly maxResolutions: number;
  /** 0..5 */
  readonly maxFixes: number;
}

export const MAX_RESOLUTIONS_LIMIT = 10;
export const MAX_FIXES_LIMIT = 5;

function bounded(o: Record<string, unknown>, key: string, max: number): number {
  const n = int(o, key);
  if (n < 0 || n > max) throw new ShapeError(`out of range at ${key}`);
  return n;
}

export function parseIntegrationSettings(v: unknown): IntegrationSettings {
  const o = obj(v);
  return {
    mode: oneOf(o, 'mode', ['master', 'off'] as const),
    order: oneOf(o, 'order', ['dependency', 'completion'] as const),
    maxResolutions: bounded(o, 'maxResolutions', MAX_RESOLUTIONS_LIMIT),
    maxFixes: bounded(o, 'maxFixes', MAX_FIXES_LIMIT),
  };
}

export function getIntegrationSettings(
  project: string,
  opts: Opts = {},
): Promise<{ readonly settings: IntegrationSettings; readonly canEdit: boolean }> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/integration-settings`,
    (body) => {
      const b = obj(body);
      return { settings: parseIntegrationSettings(b.settings), canEdit: b.canEdit === true };
    },
    opts,
  );
}

/** Admin + fresh step-up (403 `step_up_required` otherwise). */
export function putIntegrationSettings(
  project: string,
  settings: IntegrationSettings,
  opts: Opts = {},
): Promise<IntegrationSettings> {
  return apiRequest(
    'PUT',
    `/projects/${encodeURIComponent(project)}/integration-settings`,
    (body) => parseIntegrationSettings(obj(body).settings),
    {
      ...opts,
      body: {
        mode: settings.mode,
        order: settings.order,
        maxResolutions: settings.maxResolutions,
        maxFixes: settings.maxFixes,
      },
    },
  );
}
