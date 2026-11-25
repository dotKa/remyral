import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-i18n-errors (i18n Phase 3, ADR-0053 §5) contract: Fastify's Zod serializer drops undeclared fields, so every
 * route's declared error response must include `params` — or a translated error would silently lose its values.
 * Walks the full OpenAPI document of the composed master: every 4xx/5xx JSON schema with `error` + `message` must
 * declare `params` (`ErrorBodySchema`, apps/master/src/http/error-schema.ts).
 */
const PW = 'error-params-Passw0rd-long';

interface JsonSchema {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
}

interface OpenApi {
  readonly paths: Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> }>
  >;
}

function errorSchemas(s: JsonSchema | undefined): JsonSchema[] {
  if (s === undefined) return [];
  const nested = [...(s.anyOf ?? []), ...(s.oneOf ?? [])].flatMap(errorSchemas);
  return s.properties?.error !== undefined && s.properties.message !== undefined ? [s, ...nested] : nested;
}

describeIntegration('error params contract (integration)', () => {
  let h: Harness;
  let viewer: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('params-viewer', PW, 'viewer');
    const a = await enroll(h, 'params-viewer', PW);
    viewer = await fullLogin(h, 'params-viewer', PW, a.secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('every declared error response schema includes params', async () => {
    const res = await viewer.req('GET', '/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = res.json<OpenApi>();
    const missing: string[] = [];
    let checked = 0;
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        for (const [status, r] of Object.entries(op.responses ?? {})) {
          if (!/^[45]\d\d$/.test(status)) continue;
          for (const schema of errorSchemas(r.content?.['application/json']?.schema)) {
            checked += 1;
            if (schema.properties?.params === undefined)
              missing.push(`${method.toUpperCase()} ${path} ${status}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(500);
  });
});
