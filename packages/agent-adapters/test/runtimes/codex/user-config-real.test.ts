/**
 * p14-codex-mcp-isolation: the Codex JOB adapter in local-login mode against the **real pinned codex-cli 0.164.0**
 * with a hostile worker-user `CODEX_HOME/config.toml` (an stdio MCP server, a `SessionStart` command hook and a
 * `notify` program, each writing a marker file) and a local fake Responses API (fixtures/codex/mock-responses.ts).
 * No real login, no model. Opt-in: REMYRAL_CODEX_BIN (the pinned binary). macOS only: the app-server runs under the
 * localhost-only Seatbelt profile (fixtures/codex/helpers.ts `localhostOnlyConfiner`).
 *
 * The control run starts the same binary on the same home **without** the adapter's isolation (plain
 * `app-server --listen stdio://`) and must see the markers — so a passing job run is not vacuous.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../../../src/index.js';
import { localhostOnlyConfiner, pinnedCodexBinary } from '../../fixtures/codex/helpers.js';
import { startMockResponses } from '../../fixtures/codex/mock-responses.js';
import { drain, eventually, spawnContext } from '../../helpers/runtime.js';

const bin = process.env.REMYRAL_CODEX_BIN !== undefined ? pinnedCodexBinary() : undefined;
const confiner = localhostOnlyConfiner();
const base = join(homedir(), '.cache', 'remyral-tests');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'codex-user-config-real-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const MARKERS = ['mcp', 'hook', 'notify'] as const;

/**
 * A worker-user home whose config.toml would run three programs, each leaving a marker in `markDir`. The hook is
 * marked reviewed (`hooks.state.<key>.trusted_hash`, what the TUI's hook review writes) — an unreviewed hook never
 * runs on 0.162.1 — with the key and hash the app-server itself reports (`hooks/list`).
 */
async function hostileHome(mockUrl: string): Promise<{ home: string; markDir: string }> {
  const home = mkdtempSync(join(root, 'home-'));
  const markDir = mkdtempSync(join(root, 'marks-'));
  const touch = (name: string) => `touch ${JSON.stringify(join(markDir, name))}`;
  const config = join(home, 'config.toml');
  writeFileSync(
    config,
    [
      'model = "gpt-5.4"',
      'model_provider = "mock"',
      `notify = ["/bin/sh", "-c", ${JSON.stringify(touch('notify'))}]`,
      '[model_providers.mock]',
      'name = "mock"',
      `base_url = ${JSON.stringify(mockUrl)}`,
      'wire_api = "responses"',
      '[mcp_servers.evil]',
      'command = "/bin/sh"',
      `args = ["-c", ${JSON.stringify(`${touch('mcp')}; sleep 5`)}]`,
      '[[hooks.SessionStart]]',
      `hooks = [{ type = "command", command = ${JSON.stringify(touch('hook'))} }]`,
      '',
    ].join('\n'),
  );
  const cwd = mkdtempSync(join(root, 'ws-'));
  const listed = await plainSession(home, cwd, (call) => call('hooks/list', { cwds: [cwd] }));
  const hooks = JSON.stringify(listed);
  const key = /"key":"([^"]+)"/.exec(hooks)?.[1];
  const hash = /"currentHash":"([^"]+)"/.exec(hooks)?.[1];
  if (key === undefined || hash === undefined)
    throw new Error(`hooks/list: no hook (${hooks.slice(0, 300)})`);
  appendFileSync(config, `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`);
  return { home, markDir };
}

type Call = (method: string, params: unknown) => Promise<Record<string, unknown>>;

/** Plain app-server on `home` — none of the adapter's overrides — under the localhost-only confiner. */
async function plainSession<T>(
  home: string,
  cwd: string,
  body: (call: Call, turnDone: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (bin === undefined || confiner === undefined) throw new Error('unreachable');
  const plan = await confiner.confine({
    command: bin,
    args: ['--no-daemon', 'app-server', '--listen', 'stdio://'],
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home },
    secretNames: [],
  });
  const child = spawn(plan.command, plan.args, { cwd, env: plan.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map<number, (r: Record<string, unknown>) => void>();
  let onTurnDone: (() => void) | undefined;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id?: number; method?: string; result?: Record<string, unknown> };
    if (msg.method === undefined && typeof msg.id === 'number') pending.get(msg.id)?.(msg.result ?? {});
    if (msg.method === 'turn/completed') onTurnDone?.();
  });
  let next = 1;
  const call: Call = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const turnDone = (): Promise<void> =>
    Promise.race([
      new Promise<void>((resolve) => {
        onTurnDone = resolve;
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ]);
  try {
    await call('initialize', {
      clientInfo: { name: 'remyral-test', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return await body(call, turnDone);
  } finally {
    child.kill('SIGKILL');
  }
}

/** Control: one thread and one turn on the plain app-server. */
async function controlRun(home: string, cwd: string): Promise<void> {
  await plainSession(home, cwd, async (call, turnDone) => {
    const started = (await call('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })) as { thread: { id: string } };
    const done = turnDone();
    await call('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'say done', text_elements: [] }],
    });
    await done;
    await new Promise((r) => setTimeout(r, 1_000));
  });
}

describe.skipIf(bin === undefined || confiner === undefined)(
  'Codex job adapter, local-login: real codex-cli 0.164.0 ignores the user config.toml MCP servers, hooks and notify',
  { timeout: 120_000 },
  () => {
    it('control: without the isolation the hostile config runs its programs', async () => {
      const mock = await startMockResponses({ toolCall: false, answer: ['done'] });
      try {
        const { home, markDir } = await hostileHome(mock.url);
        await controlRun(home, mkdtempSync(join(root, 'ws-')));
        await eventually(() => MARKERS.every((m) => existsSync(join(markDir, m))), 5_000);
        expect(MARKERS.filter((m) => existsSync(join(markDir, m)))).toEqual([...MARKERS]);
      } finally {
        await mock.close();
      }
    });

    it('a job runs on the user home without starting its MCP server, hook or notify program', async () => {
      const mock = await startMockResponses({ toolCall: false, answer: ['done'] });
      try {
        const { home, markDir } = await hostileHome(mock.url);
        const adapter = createCodexAdapter({
          authMode: 'local-login',
          codexPath: bin ?? 'codex',
          loginDir: home,
          sourceEnv: { PATH: process.env.PATH, HOME: home },
          confinerFor: () => confiner,
        });
        await adapter.probe();
        const ws = mkdtempSync(join(root, 'ws-'));
        const ref = await adapter.spawn(
          spawnContext('codex', ws, {
            job: { runtime: 'codex', prompt: 'say done', limits: { maxDurationSec: 60 } },
            approvalPolicy: 'deny-sensitive',
          }),
        );
        try {
          await adapter.sendPrompt(ref, { text: 'say done' });
          const events = await drain(adapter, ref, 60_000);
          const result = await adapter.collectResult(ref);
          expect(result.outcome).toBe('succeeded');
          expect(events.some((e) => e.event.kind === 'error')).toBe(false);
        } finally {
          await adapter.cleanup(ref);
        }
        await new Promise((r) => setTimeout(r, 1_000));
        expect(MARKERS.filter((m) => existsSync(join(markDir, m)))).toEqual([]);
        // The model was offered no MCP tool of the user's server.
        expect(mock.requests.length).toBeGreaterThanOrEqual(1);
        const tools = JSON.stringify(mock.requests.map((r) => r.tools ?? []));
        expect(tools).not.toContain('evil');
      } finally {
        await mock.close();
      }
    });
  },
);
