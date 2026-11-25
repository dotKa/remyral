import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import { eventHash, GENESIS_HASH } from './hash.js';
import { type JsonValue, redactMetadata } from './redact.js';
import { auditRequestContext } from './request-context.js';

export type ActorType = 'user' | 'worker' | 'system' | 'anonymous';
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'error';

export interface AuditEventInput {
  readonly actor: { readonly type: ActorType; readonly id?: string | null };
  /** Dotted lower-case verb, e.g. `auth.login.password`, `user.create`. */
  readonly action: string;
  readonly target?: string | null;
  readonly outcome: AuditOutcome;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** Identifiers and reasons only. Sensitive keys are redacted before storage. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RecordedAuditEvent {
  readonly id: string;
  readonly hash: Buffer;
}

export interface AuditRecorder {
  record(event: AuditEventInput, tx?: Queryable): Promise<RecordedAuditEvent>;
}

/** Advisory-lock key serialising appends to the hash chain (`audit` in ASCII). */
export const AUDIT_LOCK_KEY = 0x6175646974n;

const ACTION = /^[a-z][a-z0-9_.-]{0,99}$/;

function clip(s: string | null | undefined, max: number): string | null {
  if (s === undefined || s === null) return null;
  const cleaned = s.replaceAll('\u0000', '');
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/**
 * The single writer of `audit_events`. Every append takes a transaction-scoped advisory lock, reads the
 * previous hash and inserts the new row with `prev_hash`/`hash`, so the chain is linear even with
 * concurrent writers. Pass `tx` to make the audit row part of the caller's transaction (the lock is then
 * held until that transaction ends — keep such transactions short).
 */
export class AuditLog implements AuditRecorder {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(event: AuditEventInput, tx?: Queryable): Promise<RecordedAuditEvent> {
    if (!ACTION.test(event.action)) throw new Error(`invalid audit action: ${event.action}`);
    if (tx) return this.append(tx, event);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.append(client, event);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async append(db: Queryable, event: AuditEventInput): Promise<RecordedAuditEvent> {
    await db.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY.toString()]);
    const prev = await db.query<{ hash: Buffer }>('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1');
    const prevHash = prev.rows[0]?.hash ?? GENESIS_HASH;
    const idRow = await db.query<{ id: string }>("SELECT nextval('audit_events_id_seq')::text AS id");
    const id = idRow.rows[0]?.id;
    if (id === undefined) throw new Error('audit: could not allocate id');

    // p16-api-tokens: entries written while serving a token request name the token (id only).
    const context = auditRequestContext.getStore();
    const viaApi = context?.apiTokenId;
    const tokenMarked =
      viaApi === undefined || event.actor.type !== 'user' || event.metadata?.viaApi !== undefined
        ? event.metadata
        : { ...event.metadata, viaApi };
    // p16-assistant-admin: entries written while a change made through the chat runs say so (`source: chat`).
    const source = context?.source;
    const metadata =
      source === undefined || (tokenMarked !== undefined && Object.hasOwn(tokenMarked, 'source'))
        ? tokenMarked
        : { ...tokenMarked, source };
    const fields = {
      id,
      occurredAt: this.clock(),
      actorType: event.actor.type,
      actorId: clip(event.actor.id, 200),
      action: event.action,
      target: clip(event.target, 500),
      outcome: event.outcome,
      ip: clip(event.ip, 100),
      userAgent: clip(event.userAgent, 500),
      metadata: redactMetadata(metadata),
      prevHash,
    };
    const hash = eventHash(fields);
    await db.query(
      `INSERT INTO audit_events
         (id, occurred_at, actor_type, actor_id, action, target, outcome, ip, user_agent, metadata, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        fields.id,
        fields.occurredAt,
        fields.actorType,
        fields.actorId,
        fields.action,
        fields.target,
        fields.outcome,
        fields.ip,
        fields.userAgent,
        JSON.stringify(fields.metadata),
        prevHash,
        hash,
      ],
    );
    return { id, hash };
  }
}

export type ChainVerification =
  | {
      readonly ok: true;
      readonly checked: number;
      readonly headHash: Buffer;
      /** Id of the last row checked (null when the range was empty). */
      readonly lastCheckedId?: string | null;
    }
  | {
      readonly ok: false;
      readonly checked: number;
      readonly brokenAtId: string;
      readonly reason: 'prev_hash_mismatch' | 'hash_mismatch';
    };

export interface ChainRange {
  /** First id to check (inclusive). Its predecessor's stored hash is trusted as the anchor. */
  readonly fromId?: string | null;
  /** Last id to check (inclusive). */
  readonly toId?: string | null;
  readonly batchSize?: number;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  outcome: string;
  ip: string | null;
  user_agent: string | null;
  metadata: { [key: string]: JsonValue };
  prev_hash: Buffer;
  hash: Buffer;
}

/**
 * Recomputes the whole chain in id order. Detects edited rows (hash mismatch), deleted or reordered rows
 * (prev_hash mismatch) and rows inserted out of band. Truncation of the newest rows is detectable only
 * against an exported head hash (`headHash`), which off-host export (p1-backups) keeps.
 */
export async function verifyChain(db: Queryable, batchSize = 1000): Promise<ChainVerification> {
  return verifyChainRange(db, { batchSize });
}

/**
 * `verifyChain` over `[fromId, toId]` (docs/design/p5-search-audit.md §3). Without `fromId` the check starts
 * at the genesis hash; with it, the stored hash of the row before `fromId` is the trusted anchor, so a range
 * check proves the links inside the range only.
 */
export async function verifyChainRange(db: Queryable, range: ChainRange = {}): Promise<ChainVerification> {
  const batchSize = range.batchSize ?? 1000;
  let expectedPrev: Buffer = GENESIS_HASH;
  let lastId = '0';
  if (range.fromId !== undefined && range.fromId !== null) {
    const prev = await db.query<{ id: string; hash: Buffer }>(
      'SELECT id::text AS id, hash FROM audit_events WHERE id < $1::bigint ORDER BY audit_events.id DESC LIMIT 1',
      [range.fromId],
    );
    const anchor = prev.rows[0];
    // Nothing before fromId: the range starts at the beginning of the chain (genesis anchor).
    if (anchor) {
      expectedPrev = anchor.hash;
      lastId = anchor.id;
    }
  }
  const toId = range.toId ?? null;
  let checked = 0;
  let lastChecked: string | null = null;
  for (;;) {
    // Order by the bigint column (not the text alias) so ids compare numerically.
    const { rows } = await db.query<AuditRow>(
      `SELECT e.id::text AS id, e.occurred_at, e.actor_type, e.actor_id, e.action, e.target, e.outcome, e.ip,
              e.user_agent, e.metadata, e.prev_hash, e.hash
         FROM audit_events e
        WHERE e.id > $1::bigint AND ($3::bigint IS NULL OR e.id <= $3::bigint)
        ORDER BY e.id LIMIT $2`,
      [lastId, batchSize, toId],
    );
    for (const r of rows) {
      if (!r.prev_hash.equals(expectedPrev)) {
        return { ok: false, checked, brokenAtId: r.id, reason: 'prev_hash_mismatch' };
      }
      const recomputed = eventHash({
        id: r.id,
        occurredAt: r.occurred_at,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        target: r.target,
        outcome: r.outcome,
        ip: r.ip,
        userAgent: r.user_agent,
        metadata: r.metadata,
        prevHash: r.prev_hash,
      });
      if (!recomputed.equals(r.hash))
        return { ok: false, checked, brokenAtId: r.id, reason: 'hash_mismatch' };
      expectedPrev = r.hash;
      lastId = r.id;
      lastChecked = r.id;
      checked += 1;
    }
    if (rows.length < batchSize) {
      return { ok: true, checked, headHash: expectedPrev, lastCheckedId: lastChecked };
    }
  }
}
