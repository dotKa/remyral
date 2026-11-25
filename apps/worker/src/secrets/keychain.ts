import { SecretStoreError } from './errors.js';
import { nodeExec, type ExecFn } from './exec.js';
import { SECRET_NAME, SecretString, assertSecretName, assertSecretValue } from './ref.js';
import type { SecretStore } from './store.js';

/** Frozen (p17-remyral-rebrand): the service attribute of keychain items already stored on installed Macs. */
export const KEYCHAIN_SERVICE = 'remana-worker';
/** Stored data is `rw1:` + base64(utf8 value): `security -w` prints non-printable data as hex, so we never store raw bytes. */
const PREFIX = 'rw1:';
/** `security` exit code for "The specified item could not be found in the keychain." */
const NOT_FOUND = 44;

export interface MacKeychainOptions {
  /** Keychain file; default: the user's default keychain / search list. */
  keychainPath?: string;
  /** Generic-password service attribute. Default `remana-worker` (frozen). */
  service?: string;
  exec?: ExecFn;
  securityBinary?: string;
}

/**
 * macOS Keychain store via the `security` CLI (generic passwords, service
 * `remyral-worker`, account = secret name).
 *
 *  - The value never appears in argv: `add-generic-password` runs inside
 *    `security -i` with the command line on stdin, data given hex-encoded (`-X`).
 *  - Reading uses `find-generic-password -w` (value on stdout of a child we own).
 *  - Listing parses `dump-keychain` *without* `-d` (attributes only, no secret data).
 *
 * Access control: items are created by `/usr/bin/security`, which is then on the
 * item's ACL, so any process of the same OS user that can run `security` can read
 * them without a prompt — the same boundary as the 0600 file store, but encrypted
 * at rest and outside the data directory. A daemon running outside the user's login
 * session needs an unlocked keychain (pass `keychainPath`; see the ops guide).
 */
export class MacKeychainSecretStore implements SecretStore {
  readonly kind = 'macos-keychain' as const;
  readonly location: string;
  readonly accessControlVerified = true;
  readonly #keychain: string[];
  readonly #service: string;
  readonly #exec: ExecFn;
  readonly #bin: string;

  constructor(options: MacKeychainOptions = {}) {
    if (options.keychainPath !== undefined && /[\s"'\\]/.test(options.keychainPath)) {
      // The path is part of a `security -i` command line; refuse anything that would need quoting.
      throw new SecretStoreError('keychainPath must not contain whitespace, quotes or backslashes');
    }
    this.#keychain = options.keychainPath === undefined ? [] : [options.keychainPath];
    this.#service = options.service ?? KEYCHAIN_SERVICE;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(this.#service))
      throw new SecretStoreError('invalid keychain service name');
    this.#exec = options.exec ?? nodeExec;
    this.#bin = options.securityBinary ?? '/usr/bin/security';
    this.location = `macOS Keychain (${options.keychainPath ?? 'default keychain'}, service ${this.#service})`;
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    assertSecretValue(value);
    const data = Buffer.from(`${PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8').toString(
      'hex',
    );
    const line = [
      'add-generic-password',
      '-U',
      '-a',
      name,
      '-s',
      this.#service,
      '-X',
      data,
      ...this.#keychain,
    ].join(' ');
    const r = await this.#exec(this.#bin, ['-i'], { input: `${line}\n` });
    if (r.code !== 0)
      throw new SecretStoreError(`security add-generic-password failed (exit ${String(r.code)})`);
    // `security -i` can exit 0 although the inner command failed: read back and compare.
    const stored = await this.get(name);
    if (stored?.reveal() !== value)
      throw new SecretStoreError(`keychain item "${name}" could not be written`);
  }

  async get(name: string): Promise<SecretString | null> {
    assertSecretName(name);
    const r = await this.#exec(this.#bin, [
      'find-generic-password',
      '-a',
      name,
      '-s',
      this.#service,
      '-w',
      ...this.#keychain,
    ]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0)
      throw new SecretStoreError(
        `security find-generic-password failed (exit ${String(r.code)}): ${firstLine(r.stderr)}`,
      );
    const data = r.stdout.replace(/\n$/, '');
    if (!data.startsWith(PREFIX)) {
      throw new SecretStoreError(
        `keychain item "${name}" was not written by remyral-worker (unexpected format)`,
      );
    }
    return new SecretString(Buffer.from(data.slice(PREFIX.length), 'base64').toString('utf8'));
  }

  async list(): Promise<string[]> {
    const r = await this.#exec(this.#bin, ['dump-keychain', ...this.#keychain]);
    if (r.code !== 0)
      throw new SecretStoreError(
        `security dump-keychain failed (exit ${String(r.code)}): ${firstLine(r.stderr)}`,
      );
    const names = new Set<string>();
    for (const block of r.stdout.split(/^keychain: /m)) {
      if (!/^class: "genp"$/m.test(block)) continue;
      const svce = /^\s*"svce"<blob>="([^"]*)"$/m.exec(block)?.[1];
      const acct = /^\s*"acct"<blob>="([^"]*)"$/m.exec(block)?.[1];
      if (svce === this.#service && acct !== undefined && SECRET_NAME.test(acct)) names.add(acct);
    }
    return [...names].sort();
  }

  async delete(name: string): Promise<boolean> {
    assertSecretName(name);
    const r = await this.#exec(this.#bin, [
      'delete-generic-password',
      '-a',
      name,
      '-s',
      this.#service,
      ...this.#keychain,
    ]);
    if (r.code === NOT_FOUND) return false;
    if (r.code !== 0)
      throw new SecretStoreError(
        `security delete-generic-password failed (exit ${String(r.code)}): ${firstLine(r.stderr)}`,
      );
    return true;
  }
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200);
}
