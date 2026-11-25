import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { LoginReport, OpsUpdatePayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { failureCode } from '../src/jobs/runner.js';
import { LOGIN_EXPIRED, LoginManager, parseStatusJson } from '../src/remote-ops/login.js';
import type { RunFn } from '../src/remote-ops/process.js';
import {
  CLAUDE_LOCK_NAME,
  claudeLockDirs,
  osClaudeRunning,
  psHasClaude,
  sweepClaudeLocks,
  tasklistHasClaude,
} from '../src/runtimes/claude-locks.js';
import { LoginExpiredError } from '@remyral/agent-adapters';
import { captureLines, tempDir } from './helpers.js';

/** p5-claude-auth-health: stale lock cleanup, the expired-login marker, the Check result. */

const HOUR = 3600_000;

async function lockFixture() {
  const home = await tempDir('claude-locks-');
  const cfg = join(home, '.claude');
  await mkdir(cfg);
  const old = new Date(Date.now() - 2 * HOUR);
  // proper-lockfile style directories and plain files, old and fresh, plus things that must never be touched.
  await mkdir(join(home, '.claude.lock'));
  await mkdir(join(cfg, '.oauth_refresh.lock'));
  await writeFile(join(cfg, '.credentials.json.lock'), '');
  await writeFile(join(cfg, '.credentials.json'), '{"secret":"never read"}');
  await writeFile(join(home, 'other.lock'), '');
  await mkdir(join(cfg, 'fresh-parent'));
  for (const p of [
    join(home, '.claude.lock'),
    join(cfg, '.oauth_refresh.lock'),
    join(cfg, '.credentials.json.lock'),
    join(home, 'other.lock'),
  ]) {
    await utimes(p, old, old);
  }
  await mkdir(join(cfg, '.claude.json.lock')); // fresh: a live refresh may hold it
  return { home, cfg };
}

describe('stale Claude lock cleanup', () => {
  it('removes only known lock names older than the limit when no Claude process runs', async () => {
    const { home, cfg } = await lockFixture();
    const log = captureLines();
    const r = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, home),
      claudeRunning: () => Promise.resolve(false),
      logger: createLogger({ sink: log.sink }),
    });
    expect([...r.removed].sort()).toEqual(
      [
        join(home, '.claude.lock'),
        join(cfg, '.credentials.json.lock'),
        join(cfg, '.oauth_refresh.lock'),
      ].sort(),
    );
    expect((await readdir(home)).sort()).toEqual(['.claude', 'other.lock']);
    expect((await readdir(cfg)).sort()).toEqual(['.claude.json.lock', '.credentials.json', 'fresh-parent']);
    expect(log.lines.join('\n')).toContain('removed stale Claude Code lock');
  });

  it('while a Claude process runs (or the process list fails) only dead refresh locks go (p10-claude-login-health)', async () => {
    const { home, cfg } = await lockFixture();
    const logger = createLogger({ sink: () => undefined });
    const running = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, home),
      claudeRunning: () => Promise.resolve(true),
      logger,
    });
    // The refresh locks are 2 h untouched: no live holder by the CLI's own rule (a holder touches them every 5 s).
    expect(running.skipped).toBe('claude_running');
    expect([...running.removed].sort()).toEqual(
      [join(home, '.claude.lock'), join(cfg, '.oauth_refresh.lock')].sort(),
    );
    // Config locks stay while a process runs.
    expect(await readdir(cfg)).toContain('.credentials.json.lock');
    const again = await lockFixture();
    const failing = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, again.home),
      claudeRunning: () => Promise.reject(new Error('tasklist failed')),
      logger,
    });
    expect(failing.skipped).toBe('process_list_unavailable');
    expect(failing.removed).toHaveLength(2);
    expect(await readdir(again.cfg)).toContain('.credentials.json.lock');
  });

  it('does not ask for the process list when nothing is stale; honours the configured age', async () => {
    const { home } = await lockFixture();
    let asked = 0;
    const r = await sweepClaudeLocks({
      dirs: claudeLockDirs({}, home),
      claudeRunning: () => {
        asked += 1;
        return Promise.resolve(false);
      },
      logger: createLogger({ sink: () => undefined }),
      maxAgeMs: 3 * HOUR,
      refreshStaleMs: 3 * HOUR,
    });
    expect(r.removed).toEqual([]);
    expect(asked).toBe(0);
  });

  it('knows the lock names and the directories (CLAUDE_CONFIG_DIR included)', () => {
    for (const n of ['.oauth_refresh.lock', '.claude.lock', '.claude.json.lock', '.credentials.json.lock'])
      expect(CLAUDE_LOCK_NAME.test(n), n).toBe(true);
    for (const n of ['.credentials.json', 'x.lock', '.claude', '.oauth_refresh.lock.bak'])
      expect(CLAUDE_LOCK_NAME.test(n), n).toBe(false);
    expect(claudeLockDirs({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/w')).toEqual([
      '/home/w',
      join('/home/w', '.claude'),
      '/cfg',
    ]);
  });

  it('parses tasklist /V CSV (any locale) and ps output', () => {
    const rows = [
      '"claude.exe","4242","Services","0","120.000 K","Unknown","NT SERVICE\\RemyralWorker","0:00:02","N/A"',
      '"claude.exe","4343","Console","1","90.000 K","Unknown","N/A","0:00:01","N/A"',
    ];
    expect(tasklistHasClaude(rows.join('\r\n'), ['RemyralWorker'])).toBe(true);
    expect(tasklistHasClaude(rows[1] ?? '', ['RemyralWorker'])).toBe(false);
    expect(
      tasklistHasClaude('INFO: No tasks are running which match the specified criteria.\r\n', ['x']),
    ).toBe(false);
    expect(psHasClaude('/usr/bin/ssh host\n/home/w/.local/share/claude/versions/2.1.296/claude -p\n')).toBe(
      true,
    );
    expect(psHasClaude('node /x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js\n')).toBe(true);
    expect(psHasClaude('/usr/bin/vim claude.md\nbash\n')).toBe(false);
  });

  it('the OS check runs tasklist on Windows and ps elsewhere; a failed listing rejects', async () => {
    const calls: string[] = [];
    const run =
      (stdout: string, exitCode = 0): RunFn =>
      (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        return Promise.resolve({ exitCode, stdout, stderr: '', timedOut: false });
      };
    const win = osClaudeRunning(
      run('"claude.exe","1","Services","0","1 K","Unknown","NT SERVICE\\svc","0:00:00","N/A"'),
      'win32',
      { SystemRoot: 'C:\\Windows', USERNAME: 'svc' },
    );
    expect(await win()).toBe(true);
    expect(calls[0]).toContain('tasklist.exe /FI IMAGENAME eq claude.exe /V /FO CSV /NH');
    if (process.platform !== 'win32') {
      await expect(osClaudeRunning(run('', 1), 'linux')()).rejects.toThrow('ps failed');
      expect(await osClaudeRunning(run('bash\n'), 'darwin')()).toBe(false);
    }
  });
});

describe('expired login marker (LoginManager)', () => {
  function manager(stdout: string) {
    return new LoginManager({
      binary: () => Promise.resolve('/bin/claude'),
      env: {},
      run: () => Promise.resolve({ exitCode: 0, stdout, stderr: '', timedOut: false }),
      logger: createLogger({ sink: () => undefined }),
      clock: () => new Date('2026-10-14T19:40:00Z'),
    });
  }

  it('a failed run marks the login expired until a run succeeds; the report validates', () => {
    const m = manager('{}');
    expect(m.report()).toEqual([]);
    m.markExpired('claude-code');
    expect(m.isExpired('claude-code')).toBe(true);
    const [rep] = m.report();
    expect(rep).toMatchObject({ runtime: 'claude-code', status: 'expired', reason: LOGIN_EXPIRED });
    expect(LoginReport.parse(rep)).toEqual(rep);
    m.clearExpired('claude-code');
    expect(m.isExpired('claude-code')).toBe(false);
    expect(m.report()[0]).toMatchObject({ status: 'logged_in' });
    expect(m.report()[0]?.reason).toBeUndefined();
  });

  it('p9-windows-slots-local-login: an older contention flag is reported with its own reason, cleared like expiry', () => {
    const m = manager('{}');
    m.markExpired('claude-code', 'login_refresh_contention');
    const [rep] = m.report();
    expect(rep).toMatchObject({ status: 'expired', reason: 'login_refresh_contention' });
    expect(LoginReport.parse(rep)).toEqual(rep);
    m.markExpired('codex', 'Not A Reason!');
    expect(m.report().find((r) => r.runtime === 'codex')?.reason).toBe(LOGIN_EXPIRED);
    m.clearExpired('claude-code');
    expect(m.report().find((r) => r.runtime === 'claude-code')).toMatchObject({ status: 'logged_in' });
    expect(m.report().find((r) => r.runtime === 'claude-code')?.reason).toBeUndefined();
  });

  it('Check reads the status JSON even with warnings around it (was: Unknown)', async () => {
    const noisy =
      '(node:2704) Warning: something deprecated\n{"loggedIn": true, "authMethod": "claude.ai"}\nUpdate available\n';
    const report = await manager(noisy).status('claude-code');
    expect(report).toEqual({
      runtime: 'claude-code',
      status: 'logged_in',
      method: 'claude.ai',
      checkedAt: '2026-10-14T19:40:00.000Z',
    });
    expect(parseStatusJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseStatusJson('no json')).toThrow();
  });

  it('Check keeps the expired state while the status command only says "logged in"', async () => {
    const m = manager('{"loggedIn": true, "authMethod": "claude.ai"}');
    m.markExpired('claude-code');
    const report = await m.status('claude-code');
    expect(report).toMatchObject({ status: 'expired', reason: LOGIN_EXPIRED, method: 'claude.ai' });
    // The OPS_UPDATE that carries it validates.
    expect(
      OpsUpdatePayload.parse({
        commandId: '00000000-0000-4000-8000-000000000001',
        seq: 1,
        kind: 'login.status',
        state: 'succeeded',
        login: { runtime: 'claude-code', expectsCode: false, status: report.status, reason: report.reason },
      }).login?.reason,
    ).toBe(LOGIN_EXPIRED);
  });
});

describe('job failure code', () => {
  it('a LoginExpiredError is reported as login_expired, other errors by name', () => {
    expect(failureCode(new LoginExpiredError('claude-code', 'Failed to refresh OAuth token'))).toBe(
      LOGIN_EXPIRED,
    );
    expect(failureCode(new TypeError('x'))).toBe('TypeError');
    expect(failureCode('str')).toBe('job_failed');
  });
});
