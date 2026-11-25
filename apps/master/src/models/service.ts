import { scanForSecrets } from '@remyral/memory';
import {
  catalogEntryIssues,
  type CatalogIssue,
  isRetiredRuntime,
  ModelCatalogEntryInput,
  modelIdIssue,
  PolicyName,
  RuntimeKind,
  type RuntimePolicyDocument,
  WorkerConfigSpec,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { RUNTIME_REMOVED_MESSAGE } from '../jobs/errors.js';
import type { ActorContext } from '../workers/fleet.js';

export class ModelCatalogInvalidError extends HttpError {
  constructor(
    readonly issues: readonly CatalogIssue[],
    message = 'The model profile is invalid; see issues.',
  ) {
    super(400, 'model_profile_invalid', message);
    this.name = 'ModelCatalogInvalidError';
  }
}

export interface CatalogEntry {
  readonly entry: ModelCatalogEntryInput;
  readonly version: number;
}

export type ModelView = ModelCatalogEntryInput & {
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly usedBy: {
    readonly policies: { policy: string; version: number; runtime: RuntimeKind; inSync: boolean }[];
    readonly workers: string[];
  };
};

/**
 * A project / global default of a runtime: a model profile (`profileId`) or, since p15-model-picker, a model id
 * (`model`, from the runtime model catalog or a custom id). Exactly one of the two is set.
 */
export interface ModelDefault {
  readonly project: string | null;
  readonly runtime: RuntimeKind;
  readonly profileId: string | null;
  readonly model: string | null;
}

interface Row {
  id: string;
  entry: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
}

/** Every string leaf of an entry (secret scan: a profile is configuration, never a credential, ADR-0006). */
function leaves(e: ModelCatalogEntryInput): Record<string, string> {
  const out: Record<string, string> = {
    displayName: e.displayName,
    model: e.model,
    ...(e.description === undefined ? {} : { description: e.description }),
  };
  for (const [k, v] of Object.entries(e.params)) if (typeof v === 'string') out[`params.${k}`] = v;
  return out;
}

/** Validates an entry from the API: schema (no unknown keys), consistency and the secret scan. */
export function validateEntry(input: unknown): ModelCatalogEntryInput {
  // ADR-0023: a removed runtime is refused with its own code (not a generic enum error).
  const runtimes = (input as { runtimes?: unknown } | null)?.runtimes;
  if (Array.isArray(runtimes) && runtimes.some((r) => isRetiredRuntime(r))) {
    throw new ModelCatalogInvalidError(
      [{ path: 'runtimes', code: 'runtime_removed' }],
      RUNTIME_REMOVED_MESSAGE,
    );
  }
  const parsed = ModelCatalogEntryInput.safeParse(input);
  if (!parsed.success) {
    throw new ModelCatalogInvalidError(
      parsed.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), code: i.code })),
    );
  }
  const e = parsed.data;
  const issues: CatalogIssue[] = [];
  if (input !== null && typeof input === 'object') {
    for (const k of Object.keys(input))
      if (!(k in e) && k !== 'description' && k !== 'credentialRef')
        issues.push({ path: k, code: 'unknown_key' });
  }
  issues.push(...catalogEntryIssues(e));
  for (const f of scanForSecrets(leaves(e))) issues.push({ path: f.field, code: 'secret_detected' });
  if (issues.length > 0) throw new ModelCatalogInvalidError(issues);
  return e;
}

/** The catalog keyed by id (stored rows re-validated; a malformed row is skipped and logged by callers). */
export async function loadCatalog(db: Queryable): Promise<Map<string, CatalogEntry>> {
  const { rows } = await db.query<{ id: string; entry: unknown; version: number }>(
    'SELECT id, entry, version FROM model_catalog',
  );
  const out = new Map<string, CatalogEntry>();
  for (const r of rows) {
    const p = ModelCatalogEntryInput.safeParse(r.entry);
    if (p.success && p.data.id === r.id) out.set(r.id, { entry: p.data, version: r.version });
  }
  return out;
}

/**
 * Runtime-policy ⇄ catalog consistency (unification, docs/design/p5-credentials-models.md §3): a policy profile
 * whose name is a catalog id stands for that catalog entry on that runtime, so it must agree with it.
 */
export async function catalogPolicyIssues(
  db: Queryable,
  doc: RuntimePolicyDocument,
): Promise<CatalogIssue[]> {
  const catalog = await loadCatalog(db);
  const out: CatalogIssue[] = [];
  for (const runtime of RuntimeKind.options) {
    const rule = doc.runtimes[runtime];
    if (rule === undefined) continue;
    rule.modelProfiles.forEach((p, i) => {
      const c = catalog.get(p.name);
      if (c === undefined) return;
      const path = `runtimes.${runtime}.modelProfiles.${String(i)}`;
      if (!c.entry.enabled) out.push({ path, code: 'catalog_profile_disabled' });
      else if (!c.entry.runtimes.includes(runtime)) out.push({ path, code: 'catalog_runtime_mismatch' });
      else if (c.entry.provider !== p.provider || c.entry.model !== p.model)
        out.push({ path, code: 'catalog_mismatch' });
    });
  }
  return out;
}

/**
 * Model catalog (p5-credentials-models): master-wide model profiles, per project/runtime defaults, and which runtime
 * policies and worker configurations use each profile. Admin + step-up to write, every change audited; a change
 * re-resolves the worker configurations that name the profile (`onChanged`).
 */
export class ModelCatalogService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      /** Re-resolve worker configurations naming the profile (WorkerConfigService.onCatalogChanged). */
      readonly onChanged?: (id: string, actor: ActorContext | null) => Promise<void>;
    },
  ) {}

  /** p15-model-picker: the pool the runtime model catalog reads (routes). */
  get pool(): Pool {
    return this.deps.pool;
  }

  async list(): Promise<{ items: ModelView[]; defaults: ModelDefault[] }> {
    const db = this.deps.pool;
    const { rows } = await db.query<Row>(
      `SELECT id, entry, version, created_at, updated_at, updated_by::text AS updated_by
         FROM model_catalog ORDER BY id`,
    );
    const policies = await db.query<{ policy: string; version: number; document: RuntimePolicyDocument }>(
      `SELECT p.name AS policy, v.version, v.document FROM runtime_policies p
         JOIN runtime_policy_versions v ON v.policy = p.name AND v.version IN (p.active_version, p.canary_version)`,
    );
    const workers = await this.#workerUsage(db);
    const items: ModelView[] = [];
    for (const r of rows) {
      const p = ModelCatalogEntryInput.safeParse(r.entry);
      if (!p.success) {
        this.deps.log.error({ id: r.id }, 'model catalog row does not validate; hidden');
        continue;
      }
      const e = p.data;
      const usedPolicies: { policy: string; version: number; runtime: RuntimeKind; inSync: boolean }[] = [];
      for (const pv of policies.rows) {
        for (const runtime of RuntimeKind.options) {
          const prof = pv.document.runtimes[runtime]?.modelProfiles.find((m) => m.name === e.id);
          if (prof === undefined) continue;
          usedPolicies.push({
            policy: pv.policy,
            version: pv.version,
            runtime,
            inSync:
              e.enabled &&
              e.runtimes.includes(runtime) &&
              prof.provider === e.provider &&
              prof.model === e.model,
          });
        }
      }
      items.push({
        ...e,
        version: r.version,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        updatedBy: r.updated_by,
        usedBy: { policies: usedPolicies, workers: workers.get(e.id) ?? [] },
      });
    }
    return { items, defaults: await this.defaults() };
  }

  async defaults(project?: string): Promise<ModelDefault[]> {
    const { rows } = await this.deps.pool.query<{
      project: string;
      runtime: RuntimeKind;
      profile_id: string | null;
      model: string | null;
    }>(
      `SELECT project, runtime, profile_id, model FROM model_defaults
        WHERE $1::text IS NULL OR project IN ('', $1) ORDER BY project, runtime`,
      [project ?? null],
    );
    return rows.map((r) => ({
      project: r.project === '' ? null : r.project,
      runtime: r.runtime,
      profileId: r.profile_id,
      model: r.model,
    }));
  }

  async put(
    id: string,
    input: { entry: unknown; expectedVersion: number },
    actor: ActorContext,
  ): Promise<ModelView> {
    const entry = validateEntry(input.entry);
    if (entry.id !== id) throw new ModelCatalogInvalidError([{ path: 'id', code: 'mismatch' }]);
    const now = this.deps.clock();
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('remyral-model-catalog:' || $1, 30))", [
        id,
      ]);
      const cur = await tx.query<{ version: number; entry: unknown }>(
        'SELECT version, entry FROM model_catalog WHERE id = $1',
        [id],
      );
      const before = cur.rows[0];
      const version = before?.version ?? 0;
      if (version !== input.expectedVersion) {
        throw new HttpError(
          409,
          'version_conflict',
          `Model profile ${id} is at version ${String(version)}; reload.`,
          {},
          {},
          { reason: 'model_profile', id, version },
        );
      }
      if (before !== undefined && JSON.stringify(before.entry) === JSON.stringify(entry)) return false;
      if (before === undefined) {
        await tx.query(
          `INSERT INTO model_catalog (id, entry, enabled, version, created_at, created_by, updated_at, updated_by)
           VALUES ($1, $2, $3, 1, $4, $5, $4, $5)`,
          [id, JSON.stringify(entry), entry.enabled, now, actor.userId],
        );
      } else {
        await tx.query(
          `UPDATE model_catalog SET entry = $2, enabled = $3, version = version + 1, updated_at = $4, updated_by = $5
            WHERE id = $1`,
          [id, JSON.stringify(entry), entry.enabled, now, actor.userId],
        );
      }
      if (!entry.enabled || before !== undefined) {
        // A default must stay usable: drop defaults the change made invalid.
        await tx.query(
          'DELETE FROM model_defaults WHERE profile_id = $1 AND (NOT $2::boolean OR NOT (runtime = ANY($3)))',
          [id, entry.enabled, entry.runtimes],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: before === undefined ? 'model.profile.create' : 'model.profile.update',
          target: id,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: {
            version: version + 1,
            runtimes: entry.runtimes,
            provider: entry.provider,
            model: entry.model,
            enabled: entry.enabled,
            credentialSource: entry.credentialRef?.source ?? null,
          },
        },
        tx,
      );
      return before !== undefined;
    });
    if (changed) await this.deps.onChanged?.(id, actor);
    const view = (await this.list()).items.find((m) => m.id === id);
    if (view === undefined)
      throw new HttpError(404, 'not_found', 'Model profile not found.', {}, {}, { reason: 'model_profile' });
    return view;
  }

  async remove(id: string, actor: ActorContext): Promise<void> {
    if (!PolicyName.safeParse(id).success)
      throw new HttpError(404, 'not_found', 'Model profile not found.', {}, {}, { reason: 'model_profile' });
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('remyral-model-catalog:' || $1, 30))", [
        id,
      ]);
      const exists = await tx.query('SELECT 1 FROM model_catalog WHERE id = $1', [id]);
      if ((exists.rowCount ?? 0) === 0)
        throw new HttpError(
          404,
          'not_found',
          'Model profile not found.',
          {},
          {},
          { reason: 'model_profile' },
        );
      const users = (await this.#workerUsage(tx)).get(id) ?? [];
      // p6-smart-routing: a routing rule naming the profile counts as a use like a default.
      const defaults = await tx.query(
        'SELECT 1 FROM model_defaults WHERE profile_id = $1 UNION ALL SELECT 1 FROM routing_rules WHERE model_profile = $1',
        [id],
      );
      if (users.length > 0 || (defaults.rowCount ?? 0) > 0) {
        throw new HttpError(
          409,
          'in_use',
          `Model profile ${id} is used by ${String(users.length)} worker configuration(s), a default or a routing rule; change them first (or disable the profile).`,
          {},
          {},
          { id, count: users.length },
        );
      }
      await tx.query('DELETE FROM model_catalog WHERE id = $1', [id]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'model.profile.delete',
          target: id,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });
  }

  async setDefault(
    input: {
      project: string | null;
      runtime: RuntimeKind;
      profileId: string | null;
      model?: string | null | undefined;
    },
    actor: ActorContext,
  ): Promise<ModelDefault[]> {
    const project = input.project ?? '';
    const model = input.model ?? null;
    if (model !== null && input.profileId !== null)
      throw new ModelCatalogInvalidError([{ path: 'model', code: 'profile_and_model' }]);
    if (model !== null) {
      const issue = modelIdIssue(model);
      if (issue !== null) throw new ModelCatalogInvalidError([{ path: 'model', code: `model_${issue}` }]);
      if (scanForSecrets({ model }).length > 0)
        throw new ModelCatalogInvalidError([{ path: 'model', code: 'secret_detected' }]);
    }
    await withTransaction(this.deps.pool, async (tx) => {
      if (project !== '') {
        const p = await tx.query('SELECT 1 FROM projects WHERE id = $1', [project]);
        if ((p.rowCount ?? 0) === 0)
          throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
      }
      if (model !== null) {
        // p15-model-picker: a model id (catalog or custom) instead of a profile.
        await tx.query(
          `INSERT INTO model_defaults (project, runtime, profile_id, model, updated_at, updated_by)
           VALUES ($1, $2, NULL, $3, $4, $5)
           ON CONFLICT (project, runtime) DO UPDATE SET profile_id = NULL, model = EXCLUDED.model,
             updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [project, input.runtime, model, this.deps.clock(), actor.userId],
        );
      } else if (input.profileId === null) {
        await tx.query('DELETE FROM model_defaults WHERE project = $1 AND runtime = $2', [
          project,
          input.runtime,
        ]);
      } else {
        const catalog = await loadCatalog(tx);
        const c = catalog.get(input.profileId);
        if (c === undefined)
          throw new ModelCatalogInvalidError([{ path: 'profileId', code: 'unknown_profile' }]);
        if (!c.entry.enabled)
          throw new ModelCatalogInvalidError([{ path: 'profileId', code: 'profile_disabled' }]);
        if (!c.entry.runtimes.includes(input.runtime))
          throw new ModelCatalogInvalidError([{ path: 'profileId', code: 'runtime_mismatch' }]);
        await tx.query(
          `INSERT INTO model_defaults (project, runtime, profile_id, model, updated_at, updated_by)
           VALUES ($1, $2, $3, NULL, $4, $5)
           ON CONFLICT (project, runtime) DO UPDATE SET profile_id = EXCLUDED.profile_id, model = NULL,
             updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [project, input.runtime, input.profileId, this.deps.clock(), actor.userId],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'model.default.set',
          target: `${project === '' ? '*' : project}/${input.runtime}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { profileId: input.profileId, model },
        },
        tx,
      );
    });
    return this.defaults();
  }

  /** Catalog id → worker ids whose desired configuration names it as a runtime's model profile. */
  async #workerUsage(db: Queryable): Promise<Map<string, string[]>> {
    const { rows } = await db.query<{ worker_id: string; spec: unknown }>(
      `SELECT c.worker_id, v.spec FROM worker_configs c
         JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation`,
    );
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const spec = WorkerConfigSpec.safeParse(r.spec);
      if (!spec.success) continue;
      const ids = new Set<string>();
      for (const runtime of RuntimeKind.options) {
        const p = spec.data.runtimes[runtime]?.modelProfile;
        if (p !== undefined) ids.add(p);
      }
      for (const id of ids) out.set(id, [...(out.get(id) ?? []), r.worker_id]);
    }
    return out;
  }
}
