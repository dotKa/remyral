import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, type RoutePlugin } from '../../src/app.js';
import { policyFailureParams } from '../../src/auth/password.js';
import { validateGitIdentity } from '../../src/git-identity/store.js';
import { ErrorBodySchema } from '../../src/http/error-schema.js';
import {
  boundedParams,
  ERROR_PARAM_STRING_MAX,
  ERROR_PARAMS_MAX_KEYS,
  HttpError,
  httpErrorBody,
} from '../../src/http/errors.js';

/**
 * p14-i18n-errors (i18n Phase 3, ADR-0053 §5): an HttpError carries bounded, client-safe `params` next to its
 * English `message`; the error handler sends them only when there are any, and the shared `ErrorBodySchema`
 * keeps them through Fastify's Zod serializer (a schema without `params` would drop them silently).
 */

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const LIMIT = new HttpError(
  413,
  'attachment_too_large',
  'notes.md: larger than 512 KiB.',
  {},
  {},
  { name: 'notes.md', maxKib: 512 },
);

const routes: RoutePlugin = (a) => {
  const r = a.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/declared',
    {
      config: { auth: 'public' },
      schema: { response: { 200: z.object({ ok: z.boolean() }), 413: ErrorBodySchema } },
    },
    () => {
      throw LIMIT;
    },
  );
  r.get(
    '/extended',
    {
      config: { auth: 'public' },
      schema: {
        response: {
          200: z.object({ ok: z.boolean() }),
          400: ErrorBodySchema.extend({ issues: z.array(z.object({ path: z.string() })).optional() }),
        },
      },
    },
    () => {
      throw new HttpError(
        400,
        'invalid_query',
        'Invalid from.',
        {},
        { issues: [{ path: 'from' }] },
        { field: 'from' },
      );
    },
  );
  r.get(
    '/undeclared',
    { config: { auth: 'public' }, schema: { response: { 200: z.object({ ok: z.boolean() }) } } },
    () => {
      throw LIMIT;
    },
  );
  r.get(
    '/plain',
    {
      config: { auth: 'public' },
      schema: { response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBodySchema } },
    },
    () => {
      throw new HttpError(404, 'job_not_found', 'Job not found.');
    },
  );
};

async function make(): Promise<FastifyInstance> {
  app = await buildApp({ logLevel: 'silent', trustProxyHops: 0, bodyLimitBytes: 1024, routes: [routes] });
  return app;
}

describe('HttpError params', () => {
  it('keeps strings, finite numbers and booleans within bounds and drops everything else', () => {
    const p = boundedParams({
      name: 'x'.repeat(ERROR_PARAM_STRING_MAX + 50),
      n: 3,
      ok: true,
      nan: Number.NaN,
      obj: { secret: 'no' },
      list: ['a'],
      nul: null,
      undef: undefined,
      'bad key': 'no',
      _leading: 'no',
    });
    expect(p).toEqual({ name: 'x'.repeat(ERROR_PARAM_STRING_MAX), n: 3, ok: true });
    const many = boundedParams(
      Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i)}`, i])),
    );
    expect(Object.keys(many)).toHaveLength(ERROR_PARAMS_MAX_KEYS);
  });

  it('the body has params only when there are any; details never override error/message', () => {
    expect(httpErrorBody(LIMIT)).toEqual({
      error: 'attachment_too_large',
      message: 'notes.md: larger than 512 KiB.',
      params: { name: 'notes.md', maxKib: 512 },
    });
    expect(httpErrorBody(new HttpError(404, 'job_not_found', 'Job not found.'))).toEqual({
      error: 'job_not_found',
      message: 'Job not found.',
    });
    const odd = new HttpError(400, 'x', 'X.', {}, { error: 'spoof', message: 'spoof' });
    expect(httpErrorBody(odd)).toEqual({ error: 'x', message: 'X.' });
  });

  it('representative errors carry their values: password policy, git identity', () => {
    expect(policyFailureParams('too_short')).toEqual({ reason: 'too_short', min: 12 });
    expect(policyFailureParams('too_long')).toEqual({ reason: 'too_long', max: 1024 });
    expect(policyFailureParams('common')).toEqual({ reason: 'common' });
    let caught: unknown;
    try {
      validateGitIdentity({ name: 'Ada', email: 'x'.repeat(260) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({
      code: 'invalid_git_identity',
      publicMessage: 'Email is at most 254 characters.',
      params: { reason: 'email_too_long', max: 254 },
    });
  });
});

describe('error serialization keeps params', () => {
  it('a route declaring ErrorBodySchema sends them', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/declared' });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: 'attachment_too_large',
      message: 'notes.md: larger than 512 KiB.',
      params: { name: 'notes.md', maxKib: 512 },
    });
  });

  it('an extended error schema keeps params and its own fields', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/extended' });
    expect(res.json()).toEqual({
      error: 'invalid_query',
      message: 'Invalid from.',
      issues: [{ path: 'from' }],
      params: { field: 'from' },
    });
  });

  it('an undeclared status is sent as is; an error without params has no params key', async () => {
    const a = await make();
    expect((await a.inject({ method: 'GET', url: '/undeclared' })).json()).toMatchObject({
      params: { name: 'notes.md', maxKib: 512 },
    });
    expect((await a.inject({ method: 'GET', url: '/plain' })).json()).toEqual({
      error: 'job_not_found',
      message: 'Job not found.',
    });
  });

  it('the OpenAPI schema of ErrorBodySchema declares params', () => {
    const json = z.toJSONSchema(ErrorBodySchema) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(json.properties)).toEqual(['error', 'message', 'params']);
    expect(json.required).toEqual(['error', 'message']);
  });
});
