import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/audit/sql.js';
import {
  clampLimit,
  cursorOrBadRequest,
  decodeKeyset,
  encodeKeyset,
  InvalidCursorError,
  keysetPage,
  pageArray,
} from '../../src/http/pagination.js';

/** p9-pagination: the shared page helpers (docs/design/p9-pagination.md §2). */
describe('pagination helpers', () => {
  it('pageArray: no limit returns everything with the total; limit/offset slice', () => {
    const all = [1, 2, 3, 4, 5];
    expect(pageArray(all, {})).toEqual({ items: all, total: 5 });
    expect(pageArray(all, { limit: 2 })).toEqual({ items: [1, 2], total: 5 });
    expect(pageArray(all, { limit: 2, offset: 4 })).toEqual({ items: [5], total: 5 });
    expect(pageArray(all, { limit: 2, offset: 10 })).toEqual({ items: [], total: 5 });
  });

  it('keyset cursors round-trip, are bound to their list and validate their content', () => {
    const at = { k: '2026-10-17T10:00:00.123456+00:00', id: '11111111-1111-4111-8111-111111111111' };
    const c = encodeKeyset('a.list', at);
    expect(decodeKeyset('a.list', c, 'uuid')).toEqual(at);
    expect(() => decodeKeyset('b.list', c, 'uuid')).toThrow(InvalidCursorError);
    expect(() => decodeKeyset('a.list', c, 'bigint')).toThrow(InvalidCursorError);
    expect(decodeKeyset('a.list', encodeKeyset('a.list', { k: at.k, id: '42' }), 'bigint').id).toBe('42');
    // Not a timestamp, injected SQL, wrong version, garbage.
    expect(() =>
      decodeKeyset('a.list', encodeCursor({ s: 'a.list', k: "x'; DROP TABLE jobs;--", id: at.id }), 'uuid'),
    ).toThrow(InvalidCursorError);
    expect(() => decodeKeyset('a.list', 'not+base64', 'uuid')).toThrow(InvalidCursorError);
    expect(() => decodeKeyset('a.list', 'x'.repeat(600), 'uuid')).toThrow(InvalidCursorError);
  });

  it('keysetPage: limit + 1 rows give a cursor of the last returned row', () => {
    const rows = [1, 2, 3].map((n) => ({ k: `2026-10-17T10:00:0${String(n)}Z`, id: String(n) }));
    const page = keysetPage(
      rows,
      2,
      's',
      (r) => r,
      (r) => r.id,
    );
    expect(page.items).toEqual(['1', '2']);
    expect(decodeKeyset('s', page.nextCursor ?? '', 'bigint')).toEqual(rows[1]);
    expect(
      keysetPage(
        rows,
        3,
        's',
        (r) => r,
        (r) => r.id,
      ).nextCursor,
    ).toBeNull();
  });

  it('clampLimit and cursorOrBadRequest', async () => {
    expect(clampLimit(undefined, 50, 200)).toBe(50);
    expect(clampLimit(0, 50, 200)).toBe(1);
    expect(clampLimit(1_000, 50, 200)).toBe(200);
    await expect(
      cursorOrBadRequest(() => {
        throw new InvalidCursorError('x');
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_cursor' });
    await expect(cursorOrBadRequest(() => Promise.resolve(7))).resolves.toBe(7);
  });
});
