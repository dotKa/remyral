import { z } from 'zod';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../audit/sql.js';
import { HttpError } from './errors.js';

/**
 * Shared list pagination (p9-pagination, docs/design/p9-pagination.md).
 *
 * Two models, one response shape `{ items, nextCursor?, total? }`:
 *  - keyset (cursor): append-heavy lists (jobs, audit, runs, checks, incidents, ops actions, approvals,
 *    chat threads, notifications, update attempts). The cursor is opaque (base64url JSON, versioned) and
 *    carries the last row's sort key and id; the next page is everything strictly after `(key, id)` in the
 *    list's order, so concurrent inserts never shift or repeat rows. No `total` (not cheap).
 *  - offset: small admin lists (users, projects, machines, templates, skills, …) that are loaded whole by
 *    their service anyway; `limit` + `offset` slice them and `total` is the full length. Without `limit`
 *    the whole list is returned (backward compatible for the worker, the CLI and the web pickers).
 */

/** Page sizes the web console offers; any value in 1..cap is accepted by the API. */
export const PAGE_SIZES = [25, 50, 100] as const;

/** Upper bound of `offset` (bounded lists only; a larger value is a client bug, not a real page). */
export const MAX_OFFSET = 100_000;

export const CursorParam = z.string().min(1).max(512);

/** `limit` (1..max) and `cursor` query parameters of a keyset list. */
export function keysetQuery(max: number) {
  return {
    limit: z.coerce.number().int().min(1).max(max).optional(),
    cursor: CursorParam.optional(),
  };
}

/** `limit` (1..max) and `offset` query parameters of a bounded admin list. */
export function offsetQuery(max: number) {
  return {
    limit: z.coerce.number().int().min(1).max(max).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  };
}

/** Response fields added to a paged list (both optional, so older clients ignore them). */
export const pageFields = {
  nextCursor: z.string().nullable().optional(),
  total: z.number().int().min(0).optional(),
};

/** Slices an already-ordered, fully loaded list. Without `limit` (and offset) everything is returned. */
export function pageArray<T>(
  all: readonly T[],
  q: { readonly limit?: number | undefined; readonly offset?: number | undefined },
): { items: T[]; total: number } {
  const offset = q.offset ?? 0;
  if (q.limit === undefined) return { items: all.slice(offset), total: all.length };
  return { items: all.slice(offset, offset + q.limit), total: all.length };
}

/** A keyset position: the sort key as text (timestamps in full microsecond precision) and the row id. */
export interface Keyset {
  readonly k: string;
  readonly id: string;
}

const ISO_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_RE = /^[1-9][0-9]{0,18}$/;

export type KeyKind = 'timestamp';
export type IdKind = 'uuid' | 'bigint';

/**
 * Encodes a keyset cursor. `scope` binds the cursor to one list (e.g. `uptime.checks`) so a cursor of one
 * list is refused by another instead of being misread.
 */
export function encodeKeyset(scope: string, at: Keyset): string {
  return encodeCursor({ s: scope, k: at.k, id: at.id });
}

/** Decodes and validates a keyset cursor (throws InvalidCursorError → 400 via `cursorOrBadRequest`). */
export function decodeKeyset(scope: string, cursor: string, idKind: IdKind): Keyset {
  return decodeCursor(cursor, (o) => {
    if (o.s !== scope || typeof o.k !== 'string' || typeof o.id !== 'string') return null;
    if (!ISO_KEY.test(o.k)) return null;
    if (!(idKind === 'uuid' ? UUID_RE : BIGINT_RE).test(o.id)) return null;
    return { k: o.k, id: o.id };
  });
}

/**
 * Turns `limit + 1` fetched rows into a page: the first `limit` rows and, when there was one more, the
 * cursor of the last returned row.
 */
export function keysetPage<R, T>(
  rows: readonly R[],
  limit: number,
  scope: string,
  key: (row: R) => Keyset,
  map: (row: R) => T,
): { items: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => map(r)),
    nextCursor: rows.length > limit && last !== undefined ? encodeKeyset(scope, key(last)) : null,
  };
}

/** Clamps a requested page size into 1..max (default when absent). */
export function clampLimit(limit: number | undefined, def: number, max: number): number {
  return Math.min(Math.max(Math.trunc(limit ?? def), 1), max);
}

/** Maps an invalid cursor to `400 invalid_cursor`. */
export async function cursorOrBadRequest<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      throw new HttpError(
        400,
        'invalid_cursor',
        'The page cursor is invalid. Start again from the first page.',
      );
    }
    throw err;
  }
}

export { InvalidCursorError };
