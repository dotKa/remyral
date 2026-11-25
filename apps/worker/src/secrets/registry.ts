import type { SecretSet } from '@remyral/observability';

/**
 * Reference-counted registration of injected secret values in the daemon's shared
 * `SecretSet` (the one every logger / stream redactor of the daemon uses), so the
 * exact values are redacted from every log line, event and LOG_CHUNK while any job
 * that injected them is alive. Two jobs injecting the same API key share one entry;
 * the value is forgotten only when the last lease is released.
 */
export class SecretRegistry {
  readonly #counts = new Map<string, number>();

  constructor(readonly secrets: SecretSet) {}

  /** A per-job lease; call `release()` once the job's output streams are closed. */
  lease(): JobSecretLease {
    return new JobSecretLease(this.secrets, this.#counts);
  }

  /** Number of distinct registered values (for tests/metrics). */
  get size(): number {
    return this.#counts.size;
  }

  toJSON(): string {
    return `[SecretRegistry size=${String(this.#counts.size)}]`;
  }
}

export class JobSecretLease {
  readonly #values: string[] = [];
  #released = false;

  constructor(
    private readonly secrets: SecretSet,
    private readonly counts: Map<string, number>,
  ) {}

  /** Register `value` for exact-match redaction under `label` (an env var name, never the value). */
  add(value: string, label: string): void {
    if (this.#released) throw new Error('secret lease already released');
    const n = this.counts.get(value) ?? 0;
    if (n === 0) this.secrets.add(value, label);
    this.counts.set(value, n + 1);
    this.#values.push(value);
  }

  get count(): number {
    return this.#values.length;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (const value of this.#values.splice(0)) {
      const n = (this.counts.get(value) ?? 1) - 1;
      if (n <= 0) {
        this.counts.delete(value);
        this.secrets.delete(value);
      } else {
        this.counts.set(value, n);
      }
    }
  }

  toJSON(): string {
    return `[JobSecretLease count=${String(this.#values.length)}]`;
  }
}
