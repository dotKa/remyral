import { apiRequest, int, nullableStr, obj, type RequestOptions, str, strArray } from './client';

/**
 * p17-embeddings (docs/design/p17-embeddings.md §6): similar past jobs, earlier failures that were solved, "a similar
 * record exists" and the per-project context setting. Every answer is about one project the person may read; an empty
 * answer with `unavailable` (no provider, capture off, …) is normal and shows nothing.
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface SimilarJob {
  readonly jobId: string;
  readonly title: string;
  readonly state: string;
  readonly finishedAt: string;
  readonly summary: string | null;
  readonly score: number;
}

export interface SolvedFailure {
  readonly failed: {
    readonly kind: 'job' | 'workflow_run';
    readonly id: string;
    readonly title: string;
    readonly code: string | null;
    readonly at: string;
  };
  readonly resolution: {
    readonly how: 'retry' | 'auto_fix' | 'automation' | 'rerun';
    readonly kind: 'job' | 'workflow_run';
    readonly id: string;
    readonly title: string;
    readonly summary: string | null;
    readonly at: string;
  };
  readonly score: number;
}

export interface JobRelated {
  readonly similar: readonly SimilarJob[];
  /** The jobs the agent was given as hints (null: not decided yet). */
  readonly givenToAgent: readonly string[] | null;
  readonly failures: readonly SolvedFailure[];
  readonly unavailable: string | null;
}

export interface DuplicateHit {
  readonly kind: 'job' | 'automation';
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly createdAt: string;
  readonly score: number;
}

export interface RelatedSettings {
  readonly project: string;
  readonly contextEnabled: boolean;
  readonly version: number;
  readonly platform: { readonly enabled: boolean; readonly context: boolean };
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function kindOf(v: unknown): 'job' | 'workflow_run' {
  return v === 'workflow_run' ? 'workflow_run' : 'job';
}

const HOWS = new Set(['retry', 'auto_fix', 'automation', 'rerun']);

function parseSimilar(v: unknown): SimilarJob {
  const o = obj(v);
  return {
    jobId: str(o, 'jobId'),
    title: str(o, 'title'),
    state: str(o, 'state'),
    finishedAt: str(o, 'finishedAt'),
    summary: nullableStr(o, 'summary'),
    score: num(o, 'score'),
  };
}

function parseFailure(v: unknown): SolvedFailure {
  const o = obj(v);
  const f = obj(o.failed);
  const r = obj(o.resolution);
  const how = str(r, 'how');
  return {
    failed: {
      kind: kindOf(f.kind),
      id: str(f, 'id'),
      title: str(f, 'title'),
      code: nullableStr(f, 'code'),
      at: str(f, 'at'),
    },
    resolution: {
      how: (HOWS.has(how) ? how : 'retry') as SolvedFailure['resolution']['how'],
      kind: kindOf(r.kind),
      id: str(r, 'id'),
      title: str(r, 'title'),
      summary: nullableStr(r, 'summary'),
      at: str(r, 'at'),
    },
    score: num(o, 'score'),
  };
}

function list<T>(v: unknown, parse: (x: unknown) => T): T[] {
  return Array.isArray(v) ? v.map(parse) : [];
}

export function parseJobRelated(v: unknown): JobRelated {
  const o = obj(v);
  return {
    similar: list(o.similar, parseSimilar),
    givenToAgent:
      o.givenToAgent === null || o.givenToAgent === undefined ? null : strArray(o, 'givenToAgent'),
    failures: list(o.failures, parseFailure),
    unavailable: o.unavailable === undefined ? null : nullableStr(o, 'unavailable'),
  };
}

export function getJobRelated(jobId: string, opts: Opts = {}): Promise<JobRelated> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/related`, parseJobRelated, opts);
}

export function getWorkflowRunRelated(
  runId: string,
  opts: Opts = {},
): Promise<{ failures: SolvedFailure[]; unavailable: string | null }> {
  return apiRequest(
    'GET',
    `/workflows/runs/${encodeURIComponent(runId)}/related`,
    (v) => {
      const o = obj(v);
      return {
        failures: list(o.failures, parseFailure),
        unavailable: o.unavailable === undefined ? null : nullableStr(o, 'unavailable'),
      };
    },
    opts,
  );
}

function parseDuplicate(v: unknown): DuplicateHit {
  const o = obj(v);
  return {
    kind: o.kind === 'automation' ? 'automation' : 'job',
    id: str(o, 'id'),
    title: str(o, 'title'),
    state: str(o, 'state'),
    createdAt: str(o, 'createdAt'),
    score: num(o, 'score'),
  };
}

/** "A similar record exists" — open or recent jobs / live automations of the project that look like `text`. */
export function checkSimilar(
  kind: 'job' | 'automation',
  body: { readonly project: string; readonly text: string; readonly excludeId?: string | null },
  opts: Opts = {},
): Promise<{ items: DuplicateHit[]; unavailable: string | null }> {
  return apiRequest(
    'POST',
    kind === 'job' ? '/related/check/jobs' : '/related/check/automations',
    (v) => {
      const o = obj(v);
      return {
        items: list(o.items, parseDuplicate),
        unavailable: o.unavailable === undefined ? null : nullableStr(o, 'unavailable'),
      };
    },
    { ...opts, body: { project: body.project, text: body.text, excludeId: body.excludeId ?? null } },
  );
}

function parseSettings(v: unknown): RelatedSettings {
  const o = obj(v);
  const p = obj(o.platform);
  return {
    project: str(o, 'project'),
    contextEnabled: o.contextEnabled === true,
    version: int(o, 'version'),
    platform: { enabled: p.enabled === true, context: p.context === true },
  };
}

export function getRelatedSettings(project: string, opts: Opts = {}): Promise<RelatedSettings> {
  return apiRequest('GET', `/related/settings?project=${encodeURIComponent(project)}`, parseSettings, opts);
}

export function setRelatedSettings(body: {
  readonly project: string;
  readonly contextEnabled: boolean;
  readonly expectedVersion: number;
}): Promise<RelatedSettings> {
  return apiRequest('PUT', '/related/settings', parseSettings, { body });
}
