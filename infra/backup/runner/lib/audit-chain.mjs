// Audit hash-chain verification for a restored database (p10-backup-restore §5). Same algorithm as the master's
// apps/master/src/audit/hash.ts (eventHash v1 over canonical JSON) and audit.ts (verifyChain); a cross-check test
// (apps/master/test/unit/backup-runner-parity.test.ts) keeps both in step.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const GENESIS_HASH_HEX = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively, no whitespace (matches the master's canonicalJson). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`).join(',')}}`;
}

/** Hex SHA-256 of one audit row (`occurredAt` as ISO string with milliseconds, `prevHash` hex). */
export function eventHashHex(row) {
  const doc = {
    v: 1,
    id: row.id,
    occurredAt: row.occurredAt,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    target: row.target,
    outcome: row.outcome,
    ip: row.ip,
    userAgent: row.userAgent,
    metadata: row.metadata,
    prevHash: row.prevHash,
  };
  return createHash('sha256')
    .update(Buffer.from(canonicalJson(doc), 'utf8'))
    .digest('hex');
}

/** One batch of audit rows as JSON, in id order, after `afterId` (bigint compared numerically). */
export function auditBatchSql(afterId, limit) {
  if (!/^\d{1,19}$/.test(afterId)) throw new Error('invalid audit id');
  return `SELECT coalesce(json_agg(r ORDER BY r.n), '[]'::json) FROM (
    SELECT e.id AS n, e.id::text AS id,
           to_char(date_trunc('milliseconds', e.occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
           e.actor_type AS "actorType", e.actor_id AS "actorId", e.action, e.target, e.outcome, e.ip,
           e.user_agent AS "userAgent", e.metadata, encode(e.prev_hash, 'hex') AS "prevHash", encode(e.hash, 'hex') AS hash
      FROM audit_events e WHERE e.id > ${afterId} ORDER BY e.id LIMIT ${String(limit)}) r`;
}

/**
 * Recomputes the whole chain through `queryJson(sql)`. Returns
 * `{ ok: true, checked, headId, headHash }` or `{ ok: false, checked, brokenAtId, reason }`.
 */
export async function verifyAuditChain(queryJson, batchSize = 2000) {
  let expectedPrev = GENESIS_HASH_HEX;
  let lastId = '0';
  let checked = 0;
  for (;;) {
    const rows = await queryJson(auditBatchSql(lastId, batchSize));
    for (const r of rows) {
      if (r.prevHash !== expectedPrev)
        return { ok: false, checked, brokenAtId: r.id, reason: 'prev_hash_mismatch' };
      if (eventHashHex(r) !== r.hash)
        return { ok: false, checked, brokenAtId: r.id, reason: 'hash_mismatch' };
      expectedPrev = r.hash;
      lastId = r.id;
      checked += 1;
    }
    if (rows.length < batchSize) {
      return {
        ok: true,
        checked,
        headId: checked === 0 ? null : lastId,
        headHash: checked === 0 ? null : expectedPrev,
      };
    }
  }
}
