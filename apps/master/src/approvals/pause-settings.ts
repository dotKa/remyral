import { APPROVAL_PAUSE_DEFAULTS, APPROVAL_PAUSE_LIMITS } from '@remyral/protocol';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md §4): a project's timing of long in-run approval waits —
 * stale after, pause after, how long a paused job (and its kept workspace) waits for a decision. Stored on `projects`
 * (migration 0079); projects without a row (older jobs) use the platform defaults.
 */
export interface ApprovalPauseSettings {
  readonly staleAfterSec: number;
  readonly pauseAfterSec: number;
  readonly retentionSec: number;
}

export const ApprovalPauseSettingsInput = z
  .strictObject({
    staleAfterSec: z
      .number()
      .int()
      .min(APPROVAL_PAUSE_LIMITS.minStaleAfterSec)
      .max(APPROVAL_PAUSE_LIMITS.maxStaleAfterSec),
    pauseAfterSec: z
      .number()
      .int()
      .min(APPROVAL_PAUSE_LIMITS.minPauseAfterSec)
      .max(APPROVAL_PAUSE_LIMITS.maxPauseAfterSec),
    retentionSec: z
      .number()
      .int()
      .min(APPROVAL_PAUSE_LIMITS.minRetentionSec)
      .max(APPROVAL_PAUSE_LIMITS.maxRetentionSec),
  })
  .refine((s) => s.staleAfterSec < s.pauseAfterSec, {
    message: 'staleAfterSec must be shorter than pauseAfterSec',
    path: ['staleAfterSec'],
  });

export class ApprovalPauseSettingsError extends Error {
  override name = 'ApprovalPauseSettingsError';
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function loadPauseSettings(db: Queryable, project: string): Promise<ApprovalPauseSettings> {
  const { rows } = await db.query<{ stale: number; pause: number; retention: number }>(
    `SELECT approval_stale_after_sec AS stale, approval_pause_after_sec AS pause,
            approval_pause_retention_sec AS retention
       FROM projects WHERE id = $1`,
    [project],
  );
  const r = rows[0];
  return r === undefined
    ? { ...APPROVAL_PAUSE_DEFAULTS }
    : { staleAfterSec: r.stale, pauseAfterSec: r.pause, retentionSec: r.retention };
}

/** Writes a project's settings (route: owner/admin, CSRF, step-up). Audited `project.approval_pause.update`. */
export async function savePauseSettings(
  pool: Pool,
  audit: AuditRecorder,
  project: string,
  input: unknown,
  actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
): Promise<ApprovalPauseSettings> {
  const parsed = ApprovalPauseSettingsInput.safeParse(input);
  if (!parsed.success) {
    throw new ApprovalPauseSettingsError(
      400,
      'invalid_settings',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const next = parsed.data;
  return withTransaction(pool, async (tx) => {
    const before = await tx.query<{ stale: number; pause: number; retention: number }>(
      `SELECT approval_stale_after_sec AS stale, approval_pause_after_sec AS pause,
              approval_pause_retention_sec AS retention
         FROM projects WHERE id = $1 FOR UPDATE`,
      [project],
    );
    const prev = before.rows[0];
    if (prev === undefined)
      throw new ApprovalPauseSettingsError(404, 'project_not_found', 'Project not found.');
    await tx.query(
      `UPDATE projects SET approval_stale_after_sec = $2, approval_pause_after_sec = $3,
              approval_pause_retention_sec = $4
        WHERE id = $1`,
      [project, next.staleAfterSec, next.pauseAfterSec, next.retentionSec],
    );
    await audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action: 'project.approval_pause.update',
        target: `project:${project}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: {
          from: { staleAfterSec: prev.stale, pauseAfterSec: prev.pause, retentionSec: prev.retention },
          to: next,
        },
      },
      tx,
    );
    return next;
  });
}
