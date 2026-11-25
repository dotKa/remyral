/**
 * p11-fixes-a: OpenCode's sub-job tools inside the JOB Seatbelt profile of this Mac, unchanged (REMYRAL_OPENCODE_BIN,
 * darwin only). The real pinned OpenCode server runs under `buildSeatbeltProfile` with the attempt layout the job
 * runner uses (worktree, attempt sandbox dir, runtime state dir inside it); the scripted provider stands in for the
 * per-job egress proxy (the only loopback port the profile lets the job connect to). OpenCode starts the local MCP
 * server itself, inside the same sandbox; its calls reach the host only through files in the runtime state dir —
 * no further loopback connect is allowed, and none is needed.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenCodeAdapter, type ProcessConfiner, type SubtaskToolHost } from '@remyral/agent-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSeatbeltProfile } from '../src/sandbox/host/seatbelt.js';
import { drain, spawnContext } from '../../../packages/agent-adapters/test/helpers/runtime.js';

const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'agent-adapters',
  'test',
  'fixtures',
  'opencode',
  'fake-provider.mjs',
);
const OPENCODE = process.env.REMYRAL_OPENCODE_BIN ?? '';
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

const roots: string[] = [];
let provider: ChildProcess | undefined;
afterAll(async () => {
  provider?.kill('SIGKILL');
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe.skipIf(!seatbelt || OPENCODE === '')('OpenCode sub-job tools in the job Seatbelt profile', () => {
  it(
    'the MCP server runs inside the sandbox and relays through the state dir',
    { timeout: 180_000 },
    async () => {
      provider = spawn(process.execPath, [FAKE], { stdio: ['ignore', 'pipe', 'inherit'] });
      const port = await new Promise<number>((resolve) => {
        provider?.stdout?.once('data', (d: Buffer) => {
          resolve(Number(d.toString().trim()));
        });
      });
      const root = await realpath(await mkdtemp(join(tmpdir(), 'remyral-ocsb-')));
      roots.push(root);
      const wsRoot = join(root, 'ws');
      const workspace = join(wsRoot, 'jobs', 'j1', 'a1');
      const sandboxDir = join(wsRoot, 'sandboxes', 'j1', 'a1');
      const stateDir = join(sandboxDir, 'runtime');
      const dataDir = join(root, 'data');
      for (const d of [workspace, stateDir, join(sandboxDir, 'tmp'), dataDir])
        await mkdir(d, { recursive: true });
      const sb = buildSeatbeltProfile({
        workspace,
        sandboxDir,
        workspaceRoot: wsRoot,
        workerDataDir: dataDir,
        homes: [],
        allowListen: true,
        proxyPort: port,
      });
      const confiner: ProcessConfiner = {
        kind: 'host-restricted:seatbelt',
        confine: (plan) =>
          Promise.resolve({
            command: sb.argv[0] ?? '/usr/bin/sandbox-exec',
            args: [...sb.argv.slice(1), plan.command, ...plan.args],
            cwd: plan.cwd,
            env: { ...plan.env, TMPDIR: join(sandboxDir, 'tmp') },
          }),
      };
      const a = createOpenCodeAdapter({
        command: OPENCODE,
        stateDir,
        authMode: 'secret-ref',
        model: 'fake/scripted',
        confiner,
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
      });
      const calls: unknown[] = [];
      const host: SubtaskToolHost = {
        request: (args) => {
          calls.push(args);
          return Promise.resolve({ ok: true, text: `sub-job 9a1d created: ${args.title}` });
        },
        wait: () => Promise.resolve({ ok: true, text: 'done' }),
        cancel: () => Promise.resolve({ ok: true, text: 'cancelled' }),
      };
      const ref = await a.spawn(spawnContext('opencode', workspace, { subtaskTools: host }));
      await a.sendPrompt(ref, { text: 'faux:subtask:30' });
      const events = (await drain(a, ref, 150_000)).map((e) => e.event);
      const text = events
        .filter((e) => e.kind === 'message' && e.role === 'assistant')
        .map((e) => (e.kind === 'message' ? e.text : ''))
        .join('\n');
      expect(text).toContain('sub-job 9a1d created: Draw the logo');
      expect(calls).toHaveLength(1);
      await a.cleanup(ref);
    },
  );
});
