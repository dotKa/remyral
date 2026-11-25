import { randomUUID } from 'node:crypto';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p10-chat-organize (docs/design/p10-chat-organize.md, migration 0080): the caller's own organisation of the ops chat —
 * pinned conversations, groups (at most one per conversation), coloured tags and starred messages. Every read and write
 * takes the caller's user id; another user's conversation, message, group or tag is "not found" (no oracle), and the
 * composite foreign keys make a cross-user reference impossible in the database as well.
 */

export const TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const MAX_PINS = 20;
export const MAX_GROUPS = 50;
export const MAX_TAGS = 100;
export const MAX_TAGS_PER_THREAD = 10;
export const MAX_STARS = 2_000;
export const MAX_GROUP_NAME = 60;
export const MAX_TAG_NAME = 40;

export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly collapsed: boolean;
  /** Conversations in the group that are not archived. */
  readonly threadCount: number;
}

export interface TagView {
  readonly id: string;
  readonly name: string;
  readonly color: TagColor;
  /** Conversations with the tag that are not archived. */
  readonly threadCount: number;
}

export interface OrganizeSummary {
  readonly groups: GroupView[];
  readonly tags: TagView[];
  /** Pinned conversations that are not archived. */
  readonly pinned: number;
}

export interface StarState {
  readonly messageId: string;
  readonly threadId: string;
  readonly starred: boolean;
  readonly starredAt: string | null;
}

const notFound = (what: 'thread' | 'group' | 'tag' | 'message'): HttpError => {
  switch (what) {
    case 'thread':
      return new HttpError(404, 'thread_not_found', 'Conversation not found.');
    case 'group':
      return new HttpError(404, 'group_not_found', 'Group not found.');
    case 'tag':
      return new HttpError(404, 'tag_not_found', 'Tag not found.');
    case 'message':
      return new HttpError(404, 'message_not_found', 'Message not found.');
  }
};

/** Trims, removes control characters and collapses whitespace; undefined when nothing is left. */
export function cleanName(name: string | undefined, max: number): string | undefined {
  if (name === undefined) return undefined;
  const n = name
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return n === '' ? undefined : n;
}

/** Postgres unique violation (a duplicate group / tag name). */
function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

interface GroupRow {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  n: number;
}
interface TagRow {
  id: string;
  name: string;
  color: TagColor;
  n: number;
}

const groupView = (r: GroupRow): GroupView => ({
  id: r.id,
  name: r.name,
  position: r.position,
  collapsed: r.collapsed,
  threadCount: r.n,
});
const tagView = (r: TagRow): TagView => ({ id: r.id, name: r.name, color: r.color, threadCount: r.n });

const GROUP_SQL = `SELECT g.id::text AS id, g.name, g.position, g.collapsed,
         (SELECT count(*)::int FROM chat_thread_groups m JOIN chat_threads t ON t.id = m.thread_id
           WHERE m.group_id = g.id AND m.user_id = g.user_id AND t.archived_at IS NULL) AS n
    FROM chat_groups g`;
const TAG_SQL = `SELECT g.id::text AS id, g.name, g.color,
         (SELECT count(*)::int FROM chat_thread_tags m JOIN chat_threads t ON t.id = m.thread_id
           WHERE m.tag_id = g.id AND m.user_id = g.user_id AND t.archived_at IS NULL) AS n
    FROM chat_tags g`;

export class ChatOrganizer {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly clock: () => Date;
    },
  ) {}

  async #ownThread(db: Queryable, userId: string, threadId: string): Promise<void> {
    const { rows } = await db.query('SELECT 1 FROM chat_threads WHERE id = $1 AND user_id = $2', [
      threadId,
      userId,
    ]);
    if (rows.length === 0) throw notFound('thread');
  }

  // ------------------------------------------------------------------------------------------ summary

  async summary(userId: string): Promise<OrganizeSummary> {
    const [groups, tags, pinned] = await Promise.all([
      this.groups(userId),
      this.tags(userId),
      this.deps.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_thread_pins p JOIN chat_threads t ON t.id = p.thread_id
          WHERE p.user_id = $1 AND t.user_id = $1 AND t.archived_at IS NULL`,
        [userId],
      ),
    ]);
    return { groups, tags, pinned: pinned.rows[0]?.n ?? 0 };
  }

  async groups(userId: string): Promise<GroupView[]> {
    const { rows } = await this.deps.pool.query<GroupRow>(
      `${GROUP_SQL} WHERE g.user_id = $1 ORDER BY g.position, lower(g.name), g.id`,
      [userId],
    );
    return rows.map(groupView);
  }

  async tags(userId: string): Promise<TagView[]> {
    const { rows } = await this.deps.pool.query<TagRow>(
      `${TAG_SQL} WHERE g.user_id = $1 ORDER BY lower(g.name), g.id`,
      [userId],
    );
    return rows.map(tagView);
  }

  // --------------------------------------------------------------------------------------------- pins

  /** Pins or unpins one of the caller's conversations (idempotent; pinning keeps the first pin time). */
  async setPinned(userId: string, threadId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#ownThread(tx, userId, threadId);
      if (!pinned) {
        await tx.query('DELETE FROM chat_thread_pins WHERE thread_id = $1 AND user_id = $2', [
          threadId,
          userId,
        ]);
        return { pinnedAt: null };
      }
      // Serialise the caller's pin changes so the limit holds under concurrent requests.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-pins:${userId}`]);
      const { rows: existing } = await tx.query<{ pinned_at: Date }>(
        'SELECT pinned_at FROM chat_thread_pins WHERE thread_id = $1 AND user_id = $2',
        [threadId, userId],
      );
      const have = existing[0];
      if (have !== undefined) return { pinnedAt: have.pinned_at.toISOString() };
      const { rows: count } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chat_thread_pins WHERE user_id = $1',
        [userId],
      );
      if ((count[0]?.n ?? 0) >= MAX_PINS) {
        throw new HttpError(
          409,
          'too_many_pins',
          `You can pin up to ${String(MAX_PINS)} conversations. Unpin one first.`,
          {},
          {},
          { max: MAX_PINS },
        );
      }
      const now = this.deps.clock();
      await tx.query('INSERT INTO chat_thread_pins (thread_id, user_id, pinned_at) VALUES ($1, $2, $3)', [
        threadId,
        userId,
        now,
      ]);
      return { pinnedAt: now.toISOString() };
    });
  }

  // ------------------------------------------------------------------------------------------- groups

  async createGroup(userId: string, name: string): Promise<GroupView> {
    const n = cleanName(name, MAX_GROUP_NAME);
    if (n === undefined) throw new HttpError(400, 'invalid_name', 'Give the group a name.');
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-groups:${userId}`]);
      const { rows: stat } = await tx.query<{ n: number; pos: number }>(
        'SELECT count(*)::int AS n, COALESCE(max(position) + 1, 0)::int AS pos FROM chat_groups WHERE user_id = $1',
        [userId],
      );
      if ((stat[0]?.n ?? 0) >= MAX_GROUPS) {
        throw new HttpError(
          409,
          'too_many_groups',
          `You can have up to ${String(MAX_GROUPS)} groups.`,
          {},
          {},
          { max: MAX_GROUPS },
        );
      }
      const now = this.deps.clock();
      const id = randomUUID();
      try {
        await tx.query(
          `INSERT INTO chat_groups (id, user_id, name, position, collapsed, created_at, updated_at)
           VALUES ($1, $2, $3, $4, false, $5, $5)`,
          [id, userId, n, Math.min(stat[0]?.pos ?? 0, 100_000), now],
        );
      } catch (err) {
        if (isUnique(err))
          throw new HttpError(409, 'group_exists', 'You already have a group with this name.');
        throw err;
      }
      return { id, name: n, position: stat[0]?.pos ?? 0, collapsed: false, threadCount: 0 };
    });
  }

  async updateGroup(
    userId: string,
    groupId: string,
    patch: { name?: string; collapsed?: boolean; position?: number },
  ): Promise<GroupView> {
    const name = patch.name === undefined ? undefined : cleanName(patch.name, MAX_GROUP_NAME);
    if (patch.name !== undefined && name === undefined) {
      throw new HttpError(400, 'invalid_name', 'Give the group a name.');
    }
    try {
      const { rowCount } = await this.deps.pool.query(
        `UPDATE chat_groups SET name = COALESCE($3, name), collapsed = COALESCE($4, collapsed),
                position = COALESCE($5, position), updated_at = $6
          WHERE id = $1 AND user_id = $2`,
        [groupId, userId, name ?? null, patch.collapsed ?? null, patch.position ?? null, this.deps.clock()],
      );
      if ((rowCount ?? 0) === 0) throw notFound('group');
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, 'group_exists', 'You already have a group with this name.');
      throw err;
    }
    const { rows } = await this.deps.pool.query<GroupRow>(`${GROUP_SQL} WHERE g.id = $1 AND g.user_id = $2`, [
      groupId,
      userId,
    ]);
    const r = rows[0];
    if (r === undefined) throw notFound('group');
    return groupView(r);
  }

  /** Deletes a group; its conversations become ungrouped (nothing else is deleted). */
  async deleteGroup(userId: string, groupId: string): Promise<void> {
    const { rowCount } = await this.deps.pool.query(
      'DELETE FROM chat_groups WHERE id = $1 AND user_id = $2',
      [groupId, userId],
    );
    if ((rowCount ?? 0) === 0) throw notFound('group');
  }

  /** Puts a conversation into one of the caller's groups (moving it out of any other), or ungroups it (null). */
  async setGroup(
    userId: string,
    threadId: string,
    groupId: string | null,
  ): Promise<{ groupId: string | null }> {
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#ownThread(tx, userId, threadId);
      if (groupId === null) {
        await tx.query('DELETE FROM chat_thread_groups WHERE thread_id = $1 AND user_id = $2', [
          threadId,
          userId,
        ]);
        return { groupId: null };
      }
      const { rows } = await tx.query('SELECT 1 FROM chat_groups WHERE id = $1 AND user_id = $2', [
        groupId,
        userId,
      ]);
      if (rows.length === 0) throw notFound('group');
      await tx.query(
        `INSERT INTO chat_thread_groups (thread_id, user_id, group_id, added_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (thread_id, user_id) DO UPDATE
            SET group_id = EXCLUDED.group_id,
                added_at = CASE WHEN chat_thread_groups.group_id = EXCLUDED.group_id
                                THEN chat_thread_groups.added_at ELSE EXCLUDED.added_at END`,
        [threadId, userId, groupId, this.deps.clock()],
      );
      return { groupId };
    });
  }

  // --------------------------------------------------------------------------------------------- tags

  async createTag(userId: string, name: string, color: TagColor): Promise<TagView> {
    const n = cleanName(name, MAX_TAG_NAME);
    if (n === undefined)
      throw new HttpError(400, 'invalid_name', 'Give the tag a name.', {}, {}, { reason: 'tag' });
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-tags:${userId}`]);
      const { rows: stat } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chat_tags WHERE user_id = $1',
        [userId],
      );
      if ((stat[0]?.n ?? 0) >= MAX_TAGS) {
        throw new HttpError(
          409,
          'too_many_tags',
          `You can have up to ${String(MAX_TAGS)} tags.`,
          {},
          {},
          { max: MAX_TAGS },
        );
      }
      const now = this.deps.clock();
      const id = randomUUID();
      try {
        await tx.query(
          `INSERT INTO chat_tags (id, user_id, name, color, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
          [id, userId, n, color, now],
        );
      } catch (err) {
        if (isUnique(err)) throw new HttpError(409, 'tag_exists', 'You already have a tag with this name.');
        throw err;
      }
      return { id, name: n, color, threadCount: 0 };
    });
  }

  async updateTag(
    userId: string,
    tagId: string,
    patch: { name?: string; color?: TagColor },
  ): Promise<TagView> {
    const name = patch.name === undefined ? undefined : cleanName(patch.name, MAX_TAG_NAME);
    if (patch.name !== undefined && name === undefined) {
      throw new HttpError(400, 'invalid_name', 'Give the tag a name.', {}, {}, { reason: 'tag' });
    }
    try {
      const { rowCount } = await this.deps.pool.query(
        `UPDATE chat_tags SET name = COALESCE($3, name), color = COALESCE($4, color), updated_at = $5
          WHERE id = $1 AND user_id = $2`,
        [tagId, userId, name ?? null, patch.color ?? null, this.deps.clock()],
      );
      if ((rowCount ?? 0) === 0) throw notFound('tag');
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, 'tag_exists', 'You already have a tag with this name.');
      throw err;
    }
    const { rows } = await this.deps.pool.query<TagRow>(`${TAG_SQL} WHERE g.id = $1 AND g.user_id = $2`, [
      tagId,
      userId,
    ]);
    const r = rows[0];
    if (r === undefined) throw notFound('tag');
    return tagView(r);
  }

  /** Deletes a tag and removes it from every conversation. */
  async deleteTag(userId: string, tagId: string): Promise<void> {
    const { rowCount } = await this.deps.pool.query('DELETE FROM chat_tags WHERE id = $1 AND user_id = $2', [
      tagId,
      userId,
    ]);
    if ((rowCount ?? 0) === 0) throw notFound('tag');
  }

  /** Replaces the tags of one of the caller's conversations (every id must be one of the caller's tags). */
  async setTags(userId: string, threadId: string, tagIds: readonly string[]): Promise<{ tagIds: string[] }> {
    const ids = [...new Set(tagIds)];
    if (ids.length > MAX_TAGS_PER_THREAD) {
      throw new HttpError(
        400,
        'too_many_tags',
        `A conversation can have up to ${String(MAX_TAGS_PER_THREAD)} tags.`,
        {},
        {},
        { reason: 'thread', max: MAX_TAGS_PER_THREAD },
      );
    }
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#ownThread(tx, userId, threadId);
      if (ids.length > 0) {
        const { rows } = await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM chat_tags WHERE user_id = $1 AND id = ANY($2::uuid[])',
          [userId, ids],
        );
        if ((rows[0]?.n ?? 0) !== ids.length) throw notFound('tag');
      }
      await tx.query(
        'DELETE FROM chat_thread_tags WHERE thread_id = $1 AND user_id = $2 AND NOT (tag_id = ANY($3::uuid[]))',
        [threadId, userId, ids],
      );
      if (ids.length > 0) {
        await tx.query(
          `INSERT INTO chat_thread_tags (thread_id, user_id, tag_id, added_at)
           SELECT $1, $2, x, $4 FROM unnest($3::uuid[]) AS x
           ON CONFLICT (thread_id, tag_id) DO NOTHING`,
          [threadId, userId, ids, this.deps.clock()],
        );
      }
      const { rows } = await tx.query<{ id: string }>(
        `SELECT tag_id::text AS id FROM chat_thread_tags WHERE thread_id = $1 AND user_id = $2
          ORDER BY added_at, tag_id`,
        [threadId, userId],
      );
      return { tagIds: rows.map((r) => r.id) };
    });
  }

  // -------------------------------------------------------------------------------------------- stars

  /** Stars or unstars a user / assistant message of one of the caller's conversations (idempotent). */
  async setStar(userId: string, messageId: string, starred: boolean): Promise<StarState> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ thread_id: string; role: string }>(
        `SELECT m.thread_id::text AS thread_id, m.role FROM chat_messages m
           JOIN chat_threads t ON t.id = m.thread_id
          WHERE m.id = $1 AND t.user_id = $2`,
        [messageId, userId],
      );
      const m = rows[0];
      if (m === undefined) throw notFound('message');
      if (!starred) {
        await tx.query('DELETE FROM chat_message_stars WHERE message_id = $1 AND user_id = $2', [
          messageId,
          userId,
        ]);
        return { messageId, threadId: m.thread_id, starred: false, starredAt: null };
      }
      if (m.role !== 'user' && m.role !== 'assistant') {
        throw new HttpError(
          400,
          'not_starrable',
          'Only your messages and the assistant’s answers can be starred.',
        );
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`chat-stars:${userId}`]);
      const { rows: have } = await tx.query<{ starred_at: Date }>(
        'SELECT starred_at FROM chat_message_stars WHERE message_id = $1 AND user_id = $2',
        [messageId, userId],
      );
      const existing = have[0];
      if (existing !== undefined) {
        return {
          messageId,
          threadId: m.thread_id,
          starred: true,
          starredAt: existing.starred_at.toISOString(),
        };
      }
      const { rows: count } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chat_message_stars WHERE user_id = $1',
        [userId],
      );
      if ((count[0]?.n ?? 0) >= MAX_STARS) {
        throw new HttpError(
          409,
          'too_many_stars',
          `You can star up to ${String(MAX_STARS)} messages.`,
          {},
          {},
          { max: MAX_STARS },
        );
      }
      const now = this.deps.clock();
      await tx.query(
        'INSERT INTO chat_message_stars (message_id, user_id, thread_id, starred_at) VALUES ($1, $2, $3, $4)',
        [messageId, userId, m.thread_id, now],
      );
      return { messageId, threadId: m.thread_id, starred: true, starredAt: now.toISOString() };
    });
  }

  /** Ids of the caller's starred messages in one conversation (the caller owns it: checked by the route). */
  async starredIds(userId: string, threadId: string): Promise<string[]> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT message_id::text AS id FROM chat_message_stars WHERE thread_id = $1 AND user_id = $2
        ORDER BY starred_at, message_id`,
      [threadId, userId],
    );
    return rows.map((r) => r.id);
  }
}
