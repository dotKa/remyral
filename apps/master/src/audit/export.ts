import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Redactor, redactDeep } from '@remyral/observability';
import { REDACTED } from './redact.js';

/**
 * Streamed, size-limited exports with a trailing manifest (docs/design/p5-search-audit.md §5).
 *
 * The body is every byte before the manifest line; the manifest carries the SHA-256 of the body. Because the
 * manifest is written last, a download without it is incomplete.
 */

export type ExportFormat = 'jsonl' | 'csv';
export type ExportKind = 'audit' | 'job' | 'context';

export const EXPORT_MAX_RECORDS = 100_000;
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export interface ExportManifest {
  readonly version: 1;
  readonly kind: ExportKind;
  readonly format: ExportFormat;
  readonly generated_at: string;
  readonly generated_by: string;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly record_count: number;
  readonly body_bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  /** Pass as `cursor` to continue a truncated export. */
  readonly next_cursor: string | null;
  /** Records changed by the export-time (defence in depth) redaction. */
  readonly redacted_records: number;
  readonly limits: { readonly max_records: number; readonly max_bytes: number };
  readonly [extra: string]: unknown;
}

export interface ExportRecord {
  readonly record: Readonly<Record<string, unknown>>;
  /** Cursor that continues the export *after* this record. */
  readonly cursor: string | null;
}

export interface ExportOptions {
  readonly kind: ExportKind;
  readonly format: ExportFormat;
  readonly generatedAt: Date;
  readonly generatedBy: string;
  readonly filters: Readonly<Record<string, unknown>>;
  /** Required for CSV: column order; each record contributes these keys (objects as JSON text). */
  readonly csvColumns?: readonly string[];
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  /** Extra manifest fields (e.g. `chain_head`). */
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly redactor?: Redactor;
  /** Called after the last record and before the manifest is sent; a rejection aborts the stream. */
  readonly onComplete: (manifest: ExportManifest) => Promise<void>;
  /** Called when the source fails or the client goes away before the manifest was sent. */
  readonly onFailure: (info: {
    reason: 'error' | 'aborted';
    recordCount: number;
    error?: unknown;
  }) => Promise<void>;
}

const defaultRedactor = new Redactor();

/**
 * Puts the stored `[REDACTED]` marker back where observability re-marked an already redacted value as
 * `[REDACTED:key]`, and reports whether anything else changed.
 */
function reconcile(before: unknown, after: unknown): { value: unknown; changed: boolean } {
  if (typeof before === 'string' && typeof after === 'string') {
    if (before === after) return { value: after, changed: false };
    if (before === REDACTED && after.startsWith('[REDACTED')) return { value: REDACTED, changed: false };
    return { value: after, changed: true };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    let changed = before.length !== after.length;
    const value = after.map((v: unknown, i) => {
      const r = reconcile(before[i], v);
      changed ||= r.changed;
      return r.value;
    });
    return { value, changed };
  }
  if (typeof before === 'object' && before !== null && typeof after === 'object' && after !== null) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    let changed = Object.keys(a).length !== Object.keys(b).length;
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      const r = reconcile(a[k], v);
      changed ||= r.changed || !(k in a);
      value[k] = r.value;
    }
    return { value, changed };
  }
  return { value: after, changed: before !== after };
}

/** Runs one record through `@remyral/observability` redaction (patterns + sensitive keys). */
export function redactRecord(
  record: Readonly<Record<string, unknown>>,
  redactor: Redactor = defaultRedactor,
): { value: Record<string, unknown>; changed: boolean } {
  const value: unknown = redactDeep(record, redactor, {
    maxStringLength: 1_000_000,
    maxDepth: 32,
    maxEntries: 10_000,
    stacks: 'omit',
  });
  const r = reconcile(record, value);
  return { value: r.value as Record<string, unknown>, changed: r.changed };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: always quoted, quotes doubled, spreadsheet formula prefixes neutralised with `'`. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else text = JSON.stringify(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

export function manifestLine(format: ExportFormat, manifest: ExportManifest): string {
  if (format === 'jsonl') return `${JSON.stringify({ type: 'manifest', manifest })}\n`;
  return `#manifest,${csvCell(JSON.stringify(manifest))}\r\n`;
}

/** Splits an export into body and parsed manifest (used by tests and documented for consumers). */
export function splitExport(text: string): { body: string; manifest: ExportManifest } {
  const trimmed = text.replace(/\r?\n$/, '');
  const cut = trimmed.lastIndexOf('\n');
  const body = cut < 0 ? '' : text.slice(0, cut + 1);
  const last = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  if (last.startsWith('#manifest,')) {
    const cell = last.slice('#manifest,'.length);
    const json = cell.slice(1, -1).replaceAll('""', '"');
    return { body, manifest: JSON.parse(json) as ExportManifest };
  }
  const parsed = JSON.parse(last) as { type: string; manifest: ExportManifest };
  if (parsed.type !== 'manifest') throw new Error('no manifest');
  return { body, manifest: parsed.manifest };
}

/**
 * Builds the export stream. Records are pulled lazily from `source` (one DB batch at a time), redacted,
 * encoded and hashed; output is coalesced into ~64 KiB chunks.
 */
export function createExportStream(source: AsyncIterable<ExportRecord>, opts: ExportOptions): Readable {
  const maxRecords = opts.maxRecords ?? EXPORT_MAX_RECORDS;
  const maxBytes = opts.maxBytes ?? EXPORT_MAX_BYTES;
  const redactor = opts.redactor ?? defaultRedactor;
  const columns = opts.csvColumns ?? [];
  if (opts.format === 'csv' && columns.length === 0) throw new Error('CSV export needs columns');

  const encode = (r: Record<string, unknown>): string =>
    opts.format === 'jsonl' ? `${JSON.stringify(r)}\n` : csvLine(columns.map((c) => r[c]));

  async function* generate(): AsyncGenerator<Buffer> {
    const hash = createHash('sha256');
    let bytes = 0;
    let count = 0;
    let redacted = 0;
    let truncated = false;
    let lastCursor: string | null = null;
    let pending: string[] = [];
    let pendingBytes = 0;
    let finished = false;
    let failed = false;

    const take = (line: string): void => {
      const n = Buffer.byteLength(line, 'utf8');
      hash.update(line, 'utf8');
      bytes += n;
      pending.push(line);
      pendingBytes += n;
    };
    const flush = (): Buffer => {
      const out = Buffer.from(pending.join(''), 'utf8');
      pending = [];
      pendingBytes = 0;
      return out;
    };

    try {
      if (opts.format === 'csv') take(csvLine(columns));
      for await (const item of source) {
        const { value, changed } = redactRecord(item.record, redactor);
        const line = encode(value);
        if (count >= maxRecords || bytes + Buffer.byteLength(line, 'utf8') > maxBytes) {
          truncated = true;
          break;
        }
        take(line);
        count += 1;
        if (changed) redacted += 1;
        lastCursor = item.cursor;
        if (pendingBytes >= CHUNK_BYTES) yield flush();
      }
      const manifest: ExportManifest = {
        version: 1,
        kind: opts.kind,
        format: opts.format,
        generated_at: opts.generatedAt.toISOString(),
        generated_by: opts.generatedBy,
        filters: opts.filters,
        record_count: count,
        body_bytes: bytes,
        sha256: hash.digest('hex'),
        truncated,
        next_cursor: truncated ? lastCursor : null,
        redacted_records: redacted,
        limits: { max_records: maxRecords, max_bytes: maxBytes },
        ...(opts.extra ?? {}),
      };
      // Audit first: if the completion record cannot be written the client never gets a manifest.
      await opts.onComplete(manifest);
      const body = flush();
      finished = true;
      yield Buffer.concat([body, Buffer.from(manifestLine(opts.format, manifest), 'utf8')]);
    } catch (err) {
      failed = true;
      await opts.onFailure({ reason: 'error', recordCount: count, error: err }).catch(() => undefined);
      throw err;
    } finally {
      if (!finished && !failed) {
        await opts.onFailure({ reason: 'aborted', recordCount: count }).catch(() => undefined);
      }
    }
  }

  return Readable.from(generate(), { objectMode: false });
}
