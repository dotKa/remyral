import type { Role } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';

/**
 * Recipient selection that mirrors the authorization model (docs/design/p5-rbac.md §2): owner/admin are
 * global; operator/viewer reach a project only through a membership, with the lower of membership and
 * account role as their effective role. Disabled accounts never receive notifications.
 */
const RANK_SQL = (expr: string): string =>
  `CASE ${expr} WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'operator' THEN 1 ELSE 0 END`;

const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function maxRole(a: Role, b: Role): Role {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Users whose effective role in `project` is at least `minRole`. */
export async function projectRecipients(db: Queryable, project: string, minRole: Role): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id
       FROM users u
       LEFT JOIN project_memberships m ON m.user_id = u.id AND m.project_id = $1
      WHERE u.disabled_at IS NULL AND u.kind = 'human'
        AND (
          (u.role IN ('owner', 'admin') AND ${RANK_SQL('u.role')} >= $2)
          OR (u.role IN ('operator', 'viewer') AND m.role IS NOT NULL
              AND LEAST(${RANK_SQL('u.role')}, ${RANK_SQL('m.role')}) >= $2)
        )
      ORDER BY u.id`,
    [project, RANK[minRole]],
  );
  return rows.map((r) => r.id);
}

/** Users whose account role is global (owner/admin) and at least `minRole`. */
export async function globalRecipients(db: Queryable, minRole: Role = 'admin'): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM users
      WHERE disabled_at IS NULL AND kind = 'human' AND role IN ('owner', 'admin') AND ${RANK_SQL('role')} >= $1
      ORDER BY id`,
    [RANK[minRole]],
  );
  return rows.map((r) => r.id);
}
