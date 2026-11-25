import { z } from 'zod';
import { AttemptId, Epoch, Identifier, NonNegativeInt, Text, Timestamp } from './common.js';

/**
 * p15-workspace-retention (docs/design/p15-workspace-retention.md): the whole working directory of a repository-less
 * (workspace / scratch) job is kept on its machine after the job ends — succeeded, failed or cancelled — for a
 * retention period, under a per-machine size cap, and never removed while a pending deploy, service or follow-up job
 * still needs it. The master tracks the kept directories ("Çalışma dosyaları"), lists / reads them through the worker,
 * and seeds follow-up jobs from them (same machine: a local copy; another machine: relayed through the master).
 *
 * Wire (feature `workfiles-v1`; every message is a control message, seq 0, never in a durable outbox):
 *
 *   ASSIGN_JOB execution.keepFiles {expiresAt, maxBytes}       keep the scratch dir after the end (else: removed)
 *   ASSIGN_JOB execution.seedFiles {jobId, attemptId, mode}    start from these kept files (local copy / relay)
 *   CAPABILITIES workfiles {maxBytes, usedBytes, kept[]}       reconciliation after every connect
 *   WORKFILES_STATUS {maxBytes, usedBytes, kept[], removed[]}  worker → master after every keep / removal
 *   WORKFILES_REQUEST {requestId, jobId, attemptId, op}        master → worker: list / read / delete / extend
 *   WORKFILES_DATA {requestId, status, …}                      worker → master: the answer
 *   WORKFILES_FETCH {attemptId, epoch, requestId, op}          worker → master (job): relay a seed (list / read)
 *   WORKFILES_FETCH_DATA {requestId, status, …}                master → worker (job): the relayed answer
 */

export const WORKFILES_FEATURE = 'workfiles-v1';

export const WORKFILES_LIMITS = {
  /** Default retention of a kept working directory (Ayarlar; a project may override; 0 = delete at the end). */
  retentionDaysDefault: 14,
  retentionDaysMax: 365,
  /** Default per-machine cap of all kept working directories. */
  machineCapBytesDefault: 10 * 1024 ** 3,
  machineCapBytesMin: 256 * 1024 ** 2,
  machineCapBytesMax: 1024 ** 4,
  /** Entries one listing answers with at most (the rest is `truncated`). */
  listMax: 5000,
  /** Bytes of one read answer. */
  readChunkBytes: 192 * 1024,
  pathMax: 512,
  depthMax: 16,
  /** Kept directories one report carries at most (newest first). */
  reportMax: 500,
  /** The worker removes an expired directory on its own only this long after the master's expiry (the master sweeps). */
  localGraceMs: 24 * 60 * 60 * 1000,
  /** A zip download, a relayed seed and a repository import move at most this much. */
  transferMaxBytes: 200 * 1024 ** 2,
  transferMaxFiles: 2000,
  /** One file of a zip / import / relay at most (read whole on the master). */
  fileMaxBytes: 50 * 1024 ** 2,
} as const;

// eslint-disable-next-line no-control-regex -- control characters are refused in kept file paths
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A relative, "/"-separated path inside a kept directory: no absolute paths, no "." / ".." segments, no backslashes. */
export function isWorkfilePath(p: string): boolean {
  if (p.length === 0 || p.length > WORKFILES_LIMITS.pathMax) return false;
  if (p.startsWith('/') || p.includes('\\') || CONTROL.test(p)) return false;
  const parts = p.split('/');
  if (parts.length > WORKFILES_LIMITS.depthMax) return false;
  return parts.every((s) => s !== '' && s !== '.' && s !== '..');
}

export const WorkfilePath = z.string().refine(isWorkfilePath, 'a relative path inside the working directory');

export const WorkfilesOutcome = z.enum(['succeeded', 'failed', 'cancelled']);
export type WorkfilesOutcome = z.infer<typeof WorkfilesOutcome>;

/** ASSIGN_JOB `execution.keepFiles` (only to `workfiles-v1` workers; workspace jobs). */
export const AssignedKeepFiles = z.object({
  /** When the kept directory expires (the master extends it while something still needs the files). */
  expiresAt: Timestamp,
  /** The machine's cap for all kept directories; older unpinned ones are evicted first. */
  maxBytes: z
    .number()
    .int()
    .min(WORKFILES_LIMITS.machineCapBytesMin)
    .max(WORKFILES_LIMITS.machineCapBytesMax),
});
export type AssignedKeepFiles = z.infer<typeof AssignedKeepFiles>;

/**
 * ASSIGN_JOB `execution.seedFiles`: the attempt starts from the kept files of an earlier job — `local` copies them on
 * this machine, `relay` fetches them through the master (WORKFILES_FETCH) from the machine that keeps them.
 */
export const AssignedSeedFiles = z.object({
  jobId: Identifier,
  attemptId: Identifier,
  mode: z.enum(['local', 'relay']),
});
export type AssignedSeedFiles = z.infer<typeof AssignedSeedFiles>;

/** One kept working directory as the worker reports it. */
export const KeptWorkfiles = z.object({
  jobId: Identifier,
  attemptId: Identifier,
  projectId: Identifier,
  outcome: WorkfilesOutcome,
  sizeBytes: NonNegativeInt,
  files: NonNegativeInt,
  keptAt: Timestamp,
  expiresAt: Timestamp,
  /** Set by the master while a deploy / service / follow-up needs the files (never evicted before it). */
  pinnedUntil: Timestamp.nullable(),
  /** Files removed at keep time (a binary that looked like it holds a secret) and text files redacted. */
  dropped: NonNegativeInt.optional(),
  redacted: NonNegativeInt.optional(),
});
export type KeptWorkfiles = z.infer<typeof KeptWorkfiles>;

/** CAPABILITIES `workfiles` (with `workfiles-v1`): the machine's kept directories (newest first). */
export const WorkfilesReport = z.object({
  maxBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  kept: z.array(KeptWorkfiles).max(WORKFILES_LIMITS.reportMax),
});
export type WorkfilesReport = z.infer<typeof WorkfilesReport>;

export const WorkfilesRemovedReason = z.enum(['expired', 'evicted', 'deleted', 'missing']);
export type WorkfilesRemovedReason = z.infer<typeof WorkfilesRemovedReason>;

/** worker → master `WORKFILES_STATUS`: what changed (kept now, removed and why) plus the totals. */
export const WorkfilesStatusPayload = WorkfilesReport.extend({
  removed: z
    .array(z.object({ jobId: Identifier, attemptId: Identifier, reason: WorkfilesRemovedReason }))
    .max(WORKFILES_LIMITS.reportMax),
});
export type WorkfilesStatusPayload = z.infer<typeof WorkfilesStatusPayload>;

export const WorkfilesOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  z.object({ op: z.literal('read'), path: WorkfilePath, offset: NonNegativeInt }),
  z.object({ op: z.literal('delete'), reason: z.enum(['user', 'expired', 'evicted']) }),
  z.object({ op: z.literal('extend'), expiresAt: Timestamp, pinnedUntil: Timestamp.nullable() }),
]);
export type WorkfilesOp = z.infer<typeof WorkfilesOp>;

/** The read-only part of {@link WorkfilesOp} (what a seeding job may relay). */
export const WorkfilesReadOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  z.object({ op: z.literal('read'), path: WorkfilePath, offset: NonNegativeInt }),
]);
export type WorkfilesReadOp = z.infer<typeof WorkfilesReadOp>;

/** master → worker `WORKFILES_REQUEST`. */
export const WorkfilesRequestPayload = z.object({
  requestId: z.uuid(),
  jobId: Identifier,
  attemptId: Identifier,
  op: WorkfilesOp,
});
export type WorkfilesRequestPayload = z.infer<typeof WorkfilesRequestPayload>;

export const WorkfileEntry = z.object({
  path: WorkfilePath,
  /** `other`: a symbolic link, socket or device — listed, never read or copied. */
  kind: z.enum(['file', 'dir', 'other']),
  size: NonNegativeInt,
  mtime: Timestamp,
});
export type WorkfileEntry = z.infer<typeof WorkfileEntry>;

/** base64 of at most {@link WORKFILES_LIMITS.readChunkBytes} bytes. */
const ChunkData = z
  .string()
  .max(Math.ceil(WORKFILES_LIMITS.readChunkBytes / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');

/** worker → master `WORKFILES_DATA`, and master → worker `WORKFILES_FETCH_DATA` (`requestId` of the request). */
export const WorkfilesDataPayload = z.object({
  requestId: z.uuid(),
  status: z.enum(['ok', 'not_found', 'refused', 'error']),
  detail: Text.optional(),
  /** list */
  entries: z.array(WorkfileEntry).max(WORKFILES_LIMITS.listMax).optional(),
  truncated: z.boolean().optional(),
  /** read */
  offset: NonNegativeInt.optional(),
  data: ChunkData.optional(),
  eof: z.boolean().optional(),
  size: NonNegativeInt.optional(),
  /** extend / delete: the record after the change (absent after a delete). */
  kept: KeptWorkfiles.optional(),
});
export type WorkfilesDataPayload = z.infer<typeof WorkfilesDataPayload>;

/** worker → master `WORKFILES_FETCH` (job message; fenced by the seeding attempt's live lease). */
export const WorkfilesFetchPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  op: WorkfilesReadOp,
});
export type WorkfilesFetchPayload = z.infer<typeof WorkfilesFetchPayload>;

/** Key of a kept directory (job + attempt). */
export function workfilesKey(e: { readonly jobId: string; readonly attemptId: string }): string {
  return `${e.jobId}/${e.attemptId}`;
}

/** Pinned now: a deploy / service / follow-up needs the files until `pinnedUntil`. */
export function workfilesPinned(e: { readonly pinnedUntil: string | null }, now: Date): boolean {
  return e.pinnedUntil !== null && Date.parse(e.pinnedUntil) > now.getTime();
}

/**
 * The kept directories to evict so that the total fits `capBytes`: the oldest first (by `keptAt`), never a pinned one
 * and never one in `protect` (e.g. the directory being kept right now). May return fewer than needed (everything
 * left is pinned or protected). Pure; shared by the worker (at keep time) and the master (sweep).
 */
export function pickEvictions<
  T extends {
    readonly jobId: string;
    readonly attemptId: string;
    readonly sizeBytes: number;
    readonly keptAt: string;
    readonly pinnedUntil: string | null;
  },
>(entries: readonly T[], capBytes: number, now: Date, protect: ReadonlySet<string> = new Set()): T[] {
  let total = entries.reduce((n, e) => n + e.sizeBytes, 0);
  if (total <= capBytes) return [];
  const oldestFirst = [...entries].sort(
    (a, b) => a.keptAt.localeCompare(b.keptAt) || workfilesKey(a).localeCompare(workfilesKey(b)),
  );
  const out: T[] = [];
  for (const e of oldestFirst) {
    if (total <= capBytes) break;
    if (workfilesPinned(e, now) || protect.has(workfilesKey(e))) continue;
    out.push(e);
    total -= e.sizeBytes;
  }
  return out;
}

/** The expiry a kept directory honours: the later of its own expiry and its pin. */
export function workfilesEffectiveExpiry(e: {
  readonly expiresAt: string;
  readonly pinnedUntil: string | null;
}): number {
  const exp = Date.parse(e.expiresAt);
  const pin = e.pinnedUntil === null ? 0 : Date.parse(e.pinnedUntil);
  return Math.max(exp, pin);
}
