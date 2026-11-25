import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { satisfiedToolNames } from '@remyral/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeFileOps } from '../src/fs/ops.js';
import type { RunFn } from '../src/remote-ops/process.js';
import { detectTools } from '../src/tools/detect.js';
import { inspectMachine, PS_DISK, PS_SERVICES, PS_SOFTWARE } from '../src/tools/inspect.js';
import { ToolInstaller, ToolRefusal } from '../src/tools/installer.js';
import { ToolInventory } from '../src/tools/inventory.js';
import { recipePlatform, type UnprivilegedRecipe } from '../src/tools/recipes.js';
import { FakeSystem, ok } from './fake-system.js';
import { buildZip } from './zip-fixtures.js';

const logger = createLogger({ sink: () => undefined });
const platform = recipePlatform(process.platform, process.arch);

let server: Server;
let base = '';
const served = new Map<string, Buffer>();
beforeAll(async () => {
  server = createServer((req, res) => {
    const body = served.get(req.url ?? '');
    if (body === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise<void>((r) =>
    server.close(() => {
      r();
    }),
  );
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rw-tools-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function recipe(
  path: string,
  zip: Buffer,
  sha256 = createHash('sha256').update(zip).digest('hex'),
): UnprivilegedRecipe {
  served.set(path, zip);
  if (platform === null) throw new Error('unsupported test platform');
  return {
    tool: 'browser',
    version: '1248',
    elevated: false,
    reportAs: 'playwright-chromium',
    title: 'test browser',
    platforms: {
      [platform]: {
        url: `${base}${path}`,
        sha256,
        size: zip.length,
        into: 'chromium-1248',
        entry: 'chromium-1248/chrome/chrome',
        markers: ['chromium-1248/INSTALLATION_COMPLETE'],
      },
    },
  };
}

async function installer(recipes: readonly UnprivilegedRecipe[]): Promise<ToolInstaller> {
  return ToolInstaller.open({
    ops: createNodeFileOps(),
    dataDir: dir,
    platform,
    logger,
    recipes,
    reserveBytes: 0,
  });
}

describe('unprivileged recipe installs', () => {
  it('downloads, verifies the pinned checksum, extracts, records the entry digest and reports it', async () => {
    const zip = buildZip([{ name: 'chrome/chrome', data: '#!/bin/sh\necho chrome\n', mode: 0o755 }]);
    const t = await installer([recipe('/ok.zip', zip)]);
    const steps: string[] = [];
    const m = await t.install('browser', '1248', { progress: (s) => steps.push(s) });
    expect(steps).toEqual(['download', 'extract', 'activate']);
    expect(m.entry).toBe(join(dir, 'tools', 'browser', '1248', 'chromium-1248', 'chrome', 'chrome'));
    expect(await readFile(join(m.dir, 'chromium-1248', 'INSTALLATION_COMPLETE'), 'utf8')).toBe('');
    expect((await t.installed()).map((i) => i.reportAs)).toEqual(['playwright-chromium']);
    expect((await t.report()).find((r) => r.tool === 'browser')).toMatchObject({
      installed: true,
      supported: true,
    });
    // A reopened installer (worker restart) still knows the install.
    expect((await (await installer([recipe('/ok.zip', zip)])).installed()).length).toBe(1);
  });

  it('strips the archive folder, writes launcher shims and restores a missing one on reopen (pip.cmd)', async () => {
    const zip = buildZip([{ name: 'pkg-1.0/tools/python.exe', data: 'py', mode: 0o755 }]);
    const base0 = recipe('/py.zip', zip);
    const step = Object.values(base0.platforms)[0];
    if (step === undefined || platform === null) throw new Error('no step');
    const py: UnprivilegedRecipe = {
      ...base0,
      tool: 'python',
      version: '3.13.16',
      reportAs: 'python',
      platforms: {
        [platform]: {
          ...step,
          into: 'python',
          strip: 'pkg-1.0/tools',
          entry: 'python/python.exe',
          markers: [],
          shims: [
            { path: 'python/Scripts/pip.cmd', content: '@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\n' },
          ],
        },
      },
    };
    const t = await installer([py]);
    const m = await t.install('python', '3.13.16');
    const shim = join(m.dir, 'python', 'Scripts', 'pip.cmd');
    expect(await readFile(shim, 'utf8')).toBe('@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\n');
    await rm(shim);
    await installer([py]);
    expect(await readFile(shim, 'utf8')).toContain('-m pip');
  });

  it('a wrong checksum installs nothing; a modified entry is no longer reported', async () => {
    const zip = buildZip([{ name: 'chrome/chrome', data: 'x', mode: 0o755 }]);
    const bad = await installer([recipe('/bad.zip', zip, 'a'.repeat(64))]);
    await expect(bad.install('browser', '1248')).rejects.toMatchObject({ reason: 'integrity_mismatch' });
    expect(await bad.installed()).toEqual([]);

    const good = await installer([recipe('/good.zip', zip)]);
    const m = await good.install('browser', '1248');
    await writeFile(m.entry, 'tampered');
    const fresh = await installer([recipe('/good.zip', zip)]);
    expect(await fresh.installed()).toEqual([]);
  });

  it('refuses unknown, elevated and other-platform recipes without downloading anything', async () => {
    const t = await installer([]);
    await expect(t.install('git', '9.9.9')).rejects.toBeInstanceOf(ToolRefusal);
    const real = await ToolInstaller.open({ ops: createNodeFileOps(), dataDir: dir, platform, logger });
    await expect(real.install('git', 'distro')).rejects.toMatchObject({ reason: 'recipe_elevated' });
    const nowhere = await ToolInstaller.open({
      ops: createNodeFileOps(),
      dataDir: dir,
      platform: null,
      logger,
    });
    await expect(nowhere.install('browser', '1248')).rejects.toMatchObject({
      reason: 'platform_unsupported',
    });
  });

  it('remove deletes the managed install', async () => {
    const zip = buildZip([{ name: 'chrome/chrome', data: 'x', mode: 0o755 }]);
    const t = await installer([recipe('/rm.zip', zip)]);
    await t.install('browser', '1248');
    await t.remove('browser', '1248');
    expect(await t.installed()).toEqual([]);
    await expect(t.remove('browser', '1248')).rejects.toMatchObject({ reason: 'not_installed' });
  });
});

describe('tool detection (cheap: no browser is started)', () => {
  it('Windows: Chrome/Edge versions from the Application folder, Python, git, ffmpeg', async () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const sys = new FakeSystem({
      platform: 'win32',
      arch: 'x64',
      env: {
        PATH: 'C:\\Tools',
        PATHEXT: '.EXE',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      },
      files: { [chrome]: '', [edge]: '', 'C:\\Tools\\git.exe': '', 'C:\\Tools\\ffmpeg.exe': '' },
      exec: (file, args) => {
        if (file.endsWith('git.exe')) return ok('git version 2.56.0.windows.2');
        if (file.endsWith('ffmpeg.exe') && args[0] === '-version')
          return ok('ffmpeg version 7.1.1-full_build-www.gyan.dev');
        return undefined;
      },
    });
    const listing: Record<string, string[]> = {
      'C:\\Program Files\\Google\\Chrome\\Application': [
        '141.0.7390.66',
        'chrome.exe',
        'SetupMetrics',
        '140.0.1.2',
      ],
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application': ['141.0.3537.71', 'msedge.exe'],
    };
    const tools = await detectTools({ sys, readdir: (p) => Promise.resolve(listing[p] ?? []) }, []);
    const by = (n: string) => tools.find((t) => t.name === n);
    expect(by('chrome')).toMatchObject({ found: true, version: '141.0.7390.66', source: 'system' });
    expect(by('edge')).toMatchObject({ found: true, version: '141.0.3537.71' });
    expect(by('git')).toMatchObject({ found: true });
    expect(by('ffmpeg')).toMatchObject({ found: true, version: '7.1.1-full_build-www.gyan.dev' });
    expect(satisfiedToolNames({ tools })).toEqual(
      expect.arrayContaining(['browser', 'chrome', 'edge', 'git', 'ffmpeg']),
    );
    // No browser was started.
    expect(sys.execCalls.some((c) => c.file.endsWith('chrome.exe') || c.file.endsWith('msedge.exe'))).toBe(
      false,
    );
  });

  it('macOS reads Info.plist, Linux asks --version; managed installs are reported as such', async () => {
    const mac = new FakeSystem({
      platform: 'darwin',
      files: {
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
        '/Applications/Google Chrome.app/Contents/Info.plist':
          '<plist><dict><key>CFBundleShortVersionString</key>\n<string>141.0.7390.66</string></dict></plist>',
      },
    });
    const m = await detectTools({ sys: mac }, [
      {
        tool: 'browser',
        version: '1248',
        reportAs: 'playwright-chromium',
        installedAt: '2026-10-14T10:00:00.000Z',
        entry: '/data/tools/browser/1248/chromium-1248/x',
        entrySha256: 'a'.repeat(64),
        dir: '/data/tools/browser/1248',
      },
    ]);
    expect(m.find((t) => t.name === 'chrome')).toMatchObject({ found: true, version: '141.0.7390.66' });
    expect(m.find((t) => t.name === 'playwright-chromium')).toMatchObject({ found: true, source: 'managed' });
    const linux = new FakeSystem({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/usr/bin' },
      files: { '/usr/bin/chromium': '' },
      exec: (file) =>
        file === '/usr/bin/chromium' ? ok('Chromium 141.0.7390.65 built on Debian') : undefined,
    });
    const l = await detectTools({ sys: linux }, []);
    expect(l.find((t) => t.name === 'chromium')).toMatchObject({ found: true, version: '141.0.7390.65' });
    expect(l.find((t) => t.name === 'chrome')?.found).toBe(false);
  });
});

describe('the inventory is cached, persisted and refreshed on demand', () => {
  it('detects once, serves the cache, persists it and reports aliases for placement', async () => {
    let calls = 0;
    let now = Date.parse('2026-10-14T10:00:00Z');
    const t = await installer([]);
    const open = () =>
      ToolInventory.open({
        ops: createNodeFileOps(),
        dataDir: dir,
        installer: t,
        detect: () => {
          calls += 1;
          return Promise.resolve([
            { name: 'edge', found: true, version: '141.0.3537.71', source: 'system' as const },
            { name: 'docker', found: false, source: 'system' as const },
          ]);
        },
        logger,
        ttlSec: 600,
        clock: () => new Date(now),
        detectDelayMs: 0,
      });
    const inv = await open();
    expect(await inv.snapshot()).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    const r = await inv.report();
    expect(calls).toBe(1);
    expect(ToolInventory.capabilityTools(r)).toEqual([
      { name: 'browser', version: '141.0.3537.71' },
      { name: 'edge', version: '141.0.3537.71' },
    ]);
    // A restarted worker reads the persisted inventory without detecting again (once it is written: the report
    // is served from memory before the file is).
    await vi.waitFor(async () => {
      await readFile(join(dir, 'tools', 'inventory.json'));
    });
    const again = await open();
    expect((await again.report()).tools[0]?.name).toBe('edge');
    expect(calls).toBe(1);
    now += 601_000;
    await again.report();
    expect(calls).toBe(2);
    await again.refresh();
    expect(calls).toBe(3);
  });
});

describe('machine.inspect (read-only)', () => {
  it('Windows: fixed PowerShell scripts, UTF-8 output, bounded and redacted', async () => {
    const calls: string[][] = [];
    const run: RunFn = (file, args) => {
      calls.push([file, ...args]);
      const script = Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le');
      const out = script.includes('Get-ItemProperty')
        ? JSON.stringify([
            { n: 'Git', v: '2.56.0' },
            { n: 'Yazıcı Sürücüsü sk-ant-api03-SECRETSECRETSECRET', v: '' },
            // Seen on the real Windows target: registry values with trailing NULs.
            { n: 'Mesh Agent\u0000', v: '2026-02-16 03:43:44\u0000\u0000' },
          ])
        : script.includes('Get-Service')
          ? JSON.stringify({ n: 'Spooler', s: 'Running', t: 'Automatic' })
          : JSON.stringify([{ m: 'C:\\', f: 100, t: 200 }]);
      return Promise.resolve({ exitCode: 0, stdout: out, stderr: '', timedOut: false });
    };
    const r = await inspectMachine(
      {
        platform: 'win32',
        run,
        env: { SystemRoot: 'C:\\Windows' },
        cwd: 'C:\\data',
        redact: (s) => s.replace(/sk-ant-[A-Za-z0-9-]+/g, '[REDACTED]'),
        logs: () => Promise.resolve(['line 1']),
        tools: () => Promise.reject(new Error('no inventory')),
      },
      ['software', 'services', 'disk', 'logs', 'tools'],
    );
    expect(r.software).toEqual([
      { name: 'Git', version: '2.56.0' },
      { name: 'Yazıcı Sürücüsü [REDACTED]' },
      { name: 'Mesh Agent', version: '2026-02-16 03:43:44' },
    ]);
    expect(r.services).toEqual([{ name: 'Spooler', state: 'Running', startType: 'Automatic' }]);
    expect(r.disk).toEqual([{ mount: 'C:\\', freeBytes: 100, totalBytes: 200 }]);
    expect(r.logs).toEqual(['line 1']);
    expect(r.problems).toEqual([{ section: 'tools', message: 'no inventory' }]);
    expect(calls[0]?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0]).toContain('-EncodedCommand');
  });

  it('Linux: dpkg / systemctl / df parsing', async () => {
    const run: RunFn = (file) => {
      const out =
        file === '/usr/bin/dpkg-query'
          ? 'git\t1:2.43.0-1ubuntu7\nffmpeg\t7:6.1.1\n'
          : file === '/usr/bin/systemctl'
            ? 'remyral-worker.service loaded active running Remyral worker\nssh.service loaded inactive dead OpenSSH\n'
            : 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\ntmpfs 10 0 10 0% /run\n';
      return Promise.resolve({ exitCode: 0, stdout: out, stderr: '', timedOut: false });
    };
    const r = await inspectMachine(
      {
        platform: 'linux',
        run,
        env: {},
        cwd: '/tmp',
        redact: (s) => s,
        logs: () => Promise.resolve([]),
        tools: () => Promise.reject(new Error('x')),
      },
      ['software', 'services', 'disk'],
    );
    expect(r.software).toEqual([
      { name: 'git', version: '1:2.43.0-1ubuntu7' },
      { name: 'ffmpeg', version: '7:6.1.1' },
    ]);
    expect(r.services?.[0]).toEqual({ name: 'remyral-worker.service', state: 'active/running' });
    expect(r.disk).toEqual([{ mount: '/', freeBytes: 600 * 1024, totalBytes: 1000 * 1024 }]);
  });

  it('the PowerShell scripts are ASCII-only and use no case-insensitive operators', () => {
    for (const s of [PS_SOFTWARE, PS_SERVICES, PS_DISK]) {
      expect(/[^\t\n\r\x20-\x7e]/.test(s)).toBe(false);
      expect(/\s-(i?match|i?notmatch|i?replace|i?split|i?like|i?notlike|eq|ne)\s/i.test(s)).toBe(false);
    }
  });
});
