import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';
const values = new WeakMap<SecretValue, string>();

/**
 * Opaque handle for a secret injected into a runtime's environment (ADR-0006).
 * The value is not an own property, so `JSON.stringify`, `String()`,
 * template literals and `util.inspect` all render `[REDACTED]`. The only way
 * to read it is `reveal()`, which only the process helper calls when it builds
 * the child's environment.
 */
export class SecretValue {
  constructor(value: string) {
    if (value.length === 0) throw new TypeError('secret value must not be empty');
    values.set(this, value);
  }

  /** Read the plaintext. Call sites must be limited to building a child env. */
  reveal(): string {
    const value = values.get(this);
    if (value === undefined) throw new Error('secret handle is not initialised');
    return value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Env-var name -> secret handle, e.g. { ANTHROPIC_API_KEY: SecretValue }. */
export type SecretEnv = Readonly<Record<string, SecretValue>>;

/** Replace every occurrence of any secret value in `text` (defence in depth for logs/tails). */
export function redactSecrets(text: string, secrets: SecretEnv): string {
  let out = text;
  for (const secret of Object.values(secrets)) {
    const value = secret.reveal();
    if (value.length > 0) out = out.split(value).join(REDACTED);
  }
  return out;
}

/** True if any secret value occurs in `text`. */
export function containsSecret(text: string, secrets: SecretEnv): boolean {
  return Object.values(secrets).some((s) => text.includes(s.reveal()));
}
