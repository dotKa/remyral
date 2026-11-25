import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/** Typed wrappers for the runtime policy routes (apps/master/src/runtime-policy/routes.ts). */

export interface PolicyRuntimeRow {
  readonly runtime: string;
  readonly pinned: string;
  /** p17-update-channel: held by the owner, or following the release / catalog pin (absent: an older master). */
  readonly pinMode?: 'follow' | 'hold';
  readonly installed: string | null;
  readonly status: 'match' | 'mismatch' | 'not-installed' | 'unknown';
  readonly allowUnpinned: boolean;
  readonly authModes: readonly string[];
  readonly defaultProfile: string | null;
  readonly profiles: readonly string[];
}

export interface WorkerRuntimePolicy {
  readonly workerId: string;
  readonly assignedPolicy: string | null;
  readonly canary: boolean;
  readonly effective: {
    readonly policy: string;
    readonly version: number;
    readonly stage: 'active' | 'canary';
    readonly documentHash: string;
  } | null;
  readonly applied: {
    readonly policy: string | null;
    readonly version: number | null;
    readonly at: string | null;
  };
  readonly inSync: boolean;
  readonly runtimes: readonly PolicyRuntimeRow[];
}

export interface RuntimePolicySummary {
  readonly name: string;
  readonly activeVersion: number | null;
  readonly canaryVersion: number | null;
  readonly previousVersion: number | null;
  readonly workers: number;
  readonly canaryWorkers: number;
}

type Opts = Omit<RequestOptions, 'body'>;

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

const STATUSES = new Set(['match', 'mismatch', 'not-installed', 'unknown']);

export function workerRuntimePolicy(v: unknown): WorkerRuntimePolicy {
  const o = obj(v);
  const eff = o.effective === null ? null : obj(o.effective);
  const applied = obj(o.applied);
  const rts = o.runtimes;
  if (!Array.isArray(rts)) throw new ShapeError('expected runtimes[]');
  const stage = eff === null ? null : str(eff, 'stage');
  if (stage !== null && stage !== 'active' && stage !== 'canary') throw new ShapeError('bad stage');
  return {
    workerId: str(o, 'workerId'),
    assignedPolicy: nullableStr(o, 'assignedPolicy'),
    canary: bool(o, 'canary'),
    effective:
      eff === null || stage === null
        ? null
        : {
            policy: str(eff, 'policy'),
            version: int(eff, 'version'),
            stage,
            documentHash: str(eff, 'documentHash'),
          },
    applied: {
      policy: nullableStr(applied, 'policy'),
      version: nullableInt(applied, 'version'),
      at: nullableStr(applied, 'at'),
    },
    inSync: bool(o, 'inSync'),
    runtimes: rts.map((r) => {
      const ro = obj(r);
      const status = str(ro, 'status');
      if (!STATUSES.has(status)) throw new ShapeError('bad status');
      return {
        runtime: str(ro, 'runtime'),
        pinned: str(ro, 'pinned'),
        ...(ro.pinMode === 'hold' || ro.pinMode === 'follow' ? { pinMode: ro.pinMode } : {}),
        installed: nullableStr(ro, 'installed'),
        status: status as PolicyRuntimeRow['status'],
        allowUnpinned: bool(ro, 'allowUnpinned'),
        authModes: strArray(ro, 'authModes'),
        defaultProfile: nullableStr(ro, 'defaultProfile'),
        profiles: strArray(ro, 'profiles'),
      };
    }),
  };
}

function policySummary(v: unknown): RuntimePolicySummary {
  const o = obj(v);
  return {
    name: str(o, 'name'),
    activeVersion: nullableInt(o, 'activeVersion'),
    canaryVersion: nullableInt(o, 'canaryVersion'),
    previousVersion: nullableInt(o, 'previousVersion'),
    workers: int(o, 'workers'),
    canaryWorkers: int(o, 'canaryWorkers'),
  };
}

export function getWorkerRuntimePolicy(id: string, opts: Opts = {}): Promise<WorkerRuntimePolicy> {
  return apiRequest('GET', `/workers/${encodeURIComponent(id)}/runtime-policy`, workerRuntimePolicy, opts);
}

export function listRuntimePolicies(opts: Opts = {}): Promise<RuntimePolicySummary[]> {
  return apiRequest(
    'GET',
    '/runtime-policies',
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('expected items[]');
      return items.map(policySummary);
    },
    opts,
  );
}

export function assignRuntimePolicy(
  id: string,
  body: { policy: string | null; canary: boolean },
  opts: Opts = {},
): Promise<WorkerRuntimePolicy> {
  return apiRequest('PUT', `/workers/${encodeURIComponent(id)}/runtime-policy`, workerRuntimePolicy, {
    ...opts,
    body,
  });
}

export function promoteRuntimePolicy(
  name: string,
  version: number,
  opts: Opts = {},
): Promise<RuntimePolicySummary> {
  return apiRequest('POST', `/runtime-policies/${encodeURIComponent(name)}/promote`, policySummary, {
    ...opts,
    body: { version },
  });
}

export function rollbackRuntimePolicy(name: string, opts: Opts = {}): Promise<RuntimePolicySummary> {
  return apiRequest('POST', `/runtime-policies/${encodeURIComponent(name)}/rollback`, policySummary, {
    ...opts,
    body: {},
  });
}

// ------------------------------------------------------------- p5-runtime-policy-ui: documents and editing

export type RuntimeAuthMode = 'secret-ref' | 'local-login';

export interface PolicyModelProfile {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/** One runtime rule of a policy document (packages/protocol/src/runtime-policy.ts RuntimePolicyRule). */
export interface PolicyRule {
  readonly version: string;
  /** p17-update-channel: absent / follow = the release or catalog pin; hold = exactly `version` (a deliberate hold). */
  readonly pin?: 'follow' | 'hold';
  /** p17-update-channel: who held the version, when and why. */
  readonly hold?: { readonly by: string; readonly at: string; readonly note?: string };
  readonly authModes: readonly RuntimeAuthMode[];
  readonly allowUnpinned: boolean;
  readonly allowUnverified?: boolean;
  readonly modelProfiles: readonly PolicyModelProfile[];
  readonly defaultProfile: string | null;
}

export interface PolicyDocument {
  readonly runtimes: Readonly<Record<string, PolicyRule>>;
  readonly projectProfiles: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export interface PolicyVersion {
  readonly version: number;
  readonly documentHash: string;
  readonly document: PolicyDocument;
  readonly changeNote: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface RuntimePolicyDetail extends RuntimePolicySummary {
  readonly description: string | null;
  readonly active: PolicyVersion | null;
  readonly canary: PolicyVersion | null;
}

/** The master validates every document on write; the UI only checks the outer shape. */
function policyDocument(v: unknown): PolicyDocument {
  const o = obj(v);
  const runtimes = obj(o.runtimes);
  obj(o.projectProfiles);
  for (const r of Object.values(runtimes)) {
    const ro = obj(r);
    str(ro, 'version');
    strArray(ro, 'authModes');
    bool(ro, 'allowUnpinned');
    if (!Array.isArray(ro.modelProfiles)) throw new ShapeError('expected modelProfiles[]');
  }
  return o as unknown as PolicyDocument;
}

function policyVersion(v: unknown): PolicyVersion {
  const o = obj(v);
  return {
    version: int(o, 'version'),
    documentHash: str(o, 'documentHash'),
    document: policyDocument(o.document),
    changeNote: nullableStr(o, 'changeNote'),
    createdAt: str(o, 'createdAt'),
    createdBy: nullableStr(o, 'createdBy'),
  };
}

export function runtimePolicyDetail(v: unknown): RuntimePolicyDetail {
  const o = obj(v);
  return {
    ...policySummary(v),
    description: o.description === undefined ? null : nullableStr(o, 'description'),
    active: o.active == null ? null : policyVersion(o.active),
    canary: o.canary == null ? null : policyVersion(o.canary),
  };
}

export function listRuntimePolicyDetails(opts: Opts = {}): Promise<RuntimePolicyDetail[]> {
  return apiRequest(
    'GET',
    '/runtime-policies',
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('expected items[]');
      return items.map(runtimePolicyDetail);
    },
    opts,
  );
}

/** A valid starter document from the compiled-in pins (GET /runtime-policies/template). */
export function getRuntimePolicyTemplate(opts: Opts = {}): Promise<PolicyDocument> {
  return apiRequest('GET', '/runtime-policies/template', (v) => policyDocument(obj(v).document), opts);
}

export function listRuntimePolicyVersions(name: string, opts: Opts = {}): Promise<PolicyVersion[]> {
  return apiRequest(
    'GET',
    `/runtime-policies/${encodeURIComponent(name)}/versions`,
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('expected items[]');
      return items.map(policyVersion);
    },
    opts,
  );
}

export function putRuntimePolicy(
  name: string,
  body: {
    readonly document: PolicyDocument;
    readonly stage: 'all' | 'canary';
    readonly expectedVersion: number;
    readonly changeNote?: string;
  },
  opts: Opts = {},
): Promise<RuntimePolicyDetail> {
  return apiRequest('PUT', `/runtime-policies/${encodeURIComponent(name)}`, runtimePolicyDetail, {
    ...opts,
    body,
  });
}

export function rollbackRuntimePolicyTo(
  name: string,
  toVersion: number,
  opts: Opts = {},
): Promise<RuntimePolicySummary> {
  return apiRequest('POST', `/runtime-policies/${encodeURIComponent(name)}/rollback`, policySummary, {
    ...opts,
    body: { toVersion },
  });
}
