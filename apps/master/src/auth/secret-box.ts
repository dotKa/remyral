import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Symmetric protection for auth secrets, keyed from one 32-byte master key (ADR-0009 §4, ADR-0006):
 * - AES-256-GCM encryption of TOTP secrets, bound to their row via AAD (`totp:<userId>`);
 * - an HMAC-SHA256 pepper for recovery-code hashes (a DB dump alone cannot brute-force them).
 * Sub-keys are derived with HKDF so the two uses never share key material.
 *
 * Production: the key file is provisioned from the secret manager (p1-secrets / ADR-0006) and mounted
 * read-only, mode 0600. Development: `pnpm dev:keygen`.
 */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export class SecretBoxError extends Error {
  override name = 'SecretBoxError';
}

export class SecretBox {
  readonly #encKey: Buffer;
  readonly #macKey: Buffer;
  readonly #master: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new SecretBoxError('master key must be exactly 32 bytes');
    this.#master = Buffer.from(masterKey);
    // Frozen (p17-remyral-rebrand): HKDF info strings of keys for data at rest — renaming them would make every stored
    // TOTP secret, recovery code, token hash and sealed secret unreadable (docs/design/p17-remyral-rebrand.md).
    this.#encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'remana/totp-secret/v1', 32));
    this.#macKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'remana/recovery-code/v1', 32));
  }

  /** Reads a key file containing the base64 encoding of 32 random bytes. Never logs the content. */
  static async fromKeyFile(path: string): Promise<SecretBox> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      throw new SecretBoxError(
        `cannot read key file (TOTP_KEY_FILE): ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== 32) throw new SecretBoxError('key file must contain base64 of exactly 32 bytes');
    return new SecretBox(key);
  }

  encrypt(plaintext: Buffer, aad: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.#encKey, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): Buffer {
    if (blob.length < 1 + IV_LEN + TAG_LEN + 1 || blob[0] !== VERSION) {
      throw new SecretBoxError('unsupported ciphertext');
    }
    const iv = blob.subarray(1, 1 + IV_LEN);
    const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const ct = blob.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.#encKey, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new SecretBoxError('decryption failed');
    }
  }

  /**
   * A further independent 32-byte sub-key (HKDF-SHA256, info `remana/<label>/v1`, frozen: keys of data at rest) for another feature
   * (p5-coolify-sso: sealing of SSO request state). Labels used here must never be reused for other purposes.
   */
  deriveKey(label: string): Buffer {
    if (!/^[a-z0-9-]{1,32}$/.test(label) || label === 'totp-secret' || label === 'recovery-code') {
      throw new SecretBoxError('invalid sub-key label');
    }
    return Buffer.from(hkdfSync('sha256', this.#master, Buffer.alloc(0), `remana/${label}/v1`, 32));
  }

  /** Keyed hash used for recovery codes. */
  mac(data: string): Buffer {
    return createHmac('sha256', this.#macKey).update(data, 'utf8').digest();
  }
}
