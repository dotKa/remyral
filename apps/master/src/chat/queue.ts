import { randomUUID } from 'node:crypto';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p22-chat-queue (docs/design/p22-chat-queue.md): the rows of messages written while the assistant is still answering.
 * They wait ("Sırada") until the running turn ends and are then delivered together as the next turn — each one its own
 * message row, the turn's input their texts in order. The service owns the delivery transaction; this module only holds
 * the SQL.
 */

/** At most this many messages wait in one conversation (the next one is refused `409 queue_full`). */
export const MAX_QUEUED_PER_THREAD = 20;

export interface QueuedMessageView {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  /** The number of files the message carries (bound to the message when it is delivered). */
  readonly attachments: number;
  /** Why the last delivery attempt waited (`assistant_unavailable`, `rate_limited`, `budget_exceeded`), else null. */
  readonly holdReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QueuedRow {
  readonly id: string;
  readonly user_id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly attachments: string[];
}

interface ViewRow extends QueuedRow {
  readonly hold_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const VIEW_COLUMNS = `id::text AS id, user_id::text AS user_id, content, meta, attachments::text[] AS attachments,
  hold_reason, created_at, updated_at`;

function view(r: ViewRow): QueuedMessageView {
  return {
    id: r.id,
    content: r.content,
    meta: r.meta,
    attachments: r.attachments.length,
    holdReason: r.hold_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Adds a queued message (the caller holds the conversation row lock; refuses past {@link MAX_QUEUED_PER_THREAD}). */
export async function insertQueued(
  tx: Queryable,
  input: {
    readonly threadId: string;
    readonly userId: string;
    readonly content: string;
    readonly meta: Record<string, unknown>;
    readonly attachments: readonly string[];
    readonly now: Date;
  },
): Promise<QueuedMessageView> {
  const { rows: n } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chat_queued_messages WHERE thread_id = $1 AND state = 'queued'`,
    [input.threadId],
  );
  if ((n[0]?.n ?? 0) >= MAX_QUEUED_PER_THREAD) {
    throw new HttpError(
      409,
      'queue_full',
      `At most ${String(MAX_QUEUED_PER_THREAD)} messages can wait in a conversation; wait for the answer or remove one.`,
    );
  }
  const { rows } = await tx.query<ViewRow>(
    `INSERT INTO chat_queued_messages (id, thread_id, user_id, content, meta, attachments, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], 'queued', $7, $7)
     RETURNING ${VIEW_COLUMNS}`,
    [
      randomUUID(),
      input.threadId,
      input.userId,
      input.content,
      JSON.stringify(input.meta),
      [...input.attachments],
      input.now,
    ],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('queued message not stored');
  return view(r);
}

/** The waiting messages of a conversation, oldest first. */
export async function listQueued(db: Queryable, threadId: string): Promise<QueuedMessageView[]> {
  const { rows } = await db.query<ViewRow>(
    `SELECT ${VIEW_COLUMNS} FROM chat_queued_messages WHERE thread_id = $1 AND state = 'queued' ORDER BY ord`,
    [threadId],
  );
  return rows.map(view);
}

/** Whether a conversation has waiting messages. */
export async function hasQueued(db: Queryable, threadId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM chat_queued_messages WHERE thread_id = $1 AND state = 'queued' LIMIT 1`,
    [threadId],
  );
  return rows.length > 0;
}

/**
 * Locks and returns the waiting messages of a conversation in order (inside the delivery transaction, after the
 * conversation row lock).
 */
export async function lockQueued(tx: Queryable, threadId: string): Promise<QueuedRow[]> {
  const { rows } = await tx.query<QueuedRow>(
    `SELECT id::text AS id, user_id::text AS user_id, content, meta, attachments::text[] AS attachments
       FROM chat_queued_messages WHERE thread_id = $1 AND state = 'queued' ORDER BY ord FOR UPDATE`,
    [threadId],
  );
  return rows;
}

/** Marks one queued row delivered as message `messageId` of turn `turnId` (fenced: only a row still queued). */
export async function markDelivered(
  tx: Queryable,
  id: string,
  messageId: string,
  turnId: string,
  now: Date,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE chat_queued_messages
        SET state = 'delivered', message_id = $2, turn_id = $3, delivered_at = $4, updated_at = $4, hold_reason = NULL
      WHERE id = $1 AND state = 'queued'`,
    [id, messageId, turnId, now],
  );
  return (rowCount ?? 0) > 0;
}

/** Records why a delivery attempt waited (shown under the bubbles; the sweep tries again). */
export async function holdQueued(db: Queryable, threadId: string, reason: string, now: Date): Promise<void> {
  await db.query(
    `UPDATE chat_queued_messages SET hold_reason = $2, updated_at = $3
      WHERE thread_id = $1 AND state = 'queued' AND hold_reason IS DISTINCT FROM $2`,
    [threadId, reason.replace(/[^a-z_]/g, '_').slice(0, 40), now],
  );
}

/** Changes the text of a waiting message (the caller's own, still queued; else 409 `message_not_queued`). */
export async function editQueued(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly threadId: string;
    readonly id: string;
    readonly content: string;
    readonly meta: Record<string, unknown> | null;
    readonly now: Date;
  },
): Promise<QueuedMessageView> {
  if (!UUID.test(input.id)) throw notQueued();
  const { rows } = await pool.query<ViewRow>(
    `UPDATE chat_queued_messages
        SET content = $4, meta = COALESCE($5::jsonb, meta), updated_at = $6
      WHERE id = $1 AND thread_id = $2 AND user_id = $3 AND state = 'queued'
      RETURNING ${VIEW_COLUMNS}`,
    [
      input.id,
      input.threadId,
      input.userId,
      input.content,
      input.meta === null ? null : JSON.stringify(input.meta),
      input.now,
    ],
  );
  const r = rows[0];
  if (r === undefined) throw notQueued();
  return view(r);
}

/** Removes a waiting message before it is delivered (the caller's own; else 409 `message_not_queued`). */
export async function cancelQueued(
  pool: Pool,
  input: { readonly userId: string; readonly threadId: string; readonly id: string; readonly now: Date },
): Promise<void> {
  if (!UUID.test(input.id)) throw notQueued();
  const { rowCount } = await pool.query(
    `UPDATE chat_queued_messages SET state = 'cancelled', updated_at = $4
      WHERE id = $1 AND thread_id = $2 AND user_id = $3 AND state = 'queued'`,
    [input.id, input.threadId, input.userId, input.now],
  );
  if ((rowCount ?? 0) === 0) throw notQueued();
}

/**
 * The conversations whose waiting messages can be delivered now: no open turn and none ended in the last `quietMs`
 * (a turn that ends and is continued elsewhere — failover, a restart re-run — gets its successor first).
 */
export async function readyThreads(db: Queryable, now: Date, quietMs: number, limit = 50): Promise<string[]> {
  const { rows } = await db.query<{ thread_id: string }>(
    `SELECT DISTINCT q.thread_id::text AS thread_id FROM chat_queued_messages q
      WHERE q.state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM chat_turns t WHERE t.thread_id = q.thread_id AND t.state IN ('sent', 'running'))
        AND NOT EXISTS (SELECT 1 FROM chat_turns t WHERE t.thread_id = q.thread_id AND t.finished_at > $1)
      LIMIT $2`,
    [new Date(now.getTime() - quietMs), limit],
  );
  return rows.map((r) => r.thread_id);
}

function notQueued(): HttpError {
  return new HttpError(
    409,
    'message_not_queued',
    'This message is no longer waiting; it was sent or removed.',
  );
}
