import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  exampleEnvelope,
  GLOBAL_EVENT_TYPES,
  SUBSCRIBABLE_EVENT_TYPES,
  WEBHOOK_CATALOG_VERSION,
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADERS,
} from '@remyral/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { authzOf } from '../http/route-authz.js';
import {
  type AttemptView,
  DELIVERY_STATUSES,
  type DeliveryView,
  SUBSCRIPTION_STATES,
  type SubscriptionView,
  type WebhookActor,
  type WebhookService,
} from './service.js';
import { MAX_HEADERS } from './targets.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** p16-webhooks-out: outgoing webhooks (tests drive runOnce() / consume() / deliverDue()). */
    readonly webhooksOut: WebhookService;
  }
}

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  422: ErrorBodySchema,
};

const Iso = z.string();
const Uuid = z.uuid();
const ProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const HeaderBody = z.object({
  name: z.string(),
  value: z.string().nullable().describe('Plain values only; a secret header’s value is never returned.'),
  secret: z.boolean(),
  hint: z.string().nullable(),
});

export const SubscriptionBody = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  project: z.string().nullable().describe('null: every project and the global events.'),
  eventTypes: z.array(z.string()),
  includeDetails: z.boolean(),
  headers: z.array(HeaderBody),
  secretHint: z.string().describe('Prefix and last characters, never the secret.'),
  secretCreatedAt: Iso,
  secretRevealed: z.boolean(),
  previousValidUntil: Iso.nullable().describe('The previous secret still signs (a second v1) until then.'),
  state: z.enum(SUBSCRIPTION_STATES),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastSuccessAt: Iso.nullable(),
  lastFailureAt: Iso.nullable(),
  createdAt: Iso,
  createdBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  updatedAt: Iso,
  stats: z.object({ pending: z.number().int(), succeeded24h: z.number().int(), failed24h: z.number().int() }),
});

const DeliveryBody = z.object({
  id: z.string().describe('Sent as X-Remyral-Delivery (the receiver’s idempotency key).'),
  subscriptionId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  project: z.string().nullable(),
  status: z.enum(DELIVERY_STATUSES),
  test: z.boolean(),
  attempts: z.number().int(),
  nextAttemptAt: Iso.nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastLatencyMs: z.number().int().nullable(),
  lastAttemptAt: Iso.nullable(),
  createdAt: Iso,
  finishedAt: Iso.nullable(),
});

const AttemptBody = z.object({
  attempt: z.number().int(),
  startedAt: Iso,
  latencyMs: z.number().int().nullable(),
  statusCode: z.number().int().nullable(),
  error: z.string().nullable(),
  responseExcerpt: z.string().nullable().describe('At most 1 KiB of the response, redacted.'),
});

const HeaderInput = z.strictObject({
  name: z.string().min(1).max(64),
  value: z.string().max(1000).optional(),
  secret: z.boolean().optional(),
  keep: z.boolean().optional().describe('Keep the stored value of this secret header (send no value).'),
});

const SubscriptionInput = z.strictObject({
  name: z.string().min(1).max(80),
  url: z.string().min(9).max(2000),
  project: ProjectId.nullable().optional(),
  eventTypes: z.array(z.string().max(64)).min(1).max(64),
  includeDetails: z.boolean().optional(),
  headers: z.array(HeaderInput).max(MAX_HEADERS).optional(),
});

const SettingsBody = z.object({
  internalOrigins: z.array(z.string()),
  updatedAt: Iso.nullable(),
  updatedBy: z.object({ id: z.string(), username: z.string() }).nullable(),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function subscriptionJson(s: SubscriptionView): z.infer<typeof SubscriptionBody> {
  return {
    ...s,
    eventTypes: [...s.eventTypes],
    headers: s.headers.map((h) => ({ ...h })),
    secretCreatedAt: s.secretCreatedAt.toISOString(),
    previousValidUntil: iso(s.previousValidUntil),
    lastSuccessAt: iso(s.lastSuccessAt),
    lastFailureAt: iso(s.lastFailureAt),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    stats: { ...s.stats },
  };
}

function deliveryJson(d: DeliveryView): z.infer<typeof DeliveryBody> {
  return {
    ...d,
    nextAttemptAt: iso(d.nextAttemptAt),
    lastAttemptAt: iso(d.lastAttemptAt),
    createdAt: d.createdAt.toISOString(),
    finishedAt: iso(d.finishedAt),
  };
}

function attemptJson(a: AttemptView): z.infer<typeof AttemptBody> {
  return { ...a, startedAt: a.startedAt.toISOString() };
}

function actorOf(request: FastifyRequest): WebhookActor {
  return {
    userId: authzOf(request).subject.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

/** The catalog as the API page shows it (also `webhooks` in /openapi.json). */
export function catalogJson() {
  return {
    catalogVersion: WEBHOOK_CATALOG_VERSION,
    headers: { ...WEBHOOK_HEADERS },
    groups: Object.fromEntries(Object.entries(WEBHOOK_EVENT_GROUPS).map(([k, v]) => [k, [...v]])),
    events: WEBHOOK_EVENT_TYPES.map((type) => ({
      type,
      description: WEBHOOK_EVENT_DESCRIPTIONS[type],
      global: GLOBAL_EVENT_TYPES.includes(type),
      subscribable: (SUBSCRIBABLE_EVENT_TYPES as readonly string[]).includes(type),
      example: exampleEnvelope(type),
    })),
  };
}

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §8, ADR-0059): Ayarlar → Webhook'lar.
 *
 * Reads `webhooks.read` (admin; an admin API token may read). Changes `webhooks.write` (admin, CSRF, session only):
 * creating, changing, resuming and rotating / revealing the secret carry the step-up event `integrations.webhooks`;
 * pausing, testing, redelivering and deleting never ask. The internal-target list is `webhooks.internal` (owner) under
 * the `security.policy` event. Every change is audited; a secret is in the create / rotate / reveal answer only
 * (`cache-control: no-store`).
 */
export function webhookRoutes(service: WebhookService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['webhooks'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const read = { authz: { action: 'webhooks.read' as const } };
    const write = { authz: { action: 'webhooks.write' as const } };
    const Params = z.object({ id: Uuid });

    r.get(
      '/webhooks/catalog',
      {
        config: read,
        schema: {
          tags,
          summary:
            'The webhook event catalog: version, header names, event types with descriptions, groups and an example envelope each',
          security: session,
          response: {
            200: z.object({
              catalogVersion: z.number().int(),
              headers: z.record(z.string(), z.string()),
              groups: z.record(z.string(), z.array(z.string())),
              events: z.array(
                z.object({
                  type: z.string(),
                  description: z.string(),
                  global: z.boolean(),
                  subscribable: z.boolean(),
                  example: z.record(z.string(), z.unknown()),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      () => catalogJson(),
    );

    r.get(
      '/webhooks/settings',
      {
        config: read,
        schema: {
          tags,
          summary: 'The owner’s internal targets: exact https origins webhooks may reach although not public',
          security: session,
          response: { 200: SettingsBody, ...errors },
        },
      },
      async () => {
        const s = await service.settings();
        return { ...s, updatedAt: iso(s.updatedAt) };
      },
    );

    r.put(
      '/webhooks/settings',
      {
        config: { authz: { action: 'webhooks.internal' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Replace the internal targets (owner; a code by the security policy’s security.policy event). Exact https:// origins only; loopback, private and metadata addresses stay refused for every other target.',
          security: csrf,
          body: z.strictObject({ internalOrigins: z.array(z.string().max(300)).max(32) }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => {
        const s = await service.setInternalOrigins(actorOf(request), request.body.internalOrigins);
        return { ...s, updatedAt: iso(s.updatedAt) };
      },
    );

    r.get(
      '/webhooks',
      {
        config: read,
        schema: {
          tags,
          summary: 'Outgoing webhooks with their state and last-24-hour delivery counts (never a secret)',
          security: session,
          response: {
            200: z.object({ items: z.array(SubscriptionBody), maxAttempts: z.number().int() }),
            ...errors,
          },
        },
      },
      async () => ({
        items: (await service.list()).map(subscriptionJson),
        maxAttempts: service.maxAttempts,
      }),
    );

    r.post(
      '/webhooks',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create a webhook: name, https target, event types, optional project (null: all projects and global events), optional redacted details and custom headers (credential headers only as secret values). The signing secret is in this answer only.',
          security: csrf,
          body: SubscriptionInput,
          response: {
            201: z.object({
              webhook: SubscriptionBody,
              secret: z.string().describe('whsec_… — shown once; HMAC-SHA256 key of X-Remyral-Signature.'),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const out = await service.create(actorOf(request), request.body);
        noStore(reply);
        return reply
          .code(201)
          .send({ webhook: subscriptionJson(out.subscription), secret: out.secret ?? '' });
      },
    );

    r.get(
      '/webhooks/:id',
      {
        config: read,
        schema: {
          tags,
          summary: 'One webhook',
          security: session,
          params: Params,
          response: { 200: z.object({ webhook: SubscriptionBody }), ...errors },
        },
      },
      async (request) => ({ webhook: subscriptionJson(await service.get(request.params.id)) }),
    );

    r.patch(
      '/webhooks/:id',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change a webhook (the whole definition). A secret header keeps its value with keep: true; send a new value to replace it.',
          security: csrf,
          params: Params,
          body: SubscriptionInput,
          response: { 200: z.object({ webhook: SubscriptionBody }), ...errors },
        },
      },
      async (request) => ({
        webhook: subscriptionJson(await service.update(actorOf(request), request.params.id, request.body)),
      }),
    );

    r.delete(
      '/webhooks/:id',
      {
        config: write,
        schema: {
          tags,
          summary: 'Delete a webhook and its delivery log. Audited.',
          security: csrf,
          params: Params,
          response: { 200: z.object({ deleted: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        await service.remove(actorOf(request), request.params.id);
        return { deleted: true };
      },
    );

    r.post(
      '/webhooks/:id/pause',
      {
        config: write,
        schema: {
          tags,
          summary: 'Pause: no new deliveries are queued; pending ones wait (never asks for a code)',
          security: csrf,
          params: Params,
          response: { 200: z.object({ webhook: SubscriptionBody }), ...errors },
        },
      },
      async (request) => ({
        webhook: subscriptionJson(await service.setState(actorOf(request), request.params.id, 'paused')),
      }),
    );

    r.post(
      '/webhooks/:id/resume',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Resume a paused or automatically disabled webhook (the failure counter starts over)',
          security: csrf,
          params: Params,
          response: { 200: z.object({ webhook: SubscriptionBody }), ...errors },
        },
      },
      async (request) => ({
        webhook: subscriptionJson(await service.setState(actorOf(request), request.params.id, 'active')),
      }),
    );

    r.post(
      '/webhooks/:id/rotate',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'A new signing secret; the previous one keeps signing (a second v1 in X-Remyral-Signature) for overlapHours (default 24, at most 168, 0 = at once). The secret is in this answer only.',
          security: csrf,
          params: Params,
          body: z.strictObject({ overlapHours: z.number().int().min(0).max(168).optional() }),
          response: { 200: z.object({ webhook: SubscriptionBody, secret: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const out = await service.rotate(actorOf(request), request.params.id, request.body.overlapHours);
        noStore(reply);
        return { webhook: subscriptionJson(out.subscription), secret: out.secret };
      },
    );

    r.post(
      '/webhooks/:id/secret',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Show a never-shown secret once (a webhook the assistant created). Afterwards only a rotation gives a new one.',
          security: csrf,
          params: Params,
          response: { 200: z.object({ secret: z.string() }), ...errors },
        },
      },
      async (request, reply) => {
        const out = await service.revealSecret(actorOf(request), request.params.id);
        noStore(reply);
        return out;
      },
    );

    r.post(
      '/webhooks/:id/test',
      {
        config: write,
        schema: {
          tags,
          summary:
            'Send a webhook.test event now (one attempt, any state, not counted for auto-disable); answers with the attempt',
          security: csrf,
          params: Params,
          response: {
            200: z.object({ delivery: DeliveryBody, attempts: z.array(AttemptBody) }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await service.test(actorOf(request), request.params.id);
        return { delivery: deliveryJson(out.delivery), attempts: out.attempts.map(attemptJson) };
      },
    );

    r.get(
      '/webhooks/:id/deliveries',
      {
        config: read,
        schema: {
          tags,
          summary:
            'The delivery log of a webhook (newest first): status, attempts, last status code, error, latency',
          security: session,
          params: Params,
          querystring: z.object({
            status: z.enum(DELIVERY_STATUSES).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
            before: z
              .string()
              .regex(/^\d{1,19}$/)
              .optional(),
          }),
          response: {
            200: z.object({ items: z.array(DeliveryBody), nextCursor: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await service.deliveries(request.params.id, request.query);
        return { items: out.items.map(deliveryJson), nextCursor: out.nextCursor };
      },
    );

    r.get(
      '/webhooks/:id/deliveries/:deliveryId',
      {
        config: read,
        schema: {
          tags,
          summary: 'One delivery with every attempt and the exact body that was (or will be) sent',
          security: session,
          params: z.object({ id: Uuid, deliveryId: Uuid }),
          response: {
            200: z.object({ delivery: DeliveryBody, attempts: z.array(AttemptBody), body: z.string() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const out = await service.delivery(request.params.id, request.params.deliveryId);
        return {
          delivery: deliveryJson(out.delivery),
          attempts: out.attempts.map(attemptJson),
          body: out.body,
        };
      },
    );

    r.post(
      '/webhooks/:id/deliveries/:deliveryId/redeliver',
      {
        config: write,
        schema: {
          tags,
          summary:
            'Send a finished delivery again: same delivery id (X-Remyral-Delivery) and body, the attempt count continues',
          security: csrf,
          params: z.object({ id: Uuid, deliveryId: Uuid }),
          response: { 200: z.object({ delivery: DeliveryBody }), ...errors },
        },
      },
      async (request) => ({
        delivery: deliveryJson(
          await service.redeliver(actorOf(request), request.params.id, request.params.deliveryId),
        ),
      }),
    );
  };
}
