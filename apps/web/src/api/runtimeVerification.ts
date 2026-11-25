import { apiRequest, obj, type RequestOptions, ShapeError } from './client';
import type { Op, OpsRuntime } from './remoteOps';

/**
 * p17-runtime-verify (apps/master/src/capability-evidence/routes.ts): "Doğrula" on Makine → Runtime’lar, the machine's
 * evidence view, proven versions per platform, the policy dependence count and the catalog mark. Starting a run and
 * the catalog mark are owner / admin with step-up.
 */

export type VerifyOutcome = 'passed' | 'failed' | 'skipped';
export type VerificationState = 'verified' | 'partial' | 'unverified' | 'not_applicable';

export interface CheckResult {
  readonly capability: string;
  /** `passed` / `failed` / `skipped` ({@link VerifyOutcome}). */
  readonly status: string;
  readonly reason: string;
  readonly durationMs: number;
}

export interface EvidenceRun {
  readonly id: string;
  readonly workerId: string;
  readonly machine: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly platform: string;
  readonly workerVersion: string;
  readonly authMode: string;
  readonly sandboxProfile: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly stoppedBy: string | null;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly CheckResult[];
}

export interface EffectiveCapability {
  readonly capability: string;
  readonly reported: string;
  readonly declared: string | null;
  readonly effective: string;
  readonly verified: boolean;
  readonly decided: {
    readonly outcome: 'passed' | 'failed';
    readonly reason: string;
    readonly at: string;
    readonly evidenceId: string;
    readonly workerId: string;
  } | null;
  readonly note: string | null;
}

export interface RuntimeVerification {
  readonly runtime: string;
  readonly version: string;
  readonly platform: string | null;
  readonly adapterVersion: string | null;
  readonly authMode: string | null;
  readonly state: VerificationState;
  readonly capabilities: readonly EffectiveCapability[];
  readonly lastRun: EvidenceRun | null;
  readonly history: readonly (EvidenceRun & { readonly applies: boolean })[];
  readonly running: { readonly opId: string; readonly state: string } | null;
  readonly estimate: {
    readonly tokens: number;
    readonly durationSec: number;
    readonly maxTokens: number;
    readonly maxDurationSec: number;
  };
}

export interface WorkerVerification {
  readonly workerId: string;
  readonly supported: boolean;
  readonly connected: boolean;
  readonly runtimes: readonly RuntimeVerification[];
}

export interface PlatformProof {
  readonly runtime: string;
  readonly platform: string;
  readonly version: string;
  readonly adapterVersion: string;
  readonly current: boolean;
  readonly verified: readonly string[];
  readonly failed: readonly string[];
  readonly at: string;
  readonly machine: string;
  readonly workerId: string;
}

export interface PolicyDependence {
  readonly total: number;
  readonly dependent: number;
  readonly items: readonly {
    readonly workerId: string;
    readonly machine: string;
    readonly runtime: string;
    readonly version: string;
    readonly platform: string | null;
    readonly unverified: readonly string[];
    readonly canVerify: boolean;
  }[];
}

export interface CatalogProof {
  readonly runtime: string;
  readonly version: string;
  readonly evidence: 'passed' | 'failed' | 'partial';
  readonly at: string;
  readonly machine: string;
  readonly platform: string;
  readonly evidenceId: string;
  readonly marked: { readonly at: string; readonly by: string | null } | null;
}

type Opts = Omit<RequestOptions, 'body'>;
const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

function parseWorker(body: unknown): WorkerVerification {
  const o = obj(body);
  if (typeof o.supported !== 'boolean' || !Array.isArray(o.runtimes))
    throw new ShapeError('runtime verification');
  return o as unknown as WorkerVerification;
}

function items<T>(name: string) {
  return (body: unknown): T[] => {
    const o = obj(body);
    if (!Array.isArray(o.items)) throw new ShapeError(name);
    return o.items as T[];
  };
}

export function getWorkerVerification(workerId: string, opts: Opts = {}): Promise<WorkerVerification> {
  return apiRequest('GET', `${wid(workerId)}/runtime-verification`, parseWorker, opts);
}

/** "Doğrula": owner / admin, step-up; starts the signed remote operation (the op is polled like any other). */
export function verifyRuntime(workerId: string, runtime: OpsRuntime, opts: Opts = {}): Promise<Op> {
  return apiRequest(
    'POST',
    `${wid(workerId)}/runtimes/${runtime}/verify`,
    (b) => {
      const o = obj(b);
      if (typeof o.id !== 'string' || typeof o.kind !== 'string') throw new ShapeError('op');
      return o as unknown as Op;
    },
    { ...opts, body: {} },
  );
}

export function getPlatformProofs(opts: Opts = {}): Promise<PlatformProof[]> {
  return apiRequest('GET', '/runtime-verification/platforms', items<PlatformProof>('platforms'), opts);
}

export function getPolicyDependence(opts: Opts = {}): Promise<PolicyDependence> {
  return apiRequest(
    'GET',
    '/runtime-verification/policy',
    (b) => {
      const o = obj(b);
      if (typeof o.dependent !== 'number' || !Array.isArray(o.items))
        throw new ShapeError('policy dependence');
      return o as unknown as PolicyDependence;
    },
    opts,
  );
}

export function getCatalogProofs(opts: Opts = {}): Promise<CatalogProof[]> {
  return apiRequest('GET', '/runtime-verification/catalog', items<CatalogProof>('catalog'), opts);
}

export function markCatalogVerified(runtime: string, version: string, opts: Opts = {}): Promise<null> {
  return apiRequest(
    'POST',
    `/runtime-verification/catalog/${encodeURIComponent(runtime)}/${encodeURIComponent(version)}/mark`,
    () => null,
    { ...opts, body: {} },
  );
}

/** The live results of a running verification op (progress updates), or the final ones. */
export function opResults(op: Op | null): readonly CheckResult[] {
  const v = op?.result?.capabilityVerify;
  if (v === null || typeof v !== 'object') return [];
  const r = (v as { results?: unknown }).results;
  return Array.isArray(r) ? (r as CheckResult[]) : [];
}

/** Whether the master refused the evidence of a finished op (bad signature, another tuple). */
export function evidenceRefused(op: Op | null): boolean {
  const v = op?.result?.capabilityVerify;
  return v !== null && typeof v === 'object' && (v as { evidenceStored?: unknown }).evidenceStored === false;
}
