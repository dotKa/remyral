import type { PrefillState } from '../screens/composer/prefill';
import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p12-deploy-feedback (ADR-0048; apps/master/src/ops/feedback-routes.ts): deploy logs (build / runtime / health), the
 * failure summary and fix plan of an ops action, a job's fix chain and the project's auto-fix setting. Log text is
 * data from the deployed application (redacted by the master) and is only ever rendered as text.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;

export type DeployLogKind = 'build' | 'runtime' | 'health';

export interface DeployLogSource {
  readonly id: string;
  readonly label: string;
  readonly status: string | null;
  readonly text: string;
  readonly truncated: boolean;
}

export interface DeployLogs {
  readonly kind: DeployLogKind;
  readonly provider: 'coolify' | 'cloudflare' | null;
  readonly sources: readonly DeployLogSource[];
  readonly health: Json | null;
  readonly note: string | null;
}

const bool = (o: Json, k: string): boolean => o[k] === true;

export function getDeployLogs(
  id: string,
  kind: DeployLogKind,
  q: { readonly lines?: number; readonly sinceMinutes?: number } = {},
  opts: Opts = {},
): Promise<DeployLogs> {
  const params = new URLSearchParams({ kind });
  if (q.lines !== undefined) params.set('lines', String(q.lines));
  if (q.sinceMinutes !== undefined) params.set('sinceMinutes', String(q.sinceMinutes));
  return apiRequest(
    'GET',
    `/deploy/actions/${encodeURIComponent(id)}/logs?${params.toString()}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.sources)) throw new ShapeError('sources');
      const provider = o.provider === 'coolify' || o.provider === 'cloudflare' ? o.provider : null;
      return {
        kind: o.kind === 'runtime' || o.kind === 'health' ? o.kind : 'build',
        provider,
        sources: o.sources.map((s) => {
          const x = obj(s);
          return {
            id: str(x, 'id'),
            label: str(x, 'label'),
            status: nullableStr(x, 'status'),
            text: str(x, 'text'),
            truncated: bool(x, 'truncated'),
          };
        }),
        health: typeof o.health === 'object' && o.health !== null ? (o.health as Json) : null,
        note: nullableStr(o, 'note'),
      };
    },
    opts,
  );
}

export interface DeployFailure {
  readonly actionId: string;
  readonly project: string;
  readonly kind: string;
  readonly env: string | null;
  readonly state: string;
  readonly failure: 'deploy' | 'publish' | 'health' | null;
  readonly error: string | null;
  readonly sourceJobId: string | null;
  readonly summary: string;
}

export function getDeployFailure(id: string, opts: Opts = {}): Promise<DeployFailure> {
  return apiRequest(
    'GET',
    `/deploy/actions/${encodeURIComponent(id)}/failure`,
    (v) => {
      const o = obj(v);
      const f = o.failure;
      return {
        actionId: str(o, 'actionId'),
        project: str(o, 'project'),
        kind: str(o, 'kind'),
        env: nullableStr(o, 'env'),
        state: str(o, 'state'),
        failure: f === 'deploy' || f === 'publish' || f === 'health' ? f : null,
        error: nullableStr(o, 'error'),
        sourceJobId: nullableStr(o, 'sourceJobId'),
        summary: str(o, 'summary'),
      };
    },
    opts,
  );
}

export interface FixPlan {
  readonly project: string;
  readonly projectKind: 'repository' | 'workspace';
  readonly title: string;
  readonly spec: Json;
  readonly continueFrom: string | null;
  readonly deployOnSuccess: {
    readonly target: 'pages' | 'coolify';
    readonly env: 'preview' | 'production';
    readonly directory?: string;
  } | null;
  readonly summary: string;
}

export function getFixPlan(id: string, opts: Opts = {}): Promise<FixPlan> {
  return apiRequest(
    'GET',
    `/deploy/actions/${encodeURIComponent(id)}/fix-plan`,
    (v) => {
      const o = obj(v);
      const spec = o.spec;
      if (typeof spec !== 'object' || spec === null) throw new ShapeError('spec');
      const d = o.deployOnSuccess === null || o.deployOnSuccess === undefined ? null : obj(o.deployOnSuccess);
      return {
        project: str(o, 'project'),
        projectKind: o.projectKind === 'workspace' ? 'workspace' : 'repository',
        title: str(o, 'title'),
        spec: spec as Json,
        continueFrom: nullableStr(o, 'continueFrom'),
        deployOnSuccess:
          d === null
            ? null
            : {
                target: d.target === 'pages' ? 'pages' : 'coolify',
                env: d.env === 'production' ? 'production' : 'preview',
                ...(typeof d.directory === 'string' ? { directory: d.directory } : {}),
              },
        summary: typeof o.failure === 'object' && o.failure !== null ? str(obj(o.failure), 'summary') : '',
      };
    },
    opts,
  );
}

export interface AutofixSettings {
  readonly project: string;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly runtime: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

function parseAutofix(v: unknown): AutofixSettings {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    enabled: bool(o, 'enabled'),
    maxAttempts: typeof o.maxAttempts === 'number' ? o.maxAttempts : 1,
    runtime: nullableStr(o, 'runtime'),
    updatedAt: nullableStr(o, 'updatedAt'),
    updatedBy: nullableStr(o, 'updatedBy'),
  };
}

export function getDeployAutofix(project: string, opts: Opts = {}): Promise<AutofixSettings> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/deploy-autofix`, parseAutofix, opts);
}

export function putDeployAutofix(
  project: string,
  body: { readonly enabled: boolean; readonly maxAttempts?: number },
  opts: Opts = {},
): Promise<AutofixSettings> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/deploy-autofix`, parseAutofix, {
    ...opts,
    body,
  });
}

export interface DeployFixChain {
  readonly fixOf: {
    readonly opsActionId: string | null;
    readonly sourceJobId: string | null;
    readonly attempt: number;
  } | null;
  readonly fixes: readonly {
    readonly id: string;
    readonly fixJobId: string | null;
    readonly opsActionId: string | null;
    readonly failure: string;
    readonly state: string;
    readonly reason: string | null;
    readonly attempt: number;
  }[];
}

export function getJobDeployFixes(jobId: string, opts: Opts = {}): Promise<DeployFixChain> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/deploy-fixes`,
    (v) => {
      const o = obj(v);
      const of = o.fixOf === null || o.fixOf === undefined ? null : obj(o.fixOf);
      return {
        fixOf:
          of === null
            ? null
            : {
                opsActionId: nullableStr(of, 'opsActionId'),
                sourceJobId: nullableStr(of, 'sourceJobId'),
                attempt: typeof of.attempt === 'number' ? of.attempt : 1,
              },
        fixes: (Array.isArray(o.fixes) ? o.fixes : []).map((f) => {
          const x = obj(f);
          return {
            id: str(x, 'id'),
            fixJobId: nullableStr(x, 'fixJobId'),
            opsActionId: nullableStr(x, 'opsActionId'),
            failure: str(x, 'failure'),
            state: str(x, 'state'),
            reason: nullableStr(x, 'reason'),
            attempt: typeof x.attempt === 'number' ? x.attempt : 1,
          };
        }),
      };
    },
    opts,
  );
}

/** Router state for `/jobs/new` built from a fix plan (the composer's own validation and the master decide). */
export function fixPrefillState(plan: FixPlan): PrefillState {
  return {
    prefill: {
      project: plan.project,
      spec: plan.spec,
      ...(plan.continueFrom === null ? {} : { continueFrom: plan.continueFrom }),
      ...(plan.deployOnSuccess === null ? {} : { deployOnSuccess: { ...plan.deployOnSuccess } }),
    },
  };
}
