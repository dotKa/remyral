import { createHash } from 'node:crypto';
import { Redactor } from '@remyral/observability';
import type { Queryable } from '../../db/pool.js';

/**
 * Node-run data of engine 2 (p14-workflow-engine §2.2, §5.4): every value a node run uses or produces passes the
 * platform Redactor (secret patterns) string by string before it is stored; a value is kept inline up to 16 KiB and
 * otherwise stored once per run in `workflow_payloads` by SHA-256 (≤ 4 MiB each, ≤ 64 MiB per run) and referenced as
 * `{"$payload": sha, "size": n}`. What flows downstream is the stored (redacted) value.
 */

export const VALUE_LIMITS = {
  inlineBytes: 16 * 1024,
  payloadBytes: 4 * 1024 * 1024,
  runPayloadBytes: 64 * 1024 * 1024,
} as const;

export interface PayloadRef {
  readonly $payload: string;
  readonly size: number;
}

export class ValueLimitError extends Error {
  constructor(readonly code: 'value_too_large' | 'limit_exceeded') {
    super(code);
    this.name = 'ValueLimitError';
  }
}

const redactor = new Redactor();
/** Header names whose values are never stored or passed on (§5.4). */
const DENIED_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

/** A redacted copy: every string through the Redactor, credential-bearing header keys dropped. */
export function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (typeof v === 'string') return redactor.redact(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DENIED_KEYS.has(k.toLowerCase())) continue;
      out[k] = redactValue(x, depth + 1);
    }
    return out;
  }
  return v;
}

export function isPayloadRef(v: unknown): v is PayloadRef {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { $payload?: unknown }).$payload === 'string' &&
    Object.keys(v).length === 2
  );
}

export const byteSize = (v: unknown): number => {
  const s = JSON.stringify(v) as string | undefined;
  return s === undefined ? 0 : Buffer.byteLength(s, 'utf8');
};

/** Redacts a value and returns what to store (inline or a payload reference), writing the payload when needed. */
export async function storeValue(db: Queryable, runId: string, value: unknown, now: Date): Promise<unknown> {
  if (value === undefined) return null;
  const clean = redactValue(value);
  const json = JSON.stringify(clean);
  const size = Buffer.byteLength(json, 'utf8');
  if (size <= VALUE_LIMITS.inlineBytes) return clean;
  if (size > VALUE_LIMITS.payloadBytes) throw new ValueLimitError('value_too_large');
  const sha = createHash('sha256').update(json).digest('hex');
  const { rows } = await db.query<{ total: string | null }>(
    'SELECT sum(size_bytes)::text AS total FROM workflow_payloads WHERE run_id = $1',
    [runId],
  );
  if (Number(rows[0]?.total ?? 0) + size > VALUE_LIMITS.runPayloadBytes)
    throw new ValueLimitError('limit_exceeded');
  await db.query(
    `INSERT INTO workflow_payloads (run_id, sha256, size_bytes, content, redacted, created_at)
     VALUES ($1, $2, $3, $4, true, $5) ON CONFLICT (run_id, sha256) DO NOTHING`,
    [runId, sha, size, Buffer.from(json, 'utf8'), now],
  );
  return { $payload: sha, size } satisfies PayloadRef;
}

/** The value behind a stored value (payload references loaded; a pruned payload is `{"$pruned": true}`). */
export async function loadValue(db: Queryable, runId: string, stored: unknown): Promise<unknown> {
  if (!isPayloadRef(stored)) return stored;
  const { rows } = await db.query<{ content: Buffer | null }>(
    'SELECT content FROM workflow_payloads WHERE run_id = $1 AND sha256 = $2',
    [runId, stored.$payload],
  );
  const c = rows[0]?.content;
  if (c === undefined || c === null) return { $pruned: true };
  return JSON.parse(c.toString('utf8')) as unknown;
}
