import { scanForSecrets } from '@remyral/memory';
import { catalogPolicyIssues } from '../models/service.js';
import {
  type AppliedRuntimePolicy,
  isRetiredRuntime,
  type PolicyIssue,
  RuntimeKind,
  RuntimePolicyDocument,
  type RuntimePolicyDelivery,
  RUNTIME_PINS,
  type RuntimeAuthMode,
  runtimePolicyHash,
  runtimePolicyIssues,
  SandboxProfile,
  ruleHoldsVersion,
  RELEASE_PIN_HISTORY,
  VERSION_CATALOG_FEATURE,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { RUNTIME_REMOVED_MESSAGE } from '../jobs/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import { WORKER_ID_PATTERN } from '../workers/ids.js';
import type { MasterPayload, WorkerSession } from '../workers/types.js';

/** The policy a worker without an explicit assignment belongs to. */
export const DEFAULT_POLICY = 'default';
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Durable master → worker queue (WorkerReplay.enqueue). */
export interface PolicyOutbox {
  enqueue(workerId: string, type: 'UPDATE_POLICY', payload: MasterPayload<'UPDATE_POLICY'>): Promise<number>;
}

export class RuntimePolicyInvalidError extends HttpError {
  constructor(
    readonly issues: readonly PolicyIssue[],
    message = 'The runtime policy is inconsistent; see issues.',
  ) {
    super(400, 'runtime_policy_invalid', message);
    this.name = 'RuntimePolicyInvalidError';
  }
}

export interface PolicyVersionView {
  readonly version: number;
  readonly documentHash: string;
  readonly document: RuntimePolicyDocument;
  readonly changeNote: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface PolicyView {
  readonly name: string;
  readonly description: string | null;
  readonly activeVersion: number | null;
  readonly canaryVersion: number | null;
  readonly previousVersion: number | null;
  readonly active: PolicyVersionView | null;
  readonly canary: PolicyVersionView | null;
  readonly workers: number;
  readonly canaryWorkers: number;
  readonly updatedAt: string;
}

export interface WorkerPolicyView {
  readonly workerId: string;
  /** Explicit assignment (null: the default policy). */
  readonly assignedPolicy: string | null;
  readonly canary: boolean;
  /** What the worker should run now (null: no policy, the worker's compiled-in pins apply). */
  readonly effective: {
    readonly policy: string;
    readonly version: number;
    readonly stage: 'active' | 'canary';
    readonly documentHash: string;
    readonly document: RuntimePolicyDocument;
  } | null;
  readonly delivered: {
    readonly policy: string | null;
    readonly version: number | null;
    readonly stage: string | null;
    readonly hash: string | null;
    readonly at: string | null;
    readonly generation: number;
  };
  readonly applied: {
    readonly policy: string | null;
    readonly version: number | null;
    readonly hash: string | null;
    readonly at: string | null;
  };
  /** In sync: the worker reports exactly the effective version. */
  readonly inSync: boolean;
  /** Per runtime of the effective policy: pinned vs installed (from the last CAPABILITIES). */
  readonly runtimes: {
    readonly runtime: RuntimeKind;
    readonly pinned: string;
    /** p17-update-channel: `hold` = the owner holds exactly `pinned`; `follow` = the release / catalog pin. */
    readonly pinMode: 'follow' | 'hold';
    readonly installed: string | null;
    readonly status: 'match' | 'mismatch' | 'not-installed' | 'unknown';
    readonly allowUnpinned: boolean;
    readonly authModes: string[];
    readonly defaultProfile: string | null;
    readonly profiles: string[];
  }[];
}

interface PolicyRow {
  name: string;
  description: string | null;
  active_version: number | null;
  canary_version: number | null;
  previous_version: number | null;
  updated_at: Date;
}

interface VersionRow {
  version: number;
  document: unknown;
  document_hash: string;
  change_note: string | null;
  created_at: Date;
  created_by: string | null;
}

interface AssignmentRow {
  worker_id: string;
  policy: string | null;
  canary: boolean;
  generation: string;
  delivered_policy: string | null;
  delivered_version: number | null;
  delivered_stage: string | null;
  delivered_hash: string | null;
  delivered_at: Date | null;
  applied_policy: string | null;
  applied_version: number | null;
  applied_hash: string | null;
  applied_at: Date | null;
}

interface Effective {
  policy: string;
  version: number;
  stage: 'active' | 'canary';
  hash: string;
  /** p17-update-channel: the other form's hash (legacy / with pin modes): a worker that applied either is in sync. */
  otherHash?: string;
  document: RuntimePolicyDocument;
}

/** Whether `hash` is either form of the effective version. */
function sameDocument(eff: Effective, hash: string | null | undefined): boolean {
  return hash === eff.hash || (eff.otherHash !== undefined && hash === eff.otherHash);
}

function notFound(what: 'policy' | 'worker' | 'version'): HttpError {
  return what === 'worker'
    ? new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' })
    : new HttpError(
        404,
        'runtime_policy_not_found',
        `Runtime policy ${what} not found.`,
        {},
        {},
        { name: what },
      );
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function parseDocument(raw: unknown): RuntimePolicyDocument {
  // Stored documents were validated on write; parse again so a hand-edited row cannot reach a worker.
  return RuntimePolicyDocument.parse(raw);
}

function versionView(r: VersionRow): PolicyVersionView {
  return {
    version: r.version,
    documentHash: r.document_hash,
    document: parseDocument(r.document),
    changeNote: r.change_note,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  };
}

/** Validates a document from the API: schema, consistency rules and no secret-looking parameter values. */
export function validateDocument(input: unknown): RuntimePolicyDocument {
  // ADR-0023: stored versions drop a removed runtime silently, but a new document naming one is refused.
  const raw = (input ?? {}) as { runtimes?: unknown; projectProfiles?: unknown };
  const removed: PolicyIssue[] = [];
  if (raw.runtimes !== null && typeof raw.runtimes === 'object') {
    for (const k of Object.keys(raw.runtimes)) {
      if (isRetiredRuntime(k)) removed.push({ path: `runtimes.${k}`, code: 'runtime_removed' });
    }
  }
  if (raw.projectProfiles !== null && typeof raw.projectProfiles === 'object') {
    for (const [p, v] of Object.entries(raw.projectProfiles as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue;
      for (const k of Object.keys(v)) {
        if (isRetiredRuntime(k)) removed.push({ path: `projectProfiles.${p}.${k}`, code: 'runtime_removed' });
      }
    }
  }
  if (removed.length > 0) throw new RuntimePolicyInvalidError(removed, RUNTIME_REMOVED_MESSAGE);
  const parsed = RuntimePolicyDocument.safeParse(input);
  if (!parsed.success) {
    throw new RuntimePolicyInvalidError(
      parsed.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), code: i.code })),
    );
  }
  const doc = parsed.data;
  const issues = [...runtimePolicyIssues(doc)];
  // ADR-0006: model profile parameters are configuration, never credentials.
  for (const runtime of RuntimeKind.options) {
    const rule = doc.runtimes[runtime];
    if (rule === undefined) continue;
    rule.modelProfiles.forEach((p, i) => {
      const fields: Record<string, string> = { model: p.model };
      for (const [k, v] of Object.entries(p.params)) if (typeof v === 'string') fields[k] = v;
      if (scanForSecrets(fields).length > 0)
        issues.push({ path: `runtimes.${runtime}.modelProfiles.${String(i)}`, code: 'secret_detected' });
    });
  }
  if (issues.length > 0) throw new RuntimePolicyInvalidError(issues);
  return doc;
}

/**
 * p5-runtime-policy-ui: a valid starter document from the compiled-in pins (the same RUNTIME_PINS the
 * workers compare against): every runtime allowed at its exact pin with `secret-ref` and `local-login`; nothing
 * unpinned or unverified allowed, no model profiles (each runtime uses its own default model).
 */
export function runtimePolicyTemplate(): RuntimePolicyDocument {
  const runtimes: RuntimePolicyDocument['runtimes'] = {};
  for (const runtime of RuntimeKind.options) {
    const authModes: RuntimeAuthMode[] = ['secret-ref', 'local-login'];
    runtimes[runtime] = {
      version: RUNTIME_PINS[runtime].version,
      // p17-update-channel: follow the release / catalog pin unless the owner holds a version.
      pin: 'follow',
      authModes,
      allowUnpinned: false,
      allowUnverified: false,
      modelProfiles: [],
      defaultProfile: null,
    };
  }
  return { runtimes, projectProfiles: {} };
}

/** Policy names a route already uses (`GET /runtime-policies/template`). */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['template']);

/**
 * Runtime policies (docs/design/p3-runtime-policy.md): versioned documents per named policy (worker group),
 * staged canary rollout, promotion and rollback, per-worker assignment, and delivery to workers through the
 * durable UPDATE_POLICY outbox. Every change is one transaction with its audit event; deliveries are queued
 * after the commit.
 */
export class RuntimePolicyService {
  constructor(
    private readonly deps: {
      pool: Pool;
      audit: AuditRecorder;
      clock: () => Date;
      log: FastifyBaseLogger;
      outbox: PolicyOutbox;
    },
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  /** The starter document, checked like a PUT would check it (a broken pin table fails loudly here). */
  async template(): Promise<{ document: RuntimePolicyDocument; documentHash: string }> {
    const document = validateDocument(runtimePolicyTemplate());
    const issues = await catalogPolicyIssues(this.deps.pool, document);
    if (issues.length > 0) throw new RuntimePolicyInvalidError(issues);
    return { document, documentHash: runtimePolicyHash(document) };
  }

  async list(): Promise<PolicyView[]> {
    const { rows } = await this.deps.pool.query<PolicyRow>('SELECT * FROM runtime_policies ORDER BY name');
    return Promise.all(rows.map((r) => this.#view(this.deps.pool, r)));
  }

  async get(name: string): Promise<PolicyView> {
    return this.#view(this.deps.pool, await this.#policy(this.deps.pool, name));
  }

  async versions(name: string): Promise<PolicyVersionView[]> {
    await this.#policy(this.deps.pool, name);
    const { rows } = await this.deps.pool.query<VersionRow>(
      `SELECT version, document, document_hash, change_note, created_at, created_by::text AS created_by
         FROM runtime_policy_versions WHERE policy = $1 ORDER BY version DESC LIMIT 200`,
      [name],
    );
    return rows.map(versionView);
  }

  async forWorker(workerId: string): Promise<WorkerPolicyView> {
    await this.#worker(this.deps.pool, workerId);
    const a = await this.#assignment(this.deps.pool, workerId);
    const eff = await this.#effective(this.deps.pool, workerId);
    const installed = await this.deps.pool.query<{
      runtime: string;
      version: string;
      installed: boolean;
      pinned_version: string | null;
    }>(
      `SELECT runtime, version, installed, pinned_version FROM worker_runtimes WHERE worker_id = $1 AND present`,
      [workerId],
    );
    const byRuntime = new Map(installed.rows.map((r) => [r.runtime, r]));
    const runtimes: WorkerPolicyView['runtimes'][number][] = [];
    if (eff !== null) {
      for (const runtime of RuntimeKind.options) {
        const rule = eff.document.runtimes[runtime];
        if (rule === undefined) continue;
        const row = byRuntime.get(runtime);
        // p17-update-channel (ADR-0065 §8): a following rule compares with the pin the worker reports (its catalog /
        // release pin); its saved version still matches while installed. A hold compares with exactly its version.
        const hold = ruleHoldsVersion(rule);
        const pinned = hold ? rule.version : (row?.pinned_version ?? RUNTIME_PINS[runtime].version);
        const status =
          row === undefined
            ? ('unknown' as const)
            : !row.installed
              ? ('not-installed' as const)
              : row.version === pinned || (!hold && row.version === rule.version)
                ? ('match' as const)
                : ('mismatch' as const);
        runtimes.push({
          runtime,
          pinned,
          pinMode: hold ? 'hold' : 'follow',
          installed: row?.installed === true ? row.version : null,
          status,
          allowUnpinned: rule.allowUnpinned,
          authModes: [...rule.authModes],
          defaultProfile: rule.defaultProfile,
          profiles: rule.modelProfiles.map((p) => p.name),
        });
      }
    }
    return {
      workerId,
      assignedPolicy: a?.policy ?? null,
      canary: a?.canary ?? false,
      effective:
        eff === null
          ? null
          : {
              policy: eff.policy,
              version: eff.version,
              stage: eff.stage,
              documentHash: eff.hash,
              document: eff.document,
            },
      delivered: {
        policy: a?.delivered_policy ?? null,
        version: a?.delivered_version ?? null,
        stage: a?.delivered_stage ?? null,
        hash: a?.delivered_hash ?? null,
        at: iso(a?.delivered_at ?? null),
        generation: Number(a?.generation ?? 0),
      },
      applied: {
        policy: a?.applied_policy ?? null,
        version: a?.applied_version ?? null,
        hash: a?.applied_hash ?? null,
        at: iso(a?.applied_at ?? null),
      },
      inSync:
        eff === null
          ? (a?.applied_hash ?? null) === null
          : a !== undefined &&
            sameDocument(eff, a.applied_hash) &&
            a.applied_policy === eff.policy &&
            a.applied_version === eff.version,
      runtimes,
    };
  }

  // ------------------------------------------------------------------------------------------ writes

  /**
   * Stores a new version of `name` (creating the policy on first use) and activates it for the whole group
   * (`stage: 'all'`) or stages it for the group's canary workers (`stage: 'canary'`). Optimistic:
   * `expectedVersion` is the latest version the editor saw (0 for a new policy).
   */
  async put(
    name: string,
    input: {
      document: unknown;
      stage: 'all' | 'canary';
      expectedVersion: number;
      changeNote?: string | undefined;
      description?: string | undefined;
    },
    actor: ActorContext,
  ): Promise<PolicyView> {
    if (!NAME.test(name)) throw new RuntimePolicyInvalidError([{ path: 'name', code: 'invalid_format' }]);
    if (RESERVED_NAMES.has(name)) throw new RuntimePolicyInvalidError([{ path: 'name', code: 'reserved' }]);
    const document = await this.#stampHolds(validateDocument(input.document), actor);
    // p5-credentials-models: a profile named like a catalog id must agree with the catalog entry.
    const catalogIssues = await catalogPolicyIssues(this.deps.pool, document);
    if (catalogIssues.length > 0) throw new RuntimePolicyInvalidError(catalogIssues);
    const changeNote = input.changeNote?.trim().slice(0, 1000) ?? null;
    if (changeNote !== null && scanForSecrets({ changeNote }).length > 0)
      throw new RuntimePolicyInvalidError([{ path: 'changeNote', code: 'secret_detected' }]);
    const hash = runtimePolicyHash(document);
    const now = this.deps.clock();
    const view = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 15))', [`runtime-policy:${name}`]);
      let row = (
        await tx.query<PolicyRow>('SELECT * FROM runtime_policies WHERE name = $1 FOR UPDATE', [name])
      ).rows[0];
      if (row === undefined) {
        await tx.query(
          `INSERT INTO runtime_policies (name, description, created_at, created_by, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $3, $4)`,
          [name, input.description?.trim().slice(0, 500) ?? null, now, actor.userId],
        );
        row = {
          name,
          description: null,
          active_version: null,
          canary_version: null,
          previous_version: null,
          updated_at: now,
        };
      }
      const latest = await this.#latest(tx, name);
      if (latest !== input.expectedVersion) {
        throw conflict(
          'version_conflict',
          `The policy is at version ${String(latest)}; reload and try again.`,
        );
      }
      const version = latest + 1;
      await tx.query(
        `INSERT INTO runtime_policy_versions (policy, version, document, document_hash, change_note, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [name, version, JSON.stringify(document), hash, changeNote, now, actor.userId],
      );
      const before = { active: row.active_version, canary: row.canary_version };
      if (input.stage === 'all') {
        await tx.query(
          `UPDATE runtime_policies
              SET active_version = $2, canary_version = NULL,
                  previous_version = COALESCE(active_version, previous_version),
                  description = COALESCE($3, description), updated_at = $4, updated_by = $5
            WHERE name = $1`,
          [name, version, input.description?.trim().slice(0, 500) ?? null, now, actor.userId],
        );
      } else {
        await tx.query(
          `UPDATE runtime_policies SET canary_version = $2, description = COALESCE($3, description),
                  updated_at = $4, updated_by = $5 WHERE name = $1`,
          [name, version, input.description?.trim().slice(0, 500) ?? null, now, actor.userId],
        );
      }
      await this.#audit(tx, actor, 'runtime_policy.version', `runtime-policy:${name}`, {
        policy: name,
        version,
        stage: input.stage,
        documentHash: hash,
        before,
        // Pins and allowed runtimes are the security-relevant part; profiles are counted, not copied.
        pins: Object.fromEntries(
          RuntimeKind.options
            .filter((r) => document.runtimes[r] !== undefined)
            .map((r) => [r, document.runtimes[r]?.version ?? null]),
        ),
        ...(changeNote === null ? {} : { changeNote }),
      });
      return this.#view(tx, await this.#policy(tx, name));
    });
    await this.#fanOut(name);
    return view;
  }

  /**
   * Promotes the staged canary version to the whole group. Refused unless a canary worker runs it with every
   * installed pinned runtime matching its pin (the evidence that the upgrade works), or `force` is set.
   */
  async promote(
    name: string,
    input: { version: number; force?: boolean | undefined },
    actor: ActorContext,
  ): Promise<PolicyView> {
    const now = this.deps.clock();
    const view = await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#policy(tx, name, true);
      if (row.canary_version === null || row.canary_version !== input.version) {
        throw conflict('no_canary', `Version ${String(input.version)} is not the staged canary version.`);
      }
      const evidence = await this.#canaryEvidence(tx, name, row.canary_version);
      if (!evidence.verified && input.force !== true) {
        throw conflict(
          'canary_not_verified',
          'No canary worker reports this version applied with every installed runtime matching its pin. ' +
            'Wait for a canary worker (and its contract tests), or promote with force.',
        );
      }
      await tx.query(
        `UPDATE runtime_policies SET previous_version = active_version, active_version = canary_version,
                canary_version = NULL, updated_at = $2, updated_by = $3 WHERE name = $1`,
        [name, now, actor.userId],
      );
      await this.#audit(tx, actor, 'runtime_policy.promote', `runtime-policy:${name}`, {
        policy: name,
        version: input.version,
        previousVersion: row.active_version,
        forced: input.force === true,
        canaryWorkers: evidence.workers,
      });
      return this.#view(tx, await this.#policy(tx, name));
    });
    await this.#fanOut(name);
    return view;
  }

  /**
   * Rollback. With a staged canary: the rollout is abandoned (canary workers return to the active version);
   * the active version changes only when `toVersion` is given. Without a canary: the active version returns to
   * `toVersion`, or by default to the previously active version.
   */
  async rollback(
    name: string,
    input: { toVersion?: number | undefined; reason?: string | undefined },
    actor: ActorContext,
  ): Promise<PolicyView> {
    const reason = input.reason?.trim().slice(0, 1000) ?? null;
    if (reason !== null && scanForSecrets({ reason }).length > 0)
      throw new RuntimePolicyInvalidError([{ path: 'reason', code: 'secret_detected' }]);
    const now = this.deps.clock();
    const view = await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#policy(tx, name, true);
      const abandoned = row.canary_version;
      let target: number | null = input.toVersion ?? null;
      if (target === null && abandoned === null) target = row.previous_version;
      if (target === null && abandoned === null) {
        throw conflict('no_rollback_target', 'There is no previous version to roll back to.');
      }
      if (target !== null) {
        const exists = await tx.query(
          'SELECT 1 FROM runtime_policy_versions WHERE policy = $1 AND version = $2',
          [name, target],
        );
        if (exists.rowCount === 0) throw notFound('version');
        if (target === row.active_version && abandoned === null) {
          throw conflict('already_active', `Version ${String(target)} is already active.`);
        }
      }
      if (target !== null && target !== row.active_version) {
        await tx.query(
          `UPDATE runtime_policies SET previous_version = active_version, active_version = $2, canary_version = NULL,
                  updated_at = $3, updated_by = $4 WHERE name = $1`,
          [name, target, now, actor.userId],
        );
      } else {
        await tx.query(
          'UPDATE runtime_policies SET canary_version = NULL, updated_at = $2, updated_by = $3 WHERE name = $1',
          [name, now, actor.userId],
        );
      }
      await this.#audit(tx, actor, 'runtime_policy.rollback', `runtime-policy:${name}`, {
        policy: name,
        fromVersion: row.active_version,
        toVersion: target ?? row.active_version,
        abandonedCanary: abandoned,
        ...(reason === null ? {} : { reason }),
      });
      return this.#view(tx, await this.#policy(tx, name));
    });
    await this.#fanOut(name);
    return view;
  }

  /** Assigns a worker to a policy (null: back to `default`) and sets its canary flag. */
  async assign(
    workerId: string,
    input: { policy: string | null; canary: boolean },
    actor: ActorContext,
  ): Promise<WorkerPolicyView> {
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#worker(tx, workerId);
      if (input.policy !== null) await this.#policy(tx, input.policy);
      const before = await this.#assignment(tx, workerId);
      const now = this.deps.clock();
      await tx.query(
        `INSERT INTO worker_runtime_policies (worker_id, policy, canary, assigned_at, assigned_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (worker_id) DO UPDATE SET policy = EXCLUDED.policy, canary = EXCLUDED.canary,
           assigned_at = EXCLUDED.assigned_at, assigned_by = EXCLUDED.assigned_by`,
        [workerId, input.policy, input.canary, now, actor.userId],
      );
      await this.#audit(tx, actor, 'worker.runtime_policy.assign', workerId, {
        before: { policy: before?.policy ?? null, canary: before?.canary ?? false },
        after: { policy: input.policy, canary: input.canary },
      });
    });
    await this.deliver(workerId);
    return this.forWorker(workerId);
  }

  // ---------------------------------------------------------------------------------------- delivery

  /** FleetSessionHandler hook: (re)deliver on every session whose last queued policy is stale. */
  async onSessionStart(session: WorkerSession): Promise<void> {
    await this.deliver(session.workerId);
  }

  /**
   * FleetSessionHandler hook: record what the worker applied; when it differs from what it should run and no
   * UPDATE_POLICY is waiting in its outbox (state lost on the worker), queue the policy again.
   */
  async onCapabilities(session: WorkerSession, applied: AppliedRuntimePolicy | undefined): Promise<void> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `INSERT INTO worker_runtime_policies (worker_id, applied_policy, applied_version, applied_hash, applied_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (worker_id) DO UPDATE SET applied_policy = EXCLUDED.applied_policy,
         applied_version = EXCLUDED.applied_version, applied_hash = EXCLUDED.applied_hash,
         applied_at = EXCLUDED.applied_at`,
      [session.workerId, applied?.name ?? null, applied?.version ?? null, applied?.documentHash ?? null, now],
    );
    const eff = await this.#effective(this.deps.pool, session.workerId);
    const matches =
      eff === null
        ? applied === undefined
        : sameDocument(eff, applied?.documentHash) &&
          applied?.name === eff.policy &&
          applied.version === eff.version;
    if (matches) return;
    const waiting = await this.deps.pool.query(
      `SELECT 1 FROM worker_outbox WHERE worker_id = $1 AND type = 'UPDATE_POLICY' LIMIT 1`,
      [session.workerId],
    );
    if (waiting.rowCount === 0) await this.deliver(session.workerId, { force: true });
  }

  /**
   * Queues UPDATE_POLICY for one worker when its effective policy differs from the last one queued (or
   * always with `force`). Returns the generation queued, or null when nothing was sent.
   */
  async deliver(workerId: string, opts: { force?: boolean } = {}): Promise<number | null> {
    const eff = await this.#effective(this.deps.pool, workerId);
    const a = await this.#assignment(this.deps.pool, workerId);
    const same =
      eff === null
        ? (a?.delivered_hash ?? null) === null
        : a !== undefined &&
          sameDocument(eff, a.delivered_hash) &&
          a.delivered_policy === eff.policy &&
          a.delivered_version === eff.version &&
          a.delivered_stage === eff.stage;
    if (same && opts.force !== true) return null;
    if (eff === null && a === undefined) return null; // never had a policy: nothing to clear
    const generation = Number(a?.generation ?? 0) + 1;
    const delivery: RuntimePolicyDelivery | undefined =
      eff === null
        ? undefined
        : {
            name: eff.policy,
            version: eff.version,
            stage: eff.stage,
            documentHash: eff.hash,
            document: eff.document,
          };
    const payload: MasterPayload<'UPDATE_POLICY'> = {
      policyVersion: generation,
      policy: {
        // This message does not narrow projects, sandbox profiles or parallelism (see design note §4).
        allowedProjects: [],
        projectsUnrestricted: true,
        allowedRuntimes:
          eff === null
            ? [...RuntimeKind.options]
            : RuntimeKind.options.filter((r) => eff.document.runtimes[r] !== undefined),
        allowedSandboxProfiles: [...SandboxProfile.options],
        maxParallelJobs: 64,
        ...(delivery === undefined ? {} : { runtimePolicy: delivery }),
      },
    };
    await this.deps.outbox.enqueue(workerId, 'UPDATE_POLICY', payload);
    await this.deps.pool.query(
      `INSERT INTO worker_runtime_policies (worker_id, generation, delivered_policy, delivered_version, delivered_stage,
                                            delivered_hash, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (worker_id) DO UPDATE SET generation = EXCLUDED.generation,
         delivered_policy = EXCLUDED.delivered_policy, delivered_version = EXCLUDED.delivered_version,
         delivered_stage = EXCLUDED.delivered_stage, delivered_hash = EXCLUDED.delivered_hash,
         delivered_at = EXCLUDED.delivered_at`,
      [
        workerId,
        generation,
        eff?.policy ?? null,
        eff?.version ?? null,
        eff?.stage ?? null,
        eff?.hash ?? null,
        this.deps.clock(),
      ],
    );
    this.deps.log.info(
      {
        workerId,
        policy: eff?.policy ?? null,
        version: eff?.version ?? null,
        stage: eff?.stage ?? null,
        generation,
      },
      'runtime policy queued for worker',
    );
    return generation;
  }

  /**
   * ADR-0023: every policy whose active version still has a rule (or project restriction) for a removed runtime
   * (OpenHands) gets a new active version without it (system actor, audited) and is fanned out — new workers would
   * otherwise refuse the stored document (its hash covers the removed rule). A canary version that names it is
   * withdrawn (the new active version is delivered instead; an administrator can stage again). Idempotent; returns
   * the policies that changed.
   */
  async retireRuntimes(): Promise<string[]> {
    const RETIRED = `(v.document->'runtimes' ? 'openhands'
        OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(v.document->'projectProfiles', '{}'::jsonb)) pp
                    WHERE jsonb_typeof(pp.value) = 'object' AND pp.value ? 'openhands'))`;
    const { rows } = await this.deps.pool.query<{ name: string }>(
      `SELECT DISTINCT p.name FROM runtime_policies p
         JOIN runtime_policy_versions v ON v.policy = p.name AND v.version IN (p.active_version, p.canary_version)
        WHERE ${RETIRED}
        ORDER BY p.name`,
    );
    const changed: string[] = [];
    for (const { name } of rows) {
      const did = await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 15))', [`runtime-policy:${name}`]);
        const row = await this.#policy(tx, name, true);
        const versions = await tx.query<{ version: number; document: unknown; retired: boolean }>(
          `SELECT v.version, v.document, ${RETIRED} AS retired FROM runtime_policy_versions v
            WHERE v.policy = $1 AND v.version IN ($2, $3)`,
          [name, row.active_version ?? 0, row.canary_version ?? 0],
        );
        const active = versions.rows.find((v) => v.version === row.active_version);
        const canary = versions.rows.find((v) => v.version === row.canary_version);
        const now = this.deps.clock();
        const metadata: Record<string, unknown> = { policy: name, runtimes: ['openhands'] };
        if (active?.retired === true) {
          // The tolerant schema drops the removed runtime's rules.
          const document = parseDocument(active.document);
          const hash = runtimePolicyHash(document);
          const version = (await this.#latest(tx, name)) + 1;
          await tx.query(
            `INSERT INTO runtime_policy_versions (policy, version, document, document_hash, change_note, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
            [name, version, JSON.stringify(document), hash, 'ADR-0023: OpenHands removed', now],
          );
          await tx.query(
            `UPDATE runtime_policies SET active_version = $2, previous_version = active_version, updated_at = $3,
                    updated_by = NULL WHERE name = $1`,
            [name, version, now],
          );
          metadata.replacedActive = active.version;
          metadata.version = version;
          metadata.documentHash = hash;
        }
        if (canary?.retired === true) {
          await tx.query(
            'UPDATE runtime_policies SET canary_version = NULL, updated_at = $2, updated_by = NULL WHERE name = $1',
            [name, now],
          );
          metadata.withdrawnCanary = canary.version;
        }
        if (active?.retired !== true && canary?.retired !== true) return false;
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'runtime-retirement' },
            action: 'runtime_policy.retire_runtime',
            target: `runtime-policy:${name}`,
            outcome: 'success',
            metadata,
          },
          tx,
        );
        return true;
      });
      if (did) {
        changed.push(name);
        await this.#fanOut(name);
      }
    }
    return changed;
  }

  /** Queues the current policy for every approved, non-revoked worker of a group. */
  /** p17-update-channel: a held rule records who held it and when (kept when the same hold is saved again). */
  async #stampHolds(document: RuntimePolicyDocument, actor: ActorContext): Promise<RuntimePolicyDocument> {
    const held = RuntimeKind.options.filter((r) => {
      const rule = document.runtimes[r];
      return rule !== undefined && ruleHoldsVersion(rule) && rule.hold === undefined;
    });
    if (held.length === 0) return document;
    const { rows } = await this.deps.pool.query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [actor.userId],
    );
    const by = rows[0]?.username ?? 'owner';
    const at = this.deps.clock().toISOString();
    const runtimes = { ...document.runtimes };
    for (const r of held) {
      const rule = runtimes[r];
      if (rule !== undefined) runtimes[r] = { ...rule, hold: { by, at } };
    }
    return { ...document, runtimes };
  }

  /**
   * p17-update-channel (ADR-0065): stored policies whose rules have no pin mode get one, as a new
   * active version written by the system — `follow` when the rule's version was a release pin (RELEASE_PIN_HISTORY)
   * or a catalog version when it was saved, `hold` otherwise (a deliberate choice, kept and shown as held). Runs at
   * start-up; idempotent (a document with every pin set is left alone). Returns the policies it moved.
   */
  async migratePinModes(
    catalogVersions: Partial<Record<RuntimeKind, readonly string[]>> = {},
  ): Promise<string[]> {
    const moved: string[] = [];
    const { rows } = await this.deps.pool.query<{ name: string; active_version: number; document: unknown }>(
      `SELECT p.name, p.active_version, v.document FROM runtime_policies p
         JOIN runtime_policy_versions v ON v.policy = p.name AND v.version = p.active_version`,
    );
    for (const row of rows) {
      const doc = parseDocument(row.document);
      const missing = RuntimeKind.options.filter(
        (r) => doc.runtimes[r] !== undefined && doc.runtimes[r].pin === undefined,
      );
      if (missing.length === 0) continue;
      const at = this.deps.clock().toISOString();
      const runtimes = { ...doc.runtimes };
      const modes: Record<string, string> = {};
      for (const r of missing) {
        const rule = runtimes[r];
        if (rule === undefined) continue;
        const known = new Set([
          ...RELEASE_PIN_HISTORY[r],
          RUNTIME_PINS[r].version,
          ...(catalogVersions[r] ?? []),
        ]);
        const follow = known.has(rule.version);
        modes[r] = follow ? 'follow' : 'hold';
        runtimes[r] = follow
          ? { ...rule, pin: 'follow' }
          : {
              ...rule,
              pin: 'hold',
              hold: {
                by: 'system',
                at,
                note: 'kept at the version stored before pin modes (p17-update-channel)',
              },
            };
      }
      const document = { ...doc, runtimes };
      const hash = runtimePolicyHash(document);
      const done = await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 15))', [
          `runtime-policy:${row.name}`,
        ]);
        const cur = await this.#policy(tx, row.name, true);
        if (cur.active_version !== row.active_version) return false;
        const version = (await this.#latest(tx, row.name)) + 1;
        await tx.query(
          `INSERT INTO runtime_policy_versions (policy, version, document, document_hash, change_note, created_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
          [
            row.name,
            version,
            JSON.stringify(document),
            hash,
            'pin modes: follow the release / catalog pin, holds kept',
            this.deps.clock(),
          ],
        );
        await tx.query(
          `UPDATE runtime_policies SET previous_version = active_version, active_version = $2, updated_at = $3 WHERE name = $1`,
          [row.name, version, this.deps.clock()],
        );
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'update-channel' },
            action: 'runtime_policy.pin_modes',
            outcome: 'success',
            target: `runtime-policy:${row.name}`,
            metadata: { policy: row.name, version, from: row.active_version, modes },
          },
          tx,
        );
        return true;
      });
      if (done) {
        moved.push(row.name);
        await this.#fanOut(row.name);
      }
    }
    return moved;
  }

  async #fanOut(name: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT w.id FROM workers w LEFT JOIN worker_runtime_policies p ON p.worker_id = w.id
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL
          AND (COALESCE(p.policy, $2) = $1 OR p.delivered_policy = $1)
        ORDER BY w.id`,
      [name, DEFAULT_POLICY],
    );
    for (const { id } of rows) {
      try {
        await this.deliver(id);
      } catch (err) {
        // The next session start or CAPABILITIES report repairs it; never fail the admin action.
        this.deps.log.error({ err, workerId: id, policy: name }, 'runtime policy delivery failed');
      }
    }
  }

  // --------------------------------------------------------------------------------------- internals

  async #effective(db: Queryable, workerId: string): Promise<Effective | null> {
    const { rows } = await db.query<{
      policy: string;
      canary: boolean;
      active_version: number | null;
      canary_version: number | null;
    }>(
      `SELECT rp.name AS policy, COALESCE(a.canary, false) AS canary, rp.active_version, rp.canary_version
         FROM (SELECT $1::text AS worker_id) w
         LEFT JOIN worker_runtime_policies a ON a.worker_id = w.worker_id
         JOIN runtime_policies rp ON rp.name = COALESCE(a.policy, $2)`,
      [workerId, DEFAULT_POLICY],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const useCanary = r.canary && r.canary_version !== null;
    const version = useCanary ? r.canary_version : r.active_version;
    if (version === null) return null;
    const v = await db.query<VersionRow>(
      `SELECT version, document, document_hash, change_note, created_at, created_by::text AS created_by
         FROM runtime_policy_versions WHERE policy = $1 AND version = $2`,
      [r.policy, version],
    );
    const row = v.rows[0];
    if (row === undefined) return null;
    const document = parseDocument(row.document);
    // p17-update-channel: a worker without the pin modes strips `pin` / `hold` when it parses the document, so the
    // hash of the stored document never matches and it refuses the delivery ("document hash does not match" —
    // prod, every 1.1.5 worker, 2026-10-26). It gets the legacy form: the rules without those fields, hashed as such;
    // a `follow` rule keeps the version current when it was saved, a `hold` rule its held version.
    if (Object.values(document.runtimes).some((rule) => rule.pin !== undefined || rule.hold !== undefined)) {
      const f = await db.query<{ features: string[] | null }>('SELECT features FROM workers WHERE id = $1', [
        workerId,
      ]);
      if (!(f.rows[0]?.features ?? []).includes(VERSION_CATALOG_FEATURE)) {
        const legacy = legacyRuntimePolicyDocument(document);
        return {
          policy: r.policy,
          version,
          stage: useCanary ? 'canary' : 'active',
          hash: runtimePolicyHash(legacy),
          otherHash: row.document_hash,
          document: legacy,
        };
      }
    }
    const withModes = Object.values(document.runtimes).some(
      (rule) => rule.pin !== undefined || rule.hold !== undefined,
    );
    return {
      policy: r.policy,
      version,
      stage: useCanary ? 'canary' : 'active',
      hash: row.document_hash,
      ...(withModes ? { otherHash: runtimePolicyHash(legacyRuntimePolicyDocument(document)) } : {}),
      document,
    };
  }

  /** A canary worker applied the version and every installed runtime it pins reports a matching version. */
  async #canaryEvidence(
    tx: Queryable,
    name: string,
    version: number,
  ): Promise<{ verified: boolean; workers: string[] }> {
    const doc = (
      await tx.query<{ document: unknown }>(
        'SELECT document FROM runtime_policy_versions WHERE policy = $1 AND version = $2',
        [name, version],
      )
    ).rows[0];
    if (doc === undefined) return { verified: false, workers: [] };
    const document = parseDocument(doc.document);
    const { rows } = await tx.query<{ worker_id: string }>(
      `SELECT a.worker_id FROM worker_runtime_policies a
         JOIN workers w ON w.id = a.worker_id AND w.revoked_at IS NULL
        WHERE a.canary AND COALESCE(a.policy, $3) = $1 AND a.applied_policy = $1 AND a.applied_version = $2`,
      [name, version, DEFAULT_POLICY],
    );
    const verified: string[] = [];
    for (const { worker_id } of rows) {
      const rts = await tx.query<{ runtime: RuntimeKind; version: string; installed: boolean }>(
        'SELECT runtime, version, installed FROM worker_runtimes WHERE worker_id = $1 AND present',
        [worker_id],
      );
      const pinned = rts.rows.filter((r) => r.installed && document.runtimes[r.runtime] !== undefined);
      // p17-update-channel: only a held version must be the installed one; following rules follow the worker's pin.
      const held = (r: { runtime: RuntimeKind; version: string }) => {
        const rule = document.runtimes[r.runtime];
        return !ruleHoldsVersion(rule) || rule?.version === r.version;
      };
      if (pinned.length > 0 && pinned.every(held)) {
        verified.push(worker_id);
      }
    }
    return { verified: verified.length > 0, workers: verified };
  }

  async #view(db: Queryable, row: PolicyRow): Promise<PolicyView> {
    const load = async (v: number | null): Promise<PolicyVersionView | null> => {
      if (v === null) return null;
      const r = await db.query<VersionRow>(
        `SELECT version, document, document_hash, change_note, created_at, created_by::text AS created_by
           FROM runtime_policy_versions WHERE policy = $1 AND version = $2`,
        [row.name, v],
      );
      return r.rows[0] === undefined ? null : versionView(r.rows[0]);
    };
    const counts = await db.query<{ workers: string; canaries: string }>(
      `SELECT count(*)::text AS workers, count(*) FILTER (WHERE COALESCE(a.canary, false))::text AS canaries
         FROM workers w LEFT JOIN worker_runtime_policies a ON a.worker_id = w.id
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND COALESCE(a.policy, $2) = $1`,
      [row.name, DEFAULT_POLICY],
    );
    return {
      name: row.name,
      description: row.description,
      activeVersion: row.active_version,
      canaryVersion: row.canary_version,
      previousVersion: row.previous_version,
      active: await load(row.active_version),
      canary: await load(row.canary_version),
      workers: Number(counts.rows[0]?.workers ?? 0),
      canaryWorkers: Number(counts.rows[0]?.canaries ?? 0),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async #policy(db: Queryable, name: string, forUpdate = false): Promise<PolicyRow> {
    if (!NAME.test(name)) throw notFound('policy');
    const { rows } = await db.query<PolicyRow>(
      `SELECT * FROM runtime_policies WHERE name = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [name],
    );
    const row = rows[0];
    if (row === undefined) throw notFound('policy');
    return row;
  }

  async #latest(db: Queryable, name: string): Promise<number> {
    const { rows } = await db.query<{ v: number | null }>(
      'SELECT max(version) AS v FROM runtime_policy_versions WHERE policy = $1',
      [name],
    );
    return rows[0]?.v ?? 0;
  }

  async #worker(db: Queryable, workerId: string): Promise<void> {
    if (!WORKER_ID_PATTERN.test(workerId)) throw notFound('worker');
    const { rowCount } = await db.query('SELECT 1 FROM workers WHERE id = $1', [workerId]);
    if (rowCount === 0) throw notFound('worker');
  }

  async #assignment(db: Queryable, workerId: string): Promise<AssignmentRow | undefined> {
    const { rows } = await db.query<AssignmentRow>(
      `SELECT worker_id, policy, canary, generation::text AS generation, delivered_policy, delivered_version,
              delivered_stage, delivered_hash, delivered_at, applied_policy, applied_version, applied_hash, applied_at
         FROM worker_runtime_policies WHERE worker_id = $1`,
      [workerId],
    );
    return rows[0];
  }

  async #audit(
    tx: Queryable,
    actor: ActorContext,
    action: string,
    target: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action,
        target,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata,
      },
      tx,
    );
  }
}

/** The document without the p17-update-channel pin fields, for workers that predate them. */
export function legacyRuntimePolicyDocument(document: RuntimePolicyDocument): RuntimePolicyDocument {
  const runtimes: RuntimePolicyDocument['runtimes'] = {};
  for (const runtime of RuntimeKind.options) {
    const rule = document.runtimes[runtime];
    if (rule === undefined) continue;
    const { pin: _pin, hold: _hold, ...rest } = rule;
    runtimes[runtime] = rest;
  }
  return { ...document, runtimes };
}
