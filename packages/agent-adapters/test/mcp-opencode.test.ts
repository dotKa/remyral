/**
 * p14-mcp-core: OpenCode delivery of a job's external MCP servers (design §2.4, §11.3) against the fixture server —
 * a `remote` entry with `oauth: false` and `{env:NAME}` headers in OPENCODE_CONFIG_CONTENT, an `ask` ruleset for its
 * tools so every call reaches the adapter (allow / ask → `tool.mcp` / deny), metadata-only `mcp_call` events, a call
 * that ran unasked failing the job, a repository opencode.json still refused.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createOpenCodeAdapter,
  InvalidSpawnContextError,
  type OpenCodeAdapterOptions,
  type SequencedEvent,
} from '../src/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';
import { MCP_TOKEN, mcpDelivery, mcpStdioDelivery } from './helpers/mcp.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'fake-opencode.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-mcp-'));
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

function adapter(extra: Partial<OpenCodeAdapterOptions> = {}, env: Record<string, string> = {}) {
  return createOpenCodeAdapter({
    command: process.execPath,
    commandArgs: [FAKE],
    stateDir: join(root, 'state', randomUUID()),
    authMode: 'secret-ref',
    model: 'fake/scripted',
    platform: { os: 'darwin', arch: 'arm64' },
    env,
    policyCheckIntervalMs: 0,
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

describe('opencode: external MCP servers (p14-mcp-core)', { timeout: 30_000 }, () => {
  it('mcpDelivery: streamable HTTP and SSE (OpenCode falls back to SSE)', () => {
    const a = adapter();
    expect(a.mcpDelivery({ mcp: mcpDelivery() })).toEqual({ supported: true });
    expect(a.mcpDelivery({ mcp: mcpDelivery(undefined, { transport: 'sse' }) })).toEqual({ supported: true });
  });

  it('config: remote entry, oauth false, {env:NAME} headers; ruleset asks for its tools; no token on argv', async () => {
    const log = join(root, `launch-${randomUUID()}.log`);
    const rules = join(root, `rules-${randomUUID()}.json`);
    const envFile = join(root, `env-${randomUUID()}.json`);
    const a = adapter(
      {},
      { FAKE_OC_LAUNCH_LOG: log, FAKE_OC_RULESET_FILE: rules, FAKE_OC_ENV_FILE: envFile },
    );
    await a.probe();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcp:x-docs_search' });
    const events = await drain(a, ref, 15_000);
    const first = JSON.parse(readFileSync(log, 'utf8').split('\n')[0] ?? '{}') as {
      configContent: { mcp: Record<string, unknown> };
    };
    expect(first.configContent.mcp['x-docs']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      oauth: false,
      timeout: 120_000,
      headers: { Authorization: '{env:REMYRAL_MCP_H_DOCS_0}', 'X-Team': 'blue' },
    });
    expect(readFileSync(log, 'utf8')).not.toContain(MCP_TOKEN);
    const ruleset = JSON.parse(readFileSync(rules, 'utf8')) as { permission: string; action: string }[];
    expect(ruleset.at(-1)).toEqual({ permission: 'x-docs_*', pattern: '*', action: 'ask' });
    const recorded = JSON.parse(readFileSync(envFile, 'utf8')) as { argv: string[] };
    expect(recorded.argv.join(' ')).not.toContain(MCP_TOKEN);
    // An allowed tool runs without a human (answered once) and is reported.
    expect(events.some((e) => e.event.kind === 'approval_request')).toBe(false);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({ server: 'docs', tool: 'search', decision: 'allow', outcome: 'ok' }),
    ]);
  });

  it('p14-mcp-stdio: a stdio server is a local entry running the launcher; its tools ask', async () => {
    const log = join(root, `launch-${randomUUID()}.log`);
    const rules = join(root, `rules-${randomUUID()}.json`);
    const a = adapter({}, { FAKE_OC_LAUNCH_LOG: log, FAKE_OC_RULESET_FILE: rules });
    const d = mcpStdioDelivery();
    const files = d.servers[0];
    if (files?.transport !== 'stdio') throw new Error('fixture');
    expect(a.mcpDelivery({ mcp: d })).toEqual({ supported: true });
    await a.probe();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST, mcp: d }));
    await a.sendPrompt(ref, { text: 'hello' });
    await drain(a, ref, 15_000);
    const first = JSON.parse(readFileSync(log, 'utf8').split('\n')[0] ?? '{}') as {
      configContent: { mcp: Record<string, unknown> };
    };
    expect(first.configContent.mcp['x-files']).toEqual({
      type: 'local',
      command: [files.command, ...files.args],
      enabled: true,
      timeout: 120_000,
    });
    const ruleset = JSON.parse(readFileSync(rules, 'utf8')) as { permission: string; action: string }[];
    expect(ruleset.at(-1)).toEqual({ permission: 'x-files_*', pattern: '*', action: 'ask' });
  });

  it('deny is rejected without a human (mcp_call denied)', async () => {
    const a = adapter();
    await a.probe();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcp:x-docs_delete_all' });
    const events = await drain(a, ref, 15_000);
    expect(events.some((e) => e.event.kind === 'approval_request')).toBe(false);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({ tool: 'delete_all', decision: 'deny', outcome: 'denied' }),
    ]);
  });

  it('ask raises a tool.mcp approval; approve runs the call', async () => {
    const a = adapter();
    await a.probe();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcp:x-docs_create_issue' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request', 10_000);
    if (req.event.kind !== 'approval_request') throw new Error('no approval');
    expect(req.event).toMatchObject({ action: 'tool.mcp', risk: 'high' });
    expect(req.event.details?.tool).toBe('x-docs/create_issue');
    await a.requestApproval(ref, { approvalId: req.event.approvalId, decision: 'approve', decidedBy: 'u1' });
    const events = await drain(a, ref, 15_000);
    expect(mcpCalls(events)).toEqual([
      expect.objectContaining({ tool: 'create_issue', decision: 'ask', outcome: 'ok' }),
    ]);
  });

  it('a call OpenCode ran without asking fails the job (approval_bypass_detected)', async () => {
    const a = adapter();
    await a.probe();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST, mcp: mcpDelivery() }));
    await a.sendPrompt(ref, { text: 'faux:mcpbypass:x-docs_delete_all' });
    const events = await drain(a, ref, 15_000);
    expect(events.some((e) => e.event.kind === 'error' && e.event.code === 'approval_bypass_detected')).toBe(
      true,
    );
  });

  it('a repository opencode.json is still refused', async () => {
    const ws = workspace();
    writeFileSync(
      join(ws, 'opencode.json'),
      JSON.stringify({ mcp: { evil: { type: 'local', command: ['sh'] } } }),
    );
    const a = adapter();
    await a.probe();
    await expect(
      a.spawn(spawnContext('opencode', ws, { timeouts: FAST, mcp: mcpDelivery() })),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
  });
});
