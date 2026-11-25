/**
 * The Codex, OpenCode and Pi assistant engines with their REAL pinned binaries inside the assistant sandbox
 * profile of this Mac (Seatbelt + egress proxy), driven by the scripted providers of the adapter package's
 * real-binary tests (no credentials, no model, no external network). Opt-in per runtime: REMYRAL_CODEX_BIN,
 * REMYRAL_OPENCODE_BIN, REMYRAL_PI_BIN (the pinned executables). The scripted providers listen on loopback, which
 * the profile only allows through its test-only `testLoopbackPorts`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_SYSTEM_PROMPT,
  type AssistantEngine,
  type AssistantSessionOptions,
  CodexAssistantEngine,
  OpenCodeAssistantEngine,
  PiAssistantEngine,
  SecretValue,
} from '@remyral/agent-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import { startMockResponses } from '../../../packages/agent-adapters/test/fixtures/codex/mock-responses.js';
import { AssistantSandbox } from '../src/assistant/sandbox.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'agent-adapters',
  'test',
  'fixtures',
);
const seatbelt =
  process.platform === 'darwin' &&
  (() => {
    try {
      execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
      return true;
    } catch {
      return false;
    }
  })();
const CODEX = process.env.REMYRAL_CODEX_BIN ?? '';
const OPENCODE = process.env.REMYRAL_OPENCODE_BIN ?? '';
const PI = process.env.REMYRAL_PI_BIN ?? '';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function sandboxed(runtime: 'codex' | 'opencode' | 'pi', ports: number[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `remyral-asb-${runtime}-`)));
  roots.push(root);
  const data = join(root, 'data');
  const session = join(data, 'assistant', 's-1');
  await mkdir(join(session, 'work'), { recursive: true });
  await mkdir(join(session, 'state'), { recursive: true });
  await mkdir(join(root, 'ws'), { recursive: true });
  const sandbox = new AssistantSandbox({
    mode: 'required',
    workerDataDir: data,
    workspaceRoot: join(root, 'ws'),
    readableInDataDir: [],
    protectedHomes: [],
    workerHome: join(root, 'home'),
    allowKeychain: false,
    egressAllow: ['api.openai.com'],
    limits: DEFAULT_LIMITS,
    testLoopbackPorts: ports,
  });
  const { confiner } = sandbox.forSession({ runtime, authMode: 'secret-ref', sessionDir: session });
  const calls: string[] = [];
  const options = (over: Partial<AssistantSessionOptions> = {}): AssistantSessionOptions => ({
    cwd: join(session, 'work'),
    stateDir: join(session, 'state'),
    authMode: 'secret-ref',
    secretEnv: {},
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 60_000, turnMs: 60_000, cancelGraceMs: 3_000 },
    ...(confiner === undefined ? {} : { confiner }),
    tools: {
      call: (tool) => {
        calls.push(tool);
        return Promise.resolve({
          content: '{"workers":[{"name":"mac-1","state":"online"}]}',
          isError: false,
        });
      },
    },
    ...over,
  });
  return { root, session, calls, options };
}

async function turn(engine: AssistantEngine, o: AssistantSessionOptions, message: string) {
  const s = await engine.start(o);
  try {
    let streamed = '';
    const r = await s.turn(
      { message, history: null },
      { delta: (t) => (streamed += t) },
      new AbortController().signal,
    );
    return { ...r, streamed };
  } finally {
    await s.close();
  }
}

describe.skipIf(!seatbelt)(
  'assistant engines inside the sandbox profile (real binaries)',
  { timeout: 180_000 },
  () => {
    it.skipIf(PI === '')('Pi: relays the platform tool and answers, confined', async () => {
      const t = await sandboxed('pi', []);
      const engine = new PiAssistantEngine({
        command: () => ({ command: PI, args: [] }),
        stateRoot: join(t.root, 'state-root'),
        sourceEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        settings: () => ({
          model: 'remyral-faux/scripted',
          extensions: [join(FIXTURES, 'pi', 'faux-assistant-provider.mjs')],
        }),
      });
      expect(await engine.ready()).toEqual({ ready: true });
      const r = await turn(engine, t.options(), 'faux:relay which machines are online?');
      expect(r.outcome, r.detail).toBe('done');
      expect(t.calls).toContain('list_workers');
      expect(r.streamed.length).toBeGreaterThan(0);
      expect(await readdir(join(t.session, 'work'))).toEqual([]);
    });

    it.skipIf(OPENCODE === '')(
      'OpenCode: serves on loopback, reaches its tool endpoint, answers, confined',
      async () => {
        const provider: ChildProcess = spawn(
          process.execPath,
          [join(FIXTURES, 'opencode', 'fake-assistant-provider.mjs')],
          {
            stdio: ['ignore', 'pipe', 'inherit'],
          },
        );
        try {
          const port = await new Promise<number>((resolve) => {
            provider.stdout?.once('data', (d: Buffer) => {
              resolve(Number(String(d).trim()));
            });
          });
          const t = await sandboxed('opencode', [port]);
          const engine = new OpenCodeAssistantEngine({
            command: () => ({ command: OPENCODE, args: [] }),
            stateRoot: join(t.root, 'state-root'),
            sourceEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
            settings: () => ({
              model: 'fake/scripted',
              config: {
                provider: {
                  fake: {
                    npm: '@ai-sdk/openai-compatible',
                    name: 'Scripted',
                    options: { baseURL: `http://127.0.0.1:${String(port)}/v1`, apiKey: 'unused' },
                    models: { scripted: { name: 'Scripted' } },
                  },
                },
              },
            }),
          });
          const r = await turn(engine, t.options(), 'faux:tool which machines are online?');
          expect(r.outcome, r.detail).toBe('done');
          expect(t.calls).toContain('list_workers');
        } finally {
          provider.kill('SIGKILL');
        }
      },
    );

    it.skipIf(CODEX === '')(
      'Codex: dynamic tool relayed, answers, API key only in env, confined',
      async () => {
        const mock = await startMockResponses();
        try {
          const port = Number(new URL(mock.url).port);
          const t = await sandboxed('codex', [port]);
          const engine = new CodexAssistantEngine({
            command: () => ({ command: CODEX, args: [] }),
            stateRoot: join(t.root, 'state-root'),
            sourceEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
            apiBaseUrl: mock.url,
          });
          const r = await turn(
            engine,
            t.options({
              model: 'gpt-5.4',
              secretEnv: { CODEX_API_KEY: new SecretValue('sk-proj-remyral-test-0123456789abcdef') },
            }),
            'Which machines are online?',
          );
          expect(r.outcome, r.detail).toBe('done');
          expect(t.calls).toContain('list_workers');
        } finally {
          await mock.close();
        }
      },
    );
  },
);
