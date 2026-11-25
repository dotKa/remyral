import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentEvent,
  AssignedMcp,
  MCP_SIGNATURE_CONTEXT,
  McpServerId,
  McpSpec,
  type McpSpecInput,
  OpsOperation,
  OpsUpdatePayload,
  SKILL_SIGNATURE_CONTEXT,
  WorkerFeature,
  mcpCallDecision,
  mcpEgressHostProblem,
  mcpFormatValue,
  mcpGlobMatches,
  mcpPolicySha256,
  mcpRuntimeName,
  mcpSecretEnvName,
  mcpSecretValueProblem,
  mcpSetHash,
  mcpSpecEgressHosts,
  mcpToolEffect,
  mcpToolLooksReadOnly,
  mcpUrlProblem,
  packMcpSpec,
  parseMcpRuntimeToolName,
  skillKeyId,
  verifyMcpSpec,
} from '../src/index.js';

/** p14-mcp-core: the signed MCP spec, its own signature context, tool rules and job delivery (design §2). */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString(
  'base64url',
);
const other = generateKeyPairSync('ed25519');
const otherPub = Buffer.from(other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString(
  'base64url',
);

const input: McpSpecInput = {
  id: 'github',
  version: '1.2.0',
  transport: 'http',
  http: {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: { secret: 'token', format: 'Bearer {}' }, 'X-Client': 'remyral' },
  },
  secrets: [{ slot: 'token', kind: 'generic', why: 'GitHub PAT, repo:read' }],
  egressHosts: ['api.github.com'],
  runtimes: ['claude-code', 'codex', 'pi', 'opencode'],
  limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
  createdAt: '2026-10-20T12:00:00.000Z',
};

describe('MCP spec schema', () => {
  it('accepts a remote http spec and derives its egress hosts', () => {
    const spec = McpSpec.parse({ schema: 1, kind: 'remana.mcp', ...input });
    expect(mcpSpecEgressHosts(spec)).toEqual(['api.github.com', 'mcp.example.com']);
  });

  it('refuses reserved and malformed ids', () => {
    for (const id of [
      'remyral',
      'remyral-x',
      'subtasks',
      'admin',
      'preview',
      'deploy',
      'A',
      'x',
      '1abc',
      'a_b',
    ]) {
      expect(McpServerId.safeParse(id).success, id).toBe(false);
    }
    expect(McpServerId.safeParse('github').success).toBe(true);
    expect(mcpRuntimeName('github')).toBe('x-github');
  });

  it('needs exactly the block of its transport', () => {
    const bad = { schema: 1, kind: 'remana.mcp', ...input, sse: input.http };
    expect(McpSpec.safeParse(bad).success).toBe(false);
    const missing = { schema: 1, kind: 'remana.mcp', ...input, http: undefined };
    expect(McpSpec.safeParse(missing).success).toBe(false);
  });

  it('limits SSE servers to Claude Code and OpenCode', () => {
    const sse = {
      schema: 1,
      kind: 'remana.mcp',
      ...input,
      transport: 'sse',
      sse: input.http,
      http: undefined,
    };
    expect(McpSpec.safeParse(sse).success).toBe(false);
    expect(McpSpec.safeParse({ ...sse, runtimes: ['claude-code', 'opencode'] }).success).toBe(true);
  });

  it('requires declared slots to be used and used slots to be declared', () => {
    const undeclared = { schema: 1, kind: 'remana.mcp', ...input, secrets: [] };
    expect(McpSpec.safeParse(undeclared).success).toBe(false);
    const unused = {
      schema: 1,
      kind: 'remana.mcp',
      ...input,
      secrets: [...input.secrets, { slot: 'other', kind: 'generic', why: '' }],
    };
    expect(McpSpec.safeParse(unused).success).toBe(false);
  });

  it('refuses unsafe URLs, hosts, headers and literal values', () => {
    expect(mcpUrlProblem('http://mcp.example.com/mcp')).not.toBeNull();
    expect(mcpUrlProblem('https://127.0.0.1/mcp')).not.toBeNull();
    expect(mcpUrlProblem('https://localhost/mcp')).not.toBeNull();
    expect(mcpUrlProblem('https://user:pw@mcp.example.com/')).not.toBeNull();
    expect(mcpUrlProblem('https://mcp.example.com/mcp#x')).not.toBeNull();
    expect(mcpUrlProblem('https://mcp.example.com:8443/mcp')).toBeNull();
    expect(mcpEgressHostProblem('svc.internal')).not.toBeNull();
    expect(mcpEgressHostProblem('printer.local')).not.toBeNull();
    expect(mcpEgressHostProblem('[::1]')).not.toBeNull();
    expect(mcpEgressHostProblem('api.github.com:443')).toBeNull();
    const withHeaders = (headers: unknown) =>
      McpSpec.safeParse({ schema: 1, kind: 'remana.mcp', ...input, http: { url: input.http?.url, headers } })
        .success;
    expect(withHeaders({ Host: 'x' })).toBe(false);
    expect(withHeaders({ 'Mcp-Session-Id': 'x' })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token' }, 'X-A': '!rm -rf /' })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token' }, 'X-A': '{env:HOME}' })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token' }, 'X-A': '$HOME' })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token', format: 'Bearer ${X} {}' } })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token', format: 'Bearer' } })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token', format: '{} {}' } })).toBe(false);
    expect(withHeaders({ Authorization: { secret: 'token' } })).toBe(true);
  });
});

describe('MCP signing', () => {
  it('signs with its own context and verifies with the trusted key only', () => {
    const { signed, specSha256 } = packMcpSpec(input, privateKey, pub);
    expect(signed.signature.keyId).toBe(skillKeyId(pub));
    const ok = verifyMcpSpec(signed, [pub]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.specSha256).toBe(specSha256);
    expect(verifyMcpSpec(signed, [otherPub])).toMatchObject({ ok: false, reason: 'unknown_key' });
    expect(verifyMcpSpec(signed, [])).toMatchObject({ ok: false, reason: 'no_trusted_keys' });
  });

  it('refuses a skill-context signature over the same bytes (no cross-replay)', () => {
    const { signed } = packMcpSpec(input, privateKey, pub);
    const bytes = Buffer.from(signed.spec, 'base64');
    const skillSig = sign(
      null,
      Buffer.concat([Buffer.from(SKILL_SIGNATURE_CONTEXT, 'utf8'), bytes]),
      privateKey,
    ).toString('base64url');
    expect(MCP_SIGNATURE_CONTEXT).not.toBe(SKILL_SIGNATURE_CONTEXT);
    expect(
      verifyMcpSpec({ ...signed, signature: { ...signed.signature, signature: skillSig } }, [pub]),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses tampered bytes and invalid specs even when signed', () => {
    const { signed } = packMcpSpec(input, privateKey, pub);
    const tampered = Buffer.from(signed.spec, 'base64')
      .toString('utf8')
      .replace('mcp.example.com', 'evil.example.com');
    expect(verifyMcpSpec({ ...signed, spec: Buffer.from(tampered).toString('base64') }, [pub])).toMatchObject(
      {
        ok: false,
        reason: 'bad_signature',
      },
    );
    const raw = Buffer.from(JSON.stringify({ schema: 1, kind: 'remana.mcp', id: 'admin' }));
    const sig = sign(null, Buffer.concat([Buffer.from(MCP_SIGNATURE_CONTEXT), raw]), privateKey).toString(
      'base64url',
    );
    expect(
      verifyMcpSpec({ spec: raw.toString('base64'), signature: { keyId: skillKeyId(pub), signature: sig } }, [
        pub,
      ]),
    ).toMatchObject({ ok: false, reason: 'invalid_spec' });
  });
});

describe('MCP tool rules', () => {
  const rules = [
    { tool: 'get_*', effect: 'allow' as const },
    { tool: 'create_issue', effect: 'ask' as const },
    { tool: 'delete_*', effect: 'deny' as const },
  ];

  it('first matching rule wins; unlisted tools are denied', () => {
    expect(mcpToolEffect(rules, 'get_issue')).toBe('allow');
    expect(mcpToolEffect(rules, 'create_issue')).toBe('ask');
    expect(mcpToolEffect(rules, 'delete_repo')).toBe('deny');
    expect(mcpToolEffect(rules, 'merge_pr')).toBe('deny');
    expect(mcpToolEffect([], 'anything')).toBe('deny');
    expect(mcpGlobMatches('a.b?', 'a.bc')).toBe(true);
    expect(mcpGlobMatches('a.b', 'axb')).toBe(false);
  });

  it('the job approval mode only tightens', () => {
    expect(mcpCallDecision(rules, 'create_issue', 'deny-sensitive')).toBe('deny');
    expect(mcpCallDecision(rules, 'get_issue', 'deny-sensitive')).toBe('allow');
    expect(mcpCallDecision(rules, 'get_issue', 'ask-all')).toBe('ask');
    expect(mcpCallDecision(rules, 'create_issue', 'allow-all')).toBe('ask');
    expect(mcpCallDecision(rules, 'merge_pr', 'allow-all')).toBe('deny');
  });

  it('hashes rules order-sensitively and suggests read-only tools', () => {
    expect(mcpPolicySha256(rules)).not.toBe(mcpPolicySha256([...rules].reverse()));
    expect(mcpToolLooksReadOnly('list_repos')).toBe(true);
    expect(mcpToolLooksReadOnly('create_issue')).toBe(false);
    // p14-mcp-chat: the server's own annotation cannot make a write-named tool look read-only.
    expect(mcpToolLooksReadOnly('create_issue', true)).toBe(false);
    expect(mcpToolLooksReadOnly('repo_delete', true)).toBe(false);
    expect(mcpToolLooksReadOnly('get_settings_and_update', true)).toBe(false);
    expect(mcpToolLooksReadOnly('time_now', true)).toBe(true);
    expect(mcpToolLooksReadOnly('get_x', false)).toBe(false);
  });
});

describe('MCP job delivery', () => {
  it('validates ASSIGN_JOB mcp and the set hash is order-independent', () => {
    const { signed, specSha256 } = packMcpSpec(input, privateKey, pub);
    const pin = { id: 'github', version: '1.2.0', specSha256, policySha256: mcpPolicySha256([]) };
    const pin2 = { ...pin, id: 'linear' };
    expect(mcpSetHash([pin, pin2])).toBe(mcpSetHash([pin2, pin]));
    expect(mcpSetHash([pin])).not.toBe(
      mcpSetHash([{ ...pin, policySha256: mcpPolicySha256([{ tool: '*', effect: 'allow' }]) }]),
    );
    const assigned = {
      setHash: mcpSetHash([pin]),
      servers: [signed],
      policies: [{ server: 'github', rules: [{ tool: '*', effect: 'ask' }] }],
      secrets: [{ server: 'github', slot: 'token', ref: 'secret:vault-gh-token' }],
    };
    expect(AssignedMcp.safeParse(assigned).success).toBe(true);
    expect(
      AssignedMcp.safeParse({ ...assigned, policies: [...assigned.policies, ...assigned.policies] }).success,
    ).toBe(false);
    expect(
      AssignedMcp.safeParse({ ...assigned, secrets: [{ ...assigned.secrets[0], ref: 'ghp_value' }] }).success,
    ).toBe(false);
  });

  it('names secret env vars and refuses values a runtime would interpret', () => {
    expect(mcpSecretEnvName('my-server', 'api_key')).toBe('REMYRAL_MCP_MY_SERVER_API_KEY');
    expect(mcpSecretValueProblem('ghp_abc123')).toBeNull();
    for (const v of [
      '',
      '!cat /etc/passwd',
      'a"b',
      'a\\b',
      'x$HOME',
      '{env:X}',
      'a`b',
      'line\nbreak',
      ' pad',
    ]) {
      expect(mcpSecretValueProblem(v), JSON.stringify(v)).not.toBeNull();
    }
    expect(mcpFormatValue('Bearer {}', 'tok')).toBe('Bearer tok');
    expect(mcpFormatValue(undefined, 'tok')).toBe('tok');
  });

  it('maps runtime tool names back to server and tool', () => {
    expect(parseMcpRuntimeToolName('claude-code', 'mcp__x-github__get_issue', ['github'])).toEqual({
      server: 'github',
      tool: 'get_issue',
    });
    expect(parseMcpRuntimeToolName('pi', 'mcp__x_my_server__t', ['my-server'])).toEqual({
      server: 'my-server',
      tool: 't',
    });
    expect(parseMcpRuntimeToolName('opencode', 'x-github_get_issue', ['github'])).toEqual({
      server: 'github',
      tool: 'get_issue',
    });
    expect(parseMcpRuntimeToolName('claude-code', 'mcp__remyral-subtasks__x', ['github'])).toBeNull();
  });

  it('adds the mcp_call event, the mcp.probe op and the mcp-v1 feature', () => {
    expect(WorkerFeature.safeParse('mcp-v1').success).toBe(true);
    const call = {
      kind: 'mcp_call',
      server: 'github',
      tool: 'get_issue',
      decision: 'allow',
      outcome: 'ok',
      durationMs: 12,
      argsBytes: 20,
      argsSha256: 'a'.repeat(64),
      resultBytes: 300,
    };
    expect(AgentEvent.safeParse(call).success).toBe(true);
    expect(AgentEvent.safeParse({ ...call, decision: 'maybe' }).success).toBe(false);
    const { signed } = packMcpSpec(input, privateKey, pub);
    expect(
      OpsOperation.safeParse({
        kind: 'mcp.probe',
        server: signed,
        secrets: [{ slot: 'token', ref: 'secret:vault-x' }],
      }).success,
    ).toBe(true);
    expect(
      OpsUpdatePayload.safeParse({
        commandId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        seq: 2,
        kind: 'mcp.probe',
        state: 'succeeded',
        mcpProbe: {
          tools: [
            {
              name: 'get_issue',
              description: 'Reads an issue',
              schemaSha256: 'b'.repeat(64),
              readOnlyHint: true,
            },
          ],
          serverInfo: { name: 'fake', version: '1.0.0' },
          protocolVersion: '2025-06-18',
          transport: 'streamable-http',
          durationMs: 40,
        },
      }).success,
    ).toBe(true);
  });
});
