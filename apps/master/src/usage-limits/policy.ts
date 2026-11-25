import { USAGE_LIMIT_DEFAULT_POLICY, UsageLimitPolicy } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';

/**
 * p11-usage-limit-fallback (docs/design/p11-usage-limit-fallback.md §3): the usage-limit policy — a workspace default
 * (`usage_limit_defaults`, singleton) and an optional per-project override (`projects.usage_limit_policy`, NULL =
 * inherit). Both are validated with the protocol's `UsageLimitPolicy` on write and on read (a stored value that no
 * longer parses falls back to the platform default, never to something more permissive).
 */

export class UsageLimitPolicyError extends Error {
  override name = 'UsageLimitPolicyError';
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EffectivePolicy {
  readonly policy: UsageLimitPolicy;
  /** `project`: the project's own policy; `default`: the workspace default applies. */
  readonly source: 'project' | 'default';
}

export interface PolicyActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

function parse(raw: unknown): UsageLimitPolicy | null {
  const r = UsageLimitPolicy.safeParse(raw);
  return r.success ? r.data : null;
}

/** The workspace default (the platform default when the stored row does not parse). */
export async function loadDefaultPolicy(db: Queryable): Promise<{
  readonly policy: UsageLimitPolicy;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}> {
  const { rows } = await db.query<{ policy: unknown; updated_at: Date; updated_by: string | null }>(
    'SELECT policy, updated_at, updated_by::text AS updated_by FROM usage_limit_defaults WHERE id = 1',
  );
  const r = rows[0];
  return {
    policy: (r === undefined ? null : parse(r.policy)) ?? USAGE_LIMIT_DEFAULT_POLICY,
    updatedAt: r?.updated_at ?? null,
    updatedBy: r?.updated_by ?? null,
  };
}

/** The project's own policy (null = inherits), or undefined when the project does not exist. */
export async function loadProjectPolicy(
  db: Queryable,
  project: string,
): Promise<
  | {
      readonly policy: UsageLimitPolicy | null;
      readonly updatedAt: Date | null;
      readonly updatedBy: string | null;
    }
  | undefined
> {
  const { rows } = await db.query<{
    usage_limit_policy: unknown;
    usage_limit_updated_at: Date | null;
    updated_by: string | null;
  }>(
    `SELECT usage_limit_policy, usage_limit_updated_at, usage_limit_updated_by::text AS updated_by
       FROM projects WHERE id = $1`,
    [project],
  );
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    policy: r.usage_limit_policy === null ? null : parse(r.usage_limit_policy),
    updatedAt: r.usage_limit_updated_at,
    updatedBy: r.updated_by,
  };
}

/** The policy in force for a project: its own, else the workspace default. */
export async function effectivePolicy(db: Queryable, project: string): Promise<EffectivePolicy> {
  const own = await loadProjectPolicy(db, project);
  if (own?.policy !== null && own?.policy !== undefined) return { policy: own.policy, source: 'project' };
  return { policy: (await loadDefaultPolicy(db)).policy, source: 'default' };
}

function validated(input: unknown): UsageLimitPolicy {
  const r = UsageLimitPolicy.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new UsageLimitPolicyError(
      400,
      'invalid_policy',
      `Invalid usage-limit policy${first === undefined ? '' : ` at ${first.path.join('.') || 'policy'}: ${first.message}`}.`,
    );
  }
  return r.data;
}

/** Replaces the workspace default (admin + step-up at the route); audited with before / after. */
export async function saveDefaultPolicy(
  pool: Pool,
  audit: AuditRecorder,
  input: unknown,
  actor: PolicyActor,
  now: Date,
): Promise<UsageLimitPolicy> {
  const policy = validated(input);
  return withTransaction(pool, async (tx) => {
    const before = await loadDefaultPolicy(tx);
    await tx.query(
      `INSERT INTO usage_limit_defaults (id, policy, updated_by, updated_at) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy, updated_by = EXCLUDED.updated_by,
                                      updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(policy), actor.userId, now],
    );
    await audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action: 'usage_limit.defaults.update',
        target: 'usage-limit:defaults',
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { before: before.policy, after: policy },
      },
      tx,
    );
    return policy;
  });
}

/** Sets (or, with null, clears) a project's own policy (project admin + step-up at the route); audited. */
export async function saveProjectPolicy(
  pool: Pool,
  audit: AuditRecorder,
  project: string,
  input: unknown,
  actor: PolicyActor,
  now: Date,
): Promise<UsageLimitPolicy | null> {
  const policy = input === null ? null : validated(input);
  return withTransaction(pool, async (tx) => {
    const before = await loadProjectPolicy(tx, project);
    if (before === undefined) throw new UsageLimitPolicyError(404, 'project_not_found', 'Project not found.');
    await tx.query(
      `UPDATE projects SET usage_limit_policy = $2, usage_limit_updated_by = $3, usage_limit_updated_at = $4
        WHERE id = $1`,
      [project, policy === null ? null : JSON.stringify(policy), actor.userId, now],
    );
    await audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action: 'project.usage_limit.update',
        target: `project:${project}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { before: before.policy, after: policy },
      },
      tx,
    );
    return policy;
  });
}
