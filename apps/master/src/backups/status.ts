import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * p10-backup-restore (docs/design/p10-backup-restore.md §6): the backup service writes `status.json` and
 * `heartbeat.json` into `<backups>/status`, mounted read-only into the master. Both are untrusted input: size-capped,
 * Zod-validated, strings truncated. Nothing in them is secret (times, sizes, hashes, outcomes, short errors).
 */
export const STATUS_MAX_BYTES = 256 * 1024;

const Str = (max: number): z.ZodType<string, string> => z.string().transform((s) => s.slice(0, max));
const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');
const Count = z.number().int().min(0);

/** Run shapes over a string type: truncating when parsing the file, plain for the API response schema. */
function runSchemas(S: (max: number) => z.ZodType<string, string>) {
  const run = z.object({
    runId: S(80),
    reason: S(40).optional(),
    startedAt: Iso,
    finishedAt: Iso.nullable(),
    durationMs: Count.nullable(),
    outcome: z.enum(['ok', 'partial', 'failed']),
    tier: z.enum(['monthly', 'weekly', 'daily', 'frequent']).nullable(),
    schemaVersion: S(16).nullable(),
    dbBytes: Count.nullable(),
    dbSha256: S(64).nullable(),
    secrets: z.enum(['ok', 'failed', 'missing']),
    offsite: z.object({
      status: z.enum(['not_configured', 'uploaded', 'failed']),
      target: S(300).nullable(),
      error: S(500).nullable(),
    }),
    warnings: z.array(S(500)).max(20),
    error: S(500).nullable(),
    removed: z.array(S(80)).max(500).optional(),
  });
  const drill = z.object({
    runId: S(80),
    backupId: S(80).nullable(),
    startedAt: Iso,
    finishedAt: Iso.nullable(),
    outcome: z.enum(['passed', 'failed']),
    restoreMs: Count.nullable(),
    totalMs: Count.nullable(),
    dumpBytes: Count.nullable(),
    restoredBytes: Count.nullable(),
    checks: z.array(z.object({ name: S(40), ok: z.boolean(), detail: S(500) })).max(20),
    error: S(500).nullable(),
    /** p11-master-resilience: the standby part (base + WAL replay); absent in older reports / WAL archiving off. */
    standby: z
      .object({
        at: Iso,
        outcome: z.enum(['passed', 'failed']),
        baseId: S(80).nullable(),
        targetTime: Iso.nullable(),
        recoveredTo: Iso.nullable(),
        replayedSegments: Count,
        restoreMs: Count.nullable(),
        error: S(500).nullable(),
      })
      .nullable()
      .optional(),
  });
  return { run, drill };
}
const parsed = runSchemas(Str);
const plain = runSchemas(() => z.string());
export const BackupRun = parsed.run;
export type BackupRun = z.infer<typeof BackupRun>;
export const DrillRun = parsed.drill;
export type DrillRun = z.infer<typeof DrillRun>;
/** Response-schema variants (no transforms: fastify-type-provider-zod encodes responses). */
export const BackupRunBody = plain.run;
export const DrillRunBody = plain.drill;

export const BackupStatusFile = z.object({
  format: z.literal('remana-backup-status/v1'),
  env: Str(32),
  updatedAt: Iso.nullable(),
  offsite: z
    .object({
      configured: z.boolean(),
      target: Str(300).nullable(),
      lastUploadAt: Iso.nullable(),
      lastError: Str(500).nullable(),
    })
    .catch({ configured: false, target: null, lastUploadAt: null, lastError: null }),
  encryption: z
    .object({ configured: z.boolean(), recipients: Count, error: Str(500).nullable().optional() })
    .catch({ configured: false, recipients: 0 }),
  storage: z
    .object({ backups: Count, bytes: Count, freeBytes: Count.nullable() })
    .catch({ backups: 0, bytes: 0, freeBytes: null }),
  lastBackup: BackupRun.nullable(),
  lastSuccessfulBackup: BackupRun.nullable(),
  backups: z.array(BackupRun).max(50).catch([]),
  lastDrill: DrillRun.nullable(),
  lastSuccessfulDrill: DrillRun.nullable(),
  drills: z.array(DrillRun).max(50).catch([]),
});
export type BackupStatusFile = z.infer<typeof BackupStatusFile>;

export const Heartbeat = z.object({
  format: z.literal('remana-backup-heartbeat/v1'),
  env: Str(32),
  at: Iso,
  startedAt: Iso,
  nextBackupAt: Iso,
  nextDrillAt: Iso.nullable(),
  expectedIntervalMs: z
    .number()
    .int()
    .min(60_000)
    .max(31 * 86_400_000),
  schedule: z.object({
    mode: z.enum(['daily', 'interval']),
    intervalMinutes: z.number().int().nullable(),
    timeOfDay: Str(5),
    drill: Str(40),
  }),
  retention: z.object({ daily: Count, weekly: Count, monthly: Count, keepRecentHours: Count }),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** p11-master-resilience: one base backup run as recorded in standby.json. */
const BaseRun = z.object({
  id: Str(80),
  startedAt: Iso,
  finishedAt: Iso.nullable(),
  outcome: z.enum(['ok', 'partial', 'failed']),
  bytes: Count.nullable(),
  startWalFile: Str(40).nullable(),
  offsite: z.object({ status: z.enum(['not_configured', 'uploaded', 'failed']), error: Str(500).nullable() }),
  error: Str(500).nullable(),
});

/**
 * p11-master-resilience: `standby.json` — WAL shipping progress and base backups (warm standby). Absent when WAL
 * archiving was never enabled. Like status.json untrusted input: capped, validated, strings truncated.
 */
export const StandbyFile = z.object({
  format: z.literal('remana-backup-standby/v1'),
  env: Str(32),
  updatedAt: Iso.nullable(),
  walArchive: z.object({ enabled: z.boolean() }).catch({ enabled: false }),
  lastShippedSegment: Str(64).nullable().catch(null),
  lastShippedAt: Iso.nullable().catch(null),
  lastArchivedSegment: Str(64).nullable().catch(null),
  lastArchivedAt: Iso.nullable().catch(null),
  pendingSegments: Count.catch(0),
  lagSeconds: Count.catch(0),
  localSegments: Count.catch(0),
  localBytes: Count.catch(0),
  offsite: z
    .object({ configured: z.boolean(), target: Str(300).nullable(), lastError: Str(500).nullable() })
    .catch({ configured: false, target: null, lastError: null }),
  gaps: z.array(Str(64)).max(10).catch([]),
  lastBaseBackup: BaseRun.nullable().catch(null),
  lastSuccessfulBaseBackup: BaseRun.nullable().catch(null),
});
export type StandbyFile = z.infer<typeof StandbyFile>;

export interface BackupFiles {
  readonly status: BackupStatusFile | null;
  readonly heartbeat: Heartbeat | null;
  /** p11-master-resilience: absent/null = WAL archiving never ran. */
  readonly standby?: StandbyFile | null;
  /** Problems reading the files (missing files are not problems: the service may not run yet). */
  readonly problems: readonly string[];
}

async function readCapped(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(STATUS_MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > STATUS_MAX_BYTES) throw new Error('file too large');
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function readOne<T>(
  dir: string,
  name: string,
  schema: z.ZodType<T>,
  problems: string[],
): Promise<T | null> {
  try {
    const text = await readCapped(join(dir, name));
    if (text === null) return null;
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      problems.push(`${name} has an unexpected format`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    problems.push(
      `${name} could not be read (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`,
    );
    return null;
  }
}

/** Reads both files from the status directory; never throws. */
export async function readBackupFiles(dir: string): Promise<BackupFiles> {
  const problems: string[] = [];
  const status = await readOne(dir, 'status.json', BackupStatusFile, problems);
  const heartbeat = await readOne(dir, 'heartbeat.json', Heartbeat, problems);
  const standby = await readOne(dir, 'standby.json', StandbyFile, problems);
  return { status, heartbeat, standby, problems };
}
