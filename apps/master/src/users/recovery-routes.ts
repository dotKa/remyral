import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { RECOVERY_ACTIONS, type RecoveryActor, type UserRecoveryService } from './recovery.js';

/**
 * p17-panel-settings Part 4 (docs/design/p17-panel-settings.md §6): account recovery from Ayarlar → Kullanıcılar.
 *
 * - `POST /users/:id/recover` (`users.recover`: owners; admins for operators / viewers; always-fresh step-up):
 *   `reset-mfa` / `reset-password` / `unlock`. Applied at once (a reset password comes back **once**) or, for another
 *   owner while a third owner exists, a waiting request a second owner approves.
 * - `GET /users/recovery-requests` (`users.recover`): the waiting requests.
 * - `POST /users/recovery-requests/:id/approve` | `/cancel` (owners; approve: always-fresh step-up).
 */
const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};
const Outcome = z.object({
  status: z.enum(['applied', 'pending']),
  temporaryPassword: z.string().nullable(),
  revokedSessions: z.number().nullable(),
  requestId: z.string().nullable(),
});
const tags = ['users'];

function actor(request: FastifyRequest): RecoveryActor {
  const a = actorOf(request);
  return { userId: a.userId, role: authzOf(request).subject.role, ip: a.ip, userAgent: a.userAgent };
}

export function recoveryRoutes(deps: { readonly service: UserRecoveryService; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const fresh = requireStepUp('always-fresh', deps.clock);
    const view = (o: Awaited<ReturnType<UserRecoveryService['recover']>>) =>
      o.status === 'applied'
        ? {
            status: 'applied' as const,
            temporaryPassword: o.temporaryPassword,
            revokedSessions: o.revokedSessions,
            requestId: null,
          }
        : {
            status: 'pending' as const,
            temporaryPassword: null,
            revokedSessions: null,
            requestId: o.requestId,
          };

    r.post(
      '/users/:id/recover',
      {
        config: { authz: { action: 'users.recover' as const } },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            "Recover another user's account: reset the authenticator or the password (a one-time password returned once), or unlock it — audited, the user is notified; another owner needs a second owner's approval",
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({ action: z.enum(RECOVERY_ACTIONS), reason: z.string().max(300).optional() }),
          response: { 200: Outcome, ...errors },
        },
      },
      async (request) =>
        view(
          await deps.service.recover(actor(request), request.params.id, {
            action: request.body.action,
            ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
          }),
        ),
    );

    r.get(
      '/users/recovery-requests',
      {
        config: { authz: { action: 'users.recover' as const } },
        schema: {
          tags,
          summary: 'Account recoveries waiting for a second owner’s approval',
          security: [{ session: [] }],
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  action: z.enum(RECOVERY_ACTIONS),
                  target: z.object({ id: z.string(), username: z.string() }),
                  requestedBy: z.string().nullable(),
                  reason: z.string(),
                  requestedAt: z.string(),
                  expiresAt: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async () => ({ items: (await deps.service.pending()).map((i) => ({ ...i, target: { ...i.target } })) }),
    );

    r.post(
      '/users/recovery-requests/:id/approve',
      {
        config: { authz: { action: 'users.recover' as const } },
        preHandler: fresh,
        schema: {
          tags,
          summary: 'Approve a waiting account recovery as a second owner (it applies now)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: Outcome, ...errors },
        },
      },
      async (request) => view(await deps.service.approve(actor(request), request.params.id)),
    );

    r.post(
      '/users/recovery-requests/:id/cancel',
      {
        config: { authz: { action: 'users.recover' as const } },
        schema: {
          tags,
          summary: 'Withdraw a waiting account recovery (owners)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ ok: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        await deps.service.cancel(actor(request), request.params.id);
        return { ok: true };
      },
    );
  };
}
