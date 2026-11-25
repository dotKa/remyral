/**
 * p14-mcp-core: Codex delivery of a job's external MCP servers (design §2.4, §11.2) against the fake app-server —
 * `-c mcp_servers.x-<id>={…}` with env var names only, every call through the MCP tool-call approval request
 * (allow / ask → `tool.mcp` / deny), the user's own servers still disabled, a same-named user server refused, a call
 * that ran without the worker's decision failing the job, metadata-only `mcp_call` events.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createCodexAdapter,
  InvalidSpawnContextError,
  type CodexAdapter,
  type CodexAdapterOptions,
  type SequencedEvent,
  type SessionRef,
  type SpawnContext,
} from '../src/index.js';
import { collectUntilStopped, readUntil } from '../src/testing/index.js';
import { codexTestStateDir, FAKE_APP_SERVER } from './fixtures/codex/helpers.js';
import { MCP_TOKEN, mcpDelivery, mcpStdioDelivery } from './helpers/mcp.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const stateDir = codexTestStateDir();
const wsRoot = mkdtempSync(join(tmpdir(), 'remyral-codex-mcp-'));
const opened: { adapter: CodexAdapter; ref: SessionRef }[] = [];
afterEach(async () => {
  for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
});
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-codex-mcp'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: mkdtempSync(join(wsRoot, 'ws-')),
    job: { runtime: 'codex', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'runtime-sandbox',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: {
      startupMs: 10_000,
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

function make(extra: CodexAdapterOptions = {}): CodexAdapter {
  return createCodexAdapter({
    codexPath: FAKE_APP_SERVER,
    stateDir,
    sourceEnv: { PATH: process.env.PATH },
    ...extra,
  });
}

async function start(adapter: CodexAdapter, c: SpawnContext, prompt: string): Promise<SessionRef> {
  await adapter.probe();
  const ref = await adapter.spawn(c);
  opened.push({ adapter, ref });
  await adapter.sendPrompt(ref, { text: prompt });
  return ref;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

async function waitFile(file: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} not written`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const mcpCalls = (events: SequencedEvent[]) =>
  events.map((e) => e.event).filter((e) => e.kind === 'mcp_call');

describePosix('codex: external MCP servers (p14-mcp-core)', { timeout: 30_000 }, () => {
  it('mcpDelivery: streamable HTTP only', () => {
    const a = make();
    expect(a.mcpDelivery({ mcp: mcpDelivery() })).toEqual({ supported: true });
    expect(a.mcpDelivery({ mcp: mcpDelivery(undefined, { transport: 'sse' }) })).toMatchObject({
      supported: false,
    });
  });

  it('allow / ask / deny decided on the approval request; env names on argv, the value only in the env', async () => {
    const home = mkdtempSync(join(stateDir, 'user-home-'));
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.mine]\ncommand = "/bin/sh"\n');
    const adapter = make({ authMode: 'local-login', loginDir: home });
    const c = ctx({ mcp: mcpDelivery() });
    // Planted repository Codex config: never loaded (the workspace is marked untrusted).
    writeFileSync(
      join(c.workspaceRoot, '.codex-config-planted.toml'),
      '[mcp_servers.repo]\ncommand = "sh"\n',
    );
    const ref = await start(adapter, c, 'mcp:x-docs/search,x-docs/delete_all,x-docs/create_issue');
    const events = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 10_000);
    const req = events.map((e) => e.event).find((e) => e.kind === 'approval_request');
    expect(req).toMatchObject({ action: 'tool.mcp', risk: 'high' });
    expect(req?.kind === 'approval_request' ? req.details?.tool : '').toBe('x-docs/create_issue');
    if (req?.kind !== 'approval_request') throw new Error('no approval');
    await adapter.requestApproval(ref, { approvalId: req.approvalId, decision: 'approve', decidedBy: 'u1' });
    const all = await collectUntilStopped(adapter, ref, 10_000);
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
    const answers = readJson<{ answers: string[] }>(join(c.workspaceRoot, '.fake-codex-mcp.json')).answers;
    expect(answers).toEqual(['accept', 'decline', 'accept']);
    const calls = mcpCalls(all);
    expect(calls).toEqual([
      expect.objectContaining({
        server: 'docs',
        tool: 'search',
        decision: 'allow',
        outcome: 'ok',
        durationMs: 7,
      }),
      expect.objectContaining({ tool: 'delete_all', decision: 'deny', outcome: 'denied' }),
      expect.objectContaining({ tool: 'create_issue', decision: 'ask', outcome: 'ok' }),
    ]);
    // argv: the server and env var names, never the token; the process env carries the formatted value.
    const rec = readJson<{ argv: string[]; envNames: string[] }>(join(c.workspaceRoot, '.fake-codex.json'));
    expect(rec.argv.join(' ')).not.toContain(MCP_TOKEN);
    expect(
      rec.argv.some((a) => a.startsWith('mcp_servers.x-docs={ url = "https://mcp.example.com/mcp"')),
    ).toBe(true);
    expect(rec.envNames).toContain('REMYRAL_MCP_H_DOCS_0');
    // The user's own server is disabled; the job's own is not; shell tools never see the MCP env.
    const start0 = readJson<{ config: { mcp_servers: Record<string, unknown> } }>(
      join(c.workspaceRoot, '.fake-codex-start.json'),
    );
    expect(start0.config.mcp_servers).toEqual({ mine: { enabled: false } });
    const exclude = rec.argv.find((a) => a.startsWith('shell_environment_policy.exclude=')) ?? '';
    expect(exclude).toContain('"REMYRAL_MCP_H_DOCS_0"');
    expect(exclude).toContain('"REMYRAL_MCP_DOCS_TOKEN"');
    // The job's own startup status is fine (no mcp_isolation_failed).
    expect(all.some((e) => e.event.kind === 'error' && e.event.code === 'mcp_isolation_failed')).toBe(false);
  });

  it('a reviewer deny declines the call (mcp_call denied, decision ask)', async () => {
    const adapter = make();
    const c = ctx({ mcp: mcpDelivery() });
    const ref = await start(adapter, c, 'mcp:x-docs/create_issue');
    const events = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 10_000);
    const req = events.map((e) => e.event).find((e) => e.kind === 'approval_request');
    if (req?.kind !== 'approval_request') throw new Error('no approval');
    await adapter.requestApproval(ref, { approvalId: req.approvalId, decision: 'deny', decidedBy: 'u1' });
    const all = await collectUntilStopped(adapter, ref, 10_000);
    expect(mcpCalls(all)).toEqual([
      expect.objectContaining({ tool: 'create_issue', decision: 'ask', outcome: 'denied' }),
    ]);
    expect(readJson<{ answers: string[] }>(join(c.workspaceRoot, '.fake-codex-mcp.json')).answers).toEqual([
      'decline',
    ]);
  });

  it('a call that ran without the worker deciding fails the job closed (mcp_policy_bypass)', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx({ mcp: mcpDelivery() }), 'mcp-bypass:x-docs/delete_all');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.some((e) => e.event.kind === 'error' && e.event.code === 'mcp_policy_bypass')).toBe(true);
    expect((await adapter.collectResult(ref)).errorCode).toBe('mcp_policy_bypass');
  });

  it("a server of the user's config.toml with the job server's name is refused (its fields would merge)", async () => {
    const home = mkdtempSync(join(stateDir, 'user-home-'));
    writeFileSync(join(home, 'config.toml'), '[mcp_servers."x-docs"]\ncommand = "/bin/sh"\n');
    const adapter = make({ authMode: 'local-login', loginDir: home });
    await adapter.probe();
    await expect(adapter.spawn(ctx({ mcp: mcpDelivery() }))).rejects.toBeInstanceOf(InvalidSpawnContextError);
  });

  it('p14-mcp-stdio: a stdio server is a bare-key launcher override, checked against config/read', async () => {
    const adapter = make();
    const d = mcpStdioDelivery();
    expect(adapter.mcpDelivery({ mcp: d })).toEqual({ supported: true });
    const c = ctx({ mcp: d });
    const ref = await start(adapter, c, 'basic');
    await collectUntilStopped(adapter, ref, 10_000);
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
    const rec = readJson<{ argv: string[] }>(join(c.workspaceRoot, '.fake-codex.json'));
    const o = rec.argv.find((a) => a.startsWith('mcp_servers.x-files={ command = ')) ?? '';
    expect(o).toContain('env_vars = ["HTTPS_PROXY", "NO_PROXY"]');
    expect(o).toContain('x-files.launch.json');
    expect(o).not.toContain('env =');
  });

  it('without MCP for the job nothing changes: no mcp_servers override', async () => {
    const adapter = make();
    const c = ctx();
    const ref = await start(adapter, c, 'basic');
    await collectUntilStopped(adapter, ref, 10_000);
    await waitFile(join(c.workspaceRoot, '.fake-codex.json'));
    const rec = readJson<{ argv: string[] }>(join(c.workspaceRoot, '.fake-codex.json'));
    expect(rec.argv.some((a) => a.startsWith('mcp_servers'))).toBe(false);
  });
});
