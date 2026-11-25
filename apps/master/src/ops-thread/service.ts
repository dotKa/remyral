import type { ApprovalRequestRecord } from '../approvals/service.js';
import { redactRecord } from '../audit/export.js';
import { authorize, type Subject, visibleProjects } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { clampLimit, decodeKeyset, encodeKeyset } from '../http/pagination.js';
import type { IntegrationView } from '../integration/service.js';
import type { JobListFilter, JobPage, JobSummary } from '../jobs/query.js';
import type { OpsActionView } from '../ops/model.js';
import type { UsageLimitEpisodeView } from '../usage-limits/service.js';
import type { WorkflowApprovalView } from '../chat/flow.js';
import {
  CARD_OF,
  countOpen,
  EMPTY_COUNTS,
  FAILED_WINDOW_MS,
  MERGE_ATTENTION,
  MERGE_WINDOW_MS,
  mergeItems,
  type OpenCounts,
  ORIGIN_KINDS,
  type OpsThreadItem,
  refOfLink,
  type SubjectKind,
  type SubjectRef,
  subjectKey,
  type ThreadEvent,
} from './model.js';

/**
 * p12-diyalog Faz 1 (docs/design/p12-diyalog.md §9): builds one page of the caller's operations thread.
 *
 * Authorization = what the caller can already read elsewhere, decided per item with the same actions the source
 * endpoints use: notifications are the caller's own (`notifications.self`, recipient = caller); an approval needs
 * `approvals.read`, an ops action `deploy.read`, a job or integration `jobs.read` — each on the item's project;
 * usage-limit pauses `quotas.read`. An entity the caller can no longer see is never attached: its notification stays
 * the text the caller already received. Payloads are the entities' own wire views, redacted once more on the way
 * out.
 */
export interface OpsThreadDeps {
  readonly pool: Queryable;
  readonly clock: () => Date;
  readonly approvals: {
    list(filter: {
      status?: 'pending';
      limit?: number;
      projects?: readonly string[] | null;
    }): Promise<ApprovalRequestRecord[]>;
    get(id: string): Promise<{ request: ApprovalRequestRecord } | null>;
  };
  readonly approvalJson: (r: ApprovalRequestRecord) => unknown;
  readonly jobs: { list(filter: JobListFilter, opts?: { limit?: number }): Promise<JobPage> };
  readonly jobJson: (s: JobSummary) => unknown;
  /** Absent until the ops service is initialised (and in deployments without it). */
  readonly ops: () => {
    get(id: string): Promise<OpsActionView>;
    listPage(
      visible: readonly string[] | null,
      q: { state?: 'awaiting_approval'; limit?: number },
    ): Promise<{ items: OpsActionView[] }>;
  } | null;
  readonly integration: () => { view(id: string): Promise<IntegrationView | null> } | null;
  readonly usageLimits: { status(): Promise<UsageLimitEpisodeView[]> };
  /** p17-chat-flow: waiting workflow approval steps the caller may decide (absent / null: none). */
  readonly workflowApprovals?: () => {
    pending(subject: Subject): Promise<readonly WorkflowApprovalView[]>;
  } | null;
}

export interface OpsThreadPage {
  readonly items: OpsThreadItem[];
  readonly nextCursor: string | null;
  /** Open cards by kind; first page only (null on older pages). */
  readonly open: OpenCounts | null;
}

const SCOPE = 'ops-thread';
const OPEN_APPROVALS = 50;
const OPEN_DEPLOYS = 30;
const OPEN_MERGES = 20;
const OPEN_FAILURES = 20;

interface NotificationRow {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  link: string | null;
  created_key: string;
  read_at: Date | null;
}

type Payload = Record<string, unknown>;

function asPayload(v: unknown): Payload {
  return v as Payload;
}

export class OpsThreadService {
  constructor(private readonly deps: OpsThreadDeps) {}

  async page(
    subject: Subject,
    q: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<OpsThreadPage> {
    const limit = clampLimit(q.limit, 50, 100);
    const before = q.cursor === undefined ? null : decodeKeyset(SCOPE, q.cursor, 'uuid');
    const { rows, nextCursor } = await this.#notifications(subject.userId, before, limit);

    // Resolve the entities the page's notifications point at (batched per kind, each checked for visibility).
    const refs = new Map<string, SubjectRef>();
    for (const r of rows) {
      const ref = refOfLink(r.link);
      if (ref !== null) refs.set(subjectKey(ref), ref);
    }
    const resolved = await this.#resolve(subject, [...refs.values()]);

    const history: OpsThreadItem[] = rows.map((r) => {
      const ref = refOfLink(r.link);
      const key = ref === null ? null : subjectKey(ref);
      const payload = key === null ? undefined : resolved.get(key);
      const event: ThreadEvent = {
        notificationId: r.id,
        kind: r.kind,
        severity: r.severity,
        title: r.title,
        body: r.body,
        link: r.link,
      };
      const origin = ORIGIN_KINDS[r.kind];
      if (ref !== null && origin === ref.kind && payload !== undefined) {
        return {
          id: key ?? `n:${r.id}`,
          type: CARD_OF[ref.kind],
          at: new Date(r.created_key).toISOString(),
          subject: key,
          unread: r.read_at === null,
          event,
          payload,
        };
      }
      return {
        id: `n:${r.id}`,
        type: `event:${r.kind}`,
        at: new Date(r.created_key).toISOString(),
        // A follow-up only names its card when the caller can see that card's entity.
        subject: payload === undefined ? null : key,
        unread: r.read_at === null,
        event,
        payload: null,
      };
    });

    const open = before === null ? await this.#open(subject) : [];
    const merged = await this.#withChatThreads(subject.userId, mergeItems(history, open));
    const items = merged.map((i) => redactItem(i));
    return { items, nextCursor, open: before === null ? countOpen(open) : null };
  }

  /**
   * p15-rerun-thread: a failed job's card carries `chatThreadId` — the caller's own (not archived) conversation whose
   * confirmed card started that job (a job card, or a run-again / continue card), or null. The card's "Retry"
   * drafts the re-run there; without one it opens the composer. Never "the latest conversation": a re-run must not
   * land in an unrelated chat. Threads are private, so only the caller's own drafts count.
   */
  async #withChatThreads(userId: string, items: readonly OpsThreadItem[]): Promise<OpsThreadItem[]> {
    const jobIds = items.flatMap((i) =>
      i.type === 'job:failed' && typeof i.payload?.id === 'string' ? [i.payload.id] : [],
    );
    if (jobIds.length === 0) return [...items];
    const { rows } = await this.deps.pool.query<{ job_id: string; thread_id: string }>(
      `SELECT DISTINCT ON (d.result->>'jobId') d.result->>'jobId' AS job_id, d.thread_id::text AS thread_id
         FROM chat_threads t
         JOIN chat_drafts d ON d.thread_id = t.id
        WHERE t.user_id = $1 AND d.user_id = $1 AND t.archived_at IS NULL AND d.state = 'confirmed'
          AND d.result->>'jobId' = ANY($2::text[])
          AND (d.kind <> 'job_action' OR d.result->>'action' IN ('run_again', 'continue'))
        ORDER BY d.result->>'jobId', d.created_at, d.id`,
      [userId, [...new Set(jobIds)]],
    );
    const threadOf = new Map(rows.map((r) => [r.job_id, r.thread_id] as const));
    return items.map((i) =>
      i.type === 'job:failed' && i.payload !== null
        ? { ...i, payload: { ...i.payload, chatThreadId: threadOf.get(String(i.payload.id)) ?? null } }
        : i,
    );
  }

  /** Counts only (rail / nav), without history. */
  async counts(subject: Subject): Promise<OpenCounts> {
    const open = await this.#open(subject);
    return open.length === 0 ? EMPTY_COUNTS : countOpen(open);
  }

  async #notifications(
    userId: string,
    before: { k: string; id: string } | null,
    limit: number,
  ): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> {
    const params: unknown[] = [userId, limit + 1];
    let cond = '';
    if (before !== null) {
      params.push(before.k, before.id);
      cond = 'AND (created_at, id) < ($3::timestamptz, $4::uuid)';
    }
    const { rows } = await this.deps.pool.query<NotificationRow>(
      `SELECT id::text AS id, kind, severity, title, body, link, read_at,
              to_json(created_at) #>> '{}' AS created_key
         FROM notifications WHERE recipient_id = $1 ${cond}
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeKeyset(SCOPE, { k: last.created_key, id: last.id })
          : null,
    };
  }

  /** subject key → payload, for the refs the caller may see. */
  async #resolve(subject: Subject, refs: readonly SubjectRef[]): Promise<Map<string, Payload>> {
    const out = new Map<string, Payload>();
    const ids = (kind: SubjectKind): string[] => refs.filter((r) => r.kind === kind).map((r) => r.id);

    // p14-web-perf (docs/design/p14-web-perf.md §6): the approval and deploy reads are independent point reads — all
    // of them run at once instead of one after the other (polled every 10 s by the home); jobs are one batched list.
    // Insertion order (approvals, deploys, jobs; each in reference order) is kept.
    const ops = this.deps.ops();
    const jobIds = ids('job');
    const [approvals, deploys, jobs] = await Promise.all([
      authorize(subject, 'approvals.read').allow
        ? Promise.all(ids('approval').map(async (id) => [id, await this.deps.approvals.get(id)] as const))
        : Promise.resolve([]),
      ops !== null && authorize(subject, 'deploy.read').allow
        ? Promise.all(ids('deploy').map(async (id) => [id, await ops.get(id).catch(() => null)] as const))
        : Promise.resolve([]),
      jobIds.length > 0 && authorize(subject, 'jobs.read').allow
        ? this.deps.jobs
            .list({ ids: jobIds, projects: visibleProjects(subject) }, { limit: jobIds.length })
            .then((page) => page.items)
        : Promise.resolve([]),
    ]);
    for (const [id, got] of approvals) {
      if (got === null) continue;
      if (!authorize(subject, 'approvals.read', { project: got.request.project }).allow) continue;
      out.set(`approval:${id}`, asPayload(this.deps.approvalJson(got.request)));
    }
    for (const [id, a] of deploys) {
      if (a === null) continue;
      if (!authorize(subject, 'deploy.read', { project: a.project }).allow) continue;
      out.set(`deploy:${id}`, asPayload(a));
    }
    for (const j of jobs) {
      if (!authorize(subject, 'jobs.read', { project: j.project }).allow) continue;
      out.set(`job:${j.id}`, asPayload(this.deps.jobJson(j)));
    }
    return out;
  }

  /**
   * Open cards: what waits for a person right now, as far as the caller can see it. p14-web-perf: the five sections
   * are independent reads and run in parallel (they ran one after the other); the cards keep the section order
   * (approvals, deploys, failures, merges, limits).
   */
  async #open(subject: Subject): Promise<OpsThreadItem[]> {
    const now = this.deps.clock();
    const projects = visibleProjects(subject);
    const card = (kind: SubjectKind, id: string, at: string, payload: Payload): OpsThreadItem => ({
      id: `${kind}:${id}`,
      type: CARD_OF[kind],
      at,
      subject: `${kind}:${id}`,
      unread: false,
      event: null,
      payload,
    });

    const approvals = async (): Promise<OpsThreadItem[]> => {
      if (!authorize(subject, 'approvals.read').allow) return [];
      const pending = await this.deps.approvals.list({ status: 'pending', limit: OPEN_APPROVALS, projects });
      return pending
        .filter((r) => authorize(subject, 'approvals.read', { project: r.project }).allow)
        .map((r) => card('approval', r.id, r.createdAt.toISOString(), asPayload(this.deps.approvalJson(r))));
    };

    const deploys = async (): Promise<OpsThreadItem[]> => {
      const ops = this.deps.ops();
      if (ops === null || !authorize(subject, 'deploy.read').allow) return [];
      const waiting = await ops.listPage(projects, { state: 'awaiting_approval', limit: OPEN_DEPLOYS });
      return waiting.items
        .filter((a) => authorize(subject, 'deploy.read', { project: a.project }).allow)
        .map((a) => card('deploy', a.id, a.createdAt, asPayload(a)));
    };

    const failures = async (): Promise<OpsThreadItem[]> => {
      if (!authorize(subject, 'jobs.read').allow) return [];
      const failed = await this.deps.jobs.list(
        {
          states: ['FAILED', 'LOST'],
          projects,
          // Created within a week, failed within the window (a long job can fail long after it was created).
          from: new Date(now.getTime() - 7 * 24 * 3600_000),
        },
        { limit: 100 },
      );
      return failed.items
        .filter((j) => now.getTime() - j.stateChangedAt.getTime() <= FAILED_WINDOW_MS)
        .filter((j) => authorize(subject, 'jobs.read', { project: j.project }).allow)
        .slice(0, OPEN_FAILURES)
        .map((j) => card('job', j.id, j.stateChangedAt.toISOString(), asPayload(this.deps.jobJson(j))));
    };

    const merges = async (): Promise<OpsThreadItem[]> => {
      const integration = this.deps.integration();
      if (integration === null || !authorize(subject, 'jobs.read').allow) return [];
      const params: unknown[] = [
        [...MERGE_ATTENTION],
        new Date(now.getTime() - MERGE_WINDOW_MS),
        OPEN_MERGES,
      ];
      let scope = '';
      if (projects !== null) {
        params.push([...projects]);
        scope = 'AND project = ANY($4::text[])';
      }
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM integrations
          WHERE state = ANY($1::text[]) AND (state = 'ready' OR updated_at >= $2) ${scope}
          ORDER BY updated_at DESC, id DESC LIMIT $3`,
        params,
      );
      // At most OPEN_MERGES views, read together (they were read one after the other).
      const views = await Promise.all(rows.map(({ id }) => integration.view(id)));
      return views.flatMap((v) =>
        v === null || !authorize(subject, 'jobs.read', { project: v.project }).allow
          ? []
          : [card('merge', v.id, v.updatedAt, asPayload(v))],
      );
    };

    const limits = async (): Promise<OpsThreadItem[]> => {
      if (!authorize(subject, 'quotas.read').allow) return [];
      // A limit tied to a project the caller cannot see stays out (machine-wide ones are fleet facts).
      return (await this.deps.usageLimits.status())
        .filter((e) => !(e.project !== null && projects !== null && !projects.includes(e.project)))
        .map((e) => card('limit', e.id, e.since, asPayload(e)));
    };

    // p17-chat-flow: workflow approval steps the caller may decide (the same check as the decision route).
    const workflowApprovals = async (): Promise<OpsThreadItem[]> => {
      const svc = this.deps.workflowApprovals?.() ?? null;
      if (svc === null) return [];
      return (await svc.pending(subject)).map((v) =>
        card('workflow', v.nodeRunId, v.createdAt, asPayload(v)),
      );
    };

    const sections = await Promise.all([
      approvals(),
      workflowApprovals(),
      deploys(),
      failures(),
      merges(),
      limits(),
    ]);
    return sections.flat();
  }
}

function redactItem(item: OpsThreadItem): OpsThreadItem {
  return redactRecord({ item }).value.item as OpsThreadItem;
}
