import { afterAll, beforeAll, expect, it } from 'vitest';
import { hiddenFromOpenApi, OPENAPI_EXAMPLES } from '../../src/http/openapi.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §10): the OpenAPI document is public and complete. Every registered
 * route of the public REST API (all but HEAD twins and the documented non-REST endpoints of `OPENAPI_HIDDEN_*`) is an
 * operation with a summary, a tag, an operationId, its security (bearer only where the route has a token scope) and
 * `x-token-scope`, a request body schema when the route takes one, and a 2xx answer with a schema (or 204 / the
 * documented 410 of retired routes). The document carries no secret and is served without a session.
 */
interface Operation {
  summary?: string;
  tags?: string[];
  operationId?: string;
  security?: Record<string, string[]>[];
  'x-token-scope'?: string;
  requestBody?: { content?: Record<string, { schema?: unknown; examples?: unknown; example?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown; examples?: unknown }> }>;
}
interface OpenApi {
  openapi: string;
  info: { title: string; version: string };
  servers?: { url: string }[];
  tags?: { name: string; description?: string }[];
  components: { securitySchemes: Record<string, { type: string; scheme?: string }> };
  paths: Record<string, Record<string, Operation>>;
}

describeIntegration('OpenAPI completeness (integration, p16-api-tokens)', { timeout: 120_000 }, () => {
  let h: Harness;
  let doc: OpenApi;
  let raw = '';

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    // Public: no session, no token.
    const res = await h.app.inject({ method: 'GET', url: '/openapi.json', remoteAddress: '198.51.100.30' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    raw = res.body;
    doc = res.json<OpenApi>();
  });
  afterAll(async () => {
    await h.stop();
  });

  it('is public, describes both credentials and serves under /api', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers?.[0]?.url).toBe('/api');
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.components.securitySchemes.session).toMatchObject({ type: 'apiKey' });
    expect(doc.components.securitySchemes.csrf).toMatchObject({ type: 'apiKey' });
    for (const t of doc.tags ?? []) expect(t.description, t.name).toBeTruthy();
  });

  it('contains no secret-looking value', () => {
    expect(raw).not.toMatch(/ryl_(pat|sa)_[0-9A-Za-z]{46}/);
    expect(raw).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(raw).not.toMatch(/\$scrypt\$ln=/);
    expect(raw).not.toMatch(/ghp_[0-9A-Za-z]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/);
  });

  it('every public REST route is an operation with schemas, security and token scope', () => {
    const problems: string[] = [];
    let operations = 0;
    let withBody = 0;
    let tokenUsable = 0;
    for (const r of h.app.registeredRoutes) {
      const key = `${r.method} ${r.url}`;
      if (hiddenFromOpenApi(r.method, r.url)) continue;
      const path = r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const op = doc.paths[path]?.[r.method.toLowerCase()];
      if (op === undefined) {
        problems.push(`${key}: missing${r.hidden ? ' (schema.hide)' : ''}`);
        continue;
      }
      operations += 1;
      if (!op.summary) problems.push(`${key}: no summary`);
      if ((op.tags ?? []).length === 0) problems.push(`${key}: no tag`);
      if (!op.operationId) problems.push(`${key}: no operationId`);
      if (op.security === undefined) problems.push(`${key}: no security`);
      const scope = op['x-token-scope'];
      const want = r.tokenScope ?? 'none';
      if (scope !== want) problems.push(`${key}: x-token-scope ${String(scope)} ≠ ${want}`);
      const bearer = (op.security ?? []).some((s) => 'bearerAuth' in s);
      if (bearer !== (r.tokenScope !== null && r.tokenScope !== undefined)) {
        problems.push(`${key}: bearerAuth ${String(bearer)} does not match its token scope`);
      }
      if (r.auth === 'public' && (op.security ?? []).length !== 0)
        problems.push(`${key}: public but secured`);
      if (r.hasBody) {
        withBody += 1;
        const media = op.requestBody?.content?.['application/json'];
        if (media?.schema === undefined) problems.push(`${key}: body schema missing`);
      }
      const answers = Object.entries(op.responses ?? {}).filter(([s]) => /^(2\d\d|410)$/.test(s));
      const ok = answers.some(
        ([s, a]) => s === '204' || Object.values(a.content ?? {}).some((m) => m.schema !== undefined),
      );
      if (!ok) problems.push(`${key}: no 2xx answer with a schema`);
      if (bearer) tokenUsable += 1;
    }
    expect(problems).toEqual([]);
    // Coverage numbers for the record (docs/design/p16-api-tokens.md §10).
    console.info(
      `openapi: ${String(operations)} operations, ${String(withBody)} with a request body, ${String(tokenUsable)} usable with a token`,
    );
    expect(operations).toBeGreaterThan(550);
    expect(tokenUsable).toBeGreaterThan(300);
  });

  it('has examples for the main flows', () => {
    for (const key of Object.keys(OPENAPI_EXAMPLES)) {
      const [method = '', url = ''] = key.split(' ');
      const op = doc.paths[url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')]?.[method.toLowerCase()];
      expect(op, key).toBeDefined();
      const ex = OPENAPI_EXAMPLES[key];
      if (ex?.request !== undefined) {
        const media = op?.requestBody?.content?.['application/json'];
        expect(media?.examples ?? media?.example, `${key} request example`).toBeDefined();
      }
      if (ex?.response !== undefined) {
        const answer = Object.entries(op?.responses ?? {}).find(([s]) => /^2\d\d$/.test(s))?.[1];
        const media = answer?.content?.['application/json'];
        expect(media?.examples, `${key} response example`).toBeDefined();
      }
    }
    for (const k of [
      'POST /jobs',
      'GET /jobs/:id',
      'GET /jobs',
      'POST /jobs/:id/cancel',
      'POST /workflows/:id/runs',
      'GET /deploy/actions/:id',
    ]) {
      expect(Object.keys(OPENAPI_EXAMPLES)).toContain(k);
    }
  });
});
