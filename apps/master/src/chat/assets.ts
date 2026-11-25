import { decodeCursor, encodeCursor } from '../audit/sql.js';
import { authorize, type Subject } from '../authz/model.js';
import type { Pool } from '../db/pool.js';
import { clampLimit } from '../http/pagination.js';

/**
 * p10-chat-organize §3: the chat sidebar's read model — what one conversation (or all the caller's conversations)
 * contains or produced: starred messages, media, links, files and the work it created. Aggregated from existing rows
 * (messages, stars, attachments, drafts and the jobs / runs / automations / deploys they created, job artifacts); nothing
 * is copied. Scoped to the caller's own threads; job state and job files only for projects the caller can still read.
 */

export const ASSET_KINDS = ['starred', 'media', 'links', 'files', 'jobs'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetItem {
  readonly kind: AssetKind;
  /** Stable, unique within the kind (message id, `att:<id>`, `art:<job>:<attempt>:<artifact>`, the URL, draft id). */
  readonly key: string;
  readonly threadId: string;
  readonly threadTitle: string;
  /** The message to jump to (null when it is no longer there). */
  readonly messageId: string | null;
  readonly seq: number | null;
  readonly createdAt: string;
  readonly label: string;
  readonly detail: string | null;
  /** Same-origin content URL (attachment / artifact) or the external link itself (links). */
  readonly url: string | null;
  /** Console page of the target (job, run, automation, deploy, monitor). */
  readonly href: string | null;
  readonly domain: string | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly role: 'user' | 'assistant' | null;
  readonly source: 'attachment' | 'artifact' | null;
  readonly draftKind: string | null;
  readonly draftState: string | null;
  /** Live state of what the draft created (job / run / automation / deploy / monitor), when readable. */
  readonly state: string | null;
}

export interface AssetPage {
  readonly items: AssetItem[];
  readonly nextCursor: string | null;
}

/** Draft kinds that create work (the Jobs tab); configuration, approval decisions and job messages are not listed. */
export const WORK_DRAFT_KINDS = [
  'job',
  'workflow_run',
  'automation',
  'automation_change',
  'ops_action',
  'machine_task',
  'tool_install',
  'monitor',
  'job_resume',
  'skill',
] as const;

/** Raster images the artifact route serves inline (the media tab shows them; other images are files). */
const RASTER = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const MAX_PAGE = 50;
const LINK_WINDOW = 200;
const LINK_WINDOWS = 5;
const LINKS_PER_MESSAGE = 50;
const MAX_URL = 2_048;
/** Postgres ARE: an http(s) URL up to whitespace, quotes, angle brackets, parentheses or brackets. */
const URL_RE = `https?://[^][[:space:]<>"'\`(){}|\\\\^]+`;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const KEY = /^[A-Za-z0-9:._~/?#[\]@!$&'()*+,;=%-]{1,2100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Cursor {
  readonly k: string;
  readonly id: string;
}

const scopeOf = (kind: AssetKind, threadId: string | null): string =>
  `chat.assets.${kind}.${threadId ?? 'all'}`;

function encode(kind: AssetKind, threadId: string | null, at: Cursor): string {
  return encodeCursor({ s: scopeOf(kind, threadId), k: at.k, id: at.id });
}

function decode(kind: AssetKind, threadId: string | null, cursor: string): Cursor {
  return decodeCursor(cursor, (o) => {
    if (o.s !== scopeOf(kind, threadId) || typeof o.k !== 'string' || typeof o.id !== 'string') return null;
    if (!ISO.test(o.k) || !KEY.test(o.id)) return null;
    return { k: o.k, id: o.id };
  });
}

/** A URL found in a message, cleaned: trailing punctuation removed, http(s) only, credentials stripped. */
export function cleanLink(raw: string): { url: string; domain: string } | null {
  const trimmed = raw.replace(/[.,;:!?'"*_~>]+$/u, '');
  if (trimmed.length === 0 || trimmed.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname === '') return null;
  u.username = '';
  u.password = '';
  const url = u.toString();
  return url.length > MAX_URL ? null : { url, domain: u.hostname };
}

const base = {
  messageId: null,
  seq: null,
  detail: null,
  url: null,
  href: null,
  domain: null,
  mediaType: null,
  sizeBytes: null,
  role: null,
  source: null,
  draftKind: null,
  draftState: null,
  state: null,
} as const;

/** The message (tool line) a draft card hangs on. */
const DRAFT_ANCHOR = `LEFT JOIN LATERAL (
    SELECT m.id::text AS message_id, m.seq FROM chat_messages m
     WHERE m.thread_id = d.thread_id AND m.role = 'tool' AND m.meta->>'draftId' = d.id::text
     ORDER BY m.seq LIMIT 1) anchor ON true`;

const uuidOrNull = (expr: string): string =>
  `CASE WHEN ${expr} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${expr})::uuid END`;

export class ChatAssets {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly clock: () => Date;
    },
  ) {}

  /**
   * One page of `kind` for `threadId` (the caller owns it: checked by the route) or, with null, over all the caller's
   * conversations. Newest first.
   */
  async list(
    subject: Subject,
    kind: AssetKind,
    q: { threadId: string | null; cursor?: string; limit?: number },
  ): Promise<AssetPage> {
    const limit = clampLimit(q.limit, 30, MAX_PAGE);
    const after = q.cursor === undefined ? null : decode(kind, q.threadId, q.cursor);
    const ctx = { subject, threadId: q.threadId, limit, after };
    switch (kind) {
      case 'starred':
        return this.#starred(ctx);
      case 'media':
        return this.#files(ctx, true);
      case 'files':
        return this.#files(ctx, false);
      case 'links':
        return this.#links(ctx);
      case 'jobs':
        return this.#jobs(ctx);
    }
  }

  #page<R>(
    kind: AssetKind,
    threadId: string | null,
    rows: readonly R[],
    limit: number,
    key: (r: R) => Cursor,
  ): { rows: R[]; nextCursor: string | null } {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > limit && last !== undefined ? encode(kind, threadId, key(last)) : null,
    };
  }

  #canRead(subject: Subject, project: string | null): boolean {
    return project !== null && authorize(subject, 'jobs.read', { project }).allow;
  }

  async #starred(c: Ctx): Promise<AssetPage> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      thread_id: string;
      title: string;
      seq: number;
      role: 'user' | 'assistant';
      snippet: string;
      created_at: Date;
      k: string;
    }>(
      `SELECT s.message_id::text AS id, s.thread_id::text AS thread_id, t.title, m.seq, m.role,
              left(m.content, 200) AS snippet, m.created_at, to_json(s.starred_at) #>> '{}' AS k
         FROM chat_message_stars s
         JOIN chat_threads t ON t.id = s.thread_id
         JOIN chat_messages m ON m.id = s.message_id
        WHERE s.user_id = $1 AND t.user_id = $1 AND ($2::uuid IS NULL OR s.thread_id = $2)
          AND ($3::timestamptz IS NULL OR (s.starred_at, s.message_id::text) < ($3::timestamptz, $4::text))
        ORDER BY s.starred_at DESC, s.message_id::text DESC LIMIT $5`,
      [c.subject.userId, c.threadId, c.after?.k ?? null, c.after?.id ?? null, c.limit + 1],
    );
    const p = this.#page('starred', c.threadId, rows, c.limit, (r) => ({ k: r.k, id: r.id }));
    return {
      nextCursor: p.nextCursor,
      items: p.rows.map((r) => ({
        ...base,
        kind: 'starred',
        key: r.id,
        threadId: r.thread_id,
        threadTitle: r.title,
        messageId: r.id,
        seq: r.seq,
        createdAt: r.created_at.toISOString(),
        label: r.snippet.replace(/\s+/g, ' ').trim() || '(attachments only)',
        role: r.role,
      })),
    };
  }

  /** Media (raster images) or files (everything else): sent attachments and output artifacts of created jobs. */
  async #files(c: Ctx, media: boolean): Promise<AssetPage> {
    const kind: AssetKind = media ? 'media' : 'files';
    const { rows } = await this.deps.pool.query<{
      key: string;
      thread_id: string;
      title: string;
      message_id: string | null;
      seq: number | null;
      name: string;
      media_type: string;
      size_bytes: number;
      created_at: Date;
      k: string;
      source: 'attachment' | 'artifact';
      ref_id: string;
      project: string | null;
      job_id: string | null;
      artifact_id: string | null;
    }>(
      `WITH made AS (
         SELECT DISTINCT ON (j.id) d.thread_id, t.title, j.id AS job_id, j.project,
                anchor.message_id, anchor.seq
           FROM chat_drafts d
           JOIN chat_threads t ON t.id = d.thread_id
           JOIN jobs j ON j.id = ${uuidOrNull(`d.result->>'jobId'`)}
           ${DRAFT_ANCHOR}
          WHERE t.user_id = $1 AND d.user_id = $1 AND ($2::uuid IS NULL OR t.id = $2) AND d.state = 'confirmed'
          ORDER BY j.id, d.created_at
       ), x AS (
         SELECT 'att:' || a.id::text AS key, a.thread_id::text AS thread_id, t.title, a.message_id::text AS message_id,
                m.seq, a.name, a.media_type, a.size_bytes, a.created_at, 'attachment' AS source, a.id::text AS ref_id,
                NULL::text AS project, NULL::text AS job_id, NULL::text AS artifact_id
           FROM chat_attachments a
           JOIN chat_threads t ON t.id = a.thread_id
           JOIN chat_messages m ON m.id = a.message_id
          WHERE t.user_id = $1 AND a.user_id = $1 AND ($2::uuid IS NULL OR t.id = $2)
            AND (a.media_type = ANY($6::text[])) = $7
         UNION ALL
         SELECT 'art:' || ja.job_id::text || ':' || ja.attempt_id::text || ':' || ja.artifact_id, made.thread_id::text,
                made.title, made.message_id, made.seq, ja.name, ja.media_type, ja.size_bytes, ja.created_at,
                'artifact', ja.artifact_id, made.project, ja.job_id::text, ja.artifact_id
           FROM made
           JOIN job_artifacts ja ON ja.job_id = made.job_id
          WHERE ja.kind = 'output' AND ja.pruned_at IS NULL AND (ja.media_type = ANY($6::text[])) = $7
       )
       SELECT x.*, to_json(x.created_at) #>> '{}' AS k FROM x
        WHERE ($3::timestamptz IS NULL OR (x.created_at, x.key) < ($3::timestamptz, $4::text))
        ORDER BY x.created_at DESC, x.key DESC LIMIT $5`,
      [c.subject.userId, c.threadId, c.after?.k ?? null, c.after?.id ?? null, c.limit + 1, RASTER, media],
    );
    const p = this.#page(kind, c.threadId, rows, c.limit, (r) => ({ k: r.k, id: r.key }));
    return {
      nextCursor: p.nextCursor,
      items: p.rows.flatMap((r): AssetItem[] => {
        if (r.source === 'artifact' && !this.#canRead(c.subject, r.project)) return [];
        const url =
          r.source === 'attachment'
            ? `/api/chat/attachments/${r.ref_id}/content`
            : `/api/jobs/${r.job_id ?? ''}/artifacts/${encodeURIComponent(r.artifact_id ?? '')}${media ? '?inline=1' : ''}`;
        return [
          {
            ...base,
            kind,
            key: r.key,
            threadId: r.thread_id,
            threadTitle: r.title,
            messageId: r.message_id,
            seq: r.seq,
            createdAt: r.created_at.toISOString(),
            label: r.name,
            detail: r.source === 'artifact' ? 'Job output' : 'Attachment',
            url,
            href: r.source === 'artifact' && r.job_id !== null ? `/jobs/${r.job_id}` : null,
            mediaType: r.media_type,
            sizeBytes: r.size_bytes,
            source: r.source,
          },
        ];
      }),
    };
  }

  /**
   * Links in user / assistant messages, newest message first. Postgres extracts the URLs (≤ 50 per message) so long
   * messages never travel; a request scans at most LINK_WINDOWS × LINK_WINDOW messages and stops once a page is full.
   * Deduplicated within the page (the newest message wins); the console dedupes across pages.
   */
  async #links(c: Ctx): Promise<AssetPage> {
    const items: AssetItem[] = [];
    const seen = new Set<string>();
    let after = c.after;
    let exhausted = false;
    let cursorAt: Cursor | null = null;
    for (let w = 0; w < LINK_WINDOWS && items.length < c.limit && !exhausted; w++) {
      const { rows } = await this.deps.pool.query<{
        id: string;
        thread_id: string;
        title: string;
        seq: number;
        role: 'user' | 'assistant';
        created_at: Date;
        k: string;
        urls: string[];
      }>(
        `SELECT m.id::text AS id, m.thread_id::text AS thread_id, t.title, m.seq, m.role, m.created_at,
                to_json(m.created_at) #>> '{}' AS k,
                ARRAY(SELECT u.v FROM (
                        SELECT (regexp_matches(m.content, $6, 'g'))[1] AS v LIMIT ${String(LINKS_PER_MESSAGE)}) u) AS urls
           FROM chat_messages m
           JOIN chat_threads t ON t.id = m.thread_id
          WHERE t.user_id = $1 AND ($2::uuid IS NULL OR t.id = $2) AND m.role IN ('user', 'assistant')
            AND m.content ~ 'https?://'
            AND ($3::timestamptz IS NULL OR (m.created_at, m.id::text) < ($3::timestamptz, $4::text))
          ORDER BY m.created_at DESC, m.id::text DESC LIMIT $5`,
        [c.subject.userId, c.threadId, after?.k ?? null, after?.id ?? null, LINK_WINDOW, `(${URL_RE})`],
      );
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      let stoppedEarly = false;
      for (const [i, r] of rows.entries()) {
        for (const raw of r.urls) {
          const l = cleanLink(raw);
          if (l === null || seen.has(l.url)) continue;
          seen.add(l.url);
          items.push({
            ...base,
            kind: 'links',
            key: l.url,
            threadId: r.thread_id,
            threadTitle: r.title,
            messageId: r.id,
            seq: r.seq,
            createdAt: r.created_at.toISOString(),
            label: l.url,
            url: l.url,
            domain: l.domain,
            role: r.role,
          });
        }
        cursorAt = { k: r.k, id: r.id };
        if (items.length >= c.limit) {
          stoppedEarly = i < rows.length - 1;
          break;
        }
      }
      // A short window is the end, unless the page filled up before its last message.
      if (rows.length < LINK_WINDOW && !stoppedEarly) exhausted = true;
      after = cursorAt;
    }
    return {
      items,
      nextCursor: exhausted || cursorAt === null ? null : encode('links', c.threadId, cursorAt),
    };
  }

  /** Work drafts of the conversation(s) with their state and the live state of what they created. */
  async #jobs(c: Ctx): Promise<AssetPage> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      thread_id: string;
      thread_title: string;
      kind: string;
      title: string;
      state: string;
      result: Record<string, unknown> | null;
      project: string | null;
      created_at: Date;
      expires_at: Date;
      k: string;
      message_id: string | null;
      seq: number | null;
    }>(
      `SELECT d.id::text AS id, d.thread_id::text AS thread_id, t.title AS thread_title, d.kind, d.title, d.state,
              d.result, d.project, d.created_at, d.expires_at, to_json(d.created_at) #>> '{}' AS k,
              anchor.message_id, anchor.seq
         FROM chat_drafts d
         JOIN chat_threads t ON t.id = d.thread_id
         ${DRAFT_ANCHOR}
        WHERE t.user_id = $1 AND d.user_id = $1 AND ($2::uuid IS NULL OR t.id = $2) AND d.kind = ANY($6::text[]) AND d.state <> 'invalid'
          AND ($3::timestamptz IS NULL OR (d.created_at, d.id::text) < ($3::timestamptz, $4::text))
        ORDER BY d.created_at DESC, d.id::text DESC LIMIT $5`,
      [
        c.subject.userId,
        c.threadId,
        c.after?.k ?? null,
        c.after?.id ?? null,
        c.limit + 1,
        [...WORK_DRAFT_KINDS],
      ],
    );
    const p = this.#page('jobs', c.threadId, rows, c.limit, (r) => ({ k: r.k, id: r.id }));
    const live = await this.#liveTargets(p.rows.map((r) => r.result));
    const now = this.deps.clock().getTime();
    return {
      nextCursor: p.nextCursor,
      items: p.rows.map((r) => {
        const target = targetOf(r.result);
        const t = target === null ? undefined : live.get(`${target.type}:${target.id}`);
        const readable = t !== undefined && this.#canRead(c.subject, t.project);
        const draftState = r.state === 'proposed' && r.expires_at.getTime() <= now ? 'expired' : r.state;
        return {
          ...base,
          kind: 'jobs' as const,
          key: r.id,
          threadId: r.thread_id,
          threadTitle: r.thread_title,
          messageId: r.message_id,
          seq: r.seq,
          createdAt: r.created_at.toISOString(),
          label: r.title,
          detail: r.project,
          href: target !== null && readable ? target.href : null,
          draftKind: r.kind,
          draftState,
          state: readable ? t.state : null,
        };
      }),
    };
  }

  /** Current state and project of the jobs / runs / automations / deploys / monitors the drafts created. */
  async #liveTargets(
    results: readonly (Record<string, unknown> | null)[],
  ): Promise<Map<string, { state: string; project: string }>> {
    const ids: Record<TargetType, string[]> = { job: [], run: [], automation: [], deploy: [], monitor: [] };
    for (const r of results) {
      const t = targetOf(r);
      if (t !== null) ids[t.type].push(t.id);
    }
    const out = new Map<string, { state: string; project: string }>();
    const tables: Record<TargetType, string> = {
      job: 'SELECT id::text AS id, project, state::text AS state FROM jobs WHERE id = ANY($1::uuid[])',
      run: 'SELECT id::text AS id, project, state FROM workflow_runs WHERE id = ANY($1::uuid[])',
      automation: 'SELECT id::text AS id, project, state FROM automations WHERE id = ANY($1::uuid[])',
      deploy: 'SELECT id::text AS id, project, state FROM ops_actions WHERE id = ANY($1::uuid[])',
      monitor: `SELECT id::text AS id, project, CASE WHEN paused THEN 'paused' ELSE status END AS state
                  FROM uptime_monitors WHERE id = ANY($1::uuid[])`,
    };
    await Promise.all(
      (Object.keys(ids) as TargetType[]).map(async (type) => {
        if (ids[type].length === 0) return;
        const { rows } = await this.deps.pool.query<{ id: string; project: string; state: string }>(
          tables[type],
          [ids[type]],
        );
        for (const r of rows) out.set(`${type}:${r.id}`, { state: r.state, project: r.project });
      }),
    );
    return out;
  }
}

interface Ctx {
  readonly subject: Subject;
  readonly threadId: string | null;
  readonly limit: number;
  readonly after: Cursor | null;
}

type TargetType = 'job' | 'run' | 'automation' | 'deploy' | 'monitor';

/** What a confirmed draft created, from its stored result (ids are re-validated; unknown shapes give null). */
export function targetOf(
  result: Record<string, unknown> | null,
): { type: TargetType; id: string; href: string } | null {
  if (result === null) return null;
  const id = (k: string): string | null => {
    const v = result[k];
    return typeof v === 'string' && UUID.test(v) ? v : null;
  };
  const deploy = id('actionId');
  if (deploy !== null) return { type: 'deploy', id: deploy, href: `/deploys/${deploy}` };
  const job = id('jobId');
  if (job !== null) return { type: 'job', id: job, href: `/jobs/${job}` };
  const run = id('runId');
  if (run !== null && result.automationId === undefined) {
    return { type: 'run', id: run, href: `/jobs/workflows/${run}` };
  }
  const automation = id('automationId');
  if (automation !== null) return { type: 'automation', id: automation, href: `/automations/${automation}` };
  const monitor = id('monitorId');
  if (monitor !== null) return { type: 'monitor', id: monitor, href: `/uptime/${monitor}` };
  return null;
}
