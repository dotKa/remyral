import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIG, EXIT_CRASH, EXIT_OK, main } from '../src/cli.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { KEY_FILE } from '../src/identity/keystore.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { FakeSystem } from './fake-system.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

const sys = () => new FakeSystem({ platform: process.platform, env: {} });

describe('remyral-worker identity show', () => {
  it('generates the key on first use, then prints the same fingerprint; never the private key', async () => {
    const dir = await tempDir();
    const first = capture();
    expect(await main(['identity', 'show', '--data-dir', dir], sys(), first.io, { ops: nodeOps() })).toBe(
      EXIT_OK,
    );
    expect(first.err.join('')).toContain('generated a new device key');
    const fp = /Fingerprint: (SHA256:[0-9A-F-]+)/.exec(first.out.join(''))?.[1];
    expect(fp).toBeDefined();

    const second = capture();
    expect(
      await main(['identity', 'show', '--data-dir', dir, '--json'], sys(), second.io, { ops: nodeOps() }),
    ).toBe(EXIT_OK);
    expect(second.err).toEqual([]);
    const json = JSON.parse(second.out.join('')) as Record<string, unknown>;
    expect(json).toMatchObject({ fingerprint: fp, keystore: 'file' });
    const keyFile = JSON.parse(await readFile(join(dir, KEY_FILE), 'utf8')) as { privateKeyPkcs8: string };
    for (const text of [...first.out, ...first.err, ...second.out]) {
      expect(text).not.toContain(keyFile.privateKeyPkcs8);
    }
  });

  it('uses the config dataDir and maps config problems to exit 78', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ masterUrl: 'ws://evil.example/v1', workspaceRoot: join(dir, 'w') }),
    );
    const c = capture();
    expect(
      await main(['identity', 'show', '--config', path], sys(), c.io, {
        ops: nodeOps(),
        pathHost: pathHost(),
      }),
    ).toBe(EXIT_CONFIG);
    expect(c.err.join('')).toContain('masterUrl');
  });

  it('rejects options that belong to another command', async () => {
    const c = capture();
    expect(await main(['identity', 'show', '--self-test'], sys(), c.io)).toBe(EXIT_CRASH);
    expect(c.err.join('')).toContain('--self-test');
    expect(await main(['identity'], sys(), capture().io)).toBe(EXIT_CRASH);
    expect(await main(['run', '--json'], sys(), capture().io)).toBe(EXIT_CRASH);
  });
});

describe('remyral-worker run', () => {
  it('runs until a shutdown signal and exits 0', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: join(dir, 'w'),
        dataDir: join(dir, 'd'),
      }),
      { mode: 0o600 },
    );
    const signals = new ManualSignals();
    const transport = new MemoryTransport();
    const lines: string[] = [];
    const exit = main(['run', '--config', path], sys(), capture().io, {
      ops: nodeOps(),
      pathHost: pathHost(),
      signals,
      transport,
      logSink: (l) => lines.push(l),
    });
    await vi.waitFor(() => {
      expect(transport.started).toBe(true);
    });
    signals.trigger('SIGINT');
    expect(await exit).toBe(EXIT_OK);
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toContain('worker daemon stopped');
  });

  it('exits 78 when no config exists', async () => {
    const dir = await tempDir();
    const c = capture();
    const host = pathHost({ platform: 'linux', env: (n) => (n === 'XDG_CONFIG_HOME' ? dir : undefined) });
    expect(await main(['run'], sys(), c.io, { ops: nodeOps(), pathHost: host })).toBe(EXIT_CONFIG);
    expect(c.err.join('')).toContain('no config file found');
  });
});
