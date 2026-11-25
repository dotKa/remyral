import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  partLength,
  RELEASE_UPLOAD_BODY_LIMIT,
  UPLOAD_PART_MAX_BYTES,
  UPLOAD_PART_MIN_BYTES,
} from '../../src/releases/uploads.js';

describe('chunked release upload (p6-release-upload)', () => {
  it('every part is partSize bytes except a shorter last one; the parts add up to the total', () => {
    const cases: [number, number][] = [
      [1, UPLOAD_PART_MIN_BYTES],
      [UPLOAD_PART_MAX_BYTES, UPLOAD_PART_MAX_BYTES],
      [UPLOAD_PART_MAX_BYTES + 1, UPLOAD_PART_MAX_BYTES],
      [13_312_345, UPLOAD_PART_MAX_BYTES],
      [RELEASE_UPLOAD_BODY_LIMIT, UPLOAD_PART_MIN_BYTES],
    ];
    for (const [total, size] of cases) {
      const count = Math.ceil(total / size);
      const lengths = Array.from({ length: count }, (_, n) => partLength(total, size, n));
      expect(lengths.reduce((a, b) => a + b, 0)).toBe(total);
      expect(lengths.slice(0, -1).every((l) => l === size)).toBe(true);
      expect(lengths.at(-1)).toBeGreaterThan(0);
      expect(lengths.at(-1)).toBeLessThanOrEqual(size);
    }
  });

  it('the database bounds (migration 0041) match the service limits', () => {
    const sql = readFileSync(new URL('../../migrations/0041_release_uploads.sql', import.meta.url), 'utf8');
    expect(sql).toContain(`total_bytes BETWEEN 1 AND ${String(RELEASE_UPLOAD_BODY_LIMIT)}`);
    expect(sql).toContain(
      `part_size BETWEEN ${String(UPLOAD_PART_MIN_BYTES)} AND ${String(UPLOAD_PART_MAX_BYTES)}`,
    );
    expect(sql).toContain(
      `part_count BETWEEN 1 AND ${String(RELEASE_UPLOAD_BODY_LIMIT / UPLOAD_PART_MIN_BYTES)}`,
    );
    expect(sql).toContain(`length(bytes) BETWEEN 1 AND ${String(UPLOAD_PART_MAX_BYTES)}`);
  });
});
