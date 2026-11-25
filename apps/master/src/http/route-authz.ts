import type { FastifyRequest } from 'fastify';
import type { Action, Resource, Role, Subject } from '../authz/model.js';
import { HttpError } from './errors.js';

/**
 * Per-route authorization declaration (docs/design/p5-rbac.md §3), in the route's `config.authz`:
 *
 * ```ts
 * r.post('/jobs/:id/cancel', {
 *   config: { authz: { action: 'jobs.cancel', resource: (req) => jobResource(db, req) } },
 *   ...
 * })
 * ```
 *
 * Every route that needs a full session must declare one; a route without a declaration is refused with
 * 403 at runtime (deny by default) and fails the route-coverage test. Routes reachable before a full
 * session (`config.auth` public / mfa_pending / enrollment) have no subject and are listed in the
 * coverage test's explicit allowlist instead.
 *
 * The rule is evaluated in a global `preValidation` hook — after authentication, **before** schema
 * validation (so an unauthorized caller cannot probe input validation) and before route `preHandler`s such
 * as `requireStepUp`. `resource` therefore sees *unvalidated* params/query/body and must treat them as
 * untrusted (type-check, parameterised SQL only).
 */
export interface AuthzRule {
  readonly action: Action;
  /**
   * Resolves the resource's attributes from the request. Return `undefined` when the request does not
   * address a single resource (collections, creation without a project), or `null` when the addressed
   * resource does not exist (the handler then answers its own 404).
   */
  readonly resource?: (
    request: FastifyRequest,
  ) => Resource | null | undefined | Promise<Resource | null | undefined>;
  /** The 404 used when the resource is in a project the subject cannot see (default: generic 404). */
  readonly notFound?: () => HttpError;
  /** Record refusals in the audit log under this action (privileged reads and exports). */
  readonly auditDenied?: {
    readonly action: string;
    readonly target?: (request: FastifyRequest) => string | null;
  };
}

/** The decision, available to handlers as `request.authz` after the hook allowed the request. */
export interface AuthzContext {
  readonly subject: Subject;
  readonly action: Action;
  readonly resource: Resource | null;
  /** Effective role for this request: the project role when the resource names a project, else the account role. */
  readonly role: Role;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    authz?: AuthzRule;
  }
  interface FastifyRequest {
    /** Set by the authorization hook on every allowed full-session route; null elsewhere. */
    authz: AuthzContext | null;
  }
}

export interface Authorizer {
  /** Called for every routed request that needs a full session. Throws an HttpError to refuse. */
  authorize(request: FastifyRequest, rule: AuthzRule | undefined): Promise<void>;
}

export function forbidden(): HttpError {
  return new HttpError(403, 'forbidden', 'Your role does not allow this.', {}, {}, { reason: 'role' });
}

/** Used until an authorizer is wired in: every full-session route is refused. */
export const denyAllAuthorizer: Authorizer = {
  authorize() {
    return Promise.reject(forbidden());
  },
};

/** The authorization decision for this request; throws if the hook did not run (programming error). */
export function authzOf(request: FastifyRequest): AuthzContext {
  const a = request.authz;
  if (!a) throw forbidden();
  return a;
}
