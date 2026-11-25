import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { CORE_EVENTS, STEP_UP_EVENT_IDS, STEP_UP_EVENTS, type StepUpEvent } from './events.js';
import {
  applyPatch,
  changedPaths,
  DEFAULT_DOCUMENT,
  effectivePolicy,
  type EffectiveSecurityPolicy,
  PRESETS,
  SECURITY_PRESETS,
  SecurityPolicyDocument,
  type SecurityPolicyPatch,
} from './model.js';

/**
 * p15-autonomy (ADR-0056): the stored security policy (`security_policy`, one row; every change also a row of
 * `security_policy_versions`), its in-process cache and the audited change path.
 *
 * Reads are cached for `cacheMs` (default 5 s; a change through this instance clears the cache at once, other master
 * replicas follow within the TTL). A row that cannot be parsed falls back to the strict preset (fail closed) and is
 * logged through `onInvalid`.
 */

export interface SecurityPolicyReader {
  current(): Promise<EffectiveSecurityPolicy>;
}

export interface SecurityPolicyView {
  readonly version: number;
  readonly document: SecurityPolicyDocument;
  readonly effective: EffectiveSecurityPolicy;
  readonly updatedAt: string | null;
  readonly updatedBy: { readonly id: string; readonly username: string } | null;
}

export interface PolicyActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** `chat`: executed by the assistant on the user's explicit instruction. */
  readonly via?: 'console' | 'chat';
}

export interface SecurityPolicyServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  readonly cacheMs?: number;
  readonly onInvalid?: (err: unknown) => void;
}

const STRICT: SecurityPolicyDocument = { preset: 'siki' };

/** Reads the stored document (no cache; for services without the service object, e.g. composer defaults). */
export async function loadSecurityDocument(db: Queryable): Promise<SecurityPolicyDocument> {
  const { rows } = await db.query<{ document: unknown }>('SELECT document FROM security_policy WHERE id = 1');
  const row = rows[0];
  if (row === undefined) return DEFAULT_DOCUMENT;
  const parsed = SecurityPolicyDocument.safeParse(row.document);
  return parsed.success ? parsed.data : STRICT;
}

export class SecurityPolicyService implements SecurityPolicyReader {
  readonly #clock: () => Date;
  readonly #cacheMs: number;
  #cached: { at: number; value: EffectiveSecurityPolicy } | null = null;

  constructor(private readonly deps: SecurityPolicyServiceDeps) {
    this.#clock = deps.clock ?? (() => new Date());
    this.#cacheMs = deps.cacheMs ?? 5_000;
  }

  async current(): Promise<EffectiveSecurityPolicy> {
    const now = Date.now();
    const c = this.#cached;
    if (c !== null && now - c.at < this.#cacheMs) return c.value;
    let value: EffectiveSecurityPolicy;
    try {
      value = effectivePolicy(await this.#document(this.deps.pool));
    } catch (err) {
      // No table yet (a master started against an older schema) or the database is unreachable: strict.
      this.deps.onInvalid?.(err);
      value = effectivePolicy(STRICT);
    }
    this.#cached = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.#cached = null;
  }

  async #document(db: Queryable): Promise<SecurityPolicyDocument> {
    const { rows } = await db.query<{ document: unknown }>(
      'SELECT document FROM security_policy WHERE id = 1',
    );
    const row = rows[0];
    if (row === undefined) return DEFAULT_DOCUMENT;
    const parsed = SecurityPolicyDocument.safeParse(row.document);
    if (!parsed.success) {
      this.deps.onInvalid?.(parsed.error);
      return STRICT;
    }
    return parsed.data;
  }

  async view(db: Queryable = this.deps.pool): Promise<SecurityPolicyView> {
    const { rows } = await db.query<{
      version: number;
      document: unknown;
      updated_at: Date | null;
      updated_by: string | null;
      username: string | null;
    }>(
      `SELECT p.version, p.document, p.updated_at, p.updated_by, u.username
         FROM security_policy p LEFT JOIN users u ON u.id = p.updated_by
        WHERE p.id = 1`,
    );
    const row = rows[0];
    const parsed = row === undefined ? null : SecurityPolicyDocument.safeParse(row.document);
    const document = parsed === null ? DEFAULT_DOCUMENT : parsed.success ? parsed.data : STRICT;
    return {
      version: row?.version ?? 0,
      document,
      effective: effectivePolicy(document),
      updatedAt: row?.updated_at?.toISOString() ?? null,
      updatedBy:
        row?.updated_by === null || row?.updated_by === undefined
          ? null
          : { id: row.updated_by, username: row.username ?? row.updated_by },
    };
  }

  /**
   * Applies a change (audited `security.policy.update`, with the changed paths, the versions and the channel).
   * `expectedVersion` (optional) refuses a change based on an older view (409 `policy_conflict`). A change that changes
   * nothing is answered with the current view and audited as `noop`.
   */
  async update(
    actor: PolicyActor,
    patch: SecurityPolicyPatch,
    opts: { readonly expectedVersion?: number; readonly reason?: string } = {},
  ): Promise<SecurityPolicyView & { readonly changed: readonly string[] }> {
    let conflictAt: number | null = null;
    const out = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT 1 FROM security_policy WHERE id = 1 FOR UPDATE');
      const before = await this.view(tx);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
        // Audited after the rollback (below): the refusal must survive the aborted transaction.
        conflictAt = before.version;
        throw new HttpError(
          409,
          'version_conflict',
          'The security policy changed meanwhile; reload it and try again.',
          {},
          {},
          { reason: 'security_policy' },
        );
      }
      const document = applyPatch(before.document, patch);
      const after = effectivePolicy(document);
      const changed = changedPaths(before.effective, after);
      if (changed.length === 0 && JSON.stringify(document) === JSON.stringify(before.document)) {
        await this.#record(tx, actor, 'success', { noop: true, version: before.version });
        return { ...before, changed: [] as string[] };
      }
      const now = this.#clock();
      const version = before.version + 1;
      await tx.query(
        `INSERT INTO security_policy (id, version, document, updated_by, updated_at)
         VALUES (1, $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, document = EXCLUDED.document,
                updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [version, JSON.stringify(document), actor.userId, now],
      );
      await tx.query(
        `INSERT INTO security_policy_versions (version, document, created_by, created_at, via, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [version, JSON.stringify(document), actor.userId, now, actor.via ?? 'console', opts.reason ?? null],
      );
      await this.#record(tx, actor, 'success', {
        fromVersion: before.version,
        toVersion: version,
        preset: after.preset,
        customized: after.customized,
        changed: changed.slice(0, 80),
        // Weakening the safe core is called out on its own (alerting / audit search).
        coreOff: CORE_EVENTS.filter((e) => !after.events[e]),
        ...(opts.reason === undefined ? {} : { reason: opts.reason.slice(0, 500) }),
      });
      return { ...(await this.view(tx)), changed };
    }).catch(async (err: unknown) => {
      if (conflictAt !== null)
        await this.#record(this.deps.pool, actor, 'denied', {
          reason: 'conflict',
          version: conflictAt,
          expectedVersion: opts.expectedVersion ?? null,
        });
      throw err;
    });
    this.invalidate();
    return out;
  }

  /**
   * p15-auto-mode (migration 0126): policy versions written by a migration are audited by the master once
   * (`security.policy.update`, actor system, `via: migration`, with the migration's reason) — the audit log is a hash
   * chain only the master extends. Idempotent: a version is marked `audited_at` in the same transaction. Returns the
   * number of versions audited.
   */
  async auditMigrationVersions(): Promise<number> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ version: number; document: unknown; reason: string | null }>(
        `SELECT version, document, reason FROM security_policy_versions
          WHERE via = 'migration' AND audited_at IS NULL ORDER BY version FOR UPDATE SKIP LOCKED`,
      );
      for (const r of rows) {
        const prev = await tx.query<{ document: unknown }>(
          'SELECT document FROM security_policy_versions WHERE version < $1 ORDER BY version DESC LIMIT 1',
          [r.version],
        );
        const parse = (d: unknown) => {
          const p = SecurityPolicyDocument.safeParse(d);
          return p.success ? effectivePolicy(p.data) : null;
        };
        const after = parse(r.document);
        const before = prev.rows[0] === undefined ? null : parse(prev.rows[0].document);
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'migration' },
            action: 'security.policy.update',
            target: 'security-policy',
            outcome: 'success',
            metadata: {
              via: 'migration',
              toVersion: r.version,
              ...(after === null
                ? { invalid: true }
                : { preset: after.preset, customized: after.customized }),
              ...(after !== null && before !== null
                ? { changed: changedPaths(before, after).slice(0, 80) }
                : {}),
              ...(r.reason === null ? {} : { reason: r.reason.slice(0, 500) }),
            },
          },
          tx,
        );
        await tx.query('UPDATE security_policy_versions SET audited_at = $2 WHERE version = $1', [
          r.version,
          this.#clock(),
        ]);
      }
      return rows.length;
    });
  }

  /**
   * "Apply to existing projects": every project except the Machines project (its auto-approve is part of the machine
   * administration gate, ADR-0021) takes the autonomy defaults for new projects (host execution, auto-approve). The
   * unconfined profile is never switched on here. Audited once with the projects that changed.
   */
  async applyAutonomyToProjects(actor: PolicyActor): Promise<{ readonly updated: readonly string[] }> {
    const p = await this.current();
    const host = p.autonomy.newProjectsHostExecution;
    const auto = p.autonomy.newProjectsAutoApprove;
    const updated = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE projects SET host_execution = $1, auto_approve_execution = $2,
                unconfined_execution = unconfined_execution AND $1
          WHERE id <> 'machines' AND (host_execution <> $1 OR auto_approve_execution <> $2)
          RETURNING id`,
        [host, auto],
      );
      const ids = rows.map((r) => r.id).sort();
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'security.policy.apply_autonomy',
          target: 'security-policy',
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            via: actor.via ?? 'console',
            hostExecution: host,
            autoApprove: auto,
            projects: ids.slice(0, 200),
            count: ids.length,
          },
        },
        tx,
      );
      return ids;
    });
    return { updated };
  }

  async #record(
    tx: Queryable,
    actor: PolicyActor,
    outcome: 'success' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action: 'security.policy.update',
        target: 'security-policy',
        outcome,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { via: actor.via ?? 'console', ...metadata },
      },
      tx,
    );
  }
}

/** The catalog the settings screen renders (events by category, presets, ranges). */
export function policyCatalog(): {
  readonly presets: readonly string[];
  readonly events: readonly {
    readonly id: StepUpEvent;
    readonly category: string;
    readonly core: boolean;
    readonly routes: readonly string[];
    readonly actions: readonly string[];
    readonly presets: Readonly<Record<string, boolean>>;
  }[];
} {
  return {
    presets: SECURITY_PRESETS,
    events: STEP_UP_EVENT_IDS.map((id) => {
      const spec = STEP_UP_EVENTS[id];
      return {
        id,
        category: spec.category,
        core: spec.core,
        routes: spec.routes,
        actions: spec.actions,
        presets: Object.fromEntries(SECURITY_PRESETS.map((p) => [p, PRESETS[p].events[id]])),
      };
    }),
  };
}
