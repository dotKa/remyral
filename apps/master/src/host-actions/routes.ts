import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { actorOf } from '../workers/routes.js';
import {
  HostActionError,
  type HostActionService,
  type HostActionsStatus,
  type HostActionView,
} from './service.js';

/**
 * p17-host-actions (docs/design/p17-host-actions.md): control-plane update and rollback from the console, carried out
 * by the remyral-ctl host applier (never by the master).
 *
 * - `GET /host-actions` (`host.actions.read`, owners): the applier (or its absence), the open request, recent ones.
 * - `GET /host-actions/requests/:id`: one request with the host's live step and output tail (the console polls it, also
 *   across the master's restart during an upgrade).
 * - `POST /host-actions/upgrade`, `POST /host-actions/rollback`, `POST /host-actions/requests/:id/cancel`
 *   (`host.update`, owners, always-fresh step-up, audited).
 */
const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  503: ErrorBody,
};
const tags = ['host-actions'];
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];

export const HostActionBody = z.object({
  id: z.string(),
  kind: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])),
  state: z.enum([
    'pending',
    'applying',
    'applied',
    'scheduled',
    'rolled_back',
    'held',
    'failed',
    'refused',
    'expired',
    'cancelled',
  ]),
  step: z.string().nullable(),
  detail: z.string().nullable(),
  log: z.array(z.string()),
  requestedAt: z.string(),
  expiresAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const ApplierBody = z.object({
  managed: z.boolean(),
  lastSeen: z.string().nullable(),
  version: z.string().nullable(),
  kinds: z.array(z.string()),
  current: z.string().nullable(),
  previous: z.string().nullable(),
  releases: z.array(z.string()),
});

export const HostActionsBody = z.object({
  applier: ApplierBody,
  open: HostActionBody.nullable(),
  recent: z.array(HostActionBody),
});

/** One literal site per code (the console's error catalog is checked against them, scripts/i18n). */
export function failHostAction(err: unknown): never {
  if (!(err instanceof HostActionError)) throw err;
  const m = err.message;
  switch (err.code) {
    case 'host_applier_unavailable':
      throw new HttpError(503, 'host_applier_unavailable', m);
    case 'host_applier_outdated':
      throw new HttpError(409, 'host_applier_outdated', m);
    case 'host_request_in_progress':
      throw new HttpError(409, 'host_request_in_progress', m);
    case 'host_request_not_found':
      throw new HttpError(404, 'host_request_not_found', m);
    case 'no_pending_host_request':
      throw new HttpError(409, 'no_pending_host_request', m);
    case 'invalid_release_version':
      throw new HttpError(400, 'invalid_release_version', m);
    case 'release_not_in_feed':
      throw new HttpError(409, 'release_not_in_feed', m);
    case 'breaking_not_accepted':
      throw new HttpError(409, 'breaking_not_accepted', m);
    case 'release_not_on_host':
      throw new HttpError(409, 'release_not_on_host', m);
    case 'invalid_backup_id':
      throw new HttpError(400, 'invalid_backup_id', m);
    case 'restore_confirmation_required':
      throw new HttpError(400, 'restore_confirmation_required', m);
  }
}

export const copyAction = (v: HostActionView) => ({ ...v, params: { ...v.params }, log: [...v.log] });
export const copyStatus = (s: HostActionsStatus) => ({
  applier: { ...s.applier, kinds: [...s.applier.kinds], releases: [...s.applier.releases] },
  open: s.open === null ? null : copyAction(s.open),
  recent: s.recent.map(copyAction),
});

export function hostActionRoutes(deps: { readonly service: HostActionService; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const read = { authz: { action: 'host.actions.read' as const } };
    const write = { authz: { action: 'host.update' as const } };
    const fresh = requireStepUp('always-fresh', deps.clock);
    const Id = z.object({ id: z.uuid() });

    r.get(
      '/host-actions',
      {
        config: read,
        schema: {
          tags,
          summary:
            'The remyral-ctl host applier (or its absence), the open request and the recent update / rollback requests',
          security: session,
          response: { 200: HostActionsBody, ...errors },
        },
      },
      async () => copyStatus(await deps.service.status(['upgrade', 'rollback'])),
    );

    r.get(
      '/host-actions/requests/:id',
      {
        config: read,
        schema: {
          tags,
          summary: "One host request with the host's current step and output tail",
          security: session,
          params: Id,
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) => copyAction(await deps.service.get(request.params.id).catch(failHostAction)),
    );

    r.post(
      '/host-actions/upgrade',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Upgrade the control plane to a newer release of the verified feed — a signed request the host applier runs (owners; always-fresh step-up; audited)',
          security: csrf,
          body: z.strictObject({ version: z.string().max(64), acceptBreaking: z.boolean().default(false) }),
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) =>
        copyAction(
          await deps.service
            .upgrade(actorOf(request), {
              version: request.body.version,
              acceptBreaking: request.body.acceptBreaking,
            })
            .catch(failHostAction),
        ),
    );

    r.post(
      '/host-actions/rollback',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Roll the control plane back to a release kept on the host, optionally restoring a backup first (destructive: the backup id typed again) — owners; always-fresh step-up; audited',
          security: csrf,
          body: z.strictObject({
            version: z.string().max(64),
            backupId: z.string().max(80).nullable().optional(),
            restoreDatabase: z.boolean().optional(),
            confirm: z.string().max(80).optional(),
          }),
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        return copyAction(
          await deps.service
            .rollback(actorOf(request), {
              version: b.version,
              ...(b.backupId === undefined ? {} : { backupId: b.backupId }),
              ...(b.restoreDatabase === undefined ? {} : { restoreDatabase: b.restoreDatabase }),
              ...(b.confirm === undefined ? {} : { confirm: b.confirm }),
            })
            .catch(failHostAction),
        );
      },
    );

    r.post(
      '/host-actions/requests/:id/cancel',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary: 'Withdraw a host request the host has not picked up yet',
          security: csrf,
          params: Id,
          response: { 200: HostActionBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.cancel(actorOf(request), request.params.id).catch(failHostAction);
        return copyAction(await deps.service.get(request.params.id).catch(failHostAction));
      },
    );
  };
}
