import { z } from 'zod';

/**
 * p14-i18n-errors (i18n Phase 3): the error body every route declares for its 4xx/5xx answers. Fastify's Zod
 * serializer drops undeclared fields, so a route whose error schema lacked `params` would silently lose them;
 * `test/integration/error-params.test.ts` walks the OpenAPI document and fails on any error schema without it.
 * Routes with extra client-safe fields (`issues`, `findings`, …) use `ErrorBodySchema.extend({ … })`.
 */
export const ErrorParamsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe('Values of the English message, for a translated sentence (`reason` picks a variant).');

export const ErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  params: ErrorParamsSchema.optional(),
});
