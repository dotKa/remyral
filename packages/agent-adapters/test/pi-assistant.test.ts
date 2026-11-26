/**
 * Pi ops chat assistant engine against the stand-in (fixtures/pi/fake-pi-assistant.mjs), which runs the
 * engine's REAL tool-bridge extension: argv policy, tool relay over the extension-UI sub-protocol, foreign
 * dialogs and tools refused, streaming, cancel/timeout, crash, secret redaction, usage.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import {
  ASSISTANT_SYSTEM_PROMPT,
  PI_ASSISTANT_EXTENSION_FILE,
  PiAssistantEngine,
  SecretValue,
  type AssistantSessionOptions,
  type AssistantToolBridge,
  type PiAssistantEngineOptions,
} from '../src/index.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'fake-pi-assistant.mjs');
const WITH_ENV = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'with-env.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-pi-assistant-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FAST = { startupMs: 10_000, turnMs: 10_000, cancelGraceMs: 500 };

/** `env` reaches the stand-in through with-env.mjs (the engine passes only an allowlisted environment). */
function engine(extra: Partial<PiAssistantEngineOptions> = {}, env: Record<string, string> = {}) {
  const pre = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return new PiAssistantEngine({
    command: () =>
      pre.length === 0
        ? { command: process.execPath, args: [FAKE] }
        : { command: process.execPath, args: [WITH_ENV, ...pre, FAKE] },
    stateRoot: join(root, 'state'),
    settings: () => ({ model: 'remyral-faux/scripted' }),
    ...extra,
  });
}

interface Recorded {
  calls: { tool: string; input: Record<string, unknown>; callId: string }[];
}

function session(
  over: Partial<AssistantSessionOptions> = {},
): AssistantSessionOptions & { recorded: Recorded; argvFile: string } {
  const dir = join(root, 's', randomUUID());
  mkdirSync(join(dir, 'work'), { recursive: true });
  const recorded: Recorded = { calls: [] };
  const tools: AssistantToolBridge = {
    call: (tool, input, callId) => {
      recorded.calls.push({ tool, input, callId });
      return Promise.resolve({ content: '{"workers":["w1"]}', isError: tool === 'describe_worker' });
    },
  };
  return {
    cwd: join(dir, 'work'),
    stateDir: join(dir, 'state'),
    authMode: 'secret-ref',
    secretEnv: {},
    tools,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: FAST,
    env: { FAKE_PI_ARGV_FILE: join(dir, 'argv.json') },
    recorded,
    argvFile: join(dir, 'argv.json'),
    ...over,
  };
}

function sink() {
  const deltas: string[] = [];
  return { deltas, sink: { delta: (t: string) => deltas.push(t) } };
}

describe('PiAssistantEngine (fixture process)', () => {
  it('is ready only with the pinned version unless unpinned versions are allowed', async () => {
    expect(await engine().ready()).toEqual({ ready: true });
    expect((await engine({}, { FAKE_PI_VERSION: '1.2.0' }).ready()).reason).toContain('not the pinned 1.6.0');
    expect(await engine({ allowUnpinned: () => true }, { FAKE_PI_VERSION: '1.2.0' }).ready()).toEqual({
      ready: true,
    });
    expect((await engine({ command: () => null }).ready()).reason).toContain('not installed');
  });

  it('starts Pi with only the platform tools, no other extension, skill, MCP or transcript', async () => {
    const o = session();
    const s = await engine().start(o);
    try {
      const rec = JSON.parse(readFileSync(o.argvFile, 'utf8')) as {
        argv: string[];
        cwd: string;
        agentDir: string | null;
      };
      const a = rec.argv;
      for (const flag of [
        '--offline',
        '--no-approve',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-mcp',
        '--no-context-files',
        '--no-session',
        '--no-builtin-tools',
      ]) {
        expect(a).toContain(flag);
      }
      expect(a[a.indexOf('--mode') + 1]).toBe('rpc');
      expect(a[a.indexOf('--tools') + 1]?.split(',').sort()).toEqual([...ASSISTANT_TOOL_NAMES].sort());
      const extensions = a.flatMap((x, i) => (x === '-e' ? [a[i + 1]] : []));
      expect(extensions).toEqual([join(o.stateDir ?? '', PI_ASSISTANT_EXTENSION_FILE)]);
      const promptFile = a[a.indexOf('--system-prompt') + 1] ?? '';
      expect(readFileSync(promptFile, 'utf8')).toBe(ASSISTANT_SYSTEM_PROMPT);
      expect(a[a.indexOf('--model') + 1]).toBe('remyral-faux/scripted');
      expect(rec.cwd.endsWith('work')).toBe(true);
      expect(rec.agentDir).toBe(join(o.stateDir ?? '', 'agent'));
    } finally {
      await s.close();
    }
  });

  it('relays platform tool calls through the extension UI channel and streams the answer', async () => {
    const o = session();
    const s = await engine().start(o);
    try {
      const { deltas, sink: k } = sink();
      const r = await s.turn({ message: 'fake:tool please', history: null }, k, new AbortController().signal);
      expect(r.outcome).toBe('done');
      expect(o.recorded.calls).toEqual([
        { tool: 'list_workers', input: { state: 'online' }, callId: 'call_1' },
      ]);
      expect(r.text).toBe('got: {"workers":["w1"]}|false');
      expect(deltas.join('')).toBe(r.text);
      expect(r.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        turns: 1,
        costUsd: 0.25,
        provenance: 'reported-by-runtime',
        model: 'scripted',
      });
      // A follow-up turn reuses the same process.
      const r2 = await s.turn({ message: 'again', history: null }, sink().sink, new AbortController().signal);
      expect(r2.text).toBe('Echo: again');
      expect(s.alive).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('passes the first turn history before the message', async () => {
    const s = await engine().start(session());
    try {
      const r = await s.turn(
        { message: 'hello', history: 'HISTORY' },
        sink().sink,
        new AbortController().signal,
      );
      expect(r.text).toContain('hello');
    } finally {
      await s.close();
    }
  });

  it('cancels foreign dialogs and the bridge blocks non-platform tools', async () => {
    const s = await engine().start(session());
    try {
      const r = await s.turn(
        { message: 'fake:foreign', history: null },
        sink().sink,
        new AbortController().signal,
      );
      expect(r.text).toBe('foreign:cancelled bash:blocked');
    } finally {
      await s.close();
    }
  });

  it('separates the text of several assistant messages', async () => {
    const s = await engine().start(session());
    try {
      const { deltas, sink: k } = sink();
      const r = await s.turn({ message: 'fake:two', history: null }, k, new AbortController().signal);
      expect(r.text).toBe('first\n\nsecond');
      expect(deltas.join('')).toBe('first\n\nsecond');
      expect(r.usage.turns).toBe(2);
    } finally {
      await s.close();
    }
  });

  it('subscription runs report tokens only', async () => {
    const s = await engine().start(session({ authMode: 'local-login' }));
    try {
      const r = await s.turn({ message: 'hi', history: null }, sink().sink, new AbortController().signal);
      expect(r.usage.costUsd).toBeUndefined();
      expect(r.usage.provenance).toBe('estimated-from-tokens');
    } finally {
      await s.close();
    }
  });

  it('cancels a running turn with abort and keeps the session', async () => {
    const s = await engine().start(session());
    try {
      const ac = new AbortController();
      const p = s.turn({ message: 'fake:long', history: null }, sink().sink, ac.signal);
      await new Promise((r) => setTimeout(r, 200));
      ac.abort();
      const r = await p;
      expect(r.outcome).toBe('cancelled');
      expect(s.alive).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('closes the session when a cancel is ignored', async () => {
    const s = await engine().start(session());
    const ac = new AbortController();
    const p = s.turn({ message: 'fake:stuck', history: null }, sink().sink, ac.signal);
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const r = await p;
    expect(r.outcome).toBe('cancelled');
    expect(s.alive).toBe(false);
    await s.close();
  });

  it('fails a turn that takes too long', async () => {
    const s = await engine().start(session({ timeouts: { ...FAST, turnMs: 300 } }));
    const r = await s.turn(
      { message: 'fake:long', history: null },
      sink().sink,
      new AbortController().signal,
    );
    expect(r).toMatchObject({ outcome: 'failed', errorCode: 'turn_timeout' });
    await s.close();
  });

  it('reports a model error and a crash', async () => {
    const s = await engine().start(session());
    const r = await s.turn(
      { message: 'fake:error', history: null },
      sink().sink,
      new AbortController().signal,
    );
    expect(r).toMatchObject({ outcome: 'failed', errorCode: 'model_error', detail: 'provider said no' });
    const c = await s.turn(
      { message: 'fake:crash', history: null },
      sink().sink,
      new AbortController().signal,
    );
    expect(c).toMatchObject({ outcome: 'failed', errorCode: 'runtime_crashed' });
    expect(s.alive).toBe(false);
    const after = await s.turn({ message: 'hi', history: null }, sink().sink, new AbortController().signal);
    expect(after.errorCode).toBe('session_ended');
    await s.close();
  });

  it('never streams an injected secret, even split across deltas, and keeps it out of argv', async () => {
    const secret = 'sk-test-0123456789abcdef0123456789';
    const o = session({ secretEnv: { REMYRAL_TEST_KEY: new SecretValue(secret) } });
    const s = await engine().start(o);
    try {
      const { deltas, sink: k } = sink();
      const r = await s.turn({ message: 'fake:secret', history: null }, k, new AbortController().signal);
      expect(deltas.join('')).not.toContain(secret);
      expect(r.text).not.toContain(secret);
      expect(readFileSync(o.argvFile, 'utf8')).not.toContain(secret);
    } finally {
      await s.close();
    }
  });

  it('fails start when Pi does not come up, and removes its own state', async () => {
    const e = engine();
    const before = readdir(join(root, 'state'));
    const { stateDir: _drop, ...o } = session({ env: { FAKE_PI_FAIL_START: '1' } });
    await expect(e.start(o)).rejects.toThrow(/did not become ready/);
    expect(readdir(join(root, 'state')).length).toBe(before.length);
  });
});

function readdir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
