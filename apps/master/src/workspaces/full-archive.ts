import type { Readable } from 'node:stream';
import { BlobUnavailableError } from '../blobs/store.js';
import { type ArchiveSource, archiveOverhead, uniqueName } from './archive.js';
import { readZipIndex, type ZipIndexEntry, ZipIndexError, ZipStreamReader } from './zip-unpack.js';

/**
 * p18-outputs-delivery (docs/design/p18-outputs-delivery.md §1): "Tüm dosyaları indir (zip)" — ONE archive with every
 * output file of the job's latest attempt at its `out/`-relative path: the files stored one by one, the CONTENTS of
 * the overflow zip (`out-rest.zip`) unpacked in place (not a zip in the zip), `_summary.md`, and — when retention or
 * the quota removed files — `_removed-files.txt` naming them.
 *
 * Order (deterministic, so the names are too): `_summary.md`, the stored files by name, the overflow zip's files in
 * its own order, the note. A name an earlier entry took gets " (2)", " (3)" … before its extension.
 *
 * An overflow zip this master cannot unpack (damaged, not the worker's format) goes into the archive as it is, so the
 * download never loses a file; the log says why.
 */

/** One stored file of the latest attempt (pruned ones too: they are named in the note). */
export interface ArchiveRow {
  readonly name: string;
  readonly summary: boolean;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly content: Buffer | null;
  readonly blobKey: string | null;
  readonly prunedReason: string | null;
}

/** The blob store as the plan needs it. */
export interface ArchiveStore {
  range(key: string, offset: number, length: number): Promise<Buffer>;
  stream(key: string): Promise<{ stream: Readable }>;
}

export interface FullArchivePlan {
  readonly sources: readonly ArchiveSource[];
  /** Output files in the archive (the summary and the note not counted). */
  readonly files: number;
  /** Bytes of those files plus the summary (what the archive holds, without its own headers). */
  readonly bytes: number;
  /** Bytes the archive will have. */
  readonly archiveBytes: number;
  /** The overflow zip whose files were unpacked into the archive (null: none, or it could not be read). */
  readonly unpacked: { readonly name: string; readonly files: number } | null;
  /** Files removed by retention / quota (named in the note). */
  readonly removed: number;
  /** Releases the overflow zip's stream (the archive writer calls it when it ends). */
  readonly close: () => void;
}

export const SUMMARY_NAME = '_summary.md';
export const REMOVED_NOTE_NAME = '_removed-files.txt';

/** Indexes of overflow zips by blob key (immutable content), so listing pages do not read them again. */
const INDEX_CACHE_MAX = 64;
const indexCache = new Map<string, ZipIndexEntry[]>();

async function cachedIndex(store: ArchiveStore, key: string, size: number): Promise<ZipIndexEntry[]> {
  const hit = indexCache.get(key);
  if (hit !== undefined) {
    indexCache.delete(key);
    indexCache.set(key, hit);
    return hit;
  }
  const index = await readZipIndex(size, (offset, length) => store.range(key, offset, length));
  indexCache.set(key, index);
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
  return index;
}

/**
 * p18-assistant-gaps: the files of an overflow zip (its central directory, cached by blob key) — the assistant lists
 * and reads them one by one (list_job_outputs / read_job_output).
 */
export function overflowZipIndex(store: ArchiveStore, key: string, size: number): Promise<ZipIndexEntry[]> {
  return cachedIndex(store, key, size);
}

/** Test seam: forget the cached indexes. */
export function clearArchiveIndexCache(): void {
  indexCache.clear();
}

function removedNote(rows: readonly ArchiveRow[]): Buffer {
  return Buffer.from(
    [
      'Files of this job that were removed from storage (retention or storage quota) and are not in this zip.',
      'Bu işin depodan kaldırılan (saklama süresi veya depolama kotası) ve bu zip’te olmayan dosyaları.',
      '',
      ...rows.map((r) => `${r.name}\t${r.prunedReason ?? 'removed'}`),
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * The archive of `rows` (the latest attempt, listing order). `overflowZip`: the overflow zip's name from the output
 * report (null: none). `onUnreadable` is told when that zip could not be unpacked (it is then included as it is).
 */
export async function planFullArchive(
  rows: readonly ArchiveRow[],
  overflowZip: string | null,
  store: ArchiveStore,
  onUnreadable: (err: unknown) => void = () => undefined,
): Promise<FullArchivePlan> {
  const kept = rows.filter((r) => r.prunedReason === null && (r.content !== null || r.blobKey !== null));
  const removed = rows.filter((r) => !kept.includes(r));
  const zipRow =
    overflowZip === null
      ? undefined
      : kept.find(
          (r) =>
            !r.summary && r.name === overflowZip && r.blobKey !== null && r.mediaType === 'application/zip',
        );
  let index: ZipIndexEntry[] | null = null;
  if (zipRow?.blobKey != null) {
    try {
      index = await cachedIndex(store, zipRow.blobKey, zipRow.sizeBytes);
    } catch (err) {
      if (!(err instanceof ZipIndexError) && !(err instanceof BlobUnavailableError)) throw err;
      onUnreadable(err);
      index = null;
    }
  }
  const taken = new Set<string>();
  const sources: ArchiveSource[] = [];
  const open = (r: ArchiveRow) => async (): Promise<Buffer | Readable> => {
    if (r.content !== null) return r.content;
    return (await store.stream(r.blobKey ?? '')).stream;
  };
  let files = 0;
  let bytes = 0;
  const summary = kept.filter((r) => r.summary);
  const stored = kept.filter((r) => !r.summary && !(index !== null && r === zipRow));
  for (const r of summary) {
    sources.push({ name: uniqueName(SUMMARY_NAME, taken), sizeBytes: r.sizeBytes, open: open(r) });
    bytes += r.sizeBytes;
  }
  for (const r of stored) {
    sources.push({ name: uniqueName(r.name, taken), sizeBytes: r.sizeBytes, open: open(r) });
    files++;
    bytes += r.sizeBytes;
  }
  let reader: ZipStreamReader | null = null;
  if (index !== null && zipRow?.blobKey != null) {
    const key = zipRow.blobKey;
    const zip = new ZipStreamReader(async () => (await store.stream(key)).stream);
    reader = zip;
    for (const e of index) {
      sources.push({
        name: uniqueName(e.name, taken),
        sizeBytes: e.size,
        crc32: e.crc32,
        open: () => zip.entry(e),
      });
      files++;
      bytes += e.size;
    }
  }
  if (removed.length > 0) {
    const note = removedNote(removed);
    sources.push({
      name: uniqueName(REMOVED_NOTE_NAME, taken),
      sizeBytes: note.length,
      open: () => Promise.resolve(note),
    });
  }
  const contentBytes = sources.reduce((n, s) => n + s.sizeBytes, 0);
  return {
    sources,
    files,
    bytes,
    archiveBytes: contentBytes + archiveOverhead(sources.map((s) => s.name)),
    unpacked: index === null || zipRow === undefined ? null : { name: zipRow.name, files: index.length },
    removed: removed.length,
    close: () => reader?.close(),
  };
}
