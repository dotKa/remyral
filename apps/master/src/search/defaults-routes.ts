import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { authzOf } from '../http/route-authz.js';
import type { SemanticDefaults, SemanticDefaultsService } from './defaults.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 409: ErrorBody };

const Mode = z.enum(['off', 'rules', 'assisted']);
const DefaultsBody = z.object({
  projectCapture: z.boolean(),
  memoryMode: Mode,
  version: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  /** When existing projects without a choice were switched on (null: not yet). */
  backfilledAt: z.string().nullable(),
});

function json(d: SemanticDefaults): z.infer<typeof DefaultsBody> {
  return {
    ...d,
    updatedAt: d.updatedAt.toISOString(),
    backfilledAt: d.backfilledAt?.toISOString() ?? null,
  };
}

/**
 * p10-semantic-defaults-chat: the project knowledge defaults for new projects (Settings → Context; the create-project
 * form pre-checks its boxes from them). Admin+; changing them needs step-up and is audited.
 */
export function semanticDefaultsRoutes(defaults: SemanticDefaultsService, clock: () => Date) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['context'];

    r.get(
      '/context/defaults',
      {
        config: { authz: { action: 'context.defaults' } },
        schema: {
          tags,
          summary: 'Project knowledge defaults for new projects (search capture, memory suggestions)',
          security: [{ session: [] }],
          response: { 200: DefaultsBody, ...errors },
        },
      },
      async () => json(await defaults.get()),
    );

    r.put(
      '/context/defaults',
      {
        config: { authz: { action: 'context.defaults' } },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary:
            'Change the project knowledge defaults for new projects (admin+, step-up, audited; existing projects keep their setting)',
          security: [{ session: [], csrf: [] }],
          body: z.object({
            projectCapture: z.boolean(),
            memoryMode: Mode,
            expectedVersion: z.number().int().min(1),
          }),
          response: { 200: DefaultsBody, ...errors },
        },
      },
      async (request) => {
        const actor = {
          id: authzOf(request).subject.userId,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        };
        return json(await defaults.put(actor, request.body));
      },
    );
  };
}
