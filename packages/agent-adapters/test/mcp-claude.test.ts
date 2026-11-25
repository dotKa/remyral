/**
 * p14-mcp-core: Claude Code delivery of a job's external MCP servers (design §2.4, §11.1) against the fake SDK —
 * never `options.mcpServers` (the SDK would put them on argv), a 0600 `--mcp-config` file, the PreToolUse gate
 * (allow / ask → approval `tool.mcp` / deny) and metadata-only `mcp_call` events.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createClaudeCodeAdapter,
  SecretValue,
  type ClaudeCodeAdapter,
  type SequencedEvent,
  type SessionRef,
  type SpawnContext,
} from '../src/index.js';
import { readUntil } from '../src/testing/index.js';
import { FAKE_CLI, FakeClaudeSdk, longTurn } from './fixtures/claude-code/fake-sdk.js';
import { MCP_TOKEN, mcpDelivery, mcpStdioDelivery } from './helpers/mcp.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const root = mkdtempSync(join(tmpdir(), 'remyral-claude-mcp-'));
const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });
const opened: { adapter: ClaudeCodeAdapter; ref: SessionRef }[] = [];
afterEach(async () => {
  for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-claude-mcp'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: mkdtempSync(join(root, 'ws-')),
    job: { runtime: 'claude-code', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: {
      startupMs: 5_000,
      cancelGraceMs: 500,
      cancelMs: 2_000,
      approvalMs: 5_000,
      maxDurationMs: 60_000,
    },
    allowUnverified: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function started(c: SpawnContext, authMode: 'secret-ref' | 'local-login' = 'secret-ref') {
  const sdk = new FakeClaudeSdk({ script: longTurn });
  const adapter = createClaudeCodeAdapter({
    binaryPath: FAKE_CLI,
    sdkInfo,
    sdk,
    stateDir: join(root, 'state'),
    authMode,
    sourceEnv: { PATH: process.env.PATH ?? '' },
  });
  await adapter.probe();
  const ref = await adapter.spawn(c);
  opened.push({ adapter, ref });
  await adapter.sendPrompt(ref, { text: 'go' });
  const options = sdk.calls[0]?.options;
  if (options === undefined) throw new Error('query() not called');
  return { adapter, ref, options };
}

function hook(options: Options, event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'): HookCallback {
  const h = options.hooks?.[event]?.[0]?.hooks[0];
  if (h === undefined) throw new Error(`no ${event} hook`);
  return h;
}

function pre(toolName: string, id: string, input: unknown = { q: 'hi' }): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/t',
    cwd: '/w',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: id,
  };
}

function post(toolName: string, id: string): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 's',
    transcript_path: '/t',
    cwd: '/w',
    tool_name: toolName,
    tool_input: { q: 'hi' },
    tool_response: { content: [{ type: 'text', text: 'result text' }] },
    tool_use_id: id,
    duration_ms: 12,
  };
}

const signal = () => ({ signal: new AbortController().signal });
const decision = (out: unknown) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
const mcpCalls = (events: SequencedEvent[]) =>
  events.map((e) => e.event).filter((e) => e.kind === 'mcp_call');

describePosix('claude-code: external MCP servers (p14-mcp-core)', { timeout: 20_000 }, () => {
  it('mcpDelivery: streamable HTTP and SSE in both auth modes', () => {
    const a = createClaudeCodeAdapter({ binaryPath: FAKE_CLI, sdkInfo });
    expect(a.mcpDelivery({ mcp: mcpDelivery() })).toEqual({ supported: true });
    expect(a.mcpDelivery({ mcp: mcpDelivery(undefined, { transport: 'sse' }) })).toEqual({ supported: true });
  });

  it('a 0600 --mcp-config file by path; never options.mcpServers, no value in argv-bound options or env', async () => {
    const c = ctx({ mcp: mcpDelivery() });
    // Planted repository MCP configuration: never read (strict MCP config, no project setting source).
    writeFileSync(
      join(c.workspaceRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { evil: { command: 'sh' } } }),
    );
    const { options } = await started(c);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(Object.keys(options.mcpServers ?? {})).not.toContain('x-docs');
    const path = options.extraArgs?.['mcp-config'];
    expect(typeof path).toBe('string');
    expect(path?.startsWith(c.mcp?.configDir ?? '/nope')).toBe(true);
    expect(statSync(path ?? '').mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path ?? '', 'utf8'))).toEqual({
      mcpServers: {
        'x-docs': {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'X-Team': 'blue' },
        },
      },
    });
    // Everything the SDK turns into argv / the CLI env: no token anywhere.
    const argvBound = JSON.stringify({ ...options, canUseTool: undefined, hooks: undefined });
    expect(argvBound).not.toContain(MCP_TOKEN);
    expect(JSON.stringify(options.env)).not.toContain(MCP_TOKEN);
    expect(options.disallowedTools).toContain('mcp__x-docs__delete_all');
    expect(options.allowedTools ?? []).not.toContain('mcp__x-docs__search');
  });

  it('p14-mcp-stdio: a stdio server is a {type: stdio} launcher entry in the 0600 file (no env, no secret)', async () => {
    const d = mcpStdioDelivery();
    const files = d.servers[0];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    const a = createClaudeCodeAdapter({ binaryPath: FAKE_CLI, sdkInfo });
    expect(a.mcpDelivery({ mcp: d })).toEqual({ supported: true });
    const { options } = await started(ctx({ mcp: d }));
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).not.toContain('x-files');
    const path = options.extraArgs?.['mcp-config'] ?? '';
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { 'x-files': { type: 'stdio', command: files.command, args: files.args } },
    });
    expect(options.disallowedTools).toContain('mcp__x-files__delete_all');
  });

  it('no MCP for the job: no hook, no file, strict and empty', async () => {
    const { options } = await started(ctx());
    expect(options.hooks).toBeUndefined();
    expect(options.extraArgs?.['mcp-config']).toBeUndefined();
    expect(options.strictMcpConfig).toBe(true);
  });

  it('allow runs (mcp_call ok), deny is refused (mcp_call denied), canUseTool lets only hook-approved ids pass', async () => {
    const { adapter, ref, options } = await started(ctx({ mcp: mcpDelivery() }), 'local-login');
    const preHook = hook(options, 'PreToolUse');
    expect(decision(await preHook(pre('mcp__x-docs__search', 'tu1'), 'tu1', signal()))).toBe('allow');
    const canUse = options.canUseTool;
    if (canUse === undefined) throw new Error('no canUseTool');
    const allowed = await canUse('mcp__x-docs__search', {}, {
      toolUseID: 'tu1',
      signal: new AbortController().signal,
    } as never);
    expect(allowed?.behavior).toBe('allow');
    const stray = await canUse('mcp__x-docs__search', {}, {
      toolUseID: 'tu-other',
      signal: new AbortController().signal,
    } as never);
    expect(stray?.behavior).toBe('deny');
    await hook(options, 'PostToolUse')(post('mcp__x-docs__search', 'tu1'), 'tu1', signal());
    expect(decision(await preHook(pre('mcp__x-docs__delete_all', 'tu2'), 'tu2', signal()))).toBe('deny');
    expect(decision(await preHook(pre('mcp__x-docs__unlisted', 'tu3'), 'tu3', signal()))).toBe('deny');
    expect(decision(await preHook(pre('mcp__x-other__search', 'tu4'), 'tu4', signal()))).toBe('deny');
    // Not an external tool: the hook stays out of it.
    expect(await preHook(pre('Read', 'tu5'), 'tu5', signal())).toEqual({});
    const events = await readUntil(
      adapter,
      ref,
      (e) => e.event.kind === 'mcp_call' && e.event.tool === 'unlisted',
      5_000,
    );
    const calls = mcpCalls(events);
    expect(calls).toEqual([
      expect.objectContaining({
        server: 'docs',
        tool: 'search',
        decision: 'allow',
        outcome: 'ok',
        durationMs: 12,
      }),
      expect.objectContaining({ tool: 'delete_all', decision: 'deny', outcome: 'denied' }),
      expect.objectContaining({ tool: 'unlisted', decision: 'deny', outcome: 'denied' }),
    ]);
    expect(JSON.stringify(calls)).not.toContain('result text');
  });

  it('ask raises a tool.mcp approval; approve runs it, deny refuses it', async () => {
    const { adapter, ref, options } = await started(ctx({ mcp: mcpDelivery() }));
    const preHook = hook(options, 'PreToolUse');
    const pending = preHook(
      pre('mcp__x-docs__create_issue', 'tu-a', { title: `t ${MCP_TOKEN}` }),
      'tu-a',
      signal(),
    );
    const asked = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5_000);
    const req = asked.map((e) => e.event).find((e) => e.kind === 'approval_request');
    expect(req).toMatchObject({ action: 'tool.mcp', risk: 'high', approvalId: 'tu-a' });
    expect(JSON.stringify(req)).not.toContain(MCP_TOKEN);
    await adapter.requestApproval(ref, { approvalId: 'tu-a', decision: 'approve', decidedBy: 'u1' });
    expect(decision(await pending)).toBe('allow');

    const second = preHook(pre('mcp__x-docs__create_page', 'tu-b'), 'tu-b', signal());
    await readUntil(
      adapter,
      ref,
      (e) => e.event.kind === 'approval_request' && e.event.approvalId === 'tu-b',
      5_000,
    );
    await adapter.requestApproval(ref, { approvalId: 'tu-b', decision: 'deny', decidedBy: 'u1' });
    expect(decision(await second)).toBe('deny');
    const events = await readUntil(adapter, ref, (e) => e.event.kind === 'mcp_call', 5_000);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({ tool: 'create_page', decision: 'ask', outcome: 'denied' }),
    ]);
  });

  it('allow-all (bypass mode): the hook still decides — deny and ask are not skipped', async () => {
    const { options } = await started(ctx({ mcp: mcpDelivery(), approvalPolicy: 'allow-all' }));
    const preHook = hook(options, 'PreToolUse');
    expect(decision(await preHook(pre('mcp__x-docs__delete_all', 'b1'), 'b1', signal()))).toBe('deny');
    expect(decision(await preHook(pre('mcp__x-docs__search', 'b2'), 'b2', signal()))).toBe('allow');
  });

  it('a secret no runtime can carry safely refuses the spawn', async () => {
    const sdk = new FakeClaudeSdk({ script: longTurn });
    const adapter = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo,
      sdk,
      stateDir: join(root, 'state'),
    });
    await adapter.probe();
    const bad = { ...mcpDelivery(), secretEnv: { REMYRAL_MCP_DOCS_TOKEN: new SecretValue('a"b') } };
    await expect(adapter.spawn(ctx({ mcp: bad }))).rejects.toThrow(/refused/);
  });
});
