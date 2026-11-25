/**
 * p14-mcp-stdio (ADR-0054 P4, design §14.3): local (stdio) MCP servers in the four runtimes' configs. The runtime only
 * ever starts the worker's launcher (`node remyral-mcp-launch.mjs <spec file>`): no env, no secret in any config or on
 * argv; command lines no runtime substitution can rewrite; Codex keys bare (the pinned 0.162.1 keeps quotes).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertMcpDelivery,
  claudeMcpConfig,
  codexMcpArgs,
  codexServerKey,
  InvalidSpawnContextError,
  type McpJobDelivery,
  mcpProcessEnv,
  mcpTransportSupport,
  opencodeMcpEntries,
  piMcpExtensionSource,
  type SpawnContext,
  withMcpSecrets,
} from '../src/index.js';
import { checkOwnMcpServers } from '../src/runtimes/codex/config.js';
import { spawnContext } from './helpers/runtime.js';
import { MCP_RULES, MCP_TOKEN, mcpDelivery, mcpStdioDelivery } from './helpers/mcp.js';

const root = mkdtempSync(join(tmpdir(), 'remyral-mcp-stdio-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const RULES = MCP_RULES;

/** A delivery with one remote (`x-docs`) and one stdio (`x-files`) server. */
function mixed(): McpJobDelivery {
  const remote = mcpDelivery(RULES);
  const stdio = mcpStdioDelivery(RULES, {}, remote.configDir);
  return { ...remote, servers: [...remote.servers, ...stdio.servers] };
}

describe('assertMcpDelivery: stdio servers', () => {
  it('accepts the launcher command line (absolute node or `node` in a container)', () => {
    expect(() => {
      assertMcpDelivery(mcpStdioDelivery(RULES));
    }).not.toThrow();
    expect(() => {
      assertMcpDelivery(mcpStdioDelivery(RULES, { command: 'node' }));
    }).not.toThrow();
    expect(() => {
      assertMcpDelivery(
        mcpStdioDelivery(RULES, {
          command: 'C:\\Program Files\\Remyral\\node\\node.exe',
          args: ['C:\\data\\a\\mcp\\remyral-mcp-launch.mjs', 'C:\\data\\a\\mcp\\x-files.launch.json'],
        }),
      );
    }).not.toThrow();
    expect(() => {
      assertMcpDelivery(mixed());
    }).not.toThrow();
  });
  it.each([
    ['a relative command', { command: 'bin/node' }],
    ['a $ in the command', { command: '/opt/$HOME/node' }],
    ['a brace in the command', { command: '/opt/{env:X}/node' }],
    ['a quote in the command', { command: '/opt/"x"/node' }],
    ['a backtick in the command', { command: '/opt/`id`/node' }],
    ['a control character in the command', { command: '/opt/no\nde' }],
    ['a command starting with !', { command: '!/bin/sh' }],
    ['one arg', { args: ['/a/remyral-mcp-launch.mjs'] }],
    ['three args', { args: ['/a/l.mjs', '/a/s.json', '/a/x'] }],
    ['a relative arg', { args: ['/a/l.mjs', 'x-files.launch.json'] }],
    ['a brace in an arg', { args: ['/a/l.mjs', '/a/{file:x}.json'] }],
    ['a $ in an arg', { args: ['/a/l.mjs', '/a/${HOME}.json'] }],
    ['an invalid forwarded env name', { forwardEnv: ['https_proxy'] }],
    ['a startup timeout out of range', { startupTimeoutSec: 121 }],
  ])('refuses %s', (_, over) => {
    expect(() => {
      assertMcpDelivery(mcpStdioDelivery(RULES, over));
    }).toThrow(InvalidSpawnContextError);
  });
});

describe('per-runtime rendering of a stdio server', () => {
  it('Claude Code: {type: stdio, command, args} — no env key, no secret', () => {
    const d = mixed();
    const cfg = claudeMcpConfig(d);
    const files = d.servers[1];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    expect(cfg.mcpServers['x-files']).toEqual({ type: 'stdio', command: files.command, args: files.args });
    expect(Object.keys(cfg.mcpServers['x-files'] as object)).not.toContain('env');
    // The remote server still carries its header in the 0600 file; the stdio entry nothing of it.
    expect(JSON.stringify(cfg.mcpServers['x-files'])).not.toContain(MCP_TOKEN);
  });

  it('Codex: a bare-key stdio override with command, args, env_vars and the tool fields', () => {
    const d = mcpStdioDelivery([
      { tool: 'read_file', effect: 'allow' },
      { tool: 'write_file', effect: 'ask' },
      { tool: 'delete_file', effect: 'deny' },
    ]);
    const files = d.servers[0];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    const args = codexMcpArgs(d);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    const o = args[1] ?? '';
    expect(o).toBe(
      `mcp_servers.x-files={ command = "${files.command}", args = ["${files.args[0] ?? ''}", "${files.args[1] ?? ''}"], ` +
        'env_vars = ["HTTPS_PROXY", "NO_PROXY"], enabled = true, startup_timeout_sec = 30, tool_timeout_sec = 120, ' +
        'default_tools_approval_mode = "prompt", enabled_tools = ["read_file", "write_file"], ' +
        'disabled_tools = ["delete_file"] }',
    );
    expect(o).not.toContain('env =');
    // No env_vars field when nothing is forwarded; a wildcard rule leaves enabled_tools out.
    const bare = codexMcpArgs(mcpStdioDelivery(RULES, { forwardEnv: [] }))[1] ?? '';
    expect(bare).not.toContain('env_vars');
    expect(bare).not.toContain('enabled_tools');
    expect(bare).toContain('disabled_tools = ["delete_all"]');
  });

  it('Codex: remote overrides use the bare key too (the pinned 0.162.1 keeps quotes in a quoted key)', () => {
    const args = codexMcpArgs(mixed());
    expect(args.filter((a) => a.startsWith('mcp_servers.x-docs={ url = '))).toHaveLength(1);
    expect(args.filter((a) => a.startsWith('mcp_servers.x-files={ command = '))).toHaveLength(1);
    expect(args.some((a) => a.startsWith('mcp_servers."'))).toBe(false);
  });

  it('codexServerKey accepts only x-<id>', () => {
    expect(codexServerKey('x-files')).toBe('x-files');
    expect(codexServerKey('x-a1-b2')).toBe('x-a1-b2');
    for (const bad of ['files', 'x-', 'x-A', 'x-1a', 'x-a.b', 'x-a"b', `x-${'a'.repeat(33)}`, 'y-files']) {
      expect(() => codexServerKey(bad), bad).toThrow(InvalidSpawnContextError);
    }
  });

  it('OpenCode: a local entry with the launcher command line, no environment key', () => {
    const d = mcpStdioDelivery(RULES, { toolTimeoutSec: 90 });
    const files = d.servers[0];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    const entries = opencodeMcpEntries(d);
    expect(entries['x-files']).toEqual({
      type: 'local',
      command: [files.command, ...files.args],
      enabled: true,
      timeout: 90_000,
    });
    expect(Object.keys(entries['x-files'] as object)).not.toContain('environment');
  });

  it('Pi: registers {type: stdio, command, args, timeout, exposure: direct, enabled} without env', () => {
    const d = mcpStdioDelivery(RULES);
    const files = d.servers[0];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    const src = piMcpExtensionSource(d);
    const json = /const SERVERS = (.*);\n/.exec(src)?.[1] ?? '[]';
    expect(JSON.parse(json)).toEqual([
      {
        name: 'x-files',
        config: {
          type: 'stdio',
          command: files.command,
          args: [...files.args],
          timeout: 120,
          exposure: 'direct',
          enabled: true,
        },
      },
    ]);
    expect(src).not.toContain('"env"');
    // Mixed: both servers registered.
    expect(piMcpExtensionSource(mixed())).toContain('"name":"x-docs"');
  });

  it('process env / context secrets: a stdio-only delivery adds no header variables and does not throw', () => {
    const d = mcpStdioDelivery(RULES);
    expect(mcpProcessEnv(d)).toEqual({});
    const ctx = withMcpSecrets({ ...spawnContext('codex', root), mcp: d } satisfies SpawnContext);
    expect(Object.keys(ctx.secretEnv).filter((k) => k.startsWith('REMYRAL_MCP_H_'))).toEqual([]);
    // Mixed: only the remote server's header is derived.
    expect(Object.keys(mcpProcessEnv(mixed())).sort()).toEqual([
      'REMYRAL_MCP_DOCS_TOKEN',
      'REMYRAL_MCP_H_DOCS_0',
    ]);
  });

  it('mcpTransportSupport: stdio where listed; a mixed set is checked server by server', () => {
    expect(mcpTransportSupport('codex', mcpStdioDelivery(), ['http', 'stdio'])).toEqual({ supported: true });
    expect(mcpTransportSupport('pi', mixed(), ['http', 'stdio'])).toEqual({ supported: true });
    expect(mcpTransportSupport('codex', mixed(), ['http'])).toMatchObject({
      supported: false,
      reason: expect.stringContaining('stdio') as unknown,
    });
    const withSse = mixed();
    const sse: McpJobDelivery = {
      ...withSse,
      servers: [...mcpDelivery(RULES, { transport: 'sse' }).servers, ...withSse.servers.slice(1)],
    };
    expect(mcpTransportSupport('codex', sse, ['http', 'stdio'])).toMatchObject({
      supported: false,
    });
  });
});

describe('Codex checkOwnMcpServers: a stdio server must be exactly ours', () => {
  const own = {
    'x-files': {
      command: '/opt/remyral/node/bin/node',
      args: ['/a/remyral-mcp-launch.mjs', '/a/x-files.launch.json'],
      envVars: ['HTTPS_PROXY', 'NO_PROXY'],
    },
  };
  const effective = (entry: Record<string, unknown>) => () =>
    Promise.resolve({ config: { mcp_servers: { 'x-files': entry } } });
  const ours = {
    command: own['x-files'].command,
    args: own['x-files'].args,
    env_vars: own['x-files'].envVars,
  };

  it('accepts the same command line and forwarded names (and absent env_vars)', async () => {
    expect(await checkOwnMcpServers(effective(ours), '/w', 1000, own)).toEqual([]);
    expect(
      await checkOwnMcpServers(effective({ ...ours, env_vars: null, env: null, url: null }), '/w', 1000, own),
    ).toEqual([]);
  });
  it.each([
    ['another command', { ...ours, command: '/bin/sh' }, 'another command'],
    ['other args', { ...ours, args: ['/a/remyral-mcp-launch.mjs', '/evil.json'] }, 'another command'],
    ['other forwarded env', { ...ours, env_vars: ['AWS_SECRET_ACCESS_KEY'] }, 'forwards other env'],
    ['env from another layer', { ...ours, env: { X: '1' } }, 'carries env'],
    ['cwd from another layer', { ...ours, cwd: '/tmp' }, 'carries cwd'],
    ['a url from another layer', { ...ours, url: 'https://evil.example.com' }, 'carries url'],
    ['a bearer token from another layer', { ...ours, bearer_token: 't' }, 'carries bearer_token'],
  ])('reports %s', async (_, entry, problem) => {
    const problems = await checkOwnMcpServers(effective(entry), '/w', 1000, own);
    expect(problems.join('; ')).toContain(problem);
  });
  it('reports a missing server', async () => {
    const problems = await checkOwnMcpServers(
      () => Promise.resolve({ config: { mcp_servers: {} } }),
      '/w',
      1000,
      own,
    );
    expect(problems).toEqual(['x-files missing from the effective configuration']);
  });
});
