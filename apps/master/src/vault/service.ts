import { scanForSecrets } from '@remyral/memory';
import {
  type ApplyCredentialPayload,
  CredentialEnv,
  CredentialKind,
  type CredentialStatusPayload,
  type CredentialVaultReport,
  credentialDeliveryStatement,
  FUNCTION_FEATURE,
  FUNCTION_LIMITS,
  HOST_BOUND_CREDENTIAL_KINDS,
  GIT_CREDENTIAL_KINDS,
  GIT_CENTRAL_FEATURE,
  SealedValueSchema,
  sealedDigest,
  VaultCredentialId,
  vaultKeyFingerprint,
  vaultKeyId,
  verifyVaultKey,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';
import { OUTBOX_TOPIC_VAULT, type VaultOutboxPayload } from './outbox.js';
import { egressEntryProblem, normaliseEgressEntry } from '../workflows/egress.js';
import { MAX_CREDENTIAL_PROJECTS } from './projects.js';

/** The protocol feature a worker must advertise before it is sent any vault message (ADR-0016). */
export const VAULT_FEATURE = 'credential-vault-v1';

export interface CredentialIssue {
  readonly path: string;
  readonly code: string;
}

export class CredentialInvalidError extends HttpError {
  constructor(readonly issues: readonly CredentialIssue[]) {
    super(400, 'credential_invalid', 'The credential request is invalid; see issues.');
    this.name = 'CredentialInvalidError';
  }
}

export interface VaultSigner {
  signCredentialDelivery(input: Parameters<typeof credentialDeliveryStatement>[0]): {
    kid: string;
    signature: string;
  };
}

export interface VaultWorkerView {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly supported: boolean;
  /** p15-chat-vault: the machine runs function jobs (function-v1) — it can hold http-auth / smtp credentials. */
  readonly functionSupported: boolean;
  readonly key: {
    readonly keyId: string;
    readonly publicKey: string;
    readonly fingerprint: string;
    readonly createdAt: string;
    readonly pinnedAt: string;
  } | null;
  readonly previousKeyId: string | null;
}

export type CredentialWorkerStatus =
  'pending' | 'applied' | 'rejected' | 'revoking' | 'revoked' | 'needs_reseal' | 'unsupported';

export interface CredentialWorkerView {
  readonly workerId: string;
  readonly displayName: string;
  readonly version: number;
  readonly keyId: string;
  readonly status: CredentialWorkerStatus;
  readonly ackedVersion: number | null;
  readonly ackedAt: string | null;
  readonly reason: string | null;
  readonly lastUsedAt: string | null;
}

export interface CredentialView {
  readonly id: string;
  readonly name: string;
  readonly kind: CredentialKind;
  readonly env: string;
  readonly description: string | null;
  readonly version: number;
  readonly state: 'active' | 'revoked';
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  /** p14-workflow-engine 14.3: the hosts an `http-auth` / `smtp` credential may be sent to (null: other kinds). */
  readonly allowedHosts: string[] | null;
  /** p22-vault-projects: the projects an `http-auth` / `smtp` credential may be used by (null: every project). */
  readonly projects: string[] | null;
  readonly workers: CredentialWorkerView[];
}

export interface SealedForWorker {
  readonly workerId: string;
  readonly keyId: string;
  readonly sealed: unknown;
}

/** What placement and worker-config validation need to know about one credential on one worker. */
export type CredentialReadiness = 'ready' | 'pending' | 'missing';

interface CredentialRow {
  id: string;
  name: string;
  kind: CredentialKind;
  env: string;
  description: string | null;
  version: number;
  state: 'active' | 'revoked';
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  revoked_at: Date | null;
  allowed_hosts?: string[] | null;
  projects?: string[] | null;
}

interface WorkerRowState {
  credential_id: string;
  worker_id: string;
  display_name: string;
  features: unknown;
  version: number;
  key_id: string;
  sealed: unknown;
  sealed_digest: string | null;
  state: 'active' | 'revoked';
  acked_version: number | null;
  acked_at: Date | null;
  ack_outcome: string | null;
  ack_reason: string | null;
  last_used_at: Date | null;
  current_key_id: string | null;
}

const RESEAL_REASONS = new Set(['unknown_key', 'open_failed']);

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Credential not found.', {}, {}, { reason: 'credential' });
}

/** Panel status of one credential on one worker. */
export function workerStatus(r: {
  readonly state: 'active' | 'revoked';
  readonly version: number;
  readonly key_id: string;
  readonly acked_version: number | null;
  readonly ack_outcome: string | null;
  readonly ack_reason: string | null;
  readonly supported: boolean;
  readonly current_key_id: string | null;
}): CredentialWorkerStatus {
  if (!r.supported) return 'unsupported';
  if (r.state === 'revoked')
    return r.ack_outcome === 'revoked' || r.acked_version === null ? 'revoked' : 'revoking';
  if (r.acked_version === r.version) return 'applied';
  if (r.ack_outcome === 'rejected') {
    return r.ack_reason !== null && RESEAL_REASONS.has(r.ack_reason) ? 'needs_reseal' : 'rejected';
  }
  if (r.current_key_id === null) return 'needs_reseal';
  return 'pending';
}

/**
 * Panel credential vault (p5-credentials-models, ADR-0016, docs/design/p5-credentials-models.md). Holds credential
 * metadata and, per worker, the ciphertext the administrator's browser sealed to that worker's pinned X25519 vault
 * key — never a plaintext value: no route accepts, logs, stores or returns one. Delivers APPLY_CREDENTIAL /
 * REVOKE_CREDENTIAL (control messages, signed by the lease key) to connected workers advertising
 * `credential-vault-v1`, and re-delivers whenever a worker's CAPABILITIES show another state.
 */
export class VaultService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly signer: VaultSigner;
      readonly session: (workerId: string) => WorkerSession | undefined;
    },
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  async workers(): Promise<VaultWorkerView[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      display_name: string;
      state: string;
      features: unknown;
      key_id: string | null;
      public_key: string | null;
      fingerprint: string | null;
      created_at: Date | null;
      pinned_at: Date | null;
      previous_key_id: string | null;
    }>(
      `SELECT w.id, w.display_name, w.state, w.features, k.key_id, k.public_key, k.fingerprint, k.created_at,
              k.pinned_at,
              (SELECT p.key_id FROM worker_vault_keys p WHERE p.worker_id = w.id AND p.retired_at IS NOT NULL
                ORDER BY p.retired_at DESC LIMIT 1) AS previous_key_id
         FROM workers w
         LEFT JOIN worker_vault_keys k ON k.worker_id = w.id AND k.retired_at IS NULL
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL
        ORDER BY w.display_name, w.id`,
    );
    return rows.map((r) => ({
      workerId: r.id,
      displayName: r.display_name,
      state: r.state,
      connected: this.deps.session(r.id) !== undefined,
      supported: features(r.features).includes(VAULT_FEATURE),
      functionSupported: features(r.features).includes(FUNCTION_FEATURE),
      key:
        r.key_id === null || r.public_key === null || r.fingerprint === null || r.created_at === null
          ? null
          : {
              keyId: r.key_id,
              publicKey: r.public_key,
              fingerprint: r.fingerprint,
              createdAt: r.created_at.toISOString(),
              pinnedAt: (r.pinned_at ?? r.created_at).toISOString(),
            },
      previousKeyId: r.previous_key_id,
    }));
  }

  async list(): Promise<CredentialView[]> {
    const { rows } = await this.deps.pool.query<CredentialRow>(
      `SELECT id, name, kind, env, description, version, state, created_at, created_by::text AS created_by,
              updated_at, revoked_at, allowed_hosts, projects FROM vault_credentials ORDER BY state, id`,
    );
    const workerRows = await this.#workerRows(this.deps.pool, null);
    return rows.map((c) =>
      this.#view(
        c,
        workerRows.filter((w) => w.credential_id === c.id),
      ),
    );
  }

  async get(id: string, db: Queryable = this.deps.pool): Promise<CredentialView> {
    const c = await this.#credential(db, id);
    return this.#view(c, await this.#workerRows(db, id));
  }

  /** Credentials as options for a worker's configuration (metadata only). */
  async options(workerId: string): Promise<
    {
      id: string;
      name: string;
      kind: CredentialKind;
      env: string;
      version: number;
      state: 'active' | 'revoked';
      sharedWithWorker: boolean;
    }[]
  > {
    const { rows } = await this.deps.pool.query<{
      id: string;
      name: string;
      kind: CredentialKind;
      env: string;
      version: number;
      state: 'active' | 'revoked';
      shared: boolean;
    }>(
      `SELECT c.id, c.name, c.kind, c.env, c.version, c.state,
              EXISTS (SELECT 1 FROM vault_credential_workers w
                       WHERE w.credential_id = c.id AND w.worker_id = $1 AND w.state = 'active') AS shared
         FROM vault_credentials c ORDER BY c.id`,
      [workerId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      env: r.env,
      version: r.version,
      state: r.state,
      sharedWithWorker: r.shared,
    }));
  }

  /**
   * Readiness of credentials on workers for placement: `ready` (the worker holds the desired version),
   * `pending` (shared, delivery outstanding), `missing` (not shared with the worker, revoked, unknown, refused, or
   * the worker cannot hold vault credentials).
   */
  async readiness(workerIds: readonly string[]): Promise<Map<string, Map<string, CredentialReadiness>>> {
    const out = new Map<string, Map<string, CredentialReadiness>>();
    if (workerIds.length === 0) return out;
    const { rows } = await this.deps.pool.query<{
      credential_id: string;
      worker_id: string;
      version: number;
      row_state: string;
      cred_state: string;
      acked_version: number | null;
      ack_outcome: string | null;
      features: unknown;
    }>(
      `SELECT r.credential_id, r.worker_id, r.version, r.state AS row_state, c.state AS cred_state,
              r.acked_version, r.ack_outcome, w.features
         FROM vault_credential_workers r
         JOIN vault_credentials c ON c.id = r.credential_id
         JOIN workers w ON w.id = r.worker_id
        WHERE r.worker_id = ANY($1)`,
      [workerIds],
    );
    for (const r of rows) {
      let state: CredentialReadiness;
      if (
        r.row_state !== 'active' ||
        r.cred_state !== 'active' ||
        !features(r.features).includes(VAULT_FEATURE)
      )
        state = 'missing';
      else if (r.acked_version === r.version) state = 'ready';
      else if (r.ack_outcome === 'rejected') state = 'missing';
      else state = 'pending';
      const m = out.get(r.worker_id) ?? new Map<string, CredentialReadiness>();
      m.set(r.credential_id, state);
      out.set(r.worker_id, m);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ writes

  async create(
    input: {
      id: string;
      name: string;
      kind: string;
      env: string;
      description?: string | undefined;
      /** p14-workflow-engine 14.3: required for `http-auth` / `smtp`, refused for other kinds. */
      allowedHosts?: readonly string[] | undefined;
      /** p22-vault-projects: `http-auth` / `smtp` only; absent / null: every project. */
      projects?: readonly string[] | null | undefined;
      workers: readonly SealedForWorker[];
    },
    actor: ActorContext,
  ): Promise<CredentialView> {
    const issues: CredentialIssue[] = [];
    if (!VaultCredentialId.safeParse(input.id).success) issues.push({ path: 'id', code: 'invalid' });
    const kind = CredentialKind.safeParse(input.kind);
    if (!kind.success) issues.push({ path: 'kind', code: 'invalid' });
    if (!CredentialEnv.safeParse(input.env).success)
      issues.push({ path: 'env', code: 'invalid_or_forbidden' });
    const name = input.name.trim();
    if (name.length < 1 || name.length > 128) issues.push({ path: 'name', code: 'invalid' });
    const description = input.description?.trim() ?? '';
    if (description.length > 500) issues.push({ path: 'description', code: 'too_long' });
    for (const f of scanForSecrets({ name, description }))
      issues.push({ path: f.field, code: 'secret_detected' });
    // p14-workflow-engine 14.3: an HTTP / SMTP credential is bound to the hosts it may be sent to (§8.2).
    const hostBound = kind.success && HOST_BOUND_CREDENTIAL_KINDS.has(kind.data);
    const allowedHosts = [...new Set((input.allowedHosts ?? []).map(normaliseEgressEntry))].sort();
    if (hostBound) {
      if (allowedHosts.length === 0) issues.push({ path: 'allowedHosts', code: 'required' });
      else if (allowedHosts.length > FUNCTION_LIMITS.maxCredentialHosts)
        issues.push({ path: 'allowedHosts', code: 'too_many' });
      else if (allowedHosts.some((h) => egressEntryProblem(h) !== null))
        issues.push({ path: 'allowedHosts', code: 'invalid' });
    } else if (input.allowedHosts !== undefined && input.allowedHosts.length > 0)
      issues.push({ path: 'allowedHosts', code: 'not_allowed' });
    const projects =
      input.projects === undefined || input.projects === null
        ? null
        : await this.#projectList(input.projects, hostBound, issues);
    if (issues.length > 0 || !kind.success) throw new CredentialInvalidError(issues);
    const now = this.deps.clock();
    const workerIds = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, input.id);
      const exists = await tx.query('SELECT 1 FROM vault_credentials WHERE id = $1', [input.id]);
      if ((exists.rowCount ?? 0) > 0)
        throw conflict('already_exists', `Credential ${input.id} already exists.`);
      const sealed = await this.#checkSealed(tx, input.workers, {
        credentialId: input.id,
        kind: kind.data,
        env: input.env,
      });
      await tx.query(
        `INSERT INTO vault_credentials (id, name, kind, env, description, version, state, created_at, created_by,
                                        updated_at, updated_by, allowed_hosts, projects)
         VALUES ($1, $2, $3, $4, $5, 1, 'active', $6, $7, $6, $7, $8, $9)`,
        [
          input.id,
          name,
          kind.data,
          input.env,
          description === '' ? null : description,
          now,
          actor.userId,
          hostBound ? allowedHosts : null,
          projects,
        ],
      );
      for (const s of sealed) await this.#upsertActive(tx, input.id, s, 1, now);
      await this.#audit(tx, actor, 'vault.credential.create', input.id, {
        kind: kind.data,
        env: input.env,
        version: 1,
        ...(hostBound ? { allowedHosts } : {}),
        ...(projects === null ? {} : { projects }),
        workers: sealed.map((s) => s.workerId),
      });
      await this.#outbox(tx, { event: 'created', credentialId: input.id, version: 1 });
      return sealed.map((s) => s.workerId);
    });
    for (const w of workerIds) await this.deliver(w);
    return this.get(input.id);
  }

  /**
   * Rotation: a new version sealed for `workers`. Workers that had the credential and are not listed lose it
   * (revoked on them). Re-entering the value is also how a credential is shared with more workers.
   */
  async setValue(
    id: string,
    input: { expectedVersion: number; workers: readonly SealedForWorker[] },
    actor: ActorContext,
  ): Promise<CredentialView> {
    const now = this.deps.clock();
    const touched = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, id);
      const c = await this.#credential(tx, id);
      if (c.state !== 'active') throw conflict('credential_revoked', `Credential ${id} is revoked.`);
      if (c.version !== input.expectedVersion) {
        throw conflict(
          'version_conflict',
          `Credential ${id} is at version ${String(c.version)}; reload and try again.`,
        );
      }
      const version = c.version + 1;
      const sealed = await this.#checkSealed(tx, input.workers, {
        credentialId: id,
        kind: c.kind,
        env: c.env,
      });
      await tx.query(
        'UPDATE vault_credentials SET version = $2, updated_at = $3, updated_by = $4 WHERE id = $1',
        [id, version, now, actor.userId],
      );
      for (const s of sealed) await this.#upsertActive(tx, id, s, version, now);
      const listed = sealed.map((s) => s.workerId);
      const dropped = await tx.query<{ worker_id: string }>(
        `UPDATE vault_credential_workers SET state = 'revoked', sealed = NULL, sealed_digest = NULL,
                ack_outcome = NULL, ack_reason = NULL, updated_at = $3
          WHERE credential_id = $1 AND state = 'active' AND NOT (worker_id = ANY($2)) RETURNING worker_id`,
        [id, listed, now],
      );
      await this.#audit(tx, actor, 'vault.credential.rotate', id, {
        version,
        workers: listed,
        removedWorkers: dropped.rows.map((r) => r.worker_id),
      });
      await this.#outbox(tx, { event: 'rotated', credentialId: id, version });
      return [...listed, ...dropped.rows.map((r) => r.worker_id)];
    });
    for (const w of touched) await this.deliver(w);
    return this.get(id);
  }

  /**
   * p22-vault-projects: which projects may use an `http-auth` / `smtp` credential (`null`: every project). Unknown
   * project ids are refused. Takes effect at the next save, slot binding, run and dispatch — a workflow saved earlier
   * that references the credential from a project no longer listed fails at run time.
   */
  async setProjects(
    id: string,
    input: { projects: readonly string[] | null },
    actor: ActorContext,
  ): Promise<CredentialView> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, id);
      const c = await this.#credential(tx, id);
      if (c.state !== 'active') throw conflict('credential_revoked', `Credential ${id} is revoked.`);
      const issues: CredentialIssue[] = [];
      const projects =
        input.projects === null
          ? null
          : await this.#projectList(input.projects, HOST_BOUND_CREDENTIAL_KINDS.has(c.kind), issues, tx);
      if (issues.length > 0) throw new CredentialInvalidError(issues);
      await tx.query(
        'UPDATE vault_credentials SET projects = $2, updated_at = $3, updated_by = $4 WHERE id = $1',
        [id, projects, now, actor.userId],
      );
      await this.#audit(tx, actor, 'vault.credential.projects', id, {
        before: c.projects ?? 'all',
        after: projects ?? 'all',
      });
    });
    return this.get(id);
  }

  /** A checked, sorted, de-duplicated project allowlist (issues: wrong kind, empty, too long, unknown project). */
  async #projectList(
    raw: readonly string[],
    hostBound: boolean,
    issues: CredentialIssue[],
    db: Queryable = this.deps.pool,
  ): Promise<string[]> {
    const list = [...new Set(raw.map((p) => p.trim()))].sort();
    if (!hostBound) issues.push({ path: 'projects', code: 'not_allowed' });
    else if (list.length === 0) issues.push({ path: 'projects', code: 'required' });
    else if (list.length > MAX_CREDENTIAL_PROJECTS) issues.push({ path: 'projects', code: 'too_many' });
    else {
      const { rows } = await db.query<{ id: string }>('SELECT id FROM projects WHERE id = ANY($1)', [list]);
      const known = new Set(rows.map((r) => r.id));
      if (list.some((p) => !known.has(p))) issues.push({ path: 'projects', code: 'unknown_project' });
    }
    return list;
  }

  async unshare(id: string, workerIds: readonly string[], actor: ActorContext): Promise<CredentialView> {
    const now = this.deps.clock();
    const touched = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, id);
      await this.#credential(tx, id);
      const { rows } = await tx.query<{ worker_id: string }>(
        `UPDATE vault_credential_workers SET state = 'revoked', sealed = NULL, sealed_digest = NULL,
                ack_outcome = NULL, ack_reason = NULL, updated_at = $3
          WHERE credential_id = $1 AND state = 'active' AND worker_id = ANY($2) RETURNING worker_id`,
        [id, [...new Set(workerIds)], now],
      );
      if (rows.length > 0) {
        await this.#audit(tx, actor, 'vault.credential.unshare', id, {
          workers: rows.map((r) => r.worker_id),
        });
        await this.#outbox(tx, { event: 'unshared', credentialId: id });
      }
      return rows.map((r) => r.worker_id);
    });
    for (const w of touched) await this.deliver(w);
    return this.get(id);
  }

  /** Revokes a credential everywhere; every ciphertext is deleted at once. */
  async revoke(id: string, actor: ActorContext): Promise<CredentialView> {
    const now = this.deps.clock();
    const touched = await withTransaction(this.deps.pool, async (tx) => {
      await this.#lock(tx, id);
      const c = await this.#credential(tx, id);
      if (c.state === 'revoked') return [];
      await tx.query(
        "UPDATE vault_credentials SET state = 'revoked', revoked_at = $2, updated_at = $2, updated_by = $3 WHERE id = $1",
        [id, now, actor.userId],
      );
      const { rows } = await tx.query<{ worker_id: string }>(
        `UPDATE vault_credential_workers SET state = 'revoked', sealed = NULL, sealed_digest = NULL,
                ack_outcome = NULL, ack_reason = NULL, updated_at = $2
          WHERE credential_id = $1 AND state = 'active' RETURNING worker_id`,
        [id, now],
      );
      await this.#audit(tx, actor, 'vault.credential.revoke', id, {
        version: c.version,
        workers: rows.map((r) => r.worker_id),
      });
      await this.#outbox(tx, { event: 'revoked', credentialId: id, version: c.version });
      return rows.map((r) => r.worker_id);
    });
    for (const w of touched) await this.deliver(w);
    return this.get(id);
  }

  /** Asks a worker to generate a new vault key (already stored values stay valid on the worker). */
  async rotateKey(workerId: string, actor: ActorContext): Promise<{ requested: boolean }> {
    const w = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL',
      [workerId],
    );
    const row = w.rows[0];
    if (row === undefined)
      throw new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
    if (!features(row.features).includes(VAULT_FEATURE)) {
      throw conflict('worker_unsupported', 'This worker build has no credential vault; update the worker.');
    }
    const session = this.deps.session(workerId);
    await this.#audit(this.deps.pool, actor, 'vault.key.rotate_requested', workerId, {
      connected: session !== undefined,
    });
    if (session === undefined) return { requested: false };
    await session.send('ROTATE_VAULT_KEY', { requestId: randomUUID() });
    return { requested: true };
  }

  // ---------------------------------------------------------------------------------------- delivery

  /**
   * Sends what a connected `credential-vault-v1` worker is missing: APPLY_CREDENTIAL for every shared credential
   * whose desired version it does not hold (unless it refused exactly that version), REVOKE_CREDENTIAL for every
   * revoked one it may still hold. Never throws.
   */
  async deliver(workerId: string, session?: WorkerSession): Promise<number> {
    try {
      const s = session ?? this.deps.session(workerId);
      if (s === undefined) return 0;
      const f = await this.deps.pool.query<{ features: unknown }>(
        'SELECT features FROM workers WHERE id = $1',
        [workerId],
      );
      if (!features(f.rows[0]?.features).includes(VAULT_FEATURE)) return 0;
      const { rows } = await this.deps.pool.query<{
        credential_id: string;
        version: number;
        kind: string;
        env: string;
        sealed: unknown;
        state: string;
        acked_version: number | null;
        ack_outcome: string | null;
      }>(
        `SELECT r.credential_id, r.version, c.kind, c.env, r.sealed, r.state, r.acked_version, r.ack_outcome
           FROM vault_credential_workers r JOIN vault_credentials c ON c.id = r.credential_id
          WHERE r.worker_id = $1 ORDER BY r.credential_id`,
        [workerId],
      );
      let sent = 0;
      for (const r of rows) {
        const issuedAt = this.deps.clock().toISOString();
        if (r.state === 'active') {
          if (r.acked_version === r.version || r.ack_outcome === 'rejected') continue;
          const sealed = SealedValueSchema.parse(r.sealed);
          const digest = sealedDigest({ kind: r.kind, env: r.env, sealed });
          const payload: ApplyCredentialPayload = {
            credentialId: r.credential_id,
            version: r.version,
            kind: CredentialKind.parse(r.kind),
            env: r.env,
            sealed,
            issuedAt,
            signature: this.deps.signer.signCredentialDelivery({
              op: 'apply',
              workerId,
              credentialId: r.credential_id,
              version: r.version,
              digest,
              issuedAt,
            }),
          };
          await s.send('APPLY_CREDENTIAL', payload);
        } else {
          if (r.ack_outcome === 'revoked' || r.acked_version === null) continue;
          await s.send('REVOKE_CREDENTIAL', {
            credentialId: r.credential_id,
            version: Math.max(r.version, r.acked_version),
            issuedAt,
            signature: this.deps.signer.signCredentialDelivery({
              op: 'revoke',
              workerId,
              credentialId: r.credential_id,
              version: Math.max(r.version, r.acked_version),
              digest: '-',
              issuedAt,
            }),
          });
        }
        await this.deps.pool.query(
          'UPDATE vault_credential_workers SET delivered_at = $3 WHERE credential_id = $1 AND worker_id = $2',
          [r.credential_id, workerId, this.deps.clock()],
        );
        sent++;
      }
      if (sent > 0) this.deps.log.info({ workerId, messages: sent }, 'vault credentials sent');
      return sent;
    } catch (err) {
      this.deps.log.error({ err, workerId }, 'vault delivery failed');
      return 0;
    }
  }

  /**
   * CAPABILITIES.credentialVault: pin (or rotate) the worker's vault key after checking the device-key signature,
   * record what it holds, then re-deliver what is missing.
   */
  async onReport(session: WorkerSession, report: CredentialVaultReport | undefined): Promise<void> {
    if (report === undefined) return;
    const now = this.deps.clock();
    if (report.key !== null) await this.#pinKey(session, report.key, report.previousKeyId ?? null, now);
    const held = new Map(report.credentials.map((c) => [c.id, c]));
    const revoked = new Map(report.revoked.map((r) => [r.id, r.version]));
    const { rows } = await this.deps.pool.query<{
      credential_id: string;
      version: number;
      state: string;
      ack_outcome: string | null;
      acked_version: number | null;
    }>(
      'SELECT credential_id, version, state, ack_outcome, acked_version FROM vault_credential_workers WHERE worker_id = $1',
      [session.workerId],
    );
    for (const r of rows) {
      const h = held.get(r.credential_id);
      let ackedVersion: number | null = h?.version ?? null;
      let outcome = r.ack_outcome;
      if (r.state === 'active') {
        if (h?.version === r.version) outcome = 'applied';
        else if (outcome === 'applied') outcome = null;
      } else if (h === undefined || (revoked.get(r.credential_id) ?? 0) >= r.version) {
        outcome = 'revoked';
        ackedVersion = null;
      }
      await this.deps.pool.query(
        `UPDATE vault_credential_workers SET acked_version = $3, ack_outcome = $4, acked_at = $5,
                last_used_at = COALESCE($6, last_used_at)
          WHERE credential_id = $1 AND worker_id = $2`,
        [r.credential_id, session.workerId, ackedVersion, outcome, now, h?.lastUsedAt ?? null],
      );
    }
    await this.deliver(session.workerId, session);
  }

  /** CREDENTIAL_STATUS: id and version only (never a value). */
  async onStatus(session: WorkerSession, p: CredentialStatusPayload): Promise<void> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      version: number;
      state: string;
      ack_outcome: string | null;
    }>(
      'SELECT version, state, ack_outcome FROM vault_credential_workers WHERE credential_id = $1 AND worker_id = $2',
      [p.credentialId, session.workerId],
    );
    const r = rows[0];
    if (r === undefined) return;
    switch (p.outcome) {
      case 'applied':
      case 'unchanged':
        await this.deps.pool.query(
          `UPDATE vault_credential_workers SET acked_version = $3, ack_outcome = 'applied', ack_reason = NULL,
                  acked_at = $4 WHERE credential_id = $1 AND worker_id = $2`,
          [p.credentialId, session.workerId, p.version, now],
        );
        return;
      case 'revoked':
        await this.deps.pool.query(
          `UPDATE vault_credential_workers SET acked_version = NULL, ack_outcome = 'revoked', ack_reason = NULL,
                  acked_at = $3 WHERE credential_id = $1 AND worker_id = $2 AND state = 'revoked'`,
          [p.credentialId, session.workerId, now],
        );
        return;
      case 'stale':
        return;
      case 'rejected': {
        if (r.state !== 'active' || r.version !== p.version || r.ack_outcome === 'rejected') return;
        const reason = p.reason ?? 'rejected';
        await withTransaction(this.deps.pool, async (tx) => {
          await tx.query(
            `UPDATE vault_credential_workers SET ack_outcome = 'rejected', ack_reason = $3, acked_at = $4
              WHERE credential_id = $1 AND worker_id = $2`,
            [p.credentialId, session.workerId, reason, now],
          );
          await this.deps.audit.record(
            {
              actor: { type: 'worker', id: session.workerId },
              action: 'vault.credential.rejected',
              target: p.credentialId,
              outcome: 'failure',
              metadata: { version: p.version, reason, workerId: session.workerId },
            },
            tx,
          );
          await this.#outbox(tx, {
            event: 'rejected',
            credentialId: p.credentialId,
            workerId: session.workerId,
            version: p.version,
            reason,
          });
        });
        this.deps.log.warn(
          { workerId: session.workerId, credentialId: p.credentialId, version: p.version, reason },
          'worker refused a vault credential',
        );
        return;
      }
    }
  }

  // --------------------------------------------------------------------------------------- internals

  async #pinKey(
    session: WorkerSession,
    key: NonNullable<CredentialVaultReport['key']>,
    previousKeyId: string | null,
    now: Date,
  ): Promise<void> {
    const workerId = session.workerId;
    const current = await this.deps.pool.query<{ key_id: string; public_key: string }>(
      'SELECT key_id, public_key FROM worker_vault_keys WHERE worker_id = $1 AND retired_at IS NULL',
      [workerId],
    );
    const pinned = current.rows[0];
    if (pinned?.key_id === key.keyId && pinned.public_key === key.publicKey) return;
    const validId = (await vaultKeyId(key.publicKey).catch(() => null)) === key.keyId;
    if (!validId || !verifyVaultKey(workerId, session.publicKey, key)) {
      this.deps.log.error(
        { workerId, keyId: key.keyId },
        'vault key announcement refused: bad key id or signature',
      );
      await this.deps.audit.record({
        actor: { type: 'worker', id: workerId },
        action: 'vault.key.refused',
        target: workerId,
        outcome: 'failure',
        metadata: { keyId: key.keyId, reason: validId ? 'bad_signature' : 'bad_key_id' },
      });
      return;
    }
    const fingerprint = await vaultKeyFingerprint(key.publicKey);
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('remyral-vault-key:' || $1, 30))", [
        workerId,
      ]);
      const again = await tx.query<{ key_id: string }>(
        'SELECT key_id FROM worker_vault_keys WHERE worker_id = $1 AND retired_at IS NULL',
        [workerId],
      );
      const before = again.rows[0]?.key_id ?? null;
      if (before === key.keyId) return;
      await tx.query(
        'UPDATE worker_vault_keys SET retired_at = $2 WHERE worker_id = $1 AND retired_at IS NULL',
        [workerId, now],
      );
      await tx.query(
        `INSERT INTO worker_vault_keys (worker_id, key_id, public_key, fingerprint, created_at, signature, pinned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (worker_id, key_id) DO UPDATE SET retired_at = NULL, pinned_at = EXCLUDED.pinned_at`,
        [workerId, key.keyId, key.publicKey, fingerprint, new Date(key.createdAt), key.signature, now],
      );
      // Continuity: a rotation names the key it replaced; anything else (a wiped data dir) is a replacement.
      const kind = before === null ? 'pinned' : previousKeyId === before ? 'rotated' : 'replaced';
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: workerId },
          action: `vault.key.${kind}`,
          target: workerId,
          outcome: 'success',
          metadata: { keyId: key.keyId, fingerprint, previousKeyId: before },
        },
        tx,
      );
      if (before !== null) await this.#outbox(tx, { event: 'key_changed', workerId });
    });
  }

  /** Validates per-worker ciphertext: schema, enrolled + capable worker, sealed to its pinned current key. */
  async #checkSealed(
    db: Queryable,
    input: readonly SealedForWorker[],
    meta: { credentialId: string; kind: string; env: string },
  ): Promise<{ workerId: string; keyId: string; sealed: SealedValueSchema; digest: string }[]> {
    const issues: CredentialIssue[] = [];
    if (input.length === 0) issues.push({ path: 'workers', code: 'empty' });
    if (new Set(input.map((w) => w.workerId)).size !== input.length)
      issues.push({ path: 'workers', code: 'duplicate' });
    const out: { workerId: string; keyId: string; sealed: SealedValueSchema; digest: string }[] = [];
    for (const [i, w] of input.entries()) {
      const parsed = SealedValueSchema.safeParse(w.sealed);
      if (!parsed.success || parsed.data.keyId !== w.keyId) {
        issues.push({ path: `workers.${String(i)}.sealed`, code: 'invalid' });
        continue;
      }
      const { rows } = await db.query<{ features: unknown; key_id: string | null }>(
        `SELECT w.features, k.key_id FROM workers w
           LEFT JOIN worker_vault_keys k ON k.worker_id = w.id AND k.retired_at IS NULL
          WHERE w.id = $1 AND w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL`,
        [w.workerId],
      );
      const row = rows[0];
      if (row === undefined) {
        issues.push({ path: `workers.${String(i)}.workerId`, code: 'unknown_worker' });
        continue;
      }
      // p14-workflow-engine 14.3: an http-auth / smtp credential only for function-v1 workers (older builds would
      // refuse the kind, and only function jobs ever use it).
      if (!holdable(meta.kind, row.features)) {
        issues.push({ path: `workers.${String(i)}.workerId`, code: 'worker_unsupported' });
        continue;
      }
      if (row.key_id === null || row.key_id !== w.keyId) {
        issues.push({ path: `workers.${String(i)}.keyId`, code: 'key_mismatch' });
        continue;
      }
      out.push({
        workerId: w.workerId,
        keyId: w.keyId,
        sealed: parsed.data,
        digest: sealedDigest({ kind: meta.kind, env: meta.env, sealed: parsed.data }),
      });
    }
    if (issues.length > 0) throw new CredentialInvalidError(issues);
    return out;
  }

  async #upsertActive(
    tx: Queryable,
    credentialId: string,
    s: { workerId: string; keyId: string; sealed: SealedValueSchema; digest: string },
    version: number,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO vault_credential_workers (credential_id, worker_id, version, key_id, sealed, sealed_digest, state,
                                             updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       ON CONFLICT (credential_id, worker_id) DO UPDATE SET version = EXCLUDED.version, key_id = EXCLUDED.key_id,
         sealed = EXCLUDED.sealed, sealed_digest = EXCLUDED.sealed_digest, state = 'active', ack_outcome = NULL,
         ack_reason = NULL, delivered_at = NULL, updated_at = EXCLUDED.updated_at`,
      [credentialId, s.workerId, version, s.keyId, JSON.stringify(s.sealed), s.digest, now],
    );
  }

  async #audit(
    db: Queryable,
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
      db,
    );
  }

  async #outbox(tx: Queryable, payload: VaultOutboxPayload): Promise<void> {
    await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
      OUTBOX_TOPIC_VAULT,
      JSON.stringify(payload),
      this.deps.clock(),
    ]);
  }

  async #lock(tx: Queryable, id: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('remyral-vault-credential:' || $1, 30))", [
      id,
    ]);
  }

  async #credential(db: Queryable, id: string): Promise<CredentialRow> {
    if (!VaultCredentialId.safeParse(id).success) throw notFound();
    const { rows } = await db.query<CredentialRow>(
      `SELECT id, name, kind, env, description, version, state, created_at, created_by::text AS created_by,
              updated_at, revoked_at, allowed_hosts, projects FROM vault_credentials WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    return row;
  }

  async #workerRows(db: Queryable, id: string | null): Promise<WorkerRowState[]> {
    const { rows } = await db.query<WorkerRowState>(
      `SELECT r.credential_id, r.worker_id, w.display_name, w.features, r.version, r.key_id, r.sealed,
              r.sealed_digest, r.state, r.acked_version, r.acked_at, r.ack_outcome, r.ack_reason, r.last_used_at,
              k.key_id AS current_key_id
         FROM vault_credential_workers r
         JOIN workers w ON w.id = r.worker_id
         LEFT JOIN worker_vault_keys k ON k.worker_id = r.worker_id AND k.retired_at IS NULL
        WHERE ($1::text IS NULL OR r.credential_id = $1)
        ORDER BY w.display_name, r.worker_id`,
      [id],
    );
    return rows;
  }

  #view(c: CredentialRow, rows: readonly WorkerRowState[]): CredentialView {
    const used = rows.map((r) => r.last_used_at).filter((d): d is Date => d !== null);
    const last = used.length === 0 ? null : new Date(Math.max(...used.map((d) => d.getTime())));
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      env: c.env,
      description: c.description,
      version: c.version,
      state: c.state,
      createdAt: c.created_at.toISOString(),
      createdBy: c.created_by,
      updatedAt: c.updated_at.toISOString(),
      revokedAt: iso(c.revoked_at),
      lastUsedAt: iso(last),
      allowedHosts: c.allowed_hosts === undefined || c.allowed_hosts === null ? null : [...c.allowed_hosts],
      projects: c.projects === undefined || c.projects === null ? null : [...c.projects],
      // Never the ciphertext: the panel has no use for it.
      workers: rows.map((r) => ({
        workerId: r.worker_id,
        displayName: r.display_name,
        version: r.version,
        keyId: r.key_id,
        status: workerStatus({ ...r, supported: holdable(c.kind, r.features) }),
        ackedVersion: r.acked_version,
        ackedAt: iso(r.acked_at),
        reason: r.ack_reason,
        lastUsedAt: iso(r.last_used_at),
      })),
    };
  }
}

/** Whether a worker can hold a credential of `kind` (the vault feature; function-v1 for host-bound kinds). */
function holdable(kind: string, workerFeatures: unknown): boolean {
  const f = features(workerFeatures);
  if (!f.includes(VAULT_FEATURE)) return false;
  // p15-git-central: repository credentials only on workers whose git uses them (older ones cannot parse the kind).
  if (GIT_CREDENTIAL_KINDS.has(kind as CredentialKind)) return f.includes(GIT_CENTRAL_FEATURE);
  return !HOST_BOUND_CREDENTIAL_KINDS.has(kind as CredentialKind) || f.includes(FUNCTION_FEATURE);
}
