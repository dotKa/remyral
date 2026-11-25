/**
 * Real-binary tests of the OpenCode assistant engine (no credentials, no model, no external network): the
 * pinned `opencode` 1.19.4 server talks to a scripted OpenAI-compatible provider on 127.0.0.1
 * (fixtures/opencode/fake-assistant-provider.mjs), which records every model request. They prove, against the
 * real runtime, that the model is offered the platform tools only, that a tool call reaches the engine's relay
 * through the loopback MCP endpoint, and that the answer streams.
 *
 * Opt-in: set REMYRAL_OPENCODE_BIN to the pinned platform binary (see opencode-real.test.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_SYSTEM_PROMPT,
  OpenCodeAssistantEngine,
  type AssistantSession,
  type AssistantSessionOptions,
} from '../src/index.js';

const OC_BIN = process.env.REMYRAL_OPENCODE_BIN ?? '';
const enabled = OC_BIN !== '';
const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'opencode',
  'fake-assistant-provider.mjs',
);
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-assist-real-'));
let provider: ChildProcess | undefined;
let providerPort = 0;

interface Recorded {
  tools: string[];
  system: string;
  users: string[];
}

beforeAll(async () => {
  if (!enabled) return;
  provider = spawn(process.execPath, [FAKE], { stdio: ['ignore', 'pipe', 'inherit'] });
  providerPort = await new Promise<number>((resolve) => {
    provider?.stdout?.once('data', (d: Buffer) => {
      resolve(Number(d.toString().trim()));
    });
  });
});

afterAll(() => {
  provider?.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

function filesBelow(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesBelow(p));
    else out.push(p);
  }
  return out;
}

async function recorded(): Promise<Recorded[]> {
  const res = await fetch(`http://127.0.0.1:${String(providerPort)}/requests`);
  return (await res.json()) as Recorded[];
}

function engine(): OpenCodeAssistantEngine {
  return new OpenCodeAssistantEngine({
    command: () => ({ command: OC_BIN, args: [] }),
    stateRoot: join(root, 'state'),
    settings: () => ({
      model: 'fake/scripted',
      config: {
        provider: {
          fake: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Scripted',
            options: { baseURL: `http://127.0.0.1:${String(providerPort)}/v1`, apiKey: 'unused' },
            models: { scripted: { name: 'Scripted' } },
          },
        },
      },
    }),
  });
}

const calls: { tool: string; input: Record<string, unknown> }[] = [];

function options(): AssistantSessionOptions {
  const cwd = join(root, 'cwd', randomUUID());
  const stateDir = join(root, 'sessions', randomUUID());
  mkdirSync(cwd, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    cwd,
    stateDir,
    authMode: 'secret-ref',
    secretEnv: {},
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 60_000, turnMs: 90_000, cancelGraceMs: 5_000 },
    tools: {
      call: (tool, input) => {
        calls.push({ tool, input });
        return Promise.resolve({ content: '{"workers":["mac-1"]}', isError: false });
      },
    },
  };
}

describe.skipIf(!enabled)('OpenCode assistant engine (real 1.19.4 binary)', { timeout: 240_000 }, () => {
  let session: AssistantSession | undefined;

  afterAll(async () => {
    await session?.close();
  });

  it('is ready on the pinned binary', async () => {
    expect(await engine().ready()).toEqual({ ready: true });
  });

  it('offers only the platform tools, relays a tool call over loopback MCP and streams the answer', async () => {
    const o = options();
    session = await engine().start(o);
    const deltas: string[] = [];
    const r = await session.turn(
      { message: 'which machines? faux:tool', history: null },
      { delta: (t) => deltas.push(t) },
      new AbortController().signal,
    );
    expect(r.outcome).toBe('done');
    expect(r.text).toContain('workers: ');
    expect(r.text).toContain('mac-1');
    expect(deltas.join('')).toContain('mac-1');
    expect(calls).toEqual([{ tool: 'list_workers', input: { state: 'online' } }]);
    const reqs = (await recorded()).filter((q) => q.tools.length > 0);
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    for (const q of reqs) {
      expect([...q.tools].sort()).toEqual(ASSISTANT_TOOL_NAMES.map((n) => `remyral_${n}`).sort());
      expect(q.system).toContain('the operations assistant of the Remyral platform');
      // Our prompt replaces OpenCode's own coding-agent prompt (only its <env> block is appended).
      expect(q.system).not.toMatch(/You are (opencode|OpenCode)/);
    }
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    // The bearer token reached OpenCode through its environment only: no file of the session holds it.
    expect(readdirSync(o.stateDir ?? '')).toEqual(expect.arrayContaining(['config', 'db']));
    for (const file of filesBelow(o.stateDir ?? '')) {
      expect(readFileSync(file).toString('latin1')).not.toMatch(/Bearer [A-Za-z0-9_-]{40,}/);
    }
  });

  it('keeps the conversation for a follow-up turn', async () => {
    if (session === undefined) throw new Error('no session');
    const r = await session.turn(
      { message: 'and now just say hello', history: null },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(r.outcome).toBe('done');
    expect(r.text).toBe('hello world');
    const last = (await recorded()).filter((q) => q.tools.length > 0).at(-1);
    expect(last?.users.length).toBe(2);
  });

  it('cancels a hanging turn natively', async () => {
    if (session === undefined) throw new Error('no session');
    const ac = new AbortController();
    const p = session.turn({ message: 'faux:hang', history: null }, { delta: () => undefined }, ac.signal);
    setTimeout(() => {
      ac.abort();
    }, 2_000);
    const r = await p;
    expect(r.outcome).toBe('cancelled');
  });

  it('a built-in tool the model asks for does not exist: OpenCode refuses it and the turn continues', async () => {
    const s = await engine().start(options());
    try {
      const r = await s.turn(
        { message: 'faux:foreign', history: null },
        { delta: () => undefined },
        new AbortController().signal,
      );
      // OpenCode refuses the unavailable tool (tool part ends in `error`); the model then answers.
      expect(r.outcome).toBe('done');
      expect(r.text).toBe('ran');
      expect(s.alive).toBe(true);
      expect(calls.some((c) => c.tool === 'bash')).toBe(false);
    } finally {
      await s.close();
    }
  });
});
