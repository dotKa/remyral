/**
 * p11-fixes-a: OpenCode 1.19.4 sub-job tools against the REAL binary (opt-in, REMYRAL_OPENCODE_BIN; no credentials, no
 * external network): the scripted provider (fixtures/opencode/fake-provider.mjs, `faux:subtask:<waitSec>`) calls the
 * `remyral-subtasks_request_subtask` tool that OpenCode offers from the local MCP server it started itself (the OpenCode
 * binary in Bun mode running the adapter's script); the call is relayed through files in the attempt's state dir to
 * the test's SubtaskToolHost, and the host's text comes back to the model. Also: a call held longer than a minute
 * (OpenCode's MCP client must not give up), no permission prompt for the platform tools under ask-sensitive, and no
 * tools when the job has none.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenCodeAdapter, type SubtaskToolHost } from '../src/index.js';
import { drain, spawnContext } from './helpers/runtime.js';

const OC_BIN = process.env.REMYRAL_OPENCODE_BIN ?? '';
const enabled = OC_BIN !== '';
const LONG = process.env.REMYRAL_OPENCODE_LONG_CALL === '1';
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'fake-provider.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-sub-'));
let provider: ChildProcess | undefined;
let providerPort = 0;

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

function adapter(waitCap = 0) {
  return createOpenCodeAdapter({
    command: OC_BIN,
    stateDir: join(root, 'state', randomUUID()),
    authMode: 'secret-ref',
    model: 'fake/scripted',
    subtaskWaitCapSec: waitCap,
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
  });
}

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function host(holdMs = 0) {
  const calls: unknown[] = [];
  const h: SubtaskToolHost = {
    request: async (args) => {
      calls.push(args);
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      return { ok: true, text: `sub-job 6f0c created: ${args.title} (waitSec ${String(args.waitSec)})` };
    },
    wait: () => Promise.resolve({ ok: true, text: 'done' }),
    cancel: () => Promise.resolve({ ok: true, text: 'cancelled' }),
  };
  return { h, calls };
}

describe.skipIf(!enabled)('opencode 1.19.4 real binary: sub-job tools (local MCP + file relay)', () => {
  it(
    'offers the tools, relays a call to the host and returns its text; no permission prompt',
    { timeout: 180_000 },
    async () => {
      const a = adapter(45);
      expect(a.offersSubtaskTools).toBe(true);
      const { h, calls } = host();
      const ref = await a.spawn(spawnContext('opencode', workspace(), { subtaskTools: h }));
      await a.sendPrompt(ref, { text: 'faux:subtask:600' });
      const events = (await drain(a, ref, 150_000)).map((e) => e.event);
      expect(events.filter((e) => e.kind === 'approval_request')).toEqual([]);
      const text = events
        .filter((e) => e.kind === 'message' && e.role === 'assistant')
        .map((e) => (e.kind === 'message' ? e.text : ''))
        .join('\n');
      expect(text).toContain('subtask via remyral-subtasks_request_subtask');
      expect(text).toContain('sub-job 6f0c created: Draw the logo (waitSec 45)');
      // The wait cap bounds one call; the protocol schema still validated the rest.
      expect(calls).toEqual([{ title: 'Draw the logo', prompt: 'Make a logo', wait: true, waitSec: 45 }]);
      expect((await a.collectResult(ref)).outcome).toBe('succeeded');
      await a.cleanup(ref);
    },
  );

  it('a job without sub-job tools gets no MCP server and no tool', { timeout: 180_000 }, async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('opencode', workspace()));
    await a.sendPrompt(ref, { text: 'faux:subtask:10' });
    const events = (await drain(a, ref, 150_000)).map((e) => e.event);
    const text = events
      .filter((e) => e.kind === 'message' && e.role === 'assistant')
      .map((e) => (e.kind === 'message' ? e.text : ''))
      .join('\n');
    expect(text).toContain('no subtask tool');
    expect(text).not.toContain('remyral-subtasks');
    await a.cleanup(ref);
  });

  it.skipIf(!LONG)(
    'a call held for 75 s still returns (REMYRAL_OPENCODE_LONG_CALL=1)',
    { timeout: 300_000 },
    async () => {
      const a = adapter();
      const { h } = host(75_000);
      const ref = await a.spawn(spawnContext('opencode', workspace(), { subtaskTools: h }));
      await a.sendPrompt(ref, { text: 'faux:subtask:540' });
      const events = (await drain(a, ref, 240_000)).map((e) => e.event);
      const text = events
        .filter((e) => e.kind === 'message' && e.role === 'assistant')
        .map((e) => (e.kind === 'message' ? e.text : ''))
        .join('\n');
      expect(text).toContain('sub-job 6f0c created');
      await a.cleanup(ref);
    },
  );
});
