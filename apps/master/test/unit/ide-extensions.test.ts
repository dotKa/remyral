import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { detectSecrets } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { checkSettingsText, denial, ideTarget, resolveProfile } from '../../src/ide/extension-policy.js';
import {
  cacheTargets,
  DEFAULT_REGISTRY,
  type Fetch,
  keyFingerprint,
  normalizeRegistry,
  OPEN_VSX_PINNED_KEYS,
  OpenVsxClient,
  OpenVsxError,
  verifyVsix,
} from '../../src/ide/openvsx.js';

/**
 * p19-ide W3: the Open VSX integrity checks (size, SHA-256 from the `.sha256` file and the signed manifest, the Ed25519
 * signature over the VSIX — the format read from the live registry), the client against a fake registry (pinned key
 * for open-vsx.org, the registry's key elsewhere, cross-origin keys refused), and the policy resolver (deny wins,
 * required + user lists, dependencies, Linux targets).
 */

function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32(e.data) >>> 0, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(e.data) >>> 0, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, e.data);
    centrals.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function signed(vsix: Buffer, key: KeyObject, opts: { manifestSha?: string } = {}): Buffer {
  const manifest = JSON.stringify({
    package: {
      size: vsix.length,
      digests: { sha256: opts.manifestSha ?? createHash('sha256').update(vsix).digest('base64') },
    },
    entries: {},
  });
  return zip([
    { name: '.signature.sig', data: sign(null, vsix, key) },
    { name: '.signature.manifest', data: Buffer.from(manifest) },
    { name: '.signature.p7s', data: Buffer.alloc(0) },
  ]);
}

const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const vsixOf = (id: string, version: string): Buffer => {
  const [publisher, name] = id.split('.');
  return zip([
    { name: 'extension.vsixmanifest', data: Buffer.from('<x/>') },
    { name: 'extension/package.json', data: Buffer.from(JSON.stringify({ publisher, name, version })) },
  ]);
};

describe('verifyVsix (Open VSX signature format)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const vsix = vsixOf('acme.tool', '1.0.0');

  it('accepts a VSIX whose digest and Ed25519 signature match', () => {
    const sha = verifyVsix({
      vsix,
      sigzip: signed(vsix, privateKey),
      sha256Text: `${hex(vsix)}\n`,
      key: publicKey,
    });
    expect(sha).toBe(hex(vsix));
  });

  it('refuses a changed VSIX, a wrong .sha256, a manifest for another package and another key', () => {
    const other = Buffer.concat([vsix, Buffer.from('x')]);
    expect(() =>
      verifyVsix({ vsix: other, sigzip: signed(vsix, privateKey), sha256Text: null, key: publicKey }),
    ).toThrow(OpenVsxError);
    expect(() =>
      verifyVsix({ vsix, sigzip: signed(vsix, privateKey), sha256Text: 'a'.repeat(64), key: publicKey }),
    ).toThrow(/sha256/i);
    expect(() =>
      verifyVsix({
        vsix,
        sigzip: signed(vsix, privateKey, { manifestSha: 'AAAA' }),
        sha256Text: null,
        key: publicKey,
      }),
    ).toThrow(/manifest/);
    const stranger = generateKeyPairSync('ed25519');
    expect(() =>
      verifyVsix({ vsix, sigzip: signed(vsix, stranger.privateKey), sha256Text: null, key: publicKey }),
    ).toThrow(/does not verify/);
    expect(() => verifyVsix({ vsix, sigzip: Buffer.from('nope'), sha256Text: null, key: publicKey })).toThrow(
      /signature archive/,
    );
    expect(() =>
      verifyVsix({
        vsix,
        sigzip: signed(vsix, privateKey),
        sha256Text: null,
        key: publicKey,
        expectedSize: 3,
      }),
    ).toThrow(/size/);
  });

  it('pins the open-vsx.org key (an Ed25519 SPKI)', () => {
    for (const der of Object.values(OPEN_VSX_PINNED_KEYS))
      expect(Buffer.from(der, 'base64')).toHaveLength(44);
    expect(keyFingerprint(publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('registry helpers', () => {
  it('normalizes https registries and refuses others', () => {
    expect(normalizeRegistry('https://open-vsx.org/')).toBe(DEFAULT_REGISTRY);
    expect(normalizeRegistry('https://vsx.example.com/sub/')).toBe('https://vsx.example.com/sub');
    expect(() => normalizeRegistry('http://open-vsx.org')).toThrow();
    expect(() => normalizeRegistry('https://u:p@x.example')).toThrow();
  });

  it('caches universal builds, else every Linux, macOS and Windows build (W2b)', () => {
    expect(cacheTargets({ targetPlatform: 'universal', downloads: {} })).toEqual(['universal']);
    expect(
      cacheTargets({
        targetPlatform: 'linux-x64',
        downloads: {
          'linux-x64': 'u',
          'linux-arm64': 'u',
          'win32-x64': 'u',
          'win32-arm64': 'u',
          'darwin-arm64': 'u',
          'alpine-x64': 'u',
        },
      }),
    ).toEqual(['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']);
    expect(cacheTargets({ targetPlatform: 'win32-x64', downloads: { 'win32-x64': 'u' } })).toEqual([
      'win32-x64',
    ]);
    expect(cacheTargets({ targetPlatform: 'win32-arm64', downloads: { 'win32-arm64': 'u' } })).toEqual([]);
  });
});

describe('OpenVsxClient against a fake registry', () => {
  const REG = 'https://vsx.example.com';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const vsix = vsixOf('acme.tool', '1.2.0');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const files = (base: string) => ({
    download: `${base}/acme.tool-1.2.0.vsix`,
    signature: `${base}/acme.tool-1.2.0.sigzip`,
    sha256: `${base}/acme.tool-1.2.0.sha256`,
    publicKey: `${REG}/api/-/public-key/k1`,
  });
  const routes = (keyUrl?: string): Record<string, Buffer> => ({
    [`${REG}/api/acme/tool/latest`]: Buffer.from(
      JSON.stringify({
        namespace: 'acme',
        name: 'tool',
        version: '1.2.0',
        targetPlatform: 'universal',
        displayName: 'Acme Tool',
        verified: true,
        engines: { vscode: '^1.90.0' },
        dependencies: ['acme.base'],
        files: { ...files(`${REG}/files`), ...(keyUrl === undefined ? {} : { publicKey: keyUrl }) },
        downloadSizes: { universal: vsix.length },
      }),
    ),
    [`${REG}/files/acme.tool-1.2.0.vsix`]: vsix,
    [`${REG}/files/acme.tool-1.2.0.sigzip`]: signed(vsix, privateKey),
    [`${REG}/files/acme.tool-1.2.0.sha256`]: Buffer.from(hex(vsix)),
    [`${REG}/api/-/public-key/k1`]: Buffer.from(pem),
    [`${REG}/api/-/search?query=tool&size=20`]: Buffer.from(
      JSON.stringify({ extensions: [{ namespace: 'acme', name: 'tool', version: '1.2.0', verified: true }] }),
    ),
  });
  const fake =
    (map: Record<string, Buffer>): Fetch =>
    (url) => {
      const body = map[url];
      return Promise.resolve({
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        url,
        headers: { get: () => null },
        arrayBuffer: () => {
          const b = body ?? Buffer.alloc(0);
          return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer);
        },
      });
    };

  it('reads metadata, downloads and verifies with the registry key (not pinned)', async () => {
    const c = new OpenVsxClient({ fetch: fake(routes()) });
    const meta = await c.meta(REG, 'acme.tool');
    expect(meta).toMatchObject({
      id: 'acme.tool',
      version: '1.2.0',
      verified: true,
      dependencies: ['acme.base'],
    });
    const v = await c.fetchVerified(REG, meta);
    expect(v).toMatchObject({ sha256: hex(vsix), keyId: 'k1', keyPinned: false });
    expect((await c.search(REG, 'tool'))[0]).toMatchObject({ id: 'acme.tool', verified: true });
  });

  it('refuses a signing key on another origin and a missing extension', async () => {
    const c = new OpenVsxClient({ fetch: fake(routes('https://evil.example/api/-/public-key/k1')) });
    const meta = await c.meta(REG, 'acme.tool');
    await expect(c.fetchVerified(REG, meta)).rejects.toMatchObject({ reason: 'unsigned' });
    await expect(c.meta(REG, 'acme.none')).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('uses the pinned key for open-vsx.org (a registry-served key is not trusted)', async () => {
    const id = Object.keys(OPEN_VSX_PINNED_KEYS)[0] ?? '';
    const c = new OpenVsxClient({ fetch: fake({}) });
    const k = await c.key(DEFAULT_REGISTRY, `${DEFAULT_REGISTRY}/api/-/public-key/${id}`);
    expect(k.pinned).toBe(true);
    expect(k.key.asymmetricKeyType).toBe('ed25519');
  });
});

describe('resolveProfile (deny wins, required + user, dependencies)', () => {
  const blob = (
    sha: string,
    target: 'universal' | 'linux-x64' | 'linux-arm64' | 'darwin-arm64' | 'win32-x64' = 'universal',
  ) => ({
    target,
    sha256: sha.repeat(64).slice(0, 64),
    size: 10,
  });
  const allowlist = [
    { id: 'a.req', version: '1.0.0', publisherVerified: true, dependencies: ['a.dep'], blobs: [blob('1')] },
    { id: 'a.dep', version: '2.0.0', publisherVerified: true, dependencies: [], blobs: [blob('2')] },
    {
      id: 'a.mine',
      version: '1.0.0',
      publisherVerified: false,
      dependencies: ['a.missing'],
      blobs: [blob('3')],
    },
    {
      id: 'a.arm',
      version: '1.0.0',
      publisherVerified: true,
      dependencies: [],
      blobs: [blob('4', 'linux-arm64')],
    },
    { id: 'a.denied', version: '1.0.0', publisherVerified: true, dependencies: [], blobs: [blob('5')] },
  ];

  it('installs required + the user list + allowed dependencies; reports the rest', () => {
    const r = resolveProfile({
      allowlist,
      global: { verifiedOnly: false, deny: [] },
      project: {
        required: ['a.req'],
        deny: ['a.denied'],
        enforcedSettings: { 'files.exclude': { dist: true } },
      },
      user: ['a.mine', 'a.arm', 'a.denied', 'a.unknown'],
      target: 'linux-x64',
      settingsSync: true,
    });
    expect(r.profile.extensions.map((e) => e.id)).toEqual(['a.req', 'a.mine', 'a.dep']);
    expect(r.profile.allowed).toEqual(['a.req', 'a.mine', 'a.dep']);
    expect(r.profile.enforcedSettings).toEqual({ 'files.exclude': { dist: true } });
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { id: 'a.arm', reason: 'no_build' },
        { id: 'a.denied', reason: 'denied' },
        { id: 'a.unknown', reason: 'not_allowed' },
        { id: 'a.missing', reason: 'dependency_not_allowed' },
      ]),
    );
  });

  it('W2b: a macOS / Windows machine gets its own platform build, else the universal one', () => {
    const native = {
      id: 'a.native',
      version: '1.0.0',
      publisherVerified: true,
      dependencies: [],
      blobs: [blob('6', 'linux-x64'), blob('7', 'darwin-arm64'), blob('8', 'win32-x64')],
    };
    const list = [...allowlist, native];
    const input = {
      allowlist: list,
      global: { verifiedOnly: false, deny: [] },
      project: null,
      user: ['a.native', 'a.arm', 'a.dep'],
      settingsSync: false,
    };
    const mac = resolveProfile({ ...input, target: 'darwin-arm64' });
    expect(mac.profile.extensions.map((e) => [e.id, e.targetPlatform])).toEqual([
      ['a.native', 'darwin-arm64'],
      ['a.dep', 'universal'],
    ]);
    expect(mac.skipped).toEqual([{ id: 'a.arm', reason: 'no_build' }]);
    const win = resolveProfile({ ...input, target: 'win32-x64' });
    expect(win.profile.extensions.find((e) => e.id === 'a.native')?.targetPlatform).toBe('win32-x64');
  });

  it('verified-only and the global deny win over the project’s required list', () => {
    const r = resolveProfile({
      allowlist,
      global: { verifiedOnly: true, deny: ['a.req'] },
      project: { required: ['a.req'], deny: [], enforcedSettings: {} },
      user: ['a.mine', 'a.arm'],
      target: 'linux-arm64',
      settingsSync: false,
    });
    expect(r.profile.extensions.map((e) => e.id)).toEqual(['a.arm']);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { id: 'a.req', reason: 'denied' },
        { id: 'a.mine', reason: 'unverified' },
      ]),
    );
    expect(
      denial('a.dep', { allowlist, global: { verifiedOnly: true, deny: [] }, project: null }),
    ).toBeNull();
  });

  it('maps machine facts to VS Code targets (W2b: macOS and Windows too)', () => {
    expect(ideTarget('linux', 'x64')).toBe('linux-x64');
    expect(ideTarget('linux', 'arm')).toBe('linux-armhf');
    expect(ideTarget(null, 'arm64')).toBe('linux-arm64');
    expect(ideTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(ideTarget('darwin', 'x64')).toBe('darwin-x64');
    expect(ideTarget('win32', 'x64')).toBe('win32-x64');
    expect(ideTarget('win32', 'arm64')).toBeNull();
    expect(ideTarget(null, 'riscv64')).toBeNull();
  });

  it('refuses settings with a secret-looking value or over 256 KiB', () => {
    const detect = (t: string) => detectSecrets(t);
    expect(checkSettingsText('{"editor.fontSize": 14}', detect)).toEqual({ ok: true });
    const secret = checkSettingsText(`{"x.token": "ghp_${'a'.repeat(36)}"}`, detect);
    expect(secret).toMatchObject({ ok: false, reason: 'secret' });
    expect(checkSettingsText('x'.repeat(256 * 1024 + 1), detect)).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
  });
});
