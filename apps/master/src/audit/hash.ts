import { createHash } from 'node:crypto';
import type { JsonValue } from './redact.js';

/** Hash of the (virtual) row before the first audit event. */
export const GENESIS_HASH = Buffer.alloc(32, 0);

/** Deterministic JSON: object keys sorted recursively, no whitespace. Matches values read back from jsonb. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(',')}}`;
}

export interface HashedFields {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly outcome: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: { [key: string]: JsonValue };
  readonly prevHash: Buffer;
}

/** SHA-256 over a versioned canonical encoding of every column except `hash` itself. */
export function eventHash(f: HashedFields): Buffer {
  const doc: JsonValue = {
    v: 1,
    id: f.id,
    occurredAt: f.occurredAt.toISOString(),
    actorType: f.actorType,
    actorId: f.actorId,
    action: f.action,
    target: f.target,
    outcome: f.outcome,
    ip: f.ip,
    userAgent: f.userAgent,
    metadata: f.metadata,
    prevHash: f.prevHash.toString('hex'),
  };
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest();
}
