import { parsePublish } from './automations';
import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p6-deploy-on-success (ADR-0030; apps/master/src/ops/on-success.ts): a job's "deploy when done" — what it deploys
 * to, where it stands, the live address and why it did not deploy.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const DEPLOY_ON_SUCCESS_STATES = [
  'pending',
  'running',
  'requested',
  'succeeded',
  'failed',
  'refused',
  'skipped',
] as const;
export type DeployOnSuccessState = (typeof DEPLOY_ON_SUCCESS_STATES)[number];

export interface JobDeployOnSuccess {
  readonly id: string;
  readonly jobId: string;
  readonly project: string;
  readonly target: 'pages' | 'coolify';
  readonly env: 'preview' | 'production';
  readonly directory: string | null;
  readonly state: DeployOnSuccessState;
  readonly reason: string | null;
  readonly url: string | null;
  readonly opsActionId: string | null;
  readonly opsActionState: string | null;
  /**
   * The level approved at creation (auto / approval / approval_step_up), or `none` (p10-publish-bundle): the job's
   * agent asked to publish — the master requests it when the job succeeds and it needs an approval then.
   */
  readonly covers: string;
  readonly approvedBy: { readonly id: string; readonly username: string | null };
  readonly approvedAt: string;
  readonly stepUp: boolean;
  readonly via: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** p10-publish-bundle: where the site is published (null: the Pages target, no domain). */
  readonly publish: {
    readonly pagesProject: string | null;
    readonly createIfMissing: boolean;
    readonly domain: string | null;
    readonly dns: 'auto' | 'skip';
  } | null;
}

/** Waiting for the job or for the deploy (worth polling). */
export function deployOpen(s: DeployOnSuccessState): boolean {
  return s === 'pending' || s === 'running' || s === 'requested';
}

export function parseDeployOnSuccess(v: unknown): JobDeployOnSuccess | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const target = str(o, 'target');
  const env = str(o, 'env');
  const state = str(o, 'state');
  if (target !== 'pages' && target !== 'coolify') throw new ShapeError('target');
  if (env !== 'preview' && env !== 'production') throw new ShapeError('env');
  if (!(DEPLOY_ON_SUCCESS_STATES as readonly string[]).includes(state)) throw new ShapeError('state');
  const by = obj(o.approvedBy);
  return {
    id: str(o, 'id'),
    jobId: str(o, 'jobId'),
    project: str(o, 'project'),
    target,
    env,
    directory: nullableStr(o, 'directory'),
    state: state as DeployOnSuccessState,
    reason: nullableStr(o, 'reason'),
    url: nullableStr(o, 'url'),
    opsActionId: nullableStr(o, 'opsActionId'),
    opsActionState: nullableStr(o, 'opsActionState'),
    covers: str(o, 'covers'),
    approvedBy: { id: str(by, 'id'), username: nullableStr(by, 'username') },
    approvedAt: str(o, 'approvedAt'),
    stepUp: o.stepUp === true,
    via: str(o, 'via'),
    createdAt: str(o, 'createdAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
    publish: parsePublish(o.publish),
  };
}

export function getJobDeployOnSuccess(jobId: string, opts: Opts = {}): Promise<JobDeployOnSuccess | null> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/deploy-on-success`,
    (v) => parseDeployOnSuccess(obj(v).deployOnSuccess),
    opts,
  );
}

/** Only an https address is ever rendered as a link (the URL comes from the provider). */
export function safeHttpsUrl(u: string | null): string | null {
  if (u === null) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
