import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { createLogger } from '@remyral/observability';
import type { IdeExtensionRef } from '@remyral/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdeBridgeServer } from '../src/ide/bridge.js';
import { BRIDGE_EXTENSION_VERSION, bridgeExtensionFiles } from '../src/ide/bridge-extension.js';
import {
  extensionFolder,
  IdeExtensionCache,
  installExtensions,
  machineSettings,
} from '../src/ide/extensions.js';
import { disableGallery } from '../src/ide/server.js';
import { httpsDownloader } from '../src/update/download.js';
import { buildZip } from './zip-fixtures.js';

/**
 * p19-ide W3 on the worker: the offline VSIX cache (SHA-256 checked on download and on use, LRU cap that never evicts
 * the start's blobs), the install into a workspace's extensions dir (package identity checked, stale folders removed),
 * the machine settings (`extensions.allowed`), the product.json gallery switch-off, the bridge's settings endpoints,
 * the bridge extension v2's code (it compiles), and the downloader's path allowlist.
 */

const logger = createLogger({ sink: () => undefined });
const require = createRequire(import.meta.url);
let dir = '';

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'rw-ide-ext-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pkg = (id: string, version: string): Buffer => {
  const [publisher, name] = id.split('.');
  return buildZip([
    { name: 'extension.vsixmanifest', data: '<x/>' },
    { name: 'extension/package.json', data: JSON.stringify({ publisher, name, version }) },
    { name: 'extension/README.md', data: 'hi' },
  ]);
};
const ref = (
  id: string,
  version: string,
  bytes: Buffer,
  target: IdeExtensionRef['targetPlatform'] = 'universal',
): IdeExtensionRef => ({
  id,
  version,
  targetPlatform: target,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
});

describe('IDE extension cache and install', () => {
  it('downloads once, re-checks the cached file, and installs only matching packages', async () => {
    const cache = new IdeExtensionCache({ dataDir: dir, logger });
    const good = pkg('acme.tool', '1.0.0');
    const liar = pkg('acme.other', '9.9.9');
    const arm = pkg('acme.native', '2.0.0');
    const refs = [
      ref('acme.tool', '1.0.0', good),
      ref('acme.lies', '1.0.0', liar),
      ref('acme.native', '2.0.0', arm, 'linux-arm64'),
    ];
    const bytes = new Map(refs.map((r, i) => [r.sha256, [good, liar, arm][i] ?? Buffer.alloc(0)]));
    let calls = 0;
    const download = (r: IdeExtensionRef): Promise<Buffer> => {
      calls += 1;
      return Promise.resolve(bytes.get(r.sha256) ?? Buffer.alloc(0));
    };
    const ext = join(dir, 'ext');
    await mkdir(join(ext, 'stale.ext-0.1.0'), { recursive: true });
    await mkdir(join(ext, 'remyral.ide-bridge-2.0.0'), { recursive: true });
    const res = await installExtensions({
      extDir: ext,
      refs,
      cache,
      download,
      keepFolders: ['remyral.ide-bridge-2.0.0'],
      now: new Date(),
      logger,
    });
    expect(res.installed).toEqual(['acme.tool', 'acme.native']);
    expect(res.failed).toEqual([
      { id: 'acme.lies', reason: 'the package is acme.other@9.9.9, not acme.lies@1.0.0' },
    ]);
    expect(res.entries.map((e) => e.relativeLocation)).toEqual([
      'acme.tool-1.0.0',
      'acme.native-2.0.0-linux-arm64',
    ]);
    expect(extensionFolder(refs[2] as IdeExtensionRef)).toBe('acme.native-2.0.0-linux-arm64');
    await expect(stat(join(ext, 'stale.ext-0.1.0'))).rejects.toThrow();
    expect((await stat(join(ext, 'remyral.ide-bridge-2.0.0'))).isDirectory()).toBe(true);
    await expect(stat(join(ext, 'acme.lies-1.0.0'))).rejects.toThrow();
    expect(calls).toBe(3);
    // Unchanged folders stay; a cached file that changed on disk is fetched again.
    await writeFile(join(cache.dir, `${refs[0]?.sha256 ?? ''}.vsix`), 'tampered');
    await rm(join(ext, 'acme.tool-1.0.0'), { recursive: true });
    const again = await installExtensions({
      extDir: ext,
      refs: refs.slice(0, 1),
      cache,
      download,
      keepFolders: [],
      now: new Date(),
      logger,
    });
    expect(again.installed).toEqual(['acme.tool']);
    expect(calls).toBe(4);
    await expect(stat(join(ext, 'acme.native-2.0.0-linux-arm64'))).rejects.toThrow();
  });

  it('refuses a download with another hash; evicts least recently used files above the cap but never kept ones', async () => {
    const cache = new IdeExtensionCache({ dataDir: dir, logger, capBytes: 1 });
    const a = pkg('acme.a', '1.0.0');
    const b = pkg('acme.b', '1.0.0');
    const ra = ref('acme.a', '1.0.0', a);
    const rb = ref('acme.b', '1.0.0', b);
    await expect(cache.get(ra, () => Promise.resolve(b))).rejects.toThrow(/another (size|SHA-256)/);
    await cache.get(ra, () => Promise.resolve(a));
    await cache.get(rb, () => Promise.resolve(b));
    const old = new Date(Date.now() - 60_000);
    await utimes(join(cache.dir, `${ra.sha256}.vsix`), old, old);
    await writeFile(join(cache.dir, `.tmp-${randomUUID().slice(0, 8)}`), 'x');
    expect(await cache.prune(new Set([rb.sha256]))).toBe(a.length);
    await expect(stat(join(cache.dir, `${ra.sha256}.vsix`))).rejects.toThrow();
    expect((await stat(join(cache.dir, `${rb.sha256}.vsix`))).size).toBe(b.length);
  });

  it('writes extensions.allowed with only the installed set; the worker keys win', () => {
    const s = machineSettings({
      allowed: ['acme.tool'],
      enforced: { 'telemetry.telemetryLevel': 'all', 'editor.tabSize': 2 },
      bridgeId: 'remyral.ide-bridge',
    });
    expect(s['extensions.allowed']).toEqual({ '*': false, 'remyral.ide-bridge': true, 'acme.tool': true });
    expect(s['telemetry.telemetryLevel']).toBe('off');
    expect(s['editor.tabSize']).toBe(2);
  });

  it('switches off the pinned server’s own gallery (idempotent)', async () => {
    await writeFile(
      join(dir, 'product.json'),
      JSON.stringify({
        nameShort: 'x',
        extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' },
      }),
    );
    expect(await disableGallery(dir)).toBe(true);
    const product = JSON.parse(await readFile(join(dir, 'product.json'), 'utf8')) as Record<string, unknown>;
    expect(product).toEqual({ nameShort: 'x' });
    expect(await disableGallery(dir)).toBe(true);
    expect(await disableGallery(join(dir, 'missing'))).toBe(false);
  });
});

describe('bridge v2', () => {
  it('ships compiling extension code that syncs vscode-userdata settings', () => {
    const files = bridgeExtensionFiles();
    const js = files['extension.js'] ?? '';
    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain("scheme: 'vscode-userdata'");
    expect(js).not.toContain('bir sonraki sürümde');
    expect(JSON.parse(files['package.json'] ?? '{}')).toMatchObject({ version: BRIDGE_EXTENSION_VERSION });
    expect(BRIDGE_EXTENSION_VERSION).toBe('2.0.0');
  });

  it('serves the synced settings and saves one file (≤ 256 KiB) through the handler', async () => {
    const saved: { file: string; content: string }[] = [];
    const refused = { status: 'refused' as const, message: '' };
    const bridge = new IdeBridgeServer(
      {
        reference: () => Promise.resolve(refused),
        push: () => Promise.resolve(refused),
        terminal: () => Promise.resolve(refused),
        settings: () => Promise.resolve({ sync: true, settings: '{"a":1}', keybindings: null }),
        saveSettings: (_id, r) => {
          saved.push(r);
          return Promise.resolve({ status: 'ok', message: 'Ayarlar kaydedildi.' });
        },
      },
      logger,
    );
    await bridge.start();
    try {
      const id = randomUUID();
      const { url, token } = bridge.register(id);
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const got = await fetch(`${url}/settings`, { headers });
      expect(await got.json()).toEqual({ sync: true, settings: '{"a":1}', keybindings: null });
      const post = await fetch(`${url}/settings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file: 'keybindings', content: '[]' }),
      });
      expect(await post.json()).toEqual({ status: 'ok', message: 'Ayarlar kaydedildi.' });
      expect(saved).toEqual([{ file: 'keybindings', content: '[]' }]);
      const big = await fetch(`${url}/settings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file: 'settings', content: 'x'.repeat(256 * 1024 + 1) }),
      });
      expect(big.status).toBe(400);
      const bad = await fetch(`${url}/settings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file: 'tasks', content: '{}' }),
      });
      expect(bad.status).toBe(400);
      expect((await fetch(`${url}/settings`)).status).toBe(401);
      expect((await fetch(`${url}/push`, { headers })).status).toBe(404);
    } finally {
      await bridge.close();
    }
  });
});

describe('bridge v2 settings sync (extension code against a fake vscode API and the real bridge)', () => {
  it('writes the stored settings into the user data at start and saves a local change back', async () => {
    const store = new Map<string, string>([['/User/keybindings.json', '[]']]);
    const saved: { file: string; content: string }[] = [];
    const refused = { status: 'refused' as const, message: '' };
    const bridge = new IdeBridgeServer(
      {
        reference: () => Promise.resolve(refused),
        push: () => Promise.resolve(refused),
        terminal: () => Promise.resolve(refused),
        settings: () =>
          Promise.resolve({ sync: true, settings: '{"editor.fontSize": 15}', keybindings: null }),
        saveSettings: (_id, r) => {
          saved.push(r);
          return Promise.resolve(
            r.content.includes('ghp_')
              ? { status: 'refused' as const, message: 'Ayarlar kaydedilmedi: gizli bilgi.' }
              : { status: 'ok' as const, message: 'ok' },
          );
        },
      },
      logger,
    );
    await bridge.start();
    const id = randomUUID();
    const { url, token } = bridge.register(id);
    const commands = new Map<string, () => unknown>();
    const warnings: string[] = [];
    const subs: { dispose?: () => void }[] = [];
    const vscode = {
      Uri: { from: (u: { scheme: string; path: string }) => u, parse: (x: string) => x },
      StatusBarAlignment: { Left: 1 },
      ProgressLocation: { Notification: 15 },
      ConfigurationTarget: { Global: 1 },
      window: {
        createStatusBarItem: () => ({ show: () => undefined, dispose: () => undefined }),
        showInformationMessage: () => Promise.resolve(undefined),
        showWarningMessage: (m: string) => {
          warnings.push(m);
          return Promise.resolve(undefined);
        },
        onDidOpenTerminal: () => ({ dispose: () => undefined }),
        terminals: [],
      },
      workspace: {
        fs: {
          readFile: (u: { path: string }) => {
            const v = store.get(u.path);
            return v === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(Buffer.from(v));
          },
          writeFile: (u: { path: string }, b: Uint8Array) => {
            store.set(u.path, Buffer.from(b).toString('utf8'));
            return Promise.resolve();
          },
        },
        onDidChangeConfiguration: () => ({ dispose: () => undefined }),
        getConfiguration: () => ({ update: () => Promise.resolve() }),
      },
      commands: {
        registerCommand: (name: string, fn: () => unknown) => {
          commands.set(name, fn);
          return { dispose: () => undefined };
        },
      },
      env: { openExternal: () => undefined },
    };
    const env = process.env;
    const before = { ...env };
    env.REMYRAL_IDE_BRIDGE_URL = url;
    env.REMYRAL_IDE_BRIDGE_TOKEN = token;
    try {
      const mod = { exports: {} as { activate?: (c: unknown) => void; deactivate?: () => void } };
      const req = (name: string): unknown => (name === 'vscode' ? vscode : (require(name) as unknown));
      const run = new Script(
        `(function (require, module, exports) {${bridgeExtensionFiles()['extension.js'] ?? ''}\n})`,
      ).runInThisContext() as (r: unknown, m: unknown, e: unknown) => void;
      run(req, mod, mod.exports);
      mod.exports.activate?.({ subscriptions: subs });
      const deadline = Date.now() + 5_000;
      while (store.get('/User/settings.json') === undefined && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      expect(store.get('/User/settings.json')).toBe('{"editor.fontSize": 15}');
      // A local change is saved back (the command runs the same push as the timer).
      store.set('/User/settings.json', '{"editor.fontSize": 16}');
      await commands.get('remyral.syncSettings')?.();
      const end = Date.now() + 5_000;
      while (saved.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      // keybindings.json was not stored on the master: its local content is the baseline, not a change.
      expect(saved).toEqual([{ file: 'settings', content: '{"editor.fontSize": 16}' }]);
      store.set('/User/settings.json', '{"x.token": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}');
      await commands.get('remyral.syncSettings')?.();
      const end2 = Date.now() + 5_000;
      while (warnings.length === 0 && Date.now() < end2) await new Promise((r) => setTimeout(r, 20));
      expect(warnings).toEqual(['Ayarlar kaydedilmedi: gizli bilgi.']);
    } finally {
      for (const sub of subs) sub.dispose?.();
      for (const k of ['REMYRAL_IDE_BRIDGE_URL', 'REMYRAL_IDE_BRIDGE_TOKEN']) {
        if (before[k] === undefined) Reflect.deleteProperty(env, k);
        else env[k] = before[k];
      }
      await bridge.close();
    }
  });
});

describe('downloader path allowlist', () => {
  it('refuses paths outside the configured prefixes', async () => {
    const d = httpsDownloader({
      masterUrl: 'wss://master.example/v1/worker',
      workerVersion: '0.0.0',
      pathPrefixes: ['/v1/worker/ide/'],
    });
    await expect(d('/v1/worker/releases/1.0.0/artifact', 'x', 10)).rejects.toMatchObject({
      reason: 'bad_url',
    });
    await expect(d('/v1/worker/ide/../releases/x', 'x', 10)).rejects.toMatchObject({ reason: 'bad_url' });
  });
});
