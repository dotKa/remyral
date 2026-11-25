/**
 * OpenCode assistant engine against a stand-in server (fixtures/opencode/fake-opencode-assistant.mjs): runs
 * everywhere, no OpenCode installation needed. The real 1.19.0 binary is covered by
 * opencode-assistant-real.test.ts (opt-in).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildOpenCodeAssistantConfig,
  configDrift,
  OPENCODE_ASSISTANT_TOKEN_ENV,
  OpenCodeAssistantEngine,
  SecretValue,
  type AssistantSessionOptions,
  type AssistantToolBridge,
  type OpenCodeAssistantEngineOptions,
} from '../src/index.js';

const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'opencode',
  'fake-opencode-assistant.mjs',
);
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-assist-'));
mkdirSync(join(root, 'state'), { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function engine(extra: Partial<OpenCodeAssistantEngineOptions> = {}): OpenCodeAssistantEngine {
  return new OpenCodeAssistantEngine({
    command: () => ({ command: process.execPath, args: [FAKE] }),
    stateRoot: join(root, 'state'),
    settings: () => ({
      model: 'fake/scripted',
      config: {
        provider: { fake: { npm: '@ai-sdk/openai-compatible', models: { scripted: {} } } },
        // An operator config must not be able to grant anything:
        permission: { '*': 'allow' },
        tools: { bash: true },
        plugin: ['evil'],
        mcp: { other: { type: 'local', command: ['x'] } },
        instructions: ['AGENTS.md'],
      },
    }),
    ...extra,
  });
}

const calls: { tool: string; input: Record<string, unknown> }[] = [];
const bridge: AssistantToolBridge = {
  call: (tool, input) => {
    calls.push({ tool, input });
    return Promise.resolve({ content: '{"workers":["mac-1"]}', isError: false });
  },
};

function options(
  extra: Partial<AssistantSessionOptions> = {},
  env: Record<string, string> = {},
): AssistantSessionOptions & { envFile: string } {
  const dir = join(root, 's', randomUUID());
  const cwd = join(dir, 'work');
  const stateDir = join(dir, 'state');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const envFile = join(dir, 'env.json');
  return {
    cwd,
    stateDir,
    envFile,
    authMode: 'secret-ref',
    secretEnv: {},
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 10_000, turnMs: 20_000, cancelGraceMs: 1_000 },
    tools: bridge,
    env: { FAKE_OC_ENV_FILE: envFile, ...env },
    ...extra,
  };
}

const never = new AbortController().signal;

describe('buildOpenCodeAssistantConfig', () => {
  const config = buildOpenCodeAssistantConfig({
    mcpUrl: 'http://127.0.0.1:1234/mcp',
    systemPrompt: 'SYSTEM',
    model: 'p/m',
    operator: {
      provider: { p: {} },
      permission: { '*': 'allow' },
      tools: { bash: true },
      plugin: ['x'],
      agent: { build: { tools: { bash: true } } },
      mcp: { evil: {} },
      instructions: ['x'],
      default_agent: 'build',
    },
  });

  it('allows the platform tools only, at config and agent level', () => {
    expect(config.tools).toEqual({ '*': false, 'remyral_*': true });
    expect(config.permission).toEqual({ '*': 'deny', 'remyral_*': 'allow' });
    const agents = config.agent as Record<string, Record<string, unknown>>;
    expect(config.default_agent).toBe('remyral-assistant');
    expect(agents['remyral-assistant']).toMatchObject({
      mode: 'primary',
      prompt: 'SYSTEM',
      tools: { '*': false, 'remyral_*': true },
      permission: { '*': 'deny', 'remyral_*': 'allow' },
    });
    for (const a of ['build', 'plan', 'general', 'explore']) expect(agents[a]).toEqual({ disable: true });
  });

  it('serves the tools from one remote MCP server whose token comes from the env', () => {
    expect(config.mcp).toEqual({
      remyral: {
        type: 'remote',
        url: 'http://127.0.0.1:1234/mcp',
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer {env:${OPENCODE_ASSISTANT_TOKEN_ENV}}` },
      },
    });
  });

  it('keeps operator providers but nothing that grants tools, plugins or instructions', () => {
    expect(config.provider).toEqual({ p: {} });
    expect(config.plugin).toEqual([]);
    expect(config.instructions).toEqual([]);
    expect(config.lsp).toBe(false);
    expect(config.formatter).toBe(false);
    expect(config.snapshot).toBe(false);
    expect(config.share).toBe('disabled');
  });

  it('detects drift of the effective configuration', () => {
    expect(configDrift(config as never)).toEqual([]);
    expect(
      configDrift({ ...config, permission: { '*': 'deny', 'remyral_*': 'allow', bash: 'allow' } }),
    ).toEqual(['permission.bash']);
    expect(configDrift({ ...config, tools: { '*': false, 'remyral_*': true, bash: true } })).toEqual([
      'tools.bash',
    ]);
    expect(configDrift({ ...config, plugin: ['x'] })).toEqual(['plugin']);
    expect(configDrift({ ...config, default_agent: 'build' })).toEqual(['default_agent']);
  });
});

describe('OpenCodeAssistantEngine (stand-in server)', { timeout: 60_000 }, () => {
  it('ready(): pinned version yes, another version only with allowUnpinned, missing binary no', async () => {
    expect(await engine().ready()).toEqual({ ready: true });
    const other = { ...process.env, FAKE_OC_VERSION: '1.20.0' };
    expect((await engine({ sourceEnv: other }).ready()).ready).toBe(true); // env allowlist drops FAKE_*
    expect(await engine({ command: () => null }).ready()).toEqual({
      ready: false,
      reason: 'OpenCode is not installed on this worker',
    });
  });

  it('starts with our config, the token in the env only, and streams an answer with usage', async () => {
    const o = options();
    const s = await engine().start(o);
    try {
      const deltas: string[] = [];
      const r = await s.turn({ message: 'hi', history: null }, { delta: (t) => deltas.push(t) }, never);
      expect(r.outcome).toBe('done');
      expect(r.text).toBe('hello world');
      expect(deltas.join('')).toBe('hello world');
      expect(r.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 40,
        turns: 1,
        costUsd: 0.25,
        provenance: 'reported-by-runtime',
        model: 'scripted',
      });
      const seen = JSON.parse(readFileSync(o.envFile, 'utf8')) as {
        argv: string[];
        env: Record<string, string>;
      };
      expect(seen.argv.slice(0, 3)).toEqual(['serve', '--hostname', '127.0.0.1']);
      expect(seen.env[OPENCODE_ASSISTANT_TOKEN_ENV]).toBe('set');
      expect(seen.env.OPENCODE_SERVER_PASSWORD).toBe('set');
      expect(seen.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      expect(seen.env.HOME).toBe(join(o.stateDir ?? '', 'home'));
      expect(seen.env.XDG_DATA_HOME).toBe(join(o.stateDir ?? '', 'data'));
      expect(JSON.parse(seen.env.OPENCODE_PERMISSION ?? '')).toEqual({ '*': 'deny', 'remyral_*': 'allow' });
      const content = seen.env.OPENCODE_CONFIG_CONTENT ?? '';
      expect(content).toContain(`{env:${OPENCODE_ASSISTANT_TOKEN_ENV}}`);
      expect(content).not.toMatch(/Bearer [A-Za-z0-9_-]{40,}/);
      expect(JSON.stringify(seen.argv)).not.toMatch(/Bearer|[A-Za-z0-9_-]{43}/);
      const config = JSON.parse(content) as Record<string, unknown>;
      expect(config.tools).toEqual({ '*': false, 'remyral_*': true });
      expect(config.plugin).toEqual([]);
      expect(Object.keys(config.mcp as object)).toEqual(['remyral']);
      expect(config.provider).toBeDefined();
    } finally {
      await s.close();
    }
  });

  it('relays tool calls through the loopback MCP endpoint to the bridge', async () => {
    calls.length = 0;
    const s = await engine().start(options());
    try {
      const r = await s.turn({ message: 'faux:tool', history: null }, { delta: () => undefined }, never);
      expect(r.outcome).toBe('done');
      expect(r.text).toBe(
        `init:remyral tools:${String(ASSISTANT_TOOL_NAMES.length)} result:{"workers":["mac-1"]}`,
      );
      expect(calls).toEqual([{ tool: 'list_workers', input: { state: 'online' } }]);
    } finally {
      await s.close();
    }
  });

  it('local-login keeps the worker user HOME and data dir (OpenCode finds its own auth.json)', async () => {
    const o = options({ authMode: 'local-login' });
    const s = await engine({ sourceEnv: { ...process.env, HOME: '/home/worker-user' } }).start(o);
    await s.close();
    const seen = JSON.parse(readFileSync(o.envFile, 'utf8')) as { env: Record<string, string> };
    expect(seen.env.HOME).toBe('/home/worker-user');
    expect(seen.env.XDG_DATA_HOME).toBeUndefined();
    expect(seen.env.XDG_CONFIG_HOME).toBe(join(o.stateDir ?? '', 'config'));
  });

  it('refuses to start when the effective configuration drifted', async () => {
    await expect(engine().start(options({}, { FAKE_OC_DRIFT: '1' }))).rejects.toThrow(
      /effective configuration differs: permission\.bash/,
    );
  });

  it('refuses a server that is not the pinned version', async () => {
    await expect(engine().start(options({}, { FAKE_OC_VERSION: '1.20.0' }))).rejects.toThrow(
      /not the pinned 1\.19\.4/,
    );
    const s = await engine({ allowUnpinned: () => true }).start(options({}, { FAKE_OC_VERSION: '1.20.0' }));
    await s.close();
  });

  it('cancels a running turn through the abort route', async () => {
    const s = await engine().start(options());
    try {
      const ac = new AbortController();
      const p = s.turn({ message: 'faux:hang', history: null }, { delta: () => undefined }, ac.signal);
      setTimeout(() => {
        ac.abort();
      }, 300);
      const r = await p;
      expect(r.outcome).toBe('cancelled');
      expect(s.alive).toBe(true);
      const again = await s.turn({ message: 'hi', history: null }, { delta: () => undefined }, never);
      expect(again.outcome).toBe('done');
    } finally {
      await s.close();
    }
  });

  it('fails a turn that takes too long', async () => {
    const s = await engine().start(
      options({ timeouts: { startupMs: 10_000, turnMs: 400, cancelGraceMs: 500 } }),
    );
    try {
      const r = await s.turn({ message: 'faux:hang', history: null }, { delta: () => undefined }, never);
      expect(r.outcome).toBe('failed');
      expect(r.errorCode).toBe('turn_timeout');
    } finally {
      await s.close();
    }
  });

  it('a crash fails the turn and ends the session', async () => {
    const s = await engine().start(options());
    const r = await s.turn({ message: 'faux:crash', history: null }, { delta: () => undefined }, never);
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_crashed');
    expect(s.alive).toBe(false);
    const after = await s.turn({ message: 'hi', history: null }, { delta: () => undefined }, never);
    expect(after.errorCode).toBe('session_ended');
  });

  it('fails closed when a non-platform tool ran', async () => {
    const s = await engine().start(options());
    const r = await s.turn({ message: 'faux:foreign', history: null }, { delta: () => undefined }, never);
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/non-platform tool ran \(bash\)/);
    expect(s.alive).toBe(false);
  });

  it('redacts an injected secret even when it is split across streamed parts', async () => {
    const secret = 'sk-test-0123456789abcdefghijklmnop';
    const s = await engine().start(
      options({ secretEnv: { FAKE_KEY: new SecretValue(secret) } }, { FAKE_SECRET_NAME: 'FAKE_KEY' }),
    );
    try {
      const deltas: string[] = [];
      const r = await s.turn(
        { message: 'faux:secret', history: null },
        { delta: (t) => deltas.push(t) },
        never,
      );
      expect(r.outcome).toBe('done');
      expect(deltas.join('')).not.toContain(secret);
      expect(r.text).not.toContain(secret);
      expect(deltas.join('')).toContain('key ');
    } finally {
      await s.close();
    }
  });

  it('removes the state dir it created itself on close', async () => {
    const o = options();
    const { stateDir: _drop, ...rest } = o;
    const before = readdirSync(join(root, 'state')).length;
    const s = await engine().start(rest);
    expect(readdirSync(join(root, 'state')).length).toBe(before + 1);
    await s.close();
    expect(readdirSync(join(root, 'state')).length).toBe(before);
  });
});
