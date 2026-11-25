import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import type { CustomToolInstall, ToolInventoryEntry } from '@remyral/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFileOps } from '../src/fs/ops.js';
import { detectTools, insideDir } from '../src/tools/detect.js';
import { ToolInstaller, ToolRefusal } from '../src/tools/installer.js';
import { ToolInventory } from '../src/tools/inventory.js';
import { recipePlatform } from '../src/tools/recipes.js';
import { applyToolEnv, managedToolEnv } from '../src/tools/tool-env.js';
import { FakeSystem, ok } from './fake-system.js';
import { buildZip } from './zip-fixtures.js';

/**
 * p13-fleet-tools (ADR-0052): inventory source classification (system vs worker-managed), the effective install per
 * tool, admin-defined (custom) download installs and their PATH placement.
 */

const logger = createLogger({ sink: () => undefined });
const platform = recipePlatform(process.platform, process.arch);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rw-fleet-tools-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MANAGED_GIT = {
  tool: 'git' as const,
  version: '2.56.0.2',
  reportAs: 'git',
  installedAt: '2026-10-14T10:00:00.000Z',
  entry: '/data/tools/git/2.56.0.2/mingit/cmd/git',
  entrySha256: 'a'.repeat(64),
  dir: '/data/tools/git/2.56.0.2',
};

describe('source classification', () => {
  it('a PATH hit inside the worker tools dir is the managed install, not a system tool', async () => {
    const sys = new FakeSystem({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/data/tools/git/2.56.0.2/mingit/cmd:/usr/bin' },
      files: { '/data/tools/git/2.56.0.2/mingit/cmd/git': '', '/usr/bin/node': '' },
      exec: (file) =>
        file.endsWith('/git')
          ? ok('git version 2.56.0')
          : file.endsWith('/node')
            ? ok('v24.21.0')
            : undefined,
    });
    const tools = await detectTools({ sys }, [MANAGED_GIT], { toolsRoot: '/data/tools' });
    const git = tools.filter((t) => t.name === 'git');
    expect(git).toEqual([
      { name: 'git', found: false, source: 'system' },
      expect.objectContaining({ name: 'git', found: true, source: 'managed', version: '2.56.0.2' }),
    ]);
    expect(tools.find((t) => t.name === 'node')).toMatchObject({ found: true, source: 'system' });
  });

  it('matches Windows paths case-insensitively and only on whole directories', () => {
    expect(insideDir('C:\\ProgramData\\RW\\Tools\\git\\x.exe', 'c:/programdata/rw/tools', 'win32')).toBe(
      true,
    );
    expect(insideDir('/data/tools-other/git', '/data/tools', 'linux')).toBe(false);
    expect(insideDir('/data/tools/git', '/data/tools', 'linux')).toBe(true);
    expect(insideDir(undefined, '/data/tools', 'linux')).toBe(false);
  });

  it('reports custom installs as managed, with the version from their own check', async () => {
    const sys = new FakeSystem({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/usr/bin' },
      exec: (file, args) =>
        file.endsWith('/rg') && args[0] === '--version' ? ok('ripgrep 15.0.1\n') : undefined,
    });
    const tools = await detectTools({ sys }, [], {
      custom: [
        {
          name: 'ripgrep',
          version: '15.0.0',
          installedAt: '2026-10-20T10:00:00.000Z',
          entry: '/data/tools/custom/ripgrep/15.0.0/rg',
          entrySha256: 'b'.repeat(64),
          dir: '/data/tools/custom/ripgrep/15.0.0',
          checkArgs: ['--version'],
          sha256: 'c'.repeat(64),
        },
      ],
    });
    expect(tools.find((t) => t.name === 'ripgrep')).toMatchObject({
      found: true,
      source: 'managed',
      version: '15.0.1',
      details: { custom: true, recipe: 'custom:ripgrep@15.0.0' },
    });
    // The check ran the installed entry with the recipe's arguments, nothing else.
    expect(sys.execCalls.filter((c) => c.file.endsWith('/rg')).map((c) => c.args)).toEqual([['--version']]);
  });
});

describe('effective tool in the inventory report', () => {
  async function inventory(entries: ToolInventoryEntry[], gitBinary?: string): Promise<ToolInventory> {
    const installer = await ToolInstaller.open({
      ops: createNodeFileOps(),
      dataDir: dir,
      platform,
      logger,
      recipes: [],
    });
    return ToolInventory.open({
      ops: createNodeFileOps(),
      dataDir: dir,
      installer,
      detect: () => Promise.resolve(entries),
      logger,
      ...(gitBinary === undefined ? {} : { gitBinary: () => gitBinary }),
    });
  }

  it('git not found on the system + worker-managed 2.56 ⇒ the worker one is effective', async () => {
    const r = await (
      await inventory([
        { name: 'git', found: false, source: 'system' },
        { name: 'node', found: true, source: 'system', version: '24.21.0' },
        { name: 'git', found: true, source: 'managed', version: '2.56.0.2', path: '/d/git' },
        { name: 'python', found: true, source: 'managed', version: '3.13.16' },
      ])
    ).refresh();
    expect(r.effective).toEqual([
      { name: 'git', source: 'managed', version: '2.56.0.2', path: '/d/git' },
      { name: 'node', source: 'system', version: '24.21.0' },
      { name: 'python', source: 'managed', version: '3.13.16' },
    ]);
  });

  it('the configured gitBinary is what the worker uses', async () => {
    const r = await (
      await inventory(
        [
          { name: 'git', found: true, source: 'system', version: '2.40.0', path: '/opt/git/bin/git' },
          { name: 'git', found: true, source: 'managed', version: '2.56.0.2' },
        ],
        '/opt/git/bin/git',
      )
    ).refresh();
    expect(r.effective?.[0]).toEqual({
      name: 'git',
      source: 'config',
      path: '/opt/git/bin/git',
      version: '2.40.0',
    });
  });
});

describe('custom download installs', () => {
  const URL = 'https://github.com/example/tool/releases/download/1.2.3/tool.zip';

  function spec(zip: Buffer, over: Partial<CustomToolInstall['download']> = {}): CustomToolInstall {
    return {
      name: 'mytool',
      version: '1.2.3',
      download: {
        url: URL,
        sha256: createHash('sha256').update(zip).digest('hex'),
        size: zip.length,
        format: 'zip',
        strip: 'tool-1.2.3',
        entry: 'bin/mytool',
        ...over,
      },
      check: { args: ['--version'] },
    };
  }

  async function open(zip: Buffer, fetched: string[] = []): Promise<ToolInstaller> {
    return ToolInstaller.open({
      ops: createNodeFileOps(),
      dataDir: dir,
      platform,
      logger,
      recipes: [],
      reserveBytes: 0,
      source: {
        fetch: (url) => {
          fetched.push(url);
          return Promise.resolve(new Response(new Uint8Array(zip)));
        },
      },
    });
  }

  it('verifies the pinned checksum, extracts into tools/custom and survives a reopen', async () => {
    const zip = buildZip([{ name: 'tool-1.2.3/bin/mytool', data: '#!/bin/sh\necho 1.2.3\n', mode: 0o755 }]);
    const fetched: string[] = [];
    const t = await open(zip, fetched);
    const m = await t.installCustom(spec(zip));
    expect(fetched).toEqual([URL]);
    expect(m.entry).toBe(join(dir, 'tools', 'custom', 'mytool', '1.2.3', 'bin', 'mytool'));
    expect(await readFile(m.entry, 'utf8')).toContain('echo 1.2.3');
    expect((await t.installedCustom()).map((c) => c.name)).toEqual(['mytool']);
    // Release recipes are untouched by custom installs.
    expect(await t.installed()).toEqual([]);
    expect((await (await open(zip)).installedCustom()).length).toBe(1);
    await t.removeCustom('mytool', '1.2.3');
    expect(await t.installedCustom()).toEqual([]);
    await expect(t.removeCustom('mytool', '1.2.3')).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('refuses a download whose checksum does not match (nothing is installed)', async () => {
    const zip = buildZip([{ name: 'tool-1.2.3/bin/mytool', data: 'x', mode: 0o755 }]);
    const t = await open(zip);
    await expect(t.installCustom(spec(zip, { sha256: 'f'.repeat(64) }))).rejects.toMatchObject({
      reason: 'integrity_mismatch',
    });
    expect(await t.installedCustom()).toEqual([]);
  });

  it('re-checks the host allowlist and the entry path itself', async () => {
    const zip = buildZip([{ name: 'a', data: 'x' }]);
    const t = await open(zip);
    await expect(t.installCustom(spec(zip, { url: 'https://evil.example/tool.zip' }))).rejects.toMatchObject({
      reason: 'recipe_invalid',
    });
    await expect(t.installCustom(spec(zip, { entry: '../../outside' }))).rejects.toMatchObject({
      reason: 'recipe_invalid',
    });
  });

  it('a modified custom install is not reported', async () => {
    const zip = buildZip([{ name: 'tool-1.2.3/bin/mytool', data: 'x', mode: 0o755 }]);
    const t = await open(zip);
    const m = await t.installCustom(spec(zip));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(m.entry, 'tampered');
    const again = await open(zip);
    expect(await again.installedCustom()).toEqual([]);
  });
});

describe('PATH placement', () => {
  it('custom bin dirs go at the end of PATH, managed release tools in front', () => {
    const env = managedToolEnv([{ ...MANAGED_GIT }], 'linux', [
      {
        name: 'mytool',
        version: '1',
        installedAt: '',
        entry: '/data/tools/custom/mytool/1/bin/mytool',
        entrySha256: '',
        dir: '/data/tools/custom/mytool/1',
        checkArgs: [],
        sha256: '',
      },
    ]);
    expect(env.pathDirs).toEqual(['/data/tools/git/2.56.0.2/mingit/cmd']);
    expect(env.pathAppend).toEqual(['/data/tools/custom/mytool/1/bin']);
    const out = applyToolEnv({ PATH: '/usr/bin:/bin' }, env, 'linux');
    expect(out.PATH).toBe(
      '/data/tools/git/2.56.0.2/mingit/cmd:/usr/bin:/bin:/data/tools/custom/mytool/1/bin',
    );
    // Already on PATH: not added twice.
    expect(applyToolEnv({ PATH: '/data/tools/custom/mytool/1/bin' }, env, 'linux').PATH).toBe(
      '/data/tools/git/2.56.0.2/mingit/cmd:/data/tools/custom/mytool/1/bin',
    );
  });
});

describe('the owner opt-in gate (openTools)', () => {
  it('refuses a custom install unless machine administration is enabled and the local ceiling allows it', async () => {
    const { openTools } = await import('../src/tools/index.js');
    let why: string | null = 'machine administration is not enabled for this worker';
    const zip = buildZip([{ name: 'bin/t', data: 'x', mode: 0o755 }]);
    const wiring = await openTools({
      ops: createNodeFileOps(),
      dataDir: dir,
      logger,
      redactor: { redact: (s: string) => s },
      log: null,
      run: () => Promise.reject(new Error('not used')),
      env: {},
      detect: () => Promise.resolve([]),
      customAllowed: () => why,
      source: { fetch: () => Promise.resolve(new Response(new Uint8Array(zip))) },
    });
    const spec: CustomToolInstall = {
      name: 'mytool',
      version: '1.0.0',
      download: {
        url: 'https://github.com/x/y/releases/download/1/t.zip',
        sha256: createHash('sha256').update(zip).digest('hex'),
        size: zip.length,
        format: 'zip',
        entry: 'bin/t',
      },
      check: { args: [] },
    };
    const opts = { signal: new AbortController().signal, progress: () => undefined };
    const install = wiring.port.installCustom;
    if (install === undefined) throw new Error('no custom installs');
    await expect(install(spec, opts)).rejects.toMatchObject({ reason: 'custom_tools_not_allowed' });
    why = 'the local config forbids custom tools (localCeiling.allowCustomTools: false)';
    await expect(install(spec, opts)).rejects.toMatchObject({
      reason: 'custom_tools_not_allowed',
      message: expect.stringContaining('allowCustomTools') as unknown,
    });
    expect(await wiring.installer.installedCustom()).toEqual([]);
    // Allowed (owner enabled machine administration, no local veto): the checked download is installed.
    why = null;
    await expect(install(spec, opts)).resolves.toEqual({ version: '1.0.0' });
    expect((await wiring.installer.installedCustom()).map((c) => c.name)).toEqual(['mytool']);
  });
});
