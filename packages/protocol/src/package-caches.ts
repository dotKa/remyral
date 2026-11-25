import { z } from 'zod';
import { Identifier, NonNegativeInt, Timestamp } from './common.js';

/**
 * p6-warm-caches (ADR-0029): per-machine package caches shared by the jobs of one project. The worker reports what
 * it holds in CAPABILITIES.packageCaches (additive in 1.0, with the `package-caches-v1` feature); the master shows it
 * on the machine page. Sizes and project ids only — never paths or file names.
 */

/** Worker feature: shared package caches, `workspace.packageCacheMaxBytes`, CAPABILITIES.packageCaches. */
export const PACKAGE_CACHES_FEATURE = 'package-caches-v1';

/** Package managers with a shared cache directory (one subdirectory each below a project's cache dir). */
export const PACKAGE_CACHE_MANAGERS = [
  'npm',
  'pnpm',
  'yarn',
  'yarn-berry',
  'pip',
  'uv',
  'cargo',
  'go',
] as const;
export const PackageCacheManager = z.enum(PACKAGE_CACHE_MANAGERS);
export type PackageCacheManager = z.infer<typeof PackageCacheManager>;

/** Default per-machine limit (10 GiB) and the bounds of the setting. */
export const DEFAULT_PACKAGE_CACHE_MAX_BYTES = 10 * 1024 ** 3;
export const MAX_PACKAGE_CACHE_MAX_BYTES = 1024 ** 4;
/** At most this many projects are listed in a report (the largest first); `truncated` says more exist. */
export const MAX_PACKAGE_CACHE_REPORT_PROJECTS = 128;

export const PackageCacheReport = z.object({
  /** Caches are handed to eligible jobs on this machine. */
  enabled: z.boolean(),
  /** Why not: the local config switched them off, or the limit in effect is 0. */
  disabledReason: z.enum(['local_config', 'limit_zero']).optional(),
  /** The size limit in effect (panel value, else the local file's, else the default). */
  maxBytes: NonNegativeInt,
  /** Bytes on disk of every project's cache, as of `scannedAt`. */
  usedBytes: NonNegativeInt,
  projects: z
    .array(
      z.object({
        projectId: Identifier,
        bytes: NonNegativeInt,
        lastUsedAt: Timestamp,
        /** A running attempt holds it (never evicted then). */
        inUse: z.boolean(),
        managers: z
          .array(z.object({ manager: PackageCacheManager, bytes: NonNegativeInt }))
          .max(PACKAGE_CACHE_MANAGERS.length),
      }),
    )
    .max(MAX_PACKAGE_CACHE_REPORT_PROJECTS),
  truncated: z.boolean().optional(),
  /** Last full size scan (null: none yet since the worker started). */
  scannedAt: Timestamp.nullable(),
  /** Last LRU sweep that removed something. */
  lastEviction: z
    .object({ at: Timestamp, projects: NonNegativeInt, bytes: NonNegativeInt })
    .nullable()
    .optional(),
});
export type PackageCacheReport = z.infer<typeof PackageCacheReport>;
