import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import { SecurityPolicyPatch } from './model.js';
import { policyCatalog, type SecurityPolicyService } from './service.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};

const Json = z.record(z.string(), z.unknown());

const ViewBody = z.object({
  version: z.number().int(),
  document: Json,
  effective: Json,
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  catalog: Json,
});

/**
 * p15-autonomy (ADR-0056): Ayarlar → Güvenlik. Read: admin+; change and "apply to existing projects": admin+, CSRF,
 * step-up hook whose event is `security.policy` (asks for a code only while the policy keeps that event protected —
 * the safe core, on by default), audited `security.policy.update` / `security.policy.apply_autonomy`.
 */
export function securityPolicyRoutes(service: SecurityPolicyService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['security'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const catalog = policyCatalog() as unknown as Record<string, unknown>;

    r.get(
      '/security/policy',
      {
        config: { authz: { action: 'security.read' } },
        schema: {
          tags,
          summary:
            'The security policy: preset (Serbest / Dengeli / Sıkı), its overrides, the effective values (step-up window, per-event authenticator codes, agent autonomy defaults) and the event catalog',
          security: session,
          response: { 200: ViewBody, ...errors },
        },
      },
      async () => {
        const v = await service.view();
        return {
          version: v.version,
          document: v.document as unknown as Record<string, unknown>,
          effective: v.effective as unknown as Record<string, unknown>,
          updatedAt: v.updatedAt,
          updatedBy: v.updatedBy,
          catalog,
        };
      },
    );

    r.put(
      '/security/policy',
      {
        config: {
          authz: {
            action: 'security.write',
            auditDenied: { action: 'security.policy.update', target: () => 'security-policy' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change the security policy: a preset (resets the overrides unless resetOverrides is false) and/or single values. expectedVersion refuses a change based on an older view (409). Audited with the changed paths.',
          security: csrf,
          body: SecurityPolicyPatch.extend({
            expectedVersion: z.number().int().min(0).optional(),
            reason: z.string().max(500).optional(),
          }),
          response: { 200: ViewBody.extend({ changed: z.array(z.string()) }), ...errors },
        },
      },
      async (request) => {
        const { expectedVersion, reason, ...patch } = request.body;
        const a = actorOf(request);
        const v = await service.update(
          { userId: a.userId, ip: a.ip, userAgent: a.userAgent, via: 'console' },
          patch,
          {
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            ...(reason === undefined ? {} : { reason }),
          },
        );
        return {
          version: v.version,
          document: v.document as unknown as Record<string, unknown>,
          effective: v.effective as unknown as Record<string, unknown>,
          updatedAt: v.updatedAt,
          updatedBy: v.updatedBy,
          catalog,
          changed: [...v.changed],
        };
      },
    );

    r.post(
      '/security/policy/apply-autonomy',
      {
        config: {
          authz: {
            action: 'security.write',
            auditDenied: { action: 'security.policy.apply_autonomy', target: () => 'security-policy' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Give every existing project (except Machines) the autonomy defaults of new projects: host execution and auto-approve as the policy says (unconfined is never switched on). Audited.',
          security: csrf,
          response: {
            200: z.object({ updated: z.array(z.string()), count: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const a = actorOf(request);
        const out = await service.applyAutonomyToProjects({
          userId: a.userId,
          ip: a.ip,
          userAgent: a.userAgent,
          via: 'console',
        });
        return { updated: [...out.updated], count: out.updated.length };
      },
    );
  };
}
