import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { Ed25519PublicKey, Ed25519Signature, PairingCode } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { DeviceKey, challengePayload, fingerprint, verifyChallenge } from '../src/identity/device-key.js';
import {
  FileKeystore,
  KEY_FILE,
  KeystoreError,
  KeystoreUnavailableError,
  MacKeychainKeystore,
  WindowsDpapiKeystore,
  createKeystore,
  loadOrCreateDeviceKey,
} from '../src/identity/keystore.js';
import { PAIRING_ALPHABET, generatePairingCode } from '../src/identity/pairing.js';
import { InsecurePermissionsError } from '../src/fs/permissions.js';
import { isWindows, nodeOps, opsWithStats, patchOps, tempDir } from './helpers.js';

describe('DeviceKey', () => {
  it('public key and signatures match the protocol formats', () => {
    const key = DeviceKey.generate();
    expect(key.publicKey).toHaveLength(43);
    expect(Ed25519PublicKey.safeParse(key.publicKey).success).toBe(true);
    const sig = key.signChallenge('nonce-0123456789abcdef');
    expect(sig).toHaveLength(86);
    expect(Ed25519Signature.safeParse(sig).success).toBe(true);
  });

  it('challenge signatures verify, are domain-separated and bound to nonce and key', () => {
    const key = DeviceKey.generate();
    const nonce = 'n-abcdefghijklmnop';
    const sig = key.signChallenge(nonce);
    expect(verifyChallenge(key.publicKey, nonce, sig)).toBe(true);
    expect(verifyChallenge(key.publicKey, `${nonce}x`, sig)).toBe(false);
    expect(verifyChallenge(DeviceKey.generate().publicKey, nonce, sig)).toBe(false);
    // A signature over the bare nonce is not a valid AUTH signature.
    expect(verifyChallenge(key.publicKey, nonce, key.sign(Buffer.from(nonce)))).toBe(false);
    expect(challengePayload(nonce).toString()).toBe(`remana-worker-auth/v1\n${nonce}`);
    expect(verifyChallenge(key.publicKey, nonce, 'short')).toBe(false);
  });

  it('fingerprint is SHA-256 of the raw key in 16 groups of 4 hex digits, stable', () => {
    const key = DeviceKey.generate();
    expect(key.fingerprint).toMatch(/^SHA256:([0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    expect(fingerprint(key.publicKey)).toBe(key.fingerprint);
    // RFC 8032 test vector 1 public key; expected value computed independently (python hashlib).
    const rfcKey = Buffer.from(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      'hex',
    ).toString('base64url');
    expect(fingerprint(rfcKey)).toBe(
      'SHA256:21FE-31DF-A154-A261-626B-F854-046F-D227-1B7B-ED4B-6ABE-45AA-5887-7EF4-7F97-21B9',
    );
  });

  it('is standard Ed25519 (RFC 8032 §7.1 test 1)', () => {
    const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
    const key = DeviceKey.fromPkcs8(Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'));
    expect(Buffer.from(key.publicKey, 'base64url').toString('hex')).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
    expect(Buffer.from(key.sign(new Uint8Array()), 'base64url').toString('hex')).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });

  it('never exposes the private key via JSON, String or inspect', () => {
    const key = DeviceKey.generate();
    const pkcs8 = key.exportPkcs8ForKeystore().toString('base64');
    for (const rendered of [JSON.stringify(key), String(key), inspect(key), JSON.stringify({ key })]) {
      expect(rendered).not.toContain(pkcs8);
      expect(rendered).not.toContain(pkcs8.slice(-20));
    }
    expect(JSON.parse(JSON.stringify(key))).toEqual({
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
    });
  });
});

describe('pairing code', () => {
  it('matches the protocol PairingCode format and avoids I/O', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(PairingCode.safeParse(code).success).toBe(true);
      expect(code).not.toMatch(/[IO01]/);
    }
    expect(PAIRING_ALPHABET).toHaveLength(32);
    expect(generatePairingCode(() => 0)).toBe('AAAA-AAAA');
  });
});

describe('FileKeystore', () => {
  it('creates a 0600 key on first use and loads the same key afterwards', async () => {
    const dir = await tempDir();
    const ks = new FileKeystore(nodeOps(), join(dir, 'data'));
    const first = await loadOrCreateDeviceKey(ks);
    expect(first.created).toBe(true);
    const second = await loadOrCreateDeviceKey(new FileKeystore(nodeOps(), join(dir, 'data')));
    expect(second.created).toBe(false);
    expect(second.key.publicKey).toBe(first.key.publicKey);
    if (!isWindows) {
      expect((await nodeOps().stat(join(dir, 'data', KEY_FILE)))?.mode).toBe(0o600);
      expect((await nodeOps().stat(join(dir, 'data')))?.mode).toBe(0o700);
    }
    await expect(ks.create()).rejects.toBeInstanceOf(KeystoreError);
  });

  it('rejects a tampered key file (public key mismatch / garbage)', async () => {
    const dir = await tempDir();
    const ks = new FileKeystore(nodeOps(), dir);
    await ks.create();
    const path = join(dir, KEY_FILE);
    const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...file, publicKey: DeviceKey.generate().publicKey }), {
      mode: 0o600,
    });
    await expect(ks.load()).rejects.toThrow(/does not match/);
    await writeFile(path, '{"version":1}', { mode: 0o600 });
    await expect(ks.load()).rejects.toThrow(/not a valid device key file/);
  });

  describe.skipIf(isWindows)('POSIX permission enforcement', () => {
    it('refuses a key file readable by group/others', async () => {
      const dir = await tempDir();
      const ks = new FileKeystore(nodeOps(), dir);
      await ks.create();
      await chmod(join(dir, KEY_FILE), 0o644);
      await expect(ks.load()).rejects.toThrow(InsecurePermissionsError);
      await expect(ks.load()).rejects.toThrow(/chmod 600/);
    });

    it('refuses a key file owned by another user', async () => {
      const dir = await tempDir();
      await new FileKeystore(nodeOps(), dir).create();
      const ks = new FileKeystore(opsWithStats({ [join(dir, KEY_FILE)]: { uid: 4242 } }), dir);
      await expect(ks.load()).rejects.toThrow(/owned by uid 4242/);
    });

    it('refuses a symlinked key file', async () => {
      const dir = await tempDir();
      const other = await tempDir();
      await new FileKeystore(nodeOps(), other).create();
      await symlink(join(other, KEY_FILE), join(dir, KEY_FILE));
      await expect(new FileKeystore(nodeOps(), dir).load()).rejects.toThrow(/not a regular file/);
    });

    it('refuses a group-writable key directory', async () => {
      const dir = await tempDir();
      await chmod(dir, 0o770);
      await expect(new FileKeystore(nodeOps(), dir).load()).rejects.toThrow(InsecurePermissionsError);
    });
  });

  it('on Windows, mode bits are not checked and access control is reported UNVERIFIED', async () => {
    const dir = await tempDir();
    const ks = new FileKeystore(patchOps({ platform: 'win32', uid: null }), dir);
    expect(ks.accessControlVerified).toBe(false);
    await expect(loadOrCreateDeviceKey(ks)).resolves.toMatchObject({ created: true });
  });
});

describe('OS keystores', () => {
  it('Keychain and DPAPI are unimplemented and fail closed with typed errors', async () => {
    await expect(new MacKeychainKeystore().load()).rejects.toBeInstanceOf(KeystoreUnavailableError);
    await expect(new WindowsDpapiKeystore().create()).rejects.toBeInstanceOf(KeystoreUnavailableError);
    expect(() => createKeystore('macos-keychain', patchOps({ platform: 'linux' }), '/x')).toThrow(
      KeystoreUnavailableError,
    );
    expect(() => createKeystore('windows-dpapi', patchOps({ platform: 'darwin' }), '/x')).toThrow(
      KeystoreUnavailableError,
    );
    expect(createKeystore('file', nodeOps(), '/x').kind).toBe('file');
  });
});
