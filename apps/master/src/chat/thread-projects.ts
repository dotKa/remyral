import { fenceData, MAX_THREAD_PROJECTS } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { projectRoleOf, type Role, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p18-multi-project W3 (docs/design/p18-multi-project.md §2.3, "Built: W3 + W5"): a conversation's **working projects**.
 *
 * The set = `chat_threads.project` (the primary — its "Proje bilgisiyle paylaş" switch stays `project_share`) ∪
 * `chat_thread_projects` (up to 7 more, each with its own `share`). The order is the primary first, then the others in
 * the order they were added. Adding a project needs read access to it (any project role); a member the user lost access
 * to is dropped at their next turn (a notice in the conversation). The set decides:
 *
 * - the knowledge links / sharing of the conversation (every member links the messages like the primary; each member's
 *   own switch, `projectChatEligible`);
 * - the related-knowledge lookup (every member, then @mentions);
 * - the assistant's per-turn "Çalışma projeleri" block and, on a worker with `assistant-projects-v1`, the write rules:
 *   a write outside the set → `project_not_in_thread`, a write without a project while the set has more than one member
 *   where the project is ambiguous → `project_required` (ChatTools), reads without a project → the set.
 *
 * Audit: `chat.thread.projects` (before / after: project ids and switches — never names or texts).
 */

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/u;
const lockKey = (userId: string): string => `chat-knowledge:${userId}`;

export interface ThreadProjectMember {
  readonly project: string;
  /** "Proje bilgisiyle paylaş" for this member (the primary: chat_threads.project_share). */
  readonly share: boolean;
  readonly primary: boolean;
}

/** A member as the console and the assistant see it. */
export interface ThreadProjectView extends ThreadProjectMember {
  readonly name: string;
  readonly kind: 'repository' | 'workspace';
  /** The signed-in user's role in the project (null: no access any more — dropped at the next turn). */
  readonly role: Role | null;
}

export interface ThreadProjectsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
}

/** The members of a thread (primary first), read without access checks. */
export async function threadProjectMembers(db: Queryable, threadId: string): Promise<ThreadProjectMember[]> {
  const { rows } = await db.query<{ project: string | null; project_share: boolean }>(
    'SELECT project, project_share FROM chat_threads WHERE id = $1',
    [threadId],
  );
  const t = rows[0];
  if (t === undefined) return [];
  const { rows: extra } = await db.query<{ project: string; share: boolean }>(
    `SELECT project, share FROM chat_thread_projects WHERE thread_id = $1 ORDER BY added_at, project`,
    [threadId],
  );
  const out: ThreadProjectMember[] = [];
  if (t.project !== null) out.push({ project: t.project, share: t.project_share, primary: true });
  for (const e of extra) {
    if (e.project === t.project) continue;
    out.push({ project: e.project, share: e.share, primary: false });
  }
  return out;
}

/** The project ids of a thread's set (primary first). */
export async function threadProjectIds(db: Queryable, threadId: string): Promise<string[]> {
  return (await threadProjectMembers(db, threadId)).map((m) => m.project);
}

/**
 * The normalised new set of `PUT /chat/threads/:id/projects` / `set_thread_projects`: ids checked, no duplicates, at
 * most {@link MAX_THREAD_PROJECTS}; a member's switch defaults to its current value, else on.
 */
export function normaliseSet(
  input: readonly { readonly project: string; readonly share?: boolean | undefined }[],
  before: readonly ThreadProjectMember[],
): { ok: true; set: ThreadProjectMember[] } | { ok: false; code: string; message: string } {
  if (input.length > MAX_THREAD_PROJECTS)
    return {
      ok: false,
      code: 'too_many_projects',
      message: `A conversation works on at most ${String(MAX_THREAD_PROJECTS)} projects.`,
    };
  const seen = new Set<string>();
  const set: ThreadProjectMember[] = [];
  for (const [i, m] of input.entries()) {
    if (!PROJECT.test(m.project)) return { ok: false, code: 'invalid', message: 'Invalid project id.' };
    if (seen.has(m.project))
      return { ok: false, code: 'invalid', message: `Project ${m.project} is listed twice.` };
    seen.add(m.project);
    const prev = before.find((b) => b.project === m.project);
    set.push({ project: m.project, share: m.share ?? prev?.share ?? true, primary: i === 0 });
  }
  return { ok: true, set };
}

/** What changed between two sets (for the audit and the answer). */
export function setChanges(
  before: readonly ThreadProjectMember[],
  after: readonly ThreadProjectMember[],
): { added: string[]; removed: string[]; shareChanged: string[]; primaryChanged: boolean } {
  const b = new Map(before.map((m) => [m.project, m]));
  const a = new Map(after.map((m) => [m.project, m]));
  return {
    added: after.filter((m) => !b.has(m.project)).map((m) => m.project),
    removed: before.filter((m) => !a.has(m.project)).map((m) => m.project),
    shareChanged: after
      .filter((m) => {
        const p = b.get(m.project);
        return p !== undefined && p.share !== m.share;
      })
      .map((m) => m.project),
    primaryChanged: (before[0]?.project ?? null) !== (after[0]?.project ?? null),
  };
}

/**
 * The "Çalışma projeleri" data block of a turn (fenced; ids, names, kinds, roles, switches — no secrets). Null for a
 * conversation without projects.
 */
export function workingProjectsBlock(view: readonly ThreadProjectView[]): string | null {
  if (view.length === 0) return null;
  return fenceData('Çalışma projeleri (working projects of this conversation)', {
    projects: view.map((v) => ({
      id: v.project,
      name: v.name,
      kind: v.kind,
      role: v.role,
      primary: v.primary,
      sharedWithProjectKnowledge: v.share,
    })),
    rule:
      view.length > 1
        ? 'Every action says which project it is in. Writes must name one of these projects (project); when the user did not make it clear, ask with ask_user. Reads without a project look only at these projects.'
        : 'Every action says which project it is in. Writes go to this project unless the user names another one (then add it with set_thread_projects first).',
  });
}

export class ThreadProjects {
  constructor(private readonly deps: ThreadProjectsDeps) {}

  #now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }

  /** The owner's view of the set (names, kinds, their role). 404 for another user's conversation. */
  async view(
    subject: Subject,
    threadId: string,
    db: Queryable = this.deps.pool,
  ): Promise<ThreadProjectView[]> {
    const { rows: own } = await db.query('SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2', [
      threadId,
      subject.userId,
    ]);
    if (own.length === 0) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
    return this.#describe(subject, await threadProjectMembers(db, threadId), db);
  }

  async #describe(
    subject: Subject,
    members: readonly ThreadProjectMember[],
    db: Queryable,
  ): Promise<ThreadProjectView[]> {
    if (members.length === 0) return [];
    const { rows } = await db.query<{ id: string; name: string; kind: 'repository' | 'workspace' }>(
      'SELECT id, name, kind FROM projects WHERE id = ANY($1::text[])',
      [members.map((m) => m.project)],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return members.map((m) => {
      const p = byId.get(m.project);
      return {
        ...m,
        name: p?.name ?? m.project,
        kind: p?.kind ?? 'repository',
        role: p === undefined ? null : projectRoleOf(subject, m.project),
      };
    });
  }

  /**
   * Replaces the set (the first entry is the primary). Every member must exist and be readable by the caller. Members
   * that leave, and members whose switch turns off, lose their project vectors of this conversation at once; the links
   * are recomputed by the next knowledge pass (or the next header read). Audited `chat.thread.projects`.
   */
  async set(
    subject: Subject,
    threadId: string,
    input: readonly { readonly project: string; readonly share?: boolean | undefined }[],
    meta: {
      readonly ip?: string | null;
      readonly userAgent?: string | null;
      readonly source?: 'console' | 'chat';
    } = {},
  ): Promise<ThreadProjectView[]> {
    const userId = subject.userId;
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', [lockKey(userId)]);
      const { rows: own } = await tx.query(
        'SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [threadId, userId],
      );
      if (own.length === 0) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
      const before = await threadProjectMembers(tx, threadId);
      const norm = normaliseSet(input, before);
      if (!norm.ok)
        throw norm.code === 'too_many_projects'
          ? new HttpError(400, 'too_many_projects', norm.message, {}, {}, { max: MAX_THREAD_PROJECTS })
          : new HttpError(400, 'bad_request', norm.message, {}, {}, { reason: 'thread_projects' });
      const after = norm.set;
      const ids = after.map((m) => m.project);
      if (ids.length > 0) {
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM projects WHERE id = ANY($1::text[])',
          [ids],
        );
        const known = new Set(rows.map((r) => r.id));
        // A project that leaves needs no access (losing access is exactly when one removes it); a kept or new one does.
        for (const p of ids) {
          if (!known.has(p) || projectRoleOf(subject, p) === null)
            throw new HttpError(404, 'project_not_found', 'Project not found.');
        }
      }
      const changes = setChanges(before, after);
      if (
        changes.added.length === 0 &&
        changes.removed.length === 0 &&
        changes.shareChanged.length === 0 &&
        !changes.primaryChanged &&
        before.every((b, i) => after[i]?.project === b.project)
      )
        return this.#describe(subject, after, tx);
      const primary = after[0] ?? null;
      await tx.query(
        `UPDATE chat_threads SET project = $3, project_share = $4, search_synced_at = NULL, links_synced_at = NULL
          WHERE id = $1 AND user_id = $2`,
        [threadId, userId, primary?.project ?? null, primary?.share ?? true],
      );
      const extras = after.slice(1);
      const now = this.#now();
      await tx.query(
        'DELETE FROM chat_thread_projects WHERE thread_id = $1 AND NOT (project = ANY($2::text[]))',
        [threadId, extras.map((m) => m.project)],
      );
      for (const [i, m] of extras.entries()) {
        // Keeps the order of the list (added_at increases with the position for new rows; existing rows keep theirs).
        await tx.query(
          `INSERT INTO chat_thread_projects (thread_id, project, share, added_by, added_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (thread_id, project) DO UPDATE SET share = EXCLUDED.share`,
          [threadId, m.project, m.share, userId, new Date(now.getTime() + i)],
        );
      }
      // Vectors of members that left or stopped sharing; the primary's switch also covers mentioned / drafted projects
      // outside the set (as before the set existed).
      const removed =
        (
          await tx.query(
            `DELETE FROM chat_embeddings e
              WHERE e.thread_id = $1 AND e.scope = 'project'
                AND NOT COALESCE(
                  (SELECT tp.share FROM chat_thread_projects tp WHERE tp.thread_id = $1 AND tp.project = e.project),
                  (SELECT t.project_share FROM chat_threads t WHERE t.id = $1))`,
            [threadId],
          )
        ).rowCount ?? 0;
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'chat.thread.projects',
          target: `chat-thread:${threadId}`,
          outcome: 'success',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            source: meta.source ?? 'console',
            before: before.map((m) => ({ project: m.project, share: m.share })),
            after: after.map((m) => ({ project: m.project, share: m.share })),
            added: changes.added,
            removed: changes.removed,
            removedVectors: removed,
          },
        },
        tx,
      );
      return this.#describe(subject, after, tx);
    });
  }

  /**
   * The set as the turn sees it: members the user can no longer read are dropped (the primary's place goes to the next
   * member) and named in `dropped` — the caller posts a notice. Never throws for a missing conversation (empty set).
   */
  async forTurn(
    subject: Subject,
    threadId: string,
  ): Promise<{ readonly view: ThreadProjectView[]; readonly dropped: string[] }> {
    const members = await threadProjectMembers(this.deps.pool, threadId);
    if (members.length === 0) return { view: [], dropped: [] };
    const view = await this.#describe(subject, members, this.deps.pool);
    const lost = view.filter((v) => v.role === null).map((v) => v.project);
    if (lost.length === 0) return { view, dropped: [] };
    const kept = view.filter((v) => v.role !== null);
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', [lockKey(subject.userId)]);
      const primary = kept[0] ?? null;
      await tx.query(
        `UPDATE chat_threads SET project = $2, project_share = $3, search_synced_at = NULL, links_synced_at = NULL
          WHERE id = $1`,
        [threadId, primary?.project ?? null, primary?.share ?? true],
      );
      await tx.query('DELETE FROM chat_thread_projects WHERE thread_id = $1 AND project = ANY($2::text[])', [
        threadId,
        [...lost, ...(primary === null ? [] : [primary.project])],
      ]);
      await tx.query(
        `DELETE FROM chat_embeddings WHERE thread_id = $1 AND scope = 'project' AND project = ANY($2::text[])`,
        [threadId, lost],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat' },
          action: 'chat.thread.projects',
          target: `chat-thread:${threadId}`,
          outcome: 'success',
          metadata: {
            source: 'access_lost',
            userId: subject.userId,
            removed: lost,
            after: kept.map((m) => ({ project: m.project, share: m.share })),
          },
        },
        tx,
      );
    });
    return {
      view: kept.map((v, i) => ({ ...v, primary: i === 0 })),
      dropped: lost,
    };
  }
}
