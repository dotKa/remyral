import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEventInput, AuditRecorder } from '../../src/audit/audit.js';
import { ConfigError, loadConfig } from '../../src/config.js';
import type { ContextPolicyService } from '../../src/context/policy.js';
import {
  cosine,
  EmbeddingError,
  HttpEmbedder,
  l2normalize,
  LocalHashEmbedder,
} from '../../src/search/index.js';
import { clip, docText, MAX_EMBED_CHARS, SearchService } from '../../src/search/service.js';

const norm = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('LocalHashEmbedder', () => {
  const e = new LocalHashEmbedder();

  it('is deterministic, unit length and names its vector space', async () => {
    const [a, b] = await e.embed(['Roll back the deployment', 'Roll back the deployment']);
    expect(e.model).toBe('local-hash/v1:512');
    expect(a).toEqual(b);
    expect(a?.length).toBe(512);
    expect(norm(a ?? new Float32Array())).toBeCloseTo(1, 5);
    // Stable across processes: a golden bucket check.
    const again = await new LocalHashEmbedder().embed(['Roll back the deployment']);
    expect(Array.from(again[0] ?? [])).toEqual(Array.from(a ?? []));
  });

  it('ranks lexically related text above unrelated text', async () => {
    const [q, near, far] = await e.embed([
      'how to roll back a kubernetes deployment',
      'Deploy runbook: kubectl rollout undo rolls back a deployment',
      'Descale the coffee machine every month',
    ]);
    expect(cosine(q ?? [], near ?? [])).toBeGreaterThan(cosine(q ?? [], far ?? []));
  });

  it('handles empty and non-latin text', async () => {
    const [empty, jp] = await e.embed(['', 'デプロイのロールバック']);
    expect(norm(empty ?? new Float32Array())).toBe(0);
    expect(norm(jp ?? new Float32Array())).toBeCloseTo(1, 5);
    expect(() => new LocalHashEmbedder(8)).toThrow(RangeError);
  });

  it('cosine of mismatched vectors is -1; normalize keeps zero vectors', () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(-1);
    expect(Array.from(l2normalize(new Float32Array([0, 0])))).toEqual([0, 0]);
    expect(Array.from(l2normalize(new Float32Array([3, 4])))).toEqual([
      0.6000000238418579, 0.800000011920929,
    ]);
  });
});

describe('HttpEmbedder (OpenAI-compatible /v1/embeddings)', () => {
  let server: Server;
  let url = '';
  let mode: 'ok' | 'shuffled' | 'error' | 'garbage' | 'inconsistent' = 'ok';
  const seen: { auth: string | undefined; body: Record<string, unknown> }[] = [];

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      void body(req).then((b) => {
        seen.push({ auth: req.headers.authorization, body: b });
        const input = b.input as string[];
        if (mode === 'error') {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad key sk-echo"}');
          return;
        }
        if (mode === 'garbage') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":"nope"}');
          return;
        }
        const data = input.map((t, i) => ({
          object: 'embedding',
          index: i,
          embedding: mode === 'inconsistent' && i === 1 ? [1, 2] : [t.length, 1, 0],
        }));
        if (mode === 'shuffled') data.reverse();
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ object: 'list', data, model: b.model, usage: { total_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/embeddings`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
  });

  it('sends model, input and dimensions with a bearer key and returns unit vectors in input order', async () => {
    mode = 'shuffled';
    const e = new HttpEmbedder({
      url,
      model: 'text-embedding-3-small',
      apiKey: 'sk-test-key',
      dimensions: 3,
    });
    expect(e.model).toBe('http:text-embedding-3-small:3');
    const [a, b] = await e.embed(['abc', 'abcdef']);
    expect(seen.at(-1)).toEqual({
      auth: 'Bearer sk-test-key',
      body: { model: 'text-embedding-3-small', input: ['abc', 'abcdef'], dimensions: 3 },
    });
    expect(norm(a ?? new Float32Array())).toBeCloseTo(1, 5);
    expect((a?.[0] ?? 0) < (b?.[0] ?? 0)).toBe(true); // 'abc' (3) before 'abcdef' (6)
  });

  it('fails closed without leaking the key, the text or the provider body', async () => {
    const e = new HttpEmbedder({ url, model: 'm', apiKey: 'sk-secret-123' });
    for (const m of ['error', 'garbage', 'inconsistent'] as const) {
      mode = m;
      const err = await e.embed(['private text', 'more']).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(EmbeddingError);
      const msg = (err as Error).message;
      expect(msg).not.toContain('sk-secret-123');
      expect(msg).not.toContain('private text');
      expect(msg).not.toContain('sk-echo');
    }
    const down = new HttpEmbedder({
      url: 'http://127.0.0.1:1/v1/embeddings',
      model: 'm',
      apiKey: 'k',
      timeoutMs: 2000,
    });
    await expect(down.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(
      new HttpEmbedder({ url, model: 'm', apiKey: 'k', maxBatch: 1 }).embed(['a', 'b']),
    ).rejects.toThrow(EmbeddingError);
    expect(() => new HttpEmbedder({ url, model: 'bad model id', apiKey: 'k' })).toThrow(RangeError);
  });
});

describe('SearchService guards (no database needed)', () => {
  const events: AuditEventInput[] = [];
  const audit: AuditRecorder = {
    record: (e) => {
      events.push(e);
      return Promise.resolve({ id: '1', hash: Buffer.alloc(0) });
    },
  };
  const fresh = { id: '00000000-0000-4000-8000-000000000009', role: 'admin' as const, mfaAt: new Date() };
  const svc = new SearchService({
    pool: {} as pg.Pool,
    audit,
    policy: {} as ContextPolicyService,
    embedder: null,
  });

  it('without a provider, consent cannot be enabled (audited as denied) and search is unavailable', async () => {
    await expect(
      svc.setConsent(fresh, { namespace: 'project:a', enabled: true, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: 'search_unavailable', httpStatus: 409 });
    expect(events.at(-1)).toMatchObject({ action: 'context.search.consent', outcome: 'denied' });
    expect(events.at(-1)?.metadata).toMatchObject({ code: 'search_unavailable' });
    await expect(svc.search(fresh, 'a', 'x')).rejects.toMatchObject({ code: 'search_unavailable' });
  });

  it('rejects skill namespaces, missing roles and stale step-up before touching anything', async () => {
    await expect(
      svc.setConsent(fresh, { namespace: 'skill:x', enabled: false, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      svc.setConsent(
        { ...fresh, role: 'operator' },
        { namespace: 'project:a', enabled: false, expectedVersion: 0 },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      svc.setConsent(
        { ...fresh, mfaAt: new Date(Date.now() - 3_600_000) },
        {
          namespace: 'project:a',
          enabled: false,
          expectedVersion: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(
      svc.search({ ...fresh, role: 'viewer', projectRole: () => null }, 'a', 'x'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('clips embedded text without splitting surrogate pairs', () => {
    expect(clip('abc', 2)).toBe('ab');
    expect(clip('a😀', 2)).toBe('a');
    expect(docText('T', 'x'.repeat(10_000)).length).toBe(MAX_EMBED_CHARS);
  });
});

describe('config: SEARCH_PROVIDER', () => {
  const base = {
    DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
    REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
    TOTP_KEY_FILE: '/abs/totp.key',
  };

  it('is off by default; local-hash needs nothing; http needs URL, model and key file (https or loopback)', () => {
    expect(loadConfig(base, '/cwd').search).toBeNull();
    expect(loadConfig({ ...base, SEARCH_PROVIDER: 'local-hash' }, '/cwd').search).toEqual({
      provider: { kind: 'local-hash' },
      intervalMs: 60_000,
    });
    expect(
      loadConfig(
        {
          ...base,
          SEARCH_PROVIDER: 'http',
          SEARCH_HTTP_URL: 'https://api.voyageai.com/v1/embeddings',
          SEARCH_HTTP_MODEL: 'voyage-4-large',
          SEARCH_HTTP_KEY_FILE: 'secrets/embed.key',
        },
        '/cwd',
      ).search,
    ).toEqual({
      provider: {
        kind: 'http',
        url: 'https://api.voyageai.com/v1/embeddings',
        model: 'voyage-4-large',
        keyFile: resolve('/cwd/secrets/embed.key'),
        dimensions: null,
      },
      intervalMs: 60_000,
    });
    expect(() => loadConfig({ ...base, SEARCH_PROVIDER: 'http' }, '/cwd')).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        {
          ...base,
          SEARCH_PROVIDER: 'http',
          SEARCH_HTTP_URL: 'http://embed.example/v1/embeddings',
          SEARCH_HTTP_MODEL: 'm',
          SEARCH_HTTP_KEY_FILE: '/k',
        },
        '/cwd',
      ),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SEARCH_HTTP_MODEL: 'm' }, '/cwd')).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SEARCH_PROVIDER: 'pgvector' }, '/cwd')).toThrow(ConfigError);
  });
});
