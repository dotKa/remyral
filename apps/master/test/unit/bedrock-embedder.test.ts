import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { GitExec } from '../../src/gitflow/git-exec.js';
import {
  BedrockEmbedder,
  type BedrockInvoke,
  bedrockModelSpec,
  DEFAULT_BEDROCK_MODEL,
  EmbeddingError,
} from '../../src/search/index.js';

/**
 * p10-semantic-memory (docs/design/p10-semantic-memory.md §3): the Amazon Bedrock embedder — request shapes per model
 * family (Cohere Embed v3 / v4, Titan V2) as documented in the Bedrock user guide, input_type per purpose, response
 * validation, errors without secrets, and the real AWS SDK against a fake Bedrock endpoint (SigV4-signed requests).
 */

const vec = (n: number, seed = 1): number[] =>
  Array.from({ length: n }, (_, i) => ((i * seed) % 7) - 3 || 0.5);

function recorder(respond: (body: Record<string, unknown>, modelId: string) => unknown) {
  const calls: { modelId: string; body: Record<string, unknown> }[] = [];
  const invoke: BedrockInvoke = (modelId, body) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    calls.push({ modelId, body: parsed });
    return Promise.resolve(JSON.stringify(respond(parsed, modelId)));
  };
  return { calls, invoke };
}

describe('BedrockEmbedder (unit)', () => {
  it('defaults to Cohere Embed Multilingual v3: texts + input_type search_document / search_query, 1024 dims', async () => {
    const r = recorder((b) => ({
      embeddings: (b.texts as string[]).map((_, i) => vec(1024, i + 2)),
      id: 'x',
    }));
    const e = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      invoke: r.invoke,
    });
    expect(e.model).toBe('bedrock:cohere.embed-multilingual-v3');
    expect({ provider: e.provider, dims: e.dims, maxBatch: e.maxBatch, maxChars: e.maxChars }).toEqual({
      provider: 'bedrock',
      dims: 1024,
      maxBatch: 96,
      maxChars: 2048,
    });
    const out = await e.embed(['Bu depo pnpm kullanıyor.', 'Deploy needs the staging secret']);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(1024);
    const norm = Math.sqrt(out[0]?.reduce((s, x) => s + x * x, 0) ?? 0);
    expect(norm).toBeCloseTo(1, 5);
    await e.embed(['hangi paket yöneticisi?'], 'query');
    expect(r.calls.map((c) => c.modelId)).toEqual([
      'cohere.embed-multilingual-v3',
      'cohere.embed-multilingual-v3',
    ]);
    expect(r.calls[0]?.body).toEqual({
      texts: ['Bu depo pnpm kullanıyor.', 'Deploy needs the staging secret'],
      input_type: 'search_document',
      truncate: 'END',
    });
    expect(r.calls[1]?.body).toMatchObject({ input_type: 'search_query' });
  });

  it('Cohere Embed v4: embedding_types float, output_dimension, both documented response shapes', async () => {
    let shape: 'array' | 'byType' = 'byType';
    const r = recorder((b) => {
      const vs = (b.texts as string[]).map(() => vec(512));
      return shape === 'array'
        ? { embeddings: vs }
        : { embeddings: { float: vs }, response_type: 'embeddings_by_type' };
    });
    const e = new BedrockEmbedder({
      region: 'us-east-1',
      modelId: 'cohere.embed-v4:0',
      dimensions: 512,
      invoke: r.invoke,
    });
    expect(e.model).toBe('bedrock:cohere.embed-v4:0:512');
    expect((await e.embed(['a learning'])).at(0)).toHaveLength(512);
    shape = 'array';
    expect((await e.embed(['another'])).at(0)).toHaveLength(512);
    expect(r.calls[0]?.body).toEqual({
      texts: ['a learning'],
      input_type: 'search_document',
      embedding_types: ['float'],
      output_dimension: 512,
      truncate: 'RIGHT',
    });
    // Inference-profile prefixes are accepted for v4; the default v4 space is 1536 dims.
    expect(
      new BedrockEmbedder({ region: 'eu-west-1', modelId: 'eu.cohere.embed-v4:0', invoke: r.invoke }).model,
    ).toBe('bedrock:eu.cohere.embed-v4:0');
  });

  it('Titan Text Embeddings V2: one inputText per call with dimensions and normalize', async () => {
    const r = recorder(() => ({ embedding: vec(256), inputTextTokenCount: 3 }));
    const e = new BedrockEmbedder({
      region: 'us-west-2',
      modelId: 'amazon.titan-embed-text-v2:0',
      dimensions: 256,
      invoke: r.invoke,
    });
    expect(e.maxBatch).toBe(1);
    await e.embed(['tek metin']);
    expect(r.calls[0]?.body).toEqual({ inputText: 'tek metin', dimensions: 256, normalize: true });
    await expect(e.embed(['a', 'b'])).rejects.toThrow(EmbeddingError);
  });

  it('refuses unknown models, bad regions, unsupported dimensions and over-long texts', async () => {
    const r = recorder(() => ({ embeddings: [vec(1024)] }));
    expect(
      () =>
        new BedrockEmbedder({ region: 'eu-central-1', modelId: 'cohere.embed-english-v2', invoke: r.invoke }),
    ).toThrow(RangeError);
    expect(
      () => new BedrockEmbedder({ region: 'Frankfurt', modelId: DEFAULT_BEDROCK_MODEL, invoke: r.invoke }),
    ).toThrow(RangeError);
    expect(
      () =>
        new BedrockEmbedder({
          region: 'eu-central-1',
          modelId: DEFAULT_BEDROCK_MODEL,
          dimensions: 512,
          invoke: r.invoke,
        }),
    ).toThrow(RangeError);
    const e = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      invoke: r.invoke,
    });
    await expect(e.embed(['x'.repeat(2049)])).rejects.toThrow(EmbeddingError);
    expect(r.calls).toHaveLength(0);
    expect(bedrockModelSpec('cohere.embed-multilingual-v3')?.family).toBe('cohere-v3');
  });

  it('rejects inconsistent responses and never leaks the SDK message (which may carry account details)', async () => {
    const wrongDims = recorder(() => ({ embeddings: [vec(768)] }));
    const e1 = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      invoke: wrongDims.invoke,
    });
    await expect(e1.embed(['x'])).rejects.toThrow(/missing or inconsistent/);
    const missing = recorder(() => ({ embeddings: [] }));
    const e2 = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      invoke: missing.invoke,
    });
    await expect(e2.embed(['x'])).rejects.toThrow(EmbeddingError);
    const garbage: BedrockInvoke = () => Promise.resolve('<html>');
    const e3 = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      invoke: garbage,
    });
    await expect(e3.embed(['x'])).rejects.toThrow(/unexpected response/);
    const denied: BedrockInvoke = () =>
      Promise.reject(
        Object.assign(
          new Error('User arn:aws:iam::123456789012:user/remyral is not authorized; key AKIAEXAMPLEEXAMPLE'),
          {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          },
        ),
      );
    const e4 = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      invoke: denied,
    });
    const err = (await e4.embed(['secret text']).catch((x: unknown) => x)) as Error;
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.message).toBe('Bedrock embedding call failed (AccessDeniedException, HTTP 403)');
    expect(err.message).not.toMatch(/arn:|AKIA|secret text/);
  });
});

describe('BedrockEmbedder through the AWS SDK against a fake Bedrock endpoint (unit)', () => {
  // The Bedrock runtime client talks HTTP/2 (its default handler); the fake endpoint is cleartext h2.
  let server: Http2Server;
  let endpoint: string;
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] =
    [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (status !== 200) {
          res.writeHead(status, {
            'content-type': 'application/json',
            'x-amzn-errortype': 'AccessDeniedException',
          });
          res.end(
            JSON.stringify({
              message: 'not authorized for arn:aws:bedrock:eu-central-1::foundation-model/x',
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ embeddings: ((body.texts as string[] | undefined) ?? []).map(() => vec(1024)) }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('signs InvokeModel with SigV4 for the bedrock service and posts the documented body', async () => {
    const e = new BedrockEmbedder({
      region: 'eu-central-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      endpoint,
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
    });
    const out = await e.embed(['Relackout marka rengi #FF5A1F'], 'document');
    expect(out[0]).toHaveLength(1024);
    const req = seen.at(-1);
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/model/cohere.embed-multilingual-v3/invoke');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(String(req?.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/,
    );
    expect(String(req?.headers.authorization)).not.toContain('wJalrXUtnFEMI');
    expect(req?.body).toEqual({
      texts: ['Relackout marka rengi #FF5A1F'],
      input_type: 'search_document',
      truncate: 'END',
    });
  });

  it('turns an AWS error into an EmbeddingError naming only the error type and status', async () => {
    status = 403;
    try {
      const e = new BedrockEmbedder({
        region: 'eu-central-1',
        modelId: DEFAULT_BEDROCK_MODEL,
        endpoint,
        credentials: {
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        },
      });
      const err = (await e.embed(['x']).catch((x: unknown) => x)) as Error;
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err.message).toMatch(/^Bedrock embedding call failed \(AccessDeniedException, HTTP 403\)$/);
    } finally {
      status = 200;
    }
  });
});

describe('Bedrock search configuration (unit)', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379/0',
    TOTP_KEY_FILE: '/run/secrets/totp.key',
  };

  it('SEARCH_PROVIDER=bedrock: region from SEARCH_BEDROCK_REGION or AWS_REGION, default model, no credentials in config', () => {
    const c = loadConfig({
      ...base,
      SEARCH_PROVIDER: 'bedrock',
      SEARCH_BEDROCK_REGION: 'eu-central-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE12',
      AWS_SECRET_ACCESS_KEY: 'never-in-the-config',
    });
    expect(c.search?.provider).toEqual({
      kind: 'bedrock',
      region: 'eu-central-1',
      model: 'cohere.embed-multilingual-v3',
      dimensions: null,
    });
    expect(JSON.stringify(c)).not.toMatch(/AKIAEXAMPLE|never-in-the-config/);
    const viaAws = loadConfig({ ...base, SEARCH_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' });
    expect(viaAws.search?.provider).toMatchObject({ region: 'us-east-1' });
    const v4 = loadConfig({
      ...base,
      SEARCH_PROVIDER: 'bedrock',
      SEARCH_BEDROCK_REGION: 'us-east-1',
      SEARCH_BEDROCK_MODEL: 'cohere.embed-v4:0',
      SEARCH_BEDROCK_DIMENSIONS: '1024',
    });
    expect(v4.search?.provider).toMatchObject({ model: 'cohere.embed-v4:0', dimensions: 1024 });
    expect(loadConfig(base).memorySuggestions).toEqual({
      intervalMs: 60_000,
      duplicateThreshold: 0.9,
      chatPerThreadPerDay: 5,
      // p17-auto-learning: MEMORY_AUTO_LEARN, on unless switched off.
      autoLearn: true,
    });
    expect(loadConfig({ ...base, MEMORY_AUTO_LEARN: 'off' }).memorySuggestions.autoLearn).toBe(false);
    expect(() => loadConfig({ ...base, MEMORY_AUTO_LEARN: 'maybe' })).toThrow(/MEMORY_AUTO_LEARN/);
  });

  it('fails fast on a missing region, an unknown model, wrong dimensions or stray Bedrock settings', () => {
    expect(() => loadConfig({ ...base, SEARCH_PROVIDER: 'bedrock' })).toThrow(/SEARCH_BEDROCK_REGION/);
    expect(() =>
      loadConfig({
        ...base,
        SEARCH_PROVIDER: 'bedrock',
        AWS_REGION: 'us-east-1',
        SEARCH_BEDROCK_MODEL: 'cohere.embed-english-v2',
      }),
    ).toThrow(/SEARCH_BEDROCK_MODEL/);
    expect(() =>
      loadConfig({
        ...base,
        SEARCH_PROVIDER: 'bedrock',
        AWS_REGION: 'us-east-1',
        SEARCH_BEDROCK_DIMENSIONS: '512',
      }),
    ).toThrow(/SEARCH_BEDROCK_DIMENSIONS/);
    expect(() => loadConfig({ ...base, SEARCH_BEDROCK_REGION: 'eu-central-1' })).toThrow(/only meaningful/);
    expect(() =>
      loadConfig({ ...base, SEARCH_PROVIDER: 'bedrock', SEARCH_BEDROCK_REGION: 'Frankfurt' }),
    ).toThrow(/SEARCH_BEDROCK_REGION/);
    expect(() => loadConfig({ ...base, MEMORY_DUPLICATE_THRESHOLD: '1.5' })).toThrow(
      /MEMORY_DUPLICATE_THRESHOLD/,
    );
  });
});

describe('AWS credentials stay in the master process (unit)', () => {
  it('subprocesses the master spawns for its own repository work never inherit AWS_* variables', () => {
    const env = new GitExec({
      sourceEnv: {
        PATH: '/usr/bin',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE12',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_SESSION_TOKEN: 'token',
        AWS_REGION: 'eu-central-1',
      },
    }).env({});
    expect(Object.keys(env).filter((k) => k.startsWith('AWS_'))).toEqual([]);
    expect(env.PATH).toBe('/usr/bin');
  });
});
