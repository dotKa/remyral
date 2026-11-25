import {
  type AssignedBlobUpload,
  type AssignedOutputLimits,
  BLOB_LIMITS,
  effectiveJobBytes,
  effectiveMaxFiles,
  OUTPUT_LIMITS,
  OutputReport,
  type OutputSkipCode,
  type OutputSkipped,
} from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p17-output-limits (docs/design/p17-output-limits.md): the output limits of workspace jobs on the master side.
 *
 *  - **Assignment:** the server's file limit (panel `jobs.outputMaxFiles`, else `JOB_OUTPUT_MAX_FILES`, default 500),
 *    lowered by the workspace project's `output_max_files`; the blob store's per-job bytes lowered by the project's
 *    `output_max_job_bytes`. `output-limits-v1` workers get `execution.outputLimits` and `blobUpload.maxFiles` = the
 *    limit; older workers keep `blobUpload.maxFiles` = 20 (their schema) and no zip. The effective values are recorded
 *    on the attempt (`job_attempts.output_max_files` / `output_max_job_bytes`) — the staging, commit and grant checks
 *    read them, so a later settings change does not move the bounds of a running attempt.
 *  - **Report:** JOB_RESULT `outputs` of the latest attempt plus the files the master itself refused (ARTIFACT_REF
 *    rejected: limit, quota, invalid), for the job page and the chat card.
 */

/** The server's output limits and the blob store's state now (settings views). */
export interface OutputServerLimits {
  readonly maxFiles: number;
  readonly maxJobBytes: number;
  readonly maxFileBytes: number;
  readonly thresholdBytes: number;
  /** Where blob uploads go now; `unavailable`: object storage selected but not usable (inline only). */
  readonly storage: 'local' | 's3' | 'unavailable';
}

/** The fixed facts of the inline path and the ceilings, for the settings views. */
export const OUTPUT_INLINE_INFO = {
  inlineFileBytes: OUTPUT_LIMITS.inlineFileBytes,
  inlineTotalBytes: OUTPUT_LIMITS.inlineTotalBytes,
  ceilingMaxFiles: OUTPUT_LIMITS.ceilingMaxFiles,
  ceilingJobBytes: BLOB_LIMITS.ceilingJobBytes,
  defaultMaxFiles: OUTPUT_LIMITS.defaultMaxFiles,
  zipName: OUTPUT_LIMITS.zipName,
} as const;

/** Range of a project's per-job byte limit (bytes). */
export const PROJECT_JOB_BYTES = { min: 1024 * 1024, max: BLOB_LIMITS.ceilingJobBytes } as const;

export interface ProjectOutputLimits {
  readonly maxFiles: number | null;
  readonly maxJobBytes: number | null;
}

export interface AttemptOutputLimits {
  /** Null: legacy limits (a worker without output-limits-v1, or no record). */
  readonly maxFiles: number | null;
  readonly maxJobBytes: number | null;
}

export async function loadProjectOutputLimits(db: Queryable, project: string): Promise<ProjectOutputLimits> {
  const { rows } = await db.query<{ files: number | null; bytes: string | null }>(
    `SELECT output_max_files AS files, output_max_job_bytes AS bytes FROM project_workspaces WHERE project = $1`,
    [project],
  );
  const r = rows[0];
  return {
    maxFiles: r?.files ?? null,
    maxJobBytes: r?.bytes === null || r?.bytes === undefined ? null : Number(r.bytes),
  };
}

export async function attemptOutputLimits(db: Queryable, attemptId: string): Promise<AttemptOutputLimits> {
  const { rows } = await db.query<{ files: number | null; bytes: string | null }>(
    `SELECT output_max_files AS files, output_max_job_bytes AS bytes FROM job_attempts WHERE id = $1`,
    [attemptId],
  );
  const r = rows[0];
  return {
    maxFiles: r?.files ?? null,
    maxJobBytes: r?.bytes === null || r?.bytes === undefined ? null : Number(r.bytes),
  };
}

/** One entry of the report's "not returned" list (the worker's, or a refusal of the master). */
export type ReportSkipCode = OutputSkipCode | 'quota';

export interface ReportSkipped {
  readonly name: string;
  readonly code: ReportSkipCode;
  readonly reason: string;
}

/** GET /jobs/:id/output-report. */
export interface OutputReportView {
  readonly attemptId: string;
  /** The limit in force (null: a worker before output-limits-v1 — the legacy limits). */
  readonly maxFiles: number | null;
  /** Files returned (null: the worker did not report). */
  readonly returned: number | null;
  /** The blob store was available to the attempt (null: unknown). */
  readonly storage: boolean | null;
  readonly zip: { readonly name: string; readonly files: number; readonly bytes: number } | null;
  readonly skipped: readonly ReportSkipped[];
  /** All skipped files (≥ skipped.length; refusals of the master included). */
  readonly skippedCount: number;
}

/** Reason codes of the master's own refusals (ARTIFACT_REF outcome_reason `artifact_<x>`). */
function refusalCode(reason: string): ReportSkipCode {
  switch (reason) {
    case 'artifact_limit':
      return 'count';
    case 'artifact_quota':
      return 'quota';
    case 'artifact_invalid':
      return 'content';
    case 'artifact_incomplete':
      return 'upload';
    default:
      return 'other';
  }
}

export class OutputLimitsService {
  constructor(
    private readonly deps: {
      readonly pool: Queryable;
      /** The server's output file limit now (panel value, else the environment's). */
      readonly serverMaxFiles: () => number;
    },
  ) {}

  /** The server value (clamped to the ceiling). */
  serverMaxFiles(): number {
    return effectiveMaxFiles(this.deps.serverMaxFiles(), null);
  }

  /**
   * ASSIGN_JOB for a workspace job: the effective limits, recorded on the attempt. `feature`: the worker advertises
   * `output-limits-v1`. `blob`: the store's assignment (null: none for this job).
   */
  async assignment(input: {
    readonly project: string;
    readonly attemptId: string;
    readonly feature: boolean;
    readonly blob: AssignedBlobUpload | null;
  }): Promise<{
    readonly outputLimits: AssignedOutputLimits | null;
    readonly blobUpload: AssignedBlobUpload | null;
  }> {
    const project = await loadProjectOutputLimits(this.deps.pool, input.project);
    const maxFiles = effectiveMaxFiles(this.deps.serverMaxFiles(), project.maxFiles);
    const blob =
      input.blob === null
        ? null
        : {
            ...input.blob,
            maxJobBytes: effectiveJobBytes(input.blob.maxJobBytes, project.maxJobBytes),
            // Older workers' schema stops at 20 (BLOB_LIMITS.maxFiles); newer ones get the job's file limit.
            maxFiles: input.feature ? maxFiles : Math.min(input.blob.maxFiles, BLOB_LIMITS.maxFiles),
          };
    await this.deps.pool.query(
      `UPDATE job_attempts SET output_max_files = $2, output_max_job_bytes = $3 WHERE id = $1`,
      [input.attemptId, input.feature ? maxFiles : null, blob?.maxJobBytes ?? null],
    );
    return {
      outputLimits: input.feature ? { maxFiles, zipOverflow: blob !== null } : null,
      blobUpload: blob,
    };
  }

  /** What became of the latest attempt's `out/` (null: nothing to say — no report and no refusal). */
  async report(jobId: string): Promise<OutputReportView | null> {
    const { rows } = await this.deps.pool.query<{
      attempt_id: string;
      outputs: unknown;
      max_files: number | null;
    }>(
      `SELECT a.id::text AS attempt_id, r.result -> 'outputs' AS outputs, a.output_max_files AS max_files
         FROM job_attempts a LEFT JOIN job_runs r ON r.attempt_id = a.id
        WHERE a.job_id = $1
        ORDER BY a.number DESC LIMIT 1`,
      [jobId],
    );
    const a = rows[0];
    if (a === undefined) return null;
    const parsed = a.outputs === null ? null : OutputReport.safeParse(a.outputs);
    const worker = parsed?.success === true ? parsed.data : null;
    const refused = await this.deps.pool.query<{ name: string | null; reason: string | null; n: number }>(
      `SELECT payload ->> 'name' AS name, outcome_reason AS reason, count(*) OVER ()::int AS n
         FROM worker_inbox
        WHERE job_id = $1 AND type = 'ARTIFACT_REF' AND outcome = 'rejected' AND payload ->> 'attemptId' = $2
          AND payload ->> 'artifactId' LIKE 'ws-o%'
        ORDER BY id LIMIT $3`,
      [jobId, a.attempt_id, OUTPUT_LIMITS.reportMaxSkipped],
    );
    const refusedCount = refused.rows[0]?.n ?? 0;
    if (worker === null && refusedCount === 0) return null;
    const skipped: ReportSkipped[] = [
      ...(worker?.skipped ?? []).map((s: OutputSkipped) => ({
        name: s.name,
        code: s.code,
        reason: s.reason,
      })),
      ...refused.rows.map((r) => ({
        name: (r.name ?? '').slice(0, 300),
        code: refusalCode(r.reason ?? ''),
        reason: `refused by the master (${(r.reason ?? 'rejected').slice(0, 60)})`,
      })),
    ].slice(0, OUTPUT_LIMITS.reportMaxSkipped);
    return {
      attemptId: a.attempt_id,
      maxFiles: worker?.maxFiles ?? a.max_files,
      // The master's refusals were counted as returned by the worker.
      returned: worker === null ? null : Math.max(0, worker.returned - refusedCount),
      storage: worker?.storage ?? null,
      zip: worker?.zip ?? null,
      skipped,
      skippedCount: (worker?.skippedCount ?? 0) + refusedCount,
    };
  }
}
