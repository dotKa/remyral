import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallError } from '../src/remote-ops/fetch.js';
import { INSTALL_MANIFEST } from '../src/remote-ops/install-manifest.generated.js';
import { InstallRefusal, RuntimeInstaller } from '../src/remote-ops/installer.js';
import {
  compareVersions,
  decideTarget,
  hostPlatform,
  type InstallManifest,
  matchesPlatform,
  selectPackages,
} from '../src/remote-ops/manifest.js';
import { extractTgz, safeTarget, TarError } from '../src/remote-ops/tar.js';
import { captureLines, isWindows, nodeOps, tempDir } from './helpers.js';
import { codexFixture, codexManifest, fixtureServer, type Registry, tgz } from './remote-ops-fixtures.js';

const host = hostPlatform();
const servers: Registry[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(files: Record<string, Buffer | string>): Promise<Registry> {
  const s = await fixtureServer(files);
  servers.push(s);
  return s;
}

async function installer(
  manifest: InstallManifest,
  registry: string,
  extra: Partial<Parameters<typeof RuntimeInstaller.open>[0]> = {},
) {
  const dataDir = await tempDir('ro-');
  const log = captureLines();
  const i = await RuntimeInstaller.open({
    ops: nodeOps(),
    dataDir,
    manifest,
    host,
    nodePath: process.execPath,
    source: { npmRegistry: registry },
    logger: createLogger({ sink: log.sink }),
    minFreeBytes: 1,
    ...extra,
  });
  return { i, dataDir, log };
}

const progress = () => undefined;

describe('install set (bundled manifest)', () => {
  it('covers the four runtimes at their pins, npm sha512 only, registry tarballs only (ADR-0023)', () => {
    const rts = INSTALL_MANIFEST.runtimes;
    expect(Object.keys(rts).sort()).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
    expect(rts.codex?.pinned).toBe('0.164.0');
    for (const spec of Object.values(rts)) expect(spec.method).toBe('npm');
    for (const [rt, spec] of Object.entries(rts)) {
      const v = spec.versions[spec.pinned];
      expect(v, rt).toBeDefined();
      if (v !== undefined && 'npm' in v) {
        for (const p of v.npm.packages) {
          expect(p.integrity).toMatch(/^sha512-/);
          expect(p.resolved.startsWith('https://registry.npmjs.org/')).toBe(true);
        }
      }
    }
  });

  it('selects platform packages by os/cpu/libc (npm semantics, negation included)', () => {
    const base = { path: 'node_modules/x', name: 'x', version: '1.0.0', resolved: 'r', integrity: 'i' };
    const linux = { os: 'linux' as const, arch: 'x64', libc: 'glibc' as const };
    expect(matchesPlatform({ ...base, os: ['linux'], cpu: ['x64'] }, linux)).toBe(true);
    expect(matchesPlatform({ ...base, os: ['!linux'] }, linux)).toBe(false);
    expect(matchesPlatform({ ...base, libc: ['musl'] }, linux)).toBe(false);
    expect(matchesPlatform({ ...base, os: ['darwin'] }, linux)).toBe(false);
    // A required package for another platform makes the version unsupported here.
    expect(selectPackages([{ ...base, os: ['darwin'] }], linux).ok).toBe(false);
    expect(selectPackages([{ ...base, os: ['darwin'], optional: true }], linux)).toEqual({
      ok: true,
      packages: [],
    });
    // Every pinned npm runtime installs on the current host's platform set (no required foreign package).
    for (const rt of ['codex', 'pi', 'opencode', 'claude-code'] as const) {
      const spec = INSTALL_MANIFEST.runtimes[rt];
      const v = spec === undefined ? undefined : spec.versions[spec.pinned];
      if (v !== undefined && 'npm' in v) expect(selectPackages(v.npm.packages, host).ok, rt).toBe(true);
    }
  });

  it('version policy: pinned set only; below the active version only the previous pin', () => {
    const spec = codexManifest({ '1.0.0': [], '1.5.0': [], '2.0.0': [] }, '2.0.0', '1.5.0').runtimes.codex;
    if (spec === undefined) throw new Error('no spec');
    expect(decideTarget(spec, '2.0.0', null)).toEqual({ ok: true, action: 'install' });
    expect(decideTarget(spec, '2.0.0', '1.5.0')).toEqual({ ok: true, action: 'upgrade' });
    expect(decideTarget(spec, '2.0.0', '2.0.0')).toEqual({ ok: true, action: 'reinstall' });
    expect(decideTarget(spec, '1.5.0', '2.0.0')).toEqual({ ok: true, action: 'downgrade' });
    expect(decideTarget(spec, '1.0.0', '2.0.0')).toMatchObject({ ok: false, reason: 'downgrade_refused' });
    expect(decideTarget(spec, '3.0.0', '2.0.0')).toMatchObject({ ok: false, reason: 'version_not_pinned' });
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });
});

describe('tar extraction (defensive)', () => {
  it('strips package/, normalises modes, skips links and refuses traversal', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.tgz');
    await writeFile(
      file,
      tgz([
        { path: 'package/bin/tool', data: '#!/bin/sh\n', mode: 0o4777 },
        { path: 'package/lib/', type: '5' },
        { path: 'package/lib/x.js', data: 'x', mode: 0o666 },
        { path: 'package/evil-link', type: '2', linkname: '/etc/passwd' },
      ]),
    );
    const out = join(dir, 'out');
    const r = await extractTgz(file, out);
    expect(r).toMatchObject({ files: 2, skippedLinks: 1 });
    expect(existsSync(join(out, 'evil-link'))).toBe(false);
    if (!isWindows) {
      expect((await stat(join(out, 'bin/tool'))).mode & 0o7777).toBe(0o755);
      expect((await stat(join(out, 'lib/x.js'))).mode & 0o7777).toBe(0o644);
    }
    for (const bad of ['package/../../x', '/abs/x', 'package/a\\b', 'C:/x']) {
      expect(() => safeTarget(out, bad)).toThrow(TarError);
    }
    const trav = join(dir, 'b.tgz');
    await writeFile(trav, tgz([{ path: 'package/../../escape.txt', data: 'x' }]));
    await expect(extractTgz(trav, join(dir, 'out2'))).rejects.toThrow(TarError);
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
  });
});

describe.skipIf(isWindows)('npm runtime install from a local fixture registry', () => {
  it('installs at the pinned version, verifies every tarball, never fetches foreign platform packages', async () => {
    const fx = codexFixture('9.1.0', host);
    const reg = await serve(fx.files);
    const { i, dataDir } = await installer(codexManifest({ '9.1.0': fx.packages }, '9.1.0'), reg.base);
    const steps: string[] = [];
    const r = await i.install('codex', '9.1.0', { progress: (s) => steps.push(s) });
    expect(r).toEqual({ action: 'install', version: '9.1.0' });
    expect(steps).toContain('download');
    expect(steps).toContain('activate');
    expect(reg.requests.some((p) => p.includes(host.os === 'darwin' ? 'linux-x64' : 'darwin-arm64'))).toBe(
      false,
    );
    const launch = i.launch('codex');
    expect(launch?.version).toBe('9.1.0');
    expect(launch?.file.startsWith(join(dataDir, 'runtimes', 'codex', '9.1.0'))).toBe(true);
    expect(execFileSync(launch?.file ?? '', [], { encoding: 'utf8' }).trim()).toBe('codex-cli 9.1.0');
    const state = JSON.parse(await readFile(join(dataDir, 'runtimes', 'codex', 'state.json'), 'utf8')) as {
      active: string;
    };
    expect(state.active).toBe('9.1.0');
    expect((await stat(join(dataDir, 'runtimes', 'codex', 'state.json'))).mode & 0o777).toBe(0o600);
    const report = (await i.report()).find((x) => x.runtime === 'codex');
    expect(report).toMatchObject({
      method: 'npm',
      supported: true,
      pinned: '9.1.0',
      active: '9.1.0',
      installed: [expect.objectContaining({ version: '9.1.0', integrity: 'ok' })],
    });
    // No staging leftovers, no downloads kept.
    const entries = await readdir(join(dataDir, 'runtimes', 'codex'));
    expect(entries.sort()).toEqual(['9.1.0', 'state.json']);
  });

  it('refuses a tampered tarball (sha512 mismatch): nothing installed, nothing left behind', async () => {
    const fx = codexFixture('9.1.0', host);
    const reg = await serve(fx.files);
    const plat = `${host.os}-${host.arch}`;
    reg.set(
      `/@openai/codex/-/codex-9.1.0-${plat}.tgz`,
      tgz([{ path: `package/vendor/x/bin/codex`, data: '#!/bin/sh\necho pwned\n', mode: 0o755 }]),
    );
    const { i, dataDir } = await installer(codexManifest({ '9.1.0': fx.packages }, '9.1.0'), reg.base);
    const err = await i.install('codex', '9.1.0', { progress }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).reason).toBe('integrity_mismatch');
    expect(i.launch('codex')).toBeNull();
    expect(await readdir(join(dataDir, 'runtimes', 'codex')).catch(() => [])).toEqual([]);
  });

  it('refuses a wrong checksum in the install set', async () => {
    const fx = codexFixture('9.1.0', host);
    const reg = await serve(fx.files);
    const wrong = fx.packages.map((p, n) =>
      n === 0 ? { ...p, integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}` } : p,
    );
    const { i } = await installer(codexManifest({ '9.1.0': wrong }, '9.1.0'), reg.base);
    await expect(i.install('codex', '9.1.0', { progress })).rejects.toMatchObject({
      reason: 'integrity_mismatch',
    });
    expect(i.activeVersion('codex')).toBeNull();
  });

  it('upgrades, rolls back only to the previous pin, refuses other downgrades and unpinned versions', async () => {
    const a = codexFixture('9.0.0', host);
    const b = codexFixture('9.1.0', host);
    const c = codexFixture('8.0.0', host);
    const reg = await serve({ ...a.files, ...b.files, ...c.files });
    const manifest = codexManifest(
      { '8.0.0': c.packages, '9.0.0': a.packages, '9.1.0': b.packages },
      '9.1.0',
      '9.0.0',
    );
    const { i } = await installer(manifest, reg.base);
    await i.install('codex', '9.0.0', { progress });
    expect((await i.install('codex', '9.1.0', { progress })).action).toBe('upgrade');
    expect(i.launch('codex')?.version).toBe('9.1.0');
    // Rollback to the previous pin: allowed, and the old version stays installed for it.
    expect((await i.install('codex', '9.0.0', { progress })).action).toBe('downgrade');
    await i.install('codex', '9.1.0', { progress });
    const refused = await i.install('codex', '8.0.0', { progress }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InstallRefusal);
    expect((refused as InstallRefusal).reason).toBe('downgrade_refused');
    await expect(i.install('codex', '10.0.0', { progress })).rejects.toMatchObject({
      reason: 'version_not_pinned',
    });
    expect(i.launch('codex')?.version).toBe('9.1.0');
    const report = (await i.report()).find((x) => x.runtime === 'codex');
    expect(report?.installed.map((x) => x.version)).toEqual(['9.0.0', '9.1.0']);
    expect(report?.previous).toBe('9.0.0');
  });

  it('detects a modified install and stops using it; remove deletes it', async () => {
    const fx = codexFixture('9.1.0', host);
    const reg = await serve(fx.files);
    const { i, dataDir } = await installer(codexManifest({ '9.1.0': fx.packages }, '9.1.0'), reg.base);
    await i.install('codex', '9.1.0', { progress });
    const file = i.launch('codex')?.file ?? '';
    await writeFile(file, '#!/bin/sh\necho tampered\n');
    await i.verify('codex');
    expect(i.launch('codex')).toBeNull();
    expect((await i.report()).find((x) => x.runtime === 'codex')?.installed[0]?.integrity).toBe('modified');
    // Also on the next start.
    const again = await RuntimeInstaller.open({
      ops: nodeOps(),
      dataDir,
      manifest: codexManifest({ '9.1.0': fx.packages }, '9.1.0'),
      host,
      nodePath: process.execPath,
      logger: createLogger({ sink: () => undefined }),
    });
    expect(again.launch('codex')).toBeNull();
    await i.remove('codex', '9.1.0');
    expect(existsSync(join(dataDir, 'runtimes', 'codex', '9.1.0'))).toBe(false);
    await expect(i.remove('codex', '9.1.0')).rejects.toMatchObject({ reason: 'not_installed' });
  });

  it('a path traversal inside a correctly checksummed tarball fails the install', async () => {
    const fx = codexFixture('9.1.0', host, { tarEntries: [{ path: 'package/../../../escape', data: 'x' }] });
    const reg = await serve(fx.files);
    const { i, dataDir } = await installer(codexManifest({ '9.1.0': fx.packages }, '9.1.0'), reg.base);
    await expect(i.install('codex', '9.1.0', { progress })).rejects.toMatchObject({
      reason: 'extract_failed',
    });
    expect(existsSync(join(dataDir, 'escape'))).toBe(false);
    expect(await readdir(join(dataDir, 'runtimes', 'codex'))).toEqual([]);
  });

  it('removes leftovers of an interrupted install on the next start', async () => {
    const fx = codexFixture('9.1.0', host);
    const { dataDir } = await installer(
      codexManifest({ '9.1.0': fx.packages }, '9.1.0'),
      'http://127.0.0.1:9',
    );
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'runtimes', 'codex', '.staging-abc'), { recursive: true });
    await mkdir(join(dataDir, 'runtimes', 'codex', '9.1.0'), { recursive: true });
    await RuntimeInstaller.open({
      ops: nodeOps(),
      dataDir,
      manifest: codexManifest({ '9.1.0': fx.packages }, '9.1.0'),
      host,
      nodePath: process.execPath,
      logger: createLogger({ sink: () => undefined }),
    });
    expect(await readdir(join(dataDir, 'runtimes', 'codex'))).toEqual([]);
  });
});

/**
 * Opt-in online test (REMYRAL_ONLINE_TESTS=1): installs the real pinned Codex from registry.npmjs.org with the
 * bundled install set and runs `codex --version`.
 */
describe.skipIf(process.env.REMYRAL_ONLINE_TESTS !== '1')('online: real pinned runtime install', () => {
  it(
    'installs @openai/codex 0.164.0 from the npm registry and reports the pinned version',
    { timeout: 300_000 },
    async () => {
      const { i } = await installer(INSTALL_MANIFEST, 'https://registry.npmjs.org/');
      await i.install('codex', '0.164.0', { progress });
      const launch = i.launch('codex');
      expect(launch).not.toBeNull();
      const out = execFileSync(launch?.file ?? '', ['--version'], { encoding: 'utf8' });
      expect(out).toContain('0.164.0');
    },
  );
});
