import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RateLimiter } from '../auth/rate-limit.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { SetupError, type SetupService } from './service.js';

/**
 * p16-selfhost-onboarding §3: the public first-owner routes of a fresh install.
 *
 * - `GET /setup/status` — `{ required }`: true only while no account exists (the login screen offers "İlk kurulum").
 * - `POST /setup/owner` — token + username + password → the first owner. Rate-limited per address (10 / 15 min);
 *   refused for good once any account exists. The response carries no session: the owner signs in normally next
 *   and enrolls the authenticator (ADR-0009).
 */
const ErrorBody = ErrorBodySchema;
const CLAIM_LIMIT = { perIp: 10, windowMs: 15 * 60_000 };

export function setupRoutes(deps: { readonly service: SetupService; readonly limiter: RateLimiter }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/setup/status',
      {
        config: { auth: 'public' },
        schema: {
          tags: ['setup'],
          summary: 'Whether this master still needs its first owner (true only while no account exists)',
          response: { 200: z.object({ required: z.boolean() }) },
        },
      },
      async () => ({ required: await deps.service.required() }),
    );

    r.post(
      '/setup/owner',
      {
        config: { auth: 'public' },
        schema: {
          tags: ['setup'],
          summary:
            'Create the first owner with the one-time setup token printed by remyral-ctl install (refused once any account exists)',
          body: z.object({
            token: z.string().min(1).max(100),
            username: z.string().min(1).max(64),
            password: z.string().min(1).max(1024),
          }),
          response: {
            201: z.object({ username: z.string() }),
            400: ErrorBody,
            401: ErrorBody,
            409: ErrorBody,
            429: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const hit = await deps.limiter.hit(
          'setup-owner',
          request.ip,
          CLAIM_LIMIT.perIp,
          CLAIM_LIMIT.windowMs,
        );
        if (!hit.allowed) {
          throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', {
            'retry-after': String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))),
          });
        }
        try {
          const created = await deps.service.claim(request.body, {
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
          return await reply.code(201).send({ username: created.username });
        } catch (err) {
          if (!(err instanceof SetupError)) throw err;
          if (err.code === 'setup_done') throw new HttpError(409, 'setup_done', err.message);
          if (err.code === 'username_taken') throw new HttpError(409, 'username_taken', err.message);
          if (err.code === 'invalid_setup_token')
            throw new HttpError(401, 'invalid_setup_token', err.message);
          if (err.code === 'weak_password')
            throw new HttpError(400, 'weak_password', err.message, {}, {}, err.params);
          throw new HttpError(400, 'invalid_username', err.message);
        }
      },
    );
  };
}
