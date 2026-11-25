import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { ReleaseVersion, UpdateDiagnostics } from '@remyral/protocol';
import { z } from 'zod';

/** Small JSON documents exchanged between the daemon (unprivileged) and the privileged updater. */

/** `<dataDir>/updates/request.json` — written by the daemon, *untrusted* input for the updater. */
export const ActivationRequest = z.strictObject({
  schema: z.literal(1),
  attemptId: z.uuid(),
  version: ReleaseVersion,
  /** Explicit administrator rollback: a lower version is acceptable (above the owner floor). */
  rollback: z.boolean(),
  requestedAt: z.iso.datetime(),
});
export type ActivationRequest = z.infer<typeof ActivationRequest>;

/** `<dataDir>/update-health.json` — the running daemon proves it connected and heartbeated. */
export const HealthReport = z.strictObject({
  schema: z.literal(1),
  version: z.string().min(1).max(64),
  pid: z.number().int().positive(),
  sessionEstablishedAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
});
export type HealthReport = z.infer<typeof HealthReport>;

export const UpdateOutcome = z.enum(['succeeded', 'rolled_back', 'failed', 'refused']);
export type UpdateOutcome = z.infer<typeof UpdateOutcome>;

/** `<install>/state/last-result.json` — written by the updater only (root-owned, world-readable). */
export const UpdateResult = z.strictObject({
  schema: z.literal(1),
  attemptId: z.uuid().nullable(),
  version: z.string().min(1).max(64),
  outcome: UpdateOutcome,
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .nullable(),
  detail: z.string().max(500).nullable(),
  activeVersion: z.string().min(1).max(64),
  finishedAt: z.iso.datetime(),
});
export type UpdateResult = z.infer<typeof UpdateResult>;

/**
 * `<install>/state/last-diagnostics.json` (p6-worker-boot-diagnostics): evidence of the last attempt that failed its
 * health check, for the daemon to attach to UPDATE_STATUS. Its own file so last-result.json keeps the exact shape
 * older daemons parse strictly.
 */
export const UpdateDiagnosticsFile = z.strictObject({
  schema: z.literal(1),
  attemptId: z.uuid(),
  diagnostics: UpdateDiagnostics,
});
export type UpdateDiagnosticsFile = z.infer<typeof UpdateDiagnosticsFile>;

export const VersionRef = z.strictObject({
  version: z.string().min(1).max(64),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type VersionRef = z.infer<typeof VersionRef>;

/** `<install>/state/update.json` — updater bookkeeping (crash-resumable health check). */
export const UpdaterState = z.strictObject({
  schema: z.literal(1),
  lastAttemptId: z.uuid().nullable(),
  phase: z.enum(['idle', 'health_check']),
  target: VersionRef.nullable(),
  previous: VersionRef.nullable(),
  attemptId: z.uuid().nullable(),
  restartedAt: z.iso.datetime().nullable(),
});
export type UpdaterState = z.infer<typeof UpdaterState>;

/** `<install>/state/active.json` */
export const ActiveVersion = z.strictObject({
  schema: z.literal(1),
  version: z.string().min(1).max(64),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  activatedAt: z.iso.datetime(),
});
export type ActiveVersion = z.infer<typeof ActiveVersion>;

export class UnsafeFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = 'UnsafeFileError';
  }
}

/**
 * Reads a file that a less privileged account controls, for a privileged reader:
 * - the last path component must not be a symlink (`O_NOFOLLOW`, POSIX);
 * - it must be a regular file (no FIFO/device: opened `O_NONBLOCK` so a FIFO cannot block us);
 * - at most `maxBytes` (checked on the open handle, then read exactly).
 * Returns `null` if it does not exist. The bytes are what the caller verifies — never the path.
 */
export async function readUntrustedFile(path: string, maxBytes: number): Promise<Buffer | null> {
  const flags =
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new UnsafeFileError(path, 'is a symbolic link');
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new UnsafeFileError(path, 'is not a regular file');
    if (st.size > maxBytes) throw new UnsafeFileError(path, `is larger than ${String(maxBytes)} bytes`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await handle.read(buf, read, st.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** Parses a small JSON document with a schema; `null` when absent or invalid (never throws on content). */
export async function readJsonDocument<S extends z.ZodType>(
  path: string,
  schema: S,
  maxBytes = 16 * 1024,
): Promise<z.infer<S> | null> {
  const raw = await readUntrustedFile(path, maxBytes);
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
