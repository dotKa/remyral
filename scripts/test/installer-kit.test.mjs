import { Buffer } from 'node:buffer';
// p5-worker-onboarding: installer kits (scripts/release/kit.mjs, sign.mjs installers|verify-installers)
// and the Node pin check (scripts/security/node-pin.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildKits, dearmor, kitFileName, nodeKeyring, parsePin, tarGz, zip } from '../release/kit.mjs';
import { checkNodePin, hashesFrom, NODE_DIR, PLATFORMS } from '../security/node-pin.mjs';
import { REPO } from '../security/lib.mjs';

const SIGN = join(REPO, 'scripts/release/sign.mjs');
const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const sign = (...args) => execFileSync(process.execPath, [SIGN, ...args], { encoding: 'utf8' });
const hasCmd = (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;

/** Minimal ustar reader: [{name, type, mode, size, data}] (enough to check our own writer). */
function untar(gz) {
  const buf = gunzipSync(gz);
  const out = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, n) =>
      h
        .subarray(a, a + n)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    expect(parseInt(field(148, 8), 8)).toBe(sum);
    out.push({
      name: field(0, 100),
      type: field(156, 1),
      mode: parseInt(field(100, 8), 8),
      uid: parseInt(field(108, 8), 8),
      data: buf.subarray(off + 512, off + 512 + size),
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('archives', () => {
  const entries = [
    { path: 'b.txt', data: Buffer.from('bee\n'), mode: 0o644 },
    { path: 'install.sh', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
    { path: 'node/pin.env', data: Buffer.from('NODE_VERSION=24.0.0\n'), mode: 0o644 },
  ];

  it('tar.gz: ustar, root-owned, modes kept, directories first, deterministic', () => {
    const a = tarGz('kit', entries, 1_790_000_000);
    expect(a.equals(tarGz('kit', [...entries].reverse(), 1_790_000_000))).toBe(true);
    const files = untar(a);
    expect(files.map((f) => f.name)).toEqual([
      'kit/',
      'kit/node/',
      'kit/b.txt',
      'kit/install.sh',
      'kit/node/pin.env',
    ]);
    expect(files.every((f) => f.uid === 0)).toBe(true);
    expect(files.find((f) => f.name === 'kit/install.sh')?.mode).toBe(0o755);
    expect(files.find((f) => f.name === 'kit/node/pin.env')?.data.toString()).toBe('NODE_VERSION=24.0.0\n');
  });

  it.skipIf(!hasCmd('tar'))('tar.gz extracts with the system tar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-tar-'));
    try {
      writeFileSync(join(dir, 'k.tgz'), tarGz('kit', entries, 1_790_000_000));
      execFileSync('tar', ['-xzf', join(dir, 'k.tgz'), '-C', dir]);
      expect(readFileSync(join(dir, 'kit/node/pin.env'), 'utf8')).toBe('NODE_VERSION=24.0.0\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasCmd('unzip'))('zip: valid deflate archive with CRCs (unzip -t), deterministic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-zip-'));
    try {
      const z = zip('kit', entries, 1_790_000_000);
      expect(z.equals(zip('kit', entries, 1_790_000_000))).toBe(true);
      writeFileSync(join(dir, 'k.zip'), z);
      expect(execFileSync('unzip', ['-tq', join(dir, 'k.zip')], { encoding: 'utf8' })).toMatch(/No errors/);
      execFileSync('unzip', ['-q', join(dir, 'k.zip'), '-d', dir]);
      expect(readFileSync(join(dir, 'kit/install.sh'), 'utf8')).toContain('echo hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dearmor checks the CRC-24 of the vendored keys', () => {
    const asc = readFileSync(
      join(
        NODE_DIR,
        'keys',
        readdirSync(join(NODE_DIR, 'keys')).find((f) => f.endsWith('.asc')),
      ),
      'utf8',
    );
    const bin = dearmor(asc);
    expect(bin[0] & 0x80).toBe(0x80); // an OpenPGP packet tag
    const broken = asc.replace(/\n([A-Za-z0-9+/]{10})/, (_, s) => `\n${s.split('').reverse().join('')}`);
    expect(() => dearmor(broken)).toThrow(/CRC-24/);
    expect(() => dearmor('hello')).toThrow(/not an armored/);
    expect(nodeKeyring(NODE_DIR).length).toBeGreaterThan(10_000);
  });
});

describe('sign.mjs installers / verify-installers', () => {
  let dir;
  let pub;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-sign-'));
    sign('keygen', '--out', join(dir, 'keys'));
    pub = readFileSync(join(dir, 'keys/release-key.pub'), 'utf8').trim();
    writeFileSync(join(dir, 'worker.mjs'), 'console.log("worker 2.0.0")\n');
    sign(
      'sign',
      '--artifact',
      join(dir, 'worker.mjs'),
      '--version',
      '2.0.0',
      '--key',
      join(dir, 'keys/release-key.pem'),
      '--out',
      join(dir, 'rel'),
    );
    writeFileSync(join(dir, 'rel/remyral-worker-updater.mjs'), 'console.log("updater")\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('builds one kit per OS, signs the index, and adds both to release.json', () => {
    const out = sign('installers', '--dir', join(dir, 'rel'), '--key', join(dir, 'keys/release-key.pem'));
    expect(out).toMatch(/remyral-worker-2\.0\.0-linux\.tar\.gz/);
    const index = JSON.parse(readFileSync(join(dir, 'rel/installers/index.json'), 'utf8'));
    expect(index.kits.map((k) => k.file)).toEqual(
      ['linux', 'macos', 'windows'].map((os) => kitFileName('2.0.0', os)),
    );
    expect(index.releaseManifestSha256).toBe(sha256(readFileSync(join(dir, 'rel/manifest.json'))));
    expect(index.node.version).toBe(parsePin(readFileSync(join(NODE_DIR, 'pin.env'), 'utf8')).NODE_VERSION);
    const upload = JSON.parse(readFileSync(join(dir, 'rel/release.json'), 'utf8'));
    expect(upload.installers.kits.map((k) => k.os)).toEqual(['linux', 'macos', 'windows']);
    expect(
      Buffer.from(upload.installers.index, 'base64').equals(
        readFileSync(join(dir, 'rel/installers/index.json')),
      ),
    ).toBe(true);
    expect(sign('verify-installers', '--dir', join(dir, 'rel'), `--public-key=${pub}`)).toMatch(
      /OK installer index 2\.0\.0/,
    );
  });

  it('a kit contains the signed release, the scripts, the Node pin and a complete SHA256SUMS', () => {
    const kit = readFileSync(join(dir, 'rel/installers', kitFileName('2.0.0', 'linux')));
    const files = untar(kit).filter((f) => f.type === '0');
    const byName = Object.fromEntries(
      files.map((f) => [f.name.replace(/^remyral-worker-2\.0\.0-linux\//, ''), f]),
    );
    for (const f of [
      'install.sh',
      'uninstall.sh',
      'remyral-worker.service',
      'remyral-worker.mjs',
      'manifest.json',
      'manifest.sig.json',
      'remyral-worker-updater.mjs',
      'node/pin.env',
      'node/install-node.sh',
      'node/nodejs-keyring.gpg',
      'README.txt',
      'SHA256SUMS',
    ]) {
      expect(byName[f], f).toBeDefined();
    }
    expect(byName['install.sh'].mode).toBe(0o755);
    const sums = byName.SHA256SUMS.data.toString().trim().split('\n');
    expect(sums).toHaveLength(files.length - 1);
    for (const line of sums) {
      const [hash, path] = line.split('  ');
      expect(sha256(byName[path].data), path).toBe(hash);
    }
  });

  it('verify-installers refuses a swapped kit and a forged index', () => {
    const k = join(dir, 'rel/installers', kitFileName('2.0.0', 'macos'));
    const orig = readFileSync(k);
    writeFileSync(k, Buffer.concat([orig, Buffer.from('x')]));
    const r = spawnSync(
      process.execPath,
      [SIGN, 'verify-installers', '--dir', join(dir, 'rel'), `--public-key=${pub}`],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match the signed index/);
    writeFileSync(k, orig);
    const idx = join(dir, 'rel/installers/index.json');
    const text = readFileSync(idx, 'utf8');
    writeFileSync(idx, text.replace('"2.0.0"', '"2.0.1"'));
    const f = spawnSync(
      process.execPath,
      [SIGN, 'verify-installers', '--dir', join(dir, 'rel'), `--public-key=${pub}`],
      { encoding: 'utf8' },
    );
    expect(f.stderr).toMatch(/BAD installer index signature/);
    writeFileSync(idx, text);
  });

  it('refuses a release dir whose bundle does not match its manifest', () => {
    writeFileSync(join(dir, 'rel/remyral-worker.mjs'), 'tampered\n');
    expect(() => buildKits({ releaseDir: join(dir, 'rel'), repo: REPO })).toThrow(/does not match manifest/);
  });
});

describe('node pin (scripts/security/node-pin.mjs)', () => {
  it('the shipped pin is consistent', () => {
    expect(checkNodePin()).toEqual([]);
  });

  it('flags a wrong major, missing hashes, an unknown signer, missing keys and an outdated version', () => {
    const pinText = readFileSync(join(NODE_DIR, 'pin.env'), 'utf8');
    expect(
      checkNodePin({ pinText: pinText.replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=22.1.0') }).join(),
    ).toMatch(/not a Node 24/);
    expect(checkNodePin({ pinText: pinText.replace(/^NODE_SHA256_win_x64=.*$/m, '') }).join()).toMatch(
      /NODE_SHA256_win_x64 missing/,
    );
    expect(
      checkNodePin({ pinText: pinText.replace(/^NODE_SIGNER=.*$/m, `NODE_SIGNER=${'A'.repeat(40)}`) }).join(),
    ).toMatch(/not in keys\/keys.list/);
    expect(checkNodePin({ keyFiles: ['keys.list'] }).join()).toMatch(/\.asc missing/);
    expect(checkNodePin({ engines: '>=24.99.0 <25' }).join()).toMatch(/older than the repository's engines/);
    expect(
      checkNodePin({ pinText: pinText.replace('https://nodejs.org/dist', 'http://evil.example') }).join(),
    ).toMatch(/NODE_DIST_URL/);
  });

  it('reads per-platform hashes from SHASUMS256.txt', () => {
    const lines = PLATFORMS.map(
      (p, i) => `${String(i).repeat(64)}  node-v24.1.0-${p}.${p.startsWith('win') ? 'zip' : 'tar.gz'}`,
    );
    const h = hashesFrom(Buffer.from(`${lines.join('\n')}\n`), '24.1.0');
    expect(h['linux-arm64']).toBe('1'.repeat(64));
    expect(() => hashesFrom(Buffer.from(lines[0]), '24.1.0')).toThrow(/has no/);
  });
});
