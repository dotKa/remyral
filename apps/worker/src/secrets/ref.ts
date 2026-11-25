import { inspect } from 'node:util';
import type { Revealable } from '@remyral/observability';
import {
  ForeignSecretRefError,
  InvalidSecretNameError,
  InvalidSecretRefError,
  InvalidSecretValueError,
} from './errors.js';

/** Secret names are file names (file store) and keychain accounts: no dots, slashes or spaces. */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) throw new InvalidSecretNameError(name);
}

/** Worker ids follow the protocol `Identifier`. */
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Reference to a secret held on a worker (ADR-0006 §2): `worker:<workerId>/secret:<name>`.
 * The master stores only the reference; the value never leaves the worker. Config files
 * may use the local short form `secret:<name>` (this worker).
 */
export interface SecretRef {
  /** `null` for the short form. */
  readonly workerId: string | null;
  readonly name: string;
}

export function parseSecretRef(raw: string): SecretRef {
  const short = /^secret:(.+)$/.exec(raw);
  if (short !== null) {
    const name = short[1] ?? '';
    assertSecretName(name);
    return { workerId: null, name };
  }
  const full = /^worker:([^/]+)\/secret:(.+)$/.exec(raw);
  if (full === null) {
    throw new InvalidSecretRefError('expected "worker:<workerId>/secret:<name>" or "secret:<name>"');
  }
  const workerId = full[1] ?? '';
  const name = full[2] ?? '';
  if (!WORKER_ID.test(workerId)) throw new InvalidSecretRefError('invalid worker id');
  assertSecretName(name);
  return { workerId, name };
}

export function formatSecretRef(workerId: string, name: string): string {
  if (!WORKER_ID.test(workerId)) throw new InvalidSecretRefError('invalid worker id');
  assertSecretName(name);
  return `worker:${workerId}/secret:${name}`;
}

/** Resolve a reference for this worker; a full reference must name this worker. */
export function localSecretName(ref: SecretRef, thisWorkerId: string | null, raw: string): string {
  if (ref.workerId !== null && ref.workerId !== thisWorkerId)
    throw new ForeignSecretRefError(raw, thisWorkerId);
  return ref.name;
}

/** Bounds every store enforces on a value. */
export const MIN_SECRET_VALUE_LENGTH = 6;
export const MAX_SECRET_VALUE_LENGTH = 16 * 1024;

export function assertSecretValue(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    // Exact-value redaction refuses shorter values (observability MIN_SECRET_LENGTH).
    throw new InvalidSecretValueError(`must be at least ${String(MIN_SECRET_VALUE_LENGTH)} characters`);
  }
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    throw new InvalidSecretValueError(`must be at most ${String(MAX_SECRET_VALUE_LENGTH)} characters`);
  }
  if (value.includes('\0')) throw new InvalidSecretValueError('must not contain NUL');
}

const REDACTED = '[REDACTED]';
const values = new WeakMap<SecretString, string>();

/**
 * Opaque secret handle (structurally compatible with `SecretValue` from
 * @remyral/agent-adapters). The plaintext lives in a module-private WeakMap, so it
 * cannot be reached through the object; `toString`/`toJSON`/`inspect` print a marker.
 */
export class SecretString implements Revealable {
  constructor(value: string) {
    if (value.length === 0) throw new InvalidSecretValueError('must not be empty');
    values.set(this, value);
  }

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
