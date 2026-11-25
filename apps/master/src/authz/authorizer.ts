import type { FastifyRequest } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { unauthorized } from '../http/route-auth.js';
import { type Authorizer, type AuthzRule, forbidden } from '../http/route-authz.js';
import { authorize, type ProjectRole, type Resource, type Subject } from './model.js';

/** Loads the subject (account role + memberships) for the session's user. One query per request. */
export async function loadSubject(
  db: Queryable,
  user: { id: string; role: Subject['role'] },
): Promise<Subject> {
  const { rows } = await db.query<{ project_id: string; role: ProjectRole }>(
    'SELECT project_id, role FROM project_memberships WHERE user_id = $1',
    [user.id],
  );
  return { userId: user.id, role: user.role, memberships: new Map(rows.map((r) => [r.project_id, r.role])) };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function genericNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'Not found.');
}

/**
 * The enforcement point (PEP) for the decision function in model.ts. Runs from the global preValidation
 * hook in app.ts for every full-session route:
 *
 * - no declaration → 403 and an error log (deny by default; the route-coverage test fails too);
 * - account role below the action's minimum → 403 (`forbidden`), audited when the rule asks for it;
 * - resource in a project the caller cannot see → 404 (indistinguishable from a missing resource);
 * - project role below the minimum → 403.
 */
export function createAuthorizer(deps: { db: Queryable; audit: AuditRecorder }): Authorizer {
  return {
    async authorize(request: FastifyRequest, rule: AuthzRule | undefined) {
      const session = request.auth?.session;
      if (!session) throw unauthorized(); // unreachable: the authentication hook ran first
      if (!rule) {
        request.log.error(
          { route: `${request.method} ${request.routeOptions.url ?? ''}` },
          'route has no authorization declaration; refused',
        );
        throw forbidden();
      }
      const subject = await loadSubject(deps.db, session.user);
      const deny = async (reason: string, err: HttpError): Promise<never> => {
        // Refusals are audited for declared privileged reads and for every state-changing request.
        const audited =
          rule.auditDenied ??
          (SAFE_METHODS.has(request.method)
            ? undefined
            : {
                action: 'authz.denied',
                target: () => `${request.method} ${request.routeOptions.url ?? ''}`,
              });
        if (audited) {
          await deps.audit.record({
            actor: { type: 'user', id: subject.userId },
            action: audited.action,
            target: audited.target?.(request) ?? null,
            outcome: 'denied',
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            metadata: { reason, role: subject.role, authz: rule.action },
          });
        }
        throw err;
      };

      // Resource-independent check first: never reveals whether the addressed resource exists.
      const ceiling = authorize(subject, rule.action, { ownerId: subject.userId });
      if (!ceiling.allow) await deny(ceiling.reason, forbidden());

      let resource: Resource | null = null;
      let role = subject.role;
      if (rule.resource) {
        const found = await rule.resource(request);
        if (found) {
          const decision = authorize(subject, rule.action, found);
          if (!decision.allow) {
            await deny(
              decision.reason,
              decision.reason === 'not_visible' ? (rule.notFound ?? genericNotFound)() : forbidden(),
            );
          } else {
            resource = found;
            role = decision.role;
          }
        }
      }
      request.authz = { subject, action: rule.action, resource, role };
    },
  };
}
