import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, main } from '../src/cli.js';
import { secretCommand } from '../src/secrets/cli.js';
import { VAULT_KEY_FILE } from '../src/vault/index.js';
import { FakeSystem } from './fake-system.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

const sys = () => new FakeSystem({ platform: process.platform, env: {} });

describe('remyral-worker vault key', () => {
  it('generates the vault key on first use and prints the same key id/fingerprint; never the private key', async () => {
    const dir = await tempDir();
    const first = capture();
    expect(await main(['vault', 'key', '--data-dir', dir], sys(), first.io, { ops: nodeOps() })).toBe(
      EXIT_OK,
    );
    expect(first.err.join('')).toContain('generated a new vault key');
    const fp = /Fingerprint: {2}(X25519:[0-9A-F-]+)/.exec(first.out.join(''))?.[1];
    expect(fp).toBeDefined();
    const second = capture();
    expect(
      await main(['vault', 'key', '--data-dir', dir, '--json'], sys(), second.io, { ops: nodeOps() }),
    ).toBe(EXIT_OK);
    const json = JSON.parse(second.out.join('')) as Record<string, unknown>;
    expect(json).toMatchObject({ fingerprint: fp, previousKeyId: null });
    const file = JSON.parse(await readFile(join(dir, VAULT_KEY_FILE), 'utf8')) as {
      current: { privateKeyPkcs8: string };
    };
    for (const text of [...first.out, ...first.err, ...second.out]) {
      expect(text).not.toContain(file.current.privateKeyPkcs8);
    }
  });
});

describe('reserved vault-* secret names', () => {
  it('`secret set vault-…` is refused (the panel vault owns that prefix)', async () => {
    const dir = await tempDir();
    const c = capture();
    async function* stdin() {
      await Promise.resolve();
      yield Buffer.from('sk-local-value-123\n');
    }
    expect(
      await secretCommand(['set', 'vault-openai', '--stdin', '--data-dir', dir], c.io, {
        ops: nodeOps(),
        pathHost: pathHost(),
        stdin: stdin(),
      }),
    ).toBe(2);
    expect(c.err.join('')).toContain('reserved');
  });
});
