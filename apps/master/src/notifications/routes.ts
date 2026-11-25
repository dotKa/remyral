import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requestStepUpFresh, stepUpRequiredError } from '../auth/hooks.js';
import { HttpError } from '../http/errors.js';
import { unauthorized } from '../http/route-auth.js';
import type { AuthzRule } from '../http/route-authz.js';
import { NOTIFICATION_KINDS, type NotificationRecord, SEVERITIES } from './model.js';
import { DeliveryError } from './notifier.js';
import type { NotificationService } from './service.js';
import type { PushDevice as PushDeviceRecord } from './push/subscriptions.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };

const Kind = z.enum(NOTIFICATION_KINDS);
const Notification = z.object({
  id: z.string(),
  kind: Kind,
  severity: z.enum(SEVERITIES),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

const Preferences = z.object({
  kinds: z.array(
    z.object({
      kind: Kind,
      label: z.string(),
      description: z.string(),
      email: z.boolean(),
      webhook: z.boolean(),
      push: z.boolean(),
    }),
  ),
  channels: z.object({
    email: z.object({ available: z.boolean(), address: z.string().nullable() }),
    webhook: z.object({ available: z.boolean(), url: z.string().nullable() }),
    push: z.object({ available: z.boolean(), devices: z.number().int() }),
  }),
});

const PushDevice = z.object({
  id: z.string(),
  label: z.string(),
  service: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  lastSuccessAt: z.string().nullable(),
});

function deviceView(d: PushDeviceRecord): z.infer<typeof PushDevice> {
  return {
    id: d.id,
    label: d.label,
    service: d.service,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null,
  };
}

/** `PushSubscription.toJSON()` as browsers send it (expirationTime is ignored). */
const SubscriptionBody = z.strictObject({
  endpoint: z.string().min(9).max(2000),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().min(80).max(100),
    auth: z.string().min(16).max(32),
  }),
});

/**
 * Own notifications only (`notifications.self`): every handler scopes its query by the session's user id,
 * so another user's notification id answers 404 exactly like a missing one.
 */
const SELF: AuthzRule = {
  action: 'notifications.self',
  resource: (request) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

function userId(request: FastifyRequest): string {
  const id = request.auth?.session.user.id;
  if (!id) throw unauthorized(); // unreachable: the auth hook ran first
  return id;
}

function view(n: NotificationRecord): z.infer<typeof Notification> {
  return {
    id: n.id,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    link: n.link,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
  };
}

function notFound(): HttpError {
  return new HttpError(404, 'notification_not_found', 'Notification not found.');
}

export function notificationRoutes(service: NotificationService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['notifications'];
    const csrf = [{ session: [], csrf: [] }];

    r.get(
      '/notifications',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Own notifications, newest first, with the unread count',
          security: [{ session: [] }],
          querystring: z.object({
            unread: z.enum(['true', 'false']).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().max(200).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(Notification),
              unreadCount: z.number().int(),
              nextCursor: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const q = request.query;
        const page = await service.list(userId(request), {
          unreadOnly: q.unread === 'true',
          ...(q.limit === undefined ? {} : { limit: q.limit }),
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        });
        return { items: page.items.map(view), unreadCount: page.unreadCount, nextCursor: page.nextCursor };
      },
    );

    r.post(
      '/notifications/read-all',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Mark every own notification read',
          security: csrf,
          response: {
            200: z.object({ updated: z.number().int(), unreadCount: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const updated = await service.markAllRead(userId(request));
        return { updated, unreadCount: 0 };
      },
    );

    r.post(
      '/notifications/:id/read',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Mark one own notification read',
          security: csrf,
          params: z.object({ id: z.string().max(64) }),
          response: {
            200: z.object({ notification: Notification, unreadCount: z.number().int() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const uid = userId(request);
        const n = await service.markRead(uid, request.params.id);
        if (!n) throw notFound();
        return { notification: view(n), unreadCount: await service.unreadCount(uid) };
      },
    );

    r.get(
      '/notifications/preferences',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Own notification preferences (kinds × outbound channels) and channel targets',
          security: [{ session: [] }],
          response: { 200: Preferences, ...errors },
        },
      },
      async (request) => service.preferences(userId(request)),
    );

    r.put(
      '/notifications/preferences',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Change own preferences; changing the e-mail address or webhook URL needs a step-up',
          security: csrf,
          body: z.strictObject({
            kinds: z
              .array(
                z.strictObject({
                  kind: Kind,
                  email: z.boolean().optional(),
                  webhook: z.boolean().optional(),
                  push: z.boolean().optional(),
                }),
              )
              .max(NOTIFICATION_KINDS.length)
              .optional(),
            email: z.string().max(254).nullable().optional(),
            webhookUrl: z.string().max(2000).nullable().optional(),
          }),
          response: { 200: Preferences, ...errors },
        },
      },
      async (request) => {
        const uid = userId(request);
        const b = request.body;
        const update = {
          ...(b.kinds === undefined ? {} : { kinds: b.kinds }),
          ...(b.email === undefined ? {} : { email: b.email }),
          ...(b.webhookUrl === undefined ? {} : { webhookUrl: b.webhookUrl }),
        };
        // Redirecting notifications elsewhere is a privileged change (a stolen session must not be able
        // to siphon them off): a step-up under the session's rule, like other privileged actions (ADR-0009 §10).
        if (await service.changesTargets(uid, update)) {
          if (!requestStepUpFresh(request, clock())) throw stepUpRequiredError();
        }
        return service.updatePreferences(uid, update, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      },
    );

    // ---------------------------------------------------------------- p8-pwa: Web Push devices

    const meta = (request: FastifyRequest) => ({
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    r.get(
      '/notifications/push',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Web Push: whether it is configured, the VAPID public key and the own push devices',
          security: [{ session: [] }],
          response: {
            200: z.object({
              available: z.boolean(),
              publicKey: z.string().nullable(),
              devices: z.array(PushDevice),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({
        available: service.pushNotifier !== null,
        publicKey: service.pushNotifier?.publicKey ?? null,
        devices: (await service.pushSubscriptions.list(userId(request))).map(deviceView),
      }),
    );

    r.post(
      '/notifications/push/subscriptions',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary:
            'Register this browser for push (a new device needs a step-up; re-registering the same one does not)',
          security: csrf,
          body: SubscriptionBody,
          response: { 200: z.object({ device: PushDevice, created: z.boolean() }), ...errors },
        },
      },
      async (request) => {
        const uid = userId(request);
        const b = request.body;
        // A new push destination is like a new e-mail address: a stolen session must not add its own device.
        if (!(await service.pushSubscriptions.isRefresh(uid, b.endpoint))) {
          if (!requestStepUpFresh(request, clock())) throw stepUpRequiredError();
        }
        const out = await service.pushSubscriptions.register(
          uid,
          { endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth },
          { ...meta(request), trustedDeviceId: request.auth?.session.trustedDeviceId ?? null },
        );
        return { device: deviceView(out.device), created: out.created };
      },
    );

    r.delete(
      '/notifications/push/subscriptions/:id',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Revoke one own push device',
          security: csrf,
          params: z.object({ id: z.string().max(64) }),
          response: { 200: z.object({ status: z.literal('revoked') }), ...errors },
        },
      },
      async (request) => {
        const ok = await service.pushSubscriptions.remove(
          userId(request),
          { id: request.params.id },
          meta(request),
          'user',
        );
        if (!ok) throw new HttpError(404, 'push_device_not_found', 'Push device not found.');
        return { status: 'revoked' as const };
      },
    );

    r.post(
      '/notifications/push/unsubscribe',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary:
            'Remove this browser’s own subscription by endpoint (turning push off here, or logging out)',
          security: csrf,
          body: z.strictObject({
            endpoint: z.string().min(9).max(2000),
            reason: z.enum(['user', 'logout']).optional(),
          }),
          response: { 200: z.object({ removed: z.boolean() }), ...errors },
        },
      },
      async (request) => ({
        removed: await service.pushSubscriptions.remove(
          userId(request),
          { endpoint: request.body.endpoint },
          meta(request),
          request.body.reason ?? 'user',
        ),
      }),
    );

    r.post(
      '/notifications/push/test',
      {
        config: { authz: SELF },
        schema: {
          tags,
          summary: 'Send a test push to the own push devices',
          security: csrf,
          response: { 200: z.object({ sent: z.number().int() }), 409: ErrorBody, 502: ErrorBody, ...errors },
        },
      },
      async (request) => {
        const notifier = service.pushNotifier;
        if (!notifier) {
          throw new HttpError(
            400,
            'channel_unavailable',
            'Push notifications are not configured on this installation.',
          );
        }
        try {
          return await notifier.sendPayload(userId(request), {
            v: 1,
            id: randomUUID(),
            kind: 'test',
            severity: 'info',
            title: 'Remyral test notification',
            body: 'Push notifications reach this device.',
            link: '/settings/devices',
            ts: clock().getTime(),
          });
        } catch (err) {
          if (err instanceof DeliveryError) {
            if (err.code === 'no_push_device') {
              throw new HttpError(409, 'no_push_device', 'No device is registered for push notifications.');
            }
            throw new HttpError(
              502,
              'push_failed',
              `The push service did not accept the message (${err.code}).`,
              {},
              {},
              { status: err.code },
            );
          }
          throw err;
        }
      },
    );
  };
}
