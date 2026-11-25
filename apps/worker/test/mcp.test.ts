import { generateKeyPairSync, sign } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AssignedMcp,
  mcpPolicySha256,
  mcpSetHash,
  type McpSpecInput,
  type McpToolRule,
  packMcpSpec,
  SKILL_SIGNATURE_CONTEXT,
  type SignedMcpSpec,
  skillKeyId,
} from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMcpDelivery,
  checkMcpSecrets,
  mcpEgressFor,
  mcpEgressNote,
  prepareMcpConfigDir,
  withMcpSecrets,
} from '../src/mcp/delivery.js';
import { McpProbeError, probeMcpServer } from '../src/mcp/probe.js';
import { runMcpProbe } from '../src/mcp/probe-op.js';
import { verifyAssignedMcp, type VerifiedMcp } from '../src/mcp/verify.js';
import { ResolvedJobEnv } from '../src/secrets/env.js';
import { SecretString } from '../src/secrets/ref.js';
import { type FakeMcpServer, fetchVia, publicLookup, startFakeMcpServer } from './helpers/fake-mcp-server.js';
import { tempDir } from './helpers.js';

/** p14-mcp-core (ADR-0054, design §2.4 / §2.8): worker-side admission, delivery, egress and the probe client. */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = String(publicKey.export({ format: 'jwk' }).x);
const otherKey = generateKeyPairSync('ed25519');
const otherPub = String(otherKey.publicKey.export({ format: 'jwk' }).x);

const base: McpSpecInput = {
  id: 'github',
  version: '1.2.0',
  transport: 'http',
  http: {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: { secret: 'token', format: 'Bearer {}' }, 'X-Client': 'remyral' },
  },
  secrets: [{ slot: 'token', kind: 'generic', why: 'PAT' }],
  egressHosts: ['api.github.com'],
  runtimes: ['claude-code', 'codex', 'pi', 'opencode'],
  limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
  createdAt: '2026-10-20T12:00:00.000Z',
};

const rules: McpToolRule[] = [
  { tool: 'get_*', effect: 'allow' },
  { tool: 'create_issue', effect: 'ask' },
];

function signed(input: McpSpecInput = base): { signed: SignedMcpSpec; specSha256: string } {
  const p = packMcpSpec(input, privateKey, pub);
  return { signed: p.signed, specSha256: p.specSha256 };
}

function assigned(list: { input?: McpSpecInput; rules?: McpToolRule[] }[] = [{}]): AssignedMcp {
  const packed = list.map((l) => ({ ...signed(l.input), input: l.input ?? base, rules: l.rules ?? rules }));
  return {
    setHash: mcpSetHash(
      packed.map((p) => ({
        id: p.input.id,
        version: p.input.version,
        specSha256: p.specSha256,
        policySha256: mcpPolicySha256(p.rules),
      })),
    ),
    servers: packed.map((p) => p.signed),
    policies: packed.map((p) => ({ server: p.input.id, rules: p.rules })),
    secrets: packed.flatMap((p) =>
      p.input.secrets.map((s) => ({ server: p.input.id, slot: s.slot, ref: `secret:vault-${p.input.id}` })),
    ),
  };
}

const trusted = { sourceTrust: 'trusted' as const };
const msg = (c: ReturnType<typeof verifyAssignedMcp>) => (c.ok ? '' : c.message);

describe('verifyAssignedMcp', () => {
  it('no MCP: nothing to verify', () => {
    expect(verifyAssignedMcp(undefined, 'codex', null)).toEqual({ ok: true, mcp: null });
  });

  it('accepts a signed set: specs, rules, secret refs and the attempt egress hosts', () => {
    const out = verifyAssignedMcp(assigned(), 'codex', [pub], trusted);
    expect(out.ok).toBe(true);
    if (!out.ok || out.mcp === null) return;
    expect(out.mcp.servers[0]?.spec.id).toBe('github');
    expect(out.mcp.servers[0]?.rules).toEqual(rules);
    expect(out.mcp.servers[0]?.secrets).toEqual({ token: 'secret:vault-github' });
    expect(out.mcp.egressHosts).toEqual(['api.github.com', 'mcp.example.com']);
  });

  it('refuses a bad signature, an unknown key and a skill signature replayed as a spec', () => {
    const a = assigned();
    const s = a.servers[0] as SignedMcpSpec;
    expect(msg(verifyAssignedMcp(a, 'codex', [otherPub], trusted))).toContain('unknown_key');
    const forged = {
      ...a,
      servers: [
        {
          ...s,
          spec: Buffer.from(Buffer.from(s.spec, 'base64').toString().replace('1.2.0', '1.2.1')).toString(
            'base64',
          ),
        },
      ],
    };
    expect(msg(verifyAssignedMcp(forged, 'codex', [pub], trusted))).toContain('bad_signature');
    // The same bytes signed in the skills context must never verify as an MCP spec.
    const bytes = Buffer.from(s.spec, 'base64');
    const replay = sign(
      null,
      Buffer.concat([Buffer.from(SKILL_SIGNATURE_CONTEXT), bytes]),
      privateKey,
    ).toString('base64url');
    const r = { ...a, servers: [{ spec: s.spec, signature: { keyId: skillKeyId(pub), signature: replay } }] };
    expect(msg(verifyAssignedMcp(r, 'codex', [pub], trusted))).toContain('bad_signature');
  });

  it('refuses a set hash mismatch (e.g. a changed tool policy) and policies / secrets for other servers', () => {
    const a = assigned();
    const changed = {
      ...a,
      policies: [{ server: 'github', rules: [{ tool: '*', effect: 'allow' as const }] }],
    };
    expect(msg(verifyAssignedMcp(changed, 'codex', [pub], trusted))).toContain('pinned hash');
    const extra = { ...a, policies: [...a.policies, { server: 'other', rules: [] }] };
    expect(msg(verifyAssignedMcp(extra, 'codex', [pub], trusted))).toContain('not a server of the job');
    const sec = { ...a, secrets: [...a.secrets, { server: 'github', slot: 'nope', ref: 'secret:vault-x' }] };
    expect(msg(verifyAssignedMcp(sec, 'codex', [pub], trusted))).toContain('no spec uses');
  });

  it('refuses another runtime, a duplicate server, stdio and a missing secret slot', () => {
    const sse: McpSpecInput = {
      ...base,
      transport: 'sse',
      http: undefined,
      sse: base.http,
      runtimes: ['claude-code', 'opencode'],
    };
    expect(msg(verifyAssignedMcp(assigned([{ input: sse }]), 'codex', [pub], trusted))).toContain(
      'not for runtime codex',
    );
    const two = assigned([{}, {}]);
    const dup = { ...two, secrets: two.secrets.slice(0, 1) };
    expect(msg(verifyAssignedMcp(dup, 'codex', [pub], trusted))).toContain('duplicate server');
    const stdio: McpSpecInput = {
      ...base,
      transport: 'stdio',
      http: undefined,
      stdio: {
        package: { manager: 'npm', name: 'mcp-x', version: '1.0.0', integrity: `sha512-${'A'.repeat(86)}==` },
        bin: 'mcp-x',
        env: { TOKEN: { secret: 'token' } },
      },
    };
    expect(msg(verifyAssignedMcp(assigned([{ input: stdio }]), 'codex', [pub], trusted))).toMatch(
      /^mcp_stdio_unsupported/,
    );
    const noSecret = { ...assigned(), secrets: [] };
    expect(msg(verifyAssignedMcp(noSecret, 'codex', [pub], trusted))).toMatch(
      /^mcp_verification_failed|^mcp_secret_missing/,
    );
  });

  it('local veto, untrusted / pull-request sources and a worker without keys decline', () => {
    const a = assigned();
    expect(msg(verifyAssignedMcp(a, 'codex', [pub], { ...trusted, allowMcp: false }))).toMatch(/^mcp_vetoed/);
    expect(msg(verifyAssignedMcp(a, 'codex', [pub], {}))).toMatch(/^mcp_untrusted/);
    expect(msg(verifyAssignedMcp(a, 'codex', [pub], { sourceTrust: 'untrusted' }))).toMatch(/^mcp_untrusted/);
    expect(msg(verifyAssignedMcp(a, 'codex', [pub], { ...trusted, pullRequest: true }))).toMatch(
      /^mcp_untrusted/,
    );
    expect(msg(verifyAssignedMcp(a, 'codex', null, trusted))).toMatch(/^mcp_untrusted_keys/);
  });
});

function store(values: Record<string, string>) {
  return {
    get: (name: string) => Promise.resolve(name in values ? new SecretString(values[name] as string) : null),
  };
}

function verified(a: AssignedMcp = assigned(), runtime: 'codex' | 'claude-code' = 'codex'): VerifiedMcp {
  const out = verifyAssignedMcp(a, runtime, [pub], trusted);
  if (!out.ok || out.mcp === null) throw new Error('not verified');
  return out.mcp;
}

describe('MCP secrets and delivery', () => {
  it('admission: a missing secret, a foreign reference and an unusable value ("!x", quotes) decline', async () => {
    const v = verified();
    expect(await checkMcpSecrets(v, store({ 'vault-github': 'ghp_abcdef123' }), 'w1')).toBeNull();
    expect(await checkMcpSecrets(v, store({}), 'w1')).toMatch(/^mcp_secret_missing/);
    expect(await checkMcpSecrets(v, store({ 'vault-github': '!rm -rf' }), 'w1')).toMatch(
      /^mcp_secret_invalid.*starts with !/,
    );
    expect(await checkMcpSecrets(v, store({ 'vault-github': 'a"b{env:X}' }), 'w1')).toMatch(
      /^mcp_secret_invalid/,
    );
    const foreign = verified({
      ...assigned(),
      secrets: [{ server: 'github', slot: 'token', ref: 'worker:other/secret:vault-github' }],
    });
    expect(await checkMcpSecrets(foreign, store({ 'vault-github': 'ghp_abcdef123' }), 'w1')).toMatch(
      /^mcp_secret_missing/,
    );
  });

  it('spawn: secrets join the job env as REMYRAL_MCP_<ID>_<SLOT>, registered for redaction; headers reference them', async () => {
    const v = verified();
    const leased: string[] = [];
    const env = new ResolvedJobEnv({ PATH: '/bin' }, {}, 'none');
    const out = await withMcpSecrets(
      env,
      v,
      store({ 'vault-github': 'ghp_abcdef123' }),
      { add: (_v, l) => leased.push(l) },
      'w1',
    );
    expect(out.env.env.REMYRAL_MCP_GITHUB_TOKEN).toBe('ghp_abcdef123');
    expect(Object.keys(out.env.secretEnv)).toEqual(['REMYRAL_MCP_GITHUB_TOKEN']);
    expect(out.env.publicEnv).toEqual({ PATH: '/bin' });
    expect(leased).toEqual(['REMYRAL_MCP_GITHUB_TOKEN']);
    expect(JSON.stringify(out.env)).not.toContain('ghp_abcdef123');
    const dir = await tempDir('rw-mcp-');
    const configDir = await prepareMcpConfigDir(join(dir, 'runtime'));
    if (process.platform !== 'win32') expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    const d = await buildMcpDelivery(v, out.mcpSecretEnv, configDir, { node: process.execPath });
    expect(d.configDir).toBe(configDir);
    expect(d.servers[0]).toMatchObject({
      id: 'github',
      name: 'x-github',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: {
        Authorization: { kind: 'secret', env: 'REMYRAL_MCP_GITHUB_TOKEN', format: 'Bearer {}' },
        'X-Client': { kind: 'literal', value: 'remyral' },
      },
      rules,
      startupTimeoutSec: 30,
      toolTimeoutSec: 120,
    });
    expect(JSON.stringify(d)).not.toContain('ghp_abcdef123');
    expect(d.secretEnv.REMYRAL_MCP_GITHUB_TOKEN?.reveal()).toBe('ghp_abcdef123');
  });

  it("egress: the servers' hosts for this attempt only, none under allowMcpEgress: false (and the note says so)", () => {
    const v = verified();
    expect(mcpEgressFor(v, true)).toEqual(['api.github.com', 'mcp.example.com']);
    expect(mcpEgressFor(v, false)).toEqual([]);
    expect(mcpEgressFor(null, true)).toEqual([]);
    expect(mcpEgressNote(v, true)).toContain('api.github.com, mcp.example.com');
    expect(mcpEgressNote(v, false)).toContain('allowMcpEgress: false');
  });
});

describe('MCP probe client (fake remote server)', () => {
  let server: FakeMcpServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const tools = [
    {
      name: 'get_issue',
      description: 'Read an issue',
      inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'create_issue',
      description: 'x'.repeat(3000),
      inputSchema: { properties: { b: {} }, type: 'object' },
    },
    { name: 'bad name with spaces and far too long'.repeat(10) },
  ];

  const spec = (url: string, transport: 'http' | 'sse' = 'http') =>
    verified(
      assigned([
        {
          input: {
            ...base,
            transport,
            http: transport === 'http' ? { ...base.http, url } : undefined,
            sse: transport === 'sse' ? { ...base.http, url } : undefined,
            runtimes: transport === 'sse' ? ['claude-code', 'opencode'] : base.runtimes,
          },
        },
      ]),
      transport === 'sse' ? 'claude-code' : 'codex',
    ).servers[0]?.spec;

  for (const answer of ['json', 'sse'] as const) {
    it(`streamable HTTP (${answer} answers): initialize, paged tools/list, session id, Authorization arrives`, async () => {
      server = await startFakeMcpServer({
        tools,
        pageSize: 1,
        answer,
        requireAuthorization: 'Bearer ghp_abcdef123',
      });
      const s = spec('https://mcp.example.com/mcp');
      if (s === undefined) throw new Error('no spec');
      const report = await probeMcpServer(
        s,
        { token: 'ghp_abcdef123' },
        { fetch: fetchVia(server), lookup: publicLookup },
      );
      expect(report.transport).toBe('streamable-http');
      expect(report.protocolVersion).toBe('2025-06-18');
      expect(report.serverInfo).toEqual({ name: 'fake-mcp', version: '0.0.1' });
      expect(report.tools.map((t) => t.name)).toEqual(['get_issue', 'create_issue']);
      expect(report.tools[0]?.readOnlyHint).toBe(true);
      expect(report.tools[1]?.description.length).toBe(1024);
      expect(report.tools[0]?.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
      const posts = server.requests.filter((r) => r.method === 'POST');
      expect(posts.map((r) => (JSON.parse(r.body) as { method: string }).method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/list',
        'tools/list',
      ]);
      expect(posts.every((r) => r.headers.authorization === 'Bearer ghp_abcdef123')).toBe(true);
      expect(posts.every((r) => r.headers['x-client'] === 'remyral')).toBe(true);
      expect(posts[2]?.headers['mcp-session-id']).toBe('fake-session-1');
      expect(posts[2]?.headers['mcp-protocol-version']).toBe('2025-06-18');
      expect(
        server.requests.some(
          (r) => r.method === 'DELETE' && r.headers['mcp-session-id'] === 'fake-session-1',
        ),
      ).toBe(true);
    });
  }

  it('legacy SSE: endpoint event, answers as message events', async () => {
    server = await startFakeMcpServer({ tools: tools.slice(0, 2) });
    const s = spec('https://mcp.example.com/sse', 'sse');
    if (s === undefined) throw new Error('no spec');
    const report = await probeMcpServer(
      s,
      { token: 'ghp_abcdef123' },
      { fetch: fetchVia(server), lookup: publicLookup },
    );
    expect(report.transport).toBe('sse');
    expect(report.tools.map((t) => t.name)).toEqual(['get_issue', 'create_issue']);
    expect(
      server.requests
        .filter((r) => r.path === '/messages')
        .every((r) => r.headers.authorization === 'Bearer ghp_abcdef123'),
    ).toBe(true);
  });

  it('refuses a redirect, an oversize answer, a private address and a wrong token', async () => {
    server = await startFakeMcpServer({ tools, requireAuthorization: 'Bearer right-token' });
    const via = { fetch: fetchVia(server), lookup: publicLookup };
    const reason = async (url: string, deps = via, token = 'right-token') => {
      const s = spec(url);
      if (s === undefined) throw new Error('no spec');
      return probeMcpServer(s, { token }, deps).then(
        () => 'ok',
        (e: unknown) => (e instanceof McpProbeError ? e.reason : String(e)),
      );
    };
    expect(await reason('https://mcp.example.com/redirect')).toBe('redirect_refused');
    expect(await reason('https://mcp.example.com/big')).toBe('response_too_large');
    expect(
      await reason('https://mcp.example.com/mcp', { ...via, lookup: () => Promise.resolve(['10.0.0.5']) }),
    ).toBe('forbidden_address');
    expect(await reason('https://mcp.example.com/mcp', via, 'wrong-token')).toBe('unauthorized');
  });

  it('DNS rebinding: every request goes to the address the check approved (one resolution only)', async () => {
    server = await startFakeMcpServer({ tools });
    const s = spec('https://mcp.example.com/mcp');
    if (s === undefined) throw new Error('no spec');
    const answers = [['93.184.216.34'], ['169.254.169.254']];
    let lookups = 0;
    const pinned: string[] = [];
    const report = await probeMcpServer(
      s,
      { token: 'x1234567' },
      {
        lookup: () => Promise.resolve(answers[lookups++] ?? ['127.0.0.1']),
        pinnedFetch: (host, address) => {
          pinned.push(`${host}=${address}`);
          return fetchVia(server as FakeMcpServer);
        },
      },
    );
    expect(report.tools.length).toBeGreaterThan(0);
    expect(lookups).toBe(1);
    expect(pinned).toEqual(['mcp.example.com=93.184.216.34']);
  });

  it('times out a server that never answers', async () => {
    const s = spec('https://mcp.example.com/mcp');
    if (s === undefined) throw new Error('no spec');
    const never = (_u: string, init: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        }),
      );
    await expect(
      probeMcpServer(s, { token: 'x1234567' }, { fetch: never, lookup: publicLookup, timeoutMs: 50 }),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });

  it("the op: verifies with the worker's own keys, reads the vault, never reports the secret", async () => {
    server = await startFakeMcpServer({ tools: tools.slice(0, 1) });
    const a = assigned([{ input: { ...base, http: { ...base.http, url: 'https://mcp.example.com/mcp' } } }]);
    const op = {
      kind: 'mcp.probe' as const,
      server: a.servers[0] as SignedMcpSpec,
      secrets: [{ slot: 'token', ref: 'secret:vault-github' }],
    };
    const deps = {
      keys: () => [pub],
      store: store({ 'vault-github': 'ghp_abcdef123' }),
      workerId: 'w1',
      allowMcp: true,
      fetch: fetchVia(server),
      lookup: publicLookup,
    };
    const ok = await runMcpProbe(op, deps);
    expect(ok).toMatchObject({ state: 'succeeded', report: { tools: [{ name: 'get_issue' }] } });
    expect(JSON.stringify(ok)).not.toContain('ghp_abcdef123');
    expect(await runMcpProbe(op, { ...deps, keys: () => [otherPub] })).toMatchObject({
      state: 'refused',
      reason: 'mcp_verification_failed',
    });
    expect(await runMcpProbe(op, { ...deps, allowMcp: false })).toMatchObject({
      state: 'refused',
      reason: 'mcp_vetoed',
    });
    expect(await runMcpProbe(op, { ...deps, store: store({}) })).toMatchObject({
      state: 'refused',
      reason: 'mcp_secret_missing',
    });
    expect(await runMcpProbe({ ...op, secrets: [] }, deps)).toMatchObject({
      state: 'refused',
      reason: 'mcp_secret_missing',
    });
    expect(await runMcpProbe(op, { ...deps, store: store({ 'vault-github': '!echo hi' }) })).toMatchObject({
      state: 'refused',
      reason: 'mcp_secret_invalid',
    });
  });
});
