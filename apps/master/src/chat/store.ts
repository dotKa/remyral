import { createHash, randomUUID } from 'node:crypto';
import type { AssistantUsage } from '@remyral/protocol';
import { ASSISTANT_TOOLS, canonicalPolicyJson } from '@remyral/protocol';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { clampLimit, decodeKeyset, keysetPage } from '../http/pagination.js';
import { untrustedKeyOf } from './untrusted.js';

/** Keyset scope of the thread-list cursor (p9-pagination). */
const THREADS_SCOPE = 'chat.threads';

/**
 * Persistence of the ops chat (migration 0034): threads (private per user), messages, turns (usage) and draft
 * cards. Every read and write takes the owner's user id; a thread of another user is "not found".
 */

export type MessageRole = 'user' | 'assistant' | 'tool' | 'error';

/** p17-chat-github: where a conversation's title comes from (migration 0169). */
export type TitleSource = 'default' | 'placeholder' | 'provisional' | 'auto' | 'user';
/** p17-chat-github: a provisional title is retitled from the 3rd exchanged message on … */
export const RETITLE_AFTER = 3;
/** … and the assistant is asked until the 5th (then the first-words title stays). */
export const RETITLE_UNTIL = 5;

export interface ThreadView {
  readonly id: string;
  readonly title: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** p9-chat-unread: a list row carries the caller's unread count (capped at {@link UNREAD_CAP}). */
export interface ThreadListItem extends ThreadView {
  readonly unreadCount: number;
  /** p10-chat-organize: the caller's own pin, group and tags of the conversation. */
  readonly pinnedAt: string | null;
  readonly groupId: string | null;
  readonly tagIds: string[];
}

/** p10-chat-organize: list filters over the caller's organisation (combine with search, archive and cursor). */
export interface ThreadOrganizeFilter {
  /** true: the pinned section (by pin time, newest first, no cursor); false: conversations that are not pinned. */
  readonly pinned?: boolean;
  /** A group id, or 'none' for conversations in no group. */
  readonly group?: string;
  readonly tag?: string;
}

/** p10-chat-organize: the caller's pin, group and tags of thread `t` (user id is $1). */
const ORGANIZE_COLUMNS = `
  (SELECT p.pinned_at FROM chat_thread_pins p WHERE p.thread_id = t.id AND p.user_id = $1) AS pinned_at,
  (SELECT g.group_id::text FROM chat_thread_groups g WHERE g.thread_id = t.id AND g.user_id = $1) AS group_id,
  ARRAY(SELECT tt.tag_id::text FROM chat_thread_tags tt WHERE tt.thread_id = t.id AND tt.user_id = $1
         ORDER BY tt.added_at, tt.tag_id) AS tag_ids`;

/** The organisation filters; parameters $7 (pinned), $8 (group id or 'none'), $9 (tag id). */
const ORGANIZE_FILTER = `
  AND ($7::boolean IS NULL OR EXISTS (
        SELECT 1 FROM chat_thread_pins p WHERE p.thread_id = t.id AND p.user_id = $1) = $7)
  AND ($8::text IS NULL
       OR ($8 = 'none' AND NOT EXISTS (
             SELECT 1 FROM chat_thread_groups g WHERE g.thread_id = t.id AND g.user_id = $1))
       OR EXISTS (SELECT 1 FROM chat_thread_groups g
                   WHERE g.thread_id = t.id AND g.user_id = $1 AND g.group_id::text = $8))
  AND ($9::uuid IS NULL OR EXISTS (
        SELECT 1 FROM chat_thread_tags tt WHERE tt.thread_id = t.id AND tt.user_id = $1 AND tt.tag_id = $9))`;

/** p10-chat-organize: the pinned section's size (also the pin limit). */
const PINNED_SECTION = 20;

/** p9-chat-unread: the caller's read position in one conversation after marking it read. */
export interface ReadState {
  readonly threadId: string;
  readonly lastReadSeq: number;
  readonly lastReadAt: string;
  readonly unreadCount: number;
}

export interface MessageView {
  readonly id: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly meta: Record<string, unknown> | null;
  readonly turnId: string | null;
  readonly createdAt: string;
  /**
   * p16-chat-complete: set when an edit / regenerate / retry replaced this row (it never reaches a model again; the
   * console folds it). Absent on current rows.
   */
  readonly supersededAt?: string;
  /** p16-chat-complete: the edited message's new row, or the turn that regenerated the answer. */
  readonly supersededBy?: string;
}

/** p16-chat-complete: what a turn about to be replaced did (the replay rule's evidence for the console). */
export interface TurnEffects {
  /** Non-read tool calls received by the turns (persisted `chat_turns.actions`). */
  readonly actions: number;
  readonly turnIds: readonly string[];
  /** Their tool rows that are not reads: tool name and the stored one-line summary. */
  readonly tools: readonly { readonly name: string; readonly summary: string }[];
  /** Their cards with the state they are in now. */
  readonly cards: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly state: string;
  }[];
}

export type DraftKind =
  | 'job'
  | 'workflow_run'
  | 'worker_config'
  | 'approval_decision'
  | 'job_message'
  /** p5-machine-admin (ADR-0021). */
  | 'machine_task'
  | 'tool_install'
  | 'skill'
  /** p6-automations (ADR-0024): create / update, and pause · resume · delete · run now. */
  | 'automation'
  | 'automation_change'
  /** p6-deploy-integrations (ADR-0028): a deploy / DNS change / rollback request. */
  | 'ops_action'
  /** p8-uptime: an uptime monitor (or the "Monitor this" set of an Outputs site). */
  | 'monitor'
  /** p13-runtime-accounts: pause / resume a machine account, or move a job to an account. */
  | 'account_action'
  /** p10-approval-pause: "Resume now" / "Restart from scratch" of a paused job. */
  | 'job_resume'
  /** p10-chat-job-actions: cancel / run again / continue / class / move / run now on existing jobs (≤ 50). */
  | 'job_action'
  /** p11-memory-layers: add / replace / retire a typed memory record. */
  | 'memory_change'
  /** p13-workflows-ui: a workflow definition (new, or a new version of a saved one). */
  | 'workflow'
  /** p14-skill-catalogs: install a skill from a catalog / GitHub link / import preview (propose_skill_install). */
  | 'skill_import'
  /** p14-mcp-chat: install an MCP server from a registry / npm / PyPI / URL preview (propose_mcp_install). */
  | 'mcp_install'
  /** p19-install-scripts: approve npm install scripts (draft_install_script_approval). */
  | 'install_script_approval'
  /** p15-autonomy: a settings / permissions / policy change (change_settings). */
  | 'settings_change'
  /** p15-autonomy: change a queued / running job's time limit (draft_time_limit). */
  | 'time_limit'
  /** p15-services: start / stop / restart a service (start_service, stop_service, restart_service). */
  | 'service_action'
  /** p15-coolify-create: create a Coolify application, set its variables or domains (coolify_* tools). */
  | 'coolify_change'
  /** p15-github-create-repo: open a GitHub repository and link it to a project (create_repository). */
  | 'github_repo'
  /** p17-chat-github: create a project, optionally linking a repository and a DNS zone (draft_project_create). */
  | 'project_create'
  /** p18-multi-project W3: the conversation's working projects (set_thread_projects). */
  | 'thread_projects'
  /** p18-multi-project W3: attach a shared workflow to a working project (attach_workflow). */
  | 'workflow_attach'
  /** p18-multi-project W5: one job per selected project, grouped as a batch (draft_job_batch). */
  | 'job_batch'
  /** p15-workspace-retention: push a job's kept working files to a repository (export_workfiles). */
  | 'workfiles_export'
  /** p15-chat-vault: one HTTP request as a function job, a vault credential by reference (run_http_request). */
  | 'http_request'
  /** p15-chat-vault: save a pasted secret in the vault — completed by the user's browser (propose_credential_save). */
  | 'credential_save'
  /**
   * p16-runtime-updates: a runtime update on one or more machines through the fleet pipeline (draft_runtime_update) —
   * a pinned version, a newer one labelled unverified (security policy), or the rollback to the pin.
   */
  | 'runtime_update'
  /** p16-webhooks-out: create / pause / resume an outgoing webhook (draft_webhook). */
  | 'webhook'
  /** p16-doctor: build and e-mail the redacted support report (draft_support_report). */
  | 'support_report';
/**
 * `invalid` (p16-workflow-quality): the master's validation refused the draft — kept hidden for the repair loop, the
 * give-up line and the audit, never listed in a thread and never confirmable.
 */
export type DraftState = 'proposed' | 'confirmed' | 'dismissed' | 'failed' | 'expired' | 'invalid';

export interface DraftView {
  readonly id: string;
  readonly threadId: string;
  readonly kind: DraftKind;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly project: string | null;
  readonly state: DraftState;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  /**
   * oss-sec3: the draft would have run at once but its turn read untrusted content — a card the person confirms;
   * `rememberable`: the card may offer to remember that kind of action on that target (untrusted.ts). Absent: not held.
   */
  readonly held?: { readonly reason: 'untrusted_content'; readonly rememberable: boolean };
}

export interface DraftRecord extends DraftView {
  readonly userId: string;
  readonly payloadHash: string;
}

export const DRAFT_TTL_MS = 24 * 60 * 60_000;
export const MAX_THREADS_PER_USER = 500;
export const MAX_MESSAGES_PER_THREAD = 2_000;

/** Unread counts stop at this many per conversation (the console shows "99+"); keeps the count an index scan. */
export const UNREAD_CAP = 100;

/**
 * p9-chat-unread: unread messages of thread `t` for the reader whose read row is `r` (LEFT JOIN, may be null).
 * The cheap guard (next_seq) skips threads without any new row; the count itself walks the partial index
 * chat_messages_unread (thread_id, seq) and stops at UNREAD_CAP.
 */
const UNREAD_SQL = `CASE WHEN t.next_seq - 1 <= COALESCE(r.last_read_seq, 0) THEN 0 ELSE (
    SELECT count(*)::int FROM (
      SELECT 1 FROM chat_messages m
       WHERE m.thread_id = t.id AND m.seq > COALESCE(r.last_read_seq, 0) AND m.role IN ('assistant', 'error')
       LIMIT ${String(UNREAD_CAP)}) u) END`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * p15-workflow-ai: a message's meta as views see it — the workflow editor's document (`meta.workflowAi.document`, up to
 * 512 KiB) stays in the row for the turn input and is replaced by its node count in every view and stream event.
 */
export function viewMeta(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  const wf = meta?.workflowAi;
  if (meta === null || typeof wf !== 'object' || wf === null || !('document' in wf)) return meta;
  const { document, ...rest } = wf as Record<string, unknown>;
  const nodes = (document as { nodes?: unknown } | null)?.nodes;
  return { ...meta, workflowAi: { ...rest, documentNodes: Array.isArray(nodes) ? nodes.length : 0 } };
}

/** Keys a card's payload derives per proposal (p17-embeddings: ignored when two cards are compared). */
const DERIVED_KEYS: ReadonlySet<string> = new Set(['workBranch', 'review', 'runtimeAdvice', 'reuse']);

/** p17-embeddings: the payload's hash without {@link DERIVED_KEYS} at any depth (two proposals of the same card match). */
export function twinKey(payload: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !DERIVED_KEYS.has(k))
        .map(([k, x]) => [k, strip(x)]),
    );
  };
  const stripped = strip(payload);
  return payloadHash(
    typeof stripped === 'object' && stripped !== null && !Array.isArray(stripped)
      ? (stripped as Record<string, unknown>)
      : {},
  );
}

export function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalPolicyJson(payload as Parameters<typeof canonicalPolicyJson>[0]), 'utf8')
    .digest('hex');
}

interface ThreadRow {
  id: string;
  title: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function threadView(r: ThreadRow): ThreadView {
  return {
    id: r.id,
    title: r.title,
    archived: r.archived_at !== null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

interface DraftRow {
  id: string;
  thread_id: string;
  user_id: string;
  kind: DraftKind;
  title: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  project: string | null;
  state: DraftState;
  result: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  held: string | null;
}

function draftRecord(r: DraftRow, now: Date): DraftRecord {
  const expired = r.state === 'proposed' && r.expires_at.getTime() <= now.getTime();
  return {
    id: r.id,
    threadId: r.thread_id,
    userId: r.user_id,
    kind: r.kind,
    title: r.title,
    payload: r.payload,
    payloadHash: r.payload_hash,
    project: r.project,
    state: expired ? 'expired' : r.state,
    result: r.result,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    decidedAt: iso(r.decided_at),
    ...(r.held === 'untrusted_content'
      ? { held: { reason: 'untrusted_content' as const, rememberable: untrustedKeyOf(r) !== null } }
      : {}),
  };
}

export function draftView(d: DraftRecord): DraftView {
  const { userId: _u, payloadHash: _h, ...view } = d;
  return view;
}

const DRAFT_COLUMNS = `id::text AS id, thread_id::text AS thread_id, user_id::text AS user_id, kind, title, payload,
  payload_hash, project, state, result, created_at, expires_at, decided_at, held`;
/** {@link DRAFT_COLUMNS} of `chat_drafts d` (joined queries). */
const DRAFT_COLUMNS_D = `d.id::text AS id, d.thread_id::text AS thread_id, d.user_id::text AS user_id, d.kind, d.title,
  d.payload, d.payload_hash, d.project, d.state, d.result, d.created_at, d.expires_at, d.decided_at, d.held`;

export class ChatStore {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly clock: () => Date;
    },
  ) {}

  #now(): Date {
    return this.deps.clock();
  }

  // ------------------------------------------------------------------------------------------- threads

  async listThreads(
    userId: string,
    q: { search?: string; archived?: boolean; limit?: number } & ThreadOrganizeFilter = {},
  ): Promise<ThreadListItem[]> {
    return (await this.listThreadsPage(userId, q)).items;
  }

  /**
   * p9-pagination: the caller's threads, most recently active first by `(updated_at, id)`, keyset-paged. A
   * thread that gets a new message while someone pages moves to the top (it is on the first page again).
   */
  async listThreadsPage(
    userId: string,
    q: { search?: string; archived?: boolean; limit?: number; cursor?: string } & ThreadOrganizeFilter = {},
  ): Promise<{ items: ThreadListItem[]; nextCursor: string | null }> {
    // p10-chat-organize: the pinned section is ordered by pin time and small (≤ 20): one page, no cursor.
    const pinnedSection = q.pinned === true;
    const limit = pinnedSection ? PINNED_SECTION : clampLimit(q.limit, 100, 200);
    const after =
      q.cursor === undefined || pinnedSection ? null : decodeKeyset(THREADS_SCOPE, q.cursor, 'uuid');
    const search = q.search?.trim() ?? '';
    const { rows } = await this.deps.pool.query<
      ThreadRow & {
        page_key: string;
        unread: number;
        pinned_at: Date | null;
        group_id: string | null;
        tag_ids: string[];
      }
    >(
      `SELECT t.id::text AS id, t.title, t.archived_at, t.created_at, t.updated_at,
              to_json(t.updated_at) #>> '{}' AS page_key, ${UNREAD_SQL} AS unread, ${ORGANIZE_COLUMNS}
         FROM chat_threads t
         LEFT JOIN chat_thread_reads r ON r.thread_id = t.id AND r.user_id = $1
        WHERE t.user_id = $1
          AND ($2::boolean IS NULL OR (t.archived_at IS NOT NULL) = $2)
          AND ($3 = '' OR t.title ILIKE '%' || $3 || '%' OR EXISTS (
                SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id AND m.role IN ('user', 'assistant')
                   AND m.content ILIKE '%' || $3 || '%')
               -- p18-plan-mode W4: the conversation's plans (title, goal, item titles and details) are its text too.
               OR EXISTS (SELECT 1 FROM chat_plans p WHERE p.thread_id = t.id
                             AND (p.title ILIKE '%' || $3 || '%' OR p.goal ILIKE '%' || $3 || '%'))
               OR EXISTS (SELECT 1 FROM chat_plans p JOIN chat_plan_items i ON i.plan_id = p.id
                           WHERE p.thread_id = t.id AND i.deleted_at IS NULL
                             AND (i.title ILIKE '%' || $3 || '%' OR i.detail ILIKE '%' || $3 || '%')))
          AND ($5::timestamptz IS NULL OR (t.updated_at, t.id) < ($5::timestamptz, $6::uuid))
          ${ORGANIZE_FILTER}
        ORDER BY ${pinnedSection ? 'pinned_at DESC, t.id DESC' : 't.updated_at DESC, t.id DESC'} LIMIT $4`,
      [
        userId,
        q.archived ?? false,
        search.replace(/[%_\\]/g, (c) => `\\${c}`),
        pinnedSection ? limit : limit + 1,
        after?.k ?? null,
        after?.id ?? null,
        q.pinned ?? null,
        q.group ?? null,
        q.tag ?? null,
      ],
    );
    return keysetPage(
      rows,
      limit,
      THREADS_SCOPE,
      (r) => ({ k: r.page_key, id: r.id }),
      (r) => ({
        ...threadView(r),
        unreadCount: r.unread,
        pinnedAt: r.pinned_at === null ? null : r.pinned_at.toISOString(),
        groupId: r.group_id,
        tagIds: r.tag_ids,
      }),
    );
  }

  async createThread(userId: string, title: string | undefined): Promise<ThreadView> {
    const now = this.#now();
    const { rows: count } = await this.deps.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chat_threads WHERE user_id = $1',
      [userId],
    );
    if ((count[0]?.n ?? 0) >= MAX_THREADS_PER_USER) {
      throw new HttpError(409, 'too_many_threads', 'You have too many conversations. Delete some first.');
    }
    const { rows } = await this.deps.pool.query<ThreadRow>(
      `INSERT INTO chat_threads (id, user_id, title, title_source, created_at, updated_at)
       VALUES ($1, $2, $3, $5, $4, $4)
       RETURNING id::text AS id, title, archived_at, created_at, updated_at`,
      [
        randomUUID(),
        userId,
        cleanTitle(title) ?? 'New conversation',
        now,
        // p17-chat-github: a title given at creation is never changed automatically.
        cleanTitle(title) === undefined ? 'default' : 'user',
      ],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('thread insert returned nothing');
    return threadView(r);
  }

  /** The thread if `userId` owns it, else a 404 (another user's thread is indistinguishable from none). */
  async thread(userId: string, threadId: string, db: Queryable = this.deps.pool): Promise<ThreadView> {
    const { rows } = await db.query<ThreadRow>(
      `SELECT id::text AS id, title, archived_at, created_at, updated_at FROM chat_threads
        WHERE id = $1 AND user_id = $2`,
      [threadId, userId],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
    return threadView(r);
  }

  async updateThread(
    userId: string,
    threadId: string,
    patch: { title?: string; archived?: boolean },
  ): Promise<ThreadView> {
    await this.thread(userId, threadId);
    const title = cleanTitle(patch.title);
    const { rows } = await this.deps.pool.query<ThreadRow>(
      `UPDATE chat_threads
          SET title = COALESCE($3, title),
              title_source = CASE WHEN $3::text IS NULL THEN title_source ELSE 'user' END,
              archived_at = CASE WHEN $4::boolean IS NULL THEN archived_at
                                 WHEN $4 THEN COALESCE(archived_at, $5) ELSE NULL END,
              updated_at = CASE WHEN $3::text IS NULL THEN updated_at ELSE $5 END
        WHERE id = $1 AND user_id = $2
        RETURNING id::text AS id, title, archived_at, created_at, updated_at`,
      [threadId, userId, title ?? null, patch.archived ?? null, this.#now()],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
    return threadView(r);
  }

  /** Deletes the thread, its messages and drafts (turn rows stay for usage accounting, unlinked). */
  async deleteThread(userId: string, threadId: string): Promise<void> {
    const { rowCount } = await this.deps.pool.query(
      'DELETE FROM chat_threads WHERE id = $1 AND user_id = $2',
      [threadId, userId],
    );
    if ((rowCount ?? 0) === 0) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
  }

  /**
   * Sets a title from the first message when the thread still has the default one — the instant placeholder (and the
   * fallback when the assistant never names it). p17-chat-github: `provisional` when the first message says too little
   * to name the conversation (it is retitled once after 3–5 messages), else `placeholder` (named from its meaning).
   */
  async autoTitle(threadId: string, text: string, provisional = false): Promise<void> {
    const title = cleanTitle(text.split('\n')[0]?.slice(0, 80));
    if (title === undefined) return;
    await this.deps.pool.query(
      `UPDATE chat_threads SET title = $2, title_source = $3
        WHERE id = $1 AND title = 'New conversation' AND title_source = 'default'`,
      [threadId, title, provisional ? 'provisional' : 'placeholder'],
    );
  }

  /**
   * p17-chat-github: where the title comes from and how many messages were exchanged (current user and assistant
   * messages) — whether the assistant is asked to name the conversation in this turn.
   */
  async titleState(
    threadId: string,
  ): Promise<{ source: TitleSource; title: string; exchanged: number } | null> {
    const { rows } = await this.deps.pool.query<{ title_source: TitleSource; title: string; n: number }>(
      `SELECT t.title_source, t.title,
              (SELECT count(*)::int FROM chat_messages m
                WHERE m.thread_id = t.id AND m.role IN ('user', 'assistant') AND m.superseded_at IS NULL) AS n
         FROM chat_threads t WHERE t.id = $1`,
      [threadId],
    );
    const r = rows[0];
    return r === undefined ? null : { source: r.title_source, title: r.title, exchanged: r.n };
  }

  /**
   * p17-chat-github: the assistant's title for the caller's conversation — only while it is a placeholder (from the
   * meaning of the first message) or provisional with at least 3 messages exchanged (from the conversation so far).
   * Never a title a person set; at most once after the placeholder. Null: nothing changed.
   */
  async applyAutoTitle(threadId: string, userId: string, title: string): Promise<ThreadView | null> {
    const clean = cleanTitle(title);
    if (clean === undefined) return null;
    const { rows } = await this.deps.pool.query<ThreadRow>(
      `UPDATE chat_threads t SET title = $3, title_source = 'auto', updated_at = $4
        WHERE t.id = $1 AND t.user_id = $2 AND t.archived_at IS NULL
          AND (t.title_source = 'placeholder'
               OR (t.title_source = 'provisional'
                   AND (SELECT count(*) FROM chat_messages m
                         WHERE m.thread_id = t.id AND m.role IN ('user', 'assistant')
                           AND m.superseded_at IS NULL) >= ${String(RETITLE_AFTER)}))
        RETURNING id::text AS id, title, archived_at, created_at, updated_at`,
      [threadId, userId, clean, this.#now()],
    );
    const r = rows[0];
    return r === undefined ? null : threadView(r);
  }

  /**
   * p18-plan-mode: the title the person asked the assistant for in turn `turnId` — like a manual
   * rename (source `user`), over any title, except one the person set by hand since that turn started. Null: nothing
   * changed (not theirs, archived, a later manual rename, or an empty / secret-looking title).
   */
  async applyRequestedTitle(
    threadId: string,
    userId: string,
    title: string,
    turnId: string,
  ): Promise<ThreadView | null> {
    const clean = cleanTitle(title);
    if (clean === undefined) return null;
    const { rows } = await this.deps.pool.query<ThreadRow>(
      `UPDATE chat_threads t SET title = $3, title_source = 'user', updated_at = $4
        WHERE t.id = $1 AND t.user_id = $2 AND t.archived_at IS NULL
          AND NOT (t.title_source = 'user'
                   AND t.updated_at > coalesce((SELECT c.created_at FROM chat_turns c WHERE c.id = $5), $4))
        RETURNING id::text AS id, title, archived_at, created_at, updated_at`,
      [threadId, userId, clean, this.#now(), turnId],
    );
    const r = rows[0];
    return r === undefined ? null : threadView(r);
  }

  // ------------------------------------------------------------------------------------- read state

  /**
   * p9-chat-unread: marks `threadId` read up to `seq` (default: its latest message) for `userId`. Idempotent and
   * monotonic: the position never moves back, and never past the thread's last message. 404 when the caller does
   * not own the thread (same rule as every thread route).
   */
  async markRead(userId: string, threadId: string, seq?: number): Promise<ReadState> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<{
      last_read_seq: number;
      last_read_at: Date;
      unread: number;
    }>(
      `WITH up AS (
         INSERT INTO chat_thread_reads AS cr (thread_id, user_id, last_read_seq, last_read_at)
         SELECT t.id, $2, GREATEST(LEAST(COALESCE($3::int, t.next_seq - 1), t.next_seq - 1), 0), $4
           FROM chat_threads t WHERE t.id = $1
            AND (t.user_id = $2 OR EXISTS (
                  SELECT 1 FROM chat_thread_shares s WHERE s.thread_id = t.id AND s.user_id = $2))
         ON CONFLICT (thread_id, user_id) DO UPDATE
            SET last_read_seq = GREATEST(cr.last_read_seq, EXCLUDED.last_read_seq),
                last_read_at = CASE WHEN EXCLUDED.last_read_seq > cr.last_read_seq THEN EXCLUDED.last_read_at
                                    ELSE cr.last_read_at END
         RETURNING cr.thread_id, cr.last_read_seq, cr.last_read_at)
       SELECT up.last_read_seq, up.last_read_at,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM chat_messages m
                  WHERE m.thread_id = up.thread_id AND m.seq > up.last_read_seq AND m.role IN ('assistant', 'error')
                  LIMIT ${String(UNREAD_CAP)}) u) AS unread
         FROM up`,
      [threadId, userId, seq ?? null, now],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
    return {
      threadId,
      lastReadSeq: r.last_read_seq,
      lastReadAt: r.last_read_at.toISOString(),
      unreadCount: r.unread,
    };
  }

  /** p9-chat-unread: "Mark all as read" — every conversation of the caller (archived ones too). */
  async markAllRead(userId: string): Promise<number> {
    const { rowCount } = await this.deps.pool.query(
      `INSERT INTO chat_thread_reads AS cr (thread_id, user_id, last_read_seq, last_read_at)
       SELECT t.id, t.user_id, t.next_seq - 1, $2 FROM chat_threads t WHERE t.user_id = $1
       ON CONFLICT (thread_id, user_id) DO UPDATE
          SET last_read_seq = EXCLUDED.last_read_seq, last_read_at = EXCLUDED.last_read_at
        WHERE EXCLUDED.last_read_seq > cr.last_read_seq`,
      [userId, this.#now()],
    );
    return rowCount ?? 0;
  }

  /**
   * p9-chat-unread: the caller's unread totals over conversations that are not archived (the nav badge and the
   * tab title): `total` messages (each conversation capped at UNREAD_CAP) in `threads` conversations.
   */
  async unreadSummary(userId: string): Promise<{ total: number; threads: number }> {
    const { rows } = await this.deps.pool.query<{ total: number; threads: number }>(
      `SELECT COALESCE(sum(x.unread), 0)::int AS total, count(*) FILTER (WHERE x.unread > 0)::int AS threads
         FROM (SELECT ${UNREAD_SQL} AS unread
                 FROM chat_threads t
                 LEFT JOIN chat_thread_reads r ON r.thread_id = t.id AND r.user_id = $1
                WHERE t.user_id = $1 AND t.archived_at IS NULL
                  AND t.next_seq - 1 > COALESCE(r.last_read_seq, 0)) x`,
      [userId],
    );
    return { total: rows[0]?.total ?? 0, threads: rows[0]?.threads ?? 0 };
  }

  // ------------------------------------------------------------------------------------------ messages

  /** `current`: only rows that are not superseded (the model history, exports). */
  async messages(threadId: string, opts: { limit?: number; current?: boolean } = {}): Promise<MessageView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), MAX_MESSAGES_PER_THREAD);
    const { rows } = await this.deps.pool.query<MessageRow>(
      `SELECT * FROM (
         SELECT ${MESSAGE_COLUMNS} FROM chat_messages
          WHERE thread_id = $1 AND ($3::boolean OR superseded_at IS NULL)
          ORDER BY seq DESC LIMIT $2) m
       ORDER BY seq`,
      [threadId, limit, opts.current !== true],
    );
    return rows.map(messageView);
  }

  /** p16-chat-complete: one message of a thread (null: none). */
  async message(threadId: string, id: string, db: Queryable = this.deps.pool): Promise<MessageView | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE thread_id = $1 AND id = $2`,
      [threadId, id],
    );
    const r = rows[0];
    return r === undefined ? null : messageView(r);
  }

  /** p16-chat-complete: the last current (not superseded) user message of a thread. */
  async lastUserMessage(threadId: string, db: Queryable = this.deps.pool): Promise<MessageView | null> {
    const { rows } = await db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages
        WHERE thread_id = $1 AND role = 'user' AND superseded_at IS NULL ORDER BY seq DESC LIMIT 1`,
      [threadId],
    );
    const r = rows[0];
    return r === undefined ? null : messageView(r);
  }

  /**
   * p16-chat-complete: marks the current rows of a thread from `fromSeq` (to before `untilSeq`) superseded by `by`, and
   * dismisses the open cards of the turns they belonged to (prepared for a conversation that no longer stands).
   */
  async supersede(
    db: Queryable,
    threadId: string,
    range: { readonly fromSeq: number; readonly untilSeq?: number; readonly extraTurns?: readonly string[] },
    by: string,
  ): Promise<{ messages: number; dismissedDrafts: string[] }> {
    const now = this.#now();
    const { rows } = await db.query<{ turn_id: string | null; draft_id: string | null }>(
      `UPDATE chat_messages SET superseded_at = $4, superseded_by = $5
        WHERE thread_id = $1 AND seq >= $2 AND ($3::int IS NULL OR seq < $3) AND superseded_at IS NULL
        RETURNING turn_id::text AS turn_id, meta->>'draftId' AS draft_id`,
      [threadId, range.fromSeq, range.untilSeq ?? null, now, by],
    );
    const turns = [
      ...new Set([
        ...rows.map((r) => r.turn_id).filter((t): t is string => t !== null),
        ...(range.extraTurns ?? []),
      ]),
    ];
    const drafts = rows.map((r) => r.draft_id).filter((d): d is string => d !== null && UUID.test(d));
    const dismissed =
      turns.length === 0 && drafts.length === 0
        ? []
        : (
            await db.query<{ id: string }>(
              `UPDATE chat_drafts SET state = 'dismissed', result = $4, decided_at = $5
                WHERE thread_id = $1 AND state = 'proposed'
                  AND (turn_id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))
                RETURNING id::text AS id`,
              [threadId, turns, drafts, JSON.stringify({ reason: 'superseded' }), now],
            )
          ).rows.map((r) => r.id);
    return { messages: rows.length, dismissedDrafts: dismissed };
  }

  /**
   * p16-chat-complete (replay rule): the turns that answered the current rows from `fromSeq` on (and the turns answering
   * `messageIds`), with their persisted non-read tool calls, their acting tool rows and their cards.
   */
  async turnEffects(threadId: string, fromSeq: number, messageIds: readonly string[]): Promise<TurnEffects> {
    const { rows: turns } = await this.deps.pool.query<{ id: string; actions: number }>(
      `SELECT t.id::text AS id, t.actions FROM chat_turns t
        WHERE t.thread_id = $1
          AND (t.message_id = ANY($3::uuid[])
               OR t.id IN (SELECT m.turn_id FROM chat_messages m
                            WHERE m.thread_id = $1 AND m.seq >= $2 AND m.superseded_at IS NULL
                              AND m.turn_id IS NOT NULL))`,
      [threadId, fromSeq, messageIds],
    );
    const ids = turns.map((t) => t.id);
    if (ids.length === 0) return { actions: 0, turnIds: [], tools: [], cards: [] };
    const [tools, cards] = await Promise.all([
      this.deps.pool.query<{ name: string | null; content: string }>(
        `SELECT meta->>'name' AS name, content FROM chat_messages
          WHERE thread_id = $1 AND role = 'tool' AND turn_id = ANY($2::uuid[]) ORDER BY seq LIMIT 50`,
        [threadId, ids],
      ),
      this.deps.pool.query<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM chat_drafts WHERE thread_id = $1 AND turn_id = ANY($2::uuid[])
          ORDER BY created_at LIMIT 50`,
        [threadId, ids],
      ),
    ]);
    const now = this.#now();
    return {
      actions: turns.reduce((n, t) => n + t.actions, 0),
      turnIds: ids,
      tools: tools.rows
        .filter((t) => t.name !== null && toolKind(t.name) !== 'read')
        .map((t) => ({ name: t.name ?? '', summary: t.content.slice(0, 300) })),
      cards: cards.rows.map((r) => {
        const d = draftRecord(r, now);
        return { id: d.id, kind: d.kind, title: d.title, state: d.state };
      }),
    };
  }

  async addMessage(
    threadId: string,
    m: { role: MessageRole; content: string; meta?: Record<string, unknown>; turnId?: string },
    db?: Queryable,
  ): Promise<MessageView> {
    const run = async (tx: Queryable): Promise<MessageView> => {
      const now = this.#now();
      const { rows: seqRows } = await tx.query<{ seq: number }>(
        `UPDATE chat_threads SET next_seq = next_seq + 1, updated_at = $2 WHERE id = $1
         RETURNING next_seq - 1 AS seq`,
        [threadId, now],
      );
      const seq = seqRows[0]?.seq;
      if (seq === undefined) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
      const id = randomUUID();
      const content = m.content.length > 262_144 ? `${m.content.slice(0, 262_143)}…` : m.content;
      await tx.query(
        `INSERT INTO chat_messages (id, thread_id, seq, role, content, meta, turn_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          threadId,
          seq,
          m.role,
          content,
          m.meta === undefined ? null : JSON.stringify(m.meta),
          m.turnId ?? null,
          now,
        ],
      );
      return {
        id,
        seq,
        role: m.role,
        content,
        meta: viewMeta(m.meta ?? null),
        turnId: m.turnId ?? null,
        createdAt: now.toISOString(),
      };
    };
    return db === undefined ? withTransaction(this.deps.pool, run) : run(db);
  }

  async messageCount(threadId: string): Promise<number> {
    const { rows } = await this.deps.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chat_messages WHERE thread_id = $1',
      [threadId],
    );
    return rows[0]?.n ?? 0;
  }

  // --------------------------------------------------------------------------------------------- turns

  async createTurn(
    t: {
      id: string;
      threadId: string;
      userId: string;
      workerId: string;
      runtime: string;
      model: string | undefined;
      /** p15-chat-failover: the lost turn this one re-runs (or that an earlier turn of the message re-ran). */
      rerunOf?: string;
      /** p16-chat-complete: the user message it answers, why it was started, and the replica that sends it. */
      messageId?: string;
      origin?: TurnOrigin;
      runner?: string;
    },
    db: Queryable = this.deps.pool,
  ): Promise<void> {
    await db.query(
      `INSERT INTO chat_turns (id, thread_id, user_id, worker_id, runtime, model, state, created_at, rerun_of,
                               message_id, origin, runner)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7, $8, $9, $10, $11)`,
      [
        t.id,
        t.threadId,
        t.userId,
        t.workerId,
        t.runtime,
        t.model ?? null,
        this.#now(),
        t.rerunOf ?? null,
        t.messageId ?? null,
        t.origin ?? null,
        t.runner ?? null,
      ],
    );
  }

  /** p16-chat-complete: the replica that sends the turn to its worker (an orphan's runner is gone). */
  async setRunner(turnId: string, runner: string): Promise<void> {
    await this.deps.pool.query('UPDATE chat_turns SET runner = $2 WHERE id = $1', [turnId, runner]);
  }

  /** p16-chat-complete: a non-read tool call arrived for the turn (persisted before it runs). */
  async countAction(turnId: string): Promise<void> {
    await this.deps.pool.query('UPDATE chat_turns SET actions = actions + 1 WHERE id = $1', [turnId]);
  }

  /** p16-chat-complete: a turn row (origin and model of a dispatched turn, the restart recovery). */
  async turnRow(turnId: string): Promise<OpenTurnRow | null> {
    const { rows } = await this.deps.pool.query<OpenTurnRow>(
      `SELECT ${TURN_COLUMNS} FROM chat_turns WHERE id = $1`,
      [turnId],
    );
    return rows[0] ?? null;
  }

  /** p16-chat-complete: open turns created before `before` (orphans of a stopped master, decided by `runner`). */
  async openTurnsBefore(before: Date, limit = 100): Promise<OpenTurnRow[]> {
    const { rows } = await this.deps.pool.query<OpenTurnRow>(
      `SELECT ${TURN_COLUMNS} FROM chat_turns WHERE state IN ('sent', 'running') AND created_at < $1
        ORDER BY created_at LIMIT $2`,
      [before, limit],
    );
    return rows;
  }

  /** The open (sent/running) turn of a thread, if any. */
  async openTurn(threadId: string): Promise<{ id: string; createdAt: Date } | null> {
    const { rows } = await this.deps.pool.query<{ id: string; created_at: Date }>(
      `SELECT id::text AS id, created_at FROM chat_turns WHERE thread_id = $1 AND state IN ('sent', 'running')
        ORDER BY created_at DESC LIMIT 1`,
      [threadId],
    );
    const r = rows[0];
    return r === undefined ? null : { id: r.id, createdAt: r.created_at };
  }

  async markRunning(turnId: string): Promise<void> {
    await this.deps.pool.query(`UPDATE chat_turns SET state = 'running' WHERE id = $1 AND state = 'sent'`, [
      turnId,
    ]);
  }

  async countToolCall(turnId: string): Promise<void> {
    await this.deps.pool.query('UPDATE chat_turns SET tool_calls = tool_calls + 1 WHERE id = $1', [turnId]);
  }

  /** Ends a turn once (later updates are ignored); returns false when it had already ended. */
  async finishTurn(
    turnId: string,
    end: { state: 'done' | 'failed' | 'cancelled'; reason?: string; usage?: AssistantUsage },
  ): Promise<boolean> {
    const u = end.usage;
    const { rowCount } = await this.deps.pool.query(
      `UPDATE chat_turns
          SET state = $2, reason = $3, input_tokens = $4, output_tokens = $5, cache_read_tokens = $6,
              cache_write_tokens = $7, cost_usd = $8, provenance = $9, auth_mode = $10, finished_at = $11
        WHERE id = $1 AND state IN ('sent', 'running')`,
      [
        turnId,
        end.state,
        end.reason ?? null,
        u?.inputTokens ?? null,
        u?.outputTokens ?? null,
        u?.cacheReadTokens ?? null,
        u?.cacheWriteTokens ?? null,
        u?.costUsd ?? null,
        u?.provenance ?? null,
        u?.authMode ?? null,
        this.#now(),
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Open turns older than `before` (lost answers) — the sweeper fails them. */
  async staleTurns(before: Date): Promise<{ id: string; threadId: string | null; workerId: string }[]> {
    const { rows } = await this.deps.pool.query<{ id: string; thread_id: string | null; worker_id: string }>(
      `SELECT id::text AS id, thread_id::text AS thread_id, worker_id FROM chat_turns
        WHERE state IN ('sent', 'running') AND created_at < $1 LIMIT 200`,
      [before],
    );
    return rows.map((r) => ({ id: r.id, threadId: r.thread_id, workerId: r.worker_id }));
  }

  /** Token and dollar use since `from` (one user or everyone). */
  async usageSince(
    from: Date,
    userId?: string,
  ): Promise<{
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    unknownTurns: number;
  }> {
    const { rows } = await this.deps.pool.query<{
      turns: number;
      input: string | null;
      output: string | null;
      cost: string | null;
      unknown: number;
    }>(
      `SELECT count(*)::int AS turns, sum(input_tokens)::text AS input, sum(output_tokens)::text AS output,
              sum(cost_usd)::text AS cost,
              count(*) FILTER (WHERE state NOT IN ('sent', 'running') AND input_tokens IS NULL)::int AS unknown
         FROM chat_turns WHERE created_at >= $1 AND ($2::uuid IS NULL OR user_id = $2)`,
      [from, userId ?? null],
    );
    const r = rows[0];
    return {
      turns: r?.turns ?? 0,
      inputTokens: Number(r?.input ?? 0),
      outputTokens: Number(r?.output ?? 0),
      costUsd: Number(r?.cost ?? 0),
      unknownTurns: r?.unknown ?? 0,
    };
  }

  // -------------------------------------------------------------------------------------------- drafts

  async createDraft(d: {
    threadId: string;
    userId: string;
    turnId: string;
    kind: DraftKind;
    title: string;
    payload: Record<string, unknown>;
    project: string | null;
    /** p16-workflow-quality: `invalid` stores a refused attempt hidden (no card); default `proposed`. */
    state?: 'proposed' | 'invalid';
  }): Promise<DraftRecord> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<DraftRow>(
      `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12, $10, $11)
       RETURNING ${DRAFT_COLUMNS}`,
      [
        randomUUID(),
        d.threadId,
        d.userId,
        d.turnId,
        d.kind,
        cleanTitle(d.title) ?? d.kind,
        JSON.stringify(d.payload),
        payloadHash(d.payload),
        d.project,
        now,
        new Date(now.getTime() + DRAFT_TTL_MS),
        d.state ?? 'proposed',
      ],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('draft insert returned nothing');
    // p22-workflow-draft-supersede: a new workflow card replaces the caller's open cards of the same workflow (project
    // and name) in this conversation — two open cards of one workflow (both "v7 → v8") would let the older one be
    // confirmed by mistake. The older card reads "replaced by the edited version", as after "Sohbette düzenle".
    const name = d.payload.name;
    if (d.kind === 'workflow' && (d.state ?? 'proposed') === 'proposed' && typeof name === 'string') {
      await this.deps.pool.query(
        `UPDATE chat_drafts SET state = 'dismissed', result = $6, decided_at = $5
          WHERE thread_id = $1 AND user_id = $2 AND kind = 'workflow' AND state = 'proposed' AND id <> $3
            AND project IS NOT DISTINCT FROM $4 AND payload->>'name' = $7 AND expires_at > $5`,
        [
          d.threadId,
          d.userId,
          r.id,
          d.project,
          now,
          JSON.stringify({ reason: 'superseded', supersededBy: r.id }),
          name,
        ],
      );
    }
    return draftRecord(r, now);
  }

  /**
   * p17-embeddings: an open (proposed, unexpired) card of the same thread and kind that proposes the same thing — the
   * assistant proposing it again (a retried or regenerated turn) gets that one back instead of a second card. Compared
   * without what is generated or derived per proposal ({@link twinKey}: the generated work branch, the review, advice
   * and reuse notes). Null: none.
   */
  async openTwin(
    threadId: string,
    kind: DraftKind,
    payload: Record<string, unknown>,
  ): Promise<DraftRecord | null> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM chat_drafts
        WHERE thread_id = $1 AND kind = $2 AND state = 'proposed' AND expires_at > $3
        ORDER BY created_at DESC LIMIT 20`,
      [threadId, kind, now],
    );
    const key = twinKey(payload);
    const r = rows.find((row) => twinKey(row.payload) === key);
    return r === undefined ? null : draftRecord(r, now);
  }

  /** The draft if `userId` owns it (else 404). */
  async draft(userId: string, draftId: string, db: Queryable = this.deps.pool): Promise<DraftRecord> {
    const { rows } = await db.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM chat_drafts WHERE id = $1 AND user_id = $2`,
      [draftId, userId],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'draft_not_found', 'Draft not found.');
    return draftRecord(r, this.#now());
  }

  /** The thread's cards (p16-workflow-quality: refused `invalid` attempts are never listed). */
  async drafts(threadId: string): Promise<DraftRecord[]> {
    const { rows } = await this.deps.pool.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS} FROM chat_drafts WHERE thread_id = $1 AND state <> 'invalid' ORDER BY created_at`,
      [threadId],
    );
    const now = this.#now();
    return rows.map((r) => draftRecord(r, now));
  }

  /**
   * p16-workflow-quality: every draft of a turn, oldest first, refused (`invalid`) attempts included — what the
   * give-up line of a turn is decided from.
   */
  async turnDrafts(turnId: string): Promise<DraftRecord[]> {
    // Same-millisecond drafts keep the order of their tool messages (the conversation's `seq`).
    const { rows } = await this.deps.pool.query<DraftRow>(
      `SELECT ${DRAFT_COLUMNS_D}
         FROM chat_drafts d
         LEFT JOIN LATERAL (SELECT min(m.seq) AS seq FROM chat_messages m
                             WHERE m.thread_id = d.thread_id AND m.meta->>'draftId' = d.id::text) x ON true
        WHERE d.turn_id = $1 ORDER BY d.created_at, x.seq NULLS LAST, d.id`,
      [turnId],
    );
    const now = this.#now();
    return rows.map((r) => draftRecord(r, now));
  }

  /**
   * p12-diyalog-f3: replaces an open draft's title, project and payload (and its hash) with an edited version — only
   * while it is still proposed, unexpired and unchanged since `expectHash` was read (a concurrent edit or confirmation
   * wins; null here). The expiry stays as proposed.
   */
  async reviseDraft(
    draftId: string,
    userId: string,
    expectHash: string,
    next: { title: string; project: string | null; payload: Record<string, unknown> },
  ): Promise<DraftRecord | null> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<DraftRow>(
      `UPDATE chat_drafts SET title = $4, project = $5, payload = $6, payload_hash = $7
        WHERE id = $1 AND user_id = $2 AND state = 'proposed' AND expires_at > $8 AND payload_hash = $3
        RETURNING ${DRAFT_COLUMNS}`,
      [
        draftId,
        userId,
        expectHash,
        cleanTitle(next.title) ?? 'job',
        next.project,
        JSON.stringify(next.payload),
        payloadHash(next.payload),
        now,
      ],
    );
    const r = rows[0];
    return r === undefined ? null : draftRecord(r, now);
  }

  /** oss-sec3: marks an open draft as held because its turn read untrusted content (the card says why). */
  async holdDraft(draftId: string, reason: 'untrusted_content'): Promise<DraftRecord | null> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<DraftRow>(
      `UPDATE chat_drafts SET held = $2 WHERE id = $1 AND state = 'proposed' RETURNING ${DRAFT_COLUMNS}`,
      [draftId, reason],
    );
    const r = rows[0];
    return r === undefined ? null : draftRecord(r, now);
  }

  /** Moves a proposed draft to its final state once (concurrent confirmations: exactly one wins). */
  async decideDraft(
    draftId: string,
    state: 'confirmed' | 'dismissed' | 'failed',
    result: Record<string, unknown> | null,
    db: Queryable = this.deps.pool,
  ): Promise<boolean> {
    const now = this.#now();
    const { rowCount } = await db.query(
      `UPDATE chat_drafts SET state = $2, result = $3, decided_at = $4
        WHERE id = $1 AND state = 'proposed' AND expires_at > $4`,
      [draftId, state, result === null ? null : JSON.stringify(result), now],
    );
    return (rowCount ?? 0) > 0;
  }
}

/** p16-chat-complete: why a turn was started besides a plain message. */
export type TurnOrigin = 'regenerate' | 'retry' | 'edit' | 'restart';

/** p16-chat-complete: a turn row as the restart recovery and a dispatch read it. */
export interface OpenTurnRow {
  readonly id: string;
  readonly thread_id: string | null;
  readonly user_id: string;
  readonly worker_id: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly state: string;
  readonly message_id: string | null;
  readonly actions: number;
  readonly rerun_of: string | null;
  readonly runner: string | null;
  readonly origin: TurnOrigin | null;
  readonly created_at: Date;
}

const TURN_COLUMNS = `id::text AS id, thread_id::text AS thread_id, user_id::text AS user_id, worker_id, runtime,
  model, state, message_id::text AS message_id, actions, rerun_of::text AS rerun_of, runner, origin, created_at`;

const MESSAGE_COLUMNS = `id::text AS id, seq, role, content, meta, turn_id::text AS turn_id, created_at,
  superseded_at, superseded_by::text AS superseded_by`;

interface MessageRow {
  id: string;
  seq: number;
  role: MessageRole;
  content: string;
  meta: Record<string, unknown> | null;
  turn_id: string | null;
  created_at: Date;
  superseded_at: Date | null;
  superseded_by: string | null;
}

function messageView(r: MessageRow): MessageView {
  return {
    id: r.id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    meta: viewMeta(r.meta),
    turnId: r.turn_id,
    createdAt: r.created_at.toISOString(),
    ...(r.superseded_at === null
      ? {}
      : { supersededAt: r.superseded_at.toISOString(), supersededBy: r.superseded_by ?? '' }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The kind of an assistant tool by name (an unknown name counts as acting: the replay rule stays safe). */
function toolKind(name: string): string {
  return (ASSISTANT_TOOLS as Record<string, { kind: string } | undefined>)[name]?.kind ?? 'unknown';
}

function cleanTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const t = title
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return t === '' ? undefined : t;
}
