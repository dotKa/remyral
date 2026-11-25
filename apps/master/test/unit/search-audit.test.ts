import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createExportStream,
  csvCell,
  csvLine,
  type ExportManifest,
  type ExportRecord,
  redactRecord,
  splitExport,
} from '../../src/audit/export.js';
import { auditListQuery, decodeAuditCursor, encodeAuditCursor } from '../../src/audit/query.js';
import { decodeCursor, escapeLike, InvalidCursorError, searchTerms, SqlParams } from '../../src/audit/sql.js';
import {
  decodeJobCursor,
  encodeJobCursor,
  jobListQuery,
  sanitizeSpec,
  stripUrlCredentials,
} from '../../src/jobs/query.js';

const HOSTILE = [
  "'; DROP TABLE audit_events; --",
  '%',
  '_',
  '\\',
  '$1',
  "x' OR '1'='1",
  'a\u0000b',
  ') OR (1=1',
];

/**
 * The SQL text must be byte-identical to the text built from benign values (only the filter *shape* changes
 * the SQL), and every placeholder must have a bound value.
 */
function assertParameterised(
  build: (value: string) => { text: string; values: readonly unknown[] },
  hostile: string,
): void {
  const benign = build('benign');
  const bad = build(hostile);
  expect(bad.text).toBe(benign.text);
  expect(bad.text).not.toMatch(/DROP|OR '1'='1/);
  const placeholders = [...bad.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  expect(Math.max(...placeholders)).toBe(bad.values.length);
}

describe('SqlParams', () => {
  it('numbers placeholders and keeps values out of the SQL text', () => {
    const p = new SqlParams();
    p.where((v) => `a = ${v("x'y")}`).where((v) => `b BETWEEN ${v(1)} AND ${v(2)}`);
    expect(p.whereSql()).toBe(' WHERE (a = $1) AND (b BETWEEN $2 AND $3)');
    expect(p.values).toEqual(["x'y", 1, 2]);
    expect(new SqlParams().whereSql()).toBe('');
  });

  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('auth.login')).toBe('auth.login');
  });

  it('splits search text into bounded distinct terms', () => {
    expect(searchTerms('  a  b a\u0000 c ')).toEqual(['a', 'b', 'c']);
    expect(searchTerms('1 2 3 4 5 6 7 8 9 10')).toHaveLength(8);
    expect(searchTerms('x'.repeat(500))[0]).toHaveLength(100);
    expect(searchTerms('')).toEqual([]);
  });
});

describe('audit list query builder', () => {
  it.each(HOSTILE)('binds every filter value as a parameter: %j', (bad) => {
    const build = (v: string) =>
      auditListQuery(
        {
          from: new Date('2026-01-01T00:00:00Z'),
          to: new Date('2026-12-01T00:00:00Z'),
          actorType: 'user',
          actorId: v,
          action: v,
          target: v,
          outcome: 'denied',
          // Whitespace splits terms (changes the shape), so the free-text term is the value without it.
          q: `${v.replace(/\s+/g, '')} more`,
        },
        { limit: 50, beforeId: '42' },
      );
    assertParameterised(build, bad);
    const q = build(bad);
    expect(q.values).toContain(bad);
    // LIKE patterns are escaped literals.
    expect(q.values).toContain(`${escapeLike(bad)}%`);
    expect(q.values).toContain(`%${escapeLike(bad.replace(/\s+/g, '').replaceAll('\u0000', ''))}%`);
    expect(q.values.at(-1)).toBe(51);
    expect(q.text).toContain('ORDER BY audit_events.id DESC');
  });

  it('produces the same SQL text for different values of the same filter shape', () => {
    const a = auditListQuery({ actorId: 'alice', q: 'one' }, { limit: 10 });
    const b = auditListQuery({ actorId: "'; DROP", q: '%%' }, { limit: 99 });
    expect(a.text).toBe(b.text);
  });
});

describe('jobs list query builder', () => {
  it.each(HOSTILE)('binds every filter value as a parameter: %j', (bad) => {
    const build = (v: string) =>
      jobListQuery(
        {
          states: ['QUEUED', 'RUNNING'],
          project: v,
          runtime: v,
          worker: v,
          from: new Date('2026-01-01T00:00:00Z'),
          to: new Date('2026-02-01T00:00:00Z'),
        },
        {
          limit: 20,
          before: { t: '2026-01-02T00:00:00.123456+00:00', id: '11111111-1111-4111-8111-111111111111' },
        },
      );
    assertParameterised(build, bad);
    const q = build(bad);
    expect(q.values).toContain(bad);
    expect(q.values).toContainEqual(['QUEUED', 'RUNNING']);
    expect(q.values.at(-1)).toBe(21);
  });
});

describe('cursors', () => {
  it('round-trips audit and job cursors', () => {
    expect(decodeAuditCursor(encodeAuditCursor('12345'))).toBe('12345');
    const t = '2026-10-12T12:00:00.123456+00:00';
    const id = '11111111-1111-4111-8111-111111111111';
    expect(decodeJobCursor(encodeJobCursor(t, id))).toEqual({ t, id });
  });

  it.each([
    'not base64 !',
    Buffer.from('[]').toString('base64url'),
    Buffer.from('{"v":2,"id":"1"}').toString('base64url'),
    Buffer.from('{"v":1,"id":"1; DROP TABLE x"}').toString('base64url'),
    Buffer.from('{"v":1,"id":"-1"}').toString('base64url'),
    Buffer.from('{"v":1}').toString('base64url'),
    'A'.repeat(600),
  ])('rejects tampered audit cursor %#', (c) => {
    expect(() => decodeAuditCursor(c)).toThrow(InvalidCursorError);
  });

  it('rejects tampered job cursors', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, t: "now'); --", id: 'x' })).toString('base64url');
    expect(() => decodeJobCursor(bad)).toThrow(InvalidCursorError);
    expect(() => decodeCursor('e30', () => null)).toThrow(InvalidCursorError);
  });
});

describe('CSV encoding', () => {
  it('quotes every cell, doubles quotes and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    for (const p of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(p).startsWith('"\'')).toBe(true);
    expect(csvCell(null)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvLine(['a', 'b'])).toBe('"a","b"\r\n');
  });
});

describe('redaction and spec sanitising', () => {
  it('redacts token patterns and sensitive keys, counting only real changes', () => {
    const r = redactRecord({ note: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 now', ok: 'fine' });
    expect(JSON.stringify(r.value)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(r.changed).toBe(true);
    // A value already redacted at write time does not count again.
    expect(redactRecord({ metadata: { password: '[REDACTED]' } }).changed).toBe(false);
    expect(redactRecord({ id: '1', hash: 'a'.repeat(64) }).changed).toBe(false);
  });

  it('strips repository URL credentials', () => {
    expect(stripUrlCredentials('https://user:s3cret@example.com/a/b.git')).toBe(
      'https://example.com/a/b.git',
    );
    expect(stripUrlCredentials('https://ghp_token@example.com/a.git')).toBe('https://example.com/a.git');
    expect(stripUrlCredentials('ssh://git@example.com/a.git')).toBe('ssh://git@example.com/a.git');
    expect(stripUrlCredentials('https://example.com/a.git')).toBe('https://example.com/a.git');
    expect(stripUrlCredentials('::nope')).toBe('[invalid url]');
    const spec = sanitizeSpec({
      runtime: 'codex',
      prompt: 'x',
      repository: { url: 'https://u:p@example.com/r.git', baseRef: 'main', workBranch: 'w' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-all',
      limits: { maxDurationSec: 60 },
    });
    expect(spec.repository?.url).toBe('https://example.com/r.git');
  });
});

async function collect(
  source: AsyncIterable<ExportRecord>,
  opts: Partial<Parameters<typeof createExportStream>[1]> = {},
) {
  const completed: ExportManifest[] = [];
  const failures: string[] = [];
  const stream = createExportStream(source, {
    kind: 'audit',
    format: 'jsonl',
    generatedAt: new Date('2026-10-13T00:00:00Z'),
    generatedBy: 'u1',
    filters: { q: 'x' },
    onComplete: (m) => {
      completed.push(m);
      return Promise.resolve();
    },
    onFailure: (f) => {
      failures.push(f.reason);
      return Promise.resolve();
    },
    ...opts,
  });
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return { text: Buffer.concat(chunks).toString('utf8'), completed, failures };
}

async function* records(n: number): AsyncGenerator<ExportRecord> {
  await Promise.resolve();
  for (let i = 1; i <= n; i++)
    yield { record: { type: 'r', i, s: `row ${String(i)}` }, cursor: `c${String(i)}` };
}

describe('export stream', () => {
  it('writes records, then a manifest whose sha256 covers exactly the body', async () => {
    const { text, completed } = await collect(records(3));
    const { body, manifest } = splitExport(text);
    expect(body.split('\n').filter(Boolean)).toHaveLength(3);
    expect(manifest.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(manifest).toMatchObject({
      record_count: 3,
      truncated: false,
      next_cursor: null,
      body_bytes: body.length,
    });
    expect(completed).toEqual([manifest]);
  });

  it('truncates at the record limit and returns a continuation cursor', async () => {
    const { text } = await collect(records(5), { maxRecords: 2 });
    const { manifest } = splitExport(text);
    expect(manifest).toMatchObject({ record_count: 2, truncated: true, next_cursor: 'c2' });
  });

  it('truncates at the byte limit', async () => {
    const { text } = await collect(records(100), { maxBytes: 200 });
    const { body, manifest } = splitExport(text);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(200);
    expect(manifest.truncated).toBe(true);
  });

  it('writes CSV with a header and a #manifest line', async () => {
    const { text } = await collect(records(2), { format: 'csv', csvColumns: ['i', 's'] });
    const { body, manifest } = splitExport(text);
    expect(body).toBe('"i","s"\r\n"1","row 1"\r\n"2","row 2"\r\n');
    expect(manifest.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(manifest.format).toBe('csv');
  });

  it('sends no manifest and reports a failure when the source breaks', async () => {
    async function* broken(): AsyncGenerator<ExportRecord> {
      await Promise.resolve();
      yield { record: { a: 1 }, cursor: null };
      throw new Error('db gone');
    }
    await expect(collect(broken())).rejects.toThrow('db gone');
  });

  it('sends no manifest when the completion audit fails (fail closed)', async () => {
    await expect(
      collect(records(1), { onComplete: () => Promise.reject(new Error('audit down')) }),
    ).rejects.toThrow('audit down');
  });
});
