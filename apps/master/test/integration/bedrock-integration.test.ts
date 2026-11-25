import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { BedrockEmbedder, DEFAULT_BEDROCK_MODEL, LocalHashEmbedder } from '../../src/search/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p10-bedrock-integration-panel (docs/design/p10-semantic-memory.md §11): Settings → Integrations → AWS Bedrock
 * against Postgres, with the real AWS SDK talking to a fake Bedrock endpoint (the one p10-semantic-memory uses). The
 * master starts with an env Bedrock provider using the SDK default chain ("instance role", us-east-1); the panel
 * then takes precedence, its keys reach the SDK only as static credentials (SigV4 header), a region / model change
 * is audited and rebuilds the index, and removing the panel falls back to the environment.
 */

const PW = 'quartz-meadow-lantern-7';
const KEY_ID = 'AKIAPANELTESTKEY0001';
const SECRET = 'pAnElSeCrEt/0123456789+abcdefghijklmnopq';
const KEY_ID_2 = 'AKIAPANELTESTKEY0002';
const SECRET_2 = 'pAnElSeCrEt/9876543210+abcdefghijklmnopq';
const AWS_MESSAGE = 'User: arn:aws:iam::123456789012:user/remyral is not authorized';

interface Seen {
  readonly url: string | undefined;
  readonly authorization: string;
  readonly body: Record<string, unknown>;
}

let server: Http2Server;
let endpoint = '';
const seen: Seen[] = [];
let failWith: { status: number; type: string } | null = null;
const spaces = new Map<number, LocalHashEmbedder>();
let h: Harness;

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}
const people = {} as Record<'owner' | 'admin' | 'operator', Person>;

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { secret } = await enroll(h, username, PW);
  return { id, secret, client: await fullLogin(h, username, PW, secret) };
}

async function stepUp(p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

interface Status {
  integration: {
    settings: { region: string; model: string };
    keyIdHint: string;
    keyFingerprint: string;
    usable: boolean;
    lastTest: Record<string, unknown> | null;
  } | null;
  active: {
    provider: string | null;
    model: string | null;
    region: string | null;
    source: string | null;
    panelInUse: boolean;
    panelInactiveReason: string | null;
  };
  env: { searchProvider: string; region: string | null };
  options: { regions: string[]; models: string[]; defaultModel: string };
}

async function status(p: Person = people.admin): Promise<Status> {
  const res = await p.client.req('GET', '/integrations/bedrock');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Status>();
}

async function save(body: Record<string, unknown>, p: Person = people.admin) {
  await stepUp(p);
  return p.client.req('PUT', '/integrations/bedrock', body);
}

async function providerChanges(): Promise<
  { actor_type: string; actor_id: string; metadata: Record<string, unknown> }[]
> {
  const { rows } = await h.db.pool.query<{
    actor_type: string;
    actor_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_type, actor_id, metadata FROM audit_events
      WHERE action = 'context.search.provider_changed' ORDER BY id`,
  );
  return rows;
}

async function vectorModels(): Promise<string[]> {
  const { rows } = await h.db.pool.query<{ model: string }>(
    'SELECT DISTINCT model FROM search_embeddings ORDER BY model',
  );
  return rows.map((r) => r.model);
}

function credentialOf(headers: IncomingHttpHeaders): string {
  return String(headers.authorization);
}

describeIntegration('Settings → Integrations → AWS Bedrock (integration)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        seen.push({ url: req.url, authorization: credentialOf(req.headers), body });
        if (failWith !== null) {
          res.writeHead(failWith.status, {
            'content-type': 'application/json',
            'x-amzn-errortype': failWith.type,
          });
          res.end(JSON.stringify({ message: AWS_MESSAGE }));
          return;
        }
        const dims = typeof body.output_dimension === 'number' ? body.output_dimension : 1024;
        const local = spaces.get(dims) ?? new LocalHashEmbedder(dims);
        spaces.set(dims, local);
        const texts = Array.isArray(body.texts) ? (body.texts as string[]) : [String(body.inputText)];
        void local.embed(texts).then((vs) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify(
              Array.isArray(body.texts)
                ? { embeddings: vs.map((v) => Array.from(v)) }
                : { embedding: Array.from(vs[0] ?? []) },
            ),
          );
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    // The env provider: SEARCH_PROVIDER=bedrock in us-east-1 with no keys in the environment (instance role). Its
    // credentials here are a test stand-in for the default chain.
    const envEmbedder = new BedrockEmbedder({
      region: 'us-east-1',
      modelId: DEFAULT_BEDROCK_MODEL,
      endpoint,
      credentials: { accessKeyId: 'AKIDENVCHAIN', secretAccessKey: 'env-chain-secret-not-the-panel-key' },
    });
    h = new Harness();
    await h.start({
      search: {
        embedder: envEmbedder,
        envMode: 'bedrock',
        envCredentialSource: 'instance role',
        bedrockEndpoint: endpoint,
        bedrockTestTimeoutMs: 5_000,
      },
    });
    people.owner = await person('bowner', 'owner', []);
    people.admin = await person('badmin', 'admin', []);
    people.operator = await person('boper', 'operator', ['bp']);
    // A consented namespace with one document, indexed through the env provider.
    const doc = await people.admin.client.req('POST', '/context/docs', {
      namespace: 'project:bp',
      kind: 'reference',
      title: 'Paket yöneticisi',
      content: 'Bu depo pnpm kullanır; testlerden önce lint çalıştırılır.',
    });
    expect(doc.statusCode, doc.body).toBe(201);
    await stepUp(people.admin);
    const consent = await people.admin.client.req('PUT', '/context/search/settings', {
      namespace: 'project:bp',
      enabled: true,
      expectedVersion: 0,
    });
    expect(consent.statusCode, consent.body).toBe(200);
    await h.app.semanticSearch.sync();
  });
  afterAll(async () => {
    await h.stop();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('without a panel row the environment is active: SDK default chain shown as "instance role"', async () => {
    const s = await status(people.owner);
    expect(s.integration).toBeNull();
    expect(s.active).toEqual({
      provider: 'bedrock',
      model: 'bedrock:cohere.embed-multilingual-v3',
      region: 'us-east-1',
      source: 'instance role',
      panelInUse: false,
      panelInactiveReason: null,
    });
    expect(s.env).toEqual({ searchProvider: 'bedrock', region: 'us-east-1' });
    expect(s.options.models).toEqual([
      'cohere.embed-multilingual-v3',
      'cohere.embed-v4:0',
      'amazon.titan-embed-text-v2:0',
    ]);
    expect(s.options.defaultModel).toBe('cohere.embed-multilingual-v3');
    expect(await vectorModels()).toEqual(['bedrock:cohere.embed-multilingual-v3']);
    const ctx = await people.admin.client.req('GET', '/context/search/settings?namespace=project:bp');
    expect(ctx.json()).toMatchObject({ source: 'instance role', region: 'us-east-1', provider: 'bedrock' });
  });

  it('operators cannot read or change it; writes need an always-fresh step-up', async () => {
    expect((await people.operator.client.req('GET', '/integrations/bedrock')).statusCode).toBe(403);
    const asOperator = await people.operator.client.req('PUT', '/integrations/bedrock', {
      region: 'eu-central-1',
      model: DEFAULT_BEDROCK_MODEL,
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
    });
    expect(asOperator.statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    const stale = await people.admin.client.req('PUT', '/integrations/bedrock', {
      region: 'eu-central-1',
      model: DEFAULT_BEDROCK_MODEL,
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: 'step_up_required' });
    expect((await status()).integration).toBeNull();
  });

  it('validates the keys: both or neither, AKIA… id, 40-character secret; the first save needs them', async () => {
    const missing = await save({ region: 'eu-central-1', model: DEFAULT_BEDROCK_MODEL });
    expect(missing.json()).toMatchObject({ error: 'keys_required' });
    const half = await save({ region: 'eu-central-1', model: DEFAULT_BEDROCK_MODEL, accessKeyId: KEY_ID });
    expect(half.json()).toMatchObject({ error: 'keys_incomplete' });
    const badId = await save({
      region: 'eu-central-1',
      model: DEFAULT_BEDROCK_MODEL,
      accessKeyId: 'ASIATEMPORARYKEY0001',
      secretAccessKey: SECRET,
    });
    expect(badId.json()).toMatchObject({ error: 'invalid_access_key_id' });
    const badModel = await save({
      region: 'eu-central-1',
      model: 'cohere.embed-english-v2',
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
    });
    expect(badModel.json()).toMatchObject({ error: 'invalid_settings' });
  });

  it('saving from the panel takes precedence over env, stores the keys encrypted and never returns them', async () => {
    const res = await save({
      region: 'eu-central-1',
      model: DEFAULT_BEDROCK_MODEL,
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(KEY_ID);
    expect(res.json()).toMatchObject({
      settings: { region: 'eu-central-1', model: DEFAULT_BEDROCK_MODEL },
      keyIdHint: '0001',
      usable: true,
      lastTest: null,
    });
    const s = await status();
    expect(s.active).toMatchObject({ source: 'panel', region: 'eu-central-1', panelInUse: true });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    const { rows } = await h.db.pool.query<{ config: unknown; secret: Buffer }>(
      `SELECT config, secret FROM ops_integrations WHERE provider = 'bedrock'`,
    );
    expect(rows[0]?.secret.toString('latin1')).not.toContain(SECRET);
    expect(rows[0]?.secret.toString('latin1')).not.toContain(KEY_ID);
    expect(JSON.stringify(rows[0]?.config)).not.toContain(KEY_ID);
    // Settings → Context names the source.
    const ctx = await people.admin.client.req('GET', '/context/search/settings?namespace=project:bp');
    expect(ctx.json()).toMatchObject({ source: 'panel', region: 'eu-central-1' });
    // Same model, other region: audited with the person, every vector dropped, rebuilt by the next pass.
    const changes = await providerChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor_type: 'user',
      actor_id: people.admin.id,
      metadata: {
        before: 'bedrock:cohere.embed-multilingual-v3',
        after: 'bedrock:cohere.embed-multilingual-v3',
        beforeRegion: 'us-east-1',
        afterRegion: 'eu-central-1',
        source: 'panel',
        removedVectors: 1,
      },
    });
    expect(await vectorModels()).toEqual([]);
    seen.length = 0;
    const stats = await h.app.semanticSearch.sync();
    expect(stats.indexedDocs).toBe(1);
    // The panel keys reach the SDK as static credentials: the SigV4 credential scope names them and the region.
    expect(seen.at(-1)?.authorization).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/eu-central-1/bedrock/aws4_request, `),
    );
    expect(seen.at(-1)?.authorization).not.toContain(SECRET);
    // Never through the process environment.
    expect(process.env.AWS_ACCESS_KEY_ID ?? '').not.toBe(KEY_ID);
    expect(process.env.AWS_SECRET_ACCESS_KEY ?? '').not.toBe(SECRET);
  });

  it('"Test connection" embeds a Turkish + English sample and reports dimensions and latency', async () => {
    seen.length = 0;
    const res = await people.admin.client.req('POST', '/integrations/bedrock/test');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      region: 'eu-central-1',
      model: DEFAULT_BEDROCK_MODEL,
      dims: 1024,
      vectors: 2,
    });
    expect(typeof res.json<{ latencyMs: unknown }>().latencyMs).toBe('number');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/model/cohere.embed-multilingual-v3/invoke');
    const texts = seen[0]?.body.texts as string[];
    expect(texts.some((t) => /[ışğüöç]/.test(t))).toBe(true);
    expect(texts.some((t) => /^Project memory/.test(t))).toBe(true);
    expect((await status()).integration?.lastTest).toMatchObject({ ok: true, dims: 1024 });
  });

  it('a failed test names only the AWS error type and HTTP status, with a hint', async () => {
    failWith = { status: 403, type: 'AccessDeniedException' };
    try {
      const res = await people.admin.client.req('POST', '/integrations/bedrock/test');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        ok: false,
        error: 'AccessDeniedException',
        httpStatus: 403,
        hint: expect.stringMatching(/IAM policy/) as unknown,
      });
      expect(res.body).not.toContain('123456789012');
    } finally {
      failWith = null;
    }
    const { rows } = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
      `SELECT outcome, metadata FROM audit_events WHERE action = 'ops.integration.bedrock.test' ORDER BY id`,
    );
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'failure']);
    expect(rows[1]?.metadata).toMatchObject({ ok: false, error: 'AccessDeniedException', httpStatus: 403 });
    expect(JSON.stringify(rows)).not.toContain('123456789012');
  });

  it('new keys alone do not rebuild the index; a model change does (audited, old vectors dropped)', async () => {
    const keysOnly = await save({
      region: 'eu-central-1',
      model: DEFAULT_BEDROCK_MODEL,
      accessKeyId: KEY_ID_2,
      secretAccessKey: SECRET_2,
    });
    expect(keysOnly.statusCode, keysOnly.body).toBe(200);
    expect(keysOnly.json()).toMatchObject({ keyIdHint: '0002', lastTest: null });
    expect(await providerChanges()).toHaveLength(1);
    expect(await vectorModels()).toEqual(['bedrock:cohere.embed-multilingual-v3']);

    // Keys kept (omitted), model changed.
    const v4 = await save({ region: 'eu-central-1', model: 'cohere.embed-v4:0' });
    expect(v4.statusCode, v4.body).toBe(200);
    expect(v4.json()).toMatchObject({ keyIdHint: '0002', settings: { model: 'cohere.embed-v4:0' } });
    const changes = await providerChanges();
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      actor_type: 'user',
      metadata: {
        before: 'bedrock:cohere.embed-multilingual-v3',
        after: 'bedrock:cohere.embed-v4:0',
        removedVectors: 1,
      },
    });
    seen.length = 0;
    await h.app.semanticSearch.sync();
    await h.app.semanticSearch.sync();
    expect(await vectorModels()).toEqual(['bedrock:cohere.embed-v4:0']);
    expect(seen[0]?.authorization).toContain(`Credential=${KEY_ID_2}/`);
    expect(seen[0]?.body).toMatchObject({ output_dimension: 1536 });
    // The indexer does not audit the same change again.
    expect(await providerChanges()).toHaveLength(2);
  });

  it('the keys appear in no audit row and no log line', async () => {
    const { rows } = await h.db.pool.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM audit_events WHERE action LIKE 'ops.integration.bedrock.%' ORDER BY id`,
    );
    expect(rows.map((r) => r.action)).toContain('ops.integration.bedrock.save');
    const everything = JSON.stringify((await h.db.pool.query('SELECT metadata FROM audit_events')).rows);
    for (const secret of [SECRET, SECRET_2, KEY_ID, KEY_ID_2]) {
      expect(everything).not.toContain(secret);
      expect(h.logs.text).not.toContain(secret);
    }
  });

  it('Remove falls back to the environment (instance role, us-east-1) and rebuilds for it', async () => {
    await stepUp(people.admin);
    const res = await people.admin.client.req('DELETE', '/integrations/bedrock');
    expect(res.statusCode, res.body).toBe(204);
    const s = await status();
    expect(s.integration).toBeNull();
    expect(s.active).toMatchObject({
      source: 'instance role',
      region: 'us-east-1',
      model: 'bedrock:cohere.embed-multilingual-v3',
      panelInUse: false,
    });
    const changes = await providerChanges();
    expect(changes).toHaveLength(3);
    expect(changes[2]).toMatchObject({
      actor_type: 'user',
      metadata: { before: 'bedrock:cohere.embed-v4:0', after: 'bedrock:cohere.embed-multilingual-v3' },
    });
    await h.app.semanticSearch.sync();
    expect(await vectorModels()).toEqual(['bedrock:cohere.embed-multilingual-v3']);
    await stepUp(people.admin);
    const again = await people.admin.client.req('DELETE', '/integrations/bedrock');
    expect(again.statusCode).toBe(404);
  });
});
