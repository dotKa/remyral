import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@remyral/observability';
import { describe, expect, it } from 'vitest';
import { updaterMain } from '../src/update/helper/main.js';
import {
  BUBBLEWRAP_PACKAGE,
  type Exec,
  LINUX_PREPARE_UNIT,
  PrivilegedPreparer,
  requestSandboxPackages,
} from '../src/update/helper/prepare.js';
import { createNodeSystem } from '../src/system/node.js';
import { pathHost, tempDir } from './helpers.js';

/**
 * p19-auto-bwrap (sandbox prerequisites are installed automatically): bubblewrap is installed without a click.
 * The update unit (`apply`, no network) starts the prepare unit when `bwrap` is missing; the prepare unit (root,
 * network) runs the fixed `bubblewrap_install` step without a request. Best effort, never throws, Linux only.
 */

const lines: string[] = [];
const logger = createLogger({ sink: (l) => lines.push(l) });

/** Records commands; `bwrap --version` answers per `bwrapPresent`, everything else per `fail` / success. */
function fakeExec(
  log: string[][],
  o: { bwrapPresent: boolean; fail?: string; throws?: boolean } = { bwrapPresent: false },
): Exec {
  return (file, args) => {
    log.push([file, ...args]);
    const key = [file, ...args].join(' ');
    if (o.throws === true) return Promise.reject(new Error('spawn EACCES'));
    if (key === '/usr/bin/env bwrap --version') {
      return Promise.resolve(
        o.bwrapPresent
          ? { code: 0, stdout: 'bubblewrap 0.9.0\n', stderr: '' }
          : { code: 127, stdout: '', stderr: 'env: bwrap: No such file or directory' },
      );
    }
    if (o.fail !== undefined && key.startsWith(o.fail))
      return Promise.resolve({ code: 100, stdout: '', stderr: 'E: Unable to locate package' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

async function preparer(platform: NodeJS.Platform, exec: Exec, osRelease = 'ID=ubuntu\nID_LIKE=debian\n') {
  const root = await tempDir('autobwrap-');
  const data = join(root, 'data');
  const install = join(root, 'install');
  await mkdir(data, { recursive: true });
  await mkdir(install, { recursive: true });
  return new PrivilegedPreparer({
    platform,
    configPath: join(root, 'config.json'),
    dataDir: data,
    installDir: install,
    pinnedKeys: null,
    masterUrl: 'wss://m.example.com/v1/worker',
    logger,
    exec,
    osRelease: () => Promise.resolve(osRelease),
  });
}

describe('privileged helper installs bubblewrap without a request (prepare unit)', () => {
  it('installs the fixed package when bwrap is missing (apt and dnf)', async () => {
    const log: string[][] = [];
    const r = await (await preparer('linux', fakeExec(log))).ensureSandboxPackages();
    expect(r?.state).toBe('done');
    expect(r?.detail).toContain('bubblewrap installed');
    expect(log).toContainEqual(['apt-get', 'update']);
    expect(log).toContainEqual(['apt-get', 'install', '-y', '--no-install-recommends', BUBBLEWRAP_PACKAGE]);
    const dnf: string[][] = [];
    await (
      await preparer('linux', fakeExec(dnf), 'ID="rocky"\nID_LIKE="rhel centos fedora"\n')
    ).ensureSandboxPackages();
    expect(dnf).toContainEqual(['dnf', 'install', '-y', 'bubblewrap']);
  });

  it('skips when bwrap is present and does nothing off Linux', async () => {
    const log: string[][] = [];
    const r = await (await preparer('linux', fakeExec(log, { bwrapPresent: true }))).ensureSandboxPackages();
    expect(r?.state).toBe('done');
    expect(r?.detail).toContain('already installed');
    expect(log).toEqual([['/usr/bin/env', 'bwrap', '--version']]);
    for (const platform of ['darwin', 'win32'] as const) {
      const other: string[][] = [];
      expect(await (await preparer(platform, fakeExec(other))).ensureSandboxPackages()).toBeNull();
      expect(other).toEqual([]);
    }
  });

  it('never throws: a failed install, an unknown distribution or a broken exec is reported and logged', async () => {
    const failed = await (
      await preparer('linux', fakeExec([], { bwrapPresent: false, fail: 'apt-get install' }))
    ).ensureSandboxPackages();
    expect(failed).toMatchObject({ state: 'failed', code: 'apt_install_failed' });
    const unknown = await (await preparer('linux', fakeExec([]), 'ID=arch\n')).ensureSandboxPackages();
    expect(unknown).toMatchObject({ state: 'needs_owner', code: 'distribution_unsupported' });
    const broken = await (
      await preparer('linux', fakeExec([], { bwrapPresent: false, throws: true }))
    ).ensureSandboxPackages();
    expect(broken).toMatchObject({ state: 'failed', code: 'step_error', detail: 'spawn EACCES' });
    expect(lines.join('\n')).toMatch(/automatic bubblewrap install (did not succeed|failed)/);
  });
});

describe('update activation hands a missing bubblewrap to the prepare unit (requestSandboxPackages)', () => {
  it('starts the fixed prepare unit only when bwrap is missing, only on Linux, never throws', async () => {
    const missing: string[][] = [];
    expect(await requestSandboxPackages({ platform: 'linux', exec: fakeExec(missing), logger })).toBe(
      'requested',
    );
    expect(missing).toEqual([
      ['/usr/bin/env', 'bwrap', '--version'],
      ['systemctl', 'start', '--no-block', LINUX_PREPARE_UNIT],
    ]);
    const present: string[][] = [];
    expect(
      await requestSandboxPackages({
        platform: 'linux',
        exec: fakeExec(present, { bwrapPresent: true }),
        logger,
      }),
    ).toBe('present');
    expect(present).toEqual([['/usr/bin/env', 'bwrap', '--version']]);
    const noUnit = fakeExec([], { bwrapPresent: false, fail: 'systemctl' });
    expect(await requestSandboxPackages({ platform: 'linux', exec: noUnit, logger })).toBe('failed');
    const broken = fakeExec([], { bwrapPresent: false, throws: true });
    expect(await requestSandboxPackages({ platform: 'linux', exec: broken, logger })).toBe('failed');
    for (const platform of ['darwin', 'win32'] as const) {
      const other: string[][] = [];
      expect(await requestSandboxPackages({ platform, exec: fakeExec(other), logger })).toBe('skipped');
      expect(other).toEqual([]);
    }
  });
});

describe('updater CLI wiring', () => {
  async function cli(platform: NodeJS.Platform, command: string, exec: Exec) {
    const dir = await tempDir('autobwrap-cli-');
    const cfgPath = join(dir, 'config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: join(dir, 'ws'),
        dataDir: join(dir, 'data'),
        updates: { installDir: join(dir, 'opt') },
      }),
    );
    const out: string[] = [];
    const code = await updaterMain(
      [command, '--config', cfgPath],
      {
        sys: createNodeSystem(),
        pathHost: pathHost({ platform }),
        configOwnerUid: process.getuid?.() ?? 0,
        logSink: () => undefined,
        service: { restart: () => Promise.resolve(), mainPid: () => Promise.resolve(null) },
        prepare: { exec, osRelease: () => Promise.resolve('ID=debian\n') },
      },
      { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
    );
    return { code, out };
  }

  it.skipIf(process.platform === 'win32')(
    'Linux apply (activation / boot) starts the prepare unit; Linux prepare installs; macOS apply does neither',
    async () => {
      const apply: string[][] = [];
      expect((await cli('linux', 'apply', fakeExec(apply))).code).toBe(0);
      expect(apply).toContainEqual(['systemctl', 'start', '--no-block', LINUX_PREPARE_UNIT]);
      expect(apply.some((c) => c[0] === 'apt-get')).toBe(false); // the update unit has no network

      const prepare: string[][] = [];
      expect((await cli('linux', 'prepare', fakeExec(prepare))).code).toBe(0);
      expect(prepare).toContainEqual(['apt-get', 'install', '-y', '--no-install-recommends', 'bubblewrap']);

      const present: string[][] = [];
      expect((await cli('linux', 'prepare', fakeExec(present, { bwrapPresent: true }))).code).toBe(0);
      expect(present.some((c) => c[0] === 'apt-get' || c[0] === 'systemctl')).toBe(false);

      const broken = await cli('linux', 'prepare', fakeExec([], { bwrapPresent: false, throws: true }));
      expect(broken.code).toBe(0);

      const mac: string[][] = [];
      expect((await cli('darwin', 'apply', fakeExec(mac))).code).toBe(0);
      expect(mac.some((c) => c.includes('bwrap') || c[0] === 'systemctl' || c[0] === 'apt-get')).toBe(false);
    },
  );
});

describe('Linux installer (a): bubblewrap best effort', () => {
  it('installs the fixed bubblewrap package with apt or dnf and only warns on failure', async () => {
    const script = await readFile(
      fileURLToPath(new URL('../../../infra/worker/linux/install.sh', import.meta.url)),
      'utf8',
    );
    const block = script.slice(script.indexOf('# p19-auto-bwrap'), script.indexOf('info "Enable and start"'));
    expect(block).toContain('apt-get install -y --no-install-recommends bubblewrap; }; then');
    expect(block).toContain('if ! run dnf install -y bubblewrap; then');
    expect(block).toContain('command -v bwrap');
    // Never fatal: no die/refuse in the step, every failure is a warning.
    expect(block).not.toMatch(/\b(die|refuse) /);
    expect(block.match(/warn "bubblewrap/g)).toHaveLength(3);
    // Before the service is (re)started, so the worker's first self-check sees it.
    expect(script.indexOf('# p19-auto-bwrap')).toBeLessThan(script.indexOf('info "Enable and start"'));
  });
});
