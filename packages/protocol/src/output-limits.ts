import { z } from 'zod';
import { NonNegativeInt } from './common.js';
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS, MAX_ARTIFACTS_TOTAL_BYTES } from './workspace.js';

/**
 * p17-output-limits (docs/design/p17-output-limits.md): how many files a workspace job may return, and what happens
 * to the rest. 500 files is the default; a larger result continues as a zip.
 *
 *  - **Count:** at most `maxFiles` output files per attempt (inline + blob store together; the run's `summary.md` and
 *    the special artifacts — site bundle, integration report, function result — are not counted). Default
 *    {@link OUTPUT_LIMITS.defaultMaxFiles}; the owner sets it in Ayarlar → Sunucu ayarları → İşler (panel key
 *    `jobs.outputMaxFiles`, environment `JOB_OUTPUT_MAX_FILES`), a workspace project may lower it (never above the
 *    server value, never above {@link OUTPUT_LIMITS.ceilingMaxFiles}).
 *  - **Bytes decide the path:** a file goes inline (ARTIFACT_CHUNKs staged in Postgres) only while it fits the inline
 *    budget ({@link OUTPUT_LIMITS.inlineFileBytes} per file, {@link OUTPUT_LIMITS.inlineTotalBytes} per attempt);
 *    everything else goes to the blob store (`execution.blobUpload`), bounded by its per-job bytes and the project's
 *    storage quota. Without a blob store for the job: inline only.
 *  - **Above the limit → zip:** the files beyond the count (or beyond the per-job bytes unpacked) are packed into one
 *    `out-rest.zip` (paths kept) uploaded through the blob path, within {@link OUTPUT_LIMITS.zipMaxEntries} entries and
 *    the blob limits; what still does not fit is reported, never dropped silently.
 *  - **Report:** JOB_RESULT `outputs` ({@link OutputReport}) — returned count, the zip, skipped files with a code.
 *
 * Feature `output-limits-v1`: the master sends `execution.outputLimits` (and a `blobUpload.maxFiles` above the legacy
 * 20) only to workers that advertise it; older workers keep the legacy limits (20 inline + 20 blob files, no zip) and
 * the master enforces those for them.
 */

export const OUTPUT_LIMITS_FEATURE = 'output-limits-v1';

export const OUTPUT_LIMITS = {
  /** Default output files per job. */
  defaultMaxFiles: 500,
  /** Highest value the server setting or a project may set. */
  ceilingMaxFiles: 2000,
  /** What workers without `output-limits-v1` return (inline; plus as many blob uploads). */
  legacyMaxFiles: MAX_ARTIFACTS,
  /** Largest file returned inline (chunks staged in Postgres). */
  inlineFileBytes: MAX_ARTIFACT_BYTES,
  /** Inline bytes per attempt (the Postgres staging budget). */
  inlineTotalBytes: MAX_ARTIFACTS_TOTAL_BYTES,
  /** Entries `out/` may have before the worker stops looking (the rest is reported as not looked at). */
  walkMaxEntries: 20_000,
  /** Files one overflow zip may hold (no ZIP64: well below 65 535). */
  zipMaxEntries: 10_000,
  /** Largest single file packed into the overflow zip (read into memory to check, redact and compress). */
  zipEntryMaxBytes: 64 * 1024 * 1024,
  /** Largest overflow zip (no ZIP64: below 4 GiB; also bounded by the blob per-file and per-job limits). */
  zipMaxBytes: 2 * 1024 * 1024 * 1024 - 1,
  /** Name of the overflow zip in `out/`'s namespace (a numbered name when the agent wrote one itself). */
  zipName: 'out-rest.zip',
  /** Skipped files listed by name in the report (the count is always exact). */
  reportMaxSkipped: 100,
} as const;

/** ASSIGN_JOB `execution.outputLimits` (only to `output-limits-v1` workers; workspace jobs). */
export const AssignedOutputLimits = z.object({
  /** Output files per attempt (inline + blob, the zip counted as one). */
  maxFiles: z.number().int().min(1).max(OUTPUT_LIMITS.ceilingMaxFiles),
  /** The files beyond the limits may be packed into one zip (needs `execution.blobUpload`). */
  zipOverflow: z.boolean(),
});
export type AssignedOutputLimits = z.infer<typeof AssignedOutputLimits>;

/** Why a file of `out/` was not returned (the console words it; `reason` is the worker's English detail). */
export const OutputSkipCode = z.enum([
  'type',
  'too_large',
  'count',
  'inline_budget',
  'job_bytes',
  'secret',
  'content',
  'symlink',
  'not_regular',
  'nested',
  'unreadable',
  'upload',
  'zip_full',
  'not_listed',
  'other',
]);
export type OutputSkipCode = z.infer<typeof OutputSkipCode>;

export const OutputSkipped = z.object({
  name: z.string().min(1).max(300),
  code: OutputSkipCode,
  reason: z.string().max(200),
});
export type OutputSkipped = z.infer<typeof OutputSkipped>;

/**
 * JOB_RESULT `outputs` (additive in 1.0; `output-limits-v1` workers): what became of `out/`. Older masters drop it.
 * Names are the agent's (untrusted text, shown as text).
 */
export const OutputReport = z.object({
  /** The limit in force for this attempt. */
  maxFiles: z.number().int().min(1).max(OUTPUT_LIMITS.ceilingMaxFiles),
  /** Output files returned (inline + blob, the zip counted as one; the summary not counted). */
  returned: NonNegativeInt,
  /** The blob store was available to this attempt (otherwise inline only). */
  storage: z.boolean(),
  /** The overflow zip, when one was made and returned. */
  zip: z
    .object({
      name: z.string().min(1).max(255),
      files: z.number().int().min(1).max(OUTPUT_LIMITS.zipMaxEntries),
      bytes: NonNegativeInt,
    })
    .optional(),
  /** Up to {@link OUTPUT_LIMITS.reportMaxSkipped} skipped files (the first ones). */
  skipped: z.array(OutputSkipped).max(OUTPUT_LIMITS.reportMaxSkipped),
  /** All skipped files (≥ `skipped.length`). */
  skippedCount: NonNegativeInt,
});
export type OutputReport = z.infer<typeof OutputReport>;

/**
 * The effective file limit of a job: the server value, lowered by the project's (never raised), clamped to
 * [1, ceiling].
 */
export function effectiveMaxFiles(server: number, project: number | null): number {
  const s = Math.min(Math.max(1, Math.trunc(server)), OUTPUT_LIMITS.ceilingMaxFiles);
  return project === null ? s : Math.max(1, Math.min(s, Math.trunc(project)));
}

/** The effective per-job blob bytes: the server's, lowered by the project's (never raised). */
export function effectiveJobBytes(server: number, project: number | null): number {
  return project === null ? server : Math.max(1, Math.min(server, project));
}
