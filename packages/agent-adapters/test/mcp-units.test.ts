/**
 * p14-mcp-core (ADR-0054, design §2.4): the shared MCP helpers every adapter uses — delivery checks, decisions,
 * call events (metadata only), approval requests and the per-runtime renderings (no secret value outside the
 * job-private file / the environment).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertMcpDelivery,
  claudeMcpConfig,
  codexMcpArgs,
  InvalidSpawnContextError,
  mcpApprovalEvent,
  McpGate,
  mcpProcessEnv,
  opencodeMcpEntries,
  opencodeMcpRuleset,
  piMcpExtensionSource,
  SANITIZE_NO_DASH,
  SecretValue,
  withMcpSecrets,
  writeMcpPrivateFile,
  type SpawnContext,
} from '../src/index.js';
import { spawnContext } from './helpers/runtime.js';
import { MCP_RULES, MCP_TOKEN, mcpDelivery } from './helpers/mcp.js';

const root = mkdtempSync(join(tmpdir(), 'remyral-mcp-units-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const RULES = MCP_RULES;

describe('assertMcpDelivery (defence in depth behind the worker)', () => {
  it('accepts a well-formed delivery', () => {
    expect(() => {
      assertMcpDelivery(mcpDelivery(RULES));
    }).not.toThrow();
  });
  it.each([
    ['a name that is not x-<id>', { name: 'docs' }],
    ['a reserved id', { id: 'remyral-tools', name: 'x-remyral-tools' }],
    ['an http URL', { url: 'http://mcp.example.com/mcp' }],
    ['credentials in the URL', { url: 'https://u:p@mcp.example.com/mcp' }],
    ['a $ in the URL', { url: 'https://mcp.example.com/${HOME}' }],
    ['a literal starting with !', { headers: { 'X-A': { kind: 'literal' as const, value: '!id' } } }],
    ['a literal with $', { headers: { 'X-A': { kind: 'literal' as const, value: 'a$B' } } }],
    ['a missing secret', { headers: { 'X-A': { kind: 'secret' as const, env: 'REMYRAL_MCP_DOCS_OTHER' } } }],
    ['a tool timeout out of range', { toolTimeoutSec: 601 }],
  ])('refuses %s', (_, over) => {
    expect(() => {
      assertMcpDelivery(mcpDelivery(RULES, over));
    }).toThrow(InvalidSpawnContextError);
  });
  it.each(['a"b', 'a\\b', '!cmd', '${X}', 'a{b}', 'two\nlines'])(
    'refuses a secret value no runtime can carry safely (%j) without naming it',
    (value) => {
      const d = { ...mcpDelivery(RULES), secretEnv: { REMYRAL_MCP_DOCS_TOKEN: new SecretValue(value) } };
      try {
        assertMcpDelivery(d);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidSpawnContextError);
        expect((err as Error).message).not.toContain(value);
      }
    },
  );
  it('refuses duplicate servers', () => {
    const d = mcpDelivery(RULES);
    const first = d.servers[0];
    if (first === undefined) throw new Error('no server');
    expect(() => {
      assertMcpDelivery({ ...d, servers: [first, first] });
    }).toThrow(InvalidSpawnContextError);
  });
});

describe('McpGate: names, decisions, call events', () => {
  const d = mcpDelivery(RULES);
  it('identifies the tools of the job servers per runtime spelling (x- prefix only)', () => {
    expect(new McpGate('claude-code', d).identify('mcp__x-docs__search')).toEqual({
      server: 'docs',
      tool: 'search',
    });
    expect(new McpGate('codex', d).identify('x-docs/search')).toEqual({ server: 'docs', tool: 'search' });
    expect(new McpGate('opencode', d).identify('x-docs_search')).toEqual({ server: 'docs', tool: 'search' });
    expect(new McpGate('pi', d).identify('mcp__x_docs__search')).toEqual({ server: 'docs', tool: 'search' });
    // Platform servers and other names are never external.
    const g = new McpGate('claude-code', d);
    expect(g.identify('mcp__remyral-subtasks__request_subtask')).toBeNull();
    expect(g.identify('mcp__docs__search')).toBeNull();
    expect(g.isExternalName('mcp__x-other__x')).toBe(true);
    expect(g.isExternalName('mcp__remyral-admin__run')).toBe(false);
  });
  it('first matching rule wins, unlisted tools are denied, the job mode only tightens', () => {
    const g = new McpGate('claude-code', d);
    expect(g.decide('docs', 'search', 'ask-sensitive')).toBe('allow');
    expect(g.decide('docs', 'create_issue', 'ask-sensitive')).toBe('ask');
    expect(g.decide('docs', 'delete_all', 'allow-all')).toBe('deny');
    expect(g.decide('docs', 'unlisted', 'allow-all')).toBe('deny');
    expect(g.decide('docs', 'search', 'ask-all')).toBe('ask');
    expect(g.decide('docs', 'create_issue', 'deny-sensitive')).toBe('deny');
    expect(g.decide('docs', 'create_issue', 'allow-all')).toBe('ask');
    expect(g.decide('other', 'search', 'allow-all')).toBe('deny');
  });
  it("matches rules against the runtime's sanitised tool names (Pi: get.file → get_file)", () => {
    const g = new McpGate('pi', mcpDelivery([{ tool: 'get.file', effect: 'allow' }]), SANITIZE_NO_DASH);
    expect(g.decide('docs', 'get_file', 'ask-sensitive')).toBe('allow');
    expect(g.decide('docs', 'get_other', 'ask-sensitive')).toBe('deny');
  });
  it('mcp_call carries metadata only: sizes, sha256 of the arguments, decision, outcome', () => {
    let now = 1_000;
    const g = new McpGate('claude-code', d, undefined, () => now);
    const args = { q: 'top secret question' };
    g.begin('c1', 'docs', 'search', 'allow', args);
    now = 1_250;
    const ev = g.end('c1', 'ok', { content: [{ type: 'text', text: 'answer text' }] });
    const argsText = JSON.stringify(args);
    expect(ev).toEqual({
      kind: 'mcp_call',
      server: 'docs',
      tool: 'search',
      decision: 'allow',
      outcome: 'ok',
      durationMs: 250,
      argsBytes: Buffer.byteLength(argsText),
      argsSha256: createHash('sha256').update(argsText).digest('hex'),
      resultBytes: Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: 'answer text' }] })),
    });
    expect(JSON.stringify(ev)).not.toContain('top secret');
    expect(JSON.stringify(ev)).not.toContain('answer text');
    expect(g.end('c1', 'ok', '')).toBeNull();
    const denied = g.denied('docs', 'delete_all', 'deny', { all: true });
    expect(denied).toMatchObject({ outcome: 'denied', decision: 'deny', durationMs: 0, resultBytes: 0 });
    g.begin('c2', 'docs', 'search', 'allow', {});
    expect(g.drain()).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });
  it('the approval request is action tool.mcp, risk high, with a redacted argument preview', () => {
    const secrets = { T: new SecretValue('s3cr3t-value') };
    const ev = mcpApprovalEvent('ap1', 'docs', 'create_issue', { body: 'uses s3cr3t-value' }, secrets);
    expect(ev).toMatchObject({
      kind: 'approval_request',
      approvalId: 'ap1',
      action: 'tool.mcp',
      risk: 'high',
    });
    expect(ev.details?.tool).toBe('x-docs/create_issue');
    expect(JSON.stringify(ev)).not.toContain('s3cr3t-value');
  });
});

describe('per-runtime renderings', () => {
  it('Claude Code: the mcp-config file carries the resolved headers (it is 0600 and job-private)', async () => {
    const d = mcpDelivery(RULES);
    const cfg = claudeMcpConfig(d);
    expect(cfg).toEqual({
      mcpServers: {
        'x-docs': {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'X-Team': 'blue' },
        },
      },
    });
    const path = await writeMcpPrivateFile(d, 'claude.json', JSON.stringify(cfg));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(d.configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(cfg);
    await expect(writeMcpPrivateFile(d, '../escape.json', '{}')).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
  });
  it('Codex: -c overrides name env vars only (never a value), approval prompts, enabled/disabled tools', () => {
    const literal = codexMcpArgs(
      mcpDelivery([
        { tool: 'search', effect: 'allow' },
        { tool: 'create_issue', effect: 'ask' },
        { tool: 'delete_all', effect: 'deny' },
      ]),
    );
    expect(literal[0]).toBe('-c');
    const o = literal[1] ?? '';
    expect(o.startsWith('mcp_servers.x-docs={ url = "https://mcp.example.com/mcp"')).toBe(true);
    expect(o).toContain('env_http_headers = { "Authorization" = "REMYRAL_MCP_H_DOCS_0" }');
    expect(o).toContain('http_headers = { "X-Team" = "blue" }');
    expect(o).toContain('default_tools_approval_mode = "prompt"');
    expect(o).toContain('startup_timeout_sec = 30');
    expect(o).toContain('tool_timeout_sec = 120');
    expect(o).toContain('enabled_tools = ["search", "create_issue"]');
    expect(o).toContain('disabled_tools = ["delete_all"]');
    expect(literal.join(' ')).not.toContain(MCP_TOKEN);
    // A wildcard allow/ask rule cannot be listed: no enabled_tools (the adapter decides every call).
    expect((codexMcpArgs(mcpDelivery(RULES))[1] ?? '').includes('enabled_tools')).toBe(false);
    expect(() => codexMcpArgs(mcpDelivery(RULES, { transport: 'sse' }))).toThrow(InvalidSpawnContextError);
  });
  it('OpenCode: remote entry with oauth:false, {env:NAME} for secrets, an ask ruleset per server', () => {
    const d = mcpDelivery(RULES);
    expect(opencodeMcpEntries(d)).toEqual({
      'x-docs': {
        type: 'remote',
        url: 'https://mcp.example.com/mcp',
        enabled: true,
        oauth: false,
        timeout: 120_000,
        headers: { Authorization: '{env:REMYRAL_MCP_H_DOCS_0}', 'X-Team': 'blue' },
      },
    });
    expect(JSON.stringify(opencodeMcpEntries(d))).not.toContain(MCP_TOKEN);
    expect(opencodeMcpRuleset(d)).toEqual([{ permission: 'x-docs_*', pattern: '*', action: 'ask' }]);
  });
  it('Pi: registerMcpServer source with ${VAR} references, direct exposure, no value, no SSE', () => {
    const src = piMcpExtensionSource(mcpDelivery(RULES));
    expect(src).toContain('pi.registerMcpServer(s.name, s.config)');
    expect(src).toContain('"name":"x-docs"');
    expect(src).toContain('"type":"streamable-http"');
    expect(src).toContain('"Authorization":"${REMYRAL_MCP_H_DOCS_0}"');
    expect(src).toContain('"exposure":"direct"');
    expect(src).not.toContain(MCP_TOKEN);
    expect(() => piMcpExtensionSource(mcpDelivery(RULES, { transport: 'sse' }))).toThrow(
      InvalidSpawnContextError,
    );
  });
  it('the process env carries the raw slot and the formatted header value; the context redacts both', () => {
    const d = mcpDelivery(RULES);
    const env = mcpProcessEnv(d);
    expect(env.REMYRAL_MCP_DOCS_TOKEN?.reveal()).toBe(MCP_TOKEN);
    expect(env.REMYRAL_MCP_H_DOCS_0?.reveal()).toBe(`Bearer ${MCP_TOKEN}`);
    const ctx = withMcpSecrets({ ...spawnContext('codex', root), mcp: d } satisfies SpawnContext);
    expect(Object.keys(ctx.secretEnv).sort()).toEqual(['REMYRAL_MCP_DOCS_TOKEN', 'REMYRAL_MCP_H_DOCS_0']);
    const plain = spawnContext('codex', root);
    expect(withMcpSecrets(plain)).toBe(plain);
  });
});
