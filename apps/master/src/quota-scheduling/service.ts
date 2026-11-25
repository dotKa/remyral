import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { JobRecord } from '../jobs/store.js';
import type { AdmissionVerdict, DispatchAdmission } from '../orchestration/orchestrator.js';
import type { ActorContext } from '../workers/fleet.js';
import { describeOffPeak, inOffPeak, nextOffPeakStart, OffPeakWindow } from './offpeak.js';

export interface OffPeakView {
  readonly project: string;
  readonly window: OffPeakWindow | null;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
  /** Whether the window is open now (false without a window). */
  readonly open: boolean;
  /** When it next opens (now when open; null without a window). */
  readonly nextStart: Date | null;
}

export interface QuotaSchedulingDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** Dispatches a job at once (the orchestrator); absent: the next tick picks it up. */
  readonly dispatch?: (jobId: string) => Promise<unknown>;
}

/**
 * p6-quota-scheduling (docs/design/p6-quota-scheduling.md §4): off-peak windows per project and the deferral of
 * deferrable jobs. As a dispatch admission it holds a deferrable job (`spec.deferrable`) of a project with a window
 * while the window is closed — the job stays QUEUED with the reason `deferred_off_peak` and the window's next start —
 * unless someone chose "Run now". Runtime-independent, so a held job does not try its fallback runtimes.
 */
export class QuotaSchedulingService implements DispatchAdmission {
  constructor(private readonly deps: QuotaSchedulingDeps) {}

  async admit(job: JobRecord): Promise<AdmissionVerdict> {
    if (job.spec.deferrable !== true) return { kind: 'admit' };
    const { rows } = await this.deps.pool.query<{ off_peak: unknown; run_now: boolean }>(
      `SELECT p.off_peak, EXISTS (SELECT 1 FROM job_run_now r WHERE r.job_id = $2) AS run_now
         FROM projects p WHERE p.id = $1`,
      [job.project, job.id],
    );
    const row = rows[0];
    if (row === undefined || row.run_now || row.off_peak === null) return { kind: 'admit' };
    const parsed = OffPeakWindow.safeParse(row.off_peak);
    // A stored window that no longer validates (e.g. a zone the runtime dropped) never holds work back.
    if (!parsed.success) return { kind: 'admit' };
    const now = this.deps.clock();
    if (inOffPeak(parsed.data, now)) return { kind: 'admit' };
    const until = nextOffPeakStart(parsed.data, now).toISOString();
    return {
      kind: 'hold',
      reasons: [
        {
          code: 'deferred_off_peak',
          permanent: false,
          message: `deferred to the project's off-peak window ${describeOffPeak(parsed.data)}; starts at ${until} ("Run now" starts it at once)`,
          workers: [],
          until,
        },
      ],
    };
  }

  async window(project: string): Promise<OffPeakView> {
    const { rows } = await this.deps.pool.query<{
      off_peak: unknown;
      off_peak_updated_by: string | null;
      off_peak_updated_at: Date | null;
    }>('SELECT off_peak, off_peak_updated_by, off_peak_updated_at FROM projects WHERE id = $1', [project]);
    const row = rows[0];
    if (row === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const parsed = row.off_peak === null ? null : OffPeakWindow.safeParse(row.off_peak);
    const window = parsed?.success === true ? parsed.data : null;
    const now = this.deps.clock();
    return {
      project,
      window,
      updatedBy: row.off_peak_updated_by,
      updatedAt: row.off_peak_updated_at,
      open: window !== null && inOffPeak(window, now),
      nextStart: window === null ? null : nextOffPeakStart(window, now),
    };
  }

  /** Sets (or with null removes) a project's window. Admin + step-up (route); audited. */
  async setWindow(project: string, input: unknown, actor: ActorContext): Promise<OffPeakView> {
    let next: OffPeakWindow | null = null;
    if (input !== null) {
      const parsed = OffPeakWindow.safeParse(input);
      if (!parsed.success) {
        throw new HttpError(
          400,
          'invalid_off_peak',
          `Invalid off-peak window: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}:${i.message}`)
            .join(', ')}`.slice(0, 500),
          {},
          {},
          {
            issues: parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}:${i.message}`)
              .join(', ')
              .slice(0, 300),
          },
        );
      }
      next = parsed.data;
    }
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await tx.query<{ off_peak: unknown }>(
        'SELECT off_peak FROM projects WHERE id = $1 FOR UPDATE',
        [project],
      );
      if (before.rows[0] === undefined) throw new HttpError(404, 'project_not_found', 'Project not found.');
      await tx.query(
        `UPDATE projects SET off_peak = $2, off_peak_updated_by = $3, off_peak_updated_at = $4 WHERE id = $1`,
        [project, next === null ? null : JSON.stringify(next), actor.userId, this.deps.clock()],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.off_peak.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { before: before.rows[0].off_peak ?? null, after: next },
        },
        tx,
      );
    });
    return this.window(project);
  }

  /**
   * "Run now": a queued deferrable job starts without waiting for the window (operator in the job's project,
   * route). Idempotent: a second request keeps the first one's record. Audited `job.run_now`.
   */
  async runNow(
    jobId: string,
    actor: ActorContext,
  ): Promise<{ readonly jobId: string; readonly state: string }> {
    const job = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ project: string; state: string; deferrable: boolean }>(
        `SELECT project, state, COALESCE((spec->>'deferrable')::boolean, false) AS deferrable
           FROM jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const j = rows[0];
      if (j === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
      if (!j.deferrable) {
        throw new HttpError(
          409,
          'not_deferrable',
          'The job is not deferrable; it does not wait for a window.',
        );
      }
      if (j.state !== 'QUEUED') {
        throw new HttpError(
          409,
          'not_queued',
          `The job is ${j.state}; only a queued job can be started now.`,
          {},
          {},
          { reason: 'start_now', state: j.state },
        );
      }
      const inserted = await tx.query(
        `INSERT INTO job_run_now (job_id, requested_by, requested_at) VALUES ($1, $2, $3)
         ON CONFLICT (job_id) DO NOTHING`,
        [jobId, actor.userId, this.deps.clock()],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'job.run_now',
            target: `job:${jobId}`,
            outcome: 'success',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: { project: j.project },
          },
          tx,
        );
      }
      return j;
    });
    await this.deps.dispatch?.(jobId).catch(() => undefined);
    return { jobId, state: job.state };
  }
}
