import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * Typed wrappers for the panel-managed worker configuration routes (ADR-0015,
 * apps/master/src/worker-config/routes.ts). The spec mirrors `WorkerConfigSpec` of @remyral/protocol; the
 * master validates every write, so the client only checks the response's structure.
 */

/** ADR-0023: the four runtimes the platform runs (OpenHands was removed). */
export const CONFIG_RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type ConfigRuntime = (typeof CONFIG_RUNTIMES)[number];
export const SANDBOX_PROFILES = ['container', 'runtime-sandbox', 'host-restricted'] as const;
export type SandboxProfileName = (typeof SANDBOX_PROFILES)[number];

export type CredentialRef =
  | { readonly source: 'worker-store'; readonly name: string; readonly env?: string }
  | { readonly source: 'vault'; readonly id: string; readonly env?: string };

export type RuntimeAuth =
  { readonly mode: 'local-login' } | { readonly mode: 'secret-ref'; readonly credentialRef: CredentialRef };

export interface RuntimeSettings {
  readonly auth?: RuntimeAuth;
  readonly modelProfile?: string;
  /** pi */
  readonly provider?: string;
  /** claude-code, codex, pi, opencode */
  readonly model?: string;
  /** opencode */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** p17-worker-managed: Pi extension files and the executable of a runtime (owner-only route). */
export interface RuntimePaths {
  readonly binary?: string;
  readonly extensions?: readonly string[];
}

/**
 * p17-worker-managed: the worker's local settings managed from the panel (protocol `WorkerSettings`); a key the
 * worker's local file writes pins it there. `runtimePaths` changes only through {@link putRuntimePaths}.
 */
export interface WorkerSettingsSpec {
  readonly updates?: {
    readonly enabled?: boolean;
    readonly channel?: 'stable' | 'canary';
    readonly minVersion?: string;
    readonly healthTimeoutSec?: number;
  };
  readonly logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly telemetry?: { readonly otlpEndpoint: string | null };
  readonly assistant?: {
    readonly disabled?: boolean;
    readonly maxSessions?: number;
    readonly sandbox?: 'auto' | 'required';
  };
  readonly remoteOps?: {
    readonly npmRegistry?: string;
    readonly restartable?: boolean;
    readonly logFileBytes?: number;
  };
  readonly packageCaches?: { readonly enabled?: boolean };
  readonly probes?: {
    readonly loginRecheckMinutes?: number;
    readonly usageProbeMinutes?: number;
    readonly claudeLockMaxAgeMinutes?: number;
  };
  /** p22-sandbox-settings: Linux host-sandbox switches (needs a worker-sandbox-settings-v1 worker). */
  readonly sandbox?: {
    readonly linuxLoginStoreView?: boolean;
    readonly linuxPrivateNetwork?: 'auto' | 'off';
  };
  readonly runtimePaths?: Readonly<Partial<Record<ConfigRuntime, RuntimePaths>>>;
}

/** p17-worker-managed: what the worker reports for its managed local settings. */
export interface AppliedSettingsReport {
  readonly values: {
    readonly updates?: {
      readonly enabled: boolean;
      readonly channel: string;
      readonly minVersion?: string;
      readonly healthTimeoutSec: number;
    };
    readonly logLevel?: string;
    readonly telemetry?: { readonly otlpEndpoint: string | null };
    readonly assistant?: {
      readonly disabled: boolean;
      readonly maxSessions: number;
      readonly sandbox: string;
    };
    readonly remoteOps?: {
      readonly npmRegistry: string | null;
      readonly restartable: boolean | null;
      readonly logFileBytes: number;
    };
    readonly packageCaches?: { readonly enabled: boolean };
    readonly probes?: {
      readonly loginRecheckMinutes: number | null;
      readonly usageProbeMinutes: number | null;
      readonly claudeLockMaxAgeMinutes: number | null;
    };
    readonly sandbox?: { readonly linuxLoginStoreView: boolean; readonly linuxPrivateNetwork: string };
    readonly runtimePaths?: Readonly<Partial<Record<ConfigRuntime, RuntimePaths>>>;
  };
  readonly pinned: readonly string[];
  readonly pendingRestart: readonly string[];
}

export interface WorkerConfigSpec {
  readonly projects: readonly string[];
  readonly allowedRuntimes: readonly ConfigRuntime[];
  readonly maxParallelJobs: number;
  readonly sandboxProfiles: readonly SandboxProfileName[];
  readonly workspace: {
    readonly retainFailed?: number | undefined;
    readonly minFreeBytes?: number | undefined;
    readonly submodules?: 'skip' | 'allowlisted' | undefined;
    /** p6-warm-caches: size limit of the shared package caches (0 = off); needs a package-caches-v1 worker. */
    readonly packageCacheMaxBytes?: number | undefined;
    /**
     * p17-disk-selfclean: the worker's own disk cleanup (absent: on, default margin 1 GiB); needs a disk-hygiene-v1
     * worker.
     */
    readonly diskHygiene?:
      { readonly enabled: boolean; readonly marginBytes?: number | undefined } | undefined;
  };
  readonly labels: Readonly<Record<string, string>>;
  readonly runtimes: Readonly<Partial<Record<ConfigRuntime, RuntimeSettings>>>;
  /** p17-worker-managed (needs a worker-managed-v1 worker). */
  readonly settings?: WorkerSettingsSpec;
}

export interface ConfigBlock {
  readonly path: string;
  readonly code: string;
  readonly detail?: string;
}

export interface WorkerConfigReport {
  readonly source: 'panel' | 'local';
  readonly generation: number;
  readonly documentHash?: string;
  readonly appliedAt?: string;
  readonly effective: {
    readonly projects: readonly string[];
    readonly allowedRuntimes: readonly string[];
    readonly maxParallelJobs: number;
    readonly sandboxProfiles: readonly string[];
    readonly runtimeAuth: Readonly<Record<string, string>>;
    readonly labels: Readonly<Record<string, string>>;
    /** p5-credentials-models: what each runtime actually runs with (names only, never values). */
    readonly runtimes?: Readonly<Partial<Record<ConfigRuntime, AppliedRuntimeSettings>>>;
    /** p17-worker-managed: managed local settings in effect, pins and pending restarts. */
    readonly settings?: AppliedSettingsReport;
  };
  readonly ceiling: {
    readonly projects: readonly string[] | null;
    readonly repoHosts: readonly string[] | null;
    readonly allowedRuntimes: readonly string[] | null;
    readonly maxParallelJobs: number | null;
    readonly sandboxProfiles: readonly string[] | null;
    readonly pinnedRuntimes: readonly string[];
    /** The machine owner's local vetoes (`false` = forbidden here; absent / null = not restricted). */
    readonly allowUnconfined?: boolean | null;
    readonly allowMachineAdmin?: boolean | null;
    readonly allowPanelSkills?: boolean | null;
    readonly allowMcp?: boolean | null;
    readonly allowMcpEgress?: boolean | null;
    readonly allowMcpStdio?: boolean | null;
    readonly allowPanelMcp?: boolean | null;
    readonly allowCustomTools?: boolean | null;
    readonly allowServices?: boolean | null;
  };
  readonly blocked: readonly ConfigBlock[];
  readonly rejected?: {
    readonly generation: number;
    readonly reason: string;
    readonly detail?: string;
    readonly issues: readonly { readonly path: string; readonly code: string }[];
  };
}

export interface AppliedRuntimeSettings {
  readonly auth?: {
    readonly mode: string;
    readonly source?: 'worker-store' | 'vault';
    readonly credential?: string;
    readonly env?: string;
    readonly present?: boolean;
  };
  readonly modelProfile?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly pinned?: boolean;
}

/** A vault credential the panel can reference (metadata only). */
export interface CredentialOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly env: string;
  readonly sharedWithWorker: boolean;
  readonly version: number;
  readonly state: string;
}

/** A model catalog entry the panel can reference. */
export interface ModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly runtimes: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
}

export interface ConfigVersion {
  readonly generation: number;
  readonly documentHash: string;
  readonly spec: WorkerConfigSpec;
  readonly cause: string;
  readonly rollbackOf: number | null;
  readonly changeNote: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export type ConfigStatus = 'unmanaged' | 'unsupported' | 'pending' | 'applied' | 'rejected';

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly repositoryUrl: string | null;
  /** p5-research-workspace: workspaces are assignable without a repository (`repository` when omitted). */
  readonly kind: 'repository' | 'workspace';
}

export interface WorkerConfigView {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly desired: ConfigVersion | null;
  readonly delivered: { readonly generation: number | null; readonly at: string | null };
  readonly report: WorkerConfigReport | null;
  readonly reportedAt: string | null;
  readonly status: ConfigStatus;
  readonly drift: readonly { readonly path: string; readonly reason: string }[];
  readonly suggested: WorkerConfigSpec;
  readonly projectOptions: readonly ProjectOption[];
  /** p5-credentials-models (absent from older masters: empty lists). */
  readonly credentialOptions: readonly CredentialOption[];
  readonly modelOptions: readonly ModelOption[];
  readonly vault: { readonly supported: boolean; readonly keyFingerprint: string | null };
  /** p17-worker-managed (false / false from an older master). */
  readonly settings: { readonly supported: boolean; readonly machineAdmin: boolean };
}

export interface ProjectWorker {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly managed: boolean;
  readonly supported: boolean;
  readonly assigned: boolean;
  readonly effective: boolean | null;
  readonly blocked: string | null;
  readonly generation: number | null;
  readonly appliedGeneration: number | null;
}

export interface BulkPatch {
  readonly addProjects?: readonly string[];
  readonly removeProjects?: readonly string[];
  readonly allowedRuntimes?: readonly ConfigRuntime[];
  readonly maxParallelJobs?: number;
  readonly sandboxProfiles?: readonly SandboxProfileName[];
  readonly setLabels?: Readonly<Record<string, string>>;
  readonly removeLabels?: readonly string[];
}

type Opts = Omit<RequestOptions, 'body'>;

const STATUSES = new Set<string>(['unmanaged', 'unsupported', 'pending', 'applied', 'rejected']);

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

function arrayOf<T>(v: unknown, f: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(f);
}

/** Structural check of a spec (shape only; values were validated by the master on write). */
export function parseSpec(v: unknown): WorkerConfigSpec {
  const o = obj(v);
  strArray(o, 'projects');
  strArray(o, 'allowedRuntimes');
  int(o, 'maxParallelJobs');
  strArray(o, 'sandboxProfiles');
  obj(o.workspace);
  obj(o.labels);
  obj(o.runtimes);
  return o as unknown as WorkerConfigSpec;
}

function parseReport(v: unknown): WorkerConfigReport | null {
  if (v === null) return null;
  const o = obj(v);
  const source = str(o, 'source');
  if (source !== 'panel' && source !== 'local') throw new ShapeError('bad source');
  int(o, 'generation');
  const eff = obj(o.effective);
  strArray(eff, 'projects');
  strArray(eff, 'allowedRuntimes');
  int(eff, 'maxParallelJobs');
  const ceiling = obj(o.ceiling);
  strArray(ceiling, 'pinnedRuntimes');
  arrayOf(o.blocked, (b) => str(obj(b), 'code'));
  return o as unknown as WorkerConfigReport;
}

function parseVersion(v: unknown): ConfigVersion {
  const o = obj(v);
  return {
    generation: int(o, 'generation'),
    documentHash: str(o, 'documentHash'),
    spec: parseSpec(o.spec),
    cause: str(o, 'cause'),
    rollbackOf: nullableInt(o, 'rollbackOf'),
    changeNote: nullableStr(o, 'changeNote'),
    createdAt: str(o, 'createdAt'),
    createdBy: nullableStr(o, 'createdBy'),
  };
}

export function parseConfigView(v: unknown): WorkerConfigView {
  const o = obj(v);
  const status = str(o, 'status');
  if (!STATUSES.has(status)) throw new ShapeError('bad status');
  const delivered = obj(o.delivered);
  return {
    workerId: str(o, 'workerId'),
    displayName: str(o, 'displayName'),
    state: str(o, 'state'),
    connected: bool(o, 'connected'),
    supported: bool(o, 'supported'),
    desired: o.desired === null ? null : parseVersion(o.desired),
    delivered: { generation: nullableInt(delivered, 'generation'), at: nullableStr(delivered, 'at') },
    report: parseReport(o.report),
    reportedAt: nullableStr(o, 'reportedAt'),
    status: status as ConfigStatus,
    drift: arrayOf(o.drift, (d) => {
      const x = obj(d);
      return { path: str(x, 'path'), reason: str(x, 'reason') };
    }),
    suggested: parseSpec(o.suggested),
    projectOptions: arrayOf(o.projectOptions, (p) => {
      const x = obj(p);
      return {
        id: str(x, 'id'),
        name: str(x, 'name'),
        repositoryUrl: nullableStr(x, 'repositoryUrl'),
        kind: x.kind === 'workspace' ? ('workspace' as const) : ('repository' as const),
      };
    }),
    credentialOptions:
      o.credentialOptions === undefined
        ? []
        : arrayOf(o.credentialOptions, (c) => {
            const x = obj(c);
            return {
              id: str(x, 'id'),
              name: str(x, 'name'),
              kind: str(x, 'kind'),
              env: str(x, 'env'),
              sharedWithWorker: bool(x, 'sharedWithWorker'),
              version: int(x, 'version'),
              state: str(x, 'state'),
            };
          }),
    modelOptions:
      o.modelOptions === undefined
        ? []
        : arrayOf(o.modelOptions, (m) => {
            const x = obj(m);
            return {
              id: str(x, 'id'),
              displayName: str(x, 'displayName'),
              runtimes: strArray(x, 'runtimes'),
              provider: str(x, 'provider'),
              model: str(x, 'model'),
              enabled: bool(x, 'enabled'),
            };
          }),
    vault:
      o.vault === undefined
        ? { supported: false, keyFingerprint: null }
        : (() => {
            const x = obj(o.vault);
            return { supported: bool(x, 'supported'), keyFingerprint: nullableStr(x, 'keyFingerprint') };
          })(),
    settings:
      o.settings === undefined || o.settings === null
        ? { supported: false, machineAdmin: false }
        : (() => {
            const x = obj(o.settings);
            return { supported: x.supported === true, machineAdmin: x.machineAdmin === true };
          })(),
  };
}

function parseProjectWorker(v: unknown): ProjectWorker {
  const o = obj(v);
  return {
    workerId: str(o, 'workerId'),
    displayName: str(o, 'displayName'),
    state: str(o, 'state'),
    connected: bool(o, 'connected'),
    managed: bool(o, 'managed'),
    supported: bool(o, 'supported'),
    assigned: bool(o, 'assigned'),
    effective: o.effective === null ? null : bool(o, 'effective'),
    blocked: nullableStr(o, 'blocked'),
    generation: nullableInt(o, 'generation'),
    appliedGeneration: nullableInt(o, 'appliedGeneration'),
  };
}

const items =
  <T>(f: (x: unknown) => T) =>
  (v: unknown): T[] =>
    arrayOf(obj(v).items, f);

const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

export function getWorkerConfig(id: string, opts: Opts = {}): Promise<WorkerConfigView> {
  return apiRequest('GET', `${wid(id)}/config`, parseConfigView, opts);
}

export function getWorkerConfigHistory(id: string, opts: Opts = {}): Promise<ConfigVersion[]> {
  return apiRequest('GET', `${wid(id)}/config/history`, items(parseVersion), opts);
}

export function putWorkerConfig(
  id: string,
  body: { spec: WorkerConfigSpec; expectedGeneration: number; changeNote?: string; adopt?: boolean },
  opts: Opts = {},
): Promise<WorkerConfigView> {
  return apiRequest('PUT', `${wid(id)}/config`, parseConfigView, { ...opts, body });
}

/**
 * p17-worker-managed: which executable each runtime runs (and Pi extension files) — owner only, always-fresh step-up,
 * only with machine administration enabled; an empty map clears them.
 */
export function putRuntimePaths(
  id: string,
  body: {
    runtimePaths: Readonly<Partial<Record<ConfigRuntime, RuntimePaths>>>;
    expectedGeneration: number;
    reason?: string;
  },
  opts: Opts = {},
): Promise<WorkerConfigView> {
  return apiRequest('PUT', `${wid(id)}/config/runtime-paths`, parseConfigView, { ...opts, body });
}

export function rollbackWorkerConfig(
  id: string,
  body: { toGeneration: number; expectedGeneration: number; reason?: string },
  opts: Opts = {},
): Promise<WorkerConfigView> {
  return apiRequest('POST', `${wid(id)}/config/rollback`, parseConfigView, { ...opts, body });
}

export function bulkWorkerConfig(
  body: { workerIds: readonly string[]; patch: BulkPatch; changeNote?: string },
  opts: Opts = {},
): Promise<{ workerId: string; generation: number; changed: boolean }[]> {
  return apiRequest(
    'POST',
    '/workers/config/bulk',
    items((x) => {
      const o = obj(x);
      return { workerId: str(o, 'workerId'), generation: int(o, 'generation'), changed: bool(o, 'changed') };
    }),
    { ...opts, body },
  );
}

const pid = (id: string) => `/projects/${encodeURIComponent(id)}`;

export function listProjectWorkers(project: string, opts: Opts = {}): Promise<ProjectWorker[]> {
  return apiRequest('GET', `${pid(project)}/workers`, items(parseProjectWorker), opts);
}

export function setProjectWorkers(
  project: string,
  workerIds: readonly string[],
  opts: Opts = {},
): Promise<ProjectWorker[]> {
  return apiRequest('PUT', `${pid(project)}/workers`, items(parseProjectWorker), {
    ...opts,
    body: { workerIds },
  });
}

/** p18-project-bootstrap: the project's preferred machines (a soft placement preference of all its jobs). */
export interface PreferredWorkers {
  readonly project: string;
  readonly workerIds: readonly string[];
  readonly updatedAt: string | null;
}

function parsePreferred(v: unknown): PreferredWorkers {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    workerIds: strArray(o, 'workerIds'),
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

export function getPreferredWorkers(project: string, opts: Opts = {}): Promise<PreferredWorkers> {
  return apiRequest('GET', `${pid(project)}/preferred-workers`, parsePreferred, opts);
}

export function setPreferredWorkers(
  project: string,
  workerIds: readonly string[],
  opts: Opts = {},
): Promise<PreferredWorkers> {
  return apiRequest('PUT', `${pid(project)}/preferred-workers`, parsePreferred, {
    ...opts,
    body: { workerIds },
  });
}
