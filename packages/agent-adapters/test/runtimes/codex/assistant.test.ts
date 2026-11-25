import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_SYSTEM_PROMPT,
  type AssistantSession,
  type AssistantSessionOptions,
  type AssistantToolBridge,
  CODEX_ASSISTANT_OVERRIDES,
  CodexAssistantEngine,
  type CodexAssistantEngineOptions,
  codexRawItemRefusal,
  SecretValue,
} from '../../../src/index.js';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('../../fixtures/codex/fake-assistant-app-server.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'remyral-codex-assistant-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Line = Record<string, unknown>;

function log(cwd: string): Line[] {
  const file = join(cwd, '.fake-codex-assistant.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
}
const sent = (cwd: string, method: string): Line | undefined =>
  log(cwd)
    .map((l) => l.in as Line | undefined)
    .find((m) => m?.method === method);

interface Calls {
  readonly calls: { tool: string; input: Record<string, unknown>; callId: string }[];
}

function bridge(answer = '{"workers":2}'): AssistantToolBridge & Calls {
  const calls: Calls['calls'] = [];
  return {
    calls,
    call: (tool, input, callId) => {
      calls.push({ tool, input, callId });
      return Promise.resolve({ content: answer, isError: false });
    },
  };
}

function engine(extra: Partial<CodexAssistantEngineOptions> = {}) {
  return new CodexAssistantEngine({
    command: () => ({ command: FAKE, args: [] }),
    stateRoot: join(root, 'state'),
    sourceEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
    ...extra,
  });
}

let n = 0;
function opts(over: Partial<AssistantSessionOptions> = {}): AssistantSessionOptions & { cwd: string } {
  n += 1;
  const cwd = mkdtempSync(join(root, `s${String(n)}-`));
  return {
    cwd,
    stateDir: mkdtempSync(join(root, `st${String(n)}-`)),
    authMode: 'local-login',
    secretEnv: {},
    tools: bridge(),
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 20_000, turnMs: 20_000, cancelGraceMs: 1_000 },
    ...over,
  };
}

async function turn(s: AssistantSession, message: string, signal = new AbortController().signal) {
  const deltas: string[] = [];
  const r = await s.turn({ message, history: null }, { delta: (t) => deltas.push(t) }, signal);
  return { ...r, deltas };
}

describe('CodexAssistantEngine (fake app-server)', { timeout: 60_000 }, () => {
  it('reports readiness from --version against the pin', async () => {
    expect(await engine().ready()).toEqual({ ready: true });
    const missing = new CodexAssistantEngine({ command: () => null, stateRoot: root });
    expect(await missing.ready()).toEqual({ ready: false, reason: 'Codex is not installed on this worker' });
  });

  it('starts an ephemeral, read-only thread whose only tools are the platform tools', async () => {
    const o = opts();
    const s = await engine().start(o);
    try {
      const start = log(o.cwd).find((l) => l.start === true) as { argv: string[] };
      expect(start.argv.slice(0, 5)).toEqual([
        '--no-daemon',
        'app-server',
        '--listen',
        'stdio://',
        '--strict-config',
      ]);
      for (const ov of CODEX_ASSISTANT_OVERRIDES) expect(start.argv).toContain(ov);
      expect(start.argv).toContain('features.shell_tool=false');
      expect(start.argv).toContain('web_search="disabled"');
      const init = sent(o.cwd, 'initialize') as { params: { capabilities: { experimentalApi: boolean } } };
      expect(init.params.capabilities.experimentalApi).toBe(true);
      const t = sent(o.cwd, 'thread/start') as { params: Record<string, unknown> };
      expect(t.params).toMatchObject({
        cwd: o.cwd,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        baseInstructions: ASSISTANT_SYSTEM_PROMPT,
        environments: [],
        experimentalRawEvents: true,
      });
      // Code mode stays off; the platform tools stay direct even for a code_mode_only model; no sub-agents.
      expect(start.argv).toContain('features.code_mode_host=false');
      expect(start.argv).toContain('features.code_mode={ direct_only_tool_namespaces = ["functions"] }');
      expect(start.argv).toContain('agents.enabled=false');
      expect(start.argv).toContain('features.multi_agent_v2=false');
      const tools = t.params.dynamicTools as { type: string; name: string; inputSchema: { type: string } }[];
      expect(tools.map((x) => x.name)).toEqual(ASSISTANT_TOOL_NAMES);
      expect(tools.every((x) => x.type === 'function' && x.inputSchema.type === 'object')).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('disables the MCP servers of the user configuration before the thread starts', async () => {
    const o = opts();
    const o2 = { ...o, env: { FAKE_MCP_SERVERS: '{"evil":{"command":"x"},"a.b":{"command":"y"}}' } };
    const s = await engine().start(o2);
    try {
      const t = sent(o.cwd, 'thread/start') as { params: { config: Record<string, unknown> } };
      expect(t.params.config.mcp_servers).toEqual({ evil: { enabled: false }, 'a.b': { enabled: false } });
      expect(t.params.config.notify).toEqual([]);
      const r = await turn(s, 'hi');
      expect(r.outcome).toBe('done');
    } finally {
      await s.close();
    }
  });

  it('streams deltas and reports per-turn usage without dollars', async () => {
    const o = opts();
    const s = await engine().start(o);
    try {
      const r1 = await turn(s, 'hi');
      expect(r1.outcome).toBe('done');
      expect(r1.text).toBe('Hello world');
      expect(r1.deltas.join('')).toBe('Hello world');
      expect(r1.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        authMode: 'local-login',
      });
      expect(r1.usage.costUsd).toBeUndefined();
      expect(r1.usage.provenance).toBe('estimated-from-tokens');
      const r2 = await turn(s, 'again');
      // The second turn reports its own increment, not the thread's cumulative total.
      expect(r2.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
      expect(s.alive).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('relays a platform tool call and answers it as a dynamic tool result', async () => {
    const b = bridge('{"workers":["mac","pi"]}');
    const o = opts({ tools: b });
    const s = await engine().start(o);
    try {
      const r = await turn(s, 'tool please');
      expect(r.outcome).toBe('done');
      expect(b.calls).toEqual([{ tool: 'list_workers', input: { limit: 5 }, callId: 'call_1' }]);
      const answer = log(o.cwd).find((l) => l.toolAnswer !== undefined)?.toolAnswer as { result: unknown };
      expect(answer.result).toEqual({
        contentItems: [{ type: 'inputText', text: '{"workers":["mac","pi"]}' }],
        success: true,
      });
      expect(r.text).toContain('Result(true)');
    } finally {
      await s.close();
    }
  });

  it('refuses a tool that is not a platform tool', async () => {
    const b = bridge();
    const o = opts({ tools: b });
    const s = await engine().start(o);
    try {
      const r = await turn(s, 'foreign');
      expect(b.calls).toEqual([]);
      expect(r.text).toContain('Result(false)');
      const answer = log(o.cwd).find((l) => l.toolAnswer !== undefined)?.toolAnswer as {
        result: { success: boolean };
      };
      expect(answer.result.success).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('ends the session with a clear engine error when the model calls code mode', async () => {
    const b = bridge();
    const o = opts({ tools: b });
    const s = await engine().start(o);
    const r = await turn(s, 'codemode');
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('code_mode_refused');
    expect(r.detail).toContain('`exec`');
    expect(r.detail).toContain('Settings → Chat');
    // The model's narration of the failure is not delivered as an answer.
    expect(r.text).not.toContain('code-mode host is disabled');
    expect(b.calls).toEqual([]);
    expect(s.alive).toBe(false);
    await s.close();
  });

  it('denies an approval request and fails closed', async () => {
    const o = opts();
    const s = await engine().start(o);
    const r = await turn(s, 'approval');
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_refused');
    expect(s.alive).toBe(false);
    await s.close();
    const answer = log(o.cwd).find((l) => l.approvalAnswer !== undefined)?.approvalAnswer as {
      result: unknown;
    };
    expect(answer.result).toEqual({ decision: 'cancel' });
  });

  it('fails closed when a built-in tool item starts', async () => {
    const s = await engine().start(opts());
    const r = await turn(s, 'builtin');
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_refused');
    expect(r.detail).toContain('commandExecution');
    expect(s.alive).toBe(false);
    await s.close();
  });

  it('fails closed when the thread does not run read-only / never-ask', async () => {
    await expect(engine().start(opts({ env: { FAKE_APPROVAL: 'on-request' } }))).rejects.toThrow(
      /assistant thread refused/,
    );
  });

  it('refuses another Codex version unless unpinned versions are allowed', async () => {
    const other = { env: { FAKE_CODEX_VERSION: '0.170.0' } };
    await expect(engine().start(opts(other))).rejects.toThrow(/not the pinned/);
    const s = await engine({ allowUnpinned: () => true }).start(opts(other));
    await s.close();
  });

  it('cancels a running turn with turn/interrupt', async () => {
    const o = opts();
    const s = await engine().start(o);
    try {
      const ac = new AbortController();
      const pending = turn(s, 'long', ac.signal);
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      const r = await pending;
      expect(r.outcome).toBe('cancelled');
      expect(sent(o.cwd, 'turn/interrupt')).toMatchObject({ params: { turnId: 'turn-1' } });
      expect(s.alive).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('times out a turn that ignores the interrupt and ends the session', async () => {
    const s = await engine().start(
      opts({ timeouts: { startupMs: 20_000, turnMs: 400, cancelGraceMs: 300 } }),
    );
    const r = await turn(s, 'hang');
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('turn_timeout');
    expect(s.alive).toBe(false);
    await s.close();
  });

  it('reports a crashed app-server as a failed turn and a dead session', async () => {
    const s = await engine().start(opts());
    const r = await turn(s, 'crash');
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_crashed');
    expect(s.alive).toBe(false);
    const again = await turn(s, 'hi');
    expect(again.errorCode).toBe('session_ended');
  });

  it('secret-ref: private CODEX_HOME, key only in env, split secret redacted from deltas', async () => {
    const key = 'sk-test-0123456789abcdefghij';
    const o = opts({ authMode: 'secret-ref', secretEnv: { CODEX_API_KEY: new SecretValue(key) } });
    const s = await engine().start(o);
    try {
      const start = log(o.cwd).find((l) => l.start === true) as {
        argv: string[];
        envNames: string[];
        codexHome: string;
      };
      expect(start.argv.join(' ')).not.toContain(key);
      expect(start.argv).toContain('cli_auth_credentials_store="ephemeral"');
      // The app-server ignores CODEX_API_KEY: a provider entry reads the key from that variable instead.
      expect(start.argv).toContain('model_provider="remyral-openai"');
      expect(start.argv.join(' ')).toContain('env_key = "CODEX_API_KEY"');
      expect(start.envNames).toContain('CODEX_API_KEY');
      expect(start.codexHome.startsWith(o.stateDir ?? '')).toBe(true);
      const r = await turn(s, 'secret');
      expect(r.outcome).toBe('done');
      expect(r.deltas.join('')).not.toContain(key);
      expect(r.text).not.toContain(key);
      expect(r.deltas.join('')).toContain('[REDACTED');
      expect(JSON.stringify(log(o.cwd).filter((l) => l.in !== undefined))).not.toContain(key);
    } finally {
      await s.close();
    }
    // The private home is removed with the session.
    expect(readdirSync(o.stateDir ?? '')).toEqual([]);
  });

  it('local-login refuses injected provider keys', async () => {
    await expect(
      engine().start(
        opts({ authMode: 'local-login', secretEnv: { OPENAI_API_KEY: new SecretValue('sk-x') } }),
      ),
    ).rejects.toThrow();
  });
});

describe('codexRawItemRefusal (model tool calls on the raw item stream)', () => {
  it('lets through only platform tools called as plain functions', () => {
    expect(codexRawItemRefusal({ type: 'function_call', name: 'list_workers' })).toBeNull();
    expect(codexRawItemRefusal({ type: 'function_call', name: 'list_workers', namespace: null })).toBeNull();
    expect(
      codexRawItemRefusal({ type: 'function_call', name: 'list_workers', namespace: 'functions' }),
    ).toBeNull();
    // Not tool calls: messages, reasoning, outputs.
    for (const type of [
      'message',
      'reasoning',
      'function_call_output',
      'custom_tool_call_output',
      'additional_tools',
    ]) {
      expect(codexRawItemRefusal({ type })).toBeNull();
    }
  });

  it("refuses code mode's exec / wait with the code-mode error", () => {
    expect(codexRawItemRefusal({ type: 'custom_tool_call', name: 'exec' })?.code).toBe('code_mode_refused');
    expect(codexRawItemRefusal({ type: 'function_call', name: 'wait' })?.code).toBe('code_mode_refused');
  });

  it('refuses every other call: catalog-added, namespaced, shell, hosted tools', () => {
    const refused = [
      { type: 'function_call', name: 'request_user_input_async' },
      { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration' },
      { type: 'function_call', name: 'list_workers', namespace: 'evil' },
      { type: 'custom_tool_call', name: 'list_workers' },
      { type: 'local_shell_call' },
      { type: 'web_search_call' },
      { type: 'tool_search_call' },
      { type: 'image_generation_call' },
    ];
    for (const item of refused) expect(codexRawItemRefusal(item)?.code).toBe('runtime_refused');
  });
});
