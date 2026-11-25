import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { liveUrl } from '../ops/on-success.js';
import { rowContent } from '../blobs/registry.js';
import {
  type ItemMetaUpdate,
  type ItemType,
  LIMITS,
  type NoteCardInput,
  type NoteCardPatch,
  parseItemKey,
  type PreviewKind,
  previewKindOf,
} from './model.js';

/**
 * p6-outputs (docs/design/p6-outputs.md §2): the Outputs read model and the people's own metadata on top of it.
 *
 * Nothing here copies job output: sites come from succeeded ops actions, files from `job_artifacts` (workspace
 * outputs) and `job_events` (`artifact` rows of run artifacts), note cards from `output_notes`. Titles, tags, pins
 * and the per-item notes thread live in `output_items` / `output_item_notes`. Every name, note and URL is
 * untrusted text for the console (rendered as text; links only https and opened outside the console).
 */

export interface OutputsActor {
  readonly id: string;
  /** Effective role in the item's project (owner/admin may edit or delete anyone's note). */
  readonly role: string;
  readonly ip?: string;
  readonly userAgent?: string | null;
}

export interface ListFilter {
  readonly project?: string | undefined;
  readonly type?: ItemType | undefined;
  readonly jobId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly pinned?: boolean | undefined;
  readonly q?: string | undefined;
  readonly tag?: string | undefined;
  /** Exactly this item (deep links, the item drawer, writes). */
  readonly key?: string | undefined;
  /** p8-outputs-folders: items linked to this folder (the caller checked that the folder is readable). */
  readonly folder?: string | undefined;
  /** p8-outputs-folders: files whose name starts with `<path>/` (a directory of the job's out/ tree). */
  readonly path?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface SiteView {
  readonly url: string | null;
  readonly env: 'preview' | 'production';
  readonly provider: 'pages' | 'coolify' | 'tunnel';
  readonly target: string;
  readonly opsActionId: string;
  readonly opsKind: string;
  readonly deployedAt: string;
  /** p8-preview-tunnels: an open preview link (provider `tunnel`) — its protection, kind, expiry and state. */
  readonly protection?: 'none' | 'access' | 'service-token';
  readonly stable?: boolean;
  readonly expiresAt?: string;
  readonly state?: string;
}

export interface FileView {
  readonly source: 'workspace' | 'run';
  readonly artifactId: string;
  readonly kind: 'output' | 'summary' | 'run';
  readonly mediaType: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly redacted: boolean;
  /** Content gone: workspace retention / quota, or never stored on the master (run artifacts). */
  readonly removed: 'retention' | 'quota' | null;
  /** When the retention will remove it (null: no retention, pinned, already removed or not yet decidable). */
  readonly expiresAt: string | null;
  /** API path of the content (attachment; `?inline=1` previews allowlisted types), null when there is none. */
  readonly download: string | null;
  readonly preview: PreviewKind;
  /**
   * p17-object-storage: where the bytes are — `s3` (object storage; downloads are presigned links), `local` (the
   * master's blob directory) or `database` (not yet moved by blobs:migrate); null when there are none.
   */
  readonly location: 's3' | 'local' | 'database' | null;
}

export interface NoteCardView {
  readonly id: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly links: string[];
  readonly author: { readonly id: string | null; readonly username: string | null };
  readonly updatedAt: string;
}

/** p8-uptime: the monitors linked to a site item (status dot, uptime %, provider status rows). */
export interface SiteUptime {
  /** Worst status of the active linked monitors: down > pending > up; null when all are paused. */
  readonly status: 'up' | 'down' | 'pending' | null;
  /** Uptime % over 24 h of the first http/tcp monitor (else the first one). */
  readonly uptime24h: number | null;
  readonly monitors: {
    readonly id: string;
    readonly name: string;
    readonly type: 'http' | 'tcp' | 'pages' | 'coolify';
    readonly status: 'up' | 'down' | 'pending';
    readonly paused: boolean;
    readonly uptime24h: number | null;
    readonly detail: string | null;
    readonly lastCheckAt: string | null;
  }[];
}

/** p10-verify-health: the latest post-deploy health check of a site item (dot, status, screenshot thumbnail). */
export interface SiteHealthBadge {
  readonly id: string;
  readonly state: string;
  readonly checkedAt: string;
  readonly statusCode: number | null;
  readonly latencyMs: number | null;
  readonly broken: number;
  /** The newest screenshot (a job file served by the artifact route), null when none. */
  readonly screenshot: { readonly jobId: string; readonly artifactId: string } | null;
}

export interface HealthBadges {
  badges(
    project: string,
    actionIds: readonly string[],
    previewIds: readonly string[],
  ): Promise<Map<string, SiteHealthBadge>>;
}

export interface UptimeBadges {
  badges(project: string, keys: readonly string[]): Promise<Map<string, SiteUptime['monitors'][number][]>>;
}

export interface OutputItem {
  readonly key: string;
  readonly type: ItemType;
  readonly project: string;
  /** The person's title (null: show `name`). */
  readonly title: string | null;
  readonly name: string;
  readonly tags: string[];
  readonly pinned: boolean;
  readonly noteCount: number;
  readonly jobId: string | null;
  readonly createdAt: string;
  readonly site: SiteView | null;
  readonly file: FileView | null;
  readonly note: NoteCardView | null;
  /** p8-uptime: monitors of a site item (null: none, or not a site). */
  readonly uptime?: SiteUptime | null;
  /** p10-verify-health: the latest health check of a site item (null: none, or not a site). */
  readonly health?: SiteHealthBadge | null;
}

export interface ItemNote {
  readonly id: string;
  readonly body: string;
  readonly author: { readonly id: string | null; readonly username: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteCard {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string[];
  readonly links: string[];
  readonly pinned: boolean;
  readonly author: { readonly id: string | null; readonly username: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Row {
  type: ItemType;
  item_key: string;
  project: string;
  job_id: string | null;
  name: string;
  media_type: string | null;
  size_bytes: string | null;
  created_at: Date;
  data: Record<string, unknown>;
  title: string | null;
  tags: string[];
  pinned: boolean;
  note_count: number;
  total: string;
}

const DEPLOY_KINDS = ['pages.deploy', 'pages.rollback', 'coolify.deploy', 'coolify.rollback'];
const FINISHED = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const DAY = 86_400_000;

/** `%…%` ILIKE pattern with the wildcards of the search text escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function isAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

const notFound = (): HttpError => new HttpError(404, 'output_not_found', 'Output not found.');

/** A JSON array of the resources of an ops action target (empty when absent or malformed). */
const RESOURCES = `(CASE WHEN jsonb_typeof(o.target->'resources') = 'array' THEN o.target->'resources' ELSE '[]'::jsonb END)`;

export class OutputsService {
  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      /** Live-event retention (days) of ended jobs — run artifacts disappear with it; null: kept. */
      readonly liveRetentionDays: number | null;
      /** p8-uptime: monitors linked to site items (absent: no uptime on the cards). */
      readonly uptime?: () => UptimeBadges | null;
      /** p10-verify-health: post-deploy health checks of site items (absent: none on the cards). */
      readonly health?: () => HealthBadges | null;
    },
  ) {}

  // ------------------------------------------------------------------------------------ read model

  /** One page of output items of the visible projects (`visible` null: every project), pinned first. */
  async list(
    visibleIn: readonly string[] | null,
    f: ListFilter,
  ): Promise<{ items: OutputItem[]; total: number }> {
    let visible = visibleIn;
    const limit = Math.min(Math.max(f.limit ?? 50, 1), LIMITS.pageMax);
    const offset = Math.min(Math.max(f.offset ?? 0, 0), LIMITS.offsetMax);
    // p8-outputs-folders: a folder narrows the scan to the projects its links name (within the visible ones).
    if (f.folder !== undefined) {
      const { rows: lp } = await this.deps.pool.query<{ project: string }>(
        'SELECT DISTINCT project FROM output_folder_links WHERE folder_id = $1::uuid',
        [f.folder],
      );
      const linked = lp.map((r) => r.project).filter((p) => visible === null || visible.includes(p));
      if (linked.length === 0) return { items: [], total: 0 };
      visible = linked;
    }
    const params: unknown[] = [visible === null ? null : [...visible], f.project ?? null];
    const scope = (col: string): string =>
      `($1::text[] IS NULL OR ${col} = ANY($1)) AND ($2::text IS NULL OR ${col} = $2)`;
    const p = (v: unknown): string => {
      params.push(v);
      return `$${String(params.length)}`;
    };
    const parsed = f.key === undefined ? null : parseItemKey(f.key);
    if (f.key !== undefined && parsed === null && !/^note:[0-9a-f-]{36}$/.test(f.key)) {
      return { items: [], total: 0 };
    }
    const keyType: ItemType | null =
      f.key === undefined ? null : parsed === null ? 'note' : parsed.kind === 'site' ? 'site' : 'file';
    const want = (t: ItemType): boolean =>
      (f.type === undefined || f.type === t) && (keyType === null || keyType === t);
    // Narrow every source by job / key early (the CTEs are scanned per project).
    const jobOf = parsed !== null && parsed.kind !== 'site' ? parsed.jobId : (f.jobId ?? null);
    const jobParam = jobOf === null ? null : p(jobOf);
    const jobCond = (col: string): string => (jobParam === null ? 'true' : `${col} = ${jobParam}::uuid`);

    const parts: string[] = [];
    if (want('site')) {
      parts.push(`(SELECT DISTINCT ON (o.project, t.tkey, t.env)
          'site'::text AS type, 'site:' || t.tkey || ':' || t.env AS item_key, o.project,
          CASE WHEN coalesce(o.params->>'jobId', o.source->>'jobId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN coalesce(o.params->>'jobId', o.source->>'jobId')::uuid END AS job_id,
          t.name, NULL::text AS media_type, NULL::bigint AS size_bytes,
          coalesce(o.finished_at, o.updated_at) AS created_at,
          jsonb_build_object('opsActionId', o.id::text, 'opsKind', o.kind, 'env', t.env, 'provider', t.provider,
                             'target', o.target, 'result', coalesce(o.result, '{}'::jsonb), 'tkey', t.tkey) AS data,
          coalesce(o.result->>'url', '') AS search_text, NULL::text[] AS own_tags, NULL::boolean AS own_pinned
        FROM ops_actions o
        CROSS JOIN LATERAL (SELECT
            CASE WHEN o.kind LIKE 'pages.%' THEN 'pages' ELSE 'coolify' END AS provider,
            coalesce(o.env, 'production') AS env,
            CASE WHEN o.kind LIKE 'pages.%'
                 THEN 'pages:' || CASE WHEN coalesce(o.target->>'project', '') ~ '^[a-z0-9][a-z0-9-]{0,57}$'
                                       THEN o.target->>'project' ELSE 'unknown' END
                 ELSE 'coolify:' || substr(md5(coalesce((SELECT string_agg(r->>'uuid', '+' ORDER BY r->>'uuid')
                                                          FROM jsonb_array_elements(${RESOURCES}) r), '')), 1, 16)
            END AS tkey,
            CASE WHEN o.kind LIKE 'pages.%' THEN coalesce(o.target->>'project', 'Cloudflare Pages')
                 ELSE coalesce((SELECT string_agg(r->>'name', ', ' ORDER BY r->>'name')
                                  FROM jsonb_array_elements(${RESOURCES}) r), 'Coolify')
            END AS name) t
        WHERE o.state = 'succeeded' AND o.kind = ANY(${p(DEPLOY_KINDS)}::text[]) AND ${scope('o.project')}
        ORDER BY o.project, t.tkey, t.env, o.finished_at DESC NULLS LAST, o.created_at DESC)`);
      // p8-preview-tunnels: open preview links (job-bound and stable) are live sites too, while they are open.
      parts.push(`(SELECT 'site'::text AS type, 'site:tunnel:' || replace(pt.id::text, '-', '') || ':preview' AS item_key,
          pt.project, pt.job_id, pt.hostname AS name, NULL::text AS media_type, NULL::bigint AS size_bytes,
          pt.created_at,
          jsonb_build_object('opsActionId', coalesce(pt.open_action_id::text, ''), 'opsKind', 'tunnel.open',
                             'env', 'preview', 'provider', 'tunnel', 'target', jsonb_build_object('hostname', pt.hostname),
                             'result', jsonb_build_object('url', 'https://' || pt.hostname),
                             'tkey', 'tunnel:' || replace(pt.id::text, '-', ''), 'protection', pt.protection,
                             'stable', pt.stable, 'expiresAt', pt.expires_at, 'state', pt.state) AS data,
          pt.hostname AS search_text, NULL::text[] AS own_tags, NULL::boolean AS own_pinned
        FROM preview_tunnels pt
        WHERE pt.state IN ('active', 'idle') AND ${scope('pt.project')} AND ${jobCond('pt.job_id')})`);
    }
    if (want('file')) {
      parts.push(`(SELECT DISTINCT ON (a.job_id, a.artifact_id)
          'file'::text AS type, 'file:' || a.job_id::text || ':' || a.artifact_id AS item_key, j.project, a.job_id,
          a.name, a.media_type, a.size_bytes::bigint AS size_bytes, a.created_at,
          jsonb_build_object('source', 'workspace', 'artifactId', a.artifact_id, 'kind', a.kind,
                             'redacted', a.redacted, 'prunedReason', a.pruned_reason, 'sha256', a.sha256,
                             'jobState', j.state::text, 'jobEndedAt', j.state_changed_at,
                             'retentionDays', w.artifact_retention_days,
                             -- p17-object-storage: where the bytes are (s3 / local; database until blobs:migrate).
                             'location', coalesce(bo.location, CASE WHEN a.content IS NOT NULL THEN 'database' END))
            AS data,
          NULL::text AS search_text, NULL::text[] AS own_tags, NULL::boolean AS own_pinned
        FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
        LEFT JOIN project_workspaces w ON w.project = j.project
        LEFT JOIN blob_objects bo ON bo.key = a.blob_key
        WHERE a.kind IN ('output', 'summary') AND ${scope('j.project')} AND ${jobCond('a.job_id')}
        ORDER BY a.job_id, a.artifact_id, a.created_at DESC)`);
      // Run artifacts the master holds no content of (workspace outputs are listed above; never the site bundle).
      parts.push(`(SELECT DISTINCT ON (e.job_id, e.payload->>'artifactId')
          'file'::text AS type, 'run:' || e.job_id::text || ':' || (e.payload->>'artifactId') AS item_key, j.project,
          e.job_id, left(coalesce(e.payload->>'name', 'artifact'), 255) AS name,
          CASE WHEN coalesce(e.payload->>'mediaType', '') ~ '^[a-z]+/[A-Za-z0-9.+-]+$' THEN e.payload->>'mediaType'
               ELSE 'application/octet-stream' END AS media_type,
          CASE WHEN jsonb_typeof(e.payload->'sizeBytes') = 'number' THEN (e.payload->>'sizeBytes')::numeric::bigint END
            AS size_bytes,
          e.received_at AS created_at,
          jsonb_build_object('source', 'run', 'artifactId', e.payload->>'artifactId', 'kind', 'run',
                             'sha256', e.payload->>'sha256', 'jobState', j.state::text,
                             'jobEndedAt', j.state_changed_at) AS data,
          NULL::text AS search_text, NULL::text[] AS own_tags, NULL::boolean AS own_pinned
        FROM job_events e JOIN jobs j ON j.id = e.job_id
        WHERE e.kind = 'artifact' AND ${scope('j.project')} AND ${jobCond('e.job_id')}
          AND coalesce(e.payload->>'artifactId', '') ~ '^[A-Za-z0-9_.:-]{1,128}$'
          AND (e.payload->>'artifactId') NOT LIKE 'ws-%'
          AND NOT EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = e.job_id
                            AND a.artifact_id = e.payload->>'artifactId')
        ORDER BY e.job_id, e.payload->>'artifactId', e.stream_seq DESC)`);
    }
    if (want('note') && jobParam === null) {
      const noteId = f.key?.startsWith('note:') === true ? p(f.key.slice(5)) : null;
      parts.push(`(SELECT 'note'::text AS type, 'note:' || n.id::text AS item_key, n.project, NULL::uuid AS job_id,
          n.title AS name, 'text/markdown'::text AS media_type, length(n.body)::bigint AS size_bytes, n.created_at,
          jsonb_build_object('noteId', n.id::text, 'body', left(n.body, ${String(LIMITS.excerptChars)}),
                             'bodyTruncated', length(n.body) > ${String(LIMITS.excerptChars)},
                             'links', to_jsonb(n.links), 'authorId', n.author_id::text, 'authorName', u.username,
                             'updatedAt', n.updated_at) AS data,
          n.body AS search_text, n.tags AS own_tags, n.pinned AS own_pinned
        FROM output_notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE ${scope('n.project')}${noteId === null ? '' : ` AND n.id = ${noteId}::uuid`})`);
    }
    if (parts.length === 0) return { items: [], total: 0 };

    const where: string[] = [];
    if (f.key !== undefined) where.push(`z.item_key = ${p(f.key)}`);
    if (jobParam !== null) where.push(`z.job_id = ${jobParam}::uuid`);
    if (f.from !== undefined) where.push(`z.created_at >= ${p(f.from)}`);
    if (f.to !== undefined) where.push(`z.created_at < ${p(f.to)}`);
    if (f.pinned !== undefined) where.push(f.pinned ? 'z.pinned' : 'NOT z.pinned');
    if (f.tag !== undefined) where.push(`${p(f.tag)} = ANY(z.tags)`);
    if (f.folder !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM output_folder_links l WHERE l.folder_id = ${p(f.folder)}::uuid
                            AND l.project = z.project AND l.item_key = z.item_key)`);
    }
    if (f.path !== undefined) {
      where.push(`z.type = 'file' AND z.name LIKE ${p(`${likePattern(f.path).slice(1, -1)}/%`)}`);
    }
    if (f.q !== undefined && f.q.trim() !== '') {
      const q = p(likePattern(f.q.trim()));
      where.push(`(z.name ILIKE ${q} OR coalesce(z.title, '') ILIKE ${q} OR array_to_string(z.tags, ' ') ILIKE ${q}
                   OR coalesce(z.search_text, '') ILIKE ${q}
                   OR EXISTS (SELECT 1 FROM output_item_notes x WHERE x.item_id = z.meta_id AND x.body ILIKE ${q}))`);
    }
    const sql = `
      SELECT z.type, z.item_key, z.project, z.job_id::text AS job_id, z.name, z.media_type,
             z.size_bytes::text AS size_bytes, z.created_at, z.data, z.title, z.tags, z.pinned,
             (SELECT count(*)::int FROM output_item_notes x WHERE x.item_id = z.meta_id) AS note_count,
             count(*) OVER () AS total
        FROM (SELECT u.*, m.id AS meta_id,
                     CASE WHEN u.type = 'note' THEN NULL ELSE m.title END AS title,
                     coalesce(u.own_tags, m.tags, '{}'::text[]) AS tags,
                     coalesce(u.own_pinned, m.pinned, false) AS pinned
                FROM (${parts.join(' UNION ALL ')}) u
                LEFT JOIN output_items m ON u.type <> 'note' AND m.project = u.project AND m.item_key = u.item_key) z
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY z.pinned DESC, z.created_at DESC, z.item_key
       LIMIT ${String(limit)} OFFSET ${String(offset)}`;
    const { rows } = await this.deps.pool.query<Row>(sql, params);
    const items = await this.#withHealth(await this.#withUptime(rows.map((r) => this.#view(r))));
    return { items, total: Number(rows[0]?.total ?? 0) };
  }

  /** p10-verify-health: attaches the latest health check of each site's action / preview (one query per project). */
  async #withHealth(items: OutputItem[]): Promise<OutputItem[]> {
    const src = this.deps.health?.() ?? null;
    const sites = items.filter((i) => i.type === 'site' && i.site !== null);
    if (src === null || sites.length === 0) return items;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const keyOf = (i: OutputItem): string | null => {
      const s = i.site;
      if (s === null) return null;
      if (s.provider === 'tunnel') {
        const hex = s.target.replace(/^tunnel:/, '');
        if (!/^[0-9a-f]{32}$/.test(hex)) return null;
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      return UUID.test(s.opsActionId) ? s.opsActionId : null;
    };
    const byProject = new Map<string, { actions: string[]; previews: string[] }>();
    for (const i of sites) {
      const key = keyOf(i);
      if (key === null) continue;
      const e = byProject.get(i.project) ?? { actions: [], previews: [] };
      if (i.site?.provider === 'tunnel') e.previews.push(key);
      else e.actions.push(key);
      byProject.set(i.project, e);
    }
    const found = new Map<string, SiteHealthBadge>();
    for (const [project, e] of byProject) {
      for (const [k, v] of await src.badges(project, e.actions, e.previews))
        found.set(`${project}\u0000${k}`, v);
    }
    return items.map((i) => {
      if (i.type !== 'site') return i;
      const key = keyOf(i);
      return { ...i, health: key === null ? null : (found.get(`${i.project}\u0000${key}`) ?? null) };
    });
  }

  /** p8-uptime: attaches the linked monitors to site items (one query per project on the page). */
  async #withUptime(items: OutputItem[]): Promise<OutputItem[]> {
    const src = this.deps.uptime?.() ?? null;
    const sites = items.filter((i) => i.type === 'site');
    if (src === null || sites.length === 0) return items;
    const byProject = new Map<string, string[]>();
    for (const i of sites) byProject.set(i.project, [...(byProject.get(i.project) ?? []), i.key]);
    const found = new Map<string, SiteUptime>();
    for (const [project, keys] of byProject) {
      const badges = await src.badges(project, keys);
      for (const [key, monitors] of badges) {
        const active = monitors.filter((m) => !m.paused);
        const status = active.some((m) => m.status === 'down')
          ? 'down'
          : active.some((m) => m.status === 'pending')
            ? 'pending'
            : active.length > 0
              ? 'up'
              : null;
        const lead = monitors.find((m) => m.type === 'http' || m.type === 'tcp') ?? monitors[0];
        found.set(`${project}\u0000${key}`, { status, uptime24h: lead?.uptime24h ?? null, monitors });
      }
    }
    return items.map((i) =>
      i.type === 'site' ? { ...i, uptime: found.get(`${i.project}\u0000${i.key}`) ?? null } : i,
    );
  }

  /** The item a key names in `project`, or a 404. */
  async item(project: string, key: string): Promise<OutputItem> {
    const { items } = await this.list(null, { project, key, limit: 1 });
    const item = items[0];
    if (item === undefined) throw notFound();
    return item;
  }

  #view(r: Row): OutputItem {
    const d = r.data;
    const s = (k: string): string | null => {
      const v = d[k];
      return typeof v === 'string' ? v : null;
    };
    const base = {
      key: r.item_key,
      type: r.type,
      project: r.project,
      title: r.title,
      name: r.name,
      tags: r.tags,
      pinned: r.pinned,
      noteCount: r.note_count,
      jobId: r.job_id,
      createdAt: r.created_at.toISOString(),
    };
    if (r.type === 'site') {
      const target = (typeof d.target === 'object' && d.target !== null ? d.target : {}) as Record<
        string,
        unknown
      >;
      const result = (typeof d.result === 'object' && d.result !== null ? d.result : {}) as Record<
        string,
        unknown
      >;
      const provider = s('provider');
      const tunnel = provider === 'tunnel';
      const protection = s('protection');
      return {
        ...base,
        site: {
          url: tunnel ? (typeof result.url === 'string' ? result.url : null) : liveUrl({ result, target }),
          env: s('env') === 'preview' ? 'preview' : 'production',
          provider: tunnel ? 'tunnel' : provider === 'pages' ? 'pages' : 'coolify',
          ...(tunnel
            ? {
                protection: protection === 'access' || protection === 'service-token' ? protection : 'none',
                stable: d.stable === true,
                expiresAt: new Date(s('expiresAt') ?? r.created_at.toISOString()).toISOString(),
                state: s('state') ?? 'active',
              }
            : {}),
          target: s('tkey') ?? '',
          opsActionId: s('opsActionId') ?? '',
          opsKind: s('opsKind') ?? '',
          deployedAt: r.created_at.toISOString(),
        },
        file: null,
        note: null,
      };
    }
    if (r.type === 'note') {
      return {
        ...base,
        site: null,
        file: null,
        note: {
          id: s('noteId') ?? '',
          body: s('body') ?? '',
          bodyTruncated: d.bodyTruncated === true,
          links: Array.isArray(d.links) ? d.links.filter((l): l is string => typeof l === 'string') : [],
          author: { id: s('authorId'), username: s('authorName') },
          updatedAt: new Date(s('updatedAt') ?? r.created_at.toISOString()).toISOString(),
        },
      };
    }
    const source = s('source') === 'run' ? 'run' : 'workspace';
    const artifactId = s('artifactId') ?? '';
    const pruned = s('prunedReason');
    const removed = pruned === 'retention' || pruned === 'quota' ? pruned : null;
    const jobId = r.job_id ?? '';
    const ended = s('jobEndedAt');
    const finished = FINISHED.has(s('jobState') ?? '');
    let expiresAt: string | null = null;
    if (!r.pinned && removed === null) {
      if (source === 'workspace' && typeof d.retentionDays === 'number') {
        expiresAt = new Date(r.created_at.getTime() + d.retentionDays * DAY).toISOString();
      } else if (source === 'run' && finished && ended !== null && this.deps.liveRetentionDays !== null) {
        expiresAt = new Date(new Date(ended).getTime() + this.deps.liveRetentionDays * DAY).toISOString();
      }
    }
    const kind = s('kind');
    const enc = encodeURIComponent;
    return {
      ...base,
      site: null,
      note: null,
      file: {
        source,
        artifactId,
        kind: kind === 'summary' ? 'summary' : kind === 'run' ? 'run' : 'output',
        mediaType: r.media_type ?? 'application/octet-stream',
        sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
        sha256: s('sha256'),
        redacted: d.redacted === true,
        removed,
        expiresAt,
        download:
          source === 'workspace' && removed === null
            ? `/jobs/${enc(jobId)}/artifacts/${enc(artifactId)}`
            : null,
        preview: removed === null ? previewKindOf(r.media_type, r.name, source) : 'none',
        location:
          removed === null && (d.location === 's3' || d.location === 'local' || d.location === 'database')
            ? d.location
            : null,
      },
    };
  }

  // ------------------------------------------------------------------------------------ item metadata

  async #ensureItem(tx: Queryable, item: OutputItem, actor: OutputsActor, now: Date): Promise<string> {
    const parsed = parseItemKey(item.key);
    if (parsed === null) throw notFound();
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO output_items (project, item_key, kind, job_id, artifact_id, created_by, created_at, updated_by,
                                 updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7)
       ON CONFLICT (project, item_key) DO UPDATE SET updated_at = output_items.updated_at
       RETURNING id`,
      [
        item.project,
        item.key,
        parsed.kind,
        parsed.kind === 'site' ? null : parsed.jobId,
        parsed.kind === 'site' ? null : parsed.artifactId,
        actor.id,
        now,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('output item upsert returned no row');
    return id;
  }

  /** Title, tags and pin of an item (each omitted field unchanged). Audited `outputs.item.update`. */
  async updateItem(actor: OutputsActor, input: ItemMetaUpdate): Promise<OutputItem> {
    const item = await this.item(input.project, input.key);
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const id = await this.#ensureItem(tx, item, actor, now);
      const title =
        input.title === undefined
          ? undefined
          : input.title === null || input.title === ''
            ? null
            : input.title;
      await tx.query(
        `UPDATE output_items SET
           title = CASE WHEN $2::boolean THEN $3 ELSE title END,
           tags = coalesce($4::text[], tags),
           pinned = coalesce($5::boolean, pinned),
           pinned_at = CASE WHEN $5::boolean IS NULL THEN pinned_at WHEN $5 THEN coalesce(pinned_at, $6) ELSE NULL END,
           pinned_by = CASE WHEN $5::boolean IS NULL THEN pinned_by WHEN $5 THEN coalesce(pinned_by, $7) ELSE NULL END,
           updated_by = $7, updated_at = $6
         WHERE id = $1`,
        [id, title !== undefined, title ?? null, input.tags ?? null, input.pinned ?? null, now, actor.id],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.item.update',
          target: `output:${item.key}`.slice(0, 200),
          outcome: 'success',
          ...this.#meta(actor),
          metadata: {
            project: item.project,
            ...(input.title === undefined ? {} : { title: true }),
            ...(input.tags === undefined ? {} : { tags: input.tags.length }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          },
        },
        tx,
      );
    });
    return this.item(input.project, input.key);
  }

  // ------------------------------------------------------------------------------------ item notes

  async itemNotes(project: string, key: string): Promise<ItemNote[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      body: string;
      author_id: string | null;
      username: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT n.id, n.body, n.author_id, u.username, n.created_at, n.updated_at
         FROM output_item_notes n JOIN output_items m ON m.id = n.item_id
         LEFT JOIN users u ON u.id = n.author_id
        WHERE m.project = $1 AND m.item_key = $2
        ORDER BY n.created_at, n.id LIMIT ${String(LIMITS.notesPerItem)}`,
      [project, key],
    );
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      author: { id: r.author_id, username: r.username },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async addItemNote(actor: OutputsActor, project: string, key: string, body: string): Promise<ItemNote> {
    const text = body.trim();
    if (text === '') throw new HttpError(400, 'note_empty', 'Write something first.');
    const item = await this.item(project, key);
    const now = this.deps.clock();
    const id = await withTransaction(this.deps.pool, async (tx) => {
      const itemId = await this.#ensureItem(tx, item, actor, now);
      await tx.query('SELECT id FROM output_items WHERE id = $1 FOR UPDATE', [itemId]);
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM output_item_notes WHERE item_id = $1',
        [itemId],
      );
      if ((count.rows[0]?.n ?? 0) >= LIMITS.notesPerItem) {
        throw new HttpError(
          409,
          'too_many_notes',
          `An item keeps at most ${String(LIMITS.notesPerItem)} notes.`,
          {},
          {},
          { max: LIMITS.notesPerItem },
        );
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO output_item_notes (item_id, project, author_id, body, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
        [itemId, project, actor.id, text, now],
      );
      const noteId = rows[0]?.id ?? '';
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.item_note.create',
          target: `output-note:${noteId}`,
          outcome: 'success',
          ...this.#meta(actor),
          metadata: { project, item: key.slice(0, 200), chars: text.length },
        },
        tx,
      );
      return noteId;
    });
    const note = (await this.itemNotes(project, key)).find((n) => n.id === id);
    if (note === undefined) throw notFound();
    return note;
  }

  /** The project of an item note (route authorization), or null. */
  async itemNoteProject(id: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM output_item_notes WHERE id = $1',
      [id],
    );
    return rows[0]?.project ?? null;
  }

  async #ownNote(
    tx: Queryable,
    table: 'output_item_notes' | 'output_notes',
    id: string,
    actor: OutputsActor,
    action: string,
  ): Promise<{ project: string; author: string | null }> {
    const { rows } = await tx.query<{ project: string; author_id: string | null }>(
      `SELECT project, author_id FROM ${table} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'note_not_found', 'Note not found.');
    if (r.author_id !== actor.id && !isAdmin(actor.role)) {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.id },
        action,
        target: `output-note:${id}`,
        outcome: 'denied',
        ...this.#meta(actor),
        metadata: { project: r.project, reason: 'not_author' },
      });
      throw new HttpError(403, 'not_author', 'Only the author or an admin can change this note.');
    }
    return { project: r.project, author: r.author_id };
  }

  async updateItemNote(actor: OutputsActor, id: string, body: string): Promise<ItemNote> {
    const text = body.trim();
    if (text === '') throw new HttpError(400, 'note_empty', 'Write something first.');
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      const own = await this.#ownNote(tx, 'output_item_notes', id, actor, 'outputs.item_note.update');
      await tx.query('UPDATE output_item_notes SET body = $2, updated_at = $3 WHERE id = $1', [
        id,
        text,
        now,
      ]);
      const { rows } = await tx.query<{
        created_at: Date;
        author_id: string | null;
        username: string | null;
      }>(
        `SELECT n.created_at, n.author_id, u.username FROM output_item_notes n
           LEFT JOIN users u ON u.id = n.author_id WHERE n.id = $1`,
        [id],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.item_note.update',
          target: `output-note:${id}`,
          outcome: 'success',
          ...this.#meta(actor),
          metadata: { project: own.project, chars: text.length, ownNote: own.author === actor.id },
        },
        tx,
      );
      const r = rows[0];
      return {
        id,
        body: text,
        author: { id: r?.author_id ?? null, username: r?.username ?? null },
        createdAt: (r?.created_at ?? now).toISOString(),
        updatedAt: now.toISOString(),
      };
    });
  }

  async deleteItemNote(actor: OutputsActor, id: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const own = await this.#ownNote(tx, 'output_item_notes', id, actor, 'outputs.item_note.delete');
      await tx.query('DELETE FROM output_item_notes WHERE id = $1', [id]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.item_note.delete',
          target: `output-note:${id}`,
          outcome: 'success',
          ...this.#meta(actor),
          metadata: { project: own.project, ownNote: own.author === actor.id },
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------------------------ note cards

  async noteProject(id: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM output_notes WHERE id = $1',
      [id],
    );
    return rows[0]?.project ?? null;
  }

  async note(id: string): Promise<NoteCard> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      title: string;
      body: string;
      tags: string[];
      links: string[];
      pinned: boolean;
      author_id: string | null;
      username: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT n.id, n.project, n.title, n.body, n.tags, n.links, n.pinned, n.author_id, u.username, n.created_at,
              n.updated_at
         FROM output_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'note_not_found', 'Note not found.');
    return {
      id: r.id,
      project: r.project,
      title: r.title,
      body: r.body,
      tags: r.tags,
      links: r.links,
      pinned: r.pinned,
      author: { id: r.author_id, username: r.username },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async createNote(actor: OutputsActor, input: NoteCardInput): Promise<NoteCard> {
    const now = this.deps.clock();
    const id = await withTransaction(this.deps.pool, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM projects WHERE id = $1', [input.project]);
      if (exists.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `output-notes:${input.project}`,
      ]);
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM output_notes WHERE project = $1',
        [input.project],
      );
      if ((count.rows[0]?.n ?? 0) >= LIMITS.notesPerProject) {
        throw new HttpError(
          409,
          'too_many_notes',
          `A project keeps at most ${String(LIMITS.notesPerProject)} note cards; delete old ones first.`,
          {},
          {},
          { reason: 'project', max: LIMITS.notesPerProject },
        );
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO output_notes (project, title, body, tags, pinned, links, author_id, created_at, updated_by,
                                   updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8) RETURNING id`,
        [input.project, input.title, input.body, input.tags, input.pinned, input.links, actor.id, now],
      );
      const noteId = rows[0]?.id ?? '';
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.note.create',
          target: `output-card:${noteId}`,
          outcome: 'success',
          ...this.#meta(actor),
          metadata: { project: input.project, chars: input.body.length, links: input.links.length },
        },
        tx,
      );
      return noteId;
    });
    return this.note(id);
  }

  async updateNote(actor: OutputsActor, id: string, patch: NoteCardPatch): Promise<NoteCard> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const own = await this.#ownNote(tx, 'output_notes', id, actor, 'outputs.note.update');
      await tx.query(
        `UPDATE output_notes SET title = coalesce($2, title), body = coalesce($3, body),
                tags = coalesce($4::text[], tags), links = coalesce($5::text[], links),
                pinned = coalesce($6::boolean, pinned), updated_by = $7, updated_at = $8
          WHERE id = $1`,
        [
          id,
          patch.title ?? null,
          patch.body ?? null,
          patch.tags ?? null,
          patch.links ?? null,
          patch.pinned ?? null,
          actor.id,
          now,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.note.update',
          target: `output-card:${id}`,
          outcome: 'success',
          ...this.#meta(actor),
          metadata: {
            project: own.project,
            fields: Object.keys(patch).sort(),
            ownNote: own.author === actor.id,
          },
        },
        tx,
      );
    });
    return this.note(id);
  }

  async deleteNote(actor: OutputsActor, id: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const own = await this.#ownNote(tx, 'output_notes', id, actor, 'outputs.note.delete');
      await tx.query('DELETE FROM output_notes WHERE id = $1', [id]);
      // p8-outputs-folders: the card's folder links go with it.
      await tx.query('DELETE FROM output_folder_links WHERE project = $1 AND item_key = $2', [
        own.project,
        `note:${id}`,
      ]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'outputs.note.delete',
          target: `output-card:${id}`,
          outcome: 'success',
          ...this.#meta(actor),
          metadata: { project: own.project, ownNote: own.author === actor.id },
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------------------------ zip

  /**
   * The stored files a multi-select download covers: workspace files of `project` only, content present, at most
   * {@link LIMITS.zipFilesMax} files and {@link LIMITS.zipBytesMax} bytes in total (checked before anything is sent).
   */
  async zipPlan(
    project: string,
    keys: readonly string[],
  ): Promise<{
    files: {
      jobId: string;
      artifactId: string;
      name: string;
      sizeBytes: number;
      createdAt: Date;
      sha256: string;
    }[];
    skipped: string[];
  }> {
    const unique = [...new Set(keys)];
    if (unique.length > LIMITS.zipFilesMax) {
      throw new HttpError(
        413,
        'zip_too_many',
        `At most ${String(LIMITS.zipFilesMax)} files per download.`,
        {},
        {},
        { reason: 'selection', max: LIMITS.zipFilesMax },
      );
    }
    const refs = unique.map((k) => ({ key: k, parsed: parseItemKey(k) }));
    const skipped = refs.filter((r) => r.parsed?.kind !== 'file').map((r) => r.key);
    const files = refs.flatMap((r) => (r.parsed?.kind === 'file' ? [r.parsed] : []));
    if (files.length === 0) {
      throw new HttpError(
        409,
        'zip_empty',
        'None of the selected items is a stored file.',
        {},
        {},
        { reason: 'selection' },
      );
    }
    const { rows } = await this.deps.pool.query<{
      job_id: string;
      artifact_id: string;
      name: string;
      size_bytes: number;
      created_at: Date;
      sha256: string;
      stored: boolean;
    }>(
      `SELECT DISTINCT ON (a.job_id, a.artifact_id) a.job_id::text AS job_id, a.artifact_id, a.name, a.size_bytes,
              a.created_at, a.sha256, a.pruned_at IS NULL AS stored
         FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
         JOIN unnest($2::uuid[], $3::text[]) AS x(job_id, artifact_id)
           ON x.job_id = a.job_id AND x.artifact_id = a.artifact_id
        WHERE j.project = $1 AND a.kind IN ('output', 'summary')
        ORDER BY a.job_id, a.artifact_id, a.created_at DESC`,
      [project, files.map((f) => f.jobId), files.map((f) => f.artifactId)],
    );
    const found = new Set(rows.map((r) => `${r.job_id}:${r.artifact_id}`));
    for (const f of files)
      if (!found.has(`${f.jobId}:${f.artifactId}`)) skipped.push(`file:${f.jobId}:${f.artifactId}`);
    for (const r of rows) if (!r.stored) skipped.push(`file:${r.job_id}:${r.artifact_id}`);
    const stored = rows.filter((r) => r.stored);
    if (stored.length === 0)
      throw new HttpError(
        409,
        'zip_empty',
        'None of the selected files is still stored.',
        {},
        {},
        { reason: 'gone' },
      );
    const total = stored.reduce((n, r) => n + r.size_bytes, 0);
    if (total > LIMITS.zipBytesMax) {
      throw new HttpError(
        413,
        'zip_too_large',
        `The selected files add up to more than ${String(LIMITS.zipBytesMax / (1024 * 1024))} MiB; select fewer.`,
        {},
        {},
        { reason: 'selection', maxMib: LIMITS.zipBytesMax / (1024 * 1024) },
      );
    }
    return {
      files: stored.map((r) => ({
        jobId: r.job_id,
        artifactId: r.artifact_id,
        name: r.name,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
        sha256: r.sha256,
      })),
      skipped,
    };
  }

  /** Content of one planned file (null when it was pruned meanwhile). */
  async fileContent(jobId: string, artifactId: string): Promise<Buffer | null> {
    const { rows } = await this.deps.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      `SELECT content, blob_key FROM job_artifacts
        WHERE job_id = $1 AND artifact_id = $2 AND kind IN ('output', 'summary')
        ORDER BY created_at DESC LIMIT 1`,
      [jobId, artifactId],
    );
    // p17-object-storage: the bytes may be in the blob store (the ZIP total is bounded before streaming).
    return rows[0] === undefined ? null : rowContent(rows[0], LIMITS.zipBytesMax);
  }

  async auditZip(
    actor: OutputsActor,
    project: string | null,
    files: number,
    bytes: number,
    scope?: { readonly tree: string } | { readonly folder: string },
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.id },
      action: 'outputs.zip',
      target:
        project === null
          ? `output-folder:${scope !== undefined && 'folder' in scope ? scope.folder : ''}`
          : `project:${project}`,
      outcome: 'success',
      ...this.#meta(actor),
      metadata: { files, bytes, ...(scope ?? {}) },
    });
  }

  #meta(actor: OutputsActor): { ip?: string; userAgent?: string | null } {
    return {
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
      ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
    };
  }
}
