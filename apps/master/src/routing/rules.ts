import {
  type EffectiveRoutingRule,
  effectiveRoutingRule,
  JobRole,
  RuntimeKind,
  type ScopedRoutingRule,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { loadCatalog } from '../models/service.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p6-smart-routing §2 (docs/design/p6-smart-routing.md): routing rules — a job kind's preferred model catalog
 * profile and runtime order, globally (Settings → Models → Routing) or per project (Projects → Policy), stored in
 * `routing_rules` (project '' = global). Changing a rule is an admin action with step-up, audited.
 */

export class RoutingRuleInvalidError extends HttpError {
  constructor(
    readonly issues: readonly { path: string; code: string }[],
    message = 'The routing rule is invalid; see issues.',
  ) {
    super(400, 'routing_rule_invalid', message);
    this.name = 'RoutingRuleInvalidError';
  }
}

interface Row {
  project: string;
  role: string;
  model_profile: string | null;
  runtimes: unknown;
}

function toRule(r: Row): ScopedRoutingRule | null {
  const role = JobRole.safeParse(r.role);
  if (!role.success) return null;
  const runtimes = Array.isArray(r.runtimes)
    ? r.runtimes.filter((x): x is RuntimeKind => RuntimeKind.safeParse(x).success)
    : [];
  return {
    project: r.project === '' ? null : r.project,
    role: role.data,
    modelProfile: r.model_profile,
    runtimes,
  };
}

/** Global rules and those of `project` (all projects when undefined). */
export async function loadRoutingRules(db: Queryable, project?: string): Promise<ScopedRoutingRule[]> {
  const { rows } = await db.query<Row>(
    `SELECT project, role, model_profile, runtimes FROM routing_rules
      WHERE $1::text IS NULL OR project IN ('', $1) ORDER BY project, role`,
    [project ?? null],
  );
  return rows.map(toRule).filter((r): r is ScopedRoutingRule => r !== null);
}

/** The rule in force for a project and kind (project override, else global), or null. */
export async function routingRuleFor(
  db: Queryable,
  project: string,
  role: JobRole | null,
): Promise<EffectiveRoutingRule | null> {
  if (role === null) return null;
  return effectiveRoutingRule(await loadRoutingRules(db, project), project, role);
}

export interface RoutingDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}

export class RoutingService {
  constructor(private readonly deps: RoutingDeps) {}

  list(project?: string): Promise<ScopedRoutingRule[]> {
    return loadRoutingRules(this.deps.pool, project);
  }

  /**
   * Sets (or, with no model profile and no runtimes, clears) the rule of `role` globally (`project: null`) or for a
   * project. The profile must be an enabled catalog profile offered for at least one runtime of the order (when an
   * order is given); runtimes are distinct current runtimes.
   */
  async set(
    input: {
      readonly project: string | null;
      readonly role: JobRole;
      readonly modelProfile: string | null;
      readonly runtimes: readonly RuntimeKind[];
    },
    actor: ActorContext,
  ): Promise<ScopedRoutingRule[]> {
    const project = input.project ?? '';
    const issues: { path: string; code: string }[] = [];
    if (new Set(input.runtimes).size !== input.runtimes.length) {
      issues.push({ path: 'runtimes', code: 'duplicate' });
    }
    await withTransaction(this.deps.pool, async (tx) => {
      if (project !== '') {
        const p = await tx.query('SELECT 1 FROM projects WHERE id = $1', [project]);
        if ((p.rowCount ?? 0) === 0)
          throw new HttpError(404, 'not_found', 'Project not found.', {}, {}, { reason: 'project' });
      }
      if (input.modelProfile !== null) {
        const c = (await loadCatalog(tx)).get(input.modelProfile);
        if (c === undefined) issues.push({ path: 'modelProfile', code: 'unknown_profile' });
        else if (!c.entry.enabled) issues.push({ path: 'modelProfile', code: 'profile_disabled' });
        else if (input.runtimes.length > 0 && !input.runtimes.some((r) => c.entry.runtimes.includes(r))) {
          issues.push({ path: 'modelProfile', code: 'runtime_mismatch' });
        }
      }
      if (issues.length > 0) throw new RoutingRuleInvalidError(issues);
      const clear = input.modelProfile === null && input.runtimes.length === 0;
      if (clear) {
        await tx.query('DELETE FROM routing_rules WHERE project = $1 AND role = $2', [project, input.role]);
      } else {
        await tx.query(
          `INSERT INTO routing_rules (project, role, model_profile, runtimes, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project, role) DO UPDATE SET model_profile = EXCLUDED.model_profile,
             runtimes = EXCLUDED.runtimes, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [
            project,
            input.role,
            input.modelProfile,
            JSON.stringify(input.runtimes),
            this.deps.clock(),
            actor.userId,
          ],
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: clear ? 'routing.rule.clear' : 'routing.rule.set',
          target: `${project === '' ? '*' : project}/${input.role}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { modelProfile: input.modelProfile, runtimes: input.runtimes },
        },
        tx,
      );
    });
    return this.list(input.project ?? undefined);
  }
}
