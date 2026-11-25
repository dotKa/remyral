import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessConfiner, SpawnPlan } from '@remyral/agent-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagedTool } from '../src/tools/installer.js';
import {
  applyToolEnv,
  EMPTY_TOOL_ENV,
  jobToolDirs,
  managedToolEnv,
  pathKey,
  resolveGitBinary,
  withJobToolDirs,
  withToolEnv,
} from '../src/tools/tool-env.js';
import { GitNotFoundError } from '../src/workspace/errors.js';
import { GitRunner } from '../src/workspace/git.js';

/** p5-live-fixes-2: worker-managed git / python / ffmpeg / browser for the worker and its runtimes. */

const DATA = 'C:\\ProgramData\\RemyralWorker\\data\\tools';
function managed(tool: ManagedTool['tool'], version: string, dir: string, entry: string): ManagedTool {
  return {
    tool,
    version,
    reportAs: tool === 'browser' ? 'playwright-chromium' : tool,
    installedAt: '2026-10-14T19:54:43.975Z',
    entry,
    entrySha256: 'a'.repeat(64),
    dir,
  };
}
const GIT = managed(
  'git',
  '2.56.0.2',
  `${DATA}\\git\\2.56.0.2`,
  `${DATA}\\git\\2.56.0.2\\mingit\\cmd\\git.exe`,
);
const PY = managed(
  'python',
  '3.13.16',
  `${DATA}\\python\\3.13.16`,
  `${DATA}\\python\\3.13.16\\python\\python.exe`,
);
const FF = managed(
  'ffmpeg',
  '9.0.2',
  `${DATA}\\ffmpeg\\9.0.2`,
  `${DATA}\\ffmpeg\\9.0.2\\ffmpeg\\bin\\ffmpeg.exe`,
);
const BROWSER = managed(
  'browser',
  '1248',
  `${DATA}\\browser\\1248`,
  `${DATA}\\browser\\1248\\chromium-1248\\chrome-win64\\chrome.exe`,
);

describe('git binary resolution (live: spawn git ENOENT with MinGit installed)', () => {
  it('config → worker-managed MinGit → git on PATH', () => {
    expect(resolveGitBinary('C:\\Git\\cmd\\git.exe', [GIT])).toEqual({
      binary: 'C:\\Git\\cmd\\git.exe',
      source: 'config',
    });
    expect(resolveGitBinary(undefined, [BROWSER, GIT])).toEqual({ binary: GIT.entry, source: 'managed' });
    expect(resolveGitBinary(undefined, [BROWSER])).toEqual({ binary: 'git', source: 'path' });
    // The newest managed git wins.
    const newer = { ...GIT, version: '2.57.0', entry: 'C:\\x\\git.exe' };
    expect(resolveGitBinary(undefined, [GIT, newer]).binary).toBe('C:\\x\\git.exe');
  });

  describe('GitRunner resolves the binary per command', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'rw-git-bin-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('a missing git is a clear error; a git that appears later is used without a restart', async () => {
      let installed = false;
      let calls = 0;
      const runner = new GitRunner({
        emptyHooksDir: dir,
        binary: () => {
          calls++;
          return installed ? 'git' : join(dir, 'no-such-git');
        },
      });
      const err = await runner.run({ cwd: dir, args: ['--version'] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitNotFoundError);
      expect(String(err)).toContain('Machines → <machine> → Tools → git');
      expect(runner.binary).toBe(join(dir, 'no-such-git'));
      installed = true;
      const ok = await runner.run({ cwd: dir, args: ['--version'] });
      expect(ok.stdout).toMatch(/^git version /);
      expect(calls).toBe(2);
      expect(runner.binary).toBe('git');
    });

    it('a failing resolver falls back to git on PATH', async () => {
      const runner = new GitRunner({
        emptyHooksDir: dir,
        binary: () => Promise.reject(new Error('inventory unreadable')),
      });
      expect(await runner.resolveBinary()).toBe('git');
      expect((await runner.run({ cwd: dir, args: ['--version'] })).code).toBe(0);
    });
  });
});

describe('managed tools on the runtimes PATH', () => {
  it('git cmd, python + Scripts (pip), ffmpeg bin; Playwright browsers path for the browser', () => {
    const t = managedToolEnv([BROWSER, GIT, PY, FF], 'win32');
    expect(t.pathDirs).toEqual([
      `${DATA}\\ffmpeg\\9.0.2\\ffmpeg\\bin`,
      `${DATA}\\python\\3.13.16\\python`,
      `${DATA}\\python\\3.13.16\\python\\Scripts`,
      `${DATA}\\git\\2.56.0.2\\mingit\\cmd`,
    ]);
    expect(t.vars).toEqual({
      PLAYWRIGHT_BROWSERS_PATH: `${DATA}\\browser\\1248`,
      REMYRAL_BROWSER: BROWSER.entry,
    });
    expect(managedToolEnv([], 'linux')).toEqual({ pathDirs: [], vars: {} });
  });

  it('Windows: prepends to the existing Path (whatever its casing), drops duplicates, keeps one variable', () => {
    const env = { Path: 'C:\\Windows\\system32;C:\\X\\GIT\\CMD', SystemRoot: 'C:\\Windows' };
    const out = applyToolEnv(env, { pathDirs: ['C:\\x\\git\\cmd', 'C:\\py'], vars: {} }, 'win32');
    expect(out).toEqual({ Path: 'C:\\x\\git\\cmd;C:\\py;C:\\Windows\\system32', SystemRoot: 'C:\\Windows' });
    expect(pathKey({ PATH: 'a', Path: 'b' }, 'win32')).toBe('PATH');
    const two = applyToolEnv({ PATH: 'a', Path: 'b' }, { pathDirs: ['c'], vars: {} }, 'win32');
    expect(two).toEqual({ PATH: 'c;a' });
    // No PATH at all: one is created.
    expect(applyToolEnv({}, { pathDirs: ['c'], vars: {} }, 'win32')).toEqual({ PATH: 'c' });
  });

  it('POSIX: PATH with colons; variables already set by the job are kept', () => {
    const out = applyToolEnv(
      { PATH: '/usr/bin:/opt/tool', PLAYWRIGHT_BROWSERS_PATH: '/mine' },
      { pathDirs: ['/opt/tool'], vars: { PLAYWRIGHT_BROWSERS_PATH: '/managed', REMYRAL_BROWSER: '/b' } },
      'linux',
    );
    expect(out).toEqual({
      PATH: '/opt/tool:/usr/bin',
      PLAYWRIGHT_BROWSERS_PATH: '/mine',
      REMYRAL_BROWSER: '/b',
    });
    // Windows variable names are case-insensitive.
    expect(
      applyToolEnv(
        { playwright_browsers_path: 'x' },
        { pathDirs: [], vars: { PLAYWRIGHT_BROWSERS_PATH: 'y' } },
        'win32',
      ),
    ).toEqual({ playwright_browsers_path: 'x' });
  });

  it('the confiner decorator rewrites the plan env read at start time (a tool installed later is included)', async () => {
    const seen: SpawnPlan[] = [];
    const inner: ProcessConfiner = {
      kind: 'host-restricted:test',
      confine: (plan) => {
        seen.push(plan);
        return Promise.resolve({ command: plan.command, args: plan.args, cwd: plan.cwd, env: plan.env });
      },
    };
    let tools = [GIT];
    const c = withToolEnv(inner, () => Promise.resolve(managedToolEnv(tools, 'win32')), 'win32');
    expect(c.kind).toBe('host-restricted:test');
    const plan: SpawnPlan = {
      command: 'claude',
      args: [],
      cwd: 'C:\\w',
      env: { PATH: 'C:\\Windows', SECRET: 's' },
      secretNames: ['SECRET'],
    };
    await c.confine(plan);
    tools = [GIT, FF];
    await c.confine(plan);
    expect(seen[0]?.env).toEqual({ PATH: `${DATA}\\git\\2.56.0.2\\mingit\\cmd;C:\\Windows`, SECRET: 's' });
    expect(seen[1]?.env.PATH?.startsWith(`${DATA}\\ffmpeg\\9.0.2\\ffmpeg\\bin;`)).toBe(true);
    expect(seen[1]?.secretNames).toEqual(['SECRET']);
    // A failing inventory never blocks the runtime.
    const broken = withToolEnv(inner, () => Promise.reject(new Error('x')), 'win32');
    await broken.confine(plan);
    expect(seen[2]?.env).toEqual(plan.env);
  });
});

describe('job PATH: the tools the machine reports (p14-repo-egress problem 2)', () => {
  const LINUX_NODE = '/opt/remyral-worker/node/node-v24.11.1-linux-x64/bin/node';
  const writableOnly = (writable: readonly string[]) => (d: string) => Promise.resolve(writable.includes(d));

  it('Linux: the worker’s private Node dir (node, npm, npx) and system tools are appended after the service PATH', async () => {
    const dirs = await jobToolDirs({
      execPath: LINUX_NODE,
      detected: [
        { name: 'node', found: true, source: 'system' },
        { name: 'git', found: true, source: 'system', path: '/usr/bin/git' },
        { name: 'uv', found: true, source: 'system', path: '/usr/local/bin/uv' },
        { name: 'docker', found: true, source: 'system', path: '/opt/docker/bin/docker' },
        { name: 'python', found: false, source: 'system' },
        { name: 'git', found: true, source: 'managed', path: '/var/lib/remyral-worker/tools/git/x/bin/git' },
      ],
      platform: 'linux',
      excluded: [
        '/var/lib/remyral-worker',
        '/var/lib/remyral-worker/workspaces',
        '/var/lib/remyral-worker/home',
      ],
      writable: writableOnly([]),
    });
    // docker is not a job tool; a managed install comes through pathDirs; duplicates collapse.
    expect(dirs).toEqual([
      '/opt/remyral-worker/node/node-v24.11.1-linux-x64/bin',
      '/usr/bin',
      '/usr/local/bin',
    ]);
    const env = applyToolEnv(
      { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      withJobToolDirs({ pathDirs: ['/var/lib/remyral-worker/tools/git/x/bin'], vars: {} }, dirs),
      'linux',
    );
    expect(env.PATH).toBe(
      '/var/lib/remyral-worker/tools/git/x/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/remyral-worker/node/node-v24.11.1-linux-x64/bin',
    );
  });

  it('never a writable dir, the data dir, the workspace root or the worker HOME (nvm / ~/.local/bin)', async () => {
    const dirs = await jobToolDirs({
      execPath: '/var/lib/remyral-worker/home/.nvm/versions/node/v24.11.1/bin/node',
      detected: [
        { name: 'uv', found: true, source: 'system', path: '/var/lib/remyral-worker/home/.local/bin/uv' },
        { name: 'git', found: true, source: 'system', path: '/srv/shared/bin/git' },
        { name: 'python', found: true, source: 'system', path: '/var/lib/remyral-worker/data/py/python3' },
        { name: 'node', found: true, source: 'system', path: 'relative/node' },
      ],
      platform: 'linux',
      excluded: ['/var/lib/remyral-worker/data', '/srv/work', '/var/lib/remyral-worker/home'],
      writable: writableOnly(['/srv/shared/bin']),
    });
    expect(dirs).toEqual([]);
    // A failing access check counts as writable (never added).
    expect(
      await jobToolDirs({
        execPath: '/usr/local/bin/node',
        detected: [],
        platform: 'darwin',
        excluded: [],
        writable: () => Promise.reject(new Error('EACCES')),
      }),
    ).toEqual([]);
  });

  it('Windows (per-job accounts too): the private Node and Git for Windows, case-insensitive exclusions', async () => {
    const dirs = await jobToolDirs({
      execPath: 'C:\\Program Files\\RemyralWorker\\node\\node-v24.11.1-win-x64\\node.exe',
      detected: [
        { name: 'git', found: true, source: 'system', path: 'C:\\Program Files\\Git\\cmd\\git.exe' },
        {
          name: 'uv',
          found: true,
          source: 'system',
          path: 'c:\\programdata\\remyralworker\\data\\x\\uv.exe',
        },
        {
          name: 'node',
          found: true,
          source: 'system',
          path: 'C:\\Users\\svc\\AppData\\Roaming\\npm\\node.exe',
        },
      ],
      platform: 'win32',
      excluded: ['C:\\ProgramData\\RemyralWorker\\data', 'C:\\Users\\svc'],
      writable: () => Promise.resolve(true),
    });
    expect(dirs).toEqual([
      'C:\\Program Files\\RemyralWorker\\node\\node-v24.11.1-win-x64',
      'C:\\Program Files\\Git\\cmd',
    ]);
    const env = applyToolEnv(
      { Path: 'C:\\Windows\\system32' },
      withJobToolDirs(EMPTY_TOOL_ENV, dirs),
      'win32',
    );
    expect(env).toEqual({
      Path: 'C:\\Windows\\system32;C:\\Program Files\\RemyralWorker\\node\\node-v24.11.1-win-x64;C:\\Program Files\\Git\\cmd',
    });
  });
});
