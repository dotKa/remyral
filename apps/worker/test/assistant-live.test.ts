/**
 * Live ops-chat assistant run against a real model (p5-ops-chat-next "live Claude Code verification"). Skipped
 * unless REMYRAL_LIVE_RUNTIMES=1 and REMYRAL_LIVE_CLAUDE_LOCAL_LOGIN=1 (the worker user logged in with `claude`;
 * the engine never touches that login). Runs the real Claude Code engine (the CLI bundled with the pinned Agent
 * SDK) inside the assistant sandbox profile of this OS (macOS: Seatbelt + egress proxy), with a scripted
 * platform tool bridge — no master, no fleet. Spends a few hundred tokens of the logged-in subscription.
 * Optional: REMYRAL_LIVE_CLAUDE_MODEL (e.g. a Haiku model id) to keep it cheap.
 */
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_SYSTEM_PROMPT,
  ClaudeAssistantEngine,
  readClaudeSdkPackageInfo,
  resolveBundledClaudeBinary,
} from '@remyral/agent-adapters';
import { fenceData } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { AssistantSandbox } from '../src/assistant/sandbox.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';

const live = process.env.REMYRAL_LIVE_RUNTIMES === '1' && process.env.REMYRAL_LIVE_CLAUDE_LOCAL_LOGIN === '1';
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe.skipIf(!live)(
  'ops chat assistant: Claude Code live (local login, sandboxed)',
  { timeout: 180_000 },
  () => {
    it.each(['auto', 'off'] as const)(
      'answers through the platform tool only, streams, reports usage (sandbox %s)',
      async (mode) => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'remyral-assistant-live-')));
        roots.push(root);
        const data = join(root, 'data');
        const session = join(data, 'assistant', 's-live');
        await mkdir(join(session, 'work'), { recursive: true });
        await mkdir(join(session, 'state'), { recursive: true });
        await mkdir(join(root, 'ws'), { recursive: true });
        const sandbox = new AssistantSandbox({
          mode,
          workerDataDir: data,
          workspaceRoot: join(root, 'ws'),
          readableInDataDir: [join(data, 'runtimes')],
          protectedHomes: [],
          workerHome: homedir(),
          allowKeychain: false,
          egressAllow: (process.env.REMYRAL_LIVE_EGRESS ?? 'api.anthropic.com').split(','),
          limits: DEFAULT_LIMITS,
        });
        const report = sandbox.report();
        const { confiner } = sandbox.forSession({
          runtime: 'claude-code',
          authMode: 'local-login',
          sessionDir: session,
        });
        const binary = resolveBundledClaudeBinary(readClaudeSdkPackageInfo()) ?? null;
        expect(binary).not.toBeNull();
        const engine = new ClaudeAssistantEngine({ binary: () => binary, sourceEnv: process.env });
        expect(await engine.ready()).toEqual({ ready: true });
        const calls: { tool: string; input: Record<string, unknown> }[] = [];
        const model = process.env.REMYRAL_LIVE_CLAUDE_MODEL;
        const s = await engine.start({
          cwd: join(session, 'work'),
          stateDir: join(session, 'state'),
          authMode: 'local-login',
          secretEnv: {},
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          timeouts: { startupMs: 60_000, turnMs: 150_000, cancelGraceMs: 5_000 },
          ...(confiner === undefined ? {} : { confiner }),
          ...(model === undefined ? {} : { model }),
          tools: {
            call: (tool, input) => {
              calls.push({ tool, input });
              return Promise.resolve({
                isError: false,
                content: fenceData('list_workers', {
                  workers: [
                    { name: 'live-mac-1', state: 'online', os: 'macos', arch: 'arm64' },
                    { name: 'live-pi-1', state: 'offline', os: 'linux', arch: 'arm64' },
                  ],
                }),
              });
            },
          },
        });
        let streamed = '';
        try {
          const r = await s.turn(
            {
              message:
                'Which of my workers are online right now? Look it up with the list_workers tool and answer with just the worker names.',
              history: null,
            },
            { delta: (t) => (streamed += t) },
            new AbortController().signal,
          );

          console.log('live assistant result', {
            sandbox: report,
            outcome: r.outcome,
            errorCode: r.errorCode,
            detail: r.detail,
            text: r.text,
            usage: r.usage,
            calls,
          });
          expect(r.outcome).toBe('done');
          expect(calls.map((c) => c.tool)).toContain('list_workers');
          expect(r.text).toContain('live-mac-1');
          expect(r.text).not.toContain('live-pi-1');
          expect(streamed.length).toBeGreaterThan(0);
          expect(r.usage.authMode).toBe('local-login');
          expect(r.usage.outputTokens ?? 0).toBeGreaterThan(0);
          expect(r.usage.costUsd).toBeUndefined();
        } finally {
          await s.close();
        }
        // The runtime wrote nothing into its cwd.
        expect(await readdir(join(session, 'work'))).toEqual([]);
      },
    );
  },
);
