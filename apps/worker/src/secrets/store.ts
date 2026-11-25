import { join } from 'node:path';
import { z } from 'zod';
import { TEMP_MARKER, atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { assertPrivateFile, ensurePrivateDir } from '../fs/permissions.js';
import { SecretStoreError } from './errors.js';
import { SECRET_NAME, SecretString, assertSecretName, assertSecretValue } from './ref.js';

export type SecretStoreKind = 'file' | 'macos-keychain' | 'windows-dpapi';

/**
 * Worker-side store for provider credentials (ADR-0006 §2). Values are only read at
 * job spawn time (env injection) — never listed, logged, or sent to the master.
 */
export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** Human-readable location (no secrets). */
  readonly location: string;
  /** Whether the OS access control of the store was verified by this code on this platform. */
  readonly accessControlVerified: boolean;
  set(name: string, value: string): Promise<void>;
  /** `null` when not stored. */
  get(name: string): Promise<SecretString | null>;
  /** Names only, sorted. */
  list(): Promise<string[]>;
  /** `true` if something was removed. */
  delete(name: string): Promise<boolean>;
}

export const SECRETS_DIR = 'secrets';
const SUFFIX = '.json';

const SecretFile = z.strictObject({
  version: z.literal(1),
  value: z.string().min(1),
  updatedAt: z.string(),
});

/**
 * File store: one file per secret, `<dataDir>/secrets/<name>.json`, created 0600 with
 * O_EXCL and replaced atomically; directory 0700. Same permission model as the device
 * key (`FileKeystore`): on POSIX a symlinked, foreign-owned or group/other-readable
 * file, or a group/other-writable directory, is refused (InsecurePermissionsError).
 * Windows: NTFS ACLs are the installer's job — `accessControlVerified` is false.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly location: string;
  readonly accessControlVerified: boolean;

  constructor(
    private readonly ops: FileOps,
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.location = join(dataDir, SECRETS_DIR);
    this.accessControlVerified = ops.platform !== 'win32';
  }

  #path(name: string): string {
    assertSecretName(name);
    return join(this.location, `${name}${SUFFIX}`);
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretValue(value);
    const path = this.#path(name);
    await ensurePrivateDir(this.ops, this.location);
    await assertPrivateFile(this.ops, path);
    const file: z.infer<typeof SecretFile> = { version: 1, value, updatedAt: this.now().toISOString() };
    await atomicWriteFile(this.ops, path, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  }

  async get(name: string): Promise<SecretString | null> {
    const path = this.#path(name);
    await ensurePrivateDir(this.ops, this.location);
    // Check before reading: never follow a planted symlink to someone else's file.
    await assertPrivateFile(this.ops, path);
    const raw = await this.ops.readFile(path, 64 * 1024);
    if (raw === null) return null;
    try {
      return new SecretString(SecretFile.parse(JSON.parse(raw.toString('utf8'))).value);
    } catch (error) {
      // The cause (a Zod/JSON error) could quote file content; keep only its type.
      throw new SecretStoreError(
        `${path} is not a valid secret file (${error instanceof Error ? error.name : 'error'})`,
      );
    }
  }

  async list(): Promise<string[]> {
    await ensurePrivateDir(this.ops, this.location);
    const entries = await this.ops.readdir(this.location);
    // Leftovers of interrupted writes: `<name>.json.tmp-<pid>-<rand>`.
    for (const f of entries)
      if (f.includes(`${SUFFIX}${TEMP_MARKER}`)) await this.ops.unlink(join(this.location, f));
    return entries
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => f.slice(0, -SUFFIX.length))
      .filter((n) => SECRET_NAME.test(n))
      .sort();
  }

  async delete(name: string): Promise<boolean> {
    const path = this.#path(name);
    await ensurePrivateDir(this.ops, this.location);
    if ((await this.ops.lstat(path)) === null) return false;
    await this.ops.unlink(path);
    await this.ops.fsyncDir(this.location);
    return true;
  }
}
