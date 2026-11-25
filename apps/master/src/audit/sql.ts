/**
 * Tiny, injection-safe SQL building blocks for the read APIs (docs/design/p5-search-audit.md §3).
 *
 * Values are never interpolated into SQL text: `SqlParams.add` stores the value and returns its `$n`
 * placeholder. SQL fragments passed to `where` must be static strings written in this codebase; anything
 * user-supplied goes through `add`.
 */
export class SqlParams {
  readonly values: unknown[] = [];
  private readonly clauses: string[] = [];

  /** Binds a value and returns its placeholder (`$1`, `$2`, …). */
  add(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }

  /** Adds a static condition; `build` is called with `add` to bind its values. */
  where(build: (p: (value: unknown) => string) => string): this {
    this.clauses.push(build((v) => this.add(v)));
    return this;
  }

  /** ` WHERE a AND b` or the empty string. */
  whereSql(): string {
    return this.clauses.length === 0 ? '' : ` WHERE ${this.clauses.map((c) => `(${c})`).join(' AND ')}`;
  }
}

/** Escapes `\`, `%` and `_` so the value matches literally inside `LIKE … ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Splits free text into at most `maxTerms` distinct non-empty terms (NUL removed). */
export function searchTerms(q: string, maxTerms = 8, maxLength = 100): string[] {
  const out: string[] = [];
  for (const raw of q.replaceAll('\u0000', '').split(/\s+/)) {
    const term = raw.slice(0, maxLength);
    if (term === '' || out.includes(term)) continue;
    out.push(term);
    if (out.length === maxTerms) break;
  }
  return out;
}

export class InvalidCursorError extends Error {
  override name = 'InvalidCursorError';
}

/** Opaque keyset cursor: base64url JSON with a version tag. Decoding validates with `check`. */
export function encodeCursor(payload: Readonly<Record<string, string>>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url');
}

export function decodeCursor<T>(cursor: string, check: (value: Record<string, unknown>) => T | null): T {
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidCursorError('malformed');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) throw new InvalidCursorError('version');
  const value = check(obj);
  if (value === null) throw new InvalidCursorError('content');
  return value;
}

/** Positive bigint as decimal text (ids of bigint columns are handled as strings). */
export const BIGINT_ID = /^[1-9][0-9]{0,18}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
