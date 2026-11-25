import type { BlobService } from './store.js';

/**
 * p17-object-storage: the process's blob store. Blob reads happen in many services (outputs, verify, ops, chat,
 * workflows) whose bytes used to come straight from a Postgres column; the store is process infrastructure like the
 * pool, set once by `createMasterApp` (and the CLI) instead of threaded through every constructor. Several masters in
 * one process (tests) share one database and therefore one blob directory, so the last one set is equivalent.
 */
let current: BlobService | null = null;

export function setBlobService(s: BlobService | null): void {
  current = s;
}

/** The blob store; throws when none was set (a misconfigured process must fail loudly, never fall back to the DB). */
export function blobs(): BlobService {
  if (current === null) throw new Error('blob store not configured (createMasterApp sets it)');
  return current;
}

/** The blob store if one was set (code paths that also run in unit tests without one). */
export function maybeBlobs(): BlobService | null {
  return current;
}

/** A row's bytes: the legacy bytea column when still set, else its blob; null when the content was pruned. */
export async function rowContent(
  r: { readonly content?: Buffer | null; readonly blob_key?: string | null },
  maxBytes?: number,
): Promise<Buffer | null> {
  if (r.content !== null && r.content !== undefined) return r.content;
  if (r.blob_key === null || r.blob_key === undefined) return null;
  return blobs().read(r.blob_key, maxBytes);
}
