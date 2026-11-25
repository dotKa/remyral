import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { HttpError } from '../http/errors.js';
import { OpsError } from '../ops/model.js';
import type { BedrockIntegration } from './bedrock-integration.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * p10-bedrock-integration-panel (docs/design/p10-semantic-memory.md §11): Settings → Integrations → AWS Bedrock
 * (embeddings). Reads: admin (owner included). Writes: admin with an always-fresh step-up (like the Coolify /
 * Cloudflare tokens); the connection test needs CSRF only. No response carries a key.
 */

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const Json = z.record(z.string(), z.unknown());
const Source = z.enum(['panel', 'environment', 'instance role']).nullable();

/** Metadata only: no field can carry a key. */
const IntegrationBody = z
  .object({
    settings: z.object({ region: z.string(), model: z.string() }),
    keyIdHint: z.string(),
    keyFingerprint: z.string(),
    usable: z.boolean(),
    lastTest: Json.nullable(),
    lastTestAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .nullable();
const StatusBody = z.object({
  integration: IntegrationBody,
  active: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    region: z.string().nullable(),
    source: Source,
    panelInUse: z.boolean(),
    panelInactiveReason: z.string().nullable(),
  }),
  env: z.object({
    searchProvider: z.enum(['unset', 'off', 'bedrock', 'http', 'local-hash']),
    region: z.string().nullable(),
  }),
  options: z.object({
    regions: z.array(z.string()),
    models: z.array(z.string()),
    defaultModel: z.string(),
  }),
});
const SaveBody = z.strictObject({
  region: z.string().min(1).max(40),
  model: z.string().min(1).max(100),
  accessKeyId: z.string().max(128).optional(),
  secretAccessKey: z.string().max(256).optional(),
});

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpsError) throw new HttpError(err.status, err.code, err.message, err.headers);
    throw err;
  }
}

export function bedrockRoutes(deps: { readonly bedrock: BedrockIntegration; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { bedrock } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', deps.clock);
    const tags = ['integrations'];
    const user = (request: FastifyRequest) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });

    r.get(
      '/integrations/bedrock',
      {
        config: { authz: { action: 'integrations.bedrock.read' } },
        schema: {
          tags,
          summary:
            'AWS Bedrock embeddings: the panel connection (no keys), the active provider and its source, options',
          security: session,
          response: { 200: StatusBody, ...errors },
        },
      },
      async () =>
        wrap(async () => {
          const s = await bedrock.status();
          return {
            ...s,
            options: {
              regions: [...s.options.regions],
              models: [...s.options.models],
              defaultModel: s.options.defaultModel,
            },
          };
        }),
    );
    r.put(
      '/integrations/bedrock',
      {
        config: { authz: { action: 'integrations.bedrock.write' } },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Connect or change AWS Bedrock embeddings: region, model and (optionally) new access keys, stored encrypted by the master (always-fresh step-up)',
          security: csrf,
          body: SaveBody,
          response: { 200: IntegrationBody, ...errors },
        },
      },
      async (request) => wrap(async () => bedrock.save(user(request), request.body)),
    );
    r.delete(
      '/integrations/bedrock',
      {
        config: { authz: { action: 'integrations.bedrock.write' } },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Remove the AWS Bedrock keys from the panel (always-fresh step-up); env stays the fallback',
          security: csrf,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          await bedrock.remove(user(request));
          return reply.code(204).send(null);
        }),
    );
    r.post(
      '/integrations/bedrock/test',
      {
        config: { authz: { action: 'integrations.bedrock.write' } },
        schema: {
          tags,
          summary:
            'Test the stored AWS Bedrock keys: embed a short Turkish + English sample (dimensions, latency, or the AWS error type)',
          security: csrf,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => wrap(async () => bedrock.test(user(request))),
    );
  };
}
