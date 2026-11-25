import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@remyral/observability';
import { type LoginRuntime, OpsUpdatePayload } from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import { extractLogin, LoginManager, type LoginUpdate } from '../src/remote-ops/login.js';
import { runProcess } from '../src/remote-ops/process.js';
import { spyOnFs } from './fs-spy.js';
import { captureLines, isWindows, tempDir } from './helpers.js';

/**
 * The fake CLI is a fresh Node process behind a shell wrapper: on a loaded machine its first output can take longer
 * than vi.waitFor's 1 s default (the full suite saw "waiting_for_user" never arrive), so the waits allow 10 s.
 */
const WAIT = { timeout: 10_000, interval: 25 };
const FAKE = fileURLToPath(new URL('./fixtures/remote-ops/fake-login-cli.mjs', import.meta.url));
const TOKEN = 'sk-ant-oat01-FAKE-test-only-not-a-real-key-3456789012';

async function setup(mode = '') {
  const home = await tempDir('ro-home-');
  const bin = await tempDir('ro-bin-');
  const wrapper = async (name: string, cli: string) => {
    const file = join(bin, name);
    await writeFile(
      file,
      `#!/bin/sh\nFAKE_CLI=${cli} FAKE_MODE=${mode} exec "${process.execPath}" "${FAKE}" "$@"\n`,
    );
    await chmod(file, 0o755);
    return file;
  };
  const binaries: Record<LoginRuntime, string> = {
    'claude-code': await wrapper('claude', 'claude'),
    codex: await wrapper('codex', 'codex'),
  };
  const log = captureLines();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? '',
    // Present in the worker's environment, must never reach a login process.
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-must-not-pass',
    ANTHROPIC_API_KEY: 'sk-ant-api03-must-not-pass',
    OPENAI_API_KEY: 'sk-must-not-pass-0123456789',
  };
  const manager = new LoginManager({
    binary: (rt) => Promise.resolve(binaries[rt]),
    env,
    run: runProcess,
    logger: createLogger({ sink: log.sink }),
    timeoutMs: 8_000,
  });
  const updates: LoginUpdate[] = [];
  return { home, manager, updates, log, emit: (u: LoginUpdate) => updates.push(u) };
}

/** Everything the relay emitted, as the wire would carry it. */
function wire(updates: readonly LoginUpdate[], kind: 'login.start'): string {
  return JSON.stringify(
    updates.map((u, n) =>
      OpsUpdatePayload.parse({ commandId: '00000000-0000-4000-8000-000000000001', seq: n + 1, kind, ...u }),
    ),
  );
}

describe('login output extraction', () => {
  it('relays only an allow-listed, complete https URL and (Codex) the device code', () => {
    const claude =
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\n";
    expect(extractLogin('claude-code', claude).url).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&state=x',
    );
    // A URL still arriving (no terminator, output not paused) is not taken.
    expect(extractLogin('claude-code', claude.trimEnd(), false).url).toBeUndefined();
    expect(extractLogin('claude-code', 'visit https://evil.example/x\n').url).toBeUndefined();
    const codex =
      '1. Open \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. Enter this one-time code \u001b[94mABCD-EFGHI\u001b[0m\n';
    expect(extractLogin('codex', codex)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI',
    });
  });
});

describe.skipIf(isWindows)(
  'login relay with fake runtime CLIs (ADR-0014 / ADR-0017)',
  { timeout: 30_000 },
  () => {
    it('Claude Code: URL relayed, pasted code goes to stdin, logged in — the token never leaves the worker', async () => {
      const { home, manager, updates, log, emit } = await setup();
      const spy = spyOnFs();
      const id = randomUUID();
      try {
        const done = manager.start(id, 'claude-code', emit);
        await vi.waitFor(() => {
          expect(updates.some((u) => u.state === 'waiting_for_user')).toBe(true);
        }, WAIT);
        const waiting = updates.find((u) => u.state === 'waiting_for_user');
        expect(waiting?.login).toEqual({
          runtime: 'claude-code',
          expectsCode: true,
          url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=test&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1',
        });
        expect(manager.active()).toBe(id);
        expect(manager.input(id, 'good-code#s1')).toBe('ok');
        expect(manager.input(id, 'good-code#s1')).toBe('not_waiting'); // only once
        await done;
      } finally {
        spy.restore();
      }
      const last = updates.at(-1);
      expect(last?.state).toBe('succeeded');
      expect(last?.login?.status).toBe('logged_in');
      expect(manager.report()).toEqual([
        expect.objectContaining({ runtime: 'claude-code', status: 'logged_in', method: 'claude.ai' }),
      ]);
      // The credential exists only where the runtime put it …
      expect(await readFile(join(home, '.claude', '.credentials.json'), 'utf8')).toContain(TOKEN);
      // … and nothing the worker emitted or logged carries it (nor the account e-mail).
      const out = wire(updates, 'login.start') + log.lines.join('\n');
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain('owner@example.com');
      expect(out).not.toContain('good-code');
      // The worker process never opened the runtime's credential file.
      expect(spy.paths.filter((p) => p.includes('.credentials.json'))).toEqual([]);
      // No token or API key variable reached the login process.
      const names = JSON.parse(
        await readFile(join(home, 'env-claude-auth_login_--claudeai.json'), 'utf8'),
      ) as string[];
      for (const n of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
        expect(names).not.toContain(n);
      expect(names).toContain('HOME');
    });

    it('Claude Code: a wrong code fails the login (status stays logged out)', async () => {
      const { manager, updates, emit } = await setup();
      const id = randomUUID();
      const done = manager.start(id, 'claude-code', emit);
      await vi.waitFor(() => {
        expect(updates.some((u) => u.state === 'waiting_for_user')).toBe(true);
      }, WAIT);
      manager.input(id, 'wrong-code#s1');
      await done;
      expect(updates.at(-1)).toMatchObject({ state: 'failed', reason: 'login_failed' });
      expect(updates.at(-1)?.login?.status).toBe('logged_out');
      expect(JSON.stringify(updates)).not.toContain('status code 400'); // runtime output is never relayed
    });

    it('Codex device auth: URL + code relayed, completes by itself, logout works', async () => {
      const { home, manager, updates, log, emit } = await setup();
      await manager.start(randomUUID(), 'codex', emit);
      const waiting = updates.find((u) => u.state === 'waiting_for_user');
      expect(waiting?.login).toEqual({
        runtime: 'codex',
        expectsCode: false,
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGHI',
      });
      expect(updates.at(-1)).toMatchObject({ state: 'succeeded', login: { status: 'logged_in' } });
      expect(await readFile(join(home, '.codex', 'auth.json'), 'utf8')).toContain(TOKEN);
      expect(wire(updates, 'login.start') + log.lines.join('\n')).not.toContain(TOKEN);
      expect((await manager.status('codex')).method).toBe('chatgpt');
      expect((await manager.logout('codex')).status).toBe('logged_out');
    });

    it('a foreign URL is never relayed; cancel stops the login', async () => {
      const { manager, updates, emit } = await setup('evil');
      const id = randomUUID();
      const done = manager.start(id, 'claude-code', emit);
      await new Promise((r) => setTimeout(r, 600));
      expect(updates.some((u) => u.state === 'waiting_for_user')).toBe(false);
      expect(JSON.stringify(updates)).not.toContain('evil.example');
      expect(manager.cancel(id)).toBe(true);
      await done;
      expect(updates.at(-1)?.state).toBe('cancelled');
      expect(manager.active()).toBeUndefined();
    });

    it('one login at a time; a login that never finishes is stopped at the time limit', async () => {
      const { manager, updates, emit } = await setup('hang');
      const short = new LoginManager({
        binary: () => Promise.resolve(null),
        env: {},
        run: runProcess,
        logger: createLogger({ sink: () => undefined }),
      });
      const missing: LoginUpdate[] = [];
      await short.start(randomUUID(), 'codex', (u) => missing.push(u));
      expect(missing).toEqual([
        expect.objectContaining({ state: 'refused', reason: 'runtime_not_installed' }),
      ]);

      const first = manager.start(randomUUID(), 'codex', emit);
      const second: LoginUpdate[] = [];
      await vi.waitFor(() => {
        expect(manager.active()).toBeDefined();
      }, WAIT);
      await manager.start(randomUUID(), 'claude-code', (u) => second.push(u));
      expect(second).toEqual([expect.objectContaining({ state: 'refused', reason: 'busy' })]);
      await first; // timeoutMs 8 s in setup
      expect(updates.at(-1)).toMatchObject({ state: 'failed', reason: 'login_timeout' });
    });
  },
);
