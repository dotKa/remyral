import type { ActiveJob, ProviderPause, QuotaPolicy } from '@remyral/scheduler';
import { ZodError } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import {
  OUTBOX_TOPIC_QUOTA_ENFORCEMENT,
  type QuotaEnforcementOutboxPayload,
  type QuotaEventKind,
} from './outbox.js';
import { DEFAULT_QUOTA_POLICY, parsePolicy } from './policy.js';

export class QuotaError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}

export interface QuotaActor {
  readonly type: 'user' | 'system';
  readonly id: string;
}

export interface PolicyVersion {
  readonly version: number;
  readonly policy: QuotaPolicy;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date | null;
}

export interface PauseRecord extends ProviderPause {
  readonly reason: string;
  readonly sourceJobId: string | null;
  readonly pausedAt: Date;
  readonly resumedAt: Date | null;
  readonly resumedBy: string | null;
}

export interface HoldRecord {
  readonly project: string;
  readonly reason: string;
  readonly heldBy: string;
  readonly heldAt: Date;
}

export interface QuotaEvent {
  readonly id: string;
  readonly kind: QuotaEventKind;
  readonly project: string | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly code: string;
  readonly message: string;
  readonly createdAt: Date;
}

export interface NewQuotaEvent {
  readonly kind: QuotaEventKind;
  readonly code: string;
  readonly message: string;
  readonly project?: string | null;
  readonly jobId?: string | null;
  readonly workerId?: string | null;
  readonly runtime?: string | null;
  /** Each decision is recorded (and announced) once per key. */
  readonly dedupeKey?: string | null;
  /** Also announce it to p5-notifications (outbox). */
  readonly notify?: boolean;
}

const ATTEMPT_OPEN = ['RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'CANCELLING', 'LOST'];

/** Persistence of p4-quotas (migration 0017). The only writer of the quota tables. */
export class QuotaStore {
  constructor(
    private readonly deps: { readonly pool: Pool; readonly audit: AuditRecorder; readonly clock: () => Date },
  ) {}

  // ------------------------------------------------------------------------------------- policy

  async currentPolicy(db: Queryable = this.deps.pool): Promise<PolicyVersion> {
    const { rows } = await db.query<{
      version: number;
      policy: unknown;
      note: string | null;
      created_by: string;
      created_at: Date;
    }>(
      'SELECT version, policy, note, created_by, created_at FROM quota_policies ORDER BY version DESC LIMIT 1',
    );
    const r = rows[0];
    if (r === undefined) {
      return { version: 0, policy: DEFAULT_QUOTA_POLICY, note: null, createdBy: null, createdAt: null };
    }
    return {
      version: r.version,
      policy: parsePolicy(r.policy),
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  /** Saves a complete new policy version (optimistic: `expectedVersion` must be the current one). */
  async replacePolicy(
    actor: QuotaActor,
    input: { readonly expectedVersion: number; readonly policy: unknown; readonly note?: string | null },
  ): Promise<PolicyVersion> {
    let policy: QuotaPolicy;
    try {
      policy = parsePolicy(input.policy);
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues
          .slice(0, 10)
          .map((i) => `${i.path.map(String).join('.') || '(root)'}:${i.code}`)
          .join(', ');
        throw new QuotaError(400, 'invalid_policy', `Invalid quota policy: ${issues}`.slice(0, 1000));
      }
      throw err;
    }
    const note = input.note?.replaceAll('\u0000', '').slice(0, 500) ?? null;
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('LOCK TABLE quota_policies IN SHARE ROW EXCLUSIVE MODE');
      const cur = await this.currentPolicy(tx);
      if (cur.version !== input.expectedVersion) {
        throw new QuotaError(
          409,
          'version_conflict',
          `The quota policy changed (now version ${String(cur.version)}). Reload and try again.`,
        );
      }
      const now = this.deps.clock();
      const version = cur.version + 1;
      await tx.query(
        'INSERT INTO quota_policies (version, policy, note, created_by, created_at) VALUES ($1, $2, $3, $4, $5)',
        [version, JSON.stringify(policy), note, actor.id, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: actor.type, id: actor.id },
          action: 'quota.policy.update',
          target: 'quota:policy',
          outcome: 'success',
          metadata: {
            version,
            projects: Object.keys(policy.projects).length,
            runtimes: Object.keys(policy.runtimes).length,
            accounts: policy.accounts.length,
            incomplete: policy.budgets.incomplete,
            onExceeded: policy.budgets.onExceeded,
          },
        },
        tx,
      );
      return { version, policy, note, createdBy: actor.id, createdAt: now };
    });
  }

  // ------------------------------------------------------------------------------------- facts

  /** Jobs that count against concurrency limits (attempt-open states, incl. LOST). */
  async activeJobs(db: Queryable = this.deps.pool): Promise<ActiveJob[]> {
    const { rows } = await db.query<{ project: string; runtime: string; worker_id: string | null }>(
      `SELECT j.project, COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime, a.worker_id
         FROM jobs j LEFT JOIN job_attempts a ON a.id = j.current_attempt_id
         LEFT JOIN job_runs r ON r.attempt_id = j.current_attempt_id
        WHERE j.state = ANY($1::job_state[]) AND COALESCE(j.spec->>'kind', '') <> 'function'`,
      [ATTEMPT_OPEN],
    );
    return rows.map((r) => ({ project: r.project, runtime: r.runtime, workerId: r.worker_id }));
  }

  /** Jobs started (reserved) per project since `since` — the fairness memory. */
  async recentStarts(since: Date, db: Queryable = this.deps.pool): Promise<Map<string, number>> {
    const { rows } = await db.query<{ project: string; n: number }>(
      `SELECT j.project, count(*)::int AS n FROM job_transitions t JOIN jobs j ON j.id = t.job_id
        WHERE t.trigger = 'reserve' AND t.occurred_at >= $1 GROUP BY j.project`,
      [since],
    );
    return new Map(rows.map((r) => [r.project, r.n]));
  }

  // ------------------------------------------------------------------------------------- pauses

  async pauses(opts: { activeAt?: Date; limit?: number } = {}): Promise<PauseRecord[]> {
    const params: unknown[] = [opts.limit ?? 200];
    let where = '';
    if (opts.activeAt !== undefined) {
      params.push(opts.activeAt);
      where = 'WHERE resumed_at IS NULL AND resume_at > $2';
    }
    const { rows } = await this.deps.pool.query<PauseRow>(
      `SELECT * FROM quota_pauses ${where} ORDER BY paused_at DESC, id LIMIT $1`,
      params,
    );
    return rows.map(toPause);
  }

  /** Inserts a pause for a provider-limit report; false when that report already paused (idempotent). */
  async insertPause(p: NewPause): Promise<string | null> {
    return withTransaction(this.deps.pool, (tx) => this.insertPauseWithin(tx, p, true));
  }

  /**
   * p11-usage-limit-fallback: the same inside the caller's transaction (the inbox, so no dispatch slips in between).
   * `notify`: announce it as before; false when the usage-limit episode of the store already notified (one notice per
   * limit hit per store, not per job).
   */
  async insertPauseWithin(tx: Queryable, p: NewPause, notify: boolean): Promise<string | null> {
    const now = this.deps.clock();
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO quota_pauses (scope, worker_id, runtime, account_id, reason, source_attempt_id, source_job_id,
                                   paused_at, resume_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (source_attempt_id) DO NOTHING RETURNING id`,
      [
        p.scope,
        p.workerId,
        p.runtime,
        p.accountId,
        p.reason.slice(0, 1000),
        p.sourceAttemptId,
        p.sourceJobId,
        now,
        p.resumeAt,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) return null;
    await this.recordEvent(
      {
        kind: 'provider_paused',
        code: 'provider_usage_limit',
        message: `${p.runtime} paused${
          p.scope === 'account' ? ` for provider account ${p.accountId ?? ''}` : ` on ${p.workerId ?? ''}`
        } until ${p.resumeAt.toISOString()}`,
        project: p.project,
        jobId: p.sourceJobId,
        workerId: p.reportingWorker,
        runtime: p.runtime,
        dedupeKey: `paused:${id}`,
        notify,
      },
      tx,
    );
    await this.deps.audit.record(
      {
        actor: { type: 'system', id: 'quota' },
        action: 'quota.provider.pause',
        target: `worker:${p.reportingWorker}`,
        outcome: 'success',
        metadata: {
          pauseId: id,
          scope: p.scope,
          runtime: p.runtime,
          accountId: p.accountId,
          jobId: p.sourceJobId,
          resumeAt: p.resumeAt.toISOString(),
        },
      },
      tx,
    );
    return id;
  }

  async resumePause(id: string, actor: QuotaActor): Promise<PauseRecord> {
    return withTransaction(this.deps.pool, async (tx) => {
      const now = this.deps.clock();
      const { rows } = await tx.query<PauseRow>(
        `UPDATE quota_pauses SET resumed_at = $2, resumed_by = $3
          WHERE id = $1 AND resumed_at IS NULL RETURNING *`,
        [id, now, actor.id],
      );
      const r = rows[0];
      if (r === undefined) throw new QuotaError(404, 'pause_not_found', 'No active pause with this id.');
      const pause = toPause(r);
      await this.recordEvent(
        {
          kind: 'provider_resumed',
          code: 'resumed_by_admin',
          message: `${pause.runtime} resumed early by ${actor.id}`,
          workerId: pause.workerId,
          runtime: pause.runtime,
          dedupeKey: `resumed:${id}`,
        },
        tx,
      );
      await this.deps.audit.record(
        {
          actor: { type: actor.type, id: actor.id },
          action: 'quota.provider.resume',
          target: `quota-pause:${id}`,
          outcome: 'success',
          metadata: { runtime: pause.runtime, scope: pause.scope, accountId: pause.accountId },
        },
        tx,
      );
      return pause;
    });
  }

  // ------------------------------------------------------------------------------------- holds

  async hold(project: string, db: Queryable = this.deps.pool): Promise<HoldRecord | null> {
    const { rows } = await db.query<{ project: string; reason: string; held_by: string; held_at: Date }>(
      'SELECT project, reason, held_by, held_at FROM quota_project_holds WHERE project = $1',
      [project],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : { project: r.project, reason: r.reason, heldBy: r.held_by, heldAt: r.held_at };
  }

  async holds(): Promise<HoldRecord[]> {
    const { rows } = await this.deps.pool.query<{
      project: string;
      reason: string;
      held_by: string;
      held_at: Date;
    }>('SELECT project, reason, held_by, held_at FROM quota_project_holds ORDER BY held_at DESC');
    return rows.map((r) => ({ project: r.project, reason: r.reason, heldBy: r.held_by, heldAt: r.held_at }));
  }

  async setHold(tx: Queryable, project: string, reason: string, actor: QuotaActor): Promise<void> {
    await tx.query(
      `INSERT INTO quota_project_holds (project, reason, held_by, held_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project) DO UPDATE SET reason = EXCLUDED.reason, held_by = EXCLUDED.held_by,
         held_at = EXCLUDED.held_at`,
      [project, reason, actor.id, this.deps.clock()],
    );
  }

  async releaseHold(project: string, actor: QuotaActor): Promise<boolean> {
    return withTransaction(this.deps.pool, async (tx) => {
      const res = await tx.query('DELETE FROM quota_project_holds WHERE project = $1', [project]);
      if (res.rowCount !== 1) return false;
      await this.recordEvent(
        {
          kind: 'hold_released',
          code: 'hold_released',
          message: `dispatch hold released by ${actor.id}`,
          project,
        },
        tx,
      );
      await this.deps.audit.record(
        {
          actor: { type: actor.type, id: actor.id },
          action: 'project.kill.release',
          target: `project:${project}`,
          outcome: 'success',
          metadata: {},
        },
        tx,
      );
      return true;
    });
  }

  async projectExists(project: string): Promise<boolean> {
    const { rowCount } = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    return (rowCount ?? 0) > 0;
  }

  // ------------------------------------------------------------------------------------- events

  /** Records an enforcement decision once per dedupe key; announces it (outbox) when asked. */
  async recordEvent(e: NewQuotaEvent, db: Queryable = this.deps.pool): Promise<boolean> {
    const now = this.deps.clock();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO quota_events (kind, project, job_id, worker_id, code, message, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text AS id`,
      [
        e.kind,
        e.project ?? null,
        e.jobId ?? null,
        e.workerId ?? null,
        e.code,
        e.message.replaceAll('\u0000', '').slice(0, 1000),
        e.dedupeKey ?? null,
        now,
      ],
    );
    const inserted = rows.length === 1;
    if (inserted && e.notify === true) {
      const payload: QuotaEnforcementOutboxPayload = {
        kind: e.kind,
        code: e.code,
        project: e.project ?? null,
        jobId: e.jobId ?? null,
        workerId: e.workerId ?? null,
        runtime: e.runtime ?? null,
        at: now.toISOString(),
      };
      await db.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, $2, $3, $4)', [
        OUTBOX_TOPIC_QUOTA_ENFORCEMENT,
        e.jobId ?? null,
        JSON.stringify(payload),
        now,
      ]);
    }
    return inserted;
  }

  async events(opts: { limit?: number; projects?: readonly string[] | null } = {}): Promise<QuotaEvent[]> {
    const params: unknown[] = [Math.min(Math.max(opts.limit ?? 100, 1), 500)];
    let where = '';
    if (opts.projects !== undefined && opts.projects !== null) {
      params.push([...opts.projects]);
      where = 'WHERE project = ANY($2::text[])';
    }
    const { rows } = await this.deps.pool.query<{
      id: string;
      kind: QuotaEventKind;
      project: string | null;
      job_id: string | null;
      worker_id: string | null;
      code: string;
      message: string;
      created_at: Date;
    }>(
      `SELECT id::text AS id, kind, project, job_id, worker_id, code, message, created_at FROM quota_events
        ${where} ORDER BY created_at DESC, id DESC LIMIT $1`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      project: r.project,
      jobId: r.job_id,
      workerId: r.worker_id,
      code: r.code,
      message: r.message,
      createdAt: r.created_at,
    }));
  }
}

/** A provider pause to insert (one per limited attempt). */
export interface NewPause {
  readonly scope: 'worker_runtime' | 'account';
  readonly workerId: string | null;
  readonly runtime: string;
  readonly accountId: string | null;
  readonly reason: string;
  readonly sourceAttemptId: string;
  readonly sourceJobId: string;
  readonly resumeAt: Date;
  readonly project: string;
  readonly reportingWorker: string;
}

interface PauseRow {
  id: string;
  scope: 'worker_runtime' | 'account';
  worker_id: string | null;
  runtime: string;
  account_id: string | null;
  reason: string;
  source_job_id: string | null;
  paused_at: Date;
  resume_at: Date;
  resumed_at: Date | null;
  resumed_by: string | null;
}

function toPause(r: PauseRow): PauseRecord {
  return {
    id: r.id,
    scope: r.scope,
    workerId: r.worker_id,
    runtime: r.runtime,
    accountId: r.account_id,
    reason: r.reason,
    sourceJobId: r.source_job_id,
    pausedAt: r.paused_at,
    // An early resume ends the pause at that moment.
    resumeAt: r.resumed_at ?? r.resume_at,
    resumedAt: r.resumed_at,
    resumedBy: r.resumed_by,
  };
}
