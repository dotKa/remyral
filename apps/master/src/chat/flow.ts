import { parseStepOutcome } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Role } from '../auth/users.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, projectRoleOf, roleAtLeast, type Subject, visibleProjects } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { projectRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import { loadValue } from '../workflows/v2/values.js';
import type { OutputReportView } from '../workspaces/output-limits.js';
import { type JobEnd, jobResultNotification, jobResultText, outcomeOf } from './job-result.js';
import {
  approvalTexts,
  attentionLine,
  eventKey,
  gateEventKey,
  gateId,
  gateTexts,
  isGateId,
  isUuid,
  jobEventKey,
  V1_NODE_ID,
  plainLine,
  resultMeta,
  type RunResult,
  workflowRunResult,
} from './flow-model.js';
import { detailsView, storedDetails } from '../approvals/details.js';
import { HttpError } from '../http/errors.js';
import type { ChatStore, MessageView } from './store.js';
import type { AutoExtendFacts, TimeWarningFacts } from '../jobs/job-clock.js';
import { keptWorkOf } from '../jobs/kept-work.js';
import { TIMED_OUT_SQL } from '../jobs/timed-out-sql.js';
import { guessLanguage, mdText, type WatchLanguage } from './watches.js';

/**
 * p17-chat-flow (docs/design/p17-chat-flow.md): what the website's sample screens show in the chat, made real.
 *
 *  1. **A workflow's approval step reaches the people and the conversations it concerns.** When an engine-2 node run
 *     starts waiting for an approval (a `control.approval` node or an AI step's gate) the tick posts — once, also with
 *     several replicas (`chat_flow_events` is the claim) — a card message into every conversation linked to the run:
 *     the one whose card started it (or its parent run), the ones watching it, and the ones whose confirmed
 *     `draft_workflow` card created the workflow. Each conversation's owner must still be able to read the run. The
 *     users who may decide it get a `workflow.approval` notification; "Senden bekleyen" lists it ({@link pending}).
 *     The decision itself is the run page's route (`workflows.approve`, the gate's role, step-up, audit, one decision
 *     wins under the run lock) — every surface reads the live state through {@link approvalView}.
 *     p18-last-gaps: an ENGINE-1 gate (a v1 document's `approval` on a step, run on engine 1 while `v2ForV1` is off)
 *     takes the same way under its own keys (`gate:<run>:<node>`, `gatedone:<run>:<node>`) and a stable step id
 *     ({@link gateId}); it is decided through engine 1's gate route (`POST /workflows/runs/:id/nodes/:node/…`).
 *  2. **A job agent's question reaches the conversation that started the job.** {@link jobQuestionAsked} posts a card
 *     message (`meta.questionId`) into the conversations whose confirmed card started the job (or its parent job) or
 *     that watch it; the question stays a job question (answered through the job route, `jobs.message`).
 *  3. **A run started from a conversation ends with a result card** (state, steps, duration, a bounded summary of the
 *     last step's output). Conversations that watch the run get it on the watch's own end note instead (watches.ts).
 *  4. **A job started from a conversation ends with a result card** (p18-outputs-delivery): every terminal state —
 *     succeeded, failed (also before it ever ran: no eligible machine, an unavailable context …), cancelled, lost —
 *     posts the job result card note into the conversation whose confirmed card started it (a job card, a machine
 *     task, an automation's "run now", "Yeniden çalıştır" / "Devam et" of a job action card, every job of a job
 *     batch card), once per outcome (`job:<job id>:<terminal transition id>`), unless the conversation's own watch on the job tells it. The note
 *     makes the conversation unread and moves it up; its owner gets a `chat.watch` notification.
 *
 * Every text from a run or an agent is data: stored plain (bounded), rendered as text by the console.
 */

export interface ChatFlowDeps {
  readonly pool: Pool;
  readonly store: ChatStore;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly audit: AuditRecorder;
  readonly notifications: () => NotificationService | null;
  /** After commit: stream a posted message (or, with null, a refresh) to the conversation's open views. */
  readonly publish: (threadId: string, message: MessageView | null) => void;
  /**
   * W4: a `flow` stream event (`{kind: 'workflow-approval', runId, nodeRunId, state}` — ids and a state word only): an
   * approval step shown as a card in the conversation was decided or closed. Absent: the cards refresh on reconnect.
   */
  readonly event?: (threadId: string, data: Record<string, unknown>) => void;
  /** p18-outputs-delivery: what became of a workspace job's `out/` (the zipped-delivery line); absent: none. */
  readonly outputReport?: (jobId: string) => Promise<OutputReportView | null>;
}

export type ApprovalState = 'waiting' | 'approved' | 'denied' | 'closed';

/** One workflow approval step as every surface shows it (chat card, "Senden bekleyen", run page link). */
export interface WorkflowApprovalView {
  /**
   * p18-last-gaps: 2 = an engine-2 node run (decided through `/node-runs/:nodeRunId/…`); 1 = an engine-1 gate
   * (`nodeRunId` is its {@link gateId}; decided through `/nodes/:node/…`).
   */
  readonly engine: 1 | 2;
  readonly runId: string;
  readonly nodeRunId: string;
  readonly node: string;
  readonly nodeType: string;
  readonly scope: string;
  readonly workflow: string;
  readonly project: string;
  readonly version: number;
  /** The step's title / details as configured (expressions resolved): plain text, untrusted when the run is. */
  readonly title: string | null;
  readonly details: string | null;
  readonly approverRole: Role;
  readonly state: ApprovalState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly dueAt: string | null;
  readonly runState: string;
  /** The run was started by an untrusted source (webhook, chat inputs): the texts are not the author's. */
  readonly untrusted: boolean;
  /** The caller may decide it (`workflows.approve` in the project and at least the step's role). */
  readonly canDecide: boolean;
}

interface Link {
  readonly threadId: string;
  readonly userId: string;
}

interface NodeRunFacts {
  id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  scope: string;
  state: string;
  wait_kind: string | null;
  gate_role: Role | null;
  gate_decision: 'approved' | 'denied' | null;
  gate_decided_at: Date | null;
  decided_by_name: string | null;
  due_at: Date | null;
  created_at: Date;
  input: Record<string, unknown> | null;
  name: string;
  project: string;
  version: number;
  run_state: string;
  source_trust: string | null;
  parent_run_id: string | null;
}

/** p18-last-gaps: an engine-1 gate (`workflow_nodes`) with its run. */
interface GateFacts {
  run_id: string;
  node_id: string;
  def: Record<string, unknown> | null;
  step_title: string | null;
  state: string;
  gate_role: Role | null;
  gate_decision: 'approved' | 'denied' | null;
  gate_decided_at: Date | null;
  decided_by_name: string | null;
  updated_at: Date;
  name: string;
  project: string;
  version: number;
  run_state: string;
  source_trust: string | null;
  parent_run_id: string | null;
}

const GATE_COLS = `n.run_id::text AS run_id, n.node_id, n.def, n.job_spec ->> 'title' AS step_title, n.state, n.gate_role, n.gate_decision, n.gate_decided_at,
  n.updated_at, (SELECT u.username FROM users u WHERE u.id::text = n.gate_decided_by) AS decided_by_name,
  r.name, r.project, r.version, r.state AS run_state, r.source_trust, r.parent_run_id::text AS parent_run_id`;

/** p18-last-gaps: engine-1 gates waiting for a decision (the partial index of migration 0188). */
const GATE_WAITING = `n.state = 'awaiting_approval' AND n.gate_role IS NOT NULL AND n.gate_decision IS NULL`;

const NODE_RUN_COLS = `nr.id::text AS id, nr.run_id::text AS run_id, nr.node_id, nr.node_type, nr.scope, nr.state,
  nr.wait_kind, nr.gate_role, nr.gate_decision, nr.gate_decided_at, nr.due_at, nr.created_at, nr.input,
  (SELECT u.username FROM users u WHERE u.id::text = nr.gate_decided_by) AS decided_by_name,
  r.name, r.project, r.version, r.state AS run_state, r.source_trust, r.parent_run_id::text AS parent_run_id`;

const BATCH = 50;
const PENDING_LIMIT = 50;
/** Confirmed run cards older than this are not looked at for a result card any more. */
const RESULT_WINDOW_MS = 7 * 24 * 3600_000;
/** Announced occurrences are kept this long (then a re-announcement is impossible anyway: the source ended). */
const EVENT_RETENTION_MS = 90 * 24 * 3600_000;

/** W4: scheduled runs that ended longer ago than this are not announced any more (a stopped master catches up a day). */
const SCHEDULED_WINDOW_MS = 24 * 3600_000;
/** W4: a successful scheduled result of the same automation / workflow is posted at most once per hour per conversation. */
const SCHEDULED_QUIET_MS = 3600_000;

/** p19-job-replies: messages sent from a conversation longer ago than this get no reply note any more. */
const REPLY_WINDOW_MS = 24 * 3600_000;
/** p19-job-replies: a reply note carries at most this much of the agent's answer. */
const REPLY_MAX = 600;

/** A job result note carries at most this much of the agent's summary (as the watches' end notes). */
const JOB_SUMMARY_MAX = 400;

/**
 * p18-outputs-delivery: the jobs a confirmed card `d` started — its `result.jobId` (job, machine task, tool install,
 * an automation's run now) or, for a job action card, each result's `newJobId` ("Yeniden çalıştır", "Devam et"; a
 * cancel or a queue move of an existing job started nothing).
 */
const UUID_RE = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
const STARTED_JOBS_SQL = `
  SELECT u.job_id FROM (
    SELECT CASE WHEN d.kind <> 'job_action' AND d.result ->> 'jobId' ~* ${UUID_RE}
                THEN (d.result ->> 'jobId')::uuid END AS job_id
    UNION
    SELECT CASE WHEN r ->> 'newJobId' ~* ${UUID_RE} THEN (r ->> 'newJobId')::uuid END
      FROM jsonb_array_elements(CASE WHEN d.kind = 'job_action' AND jsonb_typeof(d.result -> 'results') = 'array'
                                     THEN d.result -> 'results' ELSE '[]'::jsonb END) r
    UNION
    SELECT CASE WHEN c ->> 'jobId' ~* ${UUID_RE} THEN (c ->> 'jobId')::uuid END
      FROM jsonb_array_elements(CASE WHEN d.kind = 'job_batch' AND jsonb_typeof(d.result -> 'created') = 'array'
                                     THEN d.result -> 'created' ELSE '[]'::jsonb END) c
  ) u WHERE u.job_id IS NOT NULL`;

/**
 * The cards whose jobs report back to their conversation. p19-job-waits: an automation's "run now" card
 * (`automation_change`, its `result.jobId`) too.
 */
const JOB_CARD_KINDS = `'job', 'machine_task', 'tool_install', 'automation', 'automation_change', 'job_action', 'job_batch'`;

const STATE_WORD: Record<WatchLanguage, Record<'succeeded' | 'failed' | 'cancelled', string>> = {
  tr: { succeeded: 'başarıyla bitti', failed: 'başarısız oldu', cancelled: 'iptal edildi' },
  en: { succeeded: 'succeeded', failed: 'failed', cancelled: 'was cancelled' },
};

export class ChatFlowService {
  #lastStep = 0;

  constructor(private readonly deps: ChatFlowDeps) {}

  #now(): Date {
    return this.deps.clock();
  }

  step(everyMs = 5_000): { name: string; run: () => Promise<number> } {
    return {
      name: 'chat-flow',
      run: async () => {
        const t = this.#now().getTime();
        if (t - this.#lastStep < everyMs) return 0;
        this.#lastStep = t;
        return this.tick();
      },
    };
  }

  /** One pass: new approval waits, then finished runs started from a conversation. Returns the occurrences posted. */
  async tick(): Promise<number> {
    let n = 0;
    const { rows: waits } = await this.deps.pool.query<{ id: string }>(
      `SELECT nr.id::text AS id FROM workflow_node_runs nr
        WHERE nr.wait_kind = 'approval' AND nr.gate_decision IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'approval:' || nr.id::text)
        ORDER BY nr.created_at LIMIT ${String(BATCH)}`,
    );
    for (const w of waits) {
      try {
        if (await this.#announceApproval(w.id)) n++;
      } catch (err) {
        this.deps.log.error({ err, nodeRunId: w.id }, 'chat flow: approval announcement failed');
      }
    }
    // p18-last-gaps: engine-1 gates (v1 documents on engine 1), once per (run, node).
    const { rows: gates } = await this.deps.pool.query<{ run_id: string; node_id: string }>(
      `SELECT n.run_id::text AS run_id, n.node_id FROM workflow_nodes n
        WHERE ${GATE_WAITING}
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'gate:' || n.run_id::text || ':' || n.node_id)
        ORDER BY n.updated_at LIMIT ${String(BATCH)}`,
    );
    for (const g of gates) {
      try {
        if (await this.#announceGate(g.run_id, g.node_id)) n++;
      } catch (err) {
        this.deps.log.error({ err, runId: g.run_id, node: g.node_id }, 'chat flow: gate announcement failed');
      }
    }
    const now = this.#now();
    const { rows: ended } = await this.deps.pool.query<{ run_id: string }>(
      `SELECT DISTINCT r.id::text AS run_id FROM chat_drafts d
         JOIN workflow_runs r
           ON r.id = (CASE WHEN d.result->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           THEN (d.result->>'runId')::uuid END)
        WHERE d.kind = 'workflow_run' AND d.state = 'confirmed' AND d.decided_at >= $1
          AND r.state IN ('succeeded', 'failed', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'result:' || r.id::text)
        LIMIT ${String(BATCH)}`,
      [new Date(now.getTime() - RESULT_WINDOW_MS)],
    );
    for (const r of ended) {
      try {
        if (await this.#announceResult(r.run_id)) n++;
      } catch (err) {
        this.deps.log.error({ err, runId: r.run_id }, 'chat flow: result announcement failed');
      }
    }
    const { rows: jobs } = await this.deps.pool.query<{ job_id: string; transition_id: string }>(
      `SELECT x.job_id, x.transition_id FROM (
         SELECT DISTINCT j.id::text AS job_id,
                (SELECT max(t.id) FROM job_transitions t WHERE t.job_id = j.id)::text AS transition_id
           FROM chat_drafts d
           CROSS JOIN LATERAL (${STARTED_JOBS_SQL}) s
           JOIN jobs j ON j.id = s.job_id
          WHERE d.state = 'confirmed' AND d.decided_at >= $1
            AND d.kind IN (${JOB_CARD_KINDS})
            AND j.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST')) x
        WHERE NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'job:' || x.job_id || ':' || x.transition_id)
        LIMIT ${String(BATCH)}`,
      [new Date(now.getTime() - RESULT_WINDOW_MS)],
    );
    for (const j of jobs) {
      try {
        if (await this.#announceJob(j.job_id, j.transition_id)) n++;
      } catch (err) {
        this.deps.log.error({ err, jobId: j.job_id }, 'chat flow: job result announcement failed');
      }
    }
    // p19-job-waits: a job started here that stops for a person (its merge approval, a gated command), once per request.
    const { rows: jobWaits } = await this.deps.pool.query<{ approval_id: string }>(
      `SELECT DISTINCT a.id::text AS approval_id
         FROM chat_drafts d
         CROSS JOIN LATERAL (${STARTED_JOBS_SQL}) s
         JOIN approval_requests a ON a.job_id = s.job_id AND a.status = 'pending'
        WHERE d.state = 'confirmed' AND d.decided_at >= $1 AND d.kind IN (${JOB_CARD_KINDS})
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'jobwait:' || a.id::text)
        LIMIT ${String(BATCH)}`,
      [new Date(now.getTime() - RESULT_WINDOW_MS)],
    );
    for (const w of jobWaits) {
      try {
        if (await this.#announceJobWait(w.approval_id)) n++;
      } catch (err) {
        this.deps.log.error(
          { err, approvalId: w.approval_id },
          'chat flow: job approval announcement failed',
        );
      }
    }
    // p19-job-replies: the agent's first answer to a message the conversation sent to a running job.
    n += await this.#announceReplies(new Date(now.getTime() - REPLY_WINDOW_MS));
    // W4: results of scheduled runs of what a conversation created (a workflow by its draft_workflow card, an
    // automation by its automation card) go into that conversation.
    n += await this.#scheduledResults(new Date(now.getTime() - SCHEDULED_WINDOW_MS));
    // W4: approval steps announced in conversations that were decided or closed meanwhile (any path: the run page, the
    // chat card, "Senden bekleyen", an expiry, a cancelled run) — their cards are told once through the stream.
    const { rows: decided } = await this.deps.pool.query<{ id: string }>(
      `SELECT nr.id::text AS id FROM chat_flow_events e
         JOIN workflow_node_runs nr ON nr.id::text = substring(e.key from 10)
        WHERE e.key LIKE 'approval:%'
          AND (nr.gate_decision IS NOT NULL OR nr.state <> 'waiting' OR nr.wait_kind IS DISTINCT FROM 'approval')
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events d WHERE d.key = 'decided:' || nr.id::text)
        LIMIT ${String(BATCH)}`,
    );
    for (const d of decided) {
      try {
        const claimed = await withTransaction(this.deps.pool, (tx) =>
          this.#claim(tx, eventKey('decided', d.id)),
        );
        if (claimed && (await this.approvalDecided(d.id)) > 0) n++;
      } catch (err) {
        this.deps.log.error({ err, nodeRunId: d.id }, 'chat flow: decided approval not announced');
      }
    }
    // p18-last-gaps: the same for engine-1 gates (`gate:<run>:<node>` → `gatedone:<run>:<node>`).
    const { rows: gatesDone } = await this.deps.pool.query<{ run_id: string; node_id: string }>(
      `SELECT n.run_id::text AS run_id, n.node_id FROM chat_flow_events e
         JOIN workflow_nodes n ON n.run_id::text = substring(e.key from 6 for 36) AND n.node_id = substring(e.key from 43)
        WHERE e.key LIKE 'gate:%'
          AND (n.gate_decision IS NOT NULL OR n.state <> 'awaiting_approval')
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events d WHERE d.key = 'gatedone:' || substring(e.key from 6))
        LIMIT ${String(BATCH)}`,
    );
    for (const g of gatesDone) {
      try {
        const claimed = await withTransaction(this.deps.pool, (tx) =>
          this.#claim(tx, gateEventKey('gatedone', g.run_id, g.node_id)),
        );
        if (claimed && (await this.gateDecided(g.run_id, g.node_id)) > 0) n++;
      } catch (err) {
        this.deps.log.error(
          { err, runId: g.run_id, node: g.node_id },
          'chat flow: decided gate not announced',
        );
      }
    }
    await this.deps.pool.query(
      `DELETE FROM chat_flow_events WHERE key IN (
         SELECT key FROM chat_flow_events WHERE created_at < $1 LIMIT 500)`,
      [new Date(now.getTime() - EVENT_RETENTION_MS)],
    );
    return n;
  }

  // -------------------------------------------------------------------------------------------- claims

  /** Claims an occurrence (true: this caller announces it; false: already announced by someone). */
  async #claim(tx: Queryable, key: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      'INSERT INTO chat_flow_events (key, created_at) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, this.#now()],
    );
    return (rowCount ?? 0) === 1;
  }

  async #activeSubject(db: Queryable, userId: string): Promise<Subject | null> {
    const { rows } = await db.query<{ id: string; role: Role; disabled_at: Date | null }>(
      'SELECT id::text AS id, role, disabled_at FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled_at !== null) return null;
    return loadSubject(db, { id: u.id, role: u.role });
  }

  /** The language a note in this conversation is written in: the owner's console language, else a guess. */
  async #language(db: Queryable, userId: string, threadId: string): Promise<WatchLanguage> {
    const { rows } = await db.query<{ locale: string | null }>('SELECT locale FROM users WHERE id = $1', [
      userId,
    ]);
    const l = rows[0]?.locale;
    if (l === 'tr' || l === 'en') return l;
    const { rows: texts } = await db.query<{ content: string }>(
      `SELECT content FROM chat_messages WHERE thread_id = $1 AND role = 'user' ORDER BY seq DESC LIMIT 3`,
      [threadId],
    );
    return guessLanguage(texts.map((r) => r.content.slice(0, 2000)));
  }

  #publish(threadId: string, message: MessageView | null): void {
    try {
      this.deps.publish(threadId, message);
    } catch (err) {
      this.deps.log.debug({ err, threadId }, 'chat flow: stream publish failed');
    }
  }

  // --------------------------------------------------------------------------------------------- links

  /**
   * p18-plan-mode W4: the item of one of the conversation's plans a card concerns — an item linked to the run / job
   * itself, or to the card (draft) that started it. Null: no plan item. `{planItem}` goes into the note's meta so the
   * console links the card to the item.
   */
  async planItemOf(
    db: Queryable,
    threadId: string,
    ref: { readonly runIds?: readonly string[]; readonly jobIds?: readonly string[] },
  ): Promise<{ planItem: { planId: string; key: string; title: string } } | Record<string, never>> {
    const runIds = (ref.runIds ?? []).filter(isUuid);
    const jobIds = (ref.jobIds ?? []).filter(isUuid);
    if (runIds.length === 0 && jobIds.length === 0) return {};
    const { rows } = await db.query<{ plan_id: string; key: string; title: string }>(
      `SELECT p.id::text AS plan_id, i.key, i.title
         FROM chat_plans p JOIN chat_plan_items i ON i.plan_id = p.id
        WHERE p.thread_id = $1 AND i.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.links) = 'array' THEN i.links ELSE '[]' END) l
             WHERE (l->>'kind' = 'workflow_run' AND l->>'id' = ANY($2::text[]))
                OR (l->>'kind' = 'job' AND l->>'id' = ANY($3::text[]))
                OR (l->>'kind' = 'draft' AND EXISTS (
                      SELECT 1 FROM chat_drafts d WHERE d.thread_id = p.thread_id AND d.id::text = l->>'id'
                         AND (d.result->>'runId' = ANY($2::text[]) OR d.result->>'jobId' = ANY($3::text[])))))
        ORDER BY p.created_at DESC, i.phase, i.position LIMIT 1`,
      [threadId, runIds, jobIds],
    );
    const r = rows[0];
    return r === undefined ? {} : { planItem: { planId: r.plan_id, key: r.key, title: r.title } };
  }

  /** The run and its parents (a sub-workflow's approval concerns the conversation of the run that called it). */
  async #lineage(db: Queryable, runId: string): Promise<{ id: string; project: string; name: string }[]> {
    const out: { id: string; project: string; name: string }[] = [];
    let id: string | null = runId;
    for (let i = 0; i < 6 && id !== null; i++) {
      const res: { rows: { project: string; name: string; parent: string | null }[] } = await db.query<{
        project: string;
        name: string;
        parent: string | null;
      }>('SELECT project, name, parent_run_id::text AS parent FROM workflow_runs WHERE id = $1', [id]);
      const r: { project: string; name: string; parent: string | null } | undefined = res.rows[0];
      if (r === undefined) break;
      out.push({ id, project: r.project, name: r.name });
      id = r.parent;
    }
    return out;
  }

  /**
   * Conversations linked to a run: its confirmed run card (`started`), an active watch on it (`watched`), and — with
   * `created` — the confirmed `draft_workflow` cards that created / changed the workflow. Owners' own, not archived.
   */
  async linksOfRun(db: Queryable, runId: string, opts: { created: boolean }): Promise<Link[]> {
    const runs = await this.#lineage(db, runId);
    if (runs.length === 0) return [];
    const ids = runs.map((r) => r.id);
    const { rows } = await db.query<{ thread_id: string; user_id: string }>(
      `SELECT DISTINCT ON (x.thread_id) x.thread_id::text AS thread_id, x.user_id::text AS user_id
         FROM (
           SELECT d.thread_id, d.user_id, d.created_at FROM chat_drafts d
            WHERE d.kind = 'workflow_run' AND d.state = 'confirmed' AND d.result->>'runId' = ANY($1::text[])
           UNION ALL
           SELECT w.thread_id, w.user_id, w.created_at FROM chat_watches w
            WHERE w.target_kind = 'workflow_run' AND w.state = 'active' AND w.thread_id IS NOT NULL
              AND w.target_uuid::text = ANY($1::text[])
           UNION ALL
           SELECT d.thread_id, d.user_id, d.created_at FROM chat_drafts d
            WHERE $2::boolean AND d.kind = 'workflow' AND d.state = 'confirmed'
              AND d.project = $3 AND d.payload->>'name' = $4
         ) x
         JOIN chat_threads t ON t.id = x.thread_id AND t.user_id = x.user_id AND t.archived_at IS NULL
        ORDER BY x.thread_id, x.created_at`,
      [ids, opts.created, runs[0]?.project ?? '', runs[0]?.name ?? ''],
    );
    return rows.map((r) => ({ threadId: r.thread_id, userId: r.user_id }));
  }

  /** Conversations linked to a job (or the job that started it as a sub-job): its confirmed card, an active watch. */
  async linksOfJob(db: Queryable, jobId: string): Promise<Link[]> {
    if (!isUuid(jobId)) return [];
    const ids = [jobId];
    let cur = jobId;
    for (let i = 0; i < 3; i++) {
      const { rows } = await db.query<{ parent: string }>(
        'SELECT parent_job_id::text AS parent FROM job_subtasks WHERE child_job_id = $1',
        [cur],
      );
      const p = rows[0]?.parent;
      if (p === undefined) break;
      ids.push(p);
      cur = p;
    }
    const { rows } = await db.query<{ thread_id: string; user_id: string }>(
      `SELECT DISTINCT ON (x.thread_id) x.thread_id::text AS thread_id, x.user_id::text AS user_id
         FROM (
           SELECT d.thread_id, d.user_id, d.created_at FROM chat_drafts d
            WHERE d.state = 'confirmed' AND d.result->>'jobId' = ANY($1::text[])
           UNION ALL
           SELECT w.thread_id, w.user_id, w.created_at FROM chat_watches w
            WHERE w.target_kind = 'job' AND w.state = 'active' AND w.thread_id IS NOT NULL
              AND w.target_uuid::text = ANY($1::text[])
         ) x
         JOIN chat_threads t ON t.id = x.thread_id AND t.user_id = x.user_id AND t.archived_at IS NULL
        ORDER BY x.thread_id, x.created_at`,
      [ids],
    );
    return rows.map((r) => ({ threadId: r.thread_id, userId: r.user_id }));
  }

  // ------------------------------------------------------------------------------------------ approvals

  async #nodeRun(db: Queryable, nodeRunId: string, runId?: string): Promise<NodeRunFacts | null> {
    if (!isUuid(nodeRunId) || (runId !== undefined && !isUuid(runId))) return null;
    const { rows } = await db.query<NodeRunFacts>(
      `SELECT ${NODE_RUN_COLS} FROM workflow_node_runs nr JOIN workflow_runs r ON r.id = nr.run_id
        WHERE nr.id = $1 AND ($2::uuid IS NULL OR nr.run_id = $2)`,
      [nodeRunId, runId ?? null],
    );
    return rows[0] ?? null;
  }

  async #view(db: Queryable, f: NodeRunFacts, subject: Subject | null): Promise<WorkflowApprovalView> {
    const stored = f.input?.config;
    const config = stored === undefined ? null : await loadValue(db, f.run_id, stored).catch(() => null);
    const texts = approvalTexts(config);
    const role: Role = f.gate_role ?? 'admin';
    const waiting = f.state === 'waiting' && f.wait_kind === 'approval' && f.gate_decision === null;
    const state: ApprovalState = waiting
      ? 'waiting'
      : f.gate_decision === 'approved'
        ? 'approved'
        : f.gate_decision === 'denied'
          ? 'denied'
          : 'closed';
    let canDecide = false;
    if (subject !== null && waiting) {
      const own = projectRoleOf(subject, f.project);
      canDecide =
        authorize(subject, 'workflows.approve', { project: f.project }).allow &&
        own !== null &&
        roleAtLeast(own, role);
    }
    return {
      engine: 2,
      runId: f.run_id,
      nodeRunId: f.id,
      node: f.node_id,
      nodeType: f.node_type,
      scope: f.scope,
      workflow: f.name,
      project: f.project,
      version: f.version,
      title: texts.title,
      details: texts.details,
      approverRole: role,
      state,
      decidedBy: f.gate_decision === null ? null : (f.decided_by_name ?? null),
      decidedAt: f.gate_decided_at?.toISOString() ?? null,
      createdAt: f.created_at.toISOString(),
      dueAt: waiting ? (f.due_at?.toISOString() ?? null) : null,
      runState: f.run_state,
      untrusted: f.source_trust === 'untrusted',
      canDecide,
    };
  }

  /** One approval step for a caller who may read the run (the route checked `workflows.read`); null: unknown. */
  async approvalView(
    subject: Subject,
    runId: string,
    nodeRunId: string,
  ): Promise<WorkflowApprovalView | null> {
    if (isGateId(nodeRunId)) {
      // p18-last-gaps: an engine-1 gate by its stable id.
      const g = await this.#gateById(this.deps.pool, runId, nodeRunId);
      if (g === null || !authorize(subject, 'workflows.read', { project: g.project }).allow) return null;
      return this.#gateView(g, subject);
    }
    const f = await this.#nodeRun(this.deps.pool, nodeRunId, runId);
    if (f === null || (f.gate_role === null && f.wait_kind !== 'approval')) return null;
    if (!authorize(subject, 'workflows.read', { project: f.project }).allow) return null;
    return this.#view(this.deps.pool, f, subject);
  }

  /** "Senden bekleyen": the waiting workflow approvals this subject may decide, newest first. */
  async pending(subject: Subject): Promise<WorkflowApprovalView[]> {
    if (!authorize(subject, 'workflows.approve').allow) return [];
    const projects = visibleProjects(subject);
    const params: unknown[] = [PENDING_LIMIT];
    let scope = '';
    if (projects !== null) {
      if (projects.length === 0) return [];
      params.push([...projects]);
      scope = 'AND r.project = ANY($2::text[])';
    }
    const { rows } = await this.deps.pool.query<NodeRunFacts>(
      `SELECT ${NODE_RUN_COLS} FROM workflow_node_runs nr JOIN workflow_runs r ON r.id = nr.run_id
        WHERE nr.wait_kind = 'approval' AND nr.gate_decision IS NULL AND nr.gate_role IS NOT NULL ${scope}
        ORDER BY nr.created_at DESC LIMIT $1`,
      params,
    );
    const out: WorkflowApprovalView[] = [];
    for (const f of rows) {
      const v = await this.#view(this.deps.pool, f, subject);
      if (v.canDecide) out.push(v);
    }
    // p18-last-gaps: engine-1 gates the subject may decide, merged newest first.
    const { rows: gates } = await this.deps.pool.query<GateFacts>(
      `SELECT ${GATE_COLS} FROM workflow_nodes n JOIN workflow_runs r ON r.id = n.run_id
        WHERE ${GATE_WAITING} ${scope}
        ORDER BY n.updated_at DESC LIMIT $1`,
      params,
    );
    for (const g of gates) {
      const v = this.#gateView(g, subject);
      if (v.canDecide) out.push(v);
    }
    return out
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, PENDING_LIMIT);
  }

  /**
   * W4 (p17-chat-flow leftover): an approval step was decided or closed — the conversations whose card shows it get a
   * `flow` event (ids and the state word; the card reads the rest through its own route). Returns the conversations told.
   */
  async approvalDecided(nodeRunId: string): Promise<number> {
    if (!isUuid(nodeRunId) || this.deps.event === undefined) return 0;
    const f = await this.#nodeRun(this.deps.pool, nodeRunId);
    if (f === null) return 0;
    const view = await this.#view(this.deps.pool, f, null);
    const { rows } = await this.deps.pool.query<{ thread_id: string }>(
      `SELECT DISTINCT thread_id::text AS thread_id FROM chat_messages
        WHERE meta->>'notice' = 'workflow-approval' AND meta->>'nodeRunId' = $1`,
      [nodeRunId],
    );
    for (const r of rows) {
      try {
        this.deps.event(r.thread_id, {
          kind: 'workflow-approval',
          runId: f.run_id,
          nodeRunId: f.id,
          state: view.state,
        });
      } catch (err) {
        this.deps.log.debug({ err, threadId: r.thread_id }, 'chat flow: stream event failed');
      }
    }
    return rows.length;
  }

  // ----------------------------------------------------------------------------------- engine-1 gates (p18-last-gaps)

  async #gate(db: Queryable, runId: string, nodeId: string): Promise<GateFacts | null> {
    if (!isUuid(runId) || !V1_NODE_ID.test(nodeId)) return null;
    const { rows } = await db.query<GateFacts>(
      `SELECT ${GATE_COLS} FROM workflow_nodes n JOIN workflow_runs r ON r.id = n.run_id
        WHERE n.run_id = $1 AND n.node_id = $2 AND n.gate_role IS NOT NULL`,
      [runId, nodeId],
    );
    return rows[0] ?? null;
  }

  /** The engine-1 gate of `runId` whose {@link gateId} is `id` (a run has a handful of gated steps at most). */
  async #gateById(db: Queryable, runId: string, id: string): Promise<GateFacts | null> {
    if (!isUuid(runId)) return null;
    const { rows } = await db.query<{ node_id: string }>(
      'SELECT node_id FROM workflow_nodes WHERE run_id = $1 AND gate_role IS NOT NULL',
      [runId],
    );
    const hit = rows.find((r) => gateId(runId, r.node_id) === id.toLowerCase());
    return hit === undefined ? null : this.#gate(db, runId, hit.node_id);
  }

  #gateView(g: GateFacts, subject: Subject | null): WorkflowApprovalView {
    const texts = gateTexts(g.def, g.step_title);
    const role: Role = g.gate_role ?? 'admin';
    const waiting = g.state === 'awaiting_approval' && g.gate_decision === null;
    const state: ApprovalState = waiting
      ? 'waiting'
      : g.gate_decision === 'approved'
        ? 'approved'
        : g.gate_decision === 'denied'
          ? 'denied'
          : 'closed';
    let canDecide = false;
    if (subject !== null && waiting) {
      const own = projectRoleOf(subject, g.project);
      canDecide =
        authorize(subject, 'workflows.approve', { project: g.project }).allow &&
        own !== null &&
        roleAtLeast(own, role);
    }
    return {
      engine: 1,
      runId: g.run_id,
      nodeRunId: gateId(g.run_id, g.node_id),
      node: g.node_id,
      nodeType: 'ai.step',
      scope: '',
      workflow: g.name,
      project: g.project,
      version: g.version,
      title: texts.title,
      details: texts.details,
      approverRole: role,
      state,
      decidedBy: g.gate_decision === null ? null : (g.decided_by_name ?? null),
      decidedAt: g.gate_decided_at?.toISOString() ?? null,
      createdAt: g.updated_at.toISOString(),
      dueAt: null,
      runState: g.run_state,
      untrusted: g.source_trust === 'untrusted',
      canDecide,
    };
  }

  /**
   * p18-last-gaps: an engine-1 gate was decided or closed — the conversations whose card shows it get the same `flow`
   * event as an engine-2 step (`nodeRunId` = its {@link gateId}, plus `engine: 1` and the node). Returns the
   * conversations told.
   */
  async gateDecided(runId: string, nodeId: string): Promise<number> {
    if (this.deps.event === undefined) return 0;
    const g = await this.#gate(this.deps.pool, runId, nodeId);
    if (g === null) return 0;
    const view = this.#gateView(g, null);
    const { rows } = await this.deps.pool.query<{ thread_id: string }>(
      `SELECT DISTINCT thread_id::text AS thread_id FROM chat_messages
        WHERE meta->>'notice' = 'workflow-approval' AND meta->>'nodeRunId' = $1`,
      [view.nodeRunId],
    );
    for (const r of rows) {
      try {
        this.deps.event(r.thread_id, {
          kind: 'workflow-approval',
          engine: 1,
          runId: g.run_id,
          nodeRunId: view.nodeRunId,
          node: g.node_id,
          state: view.state,
        });
      } catch (err) {
        this.deps.log.debug({ err, threadId: r.thread_id }, 'chat flow: stream event failed');
      }
    }
    return rows.length;
  }

  /** Posts one waiting engine-1 gate into its conversations and notifies who may decide it (once). */
  async #announceGate(runId: string, nodeId: string): Promise<boolean> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, gateEventKey('gate', runId, nodeId)))) return false;
      const g = await this.#gate(tx, runId, nodeId);
      if (g === null || g.state !== 'awaiting_approval' || g.gate_decision !== null) return true;
      const view = this.#gateView(g, null);
      for (const link of await this.linksOfRun(tx, g.run_id, { created: true })) {
        const subject = await this.#activeSubject(tx, link.userId);
        if (subject === null || !authorize(subject, 'workflows.read', { project: g.project }).allow) continue;
        const lang = await this.#language(tx, link.userId, link.threadId);
        const what = `${mdText(g.name)} · ${mdText(g.node_id)}`;
        const title = view.title === null ? '' : ` — ${mdText(view.title)}`;
        const message = await this.deps.store.addMessage(
          link.threadId,
          {
            role: 'assistant',
            content:
              lang === 'tr'
                ? `**Onay bekleniyor:** workflow ${what}${title}`
                : `**Approval needed:** workflow ${what}${title}`,
            meta: {
              notice: 'workflow-approval',
              engine: 1,
              runId: g.run_id,
              nodeRunId: view.nodeRunId,
              node: g.node_id,
              workflow: g.name,
              project: g.project,
              ...(await this.planItemOf(tx, link.threadId, {
                runIds: [g.run_id, ...(g.parent_run_id === null ? [] : [g.parent_run_id])],
              })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
      const svc = this.deps.notifications();
      if (svc !== null) {
        const recipients = await projectRecipients(tx, g.project, view.approverRole);
        await svc.notify(tx, recipients, {
          kind: 'workflow.approval',
          severity: 'warning',
          title: plainLine(`Approval needed: workflow ${g.name}`, 200),
          body: plainLine(
            `Step “${g.node_id}” of workflow “${g.name}” (${g.project}) waits for a decision (${view.approverRole} or above). Decide it on the run page, in Senden bekleyen or in the conversation that started it.`,
            1000,
          ),
          link: `/jobs/workflows/${encodeURIComponent(g.run_id)}`,
          dedupeKey: `workflow.approval:${view.nodeRunId}`,
        });
      }
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat-flow' },
          action: 'chat.flow.approval',
          target: `workflow-run:${g.run_id}`,
          outcome: 'success',
          metadata: { node: g.node_id, engine: 1, project: g.project, threads: posted.length },
        },
        tx,
      );
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  /** Posts one waiting approval into its conversations and notifies who may decide it (once). */
  async #announceApproval(nodeRunId: string): Promise<boolean> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, eventKey('approval', nodeRunId)))) return false;
      const f = await this.#nodeRun(tx, nodeRunId);
      if (f === null || f.state !== 'waiting' || f.wait_kind !== 'approval' || f.gate_decision !== null)
        return true;
      const view = await this.#view(tx, f, null);
      for (const link of await this.linksOfRun(tx, f.run_id, { created: true })) {
        const subject = await this.#activeSubject(tx, link.userId);
        if (subject === null || !authorize(subject, 'workflows.read', { project: f.project }).allow) continue;
        const lang = await this.#language(tx, link.userId, link.threadId);
        const what = `${mdText(f.name)} · ${mdText(f.node_id)}`;
        const title = view.title === null ? '' : ` — ${mdText(view.title)}`;
        const message = await this.deps.store.addMessage(
          link.threadId,
          {
            role: 'assistant',
            content:
              lang === 'tr'
                ? `**Onay bekleniyor:** workflow ${what}${title}`
                : `**Approval needed:** workflow ${what}${title}`,
            meta: {
              notice: 'workflow-approval',
              runId: f.run_id,
              nodeRunId: f.id,
              node: f.node_id,
              workflow: f.name,
              project: f.project,
              ...(await this.planItemOf(tx, link.threadId, {
                runIds: [f.run_id, ...(f.parent_run_id === null ? [] : [f.parent_run_id])],
              })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
      const svc = this.deps.notifications();
      if (svc !== null) {
        const recipients = await projectRecipients(tx, f.project, view.approverRole);
        await svc.notify(tx, recipients, {
          kind: 'workflow.approval',
          severity: 'warning',
          title: plainLine(`Approval needed: workflow ${f.name}`, 200),
          body: plainLine(
            `Step “${f.node_id}” of workflow “${f.name}” (${f.project}) waits for a decision (${view.approverRole} or above). Decide it on the run page, in Senden bekleyen or in the conversation that started it.`,
            1000,
          ),
          link: `/jobs/workflows/${encodeURIComponent(f.run_id)}`,
          dedupeKey: `workflow.approval:${f.id}`,
        });
      }
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat-flow' },
          action: 'chat.flow.approval',
          target: `workflow-run:${f.run_id}`,
          outcome: 'success',
          metadata: { node: f.node_id, nodeRunId: f.id, project: f.project, threads: posted.length },
        },
        tx,
      );
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  // --------------------------------------------------------------------------------------------- results

  /** Posts a finished run's result card into the conversations whose card started it (and whose watch does not). */
  async #announceResult(runId: string): Promise<boolean> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, eventKey('result', runId)))) return false;
      const result = await workflowRunResult(tx, runId);
      if (result === null) return true;
      // Conversations whose card started the run, unless their own watch tells it: an active watch that fires on
      // this outcome (its end note carries the card), or a watch note with this run's result already there.
      // p20-quick: a cancelled / expired watch, or one that does not fire on this outcome, no
      // longer swallows the result card.
      // p20-outcome: a watch that already fired (delivered its note) counts too.
      const { rows } = await tx.query<{ thread_id: string; user_id: string }>(
        `SELECT DISTINCT ON (d.thread_id) d.thread_id::text AS thread_id, d.user_id::text AS user_id
           FROM chat_drafts d JOIN chat_threads t ON t.id = d.thread_id AND t.user_id = d.user_id
          WHERE d.kind = 'workflow_run' AND d.state = 'confirmed' AND d.result->>'runId' = $1
            AND t.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM chat_watches w WHERE w.user_id = d.user_id
                              AND w.thread_id = d.thread_id
                              AND (w.state = 'active' OR (w.state = 'done' AND w.end_reason IN ('fired', 'attention')))
                              AND ((w.target_kind = 'workflow_run' AND w.target_uuid::text = $1)
                                   OR (w.target_kind = 'draft' AND w.target_uuid = d.id))
                              AND (w.conditions && ARRAY['finished', $2]::text[]))
            AND NOT EXISTS (SELECT 1 FROM chat_messages m
                             WHERE m.thread_id = d.thread_id AND m.role = 'assistant'
                               AND m.meta ->> 'notice' = 'chat-watch'
                               AND m.meta -> 'workflowResult' ->> 'runId' = $1)
          ORDER BY d.thread_id, d.created_at`,
        [runId, result.state],
      );
      for (const link of rows) {
        const subject = await this.#activeSubject(tx, link.user_id);
        if (subject === null || !authorize(subject, 'workflows.read', { project: result.project }).allow)
          continue;
        const lang = await this.#language(tx, link.user_id, link.thread_id);
        const message = await this.deps.store.addMessage(
          link.thread_id,
          {
            role: 'assistant',
            content: resultText(result, lang),
            meta: {
              ...resultNoteMeta(result),
              ...(await this.planItemOf(tx, link.thread_id, { runIds: [runId] })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.thread_id, message });
      }
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  // ----------------------------------------------------------------------------------------- job results

  /**
   * p18-outputs-delivery: posts a job's outcome (its terminal transition `transitionId`) into the conversations whose
   * confirmed card started it — once (the claim), skipping a conversation whose own watch on the job tells it (an
   * active watch that fires on this outcome, or its end note already there).
   */
  async #announceJob(jobId: string, transitionId: string): Promise<boolean> {
    if (!isUuid(jobId) || !/^\d{1,19}$/.test(transitionId)) return false;
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, jobEventKey(jobId, transitionId)))) return false;
      const { rows } = await tx.query<{
        project: string;
        state: JobEnd['state'];
        from_state: string | null;
        trigger: string;
        reason: string | null;
        occurred_at: Date;
        attempts: number;
        title: string;
        summary: string | null;
        last: string;
        timed_out: boolean;
      }>(
        `SELECT j.project, j.state::text AS state, t.from_state::text AS from_state, t.trigger, t.reason, t.occurred_at,
                ${TIMED_OUT_SQL('j')} AS timed_out,
                (SELECT count(*)::int FROM job_attempts a WHERE a.job_id = j.id) AS attempts,
                COALESCE(jt.title, s.title, j.spec ->> 'title', left(j.spec ->> 'prompt', 200), '') AS title,
                (SELECT r.result ->> 'summary' FROM job_runs r WHERE r.job_id = j.id
                  ORDER BY r.created_at DESC, r.attempt_id DESC LIMIT 1) AS summary,
                (SELECT max(x.id) FROM job_transitions x WHERE x.job_id = j.id)::text AS last
           FROM jobs j JOIN job_transitions t ON t.job_id = j.id AND t.id = $2
           LEFT JOIN job_titles jt ON jt.job_id = j.id LEFT JOIN job_subtasks s ON s.child_job_id = j.id
          WHERE j.id = $1`,
        [jobId, transitionId],
      );
      const job = rows[0];
      // Moved on since the scan (a resume, a reconciliation): its next end gets its own card.
      if (job === undefined || job.last !== transitionId) return true;
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST'].includes(job.state)) return true;
      const end: JobEnd = {
        jobId,
        transitionId,
        state: job.state,
        fromState: job.from_state,
        trigger: job.trigger,
        attempts: job.attempts,
        reason: job.reason,
        // p20-job-clock: it stopped on its time limit — the card offers "Aynı yerden devam et".
        timedOut: job.timed_out,
        // p22-timeout-continuity: what its worker kept of the work when the time ran out.
        kept: job.timed_out ? ((await keptWorkOf(tx, [jobId])).get(jobId) ?? null) : null,
        // p22-run-attention: "succeeded, but I could not do it" (the agent's OUTCOME: line).
        attention: job.state === 'SUCCEEDED' ? parseStepOutcome(job.summary ?? '') : null,
      };
      const outcome = outcomeOf(end.state);
      const { rows: links } = await tx.query<{ thread_id: string; user_id: string }>(
        `SELECT DISTINCT ON (d.thread_id) d.thread_id::text AS thread_id, d.user_id::text AS user_id
           FROM chat_drafts d
           CROSS JOIN LATERAL (${STARTED_JOBS_SQL}) s
           JOIN chat_threads t ON t.id = d.thread_id AND t.user_id = d.user_id
          WHERE d.state = 'confirmed' AND s.job_id = $1::uuid AND t.archived_at IS NULL
            AND d.kind IN (${JOB_CARD_KINDS})
            AND NOT EXISTS (
              SELECT 1 FROM chat_watches w
               WHERE w.user_id = d.user_id AND w.thread_id = d.thread_id AND w.state = 'active'
                 AND ((w.target_kind = 'job' AND w.target_uuid = $1::uuid)
                      OR (w.target_kind = 'draft' AND w.target_uuid = d.id))
                 AND (w.conditions && ARRAY['finished', $2]::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM chat_messages m
               WHERE m.thread_id = d.thread_id AND m.created_at >= $3 AND m.role = 'assistant'
                 AND m.meta ->> 'jobId' = $1::text AND m.meta ->> 'notice' IN ('chat-watch', 'job-result'))
          ORDER BY d.thread_id, d.created_at`,
        [jobId, outcome, job.occurred_at],
      );
      if (links.length === 0) return true;
      const report = await (this.deps.outputReport?.(jobId) ?? Promise.resolve(null)).catch(() => null);
      const summary = (job.summary ?? '').trim().slice(0, JOB_SUMMARY_MAX);
      const svc = this.deps.notifications();
      for (const link of links) {
        const subject = await this.#activeSubject(tx, link.user_id);
        if (subject === null || !authorize(subject, 'jobs.read', { project: job.project }).allow) continue;
        const lang = await this.#language(tx, link.user_id, link.thread_id);
        const message = await this.deps.store.addMessage(
          link.thread_id,
          {
            role: 'assistant',
            content: jobResultText(end, job.title, report, lang),
            meta: {
              notice: 'job-result',
              jobId,
              jobOutcome: outcome,
              jobState: end.state,
              jobSummary: summary === '' ? null : summary,
              ...(end.timedOut === true ? { jobTimedOut: true } : {}),
              ...(end.attention == null ? {} : { jobAttention: end.attention }),
              ...(end.kept == null
                ? {}
                : {
                    jobKept: {
                      branch: end.kept.branch,
                      files: end.kept.files,
                      pushed: end.kept.pushed,
                      workerId: end.kept.pushed ? null : (end.kept.workerId ?? null),
                    },
                  }),
              link: `/jobs/${jobId}`,
              ...(report?.zip == null
                ? {}
                : { jobZipped: { name: report.zip.name, files: report.zip.files } }),
              ...(await this.planItemOf(tx, link.thread_id, { jobIds: [jobId] })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.thread_id, message });
        if (svc !== null) {
          const note = jobResultNotification(end, job.title, report, lang);
          await svc.notify(tx, [link.user_id], {
            kind: 'chat.watch',
            severity: note.severity,
            title: note.title,
            body: note.body,
            link: `/chat/${link.thread_id}`,
            dedupeKey: `chat.flow.job:${jobId}:${transitionId}:${link.thread_id}`,
          });
        }
      }
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat-flow' },
          action: 'chat.flow.job_result',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: { state: end.state, trigger: end.trigger, project: job.project, threads: posted.length },
        },
        tx,
      );
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  /**
   * p19-job-waits: a job that waits for a person must still be reported, or the conversation never hears about it. A
   * job a confirmed card of a conversation started waits for a person — its work is done and the merge needs an
   * approval, or a command is gated. Nothing ends, so no result card comes; the conversation gets one note per request
   * with a link to it (skipped where the conversation's own watch on the job reports approvals).
   */
  async #announceJobWait(approvalId: string): Promise<boolean> {
    if (!isUuid(approvalId)) return false;
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, eventKey('jobwait', approvalId)))) return false;
      const { rows } = await tx.query<{
        job_id: string;
        project: string;
        action: string;
        summary: string;
        details: unknown;
        created_at: Date;
        title: string;
      }>(
        `SELECT j.id::text AS job_id, j.project, a.action, a.summary, a.details, a.created_at,
                COALESCE(jt.title, s.title, j.spec ->> 'title', left(j.spec ->> 'prompt', 200), '') AS title
           FROM approval_requests a JOIN jobs j ON j.id = a.job_id
           LEFT JOIN job_titles jt ON jt.job_id = j.id LEFT JOIN job_subtasks s ON s.child_job_id = j.id
          WHERE a.id = $1 AND a.status = 'pending'`,
        [approvalId],
      );
      const wait = rows[0];
      if (wait === undefined) return true;
      const { rows: links } = await tx.query<{ thread_id: string; user_id: string }>(
        `SELECT DISTINCT ON (d.thread_id) d.thread_id::text AS thread_id, d.user_id::text AS user_id
           FROM chat_drafts d
           CROSS JOIN LATERAL (${STARTED_JOBS_SQL}) s
           JOIN chat_threads t ON t.id = d.thread_id AND t.user_id = d.user_id
          WHERE d.state = 'confirmed' AND s.job_id = $1::uuid AND t.archived_at IS NULL
            AND d.kind IN (${JOB_CARD_KINDS})
            AND NOT EXISTS (
              SELECT 1 FROM chat_watches w
               WHERE w.user_id = d.user_id AND w.thread_id = d.thread_id AND w.state = 'active'
                 AND ((w.target_kind = 'job' AND w.target_uuid = $1::uuid)
                      OR (w.target_kind = 'draft' AND w.target_uuid = d.id))
                 AND 'approval_requested' = ANY (w.conditions))
          ORDER BY d.thread_id, d.created_at`,
        [wait.job_id],
      );
      if (links.length === 0) return true;
      const svc = this.deps.notifications();
      const link = `/approvals/${approvalId}`;
      const merge = wait.action === 'git.merge';
      const title = plainLine(wait.title, 120);
      const head = detailsView(storedDetails(wait.details), wait.summary).headline;
      for (const l of links) {
        const subject = await this.#activeSubject(tx, l.user_id);
        if (subject === null || !authorize(subject, 'jobs.read', { project: wait.project }).allow) continue;
        const lang = await this.#language(tx, l.user_id, l.thread_id);
        const tr = lang === 'tr';
        const named = title === '' ? (tr ? 'İş' : 'The job') : `“${mdText(title)}”`;
        const about =
          merge || head.source === 'summary'
            ? ''
            : head.source === 'agent'
              ? tr
                ? ` Ajanın açıklaması (doğrulanmadı): “${mdText(head.text)}”`
                : ` The agent says (unverified): “${mdText(head.text)}”`
              : tr
                ? ` Komut: ${mdText(head.text)}`
                : ` Command: ${mdText(head.text)}`;
        const content = merge
          ? tr
            ? `**İş bitti, birleştirme onayını bekliyor:** ${named} işini tamamladı; değişiklikler senin onayınla birleşir. [Onayı aç](${link})`
            : `**Work done, waiting for the merge approval:** ${named} finished its work; the changes merge once you approve. [Open the approval](${link})`
          : tr
            ? `**Onay bekleniyor:** ${named} bir onay istiyor (${mdText(wait.action)}).${about} [Onayı aç](${link})`
            : `**Approval needed:** ${named} asks for an approval (${mdText(wait.action)}).${about} [Open the approval](${link})`;
        const message = await this.deps.store.addMessage(
          l.thread_id,
          {
            role: 'assistant',
            content,
            meta: {
              notice: 'job-approval',
              jobId: wait.job_id,
              approvalId,
              link,
              ...(await this.planItemOf(tx, l.thread_id, { jobIds: [wait.job_id] })),
            },
          },
          tx,
        );
        posted.push({ threadId: l.thread_id, message });
        if (svc !== null) {
          const short = title === '' ? wait.job_id.slice(0, 8) : plainLine(title, 80);
          await svc.notify(tx, [l.user_id], {
            kind: 'chat.watch',
            severity: 'warning',
            title: merge
              ? tr
                ? `Birleştirme onayı bekleniyor: ${short}`
                : `Merge approval needed: ${short}`
              : tr
                ? `Onay bekleniyor: ${short}`
                : `Approval needed: ${short}`,
            body: tr ? `${short} işi senin onayını bekliyor.` : `${short} is waiting for your approval.`,
            link: `/chat/${l.thread_id}`,
            dedupeKey: `chat.flow.jobwait:${approvalId}:${l.thread_id}`,
          });
        }
      }
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat-flow' },
          action: 'chat.flow.job_wait',
          target: `job:${wait.job_id}`,
          outcome: 'success',
          metadata: { approvalId, action: wait.action, project: wait.project, threads: posted.length },
        },
        tx,
      );
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  // ------------------------------------------------------------------------------------- job replies

  /**
   * p19-job-replies: the person must learn that a job answered without watching the job. A message the conversation
   * sent to a running job (a confirmed `job_message` card) gets the agent's first answer back as a note — once
   * (`reply:<draft>`).
   * The answer is the first assistant message event after the agent took the message (its user-role event, else after
   * the message was delivered). A job that ends first gets its result card instead (nothing posted here).
   */
  async #announceReplies(since: Date): Promise<number> {
    const { rows } = await this.deps.pool.query<{
      draft_id: string;
      thread_id: string;
      user_id: string;
      job_id: string;
      project: string;
      title: string;
      reply: string;
      reply_id: string;
    }>(
      `SELECT d.id::text AS draft_id, d.thread_id::text AS thread_id, d.user_id::text AS user_id,
              m.job_id::text AS job_id, j.project,
              COALESCE(jt.title, j.spec ->> 'title', left(j.spec ->> 'prompt', 200), '') AS title,
              r.payload ->> 'text' AS reply, r.id::text AS reply_id
         FROM chat_drafts d
         JOIN chat_threads t ON t.id = d.thread_id AND t.user_id = d.user_id AND t.archived_at IS NULL
         JOIN job_messages m ON m.id = (CASE WHEN d.result ->> 'messageId' ~* ${UUID_RE}
                                             THEN (d.result ->> 'messageId')::uuid END)
         JOIN jobs j ON j.id = m.job_id
         LEFT JOIN job_titles jt ON jt.job_id = j.id
         CROSS JOIN LATERAL (
           SELECT e.id FROM job_events e
            WHERE e.job_id = m.job_id AND e.kind = 'message' AND e.payload ->> 'role' = 'user'
              AND e.received_at >= m.created_at
            ORDER BY e.id LIMIT 1) took
         CROSS JOIN LATERAL (
           SELECT e.id, e.payload FROM job_events e
            WHERE e.job_id = m.job_id AND e.kind = 'message' AND e.payload ->> 'role' = 'assistant'
              AND e.id > took.id AND coalesce(e.payload ->> 'text', '') <> ''
            ORDER BY e.id LIMIT 1) r
        WHERE d.kind = 'job_message' AND d.state = 'confirmed' AND d.decided_at >= $1
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events f WHERE f.key = 'reply:' || d.id::text)
        LIMIT ${String(BATCH)}`,
      [since],
    );
    let n = 0;
    for (const r of rows) {
      try {
        const posted = await withTransaction(this.deps.pool, async (tx) => {
          if (!(await this.#claim(tx, eventKey('reply', r.draft_id)))) return null;
          const subject = await this.#activeSubject(tx, r.user_id);
          if (subject === null || !authorize(subject, 'jobs.read', { project: r.project }).allow) return null;
          const lang = await this.#language(tx, r.user_id, r.thread_id);
          const title = plainLine(r.title, 120);
          const answer = r.reply.trim().slice(0, REPLY_MAX);
          const more = r.reply.trim().length > REPLY_MAX ? '…' : '';
          const head = lang === 'tr' ? 'İşin ajanı cevap verdi' : 'The job’s agent answered';
          const message = await this.deps.store.addMessage(
            r.thread_id,
            {
              role: 'assistant',
              content: `**${head}:** ${mdText(title)}\n\n> ${mdText(plainLine(answer, REPLY_MAX))}${more}`,
              meta: {
                notice: 'job-reply',
                jobId: r.job_id,
                eventId: r.reply_id,
                link: `/jobs/${r.job_id}`,
                ...(await this.planItemOf(tx, r.thread_id, { jobIds: [r.job_id] })),
              },
            },
            tx,
          );
          const svc = this.deps.notifications();
          if (svc !== null) {
            await svc.notify(tx, [r.user_id], {
              kind: 'chat.watch',
              severity: 'info',
              title: plainLine(`${head}: ${title}`, 200),
              body: plainLine(answer, 300),
              link: `/chat/${r.thread_id}`,
              dedupeKey: `chat.flow.reply:${r.draft_id}`,
            });
          }
          return { threadId: r.thread_id, message };
        });
        if (posted !== null) {
          this.#publish(posted.threadId, posted.message);
          n++;
        }
      } catch (err) {
        this.deps.log.error({ err, draftId: r.draft_id }, 'chat flow: job reply announcement failed');
      }
    }
    return n;
  }

  // --------------------------------------------------------------------------------- scheduled results (W4)

  async #scheduledResults(since: Date): Promise<number> {
    let n = 0;
    const { rows: runs } = await this.deps.pool.query<{ id: string }>(
      `SELECT r.id::text AS id FROM workflow_runs r
        WHERE r.trigger_kind = 'schedule' AND r.parent_run_id IS NULL
          AND r.state IN ('succeeded', 'failed', 'cancelled') AND r.ended_at >= $1
          AND EXISTS (SELECT 1 FROM chat_drafts d WHERE d.kind = 'workflow' AND d.state = 'confirmed'
                        AND d.project = r.project AND d.payload->>'name' = r.name)
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'result:' || r.id::text)
        ORDER BY r.ended_at LIMIT ${String(BATCH)}`,
      [since],
    );
    for (const r of runs) {
      try {
        if (await this.#announceScheduledRun(r.id)) n++;
      } catch (err) {
        this.deps.log.error({ err, runId: r.id }, 'chat flow: scheduled run result failed');
      }
    }
    const { rows: autos } = await this.deps.pool.query<{ id: string }>(
      `SELECT ar.id::text AS id FROM automation_runs ar
        WHERE ar.trigger_kind IN ('cron', 'at') AND ar.state IN ('succeeded', 'failed', 'cancelled', 'error')
          AND ar.finished_at >= $1
          AND EXISTS (SELECT 1 FROM chat_drafts d WHERE d.kind = 'automation' AND d.state = 'confirmed'
                        AND d.payload->>'action' = 'create'
                        AND d.project = ar.project AND d.result->>'automationId' = ar.automation_id::text)
          AND NOT EXISTS (SELECT 1 FROM chat_flow_events e WHERE e.key = 'sched:' || ar.id::text)
        ORDER BY ar.finished_at LIMIT ${String(BATCH)}`,
      [since],
    );
    for (const a of autos) {
      try {
        if (await this.#announceAutomationRun(a.id)) n++;
      } catch (err) {
        this.deps.log.error({ err, automationRunId: a.id }, 'chat flow: scheduled automation result failed');
      }
    }
    return n;
  }

  /**
   * The conversations a scheduled result goes to: the owners' own, not archived, not muted for `target`, whose owner may
   * still read it (`action` in the project), and — for a success — without a success of the same target in the last
   * hour (a frequent schedule does not flood the conversation; failures always arrive).
   */
  async #scheduledLinks(
    tx: Queryable,
    created: string,
    params: unknown[],
    target: string,
    project: string,
    action: 'workflows.read' | 'automations.read',
    success: boolean,
  ): Promise<Link[]> {
    const { rows } = await tx.query<{ thread_id: string; user_id: string }>(
      `SELECT DISTINCT ON (d.thread_id) d.thread_id::text AS thread_id, d.user_id::text AS user_id
         FROM chat_drafts d JOIN chat_threads t ON t.id = d.thread_id AND t.user_id = d.user_id
        WHERE ${created} AND d.state = 'confirmed' AND t.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_result_mutes x WHERE x.thread_id = d.thread_id AND x.target = $${String(params.length + 1)})
          AND NOT ($${String(params.length + 2)}::boolean AND EXISTS (
                SELECT 1 FROM chat_messages m WHERE m.thread_id = d.thread_id AND m.created_at >= $${String(params.length + 3)}
                   AND m.meta->'scheduled'->>'target' = $${String(params.length + 1)}
                   AND m.meta->'scheduled'->>'outcome' = 'succeeded'))
        ORDER BY d.thread_id, d.created_at`,
      [...params, target, success, new Date(this.#now().getTime() - SCHEDULED_QUIET_MS)],
    );
    const out: Link[] = [];
    for (const r of rows) {
      const subject = await this.#activeSubject(tx, r.user_id);
      if (subject === null || !authorize(subject, action, { project }).allow) continue;
      out.push({ threadId: r.thread_id, userId: r.user_id });
    }
    return out;
  }

  /** A scheduled run of a workflow a conversation created: its result card there (once: `result:<run id>`). */
  async #announceScheduledRun(runId: string): Promise<boolean> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, eventKey('result', runId)))) return false;
      const result = await workflowRunResult(tx, runId);
      if (result === null) return true;
      const target = `workflow:${result.project}/${result.workflow}`;
      const links = await this.#scheduledLinks(
        tx,
        `d.kind = 'workflow' AND d.project = $1 AND d.payload->>'name' = $2`,
        [result.project, result.workflow],
        target,
        result.project,
        'workflows.read',
        result.state === 'succeeded',
      );
      for (const link of links) {
        const lang = await this.#language(tx, link.userId, link.threadId);
        const message = await this.deps.store.addMessage(
          link.threadId,
          {
            role: 'assistant',
            content: `${lang === 'tr' ? '_Zamanlanmış çalışma_ · ' : '_Scheduled run_ · '}${resultText(result, lang)}`,
            meta: {
              ...resultNoteMeta(result),
              scheduled: { target, label: result.workflow, kind: 'workflow', outcome: result.state },
            },
          },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
      if (posted.length > 0)
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'chat-flow' },
            action: 'chat.flow.scheduled_result',
            target: `workflow-run:${runId}`,
            outcome: 'success',
            metadata: { project: result.project, state: result.state, threads: posted.length },
          },
          tx,
        );
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  /**
   * A scheduled run of an automation a conversation created: its job's result card, its workflow run's result card, or
   * (it never started a job / run) a plain line with the reason — once (`sched:<automation run id>`).
   */
  async #announceAutomationRun(automationRunId: string): Promise<boolean> {
    const posted: { threadId: string; message: MessageView }[] = [];
    const done = await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, eventKey('sched', automationRunId)))) return false;
      const { rows } = await tx.query<{
        automation_id: string;
        name: string;
        project: string;
        state: string;
        reason: string | null;
        job_id: string | null;
        job_state: string | null;
        workflow_run_id: string | null;
      }>(
        `SELECT ar.automation_id::text AS automation_id, a.name, ar.project, ar.state, ar.reason,
                ar.job_id::text AS job_id, j.state::text AS job_state, ar.workflow_run_id::text AS workflow_run_id
           FROM automation_runs ar JOIN automations a ON a.id = ar.automation_id
           LEFT JOIN jobs j ON j.id = ar.job_id
          WHERE ar.id = $1`,
        [automationRunId],
      );
      const run = rows[0];
      if (run === undefined) return true;
      // A workflow run of the automation is announced once, whichever path sees it first.
      if (run.workflow_run_id !== null && !(await this.#claim(tx, eventKey('result', run.workflow_run_id))))
        return true;
      const result = run.workflow_run_id === null ? null : await workflowRunResult(tx, run.workflow_run_id);
      const outcome: 'succeeded' | 'failed' | 'cancelled' =
        result !== null
          ? result.state
          : run.state === 'succeeded'
            ? 'succeeded'
            : run.state === 'cancelled'
              ? 'cancelled'
              : 'failed';
      const target = `automation:${run.automation_id}`;
      const links = await this.#scheduledLinks(
        tx,
        `d.kind = 'automation' AND d.payload->>'action' = 'create' AND d.project = $1
          AND d.result->>'automationId' = $2`,
        [run.project, run.automation_id],
        target,
        run.project,
        'automations.read',
        outcome === 'succeeded',
      );
      for (const link of links) {
        const lang = await this.#language(tx, link.userId, link.threadId);
        const head =
          lang === 'tr'
            ? `_Zamanlanmış otomasyon_ · ${mdText(run.name)}`
            : `_Scheduled automation_ · ${mdText(run.name)}`;
        const scheduled = { target, label: run.name, kind: 'automation', outcome };
        const word = STATE_WORD[lang][outcome];
        const meta: Record<string, unknown> =
          result !== null
            ? { ...resultNoteMeta(result), scheduled }
            : run.job_id !== null
              ? {
                  notice: 'job-result',
                  jobId: run.job_id,
                  jobOutcome: outcome,
                  jobState: run.job_state,
                  jobSummary: null,
                  link: `/jobs/${run.job_id}`,
                  scheduled,
                }
              : { notice: 'automation-result', automationId: run.automation_id, scheduled };
        const content =
          result !== null
            ? `${head} · ${resultText(result, lang)}`
            : run.job_id !== null
              ? `${head}: ${lang === 'tr' ? 'iş' : 'job'} ${run.job_id.slice(0, 8)} ${word}`
              : `${head}: ${word}${run.reason === null ? '' : ` — ${mdText(plainLine(run.reason, 300))}`}`;
        const message = await this.deps.store.addMessage(
          link.threadId,
          { role: 'assistant', content, meta },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
      if (posted.length > 0)
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'chat-flow' },
            action: 'chat.flow.scheduled_result',
            target: `automation:${run.automation_id}`,
            outcome: 'success',
            metadata: { project: run.project, state: outcome, run: automationRunId, threads: posted.length },
          },
          tx,
        );
      return true;
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return done;
  }

  /** "Bu sohbete sonuç gönderme" — the owner mutes (or unmutes) one automation's / workflow's scheduled results here. */
  async setResultMute(userId: string, threadId: string, target: string, muted: boolean): Promise<void> {
    if (!/^(automation:[0-9a-f-]{36}|workflow:[A-Za-z0-9_.:-]{1,128}\/.{1,200})$/.test(target))
      throw new HttpError(400, 'bad_request', 'The request is invalid.');
    await this.deps.store.thread(userId, threadId);
    if (muted)
      await this.deps.pool.query(
        `INSERT INTO chat_result_mutes (thread_id, target, user_id, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (thread_id, target) DO NOTHING`,
        [threadId, target, userId, this.#now()],
      );
    else
      await this.deps.pool.query('DELETE FROM chat_result_mutes WHERE thread_id = $1 AND target = $2', [
        threadId,
        target,
      ]);
    await this.deps.audit.record({
      actor: { type: 'user', id: userId },
      action: muted ? 'chat.flow.results_muted' : 'chat.flow.results_unmuted',
      target: `chat-thread:${threadId}`,
      outcome: 'success',
      metadata: { target },
    });
  }

  /** The targets whose scheduled results are muted in a conversation (its owner). */
  async resultMutes(userId: string, threadId: string): Promise<string[]> {
    await this.deps.store.thread(userId, threadId);
    const { rows } = await this.deps.pool.query<{ target: string }>(
      'SELECT target FROM chat_result_mutes WHERE thread_id = $1 ORDER BY created_at',
      [threadId],
    );
    return rows.map((r) => r.target);
  }

  // ------------------------------------------------------------------------------------------- questions

  /**
   * A job's agent asked a question: a card message in each conversation linked to the job (once per question). The
   * question stays the job's; the conversation's owner sees it only while they may read the job.
   */
  async jobQuestionAsked(jobId: string, questionId: string): Promise<number> {
    if (!isUuid(jobId) || !isUuid(questionId)) return 0;
    const posted: { threadId: string; message: MessageView }[] = [];
    await withTransaction(this.deps.pool, async (tx) => {
      if (!(await this.#claim(tx, eventKey('question', questionId)))) return;
      const { rows } = await tx.query<{ project: string; title: string | null }>(
        `SELECT j.project, COALESCE(jt.title, s.title) AS title FROM jobs j
           LEFT JOIN job_titles jt ON jt.job_id = j.id LEFT JOIN job_subtasks s ON s.child_job_id = j.id
          WHERE j.id = $1`,
        [jobId],
      );
      const job = rows[0];
      if (job === undefined) return;
      for (const link of await this.linksOfJob(tx, jobId)) {
        const subject = await this.#activeSubject(tx, link.userId);
        if (subject === null || !authorize(subject, 'jobs.read', { project: job.project }).allow) continue;
        const lang = await this.#language(tx, link.userId, link.threadId);
        const label = `${jobId.slice(0, 8)}${job.title === null ? '' : ` · ${mdText(plainLine(job.title, 80))}`}`;
        const message = await this.deps.store.addMessage(
          link.threadId,
          {
            role: 'assistant',
            content:
              lang === 'tr'
                ? `**İşin ajanı bir soru soruyor:** iş ${label}`
                : `**The job's agent asks a question:** job ${label}`,
            meta: {
              notice: 'job-question',
              questionId,
              jobId,
              link: `/jobs/${jobId}`,
              ...(await this.planItemOf(tx, link.threadId, { jobIds: [jobId] })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return posted.length;
  }

  // ------------------------------------------------------------------------------------------- job time

  /**
   * p20-job-clock: a job's time is running out — a note in each conversation linked to the job (its confirmed card,
   * an active watch), with the remaining time, the limit, whether it progressed lately and quick extensions (the console
   * draws "+30 dk" / "+1 saat" from `meta.jobTimeWarning`). The caller claims it once per attempt and limit.
   */
  async jobTimeWarning(f: TimeWarningFacts): Promise<number> {
    if (!isUuid(f.jobId)) return 0;
    const posted: { threadId: string; message: MessageView }[] = [];
    await withTransaction(this.deps.pool, async (tx) => {
      for (const link of await this.linksOfJob(tx, f.jobId)) {
        const subject = await this.#activeSubject(tx, link.userId);
        if (subject === null || !authorize(subject, 'jobs.read', { project: f.project }).allow) continue;
        const lang = await this.#language(tx, link.userId, link.threadId);
        const label = `${f.jobId.slice(0, 8)}${f.title === '' ? '' : ` · ${mdText(plainLine(f.title, 80))}`}`;
        const message = await this.deps.store.addMessage(
          link.threadId,
          {
            role: 'assistant',
            content: jobTimeWarningText(f, label, lang),
            meta: {
              notice: 'job-time-warning',
              jobId: f.jobId,
              link: `/jobs/${f.jobId}`,
              jobTimeWarning: {
                remainingSec: f.remainingSec,
                limitSec: f.limitSec,
                maxAllowedSec: f.maxAllowedSec,
                progressing: f.progressing,
                waiting: f.waiting,
              },
              ...(await this.planItemOf(tx, link.threadId, { jobIds: [f.jobId] })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return posted.length;
  }

  /**
   * p22-timeout-continuity (security policy `autonomy.autoExtendTime`): the platform extended a progressing job at its
   * time warning — a note in each conversation linked to the job ("süreyi otomatik uzattım: +X dk"). The caller extends
   * once per attempt and limit (the warning claim), so the note is posted once per extension.
   */
  async jobTimeAutoExtended(f: AutoExtendFacts): Promise<number> {
    if (!isUuid(f.jobId)) return 0;
    const posted: { threadId: string; message: MessageView }[] = [];
    await withTransaction(this.deps.pool, async (tx) => {
      for (const link of await this.linksOfJob(tx, f.jobId)) {
        const subject = await this.#activeSubject(tx, link.userId);
        if (subject === null || !authorize(subject, 'jobs.read', { project: f.project }).allow) continue;
        const lang = await this.#language(tx, link.userId, link.threadId);
        const label = `${f.jobId.slice(0, 8)}${f.title === '' ? '' : ` · ${mdText(plainLine(f.title, 80))}`}`;
        const message = await this.deps.store.addMessage(
          link.threadId,
          {
            role: 'assistant',
            content: jobTimeAutoExtendedText(f, label, lang),
            meta: {
              notice: 'job-time-extended',
              jobId: f.jobId,
              link: `/jobs/${f.jobId}`,
              jobTimeExtended: { fromSec: f.fromSec, toSec: f.toSec, n: f.n, max: f.max },
              ...(await this.planItemOf(tx, link.threadId, { jobIds: [f.jobId] })),
            },
          },
          tx,
        );
        posted.push({ threadId: link.threadId, message });
      }
    });
    for (const p of posted) this.#publish(p.threadId, p.message);
    return posted.length;
  }

  /** A job question changed (answered on the job page, expired …): the conversations showing it reload. */
  async questionChanged(questionId: string): Promise<void> {
    if (!isUuid(questionId)) return;
    const { rows } = await this.deps.pool.query<{ thread_id: string }>(
      `SELECT DISTINCT thread_id::text AS thread_id FROM chat_messages
        WHERE meta->>'notice' = 'job-question' AND meta->>'questionId' = $1`,
      [questionId],
    );
    for (const r of rows) this.#publish(r.thread_id, null);
  }
}

/** The plain note of a result card (the card itself draws `meta.workflowResult`). */
export function resultText(r: RunResult, lang: WatchLanguage): string {
  const word = STATE_WORD[lang][r.state];
  const steps = `${String(r.stepsDone)}/${String(r.stepsTotal)}`;
  if (r.attention.length > 0) {
    // p22-run-attention: succeeded, but a step could not do its work.
    const why = mdText(attentionLine(r.attention, lang));
    return lang === 'tr'
      ? `**Workflow bitti ama dikkat istiyor:** ${mdText(r.workflow)} · ${steps} adım — ${why}`
      : `**Workflow run finished but needs attention:** ${mdText(r.workflow)} · ${steps} steps — ${why}`;
  }
  return lang === 'tr'
    ? `**Workflow ${word}:** ${mdText(r.workflow)} · ${steps} adım`
    : `**Workflow ${word}:** ${mdText(r.workflow)} · ${steps} steps`;
}

export function resultNoteMeta(r: RunResult): Record<string, unknown> {
  return {
    notice: 'workflow-result',
    runId: r.runId,
    link: `/jobs/workflows/${r.runId}`,
    workflowResult: resultMeta(r),
  };
}

/**
 * p22-timeout-continuity: the note of an automatic extension (Markdown-safe: the label is escaped by the caller).
 */
export function jobTimeAutoExtendedText(f: AutoExtendFacts, label: string, lang: WatchLanguage): string {
  const add = Math.max(1, Math.round((f.toSec - f.fromSec) / 60));
  const to = Math.round(f.toSec / 60);
  const left = f.max - f.n;
  if (lang === 'tr') {
    return `**Süreyi otomatik uzattım: +${String(add)} dk** — iş ${label} çalışmaya devam ediyordu; yeni süre sınırı ${String(to)} dk (bu iş için ${String(f.n)}/${String(f.max)}. otomatik uzatma${left > 0 ? '' : '; bir dahaki uyarıda karar senin'}). Güvenlik politikasındaki “Süreyi kendiliğinden uzat” ayarıyla kapatabilirsin.`;
  }
  return `**I extended the time limit automatically: +${String(add)} min** — job ${label} was still making progress; the new limit is ${String(to)} min (automatic extension ${String(f.n)} of ${String(f.max)} for this job${left > 0 ? '' : '; at the next warning you decide'}). Turn it off with "Extend time automatically" in the security policy.`;
}

/**
 * p20-job-clock: the note of a time warning (Markdown-safe: the label is escaped by the caller). It says what rule 65
 * acts on: the time left, the limit, whether the job progressed in the last 10 minutes, and what the person can do.
 */
export function jobTimeWarningText(f: TimeWarningFacts, label: string, lang: WatchLanguage): string {
  const left = Math.max(1, Math.round(f.remainingSec / 60));
  const limit = Math.round(f.limitSec / 60);
  const room = Math.floor((f.maxAllowedSec - f.limitSec) / 60);
  if (lang === 'tr') {
    const progress =
      f.waiting === 'question'
        ? 'Şu an bir sorunun cevabını bekliyor; bekleme süreye sayılmıyor.'
        : f.waiting === 'approval'
          ? 'Şu an bir onay bekliyor; bekleme süreye sayılmıyor.'
          : f.progressing === true
            ? 'Son 10 dakikada çalışmaya devam ediyor.'
            : f.progressing === false
              ? 'Son 10 dakikada hiçbir şey yapmadı.'
              : '';
    const action =
      room > 0
        ? `Süreyi buradan uzatabilirsin (en çok ${String(room)} dk daha); uzatmazsan iş süre dolunca durur ve “Aynı yerden devam et” ile sürdürülebilir.`
        : 'Güvenlik politikasının üst sınırına ulaştı; daha fazla uzatılamaz. Süre dolarsa “Aynı yerden devam et” ile sürdürülebilir.';
    return `**İşin süresi azalıyor:** iş ${label} — yaklaşık ${String(left)} dk kaldı (süre sınırı ${String(limit)} dk). ${progress}${progress === '' ? '' : ' '}${action}`;
  }
  const progress =
    f.waiting === 'question'
      ? 'It is waiting for an answer to a question now; waiting does not count.'
      : f.waiting === 'approval'
        ? 'It is waiting for an approval now; waiting does not count.'
        : f.progressing === true
          ? 'It kept working in the last 10 minutes.'
          : f.progressing === false
            ? 'It did nothing in the last 10 minutes.'
            : '';
  const action =
    room > 0
      ? `You can extend it here (up to ${String(room)} min more); otherwise it stops when the time is up and can continue from where it was ("Continue where it stopped").`
      : 'It is at the security policy maximum and cannot be extended further. If it runs out, it can continue from where it was ("Continue where it stopped").';
  return `**The job is running out of time:** job ${label} — about ${String(left)} min left (time limit ${String(limit)} min). ${progress}${progress === '' ? '' : ' '}${action}`;
}
