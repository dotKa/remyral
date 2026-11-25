import { join } from 'node:path';
import { TEMP_MARKER, atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { ensurePrivateDir } from '../fs/permissions.js';
import { SecretStoreError } from './errors.js';
import { nodeExec, type ExecFn } from './exec.js';
import { SECRET_NAME, SecretString, assertSecretName, assertSecretValue } from './ref.js';
import type { SecretStore } from './store.js';

export const DPAPI_DIR = 'secrets-dpapi';
const SUFFIX = '.dpapi';

/**
 * PowerShell scripts. Values travel base64-encoded over stdin/stdout (never argv) so
 * console code pages cannot mangle them. `ConvertFrom-SecureString` without `-Key`
 * uses DPAPI (CurrentUser scope): the blob only decrypts for the same Windows user
 * on the same machine.
 */
export const PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))',
  '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
  '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))',
].join('; ');

export const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$secure = ConvertTo-SecureString -String ([Console]::In.ReadToEnd().Trim())',
  "$plain = [System.Net.NetworkCredential]::new('', $secure).Password",
  '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))',
].join('; ');

export interface WindowsDpapiOptions {
  exec?: ExecFn;
  /** Default `powershell.exe` (Windows PowerShell 5.1 ships with every supported Windows). */
  powershell?: string;
}

/**
 * Windows store: `<dataDir>/secrets-dpapi/<name>.dpapi` holds the DPAPI-protected
 * blob produced by PowerShell `ConvertFrom-SecureString`; decryption only works as the
 * same Windows user on the same machine.
 *
 * **UNVERIFIED:** implemented against the documented cmdlets and tested only with a
 * fake PowerShell on macOS; not yet run on Windows (p2-service-windows / fleet CI).
 * Directory ACLs are the installer's job (`accessControlVerified` is false).
 */
export class WindowsDpapiSecretStore implements SecretStore {
  readonly kind = 'windows-dpapi' as const;
  readonly location: string;
  readonly accessControlVerified = false;
  readonly #exec: ExecFn;
  readonly #ps: string;

  constructor(
    private readonly ops: FileOps,
    dataDir: string,
    options: WindowsDpapiOptions = {},
  ) {
    this.location = join(dataDir, DPAPI_DIR);
    this.#exec = options.exec ?? nodeExec;
    this.#ps = options.powershell ?? 'powershell.exe';
  }

  #path(name: string): string {
    assertSecretName(name);
    return join(this.location, `${name}${SUFFIX}`);
  }

  async #powershell(script: string, input: string): Promise<string> {
    const r = await this.#exec(
      this.#ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        input,
      },
    );
    if (r.code !== 0) {
      // PowerShell errors describe the failing cmdlet, not the input; still keep only a short first line.
      throw new SecretStoreError(
        `DPAPI via PowerShell failed (exit ${String(r.code)}): ${(r.stderr.split('\n')[0] ?? '').slice(0, 200)}`,
      );
    }
    return r.stdout.trim();
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretValue(value);
    const path = this.#path(name);
    await ensurePrivateDir(this.ops, this.location);
    const blob = await this.#powershell(PROTECT_SCRIPT, Buffer.from(value, 'utf8').toString('base64'));
    if (!/^[0-9a-fA-F]{32,}$/.test(blob))
      throw new SecretStoreError('DPAPI returned an unexpected blob format');
    await atomicWriteFile(this.ops, path, `${blob}\n`, { mode: 0o600 });
  }

  async get(name: string): Promise<SecretString | null> {
    const path = this.#path(name);
    await ensurePrivateDir(this.ops, this.location);
    const raw = await this.ops.readFile(path, 256 * 1024);
    if (raw === null) return null;
    const blob = raw.toString('utf8').trim();
    if (!/^[0-9a-fA-F]{32,}$/.test(blob)) throw new SecretStoreError(`${path} is not a DPAPI blob`);
    const b64 = await this.#powershell(UNPROTECT_SCRIPT, blob);
    return new SecretString(Buffer.from(b64, 'base64').toString('utf8'));
  }

  async list(): Promise<string[]> {
    await ensurePrivateDir(this.ops, this.location);
    const entries = await this.ops.readdir(this.location);
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
    return true;
  }
}
