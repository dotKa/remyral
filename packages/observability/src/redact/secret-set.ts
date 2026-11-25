/** Anything that can reveal a secret string, e.g. `SecretValue` from @remyral/agent-adapters. */
export interface Revealable {
  reveal(): string;
}

/**
 * Secrets shorter than this are refused: exact-value redaction of a 3-character
 * "secret" would shred ordinary output, and such a value is not a credential.
 */
export const MIN_SECRET_LENGTH = 6;

export class SecretTooShortError extends Error {
  constructor(readonly label: string) {
    super(
      `secret "${label}" is shorter than ${String(MIN_SECRET_LENGTH)} characters and cannot be redacted safely`,
    );
    this.name = 'SecretTooShortError';
  }
}

/**
 * The registered set of secret values for exact-match redaction (ADR-0006 §4, first
 * pass). Each value is stored together with the encodings it commonly shows up in
 * inside logs: URL-encoded, JSON-escaped and base64/base64url.
 *
 * The set never exposes its values: there is no getter, and `toJSON`/inspect return
 * a count only.
 */
export class SecretSet {
  readonly #variants = new Map<string, string>();
  #version = 0;

  /** Register a secret. `label` (e.g. the env-var name) must not itself be secret. */
  add(secret: string | Revealable, label = 'secret'): void {
    const value = typeof secret === 'string' ? secret : secret.reveal();
    if (value.length < MIN_SECRET_LENGTH) throw new SecretTooShortError(label);
    for (const variant of encodings(value)) {
      if (variant.length >= MIN_SECRET_LENGTH && !this.#variants.has(variant)) {
        this.#variants.set(variant, label);
      }
    }
    this.#version++;
  }

  /** Forget a secret (e.g. after a job ends and its token expired). */
  delete(secret: string | Revealable): void {
    const value = typeof secret === 'string' ? secret : secret.reveal();
    for (const variant of encodings(value)) this.#variants.delete(variant);
    this.#version++;
  }

  clear(): void {
    this.#variants.clear();
    this.#version++;
  }

  get size(): number {
    return this.#variants.size;
  }

  /** Bumped on every change, so caches (stream lookbehind) can be refreshed. */
  get version(): number {
    return this.#version;
  }

  /** Length of the longest registered variant; 0 if empty. */
  maxLength(): number {
    let max = 0;
    for (const v of this.#variants.keys()) max = Math.max(max, v.length);
    return max;
  }

  /** Internal: variants for the matcher, longest first. */
  entries(): [value: string, label: string][] {
    return [...this.#variants.entries()].sort((a, b) => b[0].length - a[0].length);
  }

  toJSON(): string {
    return `[SecretSet size=${String(this.#variants.size)}]`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toJSON();
  }
}

function encodings(value: string): Set<string> {
  const out = new Set<string>([value]);
  out.add(encodeURIComponent(value));
  out.add(JSON.stringify(value).slice(1, -1));
  const bytes = Buffer.from(value, 'utf8');
  out.add(bytes.toString('base64').replace(/=+$/, ''));
  out.add(bytes.toString('base64url'));
  return out;
}
