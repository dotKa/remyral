import { randomUUID } from 'node:crypto';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { requireStepUp } from '../auth/hooks.js';
import type { Pool } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { actorOf } from '../workers/routes.js';
import type { MailSettings } from './dynamic.js';
import { DeliveryError } from './notifier.js';
import { isEmailAddress, SmtpNotifier } from './smtp.js';

/**
 * p17-panel-settings Part 1 (docs/design/p17-panel-settings.md §4): the one SMTP configuration.
 *
 * - `GET /panel-settings/mail` (`settings.panel.read`): what the notification and support e-mail use — the source
 *   (panel / environment / none), host, port, TLS mode, sender, user name, whether a password is set (never the
 *   password). It is edited with `PUT /support/settings` (the support SMTP is the panel's SMTP).
 * - `POST /panel-settings/mail/test` (`settings.panel.write`, owners, step-up): sends a test message with it to the
 *   given address or the caller's notification address; the result is a closed error code, never the server's text.
 */
const errors = { 400: ErrorBodySchema, 401: ErrorBodySchema, 403: ErrorBodySchema, 409: ErrorBodySchema };

export function mailRoutes(deps: {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly mail: MailSettings;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, deps.clock);

    r.get(
      '/panel-settings/mail',
      {
        config: { authz: { action: 'settings.panel.read' as const } },
        schema: {
          tags: ['panel-settings'],
          summary: 'The SMTP configuration notifications and support mail use (never its password)',
          security: [{ session: [] }],
          response: {
            200: z.object({
              source: z.enum(['panel', 'env', 'none']),
              host: z.string().nullable(),
              port: z.number().nullable(),
              security: z.string().nullable(),
              from: z.string().nullable(),
              username: z.string().nullable(),
              passwordSet: z.boolean(),
            }),
            ...errors,
          },
        },
      },
      async () => {
        await deps.mail.refresh();
        const c = deps.mail.current();
        return {
          source: c === null ? ('none' as const) : c.source,
          host: c?.config.host ?? null,
          port: c?.config.port ?? null,
          security: c?.config.security ?? null,
          from: c?.config.from ?? null,
          username: c?.config.username ?? null,
          passwordSet: (c?.config.password ?? '') !== '',
        };
      },
    );

    r.post(
      '/panel-settings/mail/test',
      {
        config: { authz: { action: 'settings.panel.write' as const } },
        preHandler: stepUp,
        schema: {
          tags: ['panel-settings'],
          summary:
            'Send a test e-mail with the SMTP configuration in effect (to the given or the caller’s address)',
          security: [{ session: [], csrf: [] }],
          body: z.strictObject({ to: z.string().max(254).optional() }),
          response: {
            200: z.object({
              ok: z.boolean(),
              to: z.string(),
              source: z.string(),
              error: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const actor = actorOf(request);
        let to = request.body.to?.trim() ?? '';
        if (to === '') {
          const { rows } = await deps.pool.query<{ email: string | null }>(
            'SELECT email FROM notification_targets WHERE user_id = $1',
            [actor.userId],
          );
          to = rows[0]?.email ?? '';
        }
        if (!isEmailAddress(to)) {
          throw new HttpError(400, 'invalid_email', 'Enter a valid e-mail address.');
        }
        await deps.mail.refresh();
        const c = deps.mail.current();
        if (c === null) {
          throw new HttpError(
            409,
            'smtp_not_configured',
            'No SMTP server is configured (neither in the panel nor in the environment).',
          );
        }
        let error: string | null = null;
        try {
          await new SmtpNotifier(c.config, deps.clock).send(
            {
              id: randomUUID(),
              deliveryId: randomUUID(),
              kind: 'alert',
              severity: 'info',
              title: 'Remyral test e-mail',
              body: 'This message confirms that the server can send e-mail with the configured SMTP server.',
              link: null,
              createdAt: deps.clock(),
              recipient: { id: actor.userId, username: 'test' },
            },
            to,
          );
        } catch (err) {
          error = err instanceof DeliveryError ? err.code : 'smtp_error';
        }
        await deps.audit.record({
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip,
          userAgent: actor.userAgent,
          action: 'settings.mail.test',
          target: 'smtp',
          outcome: error === null ? 'success' : 'failure',
          metadata: { source: c.source, host: c.config.host, ...(error === null ? {} : { error }) },
        });
        return { ok: error === null, to, source: c.source, error };
      },
    );
  };
}
