import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { Timestamp, vaultKeyId, X25519PublicKey } from '@remyral/protocol';
import { z } from 'zod';
import { atomicWriteFile, removeStaleTemps } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { assertPrivateFile, ensurePrivateDir } from '../fs/permissions.js';

/**
 * The worker's X25519 **vault key** (p5-credentials-models, ADR-0016): the panel's browser seals credential
 * values to its public half; only this worker can open them. `<dataDir>/vault-key.json`, 0600, written
 * atomically, same permission model as the device key (FileKeystore). After a rotation the previous key is
 * kept (one generation) so a value sealed just before the rotation still opens.
 */
export const VAULT_KEY_FILE = 'vault-key.json';

type Subtle = typeof globalThis.crypto.subtle;
export type VaultCryptoKey = Awaited<ReturnType<Subtle['importKey']>>;
const subtle: Subtle = webcrypto.subtle;

const StoredKey = z.strictObject({
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  publicKey: X25519PublicKey,
  /** PKCS#8 DER, base64. */
  privateKeyPkcs8: z.string().min(1).max(512),
  createdAt: Timestamp,
});
type StoredKey = z.infer<typeof StoredKey>;

const KeyFile = z.strictObject({
  version: z.literal(1),
  current: StoredKey,
  previous: StoredKey.nullable(),
});
type KeyFile = z.infer<typeof KeyFile>;

export class VaultKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VaultKeyError';
  }
}

/** A usable vault key: public metadata plus the non-extractable private CryptoKey. */
export interface VaultKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly createdAt: string;
  readonly privateKey: VaultCryptoKey;
}

async function generate(now: Date): Promise<StoredKey> {
  const pair = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: VaultCryptoKey;
    privateKey: VaultCryptoKey;
  };
  const publicKey = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return {
    keyId: await vaultKeyId(publicKey),
    publicKey,
    privateKeyPkcs8: pkcs8,
    createdAt: now.toISOString(),
  };
}

async function usable(k: StoredKey): Promise<VaultKey> {
  let privateKey: VaultCryptoKey;
  try {
    privateKey = await subtle.importKey(
      'pkcs8',
      Buffer.from(k.privateKeyPkcs8, 'base64'),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    );
  } catch (error) {
    throw new VaultKeyError('the stored vault key is unreadable', { cause: error });
  }
  if ((await vaultKeyId(k.publicKey)) !== k.keyId) throw new VaultKeyError('vault key id does not match');
  return { keyId: k.keyId, publicKey: k.publicKey, createdAt: k.createdAt, privateKey };
}

export class VaultKeyStore {
  #current: VaultKey;
  #previous: VaultKey | null;

  private constructor(
    private readonly ops: FileOps,
    private readonly path: string,
    current: VaultKey,
    previous: VaultKey | null,
    private readonly clock: () => Date,
  ) {
    this.#current = current;
    this.#previous = previous;
  }

  /** Loads the key, generating it on first start (also the upgrade path of an existing worker). */
  static async open(
    ops: FileOps,
    dataDir: string,
    clock: () => Date = () => new Date(),
  ): Promise<{ store: VaultKeyStore; created: boolean }> {
    const path = join(dataDir, VAULT_KEY_FILE);
    await ensurePrivateDir(ops, dataDir);
    await removeStaleTemps(ops, dataDir, VAULT_KEY_FILE);
    await assertPrivateFile(ops, path);
    const raw = await ops.readFile(path, 8192);
    if (raw === null) {
      const current = await generate(clock());
      await write(ops, path, { version: 1, current, previous: null });
      return { store: new VaultKeyStore(ops, path, await usable(current), null, clock), created: true };
    }
    let file: KeyFile;
    try {
      file = KeyFile.parse(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      throw new VaultKeyError(`${path} is not a valid vault key file`, { cause: error });
    }
    const current = await usable(file.current);
    const previous = file.previous === null ? null : await usable(file.previous);
    return { store: new VaultKeyStore(ops, path, current, previous, clock), created: false };
  }

  get location(): string {
    return this.path;
  }

  get current(): VaultKey {
    return this.#current;
  }

  get previous(): VaultKey | null {
    return this.#previous;
  }

  /** The current or previous key with this id (null: unknown). */
  byId(keyId: string): VaultKey | null {
    if (this.#current.keyId === keyId) return this.#current;
    if (this.#previous?.keyId === keyId) return this.#previous;
    return null;
  }

  /** Generates a new key; the current one becomes `previous` (the one before is discarded). */
  async rotate(): Promise<VaultKey> {
    const raw = await this.ops.readFile(this.path, 8192);
    if (raw === null) throw new VaultKeyError(`${this.path} disappeared`);
    const file = KeyFile.parse(JSON.parse(raw.toString('utf8')));
    const next = await generate(this.clock());
    await write(this.ops, this.path, { version: 1, current: next, previous: file.current });
    this.#previous = this.#current;
    this.#current = await usable(next);
    return this.#current;
  }

  toJSON(): { keyId: string; publicKey: string } {
    return { keyId: this.#current.keyId, publicKey: this.#current.publicKey };
  }
}

async function write(ops: FileOps, path: string, file: KeyFile): Promise<void> {
  await atomicWriteFile(ops, path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
}
