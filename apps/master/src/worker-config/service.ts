import { scanForSecrets } from '@remyral/memory';
import {
  canonicalPolicyJson,
  catalogSettings,
  CONFINED_SANDBOX_PROFILES,
  type LoginRuntime,
  SANDBOX_OPS_FEATURE,
  UNCONFINED_PARALLEL_FEATURE,
  RUNTIME_ACCOUNTS_FEATURE,
  PACKAGE_CACHES_FEATURE,
  DISK_HYGIENE_FEATURE,
  MACHINE_ADMIN_FEATURE,
  MACHINES_PROJECT,
  PANEL_SKILLS_FEATURE,
  type SandboxProfile,
  type ConfigIssue,
  ConfigRepositoryUrl,
  RuntimeKind,
  WORKER_CONFIG_SCHEMA_VERSION,
  type WorkerConfigDelivery,
  WorkerConfigDocument,
  workerConfigHash,
  workerConfigIssues,
  WorkerConfigReport,
  WorkerConfigSpec,
  workerConfigSpecIssues,
  WORKSPACE_FEATURE,
  type WorkspaceEgress,
  isRetiredRuntime,
  sameRuntimePaths,
  WORKER_MANAGED_FEATURE,
  WORKER_SANDBOX_SETTINGS_FEATURE,
  type WorkerSettings,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { loadCatalog } from '../models/service.js';
import { HttpError } from '../http/errors.js';
import { RUNTIME_REMOVED_MESSAGE } from '../jobs/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import { WORKER_ID_PATTERN } from '../workers/ids.js';
import type { WorkerSession } from '../workers/types.js';
import { OUTBOX_TOPIC_WORKER_CONFIG, type WorkerConfigOutboxPayload } from './outbox.js';
import { capacityManualOverride } from '../capacity/service.js';

/** The protocol feature a worker must advertise before it is sent APPLY_WORKER_CONFIG (ADR-0015 §6). */
export const WORKER_CONFIG_FEATURE = 'worker-config-v1';

/** p5-credentials-models: vault refs and Claude Code / Codex `model` need this worker feature (ADR-0016). */
export const VAULT_CONFIG_FEATURE = 'credential-vault-v1';
/** The worker applies `JobSpec.modelProfile` (catalog model string + credential reference). */
export const MODEL_PROFILE_FEATURE = 'model-profile-v1';

export type ConfigCause =
  | 'edit'
  | 'bulk'
  | 'project'
  | 'rollback'
  | 'adopt'
  | 'repository'
  | 'catalog'
  | 'workspace'
  /** p5-sandbox-ops: the dedicated allowUnconfined route (always-fresh step-up). */
  | 'unconfined'
  /** p5-sandbox-ops: a successful subscription login set the runtime's auth to local-login. */
  | 'login'
  /** p5-machine-admin: the owner-only machine administration switch (always-fresh step-up). */
  | 'machine_admin'
  /** p5-machine-admin: the panel skills key delivered in the document changed. */
  | 'skills_key'
  /** ADR-0023: a removed runtime (OpenHands) was dropped from the stored configuration. */
  | 'runtime_removed'
  /** p8-capacity-auto: the capacity mode set maxParallelJobs (entering / leaving auto, a new max bound). */
  | 'capacity'
  /** p13-runtime-accounts: the added runtime accounts of the machine changed (the document carries them). */
  | 'accounts'
  /** p17-worker-managed: the owner-only runtime paths route (always-fresh step-up, machine admin enabled). */
  | 'runtime_paths';

/** Spec of a worker that has neither a panel configuration nor a report to take over from. */
export const EMPTY_SPEC: WorkerConfigSpec = {
  projects: [],
  allowedRuntimes: [],
  maxParallelJobs: 1,
  sandboxProfiles: [...CONFINED_SANDBOX_PROFILES],
  workspace: {},
  labels: {},
  runtimes: {},
};

export class WorkerConfigInvalidError extends HttpError {
  constructor(
    readonly issues: readonly ConfigIssue[],
    message = 'The worker configuration is invalid; see issues.',
  ) {
    super(400, 'worker_config_invalid', message);
    this.name = 'WorkerConfigInvalidError';
  }
}

export interface WorkerConfigVersionView {
  readonly generation: number;
  readonly documentHash: string;
  readonly spec: WorkerConfigSpec;
  readonly document: WorkerConfigDocument;
  readonly cause: ConfigCause;
  readonly rollbackOf: number | null;
  readonly changeNote: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export type WorkerConfigStatus = 'unmanaged' | 'unsupported' | 'pending' | 'applied' | 'rejected';

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  /** The registered repository (`PUT /projects/:id/git`); null = cannot be assigned yet (repository projects). */
  readonly repositoryUrl: string | null;
  /** p5-research-workspace: workspace projects are assignable without a repository. */
  readonly kind: 'repository' | 'workspace';
}

export interface WorkerConfigView {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  /** The worker advertised `worker-config-v1` in its latest CAPABILITIES. */
  readonly supported: boolean;
  readonly desired: WorkerConfigVersionView | null;
  readonly delivered: { readonly generation: number | null; readonly at: string | null };
  readonly report: WorkerConfigReport | null;
  readonly reportedAt: string | null;
  readonly status: WorkerConfigStatus;
  /** Desired values that are not in effect on the worker (ceiling, invalid values, not yet applied). */
  readonly drift: { path: string; reason: string }[];
  /** Prefill for an unmanaged worker: what it runs on today (registered projects only). */
  readonly suggested: WorkerConfigSpec;
  readonly projectOptions: ProjectOption[];
  /** p5-credentials-models: vault credentials (metadata) the runtime auth may reference. */
  readonly credentialOptions: CredentialOption[];
  /** Enabled and disabled catalog profiles (the panel filters per runtime). */
  readonly modelOptions: ModelOption[];
  readonly vault: { readonly supported: boolean; readonly keyFingerprint: string | null };
  /**
   * p17-worker-managed: the worker applies panel-managed local settings (`worker-managed-v1`); `machineAdmin` — machine
   * administration is enabled in the desired configuration (runtime paths need it).
   */
  readonly settings: { readonly supported: boolean; readonly machineAdmin: boolean };
}

export interface CredentialOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly env: string;
  readonly version: number;
  readonly state: 'active' | 'revoked';
  readonly sharedWithWorker: boolean;
}

export interface ModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly runtimes: RuntimeKind[];
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
}

export interface ProjectWorkerView {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly managed: boolean;
  readonly supported: boolean;
  /** The worker's desired panel configuration includes the project. */
  readonly assigned: boolean;
  /** The worker reports the project as effective (null: no report). */
  readonly effective: boolean | null;
  /** The worker reports the project blocked (local ceiling or invalid value). */
  readonly blocked: string | null;
  readonly generation: number | null;
  readonly appliedGeneration: number | null;
}

export interface ConfigBulkPatch {
  readonly addProjects?: readonly string[] | undefined;
  readonly removeProjects?: readonly string[] | undefined;
  readonly allowedRuntimes?: readonly RuntimeKind[] | undefined;
  readonly maxParallelJobs?: number | undefined;
  readonly sandboxProfiles?: readonly SandboxProfile[] | undefined;
  readonly setLabels?: Readonly<Record<string, string>> | undefined;
  readonly removeLabels?: readonly string[] | undefined;
}

export interface WorkerConfigSigner {
  signWorkerConfig(input: {
    readonly workerId: string;
    readonly generation: number;
    readonly documentHash: string;
    readonly issuedAt: string;
  }): { kid: string; signature: string };
}

interface WorkerRow {
  id: string;
  display_name: string;
  state: string;
  features: unknown;
  config_report: unknown;
  config_reported_at: Date | null;
  approved_at: Date | null;
  revoked_at: Date | null;
}

interface ConfigRow {
  generation: number;
  delivered_generation: number | null;
  delivered_at: Date | null;
}

interface VersionRow {
  generation: number;
  spec: unknown;
  document: unknown;
  document_hash: string;
  cause: ConfigCause;
  rollback_of: number | null;
  change_note: string | null;
  created_at: Date;
  created_by: string | null;
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

/** The stored report, re-validated (a malformed row is treated as "no report", never trusted). */
export function parseReport(raw: unknown): WorkerConfigReport | null {
  if (raw === null || raw === undefined) return null;
  const parsed = WorkerConfigReport.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function versionView(r: VersionRow): WorkerConfigVersionView {
  return {
    generation: r.generation,
    documentHash: r.document_hash,
    // Stored rows were validated on write; parse again so a hand-edited row cannot reach a worker.
    spec: WorkerConfigSpec.parse(r.spec),
    document: WorkerConfigDocument.parse(r.document),
    cause: r.cause,
    rollbackOf: r.rollback_of,
    changeNote: r.change_note,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  };
}

/** Keys present in `input` that the schema stripped (typos must not silently disappear from an admin's edit). */
export function unknownKeys(input: unknown, parsed: unknown, path: readonly string[] = []): string[] {
  if (input === null || typeof input !== 'object' || parsed === null || typeof parsed !== 'object') return [];
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed)) return [];
    return input.flatMap((v, i) => unknownKeys(v, parsed[i], [...path, String(i)]));
  }
  const out: string[] = [];
  const p = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(k in p)) out.push([...path, k].join('.'));
    else out.push(...unknownKeys(v, p[k], [...path, k]));
  }
  return out;
}

/** Every string leaf, keyed by its path (for the secret scan). */
function stringLeaves(value: unknown, path: string, out: Record<string, string>): void {
  if (typeof value === 'string') out[path] = value;
  else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      stringLeaves(v, `${path}.${String(i)}`, out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      stringLeaves(v, `${path}.${k}`, out);
  }
}

/**
 * Validates an administrator's spec: schema (no unknown keys), consistency rules, and no secret-looking values
 * anywhere (labels, model ids, runtime options — ADR-0006: a worker config holds references, never values).
 */
export function validateSpec(input: unknown): WorkerConfigSpec {
  // ADR-0023: stored generations drop a removed runtime silently, but an administrator's new spec is refused.
  const raw = (input ?? {}) as { allowedRuntimes?: unknown; runtimes?: unknown };
  const removed: ConfigIssue[] = [];
  if (Array.isArray(raw.allowedRuntimes) && raw.allowedRuntimes.some((r) => isRetiredRuntime(r))) {
    removed.push({ path: 'allowedRuntimes', code: 'runtime_removed' });
  }
  if (raw.runtimes !== null && typeof raw.runtimes === 'object') {
    for (const k of Object.keys(raw.runtimes)) {
      if (isRetiredRuntime(k)) removed.push({ path: `runtimes.${k}`, code: 'runtime_removed' });
    }
  }
  if (removed.length > 0) throw new WorkerConfigInvalidError(removed, RUNTIME_REMOVED_MESSAGE);
  const parsed = WorkerConfigSpec.safeParse(input);
  if (!parsed.success) {
    throw new WorkerConfigInvalidError(
      parsed.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), code: i.code })),
    );
  }
  const spec = parsed.data;
  const issues: ConfigIssue[] = unknownKeys(input, spec).map((path) => ({ path, code: 'unknown_key' }));
  issues.push(...workerConfigSpecIssues(spec, { vault: true }));
  const leaves: Record<string, string> = {};
  stringLeaves(spec.labels, 'labels', leaves);
  stringLeaves(spec.runtimes, 'runtimes', leaves);
  for (const f of scanForSecrets(leaves)) issues.push({ path: f.field, code: 'secret_detected' });
  if (issues.length > 0) throw new WorkerConfigInvalidError(issues);
  return spec;
}

function sameSpec(a: WorkerConfigSpec, b: WorkerConfigSpec): boolean {
  const norm = ({ allowUnconfined, unconfinedParallel, machineAdmin, ...s }: WorkerConfigSpec) =>
    canonicalPolicyJson({
      ...s,
      ...(allowUnconfined === true ? { allowUnconfined: true } : {}),
      ...(unconfinedParallel === true ? { unconfinedParallel: true } : {}),
      ...(machineAdmin?.enabled === true ? { machineAdmin } : {}),
      projects: [...s.projects].sort(),
      allowedRuntimes: [...s.allowedRuntimes].sort(),
      sandboxProfiles: [...s.sandboxProfiles].sort(),
    } as unknown as Parameters<typeof canonicalPolicyJson>[0]);
  return norm(a) === norm(b);
}

/** Short, non-secret summary of a spec for audit metadata. */
function summary(spec: WorkerConfigSpec | null): Record<string, unknown> | null {
  if (spec === null) return null;
  return {
    projects: [...spec.projects].sort(),
    allowedRuntimes: [...spec.allowedRuntimes].sort(),
    maxParallelJobs: spec.maxParallelJobs,
    sandboxProfiles: [...spec.sandboxProfiles].sort(),
    ...(spec.allowUnconfined === true ? { allowUnconfined: true } : {}),
    ...(spec.unconfinedParallel === true ? { unconfinedParallel: true } : {}),
    ...(spec.machineAdmin?.enabled === true ? { machineAdmin: spec.machineAdmin } : {}),
    labels: Object.keys(spec.labels).length,
    // p17-worker-managed: which local settings the panel manages (keys only).
    ...(spec.settings === undefined ? {} : { settings: Object.keys(spec.settings).sort() }),
    runtimeAuth: Object.fromEntries(
      RuntimeKind.options.flatMap((r) => {
        const a = spec.runtimes[r]?.auth;
        return a === undefined ? [] : [[r, a.mode]];
      }),
    ),
  };
}

/** The report's effective values as a spec-shaped prefill (registered projects only). */
export function suggestedFrom(
  report: WorkerConfigReport | null,
  registered: ReadonlySet<string>,
): WorkerConfigSpec {
  if (report === null) return EMPTY_SPEC;
  return {
    ...EMPTY_SPEC,
    projects: report.effective.projects.filter((p) => registered.has(p)),
    allowedRuntimes: [...report.effective.allowedRuntimes],
    maxParallelJobs: report.effective.maxParallelJobs,
    sandboxProfiles:
      report.effective.sandboxProfiles.length > 0
        ? report.effective.sandboxProfiles.filter((p) => p !== 'unconfined')
        : [...CONFINED_SANDBOX_PROFILES],
    labels: { ...report.effective.labels },
    // p14-login-status-consistency: a machine running on its subscription login keeps it when the panel takes it
    // over — without this the first panel generation dropped `local-login` and jobs had no sign-in method (the
    // runtime then showed "signed out" next to a working login). Key references cannot be transcribed (the report
    // carries names only), so a `secret-ref` runtime is left for the admin to choose.
    runtimes: Object.fromEntries(
      report.effective.allowedRuntimes.flatMap((r) =>
        report.effective.runtimeAuth[r] === 'local-login'
          ? [[r, { auth: { mode: 'local-login' as const } }]]
          : [],
      ),
    ),
  };
}

function applyPatch(base: WorkerConfigSpec, patch: ConfigBulkPatch): WorkerConfigSpec {
  const projects = new Set(base.projects);
  for (const p of patch.addProjects ?? []) projects.add(p);
  for (const p of patch.removeProjects ?? []) projects.delete(p);
  const removed = new Set(patch.removeLabels ?? []);
  const labels: Record<string, string> = Object.fromEntries(
    Object.entries({ ...base.labels, ...(patch.setLabels ?? {}) }).filter(([k]) => !removed.has(k)),
  );
  const allowedRuntimes =
    patch.allowedRuntimes === undefined ? base.allowedRuntimes : [...patch.allowedRuntimes];
  // Settings of runtimes that are no longer allowed would make the spec inconsistent: drop them.
  const runtimes = Object.fromEntries(
    Object.entries(base.runtimes).filter(([r]) => allowedRuntimes.includes(r as RuntimeKind)),
  );
  return {
    ...base,
    projects: [...projects],
    allowedRuntimes,
    maxParallelJobs: patch.maxParallelJobs ?? base.maxParallelJobs,
    sandboxProfiles: patch.sandboxProfiles === undefined ? base.sandboxProfiles : [...patch.sandboxProfiles],
    labels,
    runtimes,
  };
}

/** Status shown in the panel (ADR-0015 §6). */
export function configStatus(
  desired: { generation: number; documentHash: string } | null,
  supported: boolean,
  report: WorkerConfigReport | null,
): WorkerConfigStatus {
  if (desired === null) return 'unmanaged';
  if (!supported) return 'unsupported';
  if (report?.rejected?.generation === desired.generation) return 'rejected';
  if (
    report?.source === 'panel' &&
    report.generation === desired.generation &&
    report.documentHash === desired.documentHash
  ) {
    return 'applied';
  }
  return 'pending';
}

/**
 * Panel-managed worker configuration (ADR-0015, docs/design/p5-managed-workers.md): per-worker generations
 * (append-only), edits, rollback, bulk changes, project-side assignment, re-resolution when a project's
 * registered repository changes, delivery over APPLY_WORKER_CONFIG and the worker's reports. Every change is one
 * transaction with its audit event and admin notification; delivery happens after the commit.
 */
export class WorkerConfigService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly signer: WorkerConfigSigner;
      /** The live session of a connected worker (WorkerHub). */
      readonly session: (workerId: string) => WorkerSession | undefined;
      /** p5-credentials-models: vault credential options for the panel (metadata only). */
      readonly credentialOptions?: (workerId: string) => Promise<CredentialOption[]>;
      /**
       * p5-machine-admin (ADR-0021): public key(s) of the panel skills key, delivered to `panel-skills-v1` workers
       * in the signed document (empty: none configured).
       */
      readonly panelSkillKeys?: readonly string[];
      /**
       * p13-runtime-accounts: the machine's added runtime accounts, delivered in `runtimes.<rt>.accounts` to
       * `runtime-accounts-v1` workers (filled here, never edited in a spec).
       */
      readonly accounts?: () => {
        documentAccounts(
          db: Queryable,
          workerId: string,
        ): Promise<
          Partial<
            Record<
              'claude-code' | 'codex',
              { id: string; kind: 'subscription' | 'api_key'; credentialId: string | null }[]
            >
          >
        >;
      } | null;
    },
  ) {}

  /**
   * p13-runtime-accounts: a machine's added accounts changed — a new generation (cause `accounts`) whose document
   * carries them, delivered at once. False when the machine is not panel-managed (accounts need a panel config).
   */
  async syncAccounts(workerId: string, actor: ActorContext | null, note: string): Promise<boolean> {
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      if ((await this.#config(tx, workerId)) === null) return false;
      const base = await this.#baseSpec(tx, workerId);
      const c = await this.#commit(tx, workerId, base, 'accounts', actor, note.slice(0, 200), null);
      return c.changed;
    });
    if (changed) await this.deliver(workerId);
    return changed;
  }

  /** Whether the machine has a panel configuration (added accounts are delivered in it). */
  async managed(workerId: string): Promise<boolean> {
    return (await this.#config(this.deps.pool, workerId)) !== null;
  }

  // ------------------------------------------------------------------------------------------- reads

  async get(workerId: string): Promise<WorkerConfigView> {
    const db = this.deps.pool;
    const w = await this.#worker(db, workerId);
    const cfg = await this.#config(db, workerId);
    const desired = cfg === null ? null : await this.#version(db, workerId, cfg.generation);
    const report = parseReport(w.config_report);
    const supported = features(w.features).includes(WORKER_CONFIG_FEATURE);
    const options = await this.projectOptions(db);
    const registered = new Set(
      options.filter((o) => o.repositoryUrl !== null || o.kind === 'workspace').map((o) => o.id),
    );
    const desiredView = desired === null ? null : versionView(desired);
    return {
      workerId,
      displayName: w.display_name,
      state: w.state,
      connected: this.deps.session(workerId) !== undefined,
      supported,
      desired: desiredView,
      delivered: { generation: cfg?.delivered_generation ?? null, at: iso(cfg?.delivered_at ?? null) },
      report,
      reportedAt: iso(w.config_reported_at),
      status: configStatus(desiredView, supported, report),
      drift: desiredView === null ? [] : drift(desiredView, report),
      suggested: suggestedFrom(report, registered),
      projectOptions: options,
      credentialOptions: (await this.deps.credentialOptions?.(workerId)) ?? [],
      modelOptions: [...(await loadCatalog(db)).values()].map(({ entry: e }) => ({
        id: e.id,
        displayName: e.displayName,
        runtimes: e.runtimes,
        provider: e.provider,
        model: e.model,
        enabled: e.enabled,
      })),
      vault: {
        supported: features(w.features).includes(VAULT_CONFIG_FEATURE),
        keyFingerprint:
          (
            await db.query<{ fingerprint: string }>(
              'SELECT fingerprint FROM worker_vault_keys WHERE worker_id = $1 AND retired_at IS NULL',
              [workerId],
            )
          ).rows[0]?.fingerprint ?? null,
      },
      settings: {
        supported: features(w.features).includes(WORKER_MANAGED_FEATURE),
        machineAdmin:
          desiredView !== null && WorkerConfigSpec.parse(desiredView.spec).machineAdmin?.enabled === true,
      },
    };
  }

  async history(workerId: string): Promise<WorkerConfigVersionView[]> {
    await this.#worker(this.deps.pool, workerId);
    const { rows } = await this.deps.pool.query<VersionRow>(
      `SELECT generation, spec, document, document_hash, cause, rollback_of, change_note, created_at,
              created_by::text AS created_by
         FROM worker_config_versions WHERE worker_id = $1 ORDER BY generation DESC LIMIT 200`,
      [workerId],
    );
    return rows.map(versionView);
  }

  /** Every registered project with its registered repository (null: not assignable yet). */
  async projectOptions(db: Queryable = this.deps.pool): Promise<ProjectOption[]> {
    const { rows } = await db.query<{
      id: string;
      name: string;
      repository_url: string | null;
      kind: 'repository' | 'workspace';
    }>(
      `SELECT p.id, p.name, g.repository_url, p.kind FROM projects p
         LEFT JOIN project_git_configs g ON g.project = p.id ORDER BY p.id`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, repositoryUrl: r.repository_url, kind: r.kind }));
  }

  /** Enrolled, non-archived workers and whether `project` is assigned / effective on each. */
  async projectWorkers(project: string): Promise<ProjectWorkerView[]> {
    await this.#project(this.deps.pool, project);
    const { rows } = await this.deps.pool.query<{
      id: string;
      display_name: string;
      state: string;
      features: unknown;
      config_report: unknown;
      generation: number | null;
      spec: unknown;
    }>(
      `SELECT w.id, w.display_name, w.state, w.features, w.config_report, c.generation, v.spec
         FROM workers w
         LEFT JOIN worker_configs c ON c.worker_id = w.id
         LEFT JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL
        ORDER BY w.display_name, w.id`,
    );
    return rows.map((r) => {
      const report = parseReport(r.config_report);
      const spec = r.spec === null ? null : WorkerConfigSpec.safeParse(r.spec);
      const block = report?.blocked.find((b) => b.path === `projects.${project}`) ?? null;
      return {
        workerId: r.id,
        displayName: r.display_name,
        state: r.state,
        connected: this.deps.session(r.id) !== undefined,
        managed: r.generation !== null,
        supported: features(r.features).includes(WORKER_CONFIG_FEATURE),
        assigned: spec?.success === true && spec.data.projects.includes(project),
        effective: report === null ? null : report.effective.projects.includes(project),
        blocked: block === null ? null : (block.detail ?? block.code),
        generation: r.generation,
        appliedGeneration: report?.source === 'panel' ? report.generation : null,
      };
    });
  }

  // ------------------------------------------------------------------------------------------ writes

  /**
   * Stores a new generation for one worker (optimistic: `expectedGeneration` is the generation the editor saw,
   * 0 for an unmanaged worker). An unchanged spec creates no generation. `adopt` marks the first generation
   * taken over from the worker's local file.
   */
  async put(
    workerId: string,
    input: {
      spec: unknown;
      expectedGeneration: number;
      changeNote?: string | undefined;
      adopt?: boolean | undefined;
    },
    actor: ActorContext,
  ): Promise<WorkerConfigView> {
    const spec = validateSpec(input.spec);
    const note = this.#note(input.changeNote);
    const { changed } = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      await this.#enrolled(tx, workerId);
      const current = await this.#config(tx, workerId);
      const generation = current?.generation ?? 0;
      if (generation !== input.expectedGeneration) {
        throw conflict(
          'version_conflict',
          `The worker configuration is at generation ${String(generation)}; reload and try again.`,
        );
      }
      // ADR-0019: the general editor cannot switch `unconfined` (its route needs always-fresh step-up).
      const before = current === null ? null : await this.#version(tx, workerId, current.generation);
      const wasAllowed = before !== null && WorkerConfigSpec.parse(before.spec).allowUnconfined === true;
      if (spec.allowUnconfined !== undefined && spec.allowUnconfined !== wasAllowed) {
        throw new WorkerConfigInvalidError([{ path: 'allowUnconfined', code: 'use_unconfined_route' }]);
      }
      // p19-unconfined-parallel: switched on the same route.
      const wasParallel = before !== null && WorkerConfigSpec.parse(before.spec).unconfinedParallel === true;
      if (spec.unconfinedParallel !== undefined && spec.unconfinedParallel !== wasParallel) {
        throw new WorkerConfigInvalidError([{ path: 'unconfinedParallel', code: 'use_unconfined_route' }]);
      }
      // ADR-0021: machine administration changes only through its owner-only, always-fresh route.
      const wasAdmin = before === null ? undefined : WorkerConfigSpec.parse(before.spec).machineAdmin;
      if (
        spec.machineAdmin !== undefined &&
        canonicalPolicyJson(spec.machineAdmin) !== canonicalPolicyJson(wasAdmin ?? null)
      ) {
        throw new WorkerConfigInvalidError([{ path: 'machineAdmin', code: 'use_machine_admin_route' }]);
      }
      // p17-worker-managed: which binary a runtime executes changes only through the owner-only route.
      const beforeSettings = before === null ? undefined : WorkerConfigSpec.parse(before.spec).settings;
      if (spec.settings?.runtimePaths !== undefined && !sameRuntimePaths(spec.settings, beforeSettings)) {
        throw new WorkerConfigInvalidError([
          { path: 'settings.runtimePaths', code: 'use_runtime_paths_route' },
        ]);
      }
      return this.#commit(tx, workerId, spec, input.adopt === true ? 'adopt' : 'edit', actor, note, null);
    });
    if (changed) await this.deliver(workerId);
    return this.get(workerId);
  }

  /**
   * ADR-0019: switches the worker's `unconfined` profile on or off — the only way `allowUnconfined` changes. The
   * route requires admin + always-fresh step-up; this records a generation with cause `unconfined`, an explicit
   * audit event `worker.sandbox.unconfined` and (through the worker.config outbox event) a critical notification to
   * owners/admins. Enabling needs a worker that understands the profile (`sandbox-ops-v1`).
   *
   * p19-unconfined-parallel: `parallel` switches the machine setting "Sandbox'sız işler paralel çalışabilir"
   * (`unconfinedParallel`) on the same route — only together with `allow: true` (absent: kept as it is; turning
   * `unconfined` off clears it). Enabling needs `unconfined-parallel-v1`. Audited in the same event (`parallel`).
   */
  async setUnconfined(
    workerId: string,
    input: {
      allow: boolean;
      parallel?: boolean | undefined;
      expectedGeneration: number;
      reason?: string | undefined;
    },
    actor: ActorContext,
  ): Promise<WorkerConfigView> {
    const note = this.#note(input.reason);
    const { changed, generation } = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      const w = await this.#enrolled(tx, workerId);
      const current = await this.#config(tx, workerId);
      const gen = current?.generation ?? 0;
      if (gen !== input.expectedGeneration) {
        throw conflict(
          'version_conflict',
          `The worker configuration is at generation ${String(gen)}; reload and try again.`,
        );
      }
      if (input.allow && !features(w.features).includes(SANDBOX_OPS_FEATURE)) {
        throw conflict(
          'worker_update_required',
          'This worker build does not know the unconfined profile; update the worker first.',
        );
      }
      if (!input.allow && input.parallel === true) {
        throw new WorkerConfigInvalidError([
          { path: 'unconfinedParallel', code: 'unconfined_parallel_needs_allow' },
        ]);
      }
      const base = await this.#baseSpec(tx, workerId);
      const { allowUnconfined: _old, unconfinedParallel: wasParallel, ...without } = base;
      const parallel = input.allow && (input.parallel ?? wasParallel === true);
      if (parallel && wasParallel !== true && !features(w.features).includes(UNCONFINED_PARALLEL_FEATURE)) {
        throw conflict(
          'worker_update_required',
          'This worker build cannot run unconfined attempts in parallel; update the worker first.',
        );
      }
      const spec: WorkerConfigSpec = input.allow
        ? { ...without, allowUnconfined: true, ...(parallel ? { unconfinedParallel: true } : {}) }
        : without;
      const c = await this.#commit(tx, workerId, spec, 'unconfined', actor, note, null);
      if (c.changed) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'worker.sandbox.unconfined',
            target: workerId,
            outcome: 'success',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: {
              allow: input.allow,
              // p19-unconfined-parallel: the parallel setting after the change (and before it, when it changed).
              parallel,
              ...((wasParallel === true) !== parallel ? { parallelBefore: wasParallel === true } : {}),
              generation: c.generation,
              ...(note === null ? {} : { reason: note }),
            },
          },
          tx,
        );
      }
      return c;
    });
    if (changed) {
      this.deps.log.warn(
        { workerId, allow: input.allow, parallel: input.parallel, generation },
        'unconfined profile switched',
      );
      await this.deliver(workerId);
    }
    return this.get(workerId);
  }

  /**
   * ADR-0021: switches AI machine administration on or off for a worker — the only way `machineAdmin` changes. The
   * route requires the OWNER role + always-fresh step-up; this records a generation with cause `machine_admin`, an
   * audit event `worker.machine_admin` and (through the worker.config outbox event) a critical notification.
   * Enabling needs a worker that understands it (`machine-admin-v1`).
   */
  async setMachineAdmin(
    workerId: string,
    input: {
      enabled: boolean;
      autoApprove: boolean;
      expectedGeneration: number;
      reason?: string | undefined;
    },
    actor: ActorContext,
  ): Promise<WorkerConfigView> {
    const note = this.#note(input.reason);
    const { changed, generation } = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      const w = await this.#enrolled(tx, workerId);
      const current = await this.#config(tx, workerId);
      const gen = current?.generation ?? 0;
      if (gen !== input.expectedGeneration) {
        throw conflict(
          'version_conflict',
          `The worker configuration is at generation ${String(gen)}; reload and try again.`,
        );
      }
      if (input.enabled && !features(w.features).includes(MACHINE_ADMIN_FEATURE)) {
        throw conflict(
          'worker_update_required',
          'This worker build cannot run machine administration jobs; update the worker first.',
        );
      }
      const base = await this.#baseSpec(tx, workerId);
      const { machineAdmin: _old, ...without } = base;
      const spec: WorkerConfigSpec = input.enabled
        ? {
            ...without,
            // The built-in Machines workspace project is where machine-admin jobs live: assign it with the switch.
            projects: without.projects.includes(MACHINES_PROJECT)
              ? without.projects
              : [...without.projects, MACHINES_PROJECT],
            machineAdmin: { enabled: true, autoApprove: input.autoApprove },
          }
        : without;
      const c = await this.#commit(tx, workerId, spec, 'machine_admin', actor, note, null);
      if (c.changed) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'worker.machine_admin',
            target: workerId,
            outcome: 'success',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: {
              enabled: input.enabled,
              autoApprove: input.enabled && input.autoApprove,
              generation: c.generation,
              ...(note === null ? {} : { reason: note }),
            },
          },
          tx,
        );
      }
      return c;
    });
    if (changed) {
      this.deps.log.warn({ workerId, enabled: input.enabled, generation }, 'machine administration switched');
      await this.deliver(workerId);
    }
    return this.get(workerId);
  }

  /**
   * p17-worker-managed: which executable each runtime runs (and Pi's extension files) — the only way
   * `settings.runtimePaths` changes. The route requires the OWNER role + always-fresh step-up; machine administration
   * must be enabled for the worker (the owner already allowed privileged administration of it, ADR-0021); the worker
   * re-validates every path. Audited `worker.runtime_paths`, delivered at once; an empty map clears them.
   */
  async setRuntimePaths(
    workerId: string,
    input: {
      runtimePaths: NonNullable<WorkerSettings['runtimePaths']>;
      expectedGeneration: number;
      reason?: string | undefined;
    },
    actor: ActorContext,
  ): Promise<WorkerConfigView> {
    const note = this.#note(input.reason);
    const { changed, generation } = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      const w = await this.#enrolled(tx, workerId);
      const current = await this.#config(tx, workerId);
      const gen = current?.generation ?? 0;
      if (gen !== input.expectedGeneration) {
        throw conflict(
          'version_conflict',
          `The worker configuration is at generation ${String(gen)}; reload and try again.`,
        );
      }
      if (!features(w.features).includes(WORKER_MANAGED_FEATURE)) {
        throw conflict(
          'worker_update_required',
          'This worker build cannot take local settings from the panel; update it first (worker-managed-v1).',
        );
      }
      const base = await this.#baseSpec(tx, workerId);
      if (base.machineAdmin?.enabled !== true) {
        throw conflict(
          'machine_admin_not_enabled',
          'Runtime paths can be set only on a machine with machine administration enabled (Admin → Machine admin).',
        );
      }
      const paths = Object.fromEntries(
        Object.entries(input.runtimePaths).filter(
          ([, v]) => v.binary !== undefined || (v.extensions ?? []).length > 0,
        ),
      );
      const { runtimePaths: _old, ...otherSettings } = base.settings ?? {};
      const settings: WorkerSettings =
        Object.keys(paths).length > 0 ? { ...otherSettings, runtimePaths: paths } : otherSettings;
      const { settings: _s, ...without } = base;
      const spec: WorkerConfigSpec = Object.keys(settings).length > 0 ? { ...without, settings } : without;
      const issues = workerConfigSpecIssues(spec, { vault: true });
      if (issues.length > 0) throw new WorkerConfigInvalidError(issues);
      const c = await this.#commit(tx, workerId, spec, 'runtime_paths', actor, note, null);
      if (c.changed) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'worker.runtime_paths',
            target: workerId,
            outcome: 'success',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: {
              generation: c.generation,
              runtimePaths: paths,
              ...(note === null ? {} : { reason: note }),
            },
          },
          tx,
        );
      }
      return c;
    });
    if (changed) {
      this.deps.log.warn({ workerId, generation }, 'runtime paths changed');
      await this.deliver(workerId);
    }
    return this.get(workerId);
  }

  /** ADR-0021: the desired machine administration setting of a worker (disabled without a panel config). */
  async machineAdmin(
    workerId: string,
    db: Queryable = this.deps.pool,
  ): Promise<{ enabled: boolean; autoApprove: boolean; generation: number }> {
    const cfg = await this.#config(db, workerId);
    if (cfg === null) return { enabled: false, autoApprove: false, generation: 0 };
    const v = await this.#version(db, workerId, cfg.generation);
    const m = v === null ? undefined : WorkerConfigSpec.parse(v.spec).machineAdmin;
    return { enabled: m?.enabled === true, autoApprove: m?.autoApprove === true, generation: cfg.generation };
  }

  /**
   * ADR-0021: a new panel skills key (or the first one) must reach every managed `panel-skills-v1` worker: a new
   * generation (cause `skills_key`) for each whose stored document carries other keys. Never throws.
   */
  async #panelKeysStale(workerId: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ document: unknown; features: unknown }>(
      `SELECT v.document, w.features FROM worker_configs c
         JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
         JOIN workers w ON w.id = c.worker_id WHERE c.worker_id = $1`,
      [workerId],
    );
    const r = rows[0];
    if (r === undefined) return false;
    const doc = WorkerConfigDocument.safeParse(r.document);
    const have = doc.success ? (doc.data.panelSkillKeys ?? []) : [];
    const expected = features(r.features).includes(PANEL_SKILLS_FEATURE)
      ? [...(this.deps.panelSkillKeys ?? [])]
      : [];
    return canonicalPolicyJson(have) !== canonicalPolicyJson(expected);
  }

  async syncPanelSkillKeys(only?: readonly string[]): Promise<number> {
    let changedWorkers = 0;
    try {
      const { rows } = await this.deps.pool.query<{
        worker_id: string;
        document: unknown;
        features: unknown;
      }>(
        `SELECT c.worker_id, v.document, w.features FROM worker_configs c
           JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
           JOIN workers w ON w.id = c.worker_id
          WHERE ($1::text[] IS NULL OR c.worker_id = ANY($1))`,
        [only === undefined ? null : [...only]],
      );
      const want = [...(this.deps.panelSkillKeys ?? [])];
      for (const r of rows) {
        const doc = WorkerConfigDocument.safeParse(r.document);
        const have = doc.success ? (doc.data.panelSkillKeys ?? []) : [];
        const expected = features(r.features).includes(PANEL_SKILLS_FEATURE) ? want : [];
        if (canonicalPolicyJson(have) === canonicalPolicyJson(expected)) continue;
        const changed = await withTransaction(this.deps.pool, async (tx) => {
          await this.#lock(tx, [r.worker_id]);
          const base = await this.#baseSpec(tx, r.worker_id);
          const c = await this.#commit(tx, r.worker_id, base, 'skills_key', null, 'panel skills key', null);
          return c.changed;
        });
        if (changed) {
          changedWorkers += 1;
          if (only === undefined) await this.deliver(r.worker_id);
        }
      }
    } catch (err) {
      this.deps.log.error({ err }, 'panel skills key sync failed');
    }
    return changedWorkers;
  }

  /**
   * p5-sandbox-ops: a subscription login on the worker succeeded (Remote operations). If the worker is
   * panel-managed and the runtime has no auth in the desired configuration, store a new generation (cause `login`)
   * that enables the runtime and sets `auth: local-login` — the login the owner just performed is what jobs use.
   * An existing auth (a credential reference, an explicit choice) is never replaced. Never throws.
   */
  async onLoginSucceeded(
    workerId: string,
    runtime: LoginRuntime,
    actor: ActorContext | null,
  ): Promise<boolean> {
    try {
      const changed = await withTransaction(this.deps.pool, async (tx) => {
        await this.#lock(tx, [workerId]);
        const current = await this.#config(tx, workerId);
        if (current === null) return false; // unmanaged: the local file decides
        const base = await this.#baseSpec(tx, workerId);
        if (base.runtimes[runtime]?.auth !== undefined) return false;
        const spec: WorkerConfigSpec = {
          ...base,
          allowedRuntimes: base.allowedRuntimes.includes(runtime)
            ? base.allowedRuntimes
            : [...base.allowedRuntimes, runtime],
          runtimes: {
            ...base.runtimes,
            [runtime]: { ...base.runtimes[runtime], auth: { mode: 'local-login' } },
          },
        };
        const c = await this.#commit(tx, workerId, spec, 'login', actor, `login ${runtime}`, null);
        return c.changed;
      });
      if (changed) await this.deliver(workerId);
      return changed;
    } catch (err) {
      this.deps.log.error({ err, workerId, runtime }, 'auth not set after a successful login');
      return false;
    }
  }

  /** Whether a runtime of the worker's desired configuration uses its local subscription login. */
  async usesLocalLogin(workerId: string): Promise<boolean> {
    const cfg = await this.#config(this.deps.pool, workerId);
    if (cfg === null) return false;
    const v = await this.#version(this.deps.pool, workerId, cfg.generation);
    if (v === null) return false;
    const spec = WorkerConfigSpec.parse(v.spec);
    return RuntimeKind.options.some((r) => spec.runtimes[r]?.auth?.mode === 'local-login');
  }

  /**
   * Whether the desired configuration allows `unconfined` (ADR-0019) and lets attempts without sandbox run in parallel
   * (p19-unconfined-parallel).
   */
  async unconfinedAllowed(
    workerId: string,
  ): Promise<{ allowed: boolean; parallel: boolean; generation: number }> {
    const cfg = await this.#config(this.deps.pool, workerId);
    if (cfg === null) return { allowed: false, parallel: false, generation: 0 };
    const v = await this.#version(this.deps.pool, workerId, cfg.generation);
    const spec = v === null ? null : WorkerConfigSpec.parse(v.spec);
    return {
      allowed: spec?.allowUnconfined === true,
      parallel: spec?.allowUnconfined === true && spec.unconfinedParallel === true,
      generation: cfg.generation,
    };
  }

  /** A new generation with the spec of an earlier one (repositories re-resolved from today's registration). */
  async rollback(
    workerId: string,
    input: { toGeneration: number; expectedGeneration: number; reason?: string | undefined },
    actor: ActorContext,
  ): Promise<WorkerConfigView> {
    const note = this.#note(input.reason);
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      await this.#enrolled(tx, workerId);
      const current = await this.#config(tx, workerId);
      const generation = current?.generation ?? 0;
      if (generation !== input.expectedGeneration) {
        throw conflict(
          'version_conflict',
          `The worker configuration is at generation ${String(generation)}; reload and try again.`,
        );
      }
      const target = await this.#version(tx, workerId, input.toGeneration);
      if (target === null)
        throw new HttpError(
          404,
          'not_found',
          'Configuration generation not found.',
          {},
          {},
          { reason: 'config_generation' },
        );
      if (target.generation === generation) {
        throw conflict('already_active', `Generation ${String(generation)} is already the desired one.`);
      }
      const spec = WorkerConfigSpec.parse(target.spec);
      await this.#commit(tx, workerId, spec, 'rollback', actor, note, target.generation, true);
    });
    await this.deliver(workerId);
    return this.get(workerId);
  }

  /**
   * p8-capacity-auto: the capacity mode writes maxParallelJobs (cause `capacity`, never a manual override). The route
   * that calls it already required admin + step-up; `actor` null = the master itself.
   */
  async setCapacityParallelism(
    workerId: string,
    value: number,
    actor: ActorContext | null,
    note: string,
  ): Promise<void> {
    const changeNote = this.#note(note);
    const { changed } = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, [workerId]);
      await this.#enrolled(tx, workerId);
      if ((await this.#config(tx, workerId)) === null) {
        throw conflict('worker_not_managed', 'The worker is not managed from the panel.');
      }
      const base = await this.#baseSpec(tx, workerId);
      const spec = validateSpec({ ...base, maxParallelJobs: value });
      return this.#commit(tx, workerId, spec, 'capacity', actor, changeNote, null);
    });
    if (changed) await this.deliver(workerId);
  }

  /** Applies one patch to several workers, all or nothing (one generation and audit event per changed worker). */
  async bulk(
    input: { workerIds: readonly string[]; patch: ConfigBulkPatch; changeNote?: string | undefined },
    actor: ActorContext,
  ): Promise<{ workerId: string; generation: number; changed: boolean }[]> {
    const ids = [...new Set(input.workerIds)].sort();
    if (ids.length === 0) throw new WorkerConfigInvalidError([{ path: 'workerIds', code: 'empty' }]);
    const note = this.#note(input.changeNote);
    const results = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, ids);
      const out: { workerId: string; generation: number; changed: boolean }[] = [];
      for (const id of ids) {
        await this.#enrolled(tx, id);
        const base = await this.#baseSpec(tx, id);
        let spec: WorkerConfigSpec;
        try {
          spec = validateSpec(applyPatch(base, input.patch));
        } catch (err) {
          if (err instanceof WorkerConfigInvalidError) {
            throw new WorkerConfigInvalidError(err.issues.map((i) => ({ ...i, path: `${id}:${i.path}` })));
          }
          throw err;
        }
        let committed: { generation: number; changed: boolean };
        try {
          committed = await this.#commit(tx, id, spec, 'bulk', actor, note, null);
        } catch (err) {
          if (err instanceof WorkerConfigInvalidError) {
            throw new WorkerConfigInvalidError(err.issues.map((i) => ({ ...i, path: `${id}:${i.path}` })));
          }
          throw err;
        }
        out.push({ workerId: id, generation: committed.generation, changed: committed.changed });
      }
      return out;
    });
    for (const r of results) if (r.changed) await this.deliver(r.workerId);
    return results;
  }

  /**
   * Project-side assignment: `workerIds` is the complete set of workers that should run `project`. Workers that
   * gain or lose the project get a new generation (cause `project`); the others are untouched.
   */
  async setProjectWorkers(
    project: string,
    input: { workerIds: readonly string[] },
    actor: ActorContext,
  ): Promise<ProjectWorkerView[]> {
    const wanted = new Set(input.workerIds);
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const repo = await this.#project(tx, project);
      const { rows } = await tx.query<{ id: string; spec: unknown }>(
        `SELECT w.id, v.spec FROM workers w
           LEFT JOIN worker_configs c ON c.worker_id = w.id
           LEFT JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
          WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL`,
      );
      const known = new Set(rows.map((r) => r.id));
      const unknown = [...wanted].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new WorkerConfigInvalidError(
          unknown.map((id) => ({ path: `workerIds.${id}`, code: 'unknown_worker' })),
        );
      }
      const toChange = rows
        .filter((r) => {
          const assigned = r.spec !== null && WorkerConfigSpec.parse(r.spec).projects.includes(project);
          return assigned !== wanted.has(r.id);
        })
        .map((r) => r.id)
        .sort();
      if (toChange.some((id) => wanted.has(id)) && repo.kind === 'repository' && repo.url === null) {
        throw conflict(
          'repo_not_registered',
          `Project ${project} has no registered repository; configure it first (PUT /projects/${project}/git).`,
        );
      }
      await this.#lock(tx, toChange);
      for (const id of toChange) {
        const base = await this.#baseSpec(tx, id);
        const spec = validateSpec(
          applyPatch(base, wanted.has(id) ? { addProjects: [project] } : { removeProjects: [project] }),
        );
        await this.#commit(tx, id, spec, 'project', actor, `project ${project}`, null);
      }
      return toChange;
    });
    for (const id of changed) await this.deliver(id);
    return this.projectWorkers(project);
  }

  /**
   * A project's registered repository changed (gitflow `PUT /projects/:id/git`): every worker whose desired
   * spec includes the project gets a new generation with the re-resolved document (cause `repository`).
   * Never fails the git configuration change; a failure is logged and repaired by the next edit.
   */
  async onProjectRepositoryChanged(project: string, actor: ActorContext | null): Promise<void> {
    try {
      const changed = await withTransaction(this.deps.pool, async (tx) => {
        const { rows } = await tx.query<{ worker_id: string; spec: unknown }>(
          `SELECT c.worker_id, v.spec FROM worker_configs c
             JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
            WHERE v.spec->'projects' ? $1 ORDER BY c.worker_id`,
          [project],
        );
        await this.#lock(
          tx,
          rows.map((r) => r.worker_id),
        );
        const out: string[] = [];
        for (const r of rows) {
          const spec = WorkerConfigSpec.parse(r.spec);
          const c = await this.#commit(
            tx,
            r.worker_id,
            spec,
            'repository',
            actor,
            `repository of ${project}`,
            null,
          );
          if (c.changed) out.push(r.worker_id);
        }
        return out;
      });
      for (const id of changed) await this.deliver(id);
    } catch (err) {
      this.deps.log.error(
        { err, project },
        'worker configurations not re-resolved after a repository change',
      );
    }
  }

  /**
   * p5-research-workspace: a workspace's egress settings changed: every worker whose desired spec includes the
   * project gets a new generation with the re-resolved document (cause `workspace`). Never throws.
   */
  async onWorkspaceChanged(project: string, actor: ActorContext | null): Promise<void> {
    try {
      const changed = await withTransaction(this.deps.pool, async (tx) => {
        const { rows } = await tx.query<{ worker_id: string; spec: unknown }>(
          `SELECT c.worker_id, v.spec FROM worker_configs c
             JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
            WHERE v.spec->'projects' ? $1 ORDER BY c.worker_id`,
          [project],
        );
        await this.#lock(
          tx,
          rows.map((r) => r.worker_id),
        );
        const out: string[] = [];
        for (const r of rows) {
          const spec = WorkerConfigSpec.parse(r.spec);
          const c = await this.#commit(
            tx,
            r.worker_id,
            spec,
            'workspace',
            actor,
            `workspace ${project}`,
            null,
          );
          if (c.changed) out.push(r.worker_id);
        }
        return out;
      });
      for (const id of changed) await this.deliver(id);
    } catch (err) {
      this.deps.log.error({ err, project }, 'worker configurations not re-resolved after a workspace change');
    }
  }

  /**
   * ADR-0023: every worker whose desired generation still names a removed runtime (OpenHands, in the stored spec or
   * document) gets a new generation without it (cause `runtime_removed`, system actor) and is re-delivered — new
   * workers would otherwise refuse the old document (its hash covers the removed settings). Idempotent; returns the
   * workers that changed. Throws on database errors (the caller logs).
   */
  async retireRuntimes(): Promise<string[]> {
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ worker_id: string; spec: unknown }>(
        `SELECT c.worker_id, v.spec FROM worker_configs c
           JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
          WHERE v.spec->'allowedRuntimes' ? 'openhands' OR v.spec->'runtimes' ? 'openhands'
             OR v.document->'allowedRuntimes' ? 'openhands' OR v.document->'runtimes' ? 'openhands'
          ORDER BY c.worker_id`,
      );
      await this.#lock(
        tx,
        rows.map((r) => r.worker_id),
      );
      const out: string[] = [];
      for (const r of rows) {
        // The tolerant schema drops the removed runtime; force: the spec may otherwise compare equal.
        const spec = WorkerConfigSpec.parse(r.spec);
        const c = await this.#commit(
          tx,
          r.worker_id,
          spec,
          'runtime_removed',
          null,
          'ADR-0023: OpenHands removed',
          null,
          true,
        );
        if (c.changed) out.push(r.worker_id);
      }
      return out;
    });
    for (const id of changed) {
      try {
        await this.deliver(id);
      } catch (err) {
        this.deps.log.error(
          { err, workerId: id },
          'worker configuration delivery failed after runtime retirement',
        );
      }
    }
    return changed;
  }

  /**
   * A catalog profile changed (p5-credentials-models): every worker whose desired spec names it as a runtime's
   * model profile gets a new generation with the re-resolved document (cause `catalog`). Never throws.
   */
  async onCatalogChanged(profileId: string, actor: ActorContext | null): Promise<void> {
    try {
      const changed = await withTransaction(this.deps.pool, async (tx) => {
        const { rows } = await tx.query<{ worker_id: string; spec: unknown }>(
          `SELECT c.worker_id, v.spec FROM worker_configs c
             JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
            ORDER BY c.worker_id`,
        );
        const affected = rows.filter((r) => {
          const spec = WorkerConfigSpec.safeParse(r.spec);
          return (
            spec.success && RuntimeKind.options.some((k) => spec.data.runtimes[k]?.modelProfile === profileId)
          );
        });
        await this.#lock(
          tx,
          affected.map((r) => r.worker_id),
        );
        const out: string[] = [];
        for (const r of affected) {
          const spec = WorkerConfigSpec.parse(r.spec);
          const c = await this.#commit(
            tx,
            r.worker_id,
            spec,
            'catalog',
            actor,
            `model profile ${profileId}`,
            null,
          );
          if (c.changed) out.push(r.worker_id);
        }
        return out;
      });
      for (const id of changed) await this.deliver(id);
    } catch (err) {
      this.deps.log.error({ err, profileId }, 'worker configurations not re-resolved after a catalog change');
    }
  }

  // ---------------------------------------------------------------------------------------- delivery

  /**
   * Sends the desired generation to a connected worker that advertises `worker-config-v1`. Returns the
   * generation sent, or null (no configuration, not connected, feature not advertised). Never throws.
   */
  async deliver(workerId: string, session?: WorkerSession): Promise<number | null> {
    try {
      const s = session ?? this.deps.session(workerId);
      if (s === undefined) return null;
      const w = await this.deps.pool.query<{ features: unknown }>(
        'SELECT features FROM workers WHERE id = $1',
        [workerId],
      );
      if (!features(w.rows[0]?.features).includes(WORKER_CONFIG_FEATURE)) return null;
      const cfg = await this.#config(this.deps.pool, workerId);
      if (cfg === null) return null;
      const v = await this.#version(this.deps.pool, workerId, cfg.generation);
      if (v === null) return null;
      const document = WorkerConfigDocument.parse(v.document);
      const issuedAt = this.deps.clock().toISOString();
      const payload: WorkerConfigDelivery = {
        generation: v.generation,
        documentHash: v.document_hash,
        issuedAt,
        document,
        signature: this.deps.signer.signWorkerConfig({
          workerId,
          generation: v.generation,
          documentHash: v.document_hash,
          issuedAt,
        }),
      };
      await s.send('APPLY_WORKER_CONFIG', payload);
      await this.deps.pool.query(
        'UPDATE worker_configs SET delivered_generation = $2, delivered_at = $3 WHERE worker_id = $1',
        [workerId, v.generation, this.deps.clock()],
      );
      this.deps.log.info({ workerId, generation: v.generation }, 'worker configuration sent');
      return v.generation;
    } catch (err) {
      this.deps.log.error({ err, workerId }, 'worker configuration delivery failed');
      return null;
    }
  }

  /**
   * FleetSessionHandler hook for CAPABILITIES (after the features column was written) and WORKER_CONFIG_STATUS:
   * store the report, notify admins of a new rejection, and (re-)send the desired generation when the worker
   * reports another one that it did not refuse.
   */
  async onReport(session: WorkerSession, report: WorkerConfigReport | undefined): Promise<void> {
    const now = this.deps.clock();
    if (report !== undefined) {
      const previous = await this.deps.pool.query<{ config_report: unknown }>(
        'SELECT config_report FROM workers WHERE id = $1',
        [session.workerId],
      );
      const before = parseReport(previous.rows[0]?.config_report ?? null);
      await this.deps.pool.query(
        'UPDATE workers SET config_report = $2, config_reported_at = $3 WHERE id = $1',
        [session.workerId, JSON.stringify(report), now],
      );
      const rejected = report.rejected;
      if (rejected !== undefined && before?.rejected?.generation !== rejected.generation) {
        await this.#rejection(session.workerId, rejected.generation, rejected.reason);
      }
    }
    const cfg = await this.#config(this.deps.pool, session.workerId);
    if (cfg === null) return;
    // ADR-0021: a worker that now understands panel skills keys (or a changed key) gets a new generation first.
    if (await this.#panelKeysStale(session.workerId)) await this.syncPanelSkillKeys([session.workerId]);
    const v = await this.#version(
      this.deps.pool,
      session.workerId,
      (await this.#config(this.deps.pool, session.workerId))?.generation ?? cfg.generation,
    );
    if (v === null) return;
    const inSync =
      report?.source === 'panel' &&
      report.generation === v.generation &&
      report.documentHash === v.document_hash;
    const refused = report?.rejected?.generation === v.generation;
    if (!inSync && !refused) await this.deliver(session.workerId, session);
  }

  // --------------------------------------------------------------------------------------- internals

  /**
   * Resolves project ids to their registered repositories and catalog model profiles to concrete runtime
   * settings, and validates the delivered document for this worker's features.
   */
  async #document(db: Queryable, workerId: string, spec: WorkerConfigSpec): Promise<WorkerConfigDocument> {
    const issues: ConfigIssue[] = [];
    const f = await db.query<{ features: unknown }>('SELECT features FROM workers WHERE id = $1', [workerId]);
    const vault = features(f.rows[0]?.features).includes(VAULT_CONFIG_FEATURE);
    const workspaceFeature = features(f.rows[0]?.features).includes(WORKSPACE_FEATURE);
    const sandboxOps = features(f.rows[0]?.features).includes(SANDBOX_OPS_FEATURE);
    const machineAdminFeature = features(f.rows[0]?.features).includes(MACHINE_ADMIN_FEATURE);
    const panelSkills = features(f.rows[0]?.features).includes(PANEL_SKILLS_FEATURE);
    // p6-warm-caches (ADR-0029): an older worker would strip the key and fail the document hash.
    if (
      spec.workspace.packageCacheMaxBytes !== undefined &&
      !features(f.rows[0]?.features).includes(PACKAGE_CACHES_FEATURE)
    ) {
      issues.push({ path: 'workspace.packageCacheMaxBytes', code: 'worker_update_required' });
    }
    // p17-disk-selfclean: same for the disk hygiene settings (an older worker would strip the key and fail the hash).
    if (
      spec.workspace.diskHygiene !== undefined &&
      !features(f.rows[0]?.features).includes(DISK_HYGIENE_FEATURE)
    ) {
      issues.push({ path: 'workspace.diskHygiene', code: 'worker_update_required' });
    }
    const { rows } = await db.query<{
      id: string;
      repository_url: string | null;
      kind: 'repository' | 'workspace';
      egress: WorkspaceEgress | null;
      allow_hosts: string[] | null;
    }>(
      `SELECT p.id, g.repository_url, p.kind, w.egress, w.allow_hosts FROM projects p
         LEFT JOIN project_git_configs g ON g.project = p.id
         LEFT JOIN project_workspaces w ON w.project = p.id
        WHERE p.id = ANY($1)`,
      [spec.projects],
    );
    const byId = new Map(rows.map((r) => [r.id, r.repository_url]));
    const kinds = new Map(rows.map((r) => [r.id, r]));
    const projects: WorkerConfigDocument['projects'] = {};
    const workspaces: NonNullable<WorkerConfigDocument['workspaces']> = {};
    spec.projects.forEach((p, i) => {
      if (!byId.has(p)) {
        issues.push({ path: `projects.${String(i)}`, code: 'unknown_project' });
        return;
      }
      const ws = kinds.get(p);
      if (ws?.kind === 'workspace') {
        // p5-research-workspace: no repository; only workers that understand `workspaces` get it (a worker that
        // predates it would strip the key and fail the hash). Others: placement says workspace_unsupported.
        if (workspaceFeature) {
          workspaces[p] = {
            egress: ws.egress ?? 'none',
            ...((ws.allow_hosts ?? []).length > 0 ? { allowHosts: ws.allow_hosts ?? [] } : {}),
          };
        }
        return;
      }
      const url = byId.get(p) ?? null;
      if (url === null) {
        issues.push({ path: `projects.${String(i)}`, code: 'repo_not_registered' });
        return;
      }
      if (!ConfigRepositoryUrl.safeParse(url).success) {
        issues.push({ path: `projects.${String(i)}`, code: 'repository_url_unsupported' });
        return;
      }
      projects[p] = { repositories: [url] };
    });
    // p17-worker-managed: an older worker would strip `settings` and fail the hash; runtime paths need machine admin.
    if (spec.settings !== undefined && !features(f.rows[0]?.features).includes(WORKER_MANAGED_FEATURE)) {
      issues.push({ path: 'settings', code: 'worker_update_required' });
    }
    // p22-sandbox-settings: `settings.sandbox` only to workers that apply it (an older one would strip it, fail the hash).
    if (
      spec.settings?.sandbox !== undefined &&
      !features(f.rows[0]?.features).includes(WORKER_SANDBOX_SETTINGS_FEATURE)
    ) {
      issues.push({ path: 'settings.sandbox', code: 'worker_update_required' });
    }
    if (
      spec.settings?.runtimePaths !== undefined &&
      Object.keys(spec.settings.runtimePaths).length > 0 &&
      spec.machineAdmin?.enabled !== true
    ) {
      issues.push({ path: 'settings.runtimePaths', code: 'machine_admin_required' });
    }
    const { projects: _ids, allowUnconfined, unconfinedParallel, machineAdmin, ...rest } = spec;
    // ADR-0021: only machine-admin-v1 workers understand the key, and only an enabled setting is ever sent.
    if (machineAdmin?.enabled === true && !machineAdminFeature) {
      issues.push({ path: 'machineAdmin', code: 'worker_update_required' });
    }
    const panelKeys = panelSkills ? [...(this.deps.panelSkillKeys ?? [])] : [];
    // ADR-0019: only sandbox-ops-v1 workers understand the key (older ones would strip it and fail the hash), and
    // only `true` is ever sent.
    if (allowUnconfined === true && !sandboxOps) {
      issues.push({ path: 'allowUnconfined', code: 'worker_update_required' });
    }
    // p19-unconfined-parallel: the same for the parallel setting (only `unconfined-parallel-v1` workers know it).
    const parallelFeature = features(f.rows[0]?.features).includes(UNCONFINED_PARALLEL_FEATURE);
    const sendParallel = unconfinedParallel === true && allowUnconfined === true && sandboxOps;
    if (sendParallel && !parallelFeature) {
      issues.push({ path: 'unconfinedParallel', code: 'worker_update_required' });
    }
    const resolved = await this.#resolveModels(db, spec.runtimes, vault);
    // p13-runtime-accounts: the machine's added accounts (enabled runtimes only), for workers that apply them.
    const accountsFeature = features(f.rows[0]?.features).includes(RUNTIME_ACCOUNTS_FEATURE);
    const runtimes: WorkerConfigSpec['runtimes'] = { ...resolved };
    const accountsPort = accountsFeature ? (this.deps.accounts?.() ?? null) : null;
    if (accountsPort !== null) {
      const added = await accountsPort.documentAccounts(db, workerId);
      for (const rt of ['claude-code', 'codex'] as const) {
        const list = added[rt];
        if (list === undefined || list.length === 0 || !spec.allowedRuntimes.includes(rt)) continue;
        runtimes[rt] = {
          ...runtimes[rt],
          accounts: list.map((a) =>
            a.kind === 'api_key' && a.credentialId !== null
              ? {
                  id: a.id,
                  kind: 'api_key' as const,
                  credentialRef: { source: 'vault' as const, id: a.credentialId },
                }
              : { id: a.id, kind: 'subscription' as const },
          ),
        };
      }
    }
    const document = WorkerConfigDocument.parse({
      schemaVersion: WORKER_CONFIG_SCHEMA_VERSION,
      ...rest,
      runtimes,
      projects,
      ...(Object.keys(workspaces).length > 0 ? { workspaces } : {}),
      ...(allowUnconfined === true && sandboxOps ? { allowUnconfined: true } : {}),
      ...(sendParallel && parallelFeature ? { unconfinedParallel: true } : {}),
      ...(machineAdmin?.enabled === true && machineAdminFeature ? { machineAdmin } : {}),
      ...(panelKeys.length > 0 ? { panelSkillKeys: panelKeys } : {}),
    });
    for (const k of ['claude-code', 'codex'] as const) {
      if (!vault && document.runtimes[k]?.model !== undefined) {
        issues.push({ path: `runtimes.${k}.model`, code: 'worker_update_required' });
      }
    }
    issues.push(...workerConfigIssues(document, { vault, accounts: accountsFeature }));
    if (issues.length > 0) throw new WorkerConfigInvalidError(issues);
    return document;
  }

  /**
   * Writes generation + 1 unless the spec and the resolved document are unchanged (`force` writes anyway, e.g.
   * an explicit rollback). Audits it and queues the admin notification in the same transaction.
   */
  async #commit(
    tx: Queryable,
    workerId: string,
    requested: WorkerConfigSpec,
    cause: ConfigCause,
    actor: ActorContext | null,
    note: string | null,
    rollbackOf: number | null,
    force = false,
  ): Promise<{ generation: number; changed: boolean }> {
    if (cause === 'edit' || cause === 'adopt' || cause === 'rollback')
      await this.#checkRefs(tx, workerId, requested);
    const current = await this.#config(tx, workerId);
    const before = current === null ? null : await this.#version(tx, workerId, current.generation);
    const beforeSpec = before === null ? null : WorkerConfigSpec.parse(before.spec);
    // ADR-0019: allowUnconfined changes only through its own route (always-fresh step-up, notification). Every other
    // cause — edits, bulk, rollback to an old generation, adopt — carries the current value over.
    let spec = requested;
    if (cause !== 'unconfined') {
      // p19-unconfined-parallel: the parallel setting travels with it (same route).
      const { allowUnconfined: _drop, unconfinedParallel: _dropParallel, ...without } = requested;
      spec =
        beforeSpec?.allowUnconfined === true
          ? {
              ...without,
              allowUnconfined: true,
              ...(beforeSpec.unconfinedParallel === true ? { unconfinedParallel: true } : {}),
            }
          : without;
    }
    // ADR-0021: the same for machine administration (owner-only route, cause machine_admin).
    if (cause !== 'machine_admin') {
      const { machineAdmin: _dropAdmin, ...without } = spec;
      spec =
        beforeSpec?.machineAdmin?.enabled === true
          ? { ...without, machineAdmin: beforeSpec.machineAdmin }
          : without;
    }
    // p17-worker-managed: the same for runtime paths (owner-only route, cause runtime_paths).
    if (cause !== 'runtime_paths') {
      // Without machine administration they are dropped (switching it off must not be refused because of them).
      const keep = spec.machineAdmin?.enabled === true ? beforeSpec?.settings?.runtimePaths : undefined;
      const { runtimePaths: _dropPaths, ...otherSettings } = spec.settings ?? {};
      const settings: WorkerSettings =
        keep !== undefined && Object.keys(keep).length > 0
          ? { ...otherSettings, runtimePaths: keep }
          : otherSettings;
      const { settings: _dropSettings, ...withoutSettings } = spec;
      spec = Object.keys(settings).length > 0 ? { ...withoutSettings, settings } : withoutSettings;
    }
    const document = await this.#document(tx, workerId, spec);
    const hash = workerConfigHash(document);
    if (
      !force &&
      before !== null &&
      beforeSpec !== null &&
      before.document_hash === hash &&
      sameSpec(beforeSpec, spec)
    ) {
      return { generation: before.generation, changed: false };
    }
    const generation = (current?.generation ?? 0) + 1;
    const now = this.deps.clock();
    await tx.query(
      `INSERT INTO worker_config_versions (worker_id, generation, spec, document, document_hash, cause, rollback_of,
                                           change_note, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        workerId,
        generation,
        JSON.stringify(spec),
        JSON.stringify(document),
        hash,
        cause,
        rollbackOf,
        note,
        now,
        actor?.userId ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO worker_configs (worker_id, generation, updated_at, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (worker_id) DO UPDATE SET generation = EXCLUDED.generation, updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [workerId, generation, now, actor?.userId ?? null],
    );
    await this.deps.audit.record(
      {
        actor: actor === null ? { type: 'system', id: 'worker-config' } : { type: 'user', id: actor.userId },
        action: 'worker.config.update',
        target: workerId,
        outcome: 'success',
        ip: actor?.ip ?? null,
        userAgent: actor?.userAgent ?? null,
        metadata: {
          generation,
          cause,
          documentHash: hash,
          ...(rollbackOf === null ? {} : { rollbackOf }),
          before: summary(beforeSpec),
          after: summary(spec),
          ...(note === null ? {} : { changeNote: note }),
        },
      },
      tx,
    );
    await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
      OUTBOX_TOPIC_WORKER_CONFIG,
      JSON.stringify({ workerId, generation, event: 'changed' } satisfies WorkerConfigOutboxPayload),
      now,
    ]);
    // p8-capacity-auto: a manual maxParallelJobs (edit, bulk, Apply, rollback) wins over automatic capacity.
    if (cause !== 'capacity' && beforeSpec !== null && beforeSpec.maxParallelJobs !== spec.maxParallelJobs) {
      await capacityManualOverride(
        tx,
        { audit: this.deps.audit, clock: this.deps.clock },
        workerId,
        spec.maxParallelJobs,
        actor,
      );
    }
    return { generation, changed: true };
  }

  /**
   * Fills each runtime's settings from its catalog model profile (explicit values win). An unknown id is left as
   * is (a runtime-policy profile name); a disabled profile or one not for this runtime resolves to nothing (the
   * placement reports `model_profile_unavailable`). Vault refs and Claude Code / Codex models are only filled
   * for workers that can apply them.
   */
  async #resolveModels(
    db: Queryable,
    runtimes: WorkerConfigSpec['runtimes'],
    vault: boolean,
  ): Promise<WorkerConfigSpec['runtimes']> {
    const catalog = await loadCatalog(db);
    const out: Record<string, unknown> = { ...runtimes };
    for (const k of RuntimeKind.options) {
      const s = runtimes[k];
      const id = s?.modelProfile;
      if (s === undefined || id === undefined) continue;
      const c = catalog.get(id);
      if (c === undefined || !c.entry.enabled || !c.entry.runtimes.includes(k)) continue;
      const r = catalogSettings(k, c.entry);
      const next: Record<string, unknown> = { ...s };
      if (
        r.credentialRef !== undefined &&
        s.auth === undefined &&
        (vault || r.credentialRef.source !== 'vault')
      ) {
        next.auth = { mode: 'secret-ref', credentialRef: r.credentialRef };
      }
      if (k === 'pi') {
        const pi = s as { provider?: string; model?: string };
        if (pi.provider === undefined && r.provider !== undefined) next.provider = r.provider;
        if (pi.model === undefined && r.model !== undefined) next.model = r.model;
      }
      if (k === 'opencode' && (s as { model?: string }).model === undefined && r.model !== undefined) {
        next.model = r.model;
      }
      if ((k === 'claude-code' || k === 'codex') && vault && (s as { model?: string }).model === undefined) {
        if (r.model !== undefined) next.model = r.model;
      }
      out[k] = next;
    }
    return out;
  }

  /**
   * References an administrator chose must be usable on this worker: vault credentials exist, are active and are
   * shared with it (sealed to its key), and the worker can hold vault credentials; catalog profiles are enabled
   * and valid for the runtime.
   */
  async #checkRefs(db: Queryable, workerId: string, spec: WorkerConfigSpec): Promise<void> {
    const issues: ConfigIssue[] = [];
    const f = await db.query<{ features: unknown }>('SELECT features FROM workers WHERE id = $1', [workerId]);
    const vault = features(f.rows[0]?.features).includes(VAULT_CONFIG_FEATURE);
    const catalog = await loadCatalog(db);
    for (const k of RuntimeKind.options) {
      const s = spec.runtimes[k];
      if (s === undefined) continue;
      const auth = s.auth;
      if (auth?.mode === 'secret-ref' && auth.credentialRef.source === 'vault') {
        const path = `runtimes.${k}.auth.credentialRef`;
        if (!vault) issues.push({ path, code: 'worker_update_required' });
        else {
          const { rows } = await db.query<{ state: string; shared: boolean; kind: string }>(
            `SELECT c.state, c.kind, EXISTS (SELECT 1 FROM vault_credential_workers w WHERE w.credential_id = c.id
                       AND w.worker_id = $2 AND w.state = 'active') AS shared
               FROM vault_credentials c WHERE c.id = $1`,
            [auth.credentialRef.id, workerId],
          );
          const row = rows[0];
          if (row === undefined) issues.push({ path, code: 'unknown_credential' });
          // p14-workflow-engine 14.3: an HTTP / SMTP credential is only for workflow function jobs (bound hosts).
          else if (row.kind === 'http-auth' || row.kind === 'smtp' || row.kind.startsWith('git-'))
            issues.push({ path, code: 'credential_kind' });
          else if (row.state !== 'active') issues.push({ path, code: 'credential_revoked' });
          else if (!row.shared) issues.push({ path, code: 'credential_not_shared' });
        }
      }
      const id = s.modelProfile;
      const c = id === undefined ? undefined : catalog.get(id);
      if (c !== undefined) {
        if (!c.entry.enabled)
          issues.push({ path: `runtimes.${k}.modelProfile`, code: 'model_profile_disabled' });
        else if (!c.entry.runtimes.includes(k))
          issues.push({ path: `runtimes.${k}.modelProfile`, code: 'model_profile_runtime_mismatch' });
      }
    }
    if (issues.length > 0) throw new WorkerConfigInvalidError(issues);
  }

  async #rejection(workerId: string, generation: number, reason: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: workerId },
          action: 'worker.config.rejected',
          target: workerId,
          outcome: 'failure',
          metadata: { generation, reason },
        },
        tx,
      );
      await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
        OUTBOX_TOPIC_WORKER_CONFIG,
        JSON.stringify({ workerId, generation, event: 'rejected' } satisfies WorkerConfigOutboxPayload),
        this.deps.clock(),
      ]);
    });
  }

  /** Current desired spec, or the takeover prefill for an unmanaged worker. */
  async #baseSpec(db: Queryable, workerId: string): Promise<WorkerConfigSpec> {
    const cfg = await this.#config(db, workerId);
    if (cfg !== null) {
      const v = await this.#version(db, workerId, cfg.generation);
      if (v !== null) return WorkerConfigSpec.parse(v.spec);
    }
    const w = await this.#worker(db, workerId);
    const options = await this.projectOptions(db);
    return suggestedFrom(
      parseReport(w.config_report),
      new Set(options.filter((o) => o.repositoryUrl !== null || o.kind === 'workspace').map((o) => o.id)),
    );
  }

  #note(raw: string | undefined): string | null {
    const note = raw?.trim().slice(0, 1000) ?? null;
    if (note === null || note === '') return null;
    if (scanForSecrets({ note }).length > 0) {
      throw new WorkerConfigInvalidError([{ path: 'changeNote', code: 'secret_detected' }]);
    }
    return note;
  }

  /** Serialises configuration writes per worker (sorted ids: no lock-order deadlock between bulk writes). */
  async #lock(tx: Queryable, workerIds: readonly string[]): Promise<void> {
    for (const id of [...workerIds].sort()) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('remyral-worker-config:' || $1, 28))", [
        id,
      ]);
    }
  }

  async #worker(db: Queryable, workerId: string): Promise<WorkerRow> {
    if (!WORKER_ID_PATTERN.test(workerId)) throw notFound();
    const { rows } = await db.query<WorkerRow>(
      `SELECT id, display_name, state, features, config_report, config_reported_at, approved_at, revoked_at
         FROM workers WHERE id = $1`,
      [workerId],
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    return row;
  }

  async #enrolled(db: Queryable, workerId: string): Promise<WorkerRow> {
    const w = await this.#worker(db, workerId);
    if (w.approved_at === null || w.revoked_at !== null) {
      throw conflict('worker_not_enrolled', 'Only approved, non-revoked workers can be configured.');
    }
    return w;
  }

  /** The project's registered repository URL (null: none); 404 when the project does not exist. */
  async #project(
    db: Queryable,
    project: string,
  ): Promise<{ kind: 'repository' | 'workspace'; url: string | null }> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(project))
      throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
    const { rows } = await db.query<{ repository_url: string | null; kind: 'repository' | 'workspace' }>(
      `SELECT g.repository_url, p.kind FROM projects p LEFT JOIN project_git_configs g ON g.project = p.id
        WHERE p.id = $1`,
      [project],
    );
    const row = rows[0];
    if (row === undefined)
      throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
    return { kind: row.kind, url: row.repository_url };
  }

  async #config(db: Queryable, workerId: string): Promise<ConfigRow | null> {
    const { rows } = await db.query<ConfigRow>(
      'SELECT generation, delivered_generation, delivered_at FROM worker_configs WHERE worker_id = $1',
      [workerId],
    );
    return rows[0] ?? null;
  }

  async #version(db: Queryable, workerId: string, generation: number): Promise<VersionRow | null> {
    const { rows } = await db.query<VersionRow>(
      `SELECT generation, spec, document, document_hash, cause, rollback_of, change_note, created_at,
              created_by::text AS created_by
         FROM worker_config_versions WHERE worker_id = $1 AND generation = $2`,
      [workerId, generation],
    );
    return rows[0] ?? null;
  }
}

/** Desired values not in effect on the worker, with the reason (for the panel's drift display). */
function drift(
  desired: WorkerConfigVersionView,
  report: WorkerConfigReport | null,
): { path: string; reason: string }[] {
  if (report === null) return [{ path: '', reason: 'no report from the worker yet' }];
  if (report.source !== 'panel' || report.generation !== desired.generation) {
    return [
      {
        path: '',
        reason:
          report.rejected?.generation === desired.generation
            ? `rejected by the worker: ${report.rejected.reason}`
            : `worker runs generation ${String(report.generation)}, desired ${String(desired.generation)}`,
      },
    ];
  }
  const out: { path: string; reason: string }[] = report.blocked.map((b) => ({
    path: b.path,
    reason: b.detail === undefined ? b.code : `${b.code}: ${b.detail}`,
  }));
  const eff = report.effective;
  for (const p of desired.spec.projects) {
    if (!eff.projects.includes(p) && !out.some((d) => d.path === `projects.${p}`)) {
      out.push({ path: `projects.${p}`, reason: 'not in effect on the worker' });
    }
  }
  for (const r of desired.spec.allowedRuntimes) {
    if (!eff.allowedRuntimes.includes(r) && !out.some((d) => d.path.startsWith(`allowedRuntimes`))) {
      out.push({ path: `allowedRuntimes.${r}`, reason: 'not in effect on the worker' });
    }
  }
  if (
    eff.maxParallelJobs !== desired.spec.maxParallelJobs &&
    !out.some((d) => d.path === 'maxParallelJobs')
  ) {
    out.push({
      path: 'maxParallelJobs',
      reason: `worker runs ${String(eff.maxParallelJobs)} in parallel`,
    });
  }
  return out;
}
