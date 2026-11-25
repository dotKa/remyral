/**
 * The Pi ops chat assistant engine against the REAL pinned Pi 1.4.0 (no credentials, no network, no model):
 * a scripted faux provider (fixtures/pi/faux-assistant-provider.mjs, loaded as an operator extension) plays the
 * model, so tool declaration, the bridge extension, the extension-UI relay, streaming, follow-up turns and abort
 * are the real runtime's.
 *
 * Opt-in: set REMYRAL_PI_BIN to the pinned executable (e.g. the `pi` launcher of
 * `npm install --prefix <dir> --ignore-scripts @earendil-works/pi-coding-agent@1.4.0`).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import {
  ASSISTANT_SYSTEM_PROMPT,
  PiAssistantEngine,
  type AssistantSessionOptions,
  type AssistantToolBridge,
} from '../src/index.js';

const PI_BIN = process.env.REMYRAL_PI_BIN ?? '';
const enabled = PI_BIN !== '';
const FAUX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'faux-assistant-provider.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-pi-assistant-real-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const engine = () =>
  new PiAssistantEngine({
    command: () => ({ command: PI_BIN, args: [] }),
    stateRoot: join(root, 'state'),
    settings: () => ({ model: 'remyral-faux/scripted', extensions: [FAUX] }),
  });

function session(calls: { tool: string; input: Record<string, unknown> }[]): AssistantSessionOptions {
  const dir = join(root, 's', randomUUID());
  mkdirSync(join(dir, 'work'), { recursive: true });
  const tools: AssistantToolBridge = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({ content: '{"workers":[{"name":"mac-1","state":"online"}]}', isError: false });
    },
  };
  return {
    cwd: join(dir, 'work'),
    stateDir: join(dir, 'state'),
    authMode: 'secret-ref',
    secretEnv: {},
    tools,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 60_000, turnMs: 60_000, cancelGraceMs: 2_000 },
  };
}

const run = (s: Awaited<ReturnType<PiAssistantEngine['start']>>, message: string, signal?: AbortSignal) => {
  const deltas: string[] = [];
  return s
    .turn(
      { message, history: null },
      { delta: (t) => deltas.push(t) },
      signal ?? new AbortController().signal,
    )
    .then((r) => ({ ...r, streamed: deltas.join('') }));
};

describe.skipIf(!enabled)('pi 1.4.0 real binary: ops chat assistant engine', { timeout: 180_000 }, () => {
  it('is ready with the pinned binary', async () => {
    expect(await engine().ready()).toEqual({ ready: true });
  });

  it('declares only the platform tools and our system prompt; relays a tool call and streams', async () => {
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    const o = session(calls);
    const s = await engine().start(o);
    try {
      const declared = await run(s, 'faux:tools');
      expect(declared.outcome).toBe('done');
      expect(declared.text).toBe(`tools=${[...ASSISTANT_TOOL_NAMES].sort().join(',')}|ours=true`);
      expect(declared.streamed).toBe(declared.text);

      const relayed = await run(s, 'faux:relay');
      expect(relayed.outcome).toBe('done');
      expect(calls).toEqual([{ tool: 'list_workers', input: { state: 'online' } }]);
      expect(relayed.text).toBe('result={"workers":[{"name":"mac-1","state":"online"}]}|false');
      expect(relayed.usage.inputTokens).toBeGreaterThan(0);
      expect(relayed.usage.model).toBe('scripted');

      // Pi validates the input against the declared JSON Schema before the bridge runs: nothing is relayed.
      const invalid = await run(s, 'faux:invalid');
      expect(invalid.text).toMatch(/\|true$/);
      expect(calls).toHaveLength(1);

      // A built-in tool the model was not given never runs (no file appears in the scratch dir).
      const foreign = await run(s, 'faux:foreign');
      expect(foreign.text).toMatch(/\|true$/);
      expect(existsSync(join(o.cwd, 'pwned.txt'))).toBe(false);
      expect(calls).toHaveLength(1);

      // The session holds the conversation: a follow-up is a new prompt in the same process.
      const echo = await run(s, 'hello again');
      expect(echo.text).toBe('echo: hello again');
      expect(s.alive).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('cancels a running turn with abort', async () => {
    const s = await engine().start(session([]));
    try {
      const ac = new AbortController();
      const p = run(s, 'faux:long', ac.signal);
      await new Promise((r) => setTimeout(r, 1_000));
      ac.abort();
      const r = await p;
      expect(r.outcome).toBe('cancelled');
      expect(s.alive).toBe(true);
      const after = await run(s, 'still there');
      expect(after.text).toBe('echo: still there');
    } finally {
      await s.close();
    }
  });
});
