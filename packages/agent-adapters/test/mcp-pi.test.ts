/**
 * p14-mcp-core: Pi delivery of a job's external MCP servers (design §2.4, §11.4) against the fixture process — our
 * extension registers `x-<id>` with `pi.registerMcpServer` (`-e builtin:mcp`, no `--no-mcp`), headers as `${VAR}`
 * references resolved from the env, a private agent dir, every `mcp__*` call through the gate → adapter (allow / ask →
 * `tool.mcp` / deny), metadata-only `mcp_call` events; local-login is refused (it would read the user's mcp.json).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createPiAdapter, type PiAdapterOptions, type SequencedEvent } from '../src/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';
import { MCP_TOKEN, mcpDelivery, mcpStdioDelivery } from './helpers/mcp.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'fake-pi.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-pi-mcp-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FAST = {
  startupMs: 10_000,
  cancelGraceMs: 500,
  cancelMs: 3_000,
  approvalMs: 5_000,
  maxDurationMs: 60_000,
};

function adapter(extra: Partial<PiAdapterOptions> = {}, env: Record<string, string> = {}) {
  return createPiAdapter({
    command: process.execPath,
    commandArgs: [FAKE],
    stateDir: join(root, 'state', randomUUID()),
    authMode: 'secret-ref',
    model: 'remyral-faux/scripted',
    platform: { os: 'darwin', arch: 'arm64' },
    env,
    ...extra,
  });
}

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

const mcpCalls = (events: readonly SequencedEvent[]) =>
  events.map((e) => e.event).filter((e) => e.kind === 'mcp_call');

describe('pi: external MCP servers (p14-mcp-core)', { timeout: 30_000 }, () => {
  it('mcpDelivery: streamable HTTP with a private agent dir only', () => {
    expect(adapter().mcpDelivery({ mcp: mcpDelivery() })).toEqual({ supported: true });
    expect(adapter().mcpDelivery({ mcp: mcpDelivery(undefined, { transport: 'sse' }) })).toMatchObject({
      supported: false,
    });
    expect(adapter({ authMode: 'local-login' }).mcpDelivery({ mcp: mcpDelivery() })).toMatchObject({
      supported: false,
    });
  });

  it('registers x-docs through our extension, ${VAR} headers from the env, no token on argv; allow runs', async () => {
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const mcpFile = join(root, `mcp-${randomUUID()}.json`);
    const a = adapter({}, { FAKE_PI_ARGV_FILE: argvFile, FAKE_PI_MCP_FILE: mcpFile });
    await a.probe();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcp:mcp__x_docs__search' });
    const events = await drain(a, ref, 15_000);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).not.toContain('--no-mcp');
    expect(argv).toContain('--no-extensions');
    expect(argv).toContain('builtin:mcp');
    expect(argv.join(' ')).not.toContain(MCP_TOKEN);
    const regs = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
      name: string;
      config: Record<string, unknown>;
      missingEnv: string[];
      agentDir: string | null;
    }[];
    expect(regs).toHaveLength(1);
    expect(regs[0]?.name).toBe('x-docs');
    expect(regs[0]?.config).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: '${REMYRAL_MCP_H_DOCS_0}', 'X-Team': 'blue' },
      timeout: 120,
      exposure: 'direct',
      enabled: true,
    });
    expect(regs[0]?.missingEnv).toEqual([]);
    // The agent dir is private to the run (the user's ~/.pi/agent/mcp.json is never read).
    expect(regs[0]?.agentDir).toMatch(/[\\/]run[\\/]pi-[^\\/]+[\\/]agent$/);
    expect(events.some((e) => e.event.kind === 'approval_request')).toBe(false);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({
        server: 'docs',
        tool: 'search',
        decision: 'allow',
        outcome: 'ok',
        durationMs: 3,
      }),
    ]);
  });

  it('p14-mcp-stdio: registers a stdio x-files (launcher command line, no env); local-login still refused', async () => {
    const mcpFile = join(root, `mcp-${randomUUID()}.json`);
    const a = adapter({}, { FAKE_PI_MCP_FILE: mcpFile });
    const d = mcpStdioDelivery();
    const files = d.servers[0];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    expect(a.mcpDelivery({ mcp: d })).toEqual({ supported: true });
    expect(adapter({ authMode: 'local-login' }).mcpDelivery({ mcp: d })).toMatchObject({ supported: false });
    await a.probe();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST, mcp: d }));
    await a.sendPrompt(ref, { text: 'hello' });
    await drain(a, ref, 15_000);
    const regs = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
      name: string;
      config: Record<string, unknown>;
    }[];
    expect(regs).toEqual([
      expect.objectContaining({
        name: 'x-files',
        config: {
          type: 'stdio',
          command: files.command,
          args: [...files.args],
          timeout: 120,
          exposure: 'direct',
          enabled: true,
        },
      }),
    ]);
  });

  it('deny is blocked by the gate without a human (mcp_call denied)', async () => {
    const a = adapter();
    await a.probe();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcp:mcp__x_docs__delete_all' });
    const events = await drain(a, ref, 15_000);
    expect(events.some((e) => e.event.kind === 'approval_request')).toBe(false);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({ tool: 'delete_all', decision: 'deny', outcome: 'denied' }),
    ]);
    const result = events.map((e) => e.event).find((e) => e.kind === 'tool_result');
    expect(result).toMatchObject({ ok: false });
  });

  it('ask raises a tool.mcp approval; approve runs it — also under allow-all', async () => {
    const a = adapter();
    await a.probe();
    const ref = await a.spawn(
      spawnContext('pi', workspace(), { timeouts: FAST, mcp: mcpDelivery(), approvalPolicy: 'allow-all' }),
    );
    await a.sendPrompt(ref, { text: 'faux:mcp:mcp__x_docs__create_issue' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request', 10_000);
    if (req.event.kind !== 'approval_request') throw new Error('no approval');
    expect(req.event).toMatchObject({ action: 'tool.mcp', risk: 'high' });
    await a.requestApproval(ref, { approvalId: req.event.approvalId, decision: 'approve', decidedBy: 'u1' });
    const events = await drain(a, ref, 15_000);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({ tool: 'create_issue', decision: 'ask', outcome: 'ok' }),
    ]);
  });

  it('an MCP tool of no job server is blocked; local-login with MCP is refused', async () => {
    const a = adapter();
    await a.probe();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcp:mcp__x_other__search' });
    const events = await drain(a, ref, 15_000);
    expect(events.map((e) => e.event).find((e) => e.kind === 'tool_result')).toMatchObject({ ok: false });
    const local = adapter({ authMode: 'local-login' });
    await local.probe();
    await expect(
      local.spawn(spawnContext('pi', workspace(), { timeouts: FAST, mcp: mcpDelivery() })),
    ).rejects.toThrow(/private agent dir/);
  });

  it('without MCP for the job: --no-mcp stays', async () => {
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const a = adapter({}, { FAKE_PI_ARGV_FILE: argvFile });
    await a.probe();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).toContain('--no-mcp');
    expect(argv).not.toContain('builtin:mcp');
    await a.cleanup(ref);
  });
});
