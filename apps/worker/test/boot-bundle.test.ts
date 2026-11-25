import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootVerdict } from '../src/boot/diagnostics.js';
import { isWindows, tempDir } from './helpers.js';

// p6-worker-boot-diagnostics, incident 2026-10-16 (worker 1.0.22 rolled back on Windows without a single line in
// worker.log): the REAL bundle (built like scripts/bundle.mjs) is started
//  - under a simulated Windows host (process.platform 'win32', no POSIX uid/gid APIs, no HOME): module evaluation
//    and the boot path up to "config loaded" must work and be recorded in boot.log;
//  - with a failure injected while the bundle's modules are being evaluated (before the entry runs): boot.log
//    must hold the fatal error, its stage and the exit;
//  - with a broken config (exit 78 before the logger exists): boot.log must hold the reason from stderr.

const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
let dir = '';
let bundle = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rw-bootbundle-'));
  bundle = join(dir, 'remyral-worker.mjs');
  await build({
    absWorkingDir: WORKER_ROOT,
    entryPoints: ['src/bin.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@remyral/source'],
    define: { __REMYRAL_WORKER_VERSION__: JSON.stringify('1.0.99') },
    banner: {
      js: "import { createRequire as __remyralCreateRequire } from 'node:module';\nconst require = __remyralCreateRequire(import.meta.url);",
    },
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
  });
  // Windows host simulation, loaded with --import before the bundle.
  await writeFile(
    join(dir, 'win-sim.mjs'),
    [
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      "for (const k of ['getuid', 'geteuid', 'getgid', 'getegid', 'getgroups']) {",
      '  Object.defineProperty(process, k, { value: undefined, configurable: true, writable: true });',
      '}',
      'delete process.env.HOME;',
    ].join('\n'),
  );
  // A module-evaluation failure: the protocol's site file-type table is frozen at module top level, after the
  // boot guard and before the entry runs.
  await writeFile(
    join(dir, 'fail-load.mjs'),
    [
      'const freeze = Object.freeze;',
      'Object.freeze = (o) => {',
      "  if (o !== null && typeof o === 'object' && Object.hasOwn(o, 'webmanifest')) throw new Error('simulated module-load failure');",
      '  return freeze(o);',
      '};',
    ].join('\n'),
  );
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  out: string;
}

/** Runs the bundle until it exits or `until(output)` holds (then SIGTERM), at most `ms`. */
function run(
  args: string[],
  opts: {
    cwd: string;
    preload?: string;
    env?: NodeJS.ProcessEnv;
    until?: (out: string) => boolean;
    ms?: number;
  },
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...(opts.preload === undefined ? [] : ['--import', opts.preload]), bundle, ...args],
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let stopped = false;
    const onData = (d: Buffer) => {
      out += d.toString();
      if (!stopped && opts.until?.(out) === true) {
        stopped = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.ms ?? 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const records = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe.skipIf(isWindows)('worker bundle boot under a simulated Windows host', () => {
  it('evaluates every module and boots to "config loaded"; boot.log records start and ready (win32)', async () => {
    const cwd = await tempDir('rw-winboot-');
    // On the simulated host the config's Windows paths are plain file names inside cwd.
    const configPath = 'C:\\cfg.json';
    await writeFile(
      join(cwd, configPath),
      JSON.stringify({
        masterUrl: 'ws://127.0.0.1:9/v1',
        workspaceRoot: 'C:\\rw\\work',
        dataDir: 'C:\\rw\\data',
        updates: { enabled: false },
      }),
    );
    const r = await run(['run', '--config', configPath], {
      cwd,
      preload: join(dir, 'win-sim.mjs'),
      env: { ProgramData: 'C:\\ProgramData' },
      until: (out) => out.includes('"msg":"config loaded"'),
    });
    expect(r.out).toContain('"msg":"config loaded"');
    expect(r.out).toContain('"version":"1.0.99"');
    // Data dir "C:\rw\data" → the win32 join "C:\rw\data\logs" is one directory name on this host.
    const boot = records(await readFile(join(cwd, 'C:\\rw\\data\\logs', 'boot.log'), 'utf8'));
    expect(boot[0]).toMatchObject({ event: 'start', version: '1.0.99', platform: 'win32', command: 'run' });
    expect(boot.some((b) => b.event === 'ready')).toBe(true);
    expect(boot.some((b) => b.event === 'fatal' && b.stage === 'module-load')).toBe(false);
  }, 60_000);
});

describe.skipIf(isWindows)('worker bundle boot failures land in boot.log', () => {
  it('a failure while the bundle modules are evaluated: fatal (stage module-load) + exit, verdict crashed', async () => {
    const root = await tempDir('rw-bootfail-');
    const dataDir = join(root, 'data');
    const config = join(root, 'config.json');
    await writeFile(
      config,
      JSON.stringify({ masterUrl: 'ws://127.0.0.1:9/v1', workspaceRoot: join(root, 'w'), dataDir }),
      { mode: 0o600 },
    );
    const since = new Date(Date.now() - 1000);
    const r = await run(['run', '--config', config], { cwd: root, preload: join(dir, 'fail-load.mjs') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('simulated module-load failure');
    const text = await readFile(join(dataDir, 'logs', 'boot.log'), 'utf8');
    const boot = records(text);
    expect(boot.map((b) => b.event)).toEqual(['start', 'fatal', 'exit']);
    expect(boot[1]).toMatchObject({
      stage: 'module-load',
      version: '1.0.99',
      error: { message: 'simulated module-load failure' },
    });
    expect(String((boot[1]?.error as { stack?: string }).stack)).toContain('remyral-worker.mjs');
    expect(bootVerdict(text, '1.0.99', since)).toBe('crashed');
  }, 60_000);

  it('a configuration error before the logger exists: the stderr reason is kept, verdict exited', async () => {
    const root = await tempDir('rw-bootcfg-');
    const dataDir = join(root, 'data');
    const config = join(root, 'config.json');
    await writeFile(
      config,
      JSON.stringify({ masterUrl: 'ws://evil.example/v1', workspaceRoot: join(root, 'w'), dataDir }),
      {
        mode: 0o600,
      },
    );
    const r = await run(['run', '--config', config], { cwd: root });
    expect(r.code).toBe(78);
    const text = await readFile(join(dataDir, 'logs', 'boot.log'), 'utf8');
    const boot = records(text);
    expect(boot.map((b) => b.event)).toEqual(['start', 'fatal', 'exit']);
    expect(boot[1]).toMatchObject({ origin: 'config', stage: 'startup' });
    expect(boot[2]).toMatchObject({ code: 78 });
    expect(String(boot[2]?.stderr)).toContain('masterUrl');
    expect(bootVerdict(text, '1.0.99', null)).toBe('exited');
  }, 60_000);

  it('interactive commands never write a boot log', async () => {
    const root = await tempDir('rw-bootcli-');
    const r = await run(['--version'], {
      cwd: root,
      env: { HOME: root, XDG_STATE_HOME: join(root, 'state') },
    });
    expect(r.out.trim()).toBe('1.0.99');
    await expect(readFile(join(root, 'state', 'remyral-worker', 'logs', 'boot.log'))).rejects.toThrow();
  }, 60_000);
});
