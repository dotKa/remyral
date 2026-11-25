import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { httpsDownloader, masterOrigin } from '../src/update/download.js';
import { loadUpdaterConfig } from '../src/update/helper/config.js';
import { updaterMain } from '../src/update/helper/main.js';
import { trustedReleaseKeys } from '../src/update/keys.js';
import { defaultInstallDir } from '../src/update/layout.js';
import { createNodeSystem } from '../src/system/node.js';
import { isWindows, nodeOps, opsWithStats, pathHost, tempDir } from './helpers.js';
import { releaseKey, signedRelease } from './release-fixtures.js';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

describe('release keys', () => {
  it('config keys replace the compiled-in keys (rotation can retire a key)', () => {
    const a = releaseKey().publicKey;
    const b = releaseKey().publicKey;
    expect(trustedReleaseKeys(undefined, [a])).toEqual([a]);
    expect(trustedReleaseKeys([b], [a])).toEqual([b]);
    expect(trustedReleaseKeys([], [a])).toEqual([a]);
  });

  it('install dirs match the service installers', () => {
    expect(defaultInstallDir('linux', () => undefined)).toBe('/opt/remyral-worker');
    expect(defaultInstallDir('darwin', () => undefined)).toBe(
      '/Library/Application Support/RemyralWorker/bin',
    );
    expect(defaultInstallDir('win32', (n) => (n === 'ProgramFiles' ? 'D:\\Programs' : undefined))).toBe(
      'D:\\Programs\\RemyralWorker',
    );
  });
});

describe('release downloader', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === null) resolve();
      else
        server.close(() => {
          resolve();
        });
    });
    server = null;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const s = createServer(handler);
    server = s;
    await new Promise<void>((resolve) => {
      s.listen(0, '127.0.0.1', resolve);
    });
    return `ws://127.0.0.1:${String((s.address() as AddressInfo).port)}/v1/worker`;
  }

  it('derives the HTTPS origin from the WebSocket URL', () => {
    expect(masterOrigin('wss://m.example.com:8443/v1/worker').href).toBe('https://m.example.com:8443/');
    expect(masterOrigin('ws://127.0.0.1:9/v1/worker').href).toBe('http://127.0.0.1:9/');
  });

  it('sends the bearer token, follows no redirect and enforces the size cap', async () => {
    const seen: (string | undefined)[] = [];
    const url = await serve((req, res) => {
      seen.push(req.headers.authorization);
      if (req.url?.endsWith('/redirect/artifact')) {
        res.writeHead(302, { location: 'http://evil.example/x' }).end();
      } else if (req.url?.endsWith('/big/artifact')) {
        res.writeHead(200).end(Buffer.alloc(2048));
      } else {
        res.writeHead(200).end('payload');
      }
    });
    const dl = httpsDownloader({ masterUrl: url, workerVersion: '1.0.0' });
    expect((await dl('/v1/worker/releases/1.0.0/artifact', 'tok', 100)).toString()).toBe('payload');
    expect(seen[0]).toBe('Bearer tok');
    await expect(dl('/v1/worker/releases/redirect/artifact', 'tok', 100)).rejects.toMatchObject({
      reason: 'http_status',
      status: 302,
    });
    await expect(dl('/v1/worker/releases/big/artifact', 'tok', 100)).rejects.toMatchObject({
      reason: 'too_large',
    });
    await expect(dl('/elsewhere', 'tok', 100)).rejects.toMatchObject({ reason: 'bad_url' });
  });
});

describe('updater config (privileged reader)', () => {
  it.skipIf(isWindows)('requires a root-owned, non-writable config and creates nothing', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: join(dir, 'ws'),
        dataDir: join(dir, 'data'),
        updates: { channel: 'canary', healthTimeoutSec: 30 },
      }),
      { mode: 0o640 },
    );
    const host = pathHost({ platform: process.platform });
    await expect(loadUpdaterConfig(nodeOps(), host, path)).rejects.toThrow(/must be owned by root/);
    const uid = process.getuid?.() ?? 0;
    const cfg = await loadUpdaterConfig(nodeOps(), host, path, { ownerUid: uid });
    expect(cfg).toMatchObject({
      dataDir: join(dir, 'data'),
      settings: { channel: 'canary', healthTimeoutSec: 30 },
    });
    await expect(readFile(join(dir, 'data'))).rejects.toThrow(); // not created
    const writable = opsWithStats({ [path]: { mode: 0o666 } });
    await expect(loadUpdaterConfig(writable, host, path, { ownerUid: uid })).rejects.toThrow(
      /group\/world-writable/,
    );
  });
});

describe('remyral-worker-updater CLI', () => {
  it('info, verify and adopt with the configured keys', async () => {
    const dir = await tempDir();
    const key = releaseKey();
    const r = signedRelease(key, '1.3.0');
    await writeFile(join(dir, 'remyral-worker.mjs'), r.artifact);
    await writeFile(join(dir, 'manifest.json'), r.manifest);
    await writeFile(join(dir, 'manifest.sig.json'), JSON.stringify(r.signature));
    const cfgPath = join(dir, 'config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: join(dir, 'ws'),
        dataDir: join(dir, 'data'),
        updates: { releaseKeys: [key.publicKey], installDir: join(dir, 'opt') },
      }),
    );
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
    const host = {
      sys: createNodeSystem(),
      pathHost: pathHost(),
      configOwnerUid: process.getuid?.() ?? 0,
      logSink: () => undefined,
    };
    const files = ['--bundle', join(dir, 'remyral-worker.mjs'), '--manifest', join(dir, 'manifest.json')];
    const sig = ['--signature', join(dir, 'manifest.sig.json'), '--config', cfgPath];
    expect(await updaterMain(['info'], host, io)).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ protocolVersions: ['1.0'], minNode: '24.11.0' });
    expect(await updaterMain(['verify', ...files, ...sig], host, io)).toBe(0);
    expect(out.at(-1)).toMatch(/verified: remyral-worker 1.3.0/);
    expect(await updaterMain(['adopt', ...files, ...sig], host, io)).toBe(0);
    expect(await readFile(join(dir, 'opt', 'remyral-worker.mjs'))).toEqual(r.artifact);
    expect(await updaterMain(['status', '--json', '--config', cfgPath], host, io)).toBe(0);
    expect(JSON.parse(out.at(-1) ?? '{}')).toMatchObject({ active: { version: '1.3.0' } });
    // p6-worker-boot-diagnostics: `apply` keeps its own log in <installDir>/state/updater.log (0644: the service
    // account reads it for remote `logs.tail` source updater); status/info/verify do not write it.
    await expect(readFile(join(dir, 'opt', 'state', 'updater.log'))).rejects.toThrow();
    const { mkdir: mk } = await import('node:fs/promises');
    await mk(join(dir, 'data', 'updates'), { recursive: true });
    await writeFile(
      join(dir, 'data', 'updates', 'request.json'),
      JSON.stringify({
        schema: 1,
        attemptId: '7d0c4c1e-3c55-4c1e-9d6a-1f4f3b8a2b10',
        version: '1.4.0',
        rollback: false,
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(await updaterMain(['apply', '--config', cfgPath], host, io)).toBe(1);
    const updaterLog = await readFile(join(dir, 'opt', 'state', 'updater.log'), 'utf8');
    expect(updaterLog).toContain('"msg":"update attempt finished"');
    expect(updaterLog).toContain('"reason":"not_staged"');
    if (!isWindows) {
      const { stat: st } = await import('node:fs/promises');
      expect((await st(join(dir, 'opt', 'state', 'updater.log'))).mode & 0o777).toBe(0o644);
    }
    // Another key's signature is refused (exit 1), unknown commands are usage errors (exit 2).
    const forged = signedRelease(releaseKey(), '1.4.0');
    await writeFile(join(dir, 'manifest.json'), forged.manifest);
    await writeFile(join(dir, 'manifest.sig.json'), JSON.stringify(forged.signature));
    await writeFile(join(dir, 'remyral-worker.mjs'), forged.artifact);
    expect(await updaterMain(['adopt', ...files, ...sig], host, io)).toBe(1);
    expect(err.join('')).toMatch(/refused \(unknown_key\)/);
    expect(await updaterMain(['frobnicate'], host, io)).toBe(2);
    // Security fix: admin-bind records the enrolled worker id in the root-owned install state (installer mode first).
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      features: expect.arrayContaining(['remyral-admin-binding/v1']) as string[],
    });
    expect(await updaterMain(['admin-bind', '--if-unbound', '--config', cfgPath], host, io)).toBe(0);
    expect(out.at(-1)).toMatch(/not enrolled yet/);
    await writeFile(
      join(dir, 'data', 'state.json'),
      JSON.stringify({
        version: 1,
        identity: { workerId: 'wrk_cli', publicKey: 'B'.repeat(43), enrolledAt: '2026-10-12T00:00:00.000Z' },
        leases: [],
        cursors: { lastMasterSeq: 0, ackedOutboundSeq: 0 },
      }),
    );
    expect(await updaterMain(['admin-bind', '--worker-id', 'wrk_other', '--config', cfgPath], host, io)).toBe(
      1,
    );
    expect(await updaterMain(['admin-bind', '--if-unbound', '--config', cfgPath], host, io)).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'opt', 'state', 'admin-binding.json'), 'utf8'))).toMatchObject(
      {
        v: 1,
        workerId: 'wrk_cli',
        source: 'installer',
      },
    );
  });
});

describe('scripts/release/sign.mjs', () => {
  it('keygen → sign → verify; a modified artifact or manifest fails verification', async () => {
    const dir = await tempDir();
    const script = join(REPO, 'scripts/release/sign.mjs');
    await run(process.execPath, [script, 'keygen', '--out', join(dir, 'keys')]);
    const pub = (await readFile(join(dir, 'keys', 'release-key.pub'), 'utf8')).trim();
    await expect(run(process.execPath, [script, 'keygen', '--out', join(dir, 'keys')])).rejects.toThrow(
      /refusing to overwrite/,
    );
    await writeFile(join(dir, 'artifact.mjs'), 'console.log(1)\n');
    await run(process.execPath, [
      script,
      'sign',
      '--artifact',
      join(dir, 'artifact.mjs'),
      '--version',
      '2.0.0',
      '--channel',
      'canary',
      '--key',
      join(dir, 'keys', 'release-key.pem'),
      '--out',
      join(dir, 'rel'),
    ]);
    const ok = await run(process.execPath, [
      script,
      'verify',
      '--dir',
      join(dir, 'rel'),
      '--public-key',
      pub,
    ]);
    expect(ok.stdout).toMatch(/OK remyral-worker 2.0.0 \(canary\)/);
    const upload = JSON.parse(await readFile(join(dir, 'rel', 'release.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(upload).sort()).toEqual(['artifact', 'manifest', 'signature']);

    await writeFile(join(dir, 'rel', 'remyral-worker.mjs'), 'console.log(2)\n');
    await expect(
      run(process.execPath, [script, 'verify', '--dir', join(dir, 'rel'), '--public-key', pub]),
    ).rejects.toThrow(/does not match/);
    const manifest = await readFile(join(dir, 'rel', 'manifest.json'), 'utf8');
    await writeFile(join(dir, 'rel', 'manifest.json'), manifest.replace('canary', 'stable'));
    await expect(
      run(process.execPath, [script, 'verify', '--dir', join(dir, 'rel'), '--public-key', pub]),
    ).rejects.toThrow(/BAD signature/);
  });

  it.skipIf(isWindows)('refuses a release key file that others can read', async () => {
    const dir = await tempDir();
    const script = join(REPO, 'scripts/release/sign.mjs');
    await run(process.execPath, [script, 'keygen', '--out', dir]);
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, 'release-key.pem'), 0o644);
    await writeFile(join(dir, 'a.mjs'), 'x');
    await expect(
      run(process.execPath, [
        script,
        'sign',
        '--artifact',
        join(dir, 'a.mjs'),
        '--version',
        '1.0.0',
        '--key',
        join(dir, 'release-key.pem'),
        '--out',
        join(dir, 'o'),
      ]),
    ).rejects.toThrow(/readable by group\/others/);
  });
});
