import {
  isRetiredRuntime,
  normalizeJobTitle,
  PRIORITY_CLASS_BAND,
  PRIORITY_CLASS_LABEL,
  PRIORITY_CLASS_VALUE,
  type PriorityClass,
  priorityClassOf,
} from '@remyral/protocol';
import { inputUploadOfJob } from '../input-uploads/service.js';
import { randomUUID } from 'node:crypto';
import { stepUpFresh } from '../approvals/policy-store.js';
import type { ApprovalPauseService } from '../approvals/pause.js';
import type { HumanActor } from '../approvals/index.js';
import type { AuditRecorder } from '../audit/audit.js';
import { type Action, authorize, type Subject, visibleProjects } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { IllegalTransitionError, JobStoreError, RuntimeRemovedError } from '../jobs/errors.js';
import type { JobStore } from '../jobs/store.js';
import type { Orchestrator } from '../orchestration/orchestrator.js';
import type { QueueService } from '../queue/service.js';
import type { JobClockService } from '../jobs/job-clock.js';
import { TIMED_OUT_SQL } from '../jobs/timed-out-sql.js';
import { type KeptWork, keptWorkLine, keptWorkOf } from '../jobs/kept-work.js';
import type { ActorContext } from '../workers/fleet.js';
import type { ChatStore, DraftRecord } from './store.js';
import type { ToolOutcome } from './tools.js';
import { asksToRunNow, draftPriorityClass } from './urgency.js';
import { titleColumns, titleOrDerived } from '../jobs/titles.js';
import type { ConflictResolveService } from '../self-heal/conflict-resolve.js';

/**
 * p10-chat-job-actions (docs/design/p10-chat-job-actions.md): managing existing jobs from the ops chat.
 *
 * - `find` resolves which jobs the user means (read, the caller's visible projects only) and says which actions the
 *   caller may draft on each now.
 * - `propose` drafts a `job_action` card (assistant tool `draft_job_action`, or a quick button on a job card) — it
 *   never acts.
 * - `JobActionRunner.run` executes a confirmed card **per job for the confirming user**: re-read, re-authorize, re-check
 *   the state, then the same service call the Jobs UI makes (cancel, POST /jobs, continue, queue class / move / run
 *   now). A job whose state changed meanwhile is a clear "skipped" line, never an error.
 */

export const JOB_ACTIONS = [
  'cancel',
  'run_again',
  'continue',
  'set_class',
  'move',
  'run_now',
  // p22-conflict-resolve: a verified result that conflicts with its target is carried onto it by a new job.
  'resolve_conflicts',
] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];
export const MAX_JOB_ACTION_JOBS = 50;

/** States the master accepts a cancel in (the job state machine's `cancel_requested` sources). */
export const CANCELLABLE_STATES: ReadonlySet<string> = new Set([
  'DRAFT',
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'AWAITING_APPROVAL',
  'RETRY_WAIT',
  'BLOCKED',
  'PAUSED',
]);
/** Finished jobs that can run again from their stored settings (the composer's "Run again"). */
export const RERUNNABLE_STATES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
]);
const TERMINAL: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST']);

export const STATE_GROUPS: Readonly<Record<string, readonly string[] | null>> = {
  queued: ['QUEUED', 'RETRY_WAIT', 'BLOCKED'],
  running: ['RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'CANCELLING'],
  waiting: ['AWAITING_APPROVAL', 'PAUSED'],
  paused: ['PAUSED'],
  active: [
    'DRAFT',
    'QUEUED',
    'RESERVED',
    'STARTING',
    'RUNNING',
    'VERIFYING',
    'AWAITING_APPROVAL',
    'RETRY_WAIT',
    'CANCELLING',
    'BLOCKED',
    'PAUSED',
  ],
  failed: ['FAILED', 'LOST'],
  finished: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST'],
  cancellable: [...CANCELLABLE_STATES],
  any: null,
};

/** The authorization action each job action needs on the job's project (the Jobs UI's route rule). */
export const ACTION_AUTHZ: Readonly<Record<JobAction, Action>> = {
  cancel: 'jobs.cancel',
  run_again: 'jobs.create',
  continue: 'jobs.create',
  set_class: 'jobs.queue.reorder',
  move: 'jobs.queue.reorder',
  run_now: 'jobs.queue.runnow',
  resolve_conflicts: 'jobs.create',
};

const VERB: Readonly<Record<JobAction, string>> = {
  cancel: 'Cancel',
  run_again: 'Run again',
  continue: 'Continue',
  set_class: 'Change class',
  move: 'Move in the queue',
  run_now: 'Run now (Acil)',
  resolve_conflicts: 'Resolve conflicts',
};

interface JobRow {
  id: string;
  project: string;
  state: string;
  runtime: string | null;
  /** p15-job-titles: the job's title (stored, else derived — filled by `titled`). */
  title: string;
  title_stored?: string | null;
  title_prompt?: string | null;
  /** Effective queue priority (adjustment or stored). */
  priority: number;
  stored_priority: number;
  created_by_type: string;
  created_by_id: string | null;
  created_at: Date;
  state_changed_at: Date;
  spec_kind: string | null;
  spec_role: string | null;
}

const ROW_SQL = `SELECT j.id, j.project, j.state::text AS state, j.spec ->> 'runtime' AS runtime,
       ${titleColumns()}, '' AS title,
       COALESCE(q.priority, j.priority) AS priority, j.priority AS stored_priority,
       j.created_by_type, j.created_by_id, j.created_at, j.state_changed_at,
       j.spec ->> 'kind' AS spec_kind, j.spec ->> 'role' AS spec_role
  FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id LEFT JOIN job_queue_priority q ON q.job_id = j.id`;

/** p15-job-titles: rows read with ROW_SQL get their title (stored, else derived from the prompt). */
function titled<R extends JobRow>(rows: R[]): R[] {
  for (const r of rows) r.title = titleOrDerived(r);
  return rows;
}

/** The same columns plus the stored spec (execution: run again). */
const ROW_WITH_SPEC_SQL = ROW_SQL.replace(' FROM jobs j', ', j.spec FROM jobs j');

const short = (id: string): string => id.slice(0, 8);
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Jobs whose expired approval allows "Continue" (the same rule as the job page's `continueAvailable`), and
 * (p20-job-clock) jobs that stopped on their time limit ("Aynı yerden devam et").
 */
async function continuable(db: Queryable, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT j.id FROM jobs j
      WHERE j.id = ANY($1::uuid[]) AND j.state IN ('FAILED', 'CANCELLED')
        AND (EXISTS (SELECT 1 FROM approval_requests r WHERE r.job_id = j.id AND r.status = 'expired'
                       AND (r.kind = 'gate' OR r.attempt_id = j.current_attempt_id))
             OR ${TIMED_OUT_SQL('j')})`,
    [[...ids]],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * p22-conflict-resolve: jobs whose verified result conflicts with its target and can get a conflict-resolution job now
 * (the rule of ConflictResolveService.resolve: waiting for its decision, or accepted with its pull request left open;
 * none open or merged yet).
 */
async function resolvable(db: Queryable, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT j.id FROM jobs j JOIN job_git g ON g.job_id = j.id
      WHERE j.id = ANY($1::uuid[]) AND g.verification = 'passed' AND g.merge_state = 'conflicts'
        AND g.merged_sha IS NULL AND g.head_sha IS NOT NULL
        AND (j.state = 'AWAITING_APPROVAL' OR (j.state = 'SUCCEEDED' AND g.pr_number IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM job_conflict_resolutions c
                         WHERE c.source_job_id = j.id AND c.state IN ('created', 'merged'))`,
    [[...ids]],
  );
  return new Set(rows.map((r) => r.id));
}

/** Why `action` does not apply to a job in its current state (null: it applies). */
export function stateRefusal(
  action: JobAction,
  row: Pick<JobRow, 'state' | 'runtime' | 'spec_kind' | 'spec_role'>,
  canContinue: boolean,
  canResolve = false,
): string | null {
  const s = row.state;
  switch (action) {
    case 'cancel':
      if (s === 'CANCELLING') return 'it is already being cancelled';
      return CANCELLABLE_STATES.has(s) ? null : `it is ${s} — nothing to cancel`;
    case 'run_again':
      if (!RERUNNABLE_STATES.has(s)) return `it is ${s}; only a finished job can run again`;
      if (isRetiredRuntime(row.runtime)) return 'its runtime was removed (history only)';
      if (row.spec_kind === 'machine-admin')
        return 'it is a machine administration job (start it again from Machines)';
      if (row.spec_role !== null) return `it is a ${row.spec_role} job started by the platform`;
      return null;
    case 'continue':
      return canContinue
        ? null
        : `it is ${s}; only a failed or cancelled job whose approval expired or whose time limit ran out continues`;
    case 'set_class':
    case 'move':
    case 'run_now':
      return s === 'QUEUED' ? null : `it is ${s}; only queued jobs`;
    case 'resolve_conflicts':
      return canResolve
        ? null
        : `it is ${s}; only a verified result that conflicts with its target (waiting for its decision or left open as a pull request, no resolution job open yet) can be resolved`;
  }
}

/** The actions the subject may draft on a job now (find_jobs `actions`). */
function actionsFor(subject: Subject, row: JobRow, canContinue: boolean, canResolve = false): string[] {
  const out: string[] = [];
  for (const a of JOB_ACTIONS) {
    if (!authorize(subject, ACTION_AUTHZ[a], { project: row.project }).allow) continue;
    if (stateRefusal(a, row, canContinue, canResolve) !== null) continue;
    out.push(a);
  }
  if (row.state === 'PAUSED' && authorize(subject, 'jobs.resume', { project: row.project }).allow)
    out.push('resume');
  return out;
}

function jobLine(row: JobRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    project: row.project,
    state: row.state,
    priorityClass: priorityClassOf(row.priority),
  };
}

export interface JobActionCaller {
  readonly userId: string;
  readonly subject: Subject;
  readonly threadId: string;
  /** The assistant turn that drafts the card (null: a quick button in the console). */
  readonly turnId: string | null;
}

export interface JobActionInput {
  readonly action: JobAction;
  readonly jobIds: readonly string[];
  readonly reason?: string | undefined;
  readonly prompt?: string | undefined;
  readonly priorityClass?: PriorityClass | undefined;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

export interface FindJobsInput {
  readonly idPrefix?: string;
  readonly text?: string;
  readonly stateGroup?: string;
  readonly states?: readonly string[];
  readonly project?: string;
  readonly priorityClass?: PriorityClass;
  readonly mine?: boolean;
  readonly limit?: number;
}

export class ChatJobActions {
  constructor(private readonly deps: { readonly db: Queryable; readonly store: ChatStore }) {}

  async #rows(ids: readonly string[]): Promise<Map<string, JobRow>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.deps.db.query<JobRow>(`${ROW_SQL} WHERE j.id = ANY($1::uuid[])`, [[...ids]]);
    return new Map(titled(rows).map((r) => [r.id, r]));
  }

  /** find_jobs: the jobs matching the filters, of the caller's visible projects only. */
  async find(subject: Subject, i: FindJobsInput): Promise<ToolOutcome> {
    if (i.project !== undefined) {
      const d = authorize(subject, 'jobs.read', { project: i.project });
      if (!d.allow) {
        return d.reason === 'not_visible'
          ? { ok: false, code: 'not_found', message: 'Project not found.' }
          : {
              ok: false,
              code: 'forbidden',
              message: 'The signed-in user is not allowed to read these jobs.',
            };
      }
    } else if (!authorize(subject, 'jobs.read').allow) {
      return { ok: false, code: 'forbidden', message: 'The signed-in user is not allowed to read jobs.' };
    }
    const where: string[] = [];
    const values: unknown[] = [];
    const v = (x: unknown): string => {
      values.push(x);
      return `$${String(values.length)}`;
    };
    const projects = visibleProjects(subject);
    if (projects !== null) where.push(`j.project = ANY(${v([...projects])}::text[])`);
    if (i.project !== undefined) where.push(`j.project = ${v(i.project)}`);
    if (i.idPrefix !== undefined)
      where.push(`j.id::text LIKE ${v(`${likeEscape(i.idPrefix.toLowerCase())}%`)}`);
    if (i.text !== undefined) {
      const words = i.text
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2)
        .slice(0, 8);
      for (const w of words) {
        const like = v(`%${likeEscape(w)}%`);
        where.push(`((j.spec ->> 'prompt') ILIKE ${like} OR jt.title ILIKE ${like})`);
      }
    }
    let states: readonly string[] | null = null;
    if (i.states !== undefined) states = i.states.map((s) => s.toUpperCase());
    else if (i.stateGroup !== undefined) states = STATE_GROUPS[i.stateGroup] ?? null;
    if (states !== null) where.push(`j.state::text = ANY(${v([...states])}::text[])`);
    if (i.priorityClass !== undefined) {
      const [lo, hi] = PRIORITY_CLASS_BAND[i.priorityClass];
      where.push(`COALESCE(q.priority, j.priority) BETWEEN ${v(lo)} AND ${v(hi)}`);
    }
    if (i.mine === true) where.push(`j.created_by_type = 'user' AND j.created_by_id = ${v(subject.userId)}`);
    const limit = Math.min(Math.max(i.limit ?? 20, 1), MAX_JOB_ACTION_JOBS);
    // The queue: by class, then oldest first (the dispatch order inside a class also weighs projects fairly).
    const order =
      i.stateGroup === 'queued'
        ? 'COALESCE(q.priority, j.priority) DESC, j.created_at ASC, j.id'
        : 'j.created_at DESC, j.id DESC';
    const { rows } = await this.deps.db.query<JobRow>(
      `${ROW_SQL}${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY ${order} LIMIT ${v(limit + 1)}`,
      values,
    );
    const page = titled(rows.slice(0, limit));
    const ids = page.map((r) => r.id);
    const [cont, resolv, approvals, kept] = await Promise.all([
      continuable(this.deps.db, ids),
      resolvable(this.deps.db, ids),
      ids.length === 0
        ? Promise.resolve({ rows: [] as { job_id: string; id: string }[] })
        : this.deps.db.query<{ job_id: string; id: string }>(
            `SELECT job_id, id FROM approval_requests WHERE job_id = ANY($1::uuid[]) AND status = 'pending'`,
            [ids],
          ),
      // p22-timeout-continuity: the unfinished work a timed-out job kept (continue starts from it).
      keptWorkOf(this.deps.db, ids),
    ]);
    const pending = new Map<string, string[]>();
    for (const a of approvals.rows) pending.set(a.job_id, [...(pending.get(a.job_id) ?? []), a.id]);
    return {
      ok: true,
      data: {
        jobs: page.map((r) => ({
          ...jobLine(r),
          runtime: r.runtime,
          mine: r.created_by_type === 'user' && r.created_by_id === subject.userId,
          createdAt: r.created_at.toISOString(),
          stateChangedAt: r.state_changed_at.toISOString(),
          ...(pending.has(r.id)
            ? { pendingApprovals: (pending.get(r.id) ?? []).map((id) => ({ id, link: `/approvals/${id}` })) }
            : {}),
          link: `/jobs/${r.id}`,
          ...(kept.has(r.id) ? { keptWork: keptWorkLine(kept.get(r.id) as KeptWork) } : {}),
          actions: actionsFor(subject, r, cont.has(r.id), resolv.has(r.id)),
        })),
        more: rows.length > limit,
        ...(rows.length === 0
          ? { note: 'No visible job matches. Try fewer words, another state or project, or list_jobs.' }
          : {}),
      },
    };
  }

  /**
   * Drafts a `job_action` card for `caller` (assistant tool or quick button): checks the jobs exist and are visible,
   * that the caller may take the action on each and that their state allows it now; jobs it does not apply to are left
   * off the card and reported. Never acts.
   */
  async propose(c: JobActionCaller, i: JobActionInput): Promise<ToolOutcome> {
    const invalid = (message: string): ToolOutcome => ({ ok: false, code: 'invalid', message });
    const ids = [...new Set(i.jobIds)];
    if (ids.length === 0) return invalid('Name at least one job.');
    if (ids.length > MAX_JOB_ACTION_JOBS)
      return invalid(`At most ${String(MAX_JOB_ACTION_JOBS)} jobs per card; split the request.`);
    if (i.prompt !== undefined && (i.action !== 'run_again' || ids.length !== 1))
      return invalid('An edited prompt is only for run_again of one job.');
    if ((i.before !== undefined || i.after !== undefined) && i.action !== 'move')
      return invalid('before / after are only for move.');
    if (i.action === 'move') {
      if (ids.length !== 1) return invalid('move takes exactly one job.');
      if ((i.before === undefined) === (i.after === undefined))
        return invalid('move takes exactly one of before / after.');
    }
    if (i.action === 'set_class' && i.priorityClass !== 'normal' && i.priorityClass !== 'background') {
      return invalid(
        i.priorityClass === 'urgent'
          ? 'A job becomes urgent (Acil) only through run_now (administrators).'
          : 'set_class needs priorityClass "normal" or "background".',
      );
    }
    if (i.priorityClass !== undefined && i.action !== 'set_class' && i.action !== 'run_again')
      return invalid('priorityClass is only for set_class and run_again.');
    if (i.reason !== undefined && i.action !== 'cancel') return invalid('reason is only for cancel.');

    // run now from the assistant: only when the user's own message asks for it (p9-queue-priority).
    if (i.action === 'run_now' && c.turnId !== null) {
      const ok = await asksToRunNow(this.deps.db, { threadId: c.threadId, turnId: c.turnId });
      if (!ok) {
        return {
          ok: false,
          code: 'invalid',
          message:
            'run_now was not drafted: the user’s message does not ask for it (run now, şimdi çalıştır, öne al, acil, hemen …). Ask the user whether the job should go first.',
        };
      }
    }
    let priorityNote: string | null = null;
    let priorityClass: PriorityClass | undefined = i.action === 'set_class' ? i.priorityClass : undefined;
    if (i.action === 'run_again' && i.priorityClass !== undefined) {
      if (c.turnId === null) priorityClass = i.priorityClass === 'urgent' ? 'normal' : i.priorityClass;
      else {
        const g = await draftPriorityClass(
          this.deps.db,
          { threadId: c.threadId, turnId: c.turnId },
          i.priorityClass,
        );
        priorityClass = g.priorityClass;
        priorityNote = g.note;
      }
    }

    const rows = await this.#rows(ids);
    const missing: string[] = [];
    const excluded: { id: string; title: string; state: string; why: string }[] = [];
    const included: JobRow[] = [];
    const cont = i.action === 'continue' ? await continuable(this.deps.db, ids) : new Set<string>();
    const resolv = i.action === 'resolve_conflicts' ? await resolvable(this.deps.db, ids) : new Set<string>();
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined || !authorize(c.subject, 'jobs.read', { project: row.project }).allow) {
        missing.push(id);
        continue;
      }
      const d = authorize(c.subject, ACTION_AUTHZ[i.action], { project: row.project });
      if (!d.allow) {
        excluded.push({
          id,
          title: row.title,
          state: row.state,
          why: `you may not ${VERB[i.action].toLowerCase()} jobs in ${row.project} (${i.action === 'run_now' ? 'administrator' : 'operator'} role needed)`,
        });
        continue;
      }
      const why = stateRefusal(i.action, row, cont.has(id), resolv.has(id));
      if (why !== null) {
        excluded.push({ id, title: row.title, state: row.state, why });
        continue;
      }
      if (i.action === 'set_class' && priorityClassOf(row.priority) === priorityClass) {
        excluded.push({
          id,
          title: row.title,
          state: row.state,
          why: `it is already ${PRIORITY_CLASS_LABEL[priorityClass]}`,
        });
        continue;
      }
      included.push(row);
    }
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'not_found',
        message: `Job${missing.length === 1 ? '' : 's'} not found: ${missing.map(short).join(', ')}. Use ids from find_jobs.`,
      };
    }
    let target: JobRow | null = null;
    if (i.action === 'move') {
      const targetId = i.before ?? i.after ?? '';
      if (targetId === ids[0]) return invalid('A job cannot move relative to itself.');
      target = (await this.#rows([targetId])).get(targetId) ?? null;
      if (target === null || !authorize(c.subject, 'jobs.read', { project: target.project }).allow) {
        return { ok: false, code: 'not_found', message: 'The job to move next to was not found.' };
      }
      if (target.state !== 'QUEUED')
        return invalid(`The job to move next to is ${target.state}, not queued.`);
    }
    if (included.length === 0) {
      return {
        ok: false,
        code: 'invalid',
        message: `Nothing to draft: ${excluded
          .slice(0, 10)
          .map((e) => `${short(e.id)} (${e.title || 'untitled'}): ${e.why}`)
          .join('; ')}.`,
      };
    }
    const projects = [...new Set(included.map((r) => r.project))];
    const one = included.length === 1 ? included[0] : undefined;
    const subject =
      one === undefined
        ? `${String(included.length)} jobs`
        : `job ${short(one.id)}${one.title ? `: ${one.title}` : ''}`;
    const title =
      i.action === 'set_class'
        ? `Move ${subject} to ${PRIORITY_CLASS_LABEL[priorityClass ?? 'normal']}`
        : i.action === 'move'
          ? `Move ${subject} ${i.before !== undefined ? 'before' : 'after'} job ${short(target?.id ?? '')}`
          : `${VERB[i.action]}: ${subject}`;
    const payload: Record<string, unknown> = {
      action: i.action,
      jobs: included.map(jobLine),
      ...(i.reason === undefined ? {} : { reason: i.reason }),
      ...(i.prompt === undefined ? {} : { prompt: i.prompt }),
      ...(priorityClass === undefined ? {} : { priorityClass }),
      ...(i.before === undefined ? {} : { before: i.before }),
      ...(i.after === undefined ? {} : { after: i.after }),
      ...(target === null ? {} : { target: jobLine(target) }),
      origin: c.turnId === null ? 'button' : 'assistant',
    };
    const draft = await this.deps.store.createDraft({
      threadId: c.threadId,
      userId: c.userId,
      // A quick button has no assistant turn: a fresh id keeps the column's meaning (no foreign key).
      turnId: c.turnId ?? randomUUID(),
      kind: 'job_action',
      title,
      payload,
      project: projects.length === 1 ? (projects[0] ?? null) : null,
    });
    return {
      ok: true,
      draft,
      data: {
        draftId: draft.id,
        kind: 'job_action',
        status:
          'proposed — NOT executed. The user must review and confirm this card in the console; nothing happens until then.',
        expiresAt: draft.expiresAt,
        action: i.action,
        jobs: included.map(jobLine),
        ...(excluded.length === 0 ? {} : { leftOff: excluded }),
        ...(priorityNote === null ? {} : { priorityNote }),
      },
    };
  }
}

// ------------------------------------------------------------------------------------------------- execution

export interface JobActionRunnerDeps {
  readonly pool: Queryable;
  readonly audit: AuditRecorder;
  readonly jobs: JobStore;
  readonly orchestrator: () => Orchestrator;
  readonly queue?: () => QueueService | null;
  readonly approvalPause?: () => ApprovalPauseService | null;
  readonly clock?: () => Date;
  /** p20-job-clock: "continue" of a job that stopped on its time limit (absent: only expired approvals continue). */
  readonly jobClock?: () => JobClockService | null;
  /** p22-conflict-resolve: "resolve_conflicts" (absent: refused as unavailable). */
  readonly conflictResolve?: () => ConflictResolveService | null;
}

export interface JobActionResult {
  readonly jobId: string;
  readonly title: string;
  readonly project: string | null;
  readonly outcome: 'done' | 'skipped' | 'refused' | 'failed';
  readonly message: string;
  readonly state?: string;
  /** run_again / continue: the new job. */
  readonly newJobId?: string;
}

/** Fields of a stored spec the composer's "Run again" carries over (the rest is re-derived or dropped). */
const RERUN_FIELDS = [
  'projectId',
  'runtime',
  'runtimeVersion',
  'model',
  'prompt',
  'sandboxProfile',
  'approvalPolicy',
  'limits',
  'sourceTrust',
  'requirements',
  'fallbacks',
  'deferrable',
] as const;

/** The spec of a "run again": the stored settings with a new work branch (and an edited prompt, if any). */
export function rerunSpec(
  stored: Record<string, unknown>,
  prompt?: string,
  /** p15-job-titles: the new job's title (absent: derived from the prompt). */
  title?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RERUN_FIELDS) if (stored[k] !== undefined) out[k] = stored[k];
  if (Array.isArray(out.fallbacks)) {
    out.fallbacks = out.fallbacks.map((f: unknown) => {
      if (typeof f !== 'object' || f === null) return f;
      const { modelProfile: _m, ...rest } = f as Record<string, unknown>;
      return rest;
    });
  }
  const repo = stored.repository;
  if (typeof repo === 'object' && repo !== null) {
    const r = repo as Record<string, unknown>;
    out.repository = {
      url: r.url,
      baseRef: r.baseRef,
      workBranch: `agent/chat-rerun-${randomUUID().slice(0, 8)}`,
    };
  }
  if (prompt !== undefined) out.prompt = prompt;
  const t = normalizeJobTitle(title);
  if (t !== null) out.title = t;
  return out;
}

function errorText(err: unknown): { status: number; message: string } | null {
  if (err instanceof HttpError) return { status: err.statusCode, message: err.publicMessage };
  if (err instanceof RuntimeRemovedError) return { status: 400, message: err.readable };
  if (err instanceof IllegalTransitionError)
    return { status: 409, message: `it is ${err.from} now — the action no longer applies` };
  if (err instanceof JobStoreError)
    return { status: 409, message: 'the job changed concurrently; try again' };
  if (err instanceof Error && typeof (err as { status?: unknown }).status === 'number') {
    return { status: (err as unknown as { status: number }).status, message: err.message.slice(0, 300) };
  }
  return null;
}

export interface JobActionContext {
  readonly subject: Subject;
  readonly human: HumanActor;
  readonly actor: ActorContext;
}

export class JobActionRunner {
  constructor(private readonly deps: JobActionRunnerDeps) {}

  /**
   * Runs a confirmed `job_action` draft for the confirming user, job by job (only `selected` when the user unchecked
   * some). Throws only when nothing may run at all (every job refused → 403) or a step-up is missing (run now).
   */
  async run(
    ctx: JobActionContext,
    d: DraftRecord,
    selected?: readonly string[],
  ): Promise<Record<string, unknown>> {
    const p = d.payload;
    const action = p.action as JobAction;
    if (!(JOB_ACTIONS as readonly string[]).includes(action))
      throw new HttpError(400, 'invalid_draft', 'Unknown job action.', {}, {}, { reason: 'job_action' });
    const listed = Array.isArray(p.jobs)
      ? p.jobs.flatMap((j: unknown) => {
          const o = j as { id?: unknown; title?: unknown };
          return typeof o.id === 'string'
            ? [{ id: o.id, title: typeof o.title === 'string' ? o.title : '' }]
            : [];
        })
      : [];
    const chosen = selected === undefined ? listed : listed.filter((j) => selected.includes(j.id));
    // Run now is the queue screen's admin action with a step-up: the confirmation's step-up is checked again here.
    if (action === 'run_now') {
      const maxAge = ctx.human.stepUpMaxAgeMs;
      if (!stepUpFresh(ctx.human.mfaAt, (this.deps.clock ?? (() => new Date()))(), maxAge)) {
        throw new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.');
      }
    }
    const results: JobActionResult[] = listed
      .filter((j) => !chosen.some((c) => c.id === j.id))
      .map((j) => ({
        jobId: j.id,
        title: j.title,
        project: null,
        outcome: 'skipped',
        message: 'unchecked on the card',
      }));
    for (const j of chosen) results.push(await this.#one(ctx, d, action, j));
    const count = (o: JobActionResult['outcome']): number => results.filter((r) => r.outcome === o).length;
    const ran = chosen.length;
    if (ran > 0 && results.filter((r) => r.outcome === 'refused').length === ran) {
      throw new HttpError(
        403,
        'forbidden',
        'You are not allowed to do what this card proposes on any of its jobs.',
        {},
        {},
        { reason: 'job_actions' },
      );
    }
    const single = results.length === 1 ? results[0] : undefined;
    const newJobs = results.flatMap((r) => (r.newJobId === undefined ? [] : [r.newJobId]));
    return {
      action,
      done: count('done'),
      skipped: count('skipped'),
      refused: count('refused'),
      failed: count('failed'),
      results,
      // "Open job": the new job of a single run again / continue / resolve, else the single job itself.
      ...(newJobs.length === 1
        ? { jobId: newJobs[0] }
        : single !== undefined && newJobs.length === 0
          ? { jobId: single.jobId }
          : {}),
    };
  }

  async #one(
    ctx: JobActionContext,
    d: DraftRecord,
    action: JobAction,
    j: { id: string; title: string },
  ): Promise<JobActionResult> {
    const { rows } = await this.deps.pool.query<JobRow & { spec: Record<string, unknown> }>(
      `${ROW_WITH_SPEC_SQL} WHERE j.id = $1`,
      [j.id],
    );
    const row = titled(rows)[0];
    const base = { jobId: j.id, title: row?.title ?? j.title, project: row?.project ?? null };
    let result: JobActionResult;
    if (row === undefined || !authorize(ctx.subject, 'jobs.read', { project: row.project }).allow) {
      result = { ...base, outcome: 'refused', message: 'job not found' };
    } else if (!authorize(ctx.subject, ACTION_AUTHZ[action], { project: row.project }).allow) {
      result = {
        ...base,
        outcome: 'refused',
        message: `you are not allowed to ${VERB[action].toLowerCase()} jobs in ${row.project}`,
        state: row.state,
      };
    } else {
      const cont = action === 'continue' ? (await continuable(this.deps.pool, [j.id])).has(j.id) : false;
      const resolv =
        action === 'resolve_conflicts' ? (await resolvable(this.deps.pool, [j.id])).has(j.id) : false;
      const why = stateRefusal(action, row, cont, resolv);
      if (why !== null) {
        result = {
          ...base,
          outcome: 'skipped',
          message:
            TERMINAL.has(row.state) && action === 'cancel' ? `already ${row.state} — nothing to cancel` : why,
          state: row.state,
        };
      } else {
        try {
          result = { ...base, ...(await this.#execute(ctx, d, action, row)) };
        } catch (err) {
          const e = errorText(err);
          if (e === null) throw err;
          result = {
            ...base,
            outcome:
              e.status === 409 ? 'skipped' : e.status === 403 || e.status === 404 ? 'refused' : 'failed',
            message: e.message,
            state: row.state,
          };
        }
      }
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: ctx.subject.userId },
      action: 'chat.job_action',
      target: `job:${j.id}`,
      outcome: result.outcome === 'done' ? 'success' : result.outcome === 'refused' ? 'denied' : 'failure',
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
      metadata: {
        source: 'chat',
        action,
        result: result.outcome,
        message: result.message.slice(0, 300),
        draftId: d.id,
        threadId: d.threadId,
        origin: d.payload.origin === 'button' ? 'button' : 'assistant',
        ...(result.newJobId === undefined ? {} : { newJobId: result.newJobId }),
      },
    });
    return result;
  }

  async #execute(
    ctx: JobActionContext,
    d: DraftRecord,
    action: JobAction,
    row: JobRow & { spec: Record<string, unknown> },
  ): Promise<Pick<JobActionResult, 'outcome' | 'message' | 'state' | 'newJobId'>> {
    const p = d.payload;
    const user = { type: 'user' as const, id: ctx.subject.userId };
    const queueActor = {
      userId: ctx.subject.userId,
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent ?? null,
    };
    switch (action) {
      case 'cancel': {
        const reason =
          typeof p.reason === 'string' && p.reason.trim() !== ''
            ? `${p.reason} (from chat)`
            : 'Cancelled from the ops chat';
        const job = await this.deps.orchestrator().cancel(row.id, user, reason.slice(0, 1000));
        return {
          outcome: 'done',
          state: job.state,
          message: job.state === 'CANCELLING' ? 'cancelling — the machine stops it' : 'cancelled',
        };
      }
      case 'run_again': {
        const prompt = typeof p.prompt === 'string' ? p.prompt : undefined;
        // p16-zip-job-input: the same input bundle again while it is kept (else the job runs without it).
        const bundle = await inputUploadOfJob(this.deps.pool, row.id);
        const cls = p.priorityClass;
        const priority =
          cls === 'urgent' || cls === 'normal' || cls === 'background'
            ? PRIORITY_CLASS_VALUE[cls]
            : row.stored_priority;
        const { job } = await this.deps.jobs.create({
          project: row.project,
          // p15-job-titles: the same work keeps its title; an edited prompt gets a title derived from it.
          spec: rerunSpec(row.spec, prompt, prompt === undefined ? row.title : undefined),
          priority,
          actor: user,
          submit: true,
          // p15-workspace-retention: a workspace job runs again from its kept working directory (when one is kept).
          keptFilesFrom: row.id,
          ...(bundle === null ? {} : { inputUpload: bundle }),
        });
        void this.deps
          .orchestrator()
          .dispatch(job.id)
          .catch(() => undefined);
        return {
          outcome: 'done',
          state: job.state,
          newJobId: job.id,
          message: `new job ${short(job.id)} started`,
        };
      }
      case 'continue': {
        // p20-job-clock: a job that stopped on its time limit continues where it was (a longer limit, kept files).
        const clockSvc = this.deps.jobClock?.() ?? null;
        if (clockSvc !== null && (await clockSvc.timedOut(this.deps.pool, [row.id])).has(row.id)) {
          const out = await clockSvc.continueAfterTimeout(
            row.id,
            {},
            { subject: ctx.subject, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent ?? null, via: 'chat' },
          );
          return {
            outcome: 'done',
            newJobId: out.jobId,
            // p22-timeout-continuity: say where it starts (the kept work, never "from scratch" when work was kept).
            message: `continued as job ${short(out.jobId)} with a ${String(Math.round(out.maxDurationSec / 60))} min limit${
              out.from === 'pushed'
                ? ', starting from the unfinished work the earlier run pushed'
                : out.from === 'machine'
                  ? `, starting from the unfinished work kept on machine ${out.workerId ?? '?'} (pinned to it)`
                  : ''
            }`,
          };
        }
        const pause = this.deps.approvalPause?.() ?? null;
        if (pause === null)
          throw new HttpError(
            503,
            'unavailable',
            'Continue is not available.',
            {},
            {},
            { reason: 'continue' },
          );
        const out = await pause.continueAfterExpiry(row.id, {
          id: ctx.subject.userId,
          ip: ctx.actor.ip,
          userAgent: ctx.actor.userAgent ?? null,
        });
        return { outcome: 'done', newJobId: out.jobId, message: `continued as job ${short(out.jobId)}` };
      }
      case 'resolve_conflicts': {
        const svc = this.deps.conflictResolve?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Conflict resolution is not available.',
            {},
            {},
            { reason: 'conflict_resolve' },
          );
        const out = await svc.resolve(row.id, { subject: ctx.subject, via: 'chat' });
        return {
          outcome: 'done',
          newJobId: out.jobId,
          message: `conflict-resolution job ${short(out.jobId)} started from the current target; when it merges, this job's pull request is closed by the platform`,
        };
      }
      case 'set_class': {
        const q = this.#queue();
        const cls = p.priorityClass === 'background' ? 'background' : 'normal';
        const out = await q.setClass(row.id, cls, queueActor);
        return {
          outcome: 'done',
          state: 'QUEUED',
          message: `${PRIORITY_CLASS_LABEL[out.from]} → ${PRIORITY_CLASS_LABEL[out.priorityClass]}`,
        };
      }
      case 'move': {
        const q = this.#queue();
        const before = typeof p.before === 'string' ? p.before : undefined;
        const after = typeof p.after === 'string' ? p.after : undefined;
        const targetId = before ?? after ?? '';
        // The queue route's rule: the other job must be visible to the confirming user too.
        const { rows } = await this.deps.pool.query<{ project: string }>(
          'SELECT project FROM jobs WHERE id = $1',
          [targetId],
        );
        const tp = rows[0]?.project;
        if (tp === undefined || !authorize(ctx.subject, 'jobs.read', { project: tp }).allow) {
          throw new HttpError(
            404,
            'target_not_found',
            'the job to move next to was not found',
            {},
            {},
            {
              reason: 'lower',
            },
          );
        }
        const out = await q.move(row.id, { before, after }, queueActor);
        return {
          outcome: 'done',
          state: 'QUEUED',
          message: out.note ?? `moved ${before !== undefined ? 'before' : 'after'} job ${short(targetId)}`,
        };
      }
      case 'run_now': {
        const out = await this.#queue().runNow(row.id, queueActor);
        return {
          outcome: 'done',
          state: 'QUEUED',
          message: `now ${PRIORITY_CLASS_LABEL[out.priorityClass]} and first in the queue`,
        };
      }
    }
  }

  #queue(): QueueService {
    const q = this.deps.queue?.() ?? null;
    if (q === null)
      throw new HttpError(503, 'unavailable', 'The queue is not available.', {}, {}, { reason: 'queue' });
    return q;
  }
}
