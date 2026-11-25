import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { ReleaseChannel } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { visibleProjects } from '../authz/model.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { RolloutBreaker } from '../releases/breaker.js';
import { actorOf } from '../workers/routes.js';
import { type CostBrakeService, type CostBrakeState, MAX_LIFT_HOURS } from './cost-brake.js';
import type { ExpiryService } from './expiry.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};
const Json = z.record(z.string(), z.unknown());
const ItemId = z.string().regex(/^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}$/);
const ProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Usd = z.number().min(0.01).max(10_000_000).nullable();

function ownerOnly(request: FastifyRequest): void {
  if (authzOf(request).subject.role !== 'owner') {
    throw new HttpError(403, 'owner_required', 'Only an owner can do this.');
  }
}

/** The brake as the caller may see it: global ceilings, and project ceilings of projects they can see. */
function visibleBrake(state: CostBrakeState, request: FastifyRequest): CostBrakeState {
  const projects = visibleProjects(authzOf(request).subject);
  if (projects === null) return state;
  const ok = (scope: string) => scope === 'global' || projects.includes(scope);
  return {
    ...state,
    ceilings: state.ceilings.filter((c) => ok(c.scope)),
    engaged: state.engaged.filter((c) => ok(c.scope)),
    lifts: state.lifts.filter((l) => ok(l.scope)),
  };
}

/**
 * p16-ops-safety (docs/design/p16-ops-safety.md §5): Ayarlar → Operasyon güvenliği and the rollout breaker buttons.
 *
 * - Keys and expiry: read `security.read` (admin+); "check now" and "rotated at" stamps `security.write` (admin+,
 *   CSRF, audited; a date only, so no authenticator code); a vault credential's expiry date `vault.write`.
 * - Cost brake: state `quotas.read` (every role: the banner); lift / end a lift / project ceilings `quotas.write` and
 *   the owner role, with the step-up rule of the `limits.budgets` event, audited.
 * - Rollout breaker: state `releases.read`; pause / resume / roll back `releases.publish` with step-up (event
 *   `releases.publish`), audited.
 */
export function opsSafetyRoutes(deps: {
  readonly expiry: ExpiryService;
  readonly brake: CostBrakeService;
  readonly breaker: () => RolloutBreaker | null;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, deps.clock);
    const breaker = (): RolloutBreaker => {
      const b = deps.breaker();
      if (b === null) throw new HttpError(404, 'not_found', 'Not found.');
      return b;
    };

    // ---------------------------------------------------------------------------------------------- expiry

    r.get(
      '/ops-safety/expiry',
      {
        config: { authz: { action: 'security.read' } },
        schema: {
          tags: ['ops-safety'],
          summary:
            'Keys and expiry: every credential, key and certificate the master tracks — expiry or rotation due date, age, last rotation stamp, state (admin+)',
          security: session,
          response: { 200: Json, ...errors },
        },
      },
      async () => deps.expiry.list(),
    );

    r.post(
      '/ops-safety/expiry/check',
      {
        config: { authz: { action: 'security.write' } },
        schema: {
          tags: ['ops-safety'],
          summary:
            'Run the outside checks now (Cloudflare token verify, the served TLS certificate of the public origin) and return the list (admin+)',
          security: csrf,
          response: { 200: Json, ...errors },
        },
      },
      async () => {
        await deps.expiry.refresh(true);
        return deps.expiry.list();
      },
    );

    r.post(
      '/ops-safety/expiry/:item/rotated',
      {
        config: { authz: { action: 'security.write' } },
        schema: {
          tags: ['ops-safety'],
          summary:
            'Record that an item was rotated (after its runbook): starts its age and due date over; audited secret.rotation.recorded (admin+)',
          security: csrf,
          params: z.object({ item: ItemId }),
          body: z
            .object({
              rotatedAt: z.iso.datetime({ offset: true }).optional(),
              note: z.string().max(300).optional(),
            })
            .strict()
            .optional(),
          response: { 200: z.object({ item: z.string(), rotatedAt: z.string() }), ...errors },
        },
      },
      async (request) => {
        const a = actorOf(request);
        const b = request.body ?? {};
        return deps.expiry.recordRotation(
          { userId: a.userId, ip: a.ip, userAgent: a.userAgent, source: 'console' },
          request.params.item,
          {
            ...(b.rotatedAt === undefined ? {} : { rotatedAt: new Date(b.rotatedAt) }),
            ...(b.note === undefined ? {} : { note: b.note }),
          },
        );
      },
    );

    r.put(
      '/ops-safety/vault/:id/expiry',
      {
        config: { authz: { action: 'vault.write' } },
        schema: {
          tags: ['ops-safety'],
          summary:
            "Record (or clear) a vault credential's expiry date at its provider — metadata only, for the expiry reminders (admin+)",
          security: csrf,
          params: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/) }),
          body: z.object({ expiresAt: z.iso.datetime({ offset: true }).nullable() }).strict(),
          response: { 200: z.object({ id: z.string(), expiresAt: z.string().nullable() }), ...errors },
        },
      },
      async (request) => {
        const a = actorOf(request);
        return deps.expiry.setVaultExpiry(
          { userId: a.userId, ip: a.ip, userAgent: a.userAgent },
          request.params.id,
          request.body.expiresAt === null ? null : new Date(request.body.expiresAt),
        );
      },
    );

    // ---------------------------------------------------------------------------------------------- cost brake

    r.get(
      '/cost-brake',
      {
        config: { authz: { action: 'quotas.read' } },
        schema: {
          tags: ['ops-safety'],
          summary:
            'The model cost brake: mode (warn / block), ceilings with spend this UTC day / month, what is engaged and the active lifts (every role; project ceilings of visible projects)',
          security: session,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => {
        const state = visibleBrake(await deps.brake.current(), request);
        const role = authzOf(request).subject.role;
        const projects = role === 'owner' || role === 'admin' ? await deps.brake.projectCeilings() : [];
        return { ...state, projects };
      },
    );

    r.post(
      '/cost-brake/lifts',
      {
        config: { authz: { action: 'quotas.write' } },
        preHandler: stepUp,
        schema: {
          tags: ['ops-safety'],
          summary: `Lift the cost brake for 1–${String(MAX_LIFT_HOURS)} hours, for everything (scope global) or one project (owners; step-up by policy; audited cost.brake.lift)`,
          security: csrf,
          body: z
            .object({
              scope: z.union([z.literal('global'), ProjectId]),
              hours: z.number().int().min(1).max(MAX_LIFT_HOURS),
              reason: z.string().min(1).max(300),
            })
            .strict(),
          response: { 200: Json, ...errors },
        },
      },
      async (request) => {
        ownerOnly(request);
        const a = actorOf(request);
        return {
          ...(await deps.brake.lift({ userId: a.userId, ip: a.ip, userAgent: a.userAgent }, request.body)),
        };
      },
    );

    r.delete(
      '/cost-brake/lifts/:id',
      {
        config: { authz: { action: 'quotas.write' } },
        preHandler: stepUp,
        schema: {
          tags: ['ops-safety'],
          summary: 'End a lift of the cost brake early (owners; audited)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        ownerOnly(request);
        const a = actorOf(request);
        await deps.brake.endLift({ userId: a.userId, ip: a.ip, userAgent: a.userAgent }, request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.put(
      '/cost-brake/projects/:project',
      {
        config: { authz: { action: 'quotas.write' } },
        preHandler: stepUp,
        schema: {
          tags: ['ops-safety'],
          summary:
            "Set a project's daily / monthly model spend ceilings in dollars (both null: remove them; owners; audited)",
          security: csrf,
          params: z.object({ project: ProjectId }),
          body: z.object({ dailyUsd: Usd, monthlyUsd: Usd }).strict(),
          response: { 200: z.object({ ceiling: Json.nullable() }), ...errors },
        },
      },
      async (request) => {
        ownerOnly(request);
        const a = actorOf(request);
        const c = await deps.brake.setProjectCeiling(
          { userId: a.userId, ip: a.ip, userAgent: a.userAgent },
          request.params.project,
          request.body,
        );
        return { ceiling: c as unknown as Record<string, unknown> | null };
      },
    );

    // ---------------------------------------------------------------------------------------------- breaker

    r.get(
      '/releases/breaker',
      {
        config: { authz: { action: 'releases.read' } },
        schema: {
          tags: ['releases'],
          summary:
            'The rollout circuit breaker: per channel the machines that took its version and how they fare, the job failure rates, an open hold and its evidence, recent holds',
          security: session,
          response: { 200: Json, ...errors },
        },
      },
      async () => breaker().status(),
    );

    for (const action of ['pause', 'resume', 'rollback'] as const) {
      r.post(
        `/releases/channels/:channel/${action}`,
        {
          config: { authz: { action: 'releases.publish' } },
          preHandler: stepUp,
          schema: {
            tags: ['releases'],
            summary:
              action === 'pause'
                ? 'Hold a channel rollout by hand: no further machine is offered its version (step-up; audited)'
                : action === 'resume'
                  ? 'Resume a held rollout: offers continue; the failures so far are not counted again (step-up; audited)'
                  : 'Roll a held rollout back: the channel points at the previous version and every machine on the held version gets a rollback target (step-up; audited)',
            security: csrf,
            params: z.object({ channel: ReleaseChannel }),
            response: { 200: Json, ...errors },
          },
        },
        async (request) => {
          const a = actorOf(request);
          const b = breaker();
          const ch = request.params.channel;
          if (action === 'pause') return { hold: await b.pause(a, ch) };
          if (action === 'resume') return { hold: await b.resume(a, ch) };
          return b.rollback(a, ch);
        },
      );
    }
  };
}
