import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { errnoCode, type FileOps } from './ops.js';

/** Errors Windows returns while another process (AV scanner, indexer) briefly holds the target open. */
const WINDOWS_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface AtomicWriteOptions {
  mode: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Total retry budget for transient Windows rename failures. Default 10 attempts. */
  windowsRetries?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const TEMP_MARKER = '.tmp-';

/** Temp-file name next to `path`, so the rename stays on one filesystem. */
export function tempPathFor(path: string): string {
  return join(
    dirname(path),
    `${basename(path)}${TEMP_MARKER}${String(process.pid)}-${randomBytes(4).toString('hex')}`,
  );
}

/**
 * Crash-safe replace of `path`:
 *   1. write a new temp file exclusively with `mode`, fsync it;
 *   2. rename it over `path` (atomic on POSIX; `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`
 *      on Windows via libuv, retried on transient sharing violations);
 *   3. fsync the directory so the rename itself survives power loss (POSIX).
 * A crash at any point leaves either the old or the new complete file; a leftover
 * temp file is removed by `removeStaleTemps` on the next open.
 */
export async function atomicWriteFile(
  ops: FileOps,
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  const tmp = tempPathFor(path);
  await ops.writeNew(tmp, data, options.mode);
  try {
    await renameReplacing(ops, tmp, path, options);
  } catch (error) {
    await ops.unlink(tmp).catch(() => undefined);
    throw error;
  }
  await ops.fsyncDir(dirname(path));
}

async function renameReplacing(
  ops: FileOps,
  from: string,
  to: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const attempts = ops.platform === 'win32' ? (options.windowsRetries ?? 10) : 1;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      await ops.rename(from, to);
      return;
    } catch (error) {
      const code = errnoCode(error);
      if (attempt >= attempts || code === undefined || !WINDOWS_TRANSIENT.has(code)) throw error;
      await sleep(Math.min(10 * 2 ** (attempt - 1), 200));
    }
  }
}

/** Remove `<name>.tmp-*` leftovers of interrupted writes in `dir`. Returns how many were removed. */
export async function removeStaleTemps(ops: FileOps, dir: string, name: string): Promise<number> {
  let removed = 0;
  for (const entry of await ops.readdir(dir)) {
    if (entry.startsWith(`${name}${TEMP_MARKER}`)) {
      await ops.unlink(join(dir, entry));
      removed++;
    }
  }
  return removed;
}
