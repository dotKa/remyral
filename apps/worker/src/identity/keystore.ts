import { join } from 'node:path';
import { z } from 'zod';
import { Ed25519PublicKey, Timestamp } from '@remyral/protocol';
import type { KeystoreKind } from '../config/schema.js';
import { atomicWriteFile, removeStaleTemps } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { assertPrivateFile, ensurePrivateDir } from '../fs/permissions.js';
import { DeviceKey } from './device-key.js';

/**
 * Where the device private key lives (ADR-0005 §2). The key never leaves the
 * keystore except as a `DeviceKey` object inside this process.
 */
export interface Keystore {
  readonly kind: KeystoreKind;
  /** Human-readable location for `identity show` (no secrets). */
  readonly location: string;
  /**
   * Whether the platform access control protecting the key was verified by this
   * code. `false` on Windows, where ACLs are the installer's job (UNVERIFIED).
   */
  readonly accessControlVerified: boolean;
  load(): Promise<DeviceKey | null>;
  /** Generates and stores a new key; fails if one exists. */
  create(): Promise<DeviceKey>;
  /**
   * Key rotation (ADR-0005 §5): the next key is generated and stored *before*
   * the master learns about it, so a crash cannot lose it. Idempotent: returns
   * the stored next key if there is one.
   */
  createNext(): Promise<DeviceKey>;
  loadNext(): Promise<DeviceKey | null>;
  /** Atomically replaces the current key with the next one. */
  promoteNext(): Promise<DeviceKey>;
  discardNext(): Promise<void>;
}

export class KeystoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeystoreError';
  }
}

/** The requested keystore backend is not implemented / not verified on this platform. */
export class KeystoreUnavailableError extends KeystoreError {
  constructor(
    readonly kind: KeystoreKind,
    reason: string,
  ) {
    super(`keystore "${kind}" is unavailable: ${reason}`);
    this.name = 'KeystoreUnavailableError';
  }
}

export const KEY_FILE = 'device-key.json';
export const NEXT_KEY_FILE = 'device-key.next.json';

const KeyFile = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal('ed25519'),
  /** PKCS#8 DER, base64. */
  privateKeyPkcs8: z.string().min(1).max(512),
  publicKey: Ed25519PublicKey,
  createdAt: Timestamp,
});

/**
 * File keystore: `<dataDir>/device-key.json`, created 0600 via O_EXCL so it never
 * exists with wider permissions. On POSIX, `load` refuses a key file that is a
 * symlink, not owned by the worker user, or readable by group/others, and a
 * directory writable by group/others (InsecurePermissionsError).
 *
 * Windows: mode bits are not enforced by NTFS. The directory must carry an ACL
 * granting access only to SYSTEM and the worker's service account (set by the
 * p2-service-windows installer). This class cannot verify that yet, so
 * `accessControlVerified` is false and the daemon logs a warning.
 */
export class FileKeystore implements Keystore {
  readonly kind = 'file' as const;
  readonly location: string;
  readonly accessControlVerified: boolean;

  constructor(
    private readonly ops: FileOps,
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.location = join(dir, KEY_FILE);
    this.accessControlVerified = ops.platform !== 'win32';
  }

  async load(): Promise<DeviceKey | null> {
    return this.#loadFrom(this.location, KEY_FILE);
  }

  async #loadFrom(path: string, name: string): Promise<DeviceKey | null> {
    await ensurePrivateDir(this.ops, this.dir);
    await removeStaleTemps(this.ops, this.dir, name);
    // Check before reading: never follow a planted symlink to someone else's file.
    await assertPrivateFile(this.ops, path);
    const raw = await this.ops.readFile(path, 4096);
    if (raw === null) return null;
    let file: z.infer<typeof KeyFile>;
    try {
      file = KeyFile.parse(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      throw new KeystoreError(`${path} is not a valid device key file`, { cause: error });
    }
    let key: DeviceKey;
    try {
      key = DeviceKey.fromPkcs8(Buffer.from(file.privateKeyPkcs8, 'base64'));
    } catch (error) {
      throw new KeystoreError(`${path} contains an unreadable private key`, { cause: error });
    }
    if (key.publicKey !== file.publicKey) {
      throw new KeystoreError(`${path}: stored public key does not match the private key`);
    }
    return key;
  }

  async #write(path: string, key: DeviceKey): Promise<void> {
    const file: z.infer<typeof KeyFile> = {
      version: 1,
      algorithm: 'ed25519',
      privateKeyPkcs8: key.exportPkcs8ForKeystore().toString('base64'),
      publicKey: key.publicKey,
      createdAt: this.now().toISOString(),
    };
    await atomicWriteFile(this.ops, path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  }

  async create(): Promise<DeviceKey> {
    if ((await this.load()) !== null) throw new KeystoreError(`${this.location} already exists`);
    const key = DeviceKey.generate();
    await this.#write(this.location, key);
    return key;
  }

  get nextLocation(): string {
    return join(this.dir, NEXT_KEY_FILE);
  }

  loadNext(): Promise<DeviceKey | null> {
    return this.#loadFrom(this.nextLocation, NEXT_KEY_FILE);
  }

  async createNext(): Promise<DeviceKey> {
    const existing = await this.loadNext();
    if (existing !== null) return existing;
    const key = DeviceKey.generate();
    await this.#write(this.nextLocation, key);
    return key;
  }

  async promoteNext(): Promise<DeviceKey> {
    const next = await this.loadNext();
    if (next === null) throw new KeystoreError(`${this.nextLocation} does not exist`);
    // rename() replaces the current key atomically (MoveFileEx on Windows); the old key is gone.
    await this.ops.rename(this.nextLocation, this.location);
    await this.ops.fsyncDir(this.dir);
    return next;
  }

  async discardNext(): Promise<void> {
    await this.ops.unlink(this.nextLocation);
    await this.ops.fsyncDir(this.dir);
  }
}

/**
 * macOS Keychain backend — NOT IMPLEMENTED. Needs a signed helper or native
 * binding (Security.framework `SecItemAdd` with kSecAttrAccessible…ThisDeviceOnly)
 * that we have not built or verified. Selecting it fails closed.
 */
export class MacKeychainKeystore implements Keystore {
  readonly kind = 'macos-keychain' as const;
  readonly location = 'macOS Keychain (not implemented)';
  readonly accessControlVerified = false;
  load(): Promise<DeviceKey | null> {
    return Promise.reject(
      new KeystoreUnavailableError(this.kind, 'not implemented (UNVERIFIED); use "file"'),
    );
  }
  create(): Promise<DeviceKey> {
    return Promise.reject(
      new KeystoreUnavailableError(this.kind, 'not implemented (UNVERIFIED); use "file"'),
    );
  }
  createNext(): Promise<DeviceKey> {
    return this.create();
  }
  promoteNext(): Promise<DeviceKey> {
    return this.create();
  }
  loadNext(): Promise<DeviceKey | null> {
    return this.load();
  }
  discardNext(): Promise<void> {
    return this.load().then(() => undefined);
  }
}

/**
 * Windows DPAPI / Credential Manager backend — NOT IMPLEMENTED. Needs
 * `CryptProtectData` (machine or service-account scope) via a native helper that
 * we have not built or verified. Selecting it fails closed.
 */
export class WindowsDpapiKeystore implements Keystore {
  readonly kind = 'windows-dpapi' as const;
  readonly location = 'Windows DPAPI (not implemented)';
  readonly accessControlVerified = false;
  load(): Promise<DeviceKey | null> {
    return Promise.reject(
      new KeystoreUnavailableError(this.kind, 'not implemented (UNVERIFIED); use "file"'),
    );
  }
  create(): Promise<DeviceKey> {
    return Promise.reject(
      new KeystoreUnavailableError(this.kind, 'not implemented (UNVERIFIED); use "file"'),
    );
  }
  createNext(): Promise<DeviceKey> {
    return this.create();
  }
  promoteNext(): Promise<DeviceKey> {
    return this.create();
  }
  loadNext(): Promise<DeviceKey | null> {
    return this.load();
  }
  discardNext(): Promise<void> {
    return this.load().then(() => undefined);
  }
}

export function createKeystore(kind: KeystoreKind, ops: FileOps, dataDir: string): Keystore {
  switch (kind) {
    case 'file':
      return new FileKeystore(ops, dataDir);
    case 'macos-keychain':
      if (ops.platform !== 'darwin') throw new KeystoreUnavailableError(kind, 'only available on macOS');
      return new MacKeychainKeystore();
    case 'windows-dpapi':
      if (ops.platform !== 'win32') throw new KeystoreUnavailableError(kind, 'only available on Windows');
      return new WindowsDpapiKeystore();
  }
}

/** Load the device key, generating it on first start (ADR-0005 §2). */
export async function loadOrCreateDeviceKey(
  keystore: Keystore,
): Promise<{ key: DeviceKey; created: boolean }> {
  const existing = await keystore.load();
  if (existing !== null) return { key: existing, created: false };
  return { key: await keystore.create(), created: true };
}
