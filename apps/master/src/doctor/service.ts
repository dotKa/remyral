import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, Redactor, redactDeep } from '@remyral/observability';
import {
  DOCTOR_FEATURE,
  type Diagnostics,
  type DoctorFinding,
  type DoctorSummary,
  findingKey,
  REMOTE_OPS_FEATURE,
  sortFindings,
  summarizeFindings,
  WORKER_DOCTOR_SCHEMA_VERSION,
  WorkerDoctorReport,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import type { OpView, RemoteOpsService } from '../remote-ops/service.js';
import type { ActorContext } from '../workers/fleet.js';
import { type DoctorSources, runChecks } from './checks.js';

/**
 * p16-doctor (docs/design/p16-doctor.md §2–§3): runs the master's checks (full on demand, light once a day), asks the
 * connected machines for their own doctor (`doctor.run`, or `diagnostics.run` on older workers, mapped to findings),
 * keeps the runs, and notifies owners and admins once about problems the daily run had not seen before.
 */

export type RunKind = 'manual' | 'daily' | 'chat';
export type RunScope = 'full' | 'light';

export interface WorkerResult {
  readonly workerId: string;
  readonly name: string;
  /** done: a report; pending: asked, not answered in time; failed: the op failed; unsupported / offline: not asked. */
  readonly state: 'done' | 'pending' | 'failed' | 'unsupported' | 'offline';
  readonly source: 'doctor' | 'diagnostics' | null;
  readonly opId: string | null;
  readonly reason: string | null;
  readonly report: WorkerDoctorReport | null;
}

export interface DoctorRunView {
  readonly id: string;
  readonly kind: RunKind;
  readonly scope: RunScope;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly requestedBy: string | null;
  readonly summary: DoctorSummary;
  readonly findings: readonly DoctorFinding[];
  readonly workers: readonly WorkerResult[];
  readonly newProblems: number;
}

export interface DoctorServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly sources: DoctorSources;
  readonly remoteOps: () => RemoteOpsService | null;
  readonly notifications: () => NotificationService | null;
  /** How long a run waits for the machines' answers (default 20 s). */
  readonly workerWaitMs?: number;
  /** Runs kept (default 60). */
  readonly keepRuns?: number;
  /** The daily run happens when the last one is older than this (default 23 h). */
  readonly dailyEveryMs?: number;
}

interface RunRow {
  id: string;
  kind: RunKind;
  scope: RunScope;
  started_at: Date;
  finished_at: Date | null;
  requested_by: string | null;
  summary: DoctorSummary;
  findings: DoctorFinding[];
  workers: WorkerResult[];
  new_problems: number;
}

const DAILY_LOCK = 0x646f63746f72n; // "doctor"

function view(r: RunRow): DoctorRunView {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    requestedBy: r.requested_by,
    summary: r.summary,
    findings: r.findings,
    workers: r.workers,
    newProblems: r.new_problems,
  };
}

/** p5-remote-ops `Diagnostics` of an older worker as doctor findings (problems, disk, Node, sandbox, runtimes). */
export function diagnosticsToReport(d: Diagnostics): WorkerDoctorReport {
  const findings: DoctorFinding[] = [];
  const sev = (s: 'info' | 'warning' | 'error') => s;
  for (const p of d.problems.slice(0, 40)) {
    const code =
      p.code
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^[^a-z]+/, '')
        .slice(0, 64) || 'problem';
    findings.push({
      check: `worker.${code.split('_')[0] ?? 'problem'}`.slice(0, 64).replace(/[^a-z0-9_.]/g, '_'),
      code,
      severity: sev(p.severity),
      message: p.message.slice(0, 500),
    });
  }
  if (findings.length === 0)
    findings.push({
      check: 'worker.diagnostics',
      code: 'ok',
      severity: 'ok',
      message: 'The machine reported no problem (older worker: basic diagnostics only)',
    });
  return {
    schemaVersion: WORKER_DOCTOR_SCHEMA_VERSION,
    collectedAt: d.collectedAt,
    mode: 'remote',
    workerVersion: d.workerVersion,
    host: { platform: d.os.platform, release: d.os.release, arch: d.os.arch, node: d.node.version },
    master: null,
    summary: summarizeFindings(findings),
    findings,
  };
}

export class DoctorService {
  readonly #d: DoctorServiceDeps;
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });
  #dailyRunning = false;

  constructor(d: DoctorServiceDeps) {
    this.#d = d;
  }

  #clean(findings: readonly DoctorFinding[]): DoctorFinding[] {
    return sortFindings(redactDeep(findings, this.#redactor, { maxEntries: 400 }) as DoctorFinding[]);
  }

  /** Runs the checks (and, when asked, the machines' doctor) and stores the run. */
  async run(opts: {
    readonly kind: RunKind;
    readonly scope: RunScope;
    readonly actor: ActorContext | null;
    readonly machines?: boolean;
  }): Promise<DoctorRunView> {
    const id = randomUUID();
    const startedAt = this.#d.clock();
    const [findings, workers] = await Promise.all([
      runChecks(this.#d.sources, opts.scope),
      opts.machines === true && opts.actor !== null ? this.collectMachines(opts.actor) : Promise.resolve([]),
    ]);
    const clean = this.#clean(findings);
    const row: RunRow = {
      id,
      kind: opts.kind,
      scope: opts.scope,
      started_at: startedAt,
      finished_at: this.#d.clock(),
      requested_by: opts.actor?.userId === '' ? null : (opts.actor?.userId ?? null),
      summary: summarizeFindings(clean),
      findings: clean,
      workers,
      new_problems: 0,
    };
    await this.#store(row);
    if (opts.actor !== null)
      await this.#d.audit.record({
        actor: opts.actor.system === undefined ? { type: 'user', id: opts.actor.userId } : { type: 'system' },
        action: 'doctor.run',
        outcome: 'success',
        target: `doctor:${id}`,
        ip: opts.actor.ip,
        userAgent: opts.actor.userAgent,
        metadata: { kind: opts.kind, scope: opts.scope, machines: workers.length, ...row.summary },
      });
    return view(row);
  }

  async #store(r: RunRow): Promise<void> {
    await this.#d.pool.query(
      `INSERT INTO doctor_runs (id, kind, scope, started_at, finished_at, requested_by, summary, findings, workers,
                                new_problems)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.id,
        r.kind,
        r.scope,
        r.started_at,
        r.finished_at,
        r.requested_by,
        JSON.stringify(r.summary),
        JSON.stringify(r.findings),
        JSON.stringify(r.workers),
        r.new_problems,
      ],
    );
    const keep = this.#d.keepRuns ?? 60;
    await this.#d.pool.query(
      `DELETE FROM doctor_runs WHERE id IN (SELECT id FROM doctor_runs ORDER BY started_at DESC OFFSET $1)`,
      [keep],
    );
  }

  async latest(kind?: RunKind): Promise<DoctorRunView | null> {
    const { rows } = await this.#d.pool.query<RunRow>(
      `SELECT * FROM doctor_runs WHERE finished_at IS NOT NULL ${kind === undefined ? '' : 'AND kind = $1'}
        ORDER BY started_at DESC LIMIT 1`,
      kind === undefined ? [] : [kind],
    );
    return rows[0] === undefined ? null : view(rows[0]);
  }

  async get(id: string): Promise<DoctorRunView> {
    const { rows } = await this.#d.pool.query<RunRow>('SELECT * FROM doctor_runs WHERE id = $1', [id]);
    const r = rows[0];
    if (r === undefined)
      throw new HttpError(404, 'doctor_run_not_found', 'This diagnostics run is no longer kept.');
    return view(r);
  }

  async list(limit = 20): Promise<
    {
      id: string;
      kind: RunKind;
      scope: RunScope;
      startedAt: string;
      summary: DoctorSummary;
      newProblems: number;
    }[]
  > {
    const { rows } = await this.#d.pool.query<RunRow>(
      `SELECT id, kind, scope, started_at, summary, new_problems FROM doctor_runs WHERE finished_at IS NOT NULL
        ORDER BY started_at DESC LIMIT $1`,
      [Math.min(60, Math.max(1, limit))],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      startedAt: r.started_at.toISOString(),
      summary: r.summary,
      newProblems: r.new_problems,
    }));
  }

  // ------------------------------------------------------------------------------------------------ machines

  /** Connected machines that can be asked (remote ops), with whether they know `doctor.run`. */
  async #machines(): Promise<{ id: string; name: string; connected: boolean; features: string[] }[]> {
    const { rows } = await this.#d.pool.query<{ id: string; name: string; state: string; features: unknown }>(
      `SELECT id, COALESCE(label, display_name) AS name, state, features FROM workers
        WHERE state NOT IN ('pending', 'quarantined') AND archived_at IS NULL ORDER BY id`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      connected: r.state !== 'offline',
      features: Array.isArray(r.features) ? r.features.filter((x): x is string => typeof x === 'string') : [],
    }));
  }

  /** Asks one machine for its doctor (or its diagnostics on an older build); returns the operation. */
  async requestMachine(
    workerId: string,
    actor: ActorContext,
  ): Promise<{ op: OpView; source: 'doctor' | 'diagnostics' }> {
    const ops = this.#d.remoteOps();
    if (ops === null)
      throw new HttpError(
        503,
        'unavailable',
        'Remote operations are not available.',
        {},
        {},
        { reason: 'remote_ops' },
      );
    const m = (await this.#machines()).find((x) => x.id === workerId);
    if (m === undefined)
      throw new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
    if (!m.connected) throw new HttpError(409, 'worker_offline', 'The worker is not connected.');
    const source = m.features.includes(DOCTOR_FEATURE) ? 'doctor' : 'diagnostics';
    const op = await ops.request(
      workerId,
      { kind: source === 'doctor' ? 'doctor.run' : 'diagnostics.run' },
      actor,
    );
    return { op, source };
  }

  /** A finished doctor / diagnostics operation as a worker report (null: not finished or no result). */
  static reportOf(op: OpView): WorkerDoctorReport | null {
    const r = op.result;
    if (r === null) return null;
    if (r.doctor !== undefined) {
      const p = WorkerDoctorReport.safeParse(r.doctor);
      return p.success ? p.data : null;
    }
    if (r.diagnostics !== undefined) {
      try {
        return diagnosticsToReport(r.diagnostics as Diagnostics);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Asks every connected machine and waits (bounded) for the answers. */
  async collectMachines(actor: ActorContext): Promise<WorkerResult[]> {
    const ops = this.#d.remoteOps();
    const machines = await this.#machines();
    const waitMs = this.#d.workerWaitMs ?? 20_000;
    return Promise.all(
      machines.slice(0, 40).map(async (m): Promise<WorkerResult> => {
        const base = { workerId: m.id, name: m.name };
        if (!m.connected)
          return { ...base, state: 'offline', source: null, opId: null, reason: 'offline', report: null };
        if (ops === null || !m.features.includes(REMOTE_OPS_FEATURE))
          return {
            ...base,
            state: 'unsupported',
            source: null,
            opId: null,
            reason: 'remote_ops',
            report: null,
          };
        try {
          const { op, source } = await this.requestMachine(m.id, actor);
          const done = await ops.waitFor(m.id, op.id, waitMs, 250);
          const report = DoctorService.reportOf(done);
          if (report !== null)
            return {
              ...base,
              state: 'done',
              source,
              opId: op.id,
              reason: null,
              report: redactDeep(report, this.#redactor, { maxEntries: 200 }) as WorkerDoctorReport,
            };
          if (
            done.state === 'failed' ||
            done.state === 'refused' ||
            done.state === 'lost' ||
            done.state === 'cancelled'
          )
            return {
              ...base,
              state: 'failed',
              source,
              opId: op.id,
              reason: done.reason ?? done.state,
              report: null,
            };
          return { ...base, state: 'pending', source, opId: op.id, reason: null, report: null };
        } catch (e) {
          const code = e instanceof HttpError ? e.code : 'error';
          return { ...base, state: 'failed', source: null, opId: null, reason: code, report: null };
        }
      }),
    );
  }

  /** The newest machine reports (≤ 24 h) from the operations log, for the support bundle. */
  async recentMachineReports(): Promise<WorkerResult[]> {
    const { rows } = await this.#d.pool.query<{
      id: string;
      worker_id: string;
      name: string;
      kind: string;
      result: Record<string, unknown> | null;
    }>(
      `SELECT DISTINCT ON (o.worker_id) o.id::text AS id, o.worker_id, COALESCE(w.label, w.display_name) AS name,
              o.kind, o.result
         FROM worker_ops o JOIN workers w ON w.id = o.worker_id
        WHERE o.kind IN ('doctor.run', 'diagnostics.run') AND o.state = 'succeeded'
          AND o.finished_at > $1::timestamptz - interval '24 hours'
        ORDER BY o.worker_id, (o.kind = 'doctor.run') DESC, o.finished_at DESC`,
      [this.#d.clock()],
    );
    const out: WorkerResult[] = [];
    for (const r of rows) {
      const report = DoctorService.reportOf({ result: r.result } as OpView);
      if (report === null) continue;
      out.push({
        workerId: r.worker_id,
        name: r.name,
        state: 'done',
        source: r.kind === 'doctor.run' ? 'doctor' : 'diagnostics',
        opId: r.id,
        reason: null,
        report,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ daily

  /**
   * The daily light run: at most one per `dailyEveryMs` across masters (advisory lock + the last daily row). Its
   * warning / error findings are compared with the problems seen before: new or returning ones are notified to owners
   * and admins once; problems of the checks that ran and are no longer found are marked resolved.
   */
  async daily(): Promise<DoctorRunView | null> {
    if (this.#dailyRunning) return null;
    this.#dailyRunning = true;
    try {
      const every = this.#d.dailyEveryMs ?? 23 * 3_600_000;
      const id = randomUUID();
      const claimed = await withTransaction(this.#d.pool, async (tx) => {
        const lock = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [
          DAILY_LOCK.toString(),
        ]);
        if (lock.rows[0]?.ok !== true) return false;
        const last = await tx.query<{ at: Date }>(
          "SELECT started_at AS at FROM doctor_runs WHERE kind = 'daily' ORDER BY started_at DESC LIMIT 1",
        );
        const at = last.rows[0]?.at ?? null;
        if (at !== null && this.#d.clock().getTime() - at.getTime() < every) return false;
        // The claim: another master sees this row at once and skips.
        await tx.query(
          `INSERT INTO doctor_runs (id, kind, scope, started_at) VALUES ($1, 'daily', 'light', $2)`,
          [id, this.#d.clock()],
        );
        return true;
      });
      if (!claimed) return null;
      try {
        const findings = this.#clean(await runChecks(this.#d.sources, 'light'));
        const now = this.#d.clock();
        const fresh = await this.#track(findings, now);
        const summary = summarizeFindings(findings);
        const { rows } = await this.#d.pool.query<RunRow>(
          `UPDATE doctor_runs SET finished_at = $2, summary = $3, findings = $4, new_problems = $5
            WHERE id = $1 RETURNING *`,
          [id, this.#d.clock(), JSON.stringify(summary), JSON.stringify(findings), fresh.length],
        );
        if (fresh.length > 0) await this.#notify(id, fresh);
        await this.#d.audit.record({
          actor: { type: 'system' },
          action: 'doctor.run',
          outcome: 'success',
          target: `doctor:${id}`,
          metadata: { kind: 'daily', scope: 'light', newProblems: fresh.length, ...summary },
        });
        const r = rows[0];
        return r === undefined ? null : view(r);
      } catch (err) {
        // A failed run must not hold the next one for a day.
        await this.#d.pool.query('DELETE FROM doctor_runs WHERE id = $1', [id]).catch(() => undefined);
        throw err;
      }
    } finally {
      this.#dailyRunning = false;
    }
  }

  /** Updates doctor_problems; returns the findings that are new (never seen, or seen again after being resolved). */
  async #track(findings: readonly DoctorFinding[], now: Date): Promise<DoctorFinding[]> {
    const problems = findings.filter((f) => f.severity === 'warning' || f.severity === 'error');
    const checks = [...new Set(findings.map((f) => f.check))];
    const fresh: DoctorFinding[] = [];
    await withTransaction(this.#d.pool, async (tx) => {
      for (const p of problems) {
        const key = findingKey(p).slice(0, 300);
        const r = await tx.query<{ fresh: boolean }>(
          `INSERT INTO doctor_problems (key, check_id, code, subject, severity, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (key) DO UPDATE
             SET last_seen_at = EXCLUDED.last_seen_at, severity = EXCLUDED.severity,
                 first_seen_at = CASE WHEN doctor_problems.resolved_at IS NULL THEN doctor_problems.first_seen_at
                                      ELSE EXCLUDED.first_seen_at END,
                 notified_at = CASE WHEN doctor_problems.resolved_at IS NULL THEN doctor_problems.notified_at
                                    ELSE NULL END,
                 resolved_at = NULL
           RETURNING notified_at IS NULL AS fresh`,
          [key, p.check, p.code, p.subject ?? null, p.severity, now],
        );
        if (r.rows[0]?.fresh === true) fresh.push(p);
      }
      const seen = problems.map((p) => findingKey(p).slice(0, 300));
      await tx.query(
        `UPDATE doctor_problems SET resolved_at = $1
          WHERE resolved_at IS NULL AND check_id = ANY($2::text[]) AND NOT (key = ANY($3::text[]))`,
        [now, checks, seen],
      );
      if (fresh.length > 0)
        await tx.query('UPDATE doctor_problems SET notified_at = $1 WHERE key = ANY($2::text[])', [
          now,
          fresh.map((p) => findingKey(p).slice(0, 300)),
        ]);
    });
    return fresh;
  }

  async #notify(runId: string, fresh: readonly DoctorFinding[]): Promise<void> {
    const n = this.#d.notifications();
    if (n === null) return;
    const errors = fresh.filter((f) => f.severity === 'error').length;
    const lines = fresh.slice(0, 8).map((f) => `• ${f.message}`);
    if (fresh.length > 8) lines.push(`… and ${String(fresh.length - 8)} more`);
    await withTransaction(this.#d.pool, async (tx) => {
      await n.notify(tx, await globalRecipients(tx, 'admin'), {
        kind: 'doctor.problem',
        severity: errors > 0 ? 'critical' : 'warning',
        title:
          fresh.length === 1
            ? 'Diagnostics found a new problem'
            : `Diagnostics found ${String(fresh.length)} new problems`,
        body: `${lines.join('\n')}\nSuggested fixes: Settings → Diagnostics.`,
        link: '/settings/diagnostics',
        dedupeKey: `doctor.problem:${runId}`,
      });
    });
  }

  /** The background pass: the daily run when it is due. Returns a stop function. */
  start(intervalMs: number, onError: (err: unknown) => void): () => void {
    const timer = setInterval(() => {
      this.daily().catch(onError);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}
