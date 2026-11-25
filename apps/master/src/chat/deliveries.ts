import { randomUUID } from 'node:crypto';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p20-outcome (docs/design/p20-outcome-contract.md, "Delivery outbox"): the leased, idempotent hand-off of a
 * system-written continuation turn — a plan continuation, a watch follow-up, a goal resume.
 *
 *  1. {@link claimDelivery}: one live claim per (kind, ref) with a fresh fencing token and a lease.
 *  2. `ChatService.send(…, { delivery })` → {@link fenceDelivery} in the message transaction (refuses a lost claim; the
 *     row records the message) and {@link completeDelivery} in the transaction that creates the turn ("sent" exists
 *     exactly when the turn exists; the kind's own mark is written with it).
 *  3. A delay {@link releaseDelivery}s the claim, a refusal {@link failDelivery}s it.
 *  4. {@link reapDeliveries}: a claim whose lease ran out without "sent" expires; a message it left without a turn is
 *     deleted. The owning service then claims again (plan: `cont_due` back; watch: `follow_up` still NULL).
 */

export type DeliveryKind = 'plan' | 'watch' | 'goal';

/** How long a claim may take to become a turn before another pass takes it again. */
export const DELIVERY_LEASE_MS = 2 * 60_000;

export interface DeliveryClaim {
  readonly key: string;
  readonly token: string;
}

/** The `send` option that makes a turn the delivery of a claim. */
export interface DeliveryRef {
  readonly key: string;
  readonly token: string;
}

/**
 * Claims the delivery `key` of (kind, ref): a new row, or the same key again after it was released / expired. Null when
 * another claim of the same record is live (another pass or replica sends it) or the key was already sent.
 */
export async function claimDelivery(
  db: Queryable,
  input: {
    readonly key: string;
    readonly kind: DeliveryKind;
    readonly refId: string;
    readonly threadId: string | null;
    readonly now: Date;
    readonly leaseMs?: number;
  },
): Promise<DeliveryClaim | null> {
  const token = randomUUID();
  const lease = new Date(input.now.getTime() + (input.leaseMs ?? DELIVERY_LEASE_MS));
  try {
    const { rows } = await db.query<{ key: string }>(
      `INSERT INTO chat_deliveries (key, kind, ref_id, thread_id, state, token, lease_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'claimed', $5, $6, $7, $7)
       ON CONFLICT (key) DO UPDATE
         SET state = 'claimed', token = EXCLUDED.token, lease_until = EXCLUDED.lease_until,
             attempts = chat_deliveries.attempts + 1, reason = NULL, updated_at = EXCLUDED.updated_at
         WHERE chat_deliveries.state IN ('released', 'expired')
       RETURNING key`,
      [input.key, input.kind, input.refId, input.threadId, token, lease, input.now],
    );
    return rows.length === 0 ? null : { key: input.key, token };
  } catch (err) {
    // The live-claim index: another claim of the same record (another key) is under way.
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

/**
 * In the transaction that adds the system message: the claim must still be this sender's (else `409
 * delivery_superseded` — the turn is never created twice); records the message. A message an expired attempt of the
 * same key left without a turn is removed first.
 */
export async function fenceDelivery(tx: Queryable, d: DeliveryRef, threadId: string): Promise<void> {
  const { rows } = await tx.query<{ state: string; token: string; message_id: string | null }>(
    `SELECT state, token::text AS token, message_id::text AS message_id FROM chat_deliveries WHERE key = $1 FOR UPDATE`,
    [d.key],
  );
  const r = rows[0];
  if (r?.state !== 'claimed' || r.token !== d.token) {
    throw new HttpError(409, 'delivery_superseded', 'This continuation was already delivered or taken over.');
  }
  await tx.query(
    `DELETE FROM chat_messages m
      WHERE m.thread_id = $1 AND m.meta->>'delivery' = $2
        AND NOT EXISTS (SELECT 1 FROM chat_turns t WHERE t.message_id = m.id)`,
    [threadId, d.key],
  );
}

/** After the message exists (same transaction as {@link fenceDelivery}). */
export async function noteDeliveryMessage(tx: Queryable, d: DeliveryRef, messageId: string): Promise<void> {
  await tx.query(`UPDATE chat_deliveries SET message_id = $3 WHERE key = $1 AND token = $2`, [
    d.key,
    d.token,
    messageId,
  ]);
}

/**
 * In the transaction that creates the turn (or after a sender that never reaches the chat service): "sent", fenced by
 * the token, plus the kind's own mark — the watch's `follow_up = 'sent'`, the plan's `cont_turn`. Idempotent: a
 * delivery already sent with this token is fine; a lost claim throws `409 delivery_superseded`.
 */
export async function completeDelivery(
  tx: Queryable,
  d: DeliveryRef,
  turnId: string,
  now: Date,
): Promise<void> {
  const { rows } = await tx.query<{ kind: DeliveryKind; ref_id: string }>(
    `UPDATE chat_deliveries SET state = 'sent', turn_id = $3, sent_at = $4, updated_at = $4
      WHERE key = $1 AND token = $2 AND state = 'claimed'
      RETURNING kind, ref_id::text AS ref_id`,
    [d.key, d.token, turnId, now],
  );
  const r = rows[0];
  if (r === undefined) {
    const { rows: done } = await tx.query(
      `SELECT 1 FROM chat_deliveries WHERE key = $1 AND token = $2 AND state = 'sent'`,
      [d.key, d.token],
    );
    if (done.length > 0) return;
    throw new HttpError(409, 'delivery_superseded', 'This continuation was already delivered or taken over.');
  }
  if (r.kind === 'watch') {
    await tx.query(`UPDATE chat_watches SET follow_up = 'sent' WHERE id = $1 AND follow_up IS NULL`, [
      r.ref_id,
    ]);
  } else if (r.kind === 'plan') {
    await tx.query(`UPDATE chat_plans SET cont_turn = $2 WHERE id = $1`, [r.ref_id, turnId]);
  }
}

/** Only delayed (a turn runs, the assistant is unavailable, a rate limit): the next pass claims it again. */
export async function releaseDelivery(
  db: Queryable,
  d: DeliveryRef,
  reason: string,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE chat_deliveries SET state = 'released', reason = $3, updated_at = $4
      WHERE key = $1 AND token = $2 AND state = 'claimed'`,
    [d.key, d.token, reason, now],
  );
}

/** Refused for good (budget, cost brake, another error): the owning service records what it means. */
export async function failDelivery(db: Queryable, d: DeliveryRef, reason: string, now: Date): Promise<void> {
  await db.query(
    `UPDATE chat_deliveries SET state = 'failed', reason = $3, updated_at = $4
      WHERE key = $1 AND token = $2 AND state = 'claimed'`,
    [d.key, d.token, reason, now],
  );
}

/**
 * Claims of `kind` whose lease ran out without "sent" (the process died between the claim and the turn, or the send
 * hung): expired, their turnless message removed. Returns the records they continued, for the owning service to take
 * up again.
 */
export async function reapDeliveries(
  pool: Pool,
  kind: DeliveryKind,
  now: Date,
): Promise<{ key: string; refId: string }[]> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ key: string; ref_id: string; message_id: string | null }>(
      `UPDATE chat_deliveries SET state = 'expired', reason = 'lease_expired', updated_at = $2
        WHERE kind = $1 AND state = 'claimed' AND lease_until < $2
        RETURNING key, ref_id::text AS ref_id, message_id::text AS message_id`,
      [kind, now],
    );
    const orphans = rows.map((r) => r.message_id).filter((m): m is string => m !== null);
    if (orphans.length > 0) {
      await tx.query(
        `DELETE FROM chat_messages m WHERE m.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM chat_turns t WHERE t.message_id = m.id)`,
        [orphans],
      );
    }
    return rows.map((r) => ({ key: r.key, refId: r.ref_id }));
  });
}

/** The live claim of a record, if any (the goal ledger: a continuation is under way). */
export async function liveDelivery(
  db: Queryable,
  kind: DeliveryKind,
  refId: string,
): Promise<{ key: string; leaseUntil: Date } | null> {
  const { rows } = await db.query<{ key: string; lease_until: Date }>(
    `SELECT key, lease_until FROM chat_deliveries WHERE kind = $1 AND ref_id = $2 AND state = 'claimed'`,
    [kind, refId],
  );
  return rows[0] === undefined ? null : { key: rows[0].key, leaseUntil: rows[0].lease_until };
}
