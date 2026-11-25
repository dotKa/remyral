import type { AuditRecorder } from '../audit/audit.js';
import { authorize, roleAtLeast, type Subject } from '../authz/model.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import { buildExport, type ExportDoc } from './export.js';
import {
  type ChatStore,
  draftView,
  type DraftView,
  MAX_THREADS_PER_USER,
  type MessageView,
  type ThreadView,
} from './store.js';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §4): read-only readers of a conversation and handing it over.
 *
 * The owner adds and removes readers; a reader sees the conversation read-only under "Paylaşılanlar" and may leave.
 * Everything a conversation links to stays behind the READER's own permissions: cards of projects the reader cannot
 * read are reduced to `{restricted: true}`, mention chips of invisible items lose their label, related-knowledge items
 * the reader cannot read are dropped, site upload facts of unreadable projects are hidden. The words of the
 * conversation are shared as written (that is what the owner shares).
 */

export interface ThreadAccess {
  readonly thread: ThreadView;
  readonly role: 'owner' | 'reader';
  readonly owner: { readonly id: string; readonly username: string };
}

export interface SharedThreadItem extends ThreadView {
  readonly owner: { readonly id: string; readonly username: string };
  readonly sharedAt: string;
}

export interface ShareEntry {
  readonly userId: string;
  readonly username: string;
  readonly grantedAt: string;
}

export interface ShareCandidate {
  readonly id: string;
  readonly username: string;
}

/** Most readers per conversation. */
export const MAX_SHARES_PER_THREAD = 50;

const notFound = (): HttpError => new HttpError(404, 'thread_not_found', 'Conversation not found.');

interface ThreadRow {
  id: string;
  title: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  user_id: string;
  owner_name: string;
}

function view(r: ThreadRow): ThreadView {
  return {
    id: r.id,
    title: r.title,
    archived: r.archived_at !== null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ChatShares {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly store: ChatStore;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  /** The caller's access to a conversation: its owner or a reader (else 404, as for any foreign thread). */
  async access(userId: string, threadId: string): Promise<ThreadAccess> {
    if (!UUID.test(threadId)) throw notFound();
    const { rows } = await this.deps.pool.query<ThreadRow & { reader: boolean }>(
      `SELECT t.id::text AS id, t.title, t.archived_at, t.created_at, t.updated_at, t.user_id::text AS user_id,
              u.username AS owner_name,
              EXISTS (SELECT 1 FROM chat_thread_shares s WHERE s.thread_id = t.id AND s.user_id = $2) AS reader
         FROM chat_threads t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`,
      [threadId, userId],
    );
    const r = rows[0];
    if (r === undefined || (r.user_id !== userId && !r.reader)) throw notFound();
    return {
      thread: view(r),
      role: r.user_id === userId ? 'owner' : 'reader',
      owner: { id: r.user_id, username: r.owner_name },
    };
  }

  /** Conversations shared with the caller ("Paylaşılanlar"), most recently active first. */
  async listShared(userId: string, limit = 100): Promise<SharedThreadItem[]> {
    const { rows } = await this.deps.pool.query<ThreadRow & { shared_at: Date }>(
      `SELECT t.id::text AS id, t.title, t.archived_at, t.created_at, t.updated_at, t.user_id::text AS user_id,
              u.username AS owner_name, s.created_at AS shared_at
         FROM chat_thread_shares s
         JOIN chat_threads t ON t.id = s.thread_id
         JOIN users u ON u.id = t.user_id
        WHERE s.user_id = $1
        ORDER BY t.updated_at DESC, t.id DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map((r) => ({
      ...view(r),
      owner: { id: r.user_id, username: r.owner_name },
      sharedAt: r.shared_at.toISOString(),
    }));
  }

  /**
   * p16-chat-complete §3: the export document of a conversation the caller owns or reads — built from the caller's
   * view (a reader's is filtered for them). Audited (`chat.thread.export`, the format).
   */
  async export(subject: Subject, actor: ActorContext, threadId: string, format: string): Promise<ExportDoc> {
    const access = await this.access(subject.userId, threadId);
    const [messages, drafts, me] = await Promise.all([
      this.deps.store.messages(threadId, { limit: 2_000 }),
      this.deps.store.drafts(threadId),
      this.deps.pool.query<{ username: string }>('SELECT username FROM users WHERE id = $1', [
        subject.userId,
      ]),
    ]);
    const views = drafts.map(draftView);
    const shown =
      access.role === 'reader' ? readerView(subject, messages, views) : { messages, drafts: views };
    const doc = buildExport({
      thread: access.thread,
      owner: access.owner.username,
      exportedBy: me.rows[0]?.username ?? subject.userId,
      access: access.role,
      messages: shown.messages,
      drafts: shown.drafts,
      now: this.deps.clock(),
    });
    await this.deps.audit.record({
      actor: { type: 'user', id: subject.userId },
      action: 'chat.thread.export',
      target: `chat-thread:${threadId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { format, access: access.role, items: doc.items.length },
    });
    return doc;
  }

  /** The readers of one of the caller's conversations. */
  async shares(ownerId: string, threadId: string): Promise<ShareEntry[]> {
    await this.deps.store.thread(ownerId, threadId);
    const { rows } = await this.deps.pool.query<{ user_id: string; username: string; created_at: Date }>(
      `SELECT s.user_id::text AS user_id, u.username, s.created_at FROM chat_thread_shares s
         JOIN users u ON u.id = s.user_id WHERE s.thread_id = $1 ORDER BY s.created_at, u.username`,
      [threadId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      grantedAt: r.created_at.toISOString(),
    }));
  }

  /** Active users the caller may share with (never the caller), matched by name. */
  async candidates(userId: string, q: string): Promise<ShareCandidate[]> {
    const text = q.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
    const { rows } = await this.deps.pool.query<{ id: string; username: string }>(
      `SELECT id::text AS id, username FROM users
        WHERE disabled_at IS NULL AND id <> $1 AND ($2 = '' OR username ILIKE '%' || $2 || '%')
        ORDER BY username LIMIT 20`,
      [userId, text],
    );
    return rows;
  }

  async #activeUser(id: string): Promise<{ id: string; username: string }> {
    if (!UUID.test(id)) throw new HttpError(404, 'user_not_found', 'The user does not exist.');
    const { rows } = await this.deps.pool.query<{ id: string; username: string }>(
      'SELECT id::text AS id, username FROM users WHERE id = $1 AND disabled_at IS NULL',
      [id],
    );
    const u = rows[0];
    if (u === undefined) throw new HttpError(404, 'user_not_found', 'The user does not exist.');
    return u;
  }

  /** Gives `targetId` read access to one of the owner's conversations (idempotent; audited). */
  async add(actor: ActorContext, threadId: string, targetId: string): Promise<ShareEntry[]> {
    const ownerId = actor.userId;
    await this.deps.store.thread(ownerId, threadId);
    if (targetId === ownerId)
      throw new HttpError(
        400,
        'share_self',
        'The conversation is already yours.',
        {},
        {},
        { reason: 'self' },
      );
    const target = await this.#activeUser(targetId);
    const { rows } = await this.deps.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM chat_thread_shares WHERE thread_id = $1',
      [threadId],
    );
    if ((rows[0]?.n ?? 0) >= MAX_SHARES_PER_THREAD)
      throw new HttpError(409, 'too_many_shares', 'This conversation has too many readers.');
    const { rowCount } = await this.deps.pool.query(
      `INSERT INTO chat_thread_shares (thread_id, user_id, granted_by, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (thread_id, user_id) DO NOTHING`,
      [threadId, target.id, ownerId, this.deps.clock()],
    );
    if ((rowCount ?? 0) > 0) {
      await this.deps.audit.record({
        actor: { type: 'user', id: ownerId },
        action: 'chat.thread.share',
        target: `chat-thread:${threadId}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reader: target.id, readerName: target.username },
      });
    }
    return this.shares(ownerId, threadId);
  }

  /** Removes a reader: the owner removes anyone, a reader removes themselves ("leave"). Audited. */
  async remove(actor: ActorContext, threadId: string, targetId: string): Promise<void> {
    const access = await this.access(actor.userId, threadId);
    if (access.role === 'reader' && targetId !== actor.userId) throw notFound();
    const { rowCount } = await this.deps.pool.query(
      'DELETE FROM chat_thread_shares WHERE thread_id = $1 AND user_id = $2',
      [threadId, UUID.test(targetId) ? targetId : '00000000-0000-0000-0000-000000000000'],
    );
    if ((rowCount ?? 0) === 0) throw new HttpError(404, 'share_not_found', 'This person is not a reader.');
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'chat.thread.unshare',
      target: `chat-thread:${threadId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { reader: targetId, ...(access.role === 'reader' ? { left: true } : {}) },
    });
  }

  /**
   * Hands one of the caller's conversations over to `targetId` (design §4): the thread, its cards (open ones dismissed:
   * they were prepared with the old owner's permissions) and files move; the old owner's organisation of it and its
   * user-scope search vectors go (the indexer redoes them for the new owner); active watches end; pending question
   * cards are cancelled; with `keepAccess` the old owner stays a reader. Audited.
   */
  async transfer(
    actor: ActorContext,
    threadId: string,
    targetId: string,
    keepAccess: boolean,
  ): Promise<ThreadView> {
    const ownerId = actor.userId;
    if (targetId === ownerId)
      throw new HttpError(
        400,
        'share_self',
        'The conversation is already yours.',
        {},
        {},
        { reason: 'self' },
      );
    const target = await this.#activeUser(targetId);
    const now = this.deps.clock();
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id::text AS id FROM chat_threads WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [threadId, ownerId],
      );
      if (rows[0] === undefined) throw notFound();
      const { rows: count } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chat_threads WHERE user_id = $1',
        [target.id],
      );
      if ((count[0]?.n ?? 0) >= MAX_THREADS_PER_USER)
        throw new HttpError(409, 'target_too_many_threads', 'The new owner has too many conversations.');
      const { rows: open } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_turns WHERE thread_id = $1 AND state IN ('sent', 'running')`,
        [threadId],
      );
      if ((open[0]?.n ?? 0) > 0)
        throw new HttpError(
          409,
          'turn_in_progress',
          'The assistant is still answering in this conversation.',
        );
      await tx.query(
        `UPDATE chat_threads SET user_id = $2, updated_at = $3, search_synced_at = NULL, links_synced_at = NULL
          WHERE id = $1`,
        [threadId, target.id, now],
      );
      const dismissed = await tx.query(
        `UPDATE chat_drafts SET state = 'dismissed', result = $2, decided_at = $3
          WHERE thread_id = $1 AND state = 'proposed'`,
        [threadId, JSON.stringify({ reason: 'transferred' }), now],
      );
      await tx.query('UPDATE chat_drafts SET user_id = $2 WHERE thread_id = $1', [threadId, target.id]);
      await tx.query('UPDATE chat_attachments SET user_id = $2 WHERE thread_id = $1', [threadId, target.id]);
      for (const table of [
        'chat_thread_pins',
        'chat_thread_groups',
        'chat_thread_tags',
        'chat_message_stars',
      ])
        await tx.query(`DELETE FROM ${table} WHERE thread_id = $1 AND user_id = $2`, [threadId, ownerId]);
      await tx.query(`DELETE FROM chat_embeddings WHERE thread_id = $1 AND scope = 'user'`, [threadId]);
      // p18-leftovers: the plans' vectors were the previous owner's (the chat pass indexes them for the new one).
      await tx.query('DELETE FROM chat_plan_embeddings WHERE thread_id = $1', [threadId]);
      await tx.query('UPDATE chat_plans SET search_synced_at = NULL WHERE thread_id = $1', [threadId]);
      const watches = await tx.query(
        `UPDATE chat_watches SET state = 'cancelled', end_reason = 'conversation handed over', ended_at = $2,
                updated_at = $2
          WHERE thread_id = $1 AND state = 'active'`,
        [threadId, now],
      );
      await tx.query(
        `UPDATE user_questions SET state = 'cancelled', closed_at = $2, close_reason = 'transferred'
          WHERE thread_id = $1 AND state = 'pending'`,
        [threadId, now],
      );
      await tx.query('DELETE FROM chat_thread_shares WHERE thread_id = $1 AND user_id = $2', [
        threadId,
        target.id,
      ]);
      if (keepAccess) {
        await tx.query(
          `INSERT INTO chat_thread_shares (thread_id, user_id, granted_by, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (thread_id, user_id) DO NOTHING`,
          [threadId, ownerId, ownerId, now],
        );
      }
      return { dismissed: dismissed.rowCount ?? 0, watches: watches.rowCount ?? 0 };
    });
    await this.deps.audit.record({
      actor: { type: 'user', id: ownerId },
      action: 'chat.thread.transfer',
      target: `chat-thread:${threadId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        to: target.id,
        toName: target.username,
        keepAccess,
        dismissedCards: out.dismissed,
        endedWatches: out.watches,
      },
    });
    return this.deps.store.thread(target.id, threadId);
  }
}

// ------------------------------------------------------------------------------------------ per-viewer filter

/** A card the reader may not see: kind, state and times only. */
export function restrictedDraft(d: DraftView): DraftView & { restricted: true } {
  return {
    id: d.id,
    threadId: d.threadId,
    kind: d.kind,
    title: '',
    payload: {},
    project: null,
    state: d.state,
    result: null,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    decidedAt: d.decidedAt,
    restricted: true,
  };
}

/** Whether `subject` may see a card of `project` (project-less cards: administrators only). */
export function canSeeCard(subject: Subject, project: string | null): boolean {
  if (project === null) return roleAtLeast(subject.role, 'admin');
  return authorize(subject, 'jobs.read', { project }).allow;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    : [];
}

/** A message's meta as `subject` (a reader, not the owner) may see it. */
export function readerMeta(
  subject: Subject,
  meta: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (meta === null) return null;
  const out: Record<string, unknown> = { ...meta };
  const readable = (p: unknown): boolean =>
    typeof p === 'string' && authorize(subject, 'projects.read', { project: p }).allow;
  if (Array.isArray(meta.mentions)) {
    out.mentions = list(meta.mentions).map((c) => {
      const type = c.type;
      // Another user's conversation and vault names stay the owner's; machines need the fleet view.
      const visible =
        type === 'thread' || type === 'credential' || type === 'folder'
          ? false
          : type === 'worker'
            ? authorize(subject, 'workers.read').allow
            : type === 'project'
              ? readable(c.id)
              : readable(c.project);
      return visible ? c : { type, id: '', project: null, label: '', restricted: true };
    });
  }
  const related: unknown = meta.related;
  if (typeof related === 'object' && related !== null) {
    out.related = {
      ...related,
      items: list((related as { items?: unknown }).items).filter(
        (i) => i.kind !== 'own_chat' && i.kind !== 'project_chat' && readable(i.project),
      ),
    };
  }
  if (Array.isArray(meta.siteUploads)) {
    out.siteUploads = list(meta.siteUploads).filter(
      (u) => typeof u.project === 'string' && authorize(subject, 'deploy.read', { project: u.project }).allow,
    );
  }
  delete out.workflowAi;
  return out;
}

/** The thread view a reader gets: messages and cards filtered for them (design §4). */
export function readerView(
  subject: Subject,
  messages: readonly MessageView[],
  drafts: readonly DraftView[],
): { messages: MessageView[]; drafts: DraftView[] } {
  const hidden = new Set(drafts.filter((d) => !canSeeCard(subject, d.project)).map((d) => d.id));
  return {
    messages: messages.map((m) => {
      // A tool line names its card ("draft_job: card “…”"): for a hidden card only the tool's name stays.
      const draftId = m.meta?.draftId;
      const content =
        m.role === 'tool' && typeof draftId === 'string' && hidden.has(draftId)
          ? typeof m.meta?.name === 'string'
            ? m.meta.name
            : 'tool'
          : m.content;
      return { ...m, content, meta: readerMeta(subject, m.meta) };
    }),
    drafts: drafts.map((d) => (hidden.has(d.id) ? restrictedDraft(d) : d)),
  };
}
