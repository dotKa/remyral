import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { describe, expect, it } from 'vitest';
import {
  CODE_SERVER_PIN,
  IDE_SERVER_PINS,
  idePinFor,
  IdeServerInstaller,
  type IdeServerPin,
  ideServerPlatform,
  OPENVSCODE_SERVER_PIN,
} from '../src/ide/server.js';
import { tempDir } from './helpers.js';

/**
 * p19-ide W2: the pinned openvscode-server install — downloaded once, SHA-256 checked before anything touches it,
 * extracted with the worker's own extractor (top directory stripped), cached with a marker under `<dataDir>/ide/server`.
 * No network: the archive is a local fixture served by an injected fetch. The opt-in online test
 * (`REMYRAL_ONLINE_TESTS=1`) re-checks the real pinned archive of linux-x64.
 */

const logger = createLogger({ sink: () => undefined });
const describePosix = process.platform === 'win32' ? describe.skip : describe;

async function fixture(): Promise<{ archive: Buffer; sha256: string }> {
  const dir = await tempDir('rw-ide-srv-');
  const top = join(dir, 'openvscode-server-v9.9.9-linux-x64');
  await mkdir(join(top, 'bin'), { recursive: true });
  await mkdir(join(top, 'out'), { recursive: true });
  await writeFile(join(top, 'bin', 'openvscode-server'), '#!/bin/sh\necho server\n');
  await chmod(join(top, 'bin', 'openvscode-server'), 0o755);
  await writeFile(join(top, 'out', 'server-main.js'), '// main\n');
  execFileSync('tar', ['-czf', join(dir, 'a.tgz'), '-C', dir, 'openvscode-server-v9.9.9-linux-x64'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const archive = await readFile(join(dir, 'a.tgz'));
  return { archive, sha256: createHash('sha256').update(archive).digest('hex') };
}

const pinFor = (sha256: string, size: number): IdeServerPin => ({
  kind: 'openvscode-server',
  version: '9.9.9',
  commit: 'c'.repeat(40),
  platforms: { 'linux-x64': { url: 'https://example.invalid/server.tgz', sha256, size } },
});

describePosix('openvscode-server install (p19-ide W2)', () => {
  it('maps platforms and pins checksums for every Linux build', () => {
    expect(ideServerPlatform('linux', 'x64')).toBe('linux-x64');
    expect(ideServerPlatform('linux', 'arm64')).toBe('linux-arm64');
    expect(ideServerPlatform('linux', 'arm')).toBe('linux-armhf');
    // W2b: macOS and Windows x64 map to code-server builds; Windows on arm64 has none.
    expect(ideServerPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(ideServerPlatform('darwin', 'x64')).toBe('darwin-x64');
    expect(ideServerPlatform('win32', 'x64')).toBe('win32-x64');
    expect(ideServerPlatform('win32', 'arm64')).toBeNull();
    expect(ideServerPlatform('freebsd', 'x64')).toBeNull();
    expect(idePinFor('linux-arm64')?.kind).toBe('openvscode-server');
    expect(idePinFor('darwin-arm64')?.kind).toBe('code-server');
    expect(idePinFor('win32-x64')?.kind).toBe('code-server');
    // One build per platform across the pins of a release.
    const keys = IDE_SERVER_PINS.flatMap((p) => Object.keys(p.platforms));
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of Object.values(CODE_SERVER_PIN.platforms)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.url).toMatch(/^https:\/\/github\.com\/coder\/code-server\/releases\/download\/v4\.143\.1\//);
      expect(a.size).toBeGreaterThan(100_000_000);
    }
    for (const a of Object.values(OPENVSCODE_SERVER_PIN.platforms)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.url).toMatch(/^https:\/\/github\.com\/gitpod-io\/openvscode-server\/releases\/download\//);
      expect(a.url).toContain(OPENVSCODE_SERVER_PIN.version);
    }
  });

  it('downloads, verifies, extracts once and reuses the verified install', async () => {
    const { archive, sha256 } = await fixture();
    const data = await tempDir('rw-ide-data-');
    let fetches = 0;
    const installer = new IdeServerInstaller({
      dataDir: data,
      logger,
      pin: pinFor(sha256, archive.length),
      platform: 'linux',
      arch: 'x64',
      source: {
        fetch: () => {
          fetches++;
          return Promise.resolve(new Response(new Uint8Array(archive)));
        },
      },
    });
    expect(installer.unsupported()).toBeNull();
    const [a, b] = await Promise.all([installer.ensure(), installer.ensure()]);
    expect(a).toEqual(b);
    expect(fetches).toBe(1);
    expect(a.binary).toBe(join(data, 'ide', 'server', '9.9.9-linux-x64', 'bin', 'openvscode-server'));
    expect(((await stat(a.binary)).mode & 0o111) !== 0).toBe(true);
    expect(await readFile(join(a.dir, 'out', 'server-main.js'), 'utf8')).toBe('// main\n');
    await installer.ensure();
    expect(fetches).toBe(1);
    expect(await installer.installed()).toEqual(a);
  });

  it('refuses an archive whose checksum differs and installs nothing', async () => {
    const { archive } = await fixture();
    const data = await tempDir('rw-ide-data-');
    const installer = new IdeServerInstaller({
      dataDir: data,
      logger,
      pin: pinFor('0'.repeat(64), archive.length),
      platform: 'linux',
      arch: 'x64',
      source: { fetch: () => Promise.resolve(new Response(new Uint8Array(archive))) },
    });
    await expect(installer.ensure()).rejects.toMatchObject({ reason: 'integrity_mismatch' });
    expect(await installer.installed()).toBeNull();
  });

  it('says why a machine cannot run it', async () => {
    const winArm = new IdeServerInstaller({
      dataDir: '/nonexistent',
      logger,
      platform: 'win32',
      arch: 'arm64',
    });
    expect(winArm.unsupported()).toContain('windows-amd64 only');
    expect(winArm.kind).toBeNull();
    await expect(winArm.ensure()).rejects.toMatchObject({ reason: 'platform_unsupported' });
    const mac = new IdeServerInstaller({
      dataDir: '/nonexistent',
      logger,
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(mac.unsupported()).toBeNull();
    expect(mac.kind).toBe('code-server');
    expect(mac.version).toBe(CODE_SERVER_PIN.version);
  });

  it('installs a code-server build: layout checked, node as the launch binary, gallery off, ACL hook', async () => {
    const dir = await tempDir('rw-ide-cs-');
    const top = join(dir, 'code-server-9.9.9-windows-amd64');
    await mkdir(join(top, 'lib', 'vscode', 'out'), { recursive: true });
    await mkdir(join(top, 'out', 'node'), { recursive: true });
    await writeFile(join(top, 'lib', 'node.exe'), 'MZ');
    await writeFile(join(top, 'out', 'node', 'entry.js'), '// entry\n');
    await writeFile(join(top, 'lib', 'vscode', 'out', 'server-main.js'), '// main\n');
    await writeFile(
      join(top, 'lib', 'vscode', 'product.json'),
      JSON.stringify({ nameShort: 'code-server', extensionsGallery: { serviceUrl: 'https://open-vsx.org' } }),
    );
    execFileSync('tar', ['-czf', join(dir, 'cs.tgz'), '-C', dir, 'code-server-9.9.9-windows-amd64'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const archive = await readFile(join(dir, 'cs.tgz'));
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const data = await tempDir('rw-ide-data-');
    const granted: string[] = [];
    let pool = false;
    const installer = new IdeServerInstaller({
      dataDir: data,
      logger,
      pin: {
        kind: 'code-server',
        version: '9.9.9',
        commit: 'c'.repeat(40),
        platforms: { 'win32-x64': { url: 'https://example.invalid/cs.tgz', sha256, size: archive.length } },
      },
      platform: 'win32',
      arch: 'x64',
      source: { fetch: () => Promise.resolve(new Response(new Uint8Array(archive))) },
      grantRead: (d) => {
        granted.push(d);
        return Promise.resolve(pool);
      },
    });
    const a = await installer.ensure();
    expect(a.kind).toBe('code-server');
    expect(a.binary).toBe(join(data, 'ide', 'server', '9.9.9-win32-x64', 'lib', 'node.exe'));
    const product = JSON.parse(
      await readFile(join(a.dir, 'lib', 'vscode', 'product.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(product.extensionsGallery).toBeUndefined();
    expect(product.nameShort).toBe('code-server');
    // No per-job account pool yet: the grant is retried at the next start, then not again.
    pool = true;
    await installer.ensure();
    await installer.ensure();
    expect(granted).toEqual([a.dir, a.dir]);
  });

  it('refuses a code-server archive without its entry points', async () => {
    const { archive, sha256 } = await fixture();
    const data = await tempDir('rw-ide-data-');
    const installer = new IdeServerInstaller({
      dataDir: data,
      logger,
      pin: {
        kind: 'code-server',
        version: '9.9.9',
        commit: 'c'.repeat(40),
        platforms: {
          'darwin-arm64': { url: 'https://example.invalid/cs.tgz', sha256, size: archive.length },
        },
      },
      platform: 'darwin',
      arch: 'arm64',
      source: { fetch: () => Promise.resolve(new Response(new Uint8Array(archive))) },
    });
    await expect(installer.ensure()).rejects.toMatchObject({ reason: 'entry_missing' });
    expect(await installer.installed()).toBeNull();
  });
});

const online = process.env.REMYRAL_ONLINE_TESTS === '1' ? describe : describe.skip;
online('IDE server pins (online)', () => {
  const check = async (url: string, sha256: string, size: number): Promise<void> => {
    const res = await fetch(url, { redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(size);
    expect(createHash('sha256').update(buf).digest('hex')).toBe(sha256);
  };
  it('the pinned linux-x64 archive matches its checksum and size', async () => {
    const a = OPENVSCODE_SERVER_PIN.platforms['linux-x64'];
    if (a === undefined) throw new Error('no pin');
    await check(a.url, a.sha256, a.size);
  }, 600_000);
  it('every pinned code-server archive (macOS arm64 / x64, Windows x64) matches its checksum and size', async () => {
    for (const a of Object.values(CODE_SERVER_PIN.platforms)) await check(a.url, a.sha256, a.size);
  }, 1_800_000);
});
