import type { Queryable } from '../db/pool.js';
import type { ActorType, AuditOutcome } from './audit.js';
import type { JsonValue } from './redact.js';
import { BIGINT_ID, decodeCursor, encodeCursor, escapeLike, searchTerms, SqlParams } from './sql.js';

/**
 * Read model of the hash-chained audit log (docs/design/p5-search-audit.md §3). Never writes; the only
 * writer of `audit_events` stays `AuditLog`.
 */

export const ACTOR_TYPES = ['user', 'worker', 'system', 'anonymous'] as const satisfies readonly ActorType[];
export const OUTCOMES = ['success', 'failure', 'denied', 'error'] as const satisfies readonly AuditOutcome[];

export interface AuditFilter {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly actorType?: ActorType | undefined;
  readonly actorId?: string | undefined;
  /** Prefix of the dotted action, matched literally (`auth.` matches `auth.login.password`). */
  readonly action?: string | undefined;
  readonly target?: string | undefined;
  readonly outcome?: AuditOutcome | undefined;
  /** Free text; every whitespace-separated term must occur (case-insensitive substring). */
  readonly q?: string | undefined;
}

export interface AuditEventView {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actor: { readonly type: ActorType; readonly id: string | null };
  readonly action: string;
  readonly target: string | null;
  readonly outcome: AuditOutcome;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: { [key: string]: JsonValue };
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditPage {
  readonly items: AuditEventView[];
  readonly nextCursor: string | null;
}

interface Row {
  id: string;
  occurred_at: Date;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  ip: string | null;
  user_agent: string | null;
  metadata: { [key: string]: JsonValue };
  prev_hash: Buffer;
  hash: Buffer;
}

const COLUMNS = `id::text AS id, occurred_at, actor_type, actor_id, action, target, outcome, ip, user_agent,
  metadata, prev_hash, hash`;

export const MAX_PAGE = 200;

function toView(r: Row): AuditEventView {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    actor: { type: r.actor_type, id: r.actor_id },
    action: r.action,
    target: r.target,
    outcome: r.outcome,
    ip: r.ip,
    userAgent: r.user_agent,
    metadata: r.metadata,
    prevHash: r.prev_hash.toString('hex'),
    hash: r.hash.toString('hex'),
  };
}

/** Adds the filter conditions to `p`. Every value is a bound parameter; the SQL text is static. */
export function addAuditFilter(p: SqlParams, f: AuditFilter): SqlParams {
  if (f.from) p.where((v) => `occurred_at >= ${v(f.from)}`);
  if (f.to) p.where((v) => `occurred_at < ${v(f.to)}`);
  if (f.actorType) p.where((v) => `actor_type = ${v(f.actorType)}`);
  if (f.actorId) p.where((v) => `actor_id = ${v(f.actorId)}`);
  if (f.action) p.where((v) => `action LIKE ${v(`${escapeLike(f.action ?? '')}%`)} ESCAPE '\\'`);
  if (f.target) p.where((v) => `target = ${v(f.target)}`);
  if (f.outcome) p.where((v) => `outcome = ${v(f.outcome)}`);
  for (const term of searchTerms(f.q ?? '')) {
    p.where(
      (v) =>
        `audit_search_text(action, actor_id, target, metadata) ILIKE ${v(`%${escapeLike(term)}%`)} ESCAPE '\\'`,
    );
  }
  return p;
}

export function encodeAuditCursor(id: string): string {
  return encodeCursor({ id });
}

export function decodeAuditCursor(cursor: string): string {
  return decodeCursor(cursor, (o) => (typeof o.id === 'string' && BIGINT_ID.test(o.id) ? o.id : null));
}

/** Builds the list query (exported for the SQL-safety unit test). */
export function auditListQuery(
  filter: AuditFilter,
  opts: { limit: number; beforeId?: string | null },
): { text: string; values: unknown[] } {
  const p = addAuditFilter(new SqlParams(), filter);
  if (opts.beforeId) p.where((v) => `id < ${v(opts.beforeId)}::bigint`);
  const limit = p.add(opts.limit + 1);
  return {
    text: `SELECT ${COLUMNS} FROM audit_events${p.whereSql()} ORDER BY audit_events.id DESC LIMIT ${limit}`,
    values: p.values,
  };
}

export class AuditQuery {
  constructor(private readonly db: Queryable) {}

  /** Newest first, keyset-paginated (`id < cursor`), stable under concurrent appends. */
  async list(filter: AuditFilter, opts: { limit?: number; cursor?: string | null } = {}): Promise<AuditPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const beforeId = opts.cursor ? decodeAuditCursor(opts.cursor) : null;
    const q = auditListQuery(filter, { limit, beforeId });
    const { rows } = await this.db.query<Row>(q.text, q.values);
    const page = rows.slice(0, limit).map(toView);
    const last = page.at(-1);
    return { items: page, nextCursor: rows.length > limit && last ? encodeAuditCursor(last.id) : null };
  }

  async get(id: string): Promise<AuditEventView | null> {
    if (!BIGINT_ID.test(id)) return null;
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM audit_events WHERE id = $1::bigint`, [
      id,
    ]);
    const row = rows[0];
    return row ? toView(row) : null;
  }

  /** The newest event (chain head), or null for an empty log. */
  async head(): Promise<{ id: string; hash: string } | null> {
    const { rows } = await this.db.query<{ id: string; hash: Buffer }>(
      'SELECT id::text AS id, hash FROM audit_events ORDER BY audit_events.id DESC LIMIT 1',
    );
    const r = rows[0];
    return r ? { id: r.id, hash: r.hash.toString('hex') } : null;
  }

  /** Smallest/largest ids with `occurred_at` in `[from, to)`; null bounds when the range is empty. */
  async idRange(from?: Date, to?: Date): Promise<{ fromId: string | null; toId: string | null }> {
    const p = new SqlParams();
    if (from) p.where((v) => `occurred_at >= ${v(from)}`);
    if (to) p.where((v) => `occurred_at < ${v(to)}`);
    const { rows } = await this.db.query<{ min: string | null; max: string | null }>(
      `SELECT min(id)::text AS min, max(id)::text AS max FROM audit_events${p.whereSql()}`,
      p.values,
    );
    return { fromId: rows[0]?.min ?? null, toId: rows[0]?.max ?? null };
  }

  /** Ascending batch for export: `afterId < id <= uptoId` within the filter. */
  async exportBatch(
    filter: AuditFilter,
    opts: { afterId: string; uptoId: string; limit: number },
  ): Promise<AuditEventView[]> {
    const p = addAuditFilter(new SqlParams(), filter);
    p.where((v) => `id > ${v(opts.afterId)}::bigint`);
    p.where((v) => `id <= ${v(opts.uptoId)}::bigint`);
    const limit = p.add(opts.limit);
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM audit_events${p.whereSql()} ORDER BY audit_events.id ASC LIMIT ${limit}`,
      p.values,
    );
    return rows.map(toView);
  }
}
