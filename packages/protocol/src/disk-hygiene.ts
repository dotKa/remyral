import { z } from 'zod';
import { NonNegativeInt, Timestamp } from './common.js';

/**
 * p17-disk-selfclean (docs/design/p17-disk-selfclean.md): the worker frees its own disk space when the free space under
 * its workspace root falls towards the minimum it keeps there (`workspace.minFreeBytes`). It deletes only what it
 * created itself and can recreate (staged update downloads, its package caches, kept working directories past their
 * retention, inactive managed runtime versions, rotated logs, temporary directories of finished jobs) — never user data
 * outside its data dir, never Docker images, never the git mirrors.
 *
 * Everything here is additive in protocol 1.0 and travels only with the worker feature `disk-hygiene-v1`:
 *  - CAPABILITIES `diskHygiene` ({@link DiskHygieneReport}): on / off, the threshold and target, the last run (bytes
 *    freed per category), the next runs and — when space is still low after a run — what uses the space at the top
 *    level of the data dir and the workspace root (fixed directory names and sizes only, never a file name).
 *  - OPS_COMMAND `disk.clean` → OPS_UPDATE `diskClean` ({@link DiskHygieneRun}): "Şimdi temizle" on the machine page.
 *  - APPLY_WORKER_CONFIG `workspace.diskHygiene` ({@link DiskHygieneSettings}): enable / disable, the target margin.
 */

export const DISK_HYGIENE_FEATURE = 'disk-hygiene-v1';

/** What a run may delete, in the order a low-disk run uses them (least valuable first). */
export const DISK_HYGIENE_CATEGORIES = [
  'temp',
  'logs',
  'releases',
  'workspaces',
  'runtimes',
  'packageCaches',
] as const;
export const DiskHygieneCategory = z.enum(DISK_HYGIENE_CATEGORIES);
export type DiskHygieneCategory = z.infer<typeof DiskHygieneCategory>;

/**
 * Why a run happened: `low_disk` (free space below the threshold plus the margin), `daily` (the light run: only what
 * is always safe to drop), `manual` (the panel's "Şimdi temizle").
 */
export const DiskHygieneTrigger = z.enum(['low_disk', 'daily', 'manual']);
export type DiskHygieneTrigger = z.infer<typeof DiskHygieneTrigger>;

/** Default margin above `workspace.minFreeBytes` a low-disk run cleans up to (1 GiB). */
export const DEFAULT_DISK_HYGIENE_MARGIN_BYTES = 1024 ** 3;
export const MAX_DISK_HYGIENE_MARGIN_BYTES = 1024 ** 4;

/** APPLY_WORKER_CONFIG `workspace.diskHygiene` (only to `disk-hygiene-v1` workers). Absent: on, default margin. */
export const DiskHygieneSettings = z.object({
  enabled: z.boolean(),
  /** Free bytes above `workspace.minFreeBytes` a low-disk run aims for (and below which it starts). */
  marginBytes: z.number().int().min(0).max(MAX_DISK_HYGIENE_MARGIN_BYTES).optional(),
});
export type DiskHygieneSettings = z.infer<typeof DiskHygieneSettings>;

/**
 * Top-level directory names a usage report may name: the worker's own directories under its data dir and under the
 * workspace root. Anything else is summed into `other` (a name the worker did not create is never reported).
 */
export const DISK_USAGE_NAMES = [
  // <dataDir>
  'runtimes',
  'runtime-state',
  'runtime-verify',
  'caches',
  'tools',
  'mcp',
  'mcp-state',
  'logs',
  'updates',
  'assistant',
  'assistant-state',
  'accounts',
  'sandbox',
  'services',
  'state',
  // <workspaceRoot>
  'jobs',
  'kept',
  'mirrors',
  'sandboxes',
  '.remyral',
  // the top-level entry of the data dir that holds the workspace root (when it is inside the data dir)
  'workspace-root',
  // everything else, files at the top level included
  'other',
] as const;
export const DiskUsageName = z.enum(DISK_USAGE_NAMES);
export type DiskUsageName = z.infer<typeof DiskUsageName>;

export const DiskUsageEntry = z.object({ name: DiskUsageName, bytes: NonNegativeInt });
export type DiskUsageEntry = z.infer<typeof DiskUsageEntry>;

/** What uses the space (measured only when a run could not reach its target). */
export const DiskUsageReport = z.object({
  at: Timestamp,
  dataDir: z.array(DiskUsageEntry).max(DISK_USAGE_NAMES.length),
  /** The workspace root's own top level (also counted in `dataDir` as `workspace-root` when it lies inside it). */
  workspaceRoot: z.array(DiskUsageEntry).max(DISK_USAGE_NAMES.length),
  /** The scan stopped at its bounds (time / entries): the sizes are lower bounds. */
  partial: z.boolean().optional(),
});
export type DiskUsageReport = z.infer<typeof DiskUsageReport>;

export const DiskHygieneFreed = z.object({
  category: DiskHygieneCategory,
  bytes: NonNegativeInt,
  /** Directories / files removed. */
  items: NonNegativeInt,
});
export type DiskHygieneFreed = z.infer<typeof DiskHygieneFreed>;

/** One run (CAPABILITIES `diskHygiene.lastRun`, OPS_UPDATE `diskClean`). */
export const DiskHygieneRun = z.object({
  trigger: DiskHygieneTrigger,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  /** Free bytes under the workspace root before and after (null: not measurable). */
  freeBefore: NonNegativeInt.nullable(),
  freeAfter: NonNegativeInt.nullable(),
  freedBytes: NonNegativeInt,
  /** Per category, only those that freed something. */
  freed: z.array(DiskHygieneFreed).max(DISK_HYGIENE_CATEGORIES.length),
  /** Free space is still below the target after the run. */
  stillLow: z.boolean(),
  /** Items that could not be removed (permissions, in use); the worker log says which. */
  errors: NonNegativeInt,
  /**
   * p17-worker-managed (additive): items another account owns that the worker may not delete (on Windows the per-job
   * accounts' sandbox directories, EPERM / EACCES) — left in place quietly, not counted as errors.
   */
  skipped: NonNegativeInt.optional(),
});
export type DiskHygieneRun = z.infer<typeof DiskHygieneRun>;

/** CAPABILITIES `diskHygiene` (with `disk-hygiene-v1`). */
export const DiskHygieneReport = z.object({
  enabled: z.boolean(),
  /** `workspace.minFreeBytes` in effect (jobs are refused below it). */
  thresholdBytes: NonNegativeInt,
  marginBytes: NonNegativeInt,
  /** threshold + margin: a low-disk run starts below it and cleans up to it. */
  targetBytes: NonNegativeInt,
  /** Free bytes under the workspace root at the last check (null: not measured yet / not measurable). */
  freeBytes: NonNegativeInt.nullable(),
  checkedAt: Timestamp.nullable(),
  /** A run is going on now. */
  running: z.boolean(),
  lastRun: DiskHygieneRun.nullable(),
  /** Earliest time the next low-disk run may start (runs are spaced) — null when not limited. */
  nextLowDiskAt: Timestamp.nullable(),
  /** The next daily light run. */
  nextDailyAt: Timestamp.nullable(),
  /** What uses the space — only after a run that could not reach the target. */
  usage: DiskUsageReport.nullable(),
});
export type DiskHygieneReport = z.infer<typeof DiskHygieneReport>;
