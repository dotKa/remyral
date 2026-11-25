import { skillLayoutOf, type SkillLayout } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { type ContextActor, stepUpFresh } from '../context/store.js';
import { type GitHubSkillSource, GitHubSourceError } from './github-source.js';
import { readFrontmatter } from './import-analysis.js';
import type { RequestMeta } from './service.js';

/**
 * p14-skill-catalogs (docs/design/p14-mcp-skills.md §3.3, §4.1, P2): browse and search configured skill catalogs.
 *
 * A catalog source is a GitHub repository (`github.com/anthropics/skills` is built in; admins add others, audited, with
 * step-up). The master reads it **as data** through the fixed host api.github.com — the ref resolved to a commit SHA,
 * the tree walked by SHA, each SKILL.md read by blob SHA and checked against its git hash (github-source.ts) — and keeps
 * the listing (folder, frontmatter name / description, file count, size, layout fit) with that commit in
 * `skill_catalog_sources` for {@link LISTING_TTL_MS}. Importing an entry is an ordinary GitHub import **pinned to the
 * listing's commit** (the P1 preview / findings / always-fresh publish pipeline).
 *
 * skills.sh is not a source: its documented API (`/api/v1/…`) requires a Vercel OIDC token that only apps deployed on
 * Vercel can obtain, and the open `/api/search` endpoint is undocumented (AGENTS.md rule 12) — verified 2026-10-20.
 *
 * Everything listed is untrusted third-party text: the console renders it as text, the assistant gets it fenced.
 */

/** A listing older than this is read again on the next request. */
export const LISTING_TTL_MS = 6 * 60 * 60_000;
/** After a failed read, the next automatic attempt waits this long. */
export const RETRY_AFTER_MS = 5 * 60_000;
export const MAX_CATALOG_SOURCES = 10;
/** Manual refreshes per user and minute (each costs ~n + 3 GitHub requests). */
export const CATALOG_REFRESHES_PER_MINUTE = 6;
const MAX_DESCRIPTION = 1024;
const MAX_RESULTS = 200;

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|ttf|otf|woff2?|zip|gz|tgz|jar|docx|xlsx|pptx|bin|exe|dll|so|dylib)$/i;
const LICENSE_NAME = /^(licen[cs]e|copying|notice)([.-][A-Za-z0-9]{1,16})?$/i;

export type CatalogFit = 'v1' | 'v2' | 'too_large' | 'binary';

export interface CatalogEntry {
  /** `<source id>:<folder>` — what an import or `propose_skill_install` names. */
  readonly id: string;
  readonly sourceId: string;
  readonly repo: string;
  /** Folder inside the repository. */
  readonly path: string;
  readonly commit: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Layout the import would most likely need (the import's own analysis decides). */
  readonly fit: CatalogFit;
  readonly url: string;
}

export interface CatalogSourceView {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly ref: string | null;
  readonly path: string;
  readonly enabled: boolean;
  readonly builtin: boolean;
  readonly commit: string | null;
  readonly listedAt: string | null;
  readonly error: string | null;
  readonly entryCount: number;
  readonly updatedAt: string;
}

interface SourceRow {
  id: string;
  title: string;
  repo: string;
  ref: string | null;
  path: string;
  enabled: boolean;
  builtin: boolean;
  listing: CatalogEntry[] | null;
  listing_commit: string | null;
  listed_at: Date | null;
  list_error: string | null;
  list_tried_at: Date | null;
  updated_at: Date;
}

const COLUMNS =
  'id, title, repo, ref, path, enabled, builtin, listing, listing_commit, listed_at, list_error, list_tried_at, updated_at';

export interface CatalogSourceInput {
  readonly title: string;
  readonly repo: string;
  readonly ref?: string | null | undefined;
  readonly path?: string | undefined;
  readonly enabled?: boolean | undefined;
}

const SOURCE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/@+-]{1,200}$/;
const PATH = /^([A-Za-z0-9._@+-]{1,100})(\/[A-Za-z0-9._@+-]{1,100}){0,5}$/;

/** What one catalog folder needs (the importer's moves of top-level LICENSE / README files are applied first). */
export function catalogFit(files: readonly { readonly path: string; readonly size: number }[]): CatalogFit {
  const visible = files.filter((f) => !f.path.split('/').some((s) => s.startsWith('.')));
  if (visible.some((f) => BINARY_EXT.test(f.path))) return 'binary';
  const moved = visible.map((f) => {
    if (f.path.includes('/')) return f;
    if (f.path.toLowerCase() === 'skill.md') return { ...f, path: 'SKILL.md' };
    if (LICENSE_NAME.test(f.path)) return { ...f, path: `resources/${f.path}` };
    if (/^readme(\.[A-Za-z0-9]{1,16})?$/i.test(f.path)) return { ...f, path: `references/${f.path}` };
    return f;
  });
  const layout: SkillLayout | null = skillLayoutOf(moved);
  return layout === 1 ? 'v1' : layout === 2 ? 'v2' : 'too_large';
}

export class SkillCatalogService {
  readonly #clock: () => Date;
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #budget = new Map<string, { windowStart: number; n: number }>();

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      /** null: no outbound fetch configured — listings are never read (the sources can still be configured). */
      readonly github: GitHubSkillSource | null;
      readonly clock?: () => Date;
    },
  ) {
    this.#clock = deps.clock ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.deps.github !== null;
  }

  // ------------------------------------------------------------------------------------------- read

  async sources(): Promise<CatalogSourceView[]> {
    const { rows } = await this.deps.pool.query<SourceRow>(
      `SELECT ${COLUMNS} FROM skill_catalog_sources ORDER BY builtin DESC, id`,
    );
    return rows.map(view);
  }

  /**
   * The entries of the enabled sources matching `q` (every word in name / description / folder, case-insensitive),
   * refreshing stale listings first (at most one read per source at a time; a failed read is retried after
   * {@link RETRY_AFTER_MS}). `perSource` caps results per source (the assistant gets ≤ 10).
   */
  async search(
    opts: {
      readonly q?: string | undefined;
      readonly source?: string | undefined;
      readonly perSource?: number;
    } = {},
  ): Promise<{ sources: CatalogSourceView[]; entries: CatalogEntry[] }> {
    const { rows } = await this.deps.pool.query<SourceRow>(
      `SELECT ${COLUMNS} FROM skill_catalog_sources WHERE enabled ORDER BY builtin DESC, id`,
    );
    const wanted = rows.filter((r) => opts.source === undefined || r.id === opts.source);
    await Promise.all(wanted.filter((r) => this.#stale(r)).map((r) => this.#refresh(r.id)));
    const fresh =
      wanted.length === 0
        ? []
        : (
            await this.deps.pool.query<SourceRow>(
              `SELECT ${COLUMNS} FROM skill_catalog_sources WHERE id = ANY ($1::text[]) ORDER BY builtin DESC, id`,
              [wanted.map((r) => r.id)],
            )
          ).rows;
    const words = (opts.q ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(0, 8);
    const entries: CatalogEntry[] = [];
    for (const r of fresh) {
      const matching = (r.listing ?? []).filter((e) => {
        const hay = `${e.name ?? ''} ${e.description ?? ''} ${e.path}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      entries.push(...matching.slice(0, opts.perSource ?? MAX_RESULTS));
    }
    return {
      sources: (await this.sources()).filter((s) => opts.source === undefined || s.id === opts.source),
      entries: entries.slice(0, MAX_RESULTS),
    };
  }

  /** One entry by id, from the cached listing (read once if the source was never listed). */
  async entry(id: string): Promise<CatalogEntry> {
    const sep = id.indexOf(':');
    const sourceId = sep < 0 ? '' : id.slice(0, sep);
    if (!SOURCE_ID.test(sourceId)) throw notFound();
    let row = await this.#row(sourceId);
    if (row === null || !row.enabled) throw notFound();
    if (row.listing === null) {
      await this.#refresh(sourceId);
      row = await this.#row(sourceId);
    }
    const hit = row?.listing?.find((e) => e.id === id);
    if (hit === undefined) throw notFound();
    return hit;
  }

  // ---------------------------------------------------------------------------------------- refresh

  /** Admin: read a source's listing now (rate-limited per user). */
  async refreshNow(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<CatalogSourceView> {
    this.#admin(user);
    const row = await this.#row(id);
    if (row === null) throw notFound();
    this.#spend(user.id);
    await this.#refresh(id, true);
    const after = await this.#row(id);
    if (after === null) throw notFound();
    await this.#audit(
      user,
      'skill.catalog.refresh',
      'success',
      id,
      {
        sourceId: id,
        commit: after.listing_commit,
        entries: after.listing?.length ?? 0,
        error: after.list_error,
      },
      meta,
    );
    return view(after);
  }

  #stale(r: SourceRow): boolean {
    const now = this.#clock().getTime();
    if (
      r.list_tried_at !== null &&
      now - r.list_tried_at.getTime() < RETRY_AFTER_MS &&
      r.list_error !== null
    ) {
      return false;
    }
    return r.listed_at === null || now - r.listed_at.getTime() >= LISTING_TTL_MS;
  }

  #refresh(id: string, force = false): Promise<void> {
    const running = this.#inflight.get(id);
    if (running !== undefined) return running;
    const p = this.#read(id, force).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, p);
    return p;
  }

  async #read(id: string, force: boolean): Promise<void> {
    const github = this.deps.github;
    const row = await this.#row(id);
    if (row === null || github === null) return;
    if (!force && !this.#stale(row)) return;
    const now = this.#clock();
    const [owner = '', repo = ''] = row.repo.split('/');
    try {
      const listing = await github.listing({ owner, repo, ref: row.ref, path: row.path });
      const entries: CatalogEntry[] = listing.skills.map((s) => {
        const fm = s.skillMd === null ? {} : readFrontmatter(s.skillMd);
        const folder = [row.path, s.dir].filter((x) => x !== '').join('/');
        const description = clean(fm.description, MAX_DESCRIPTION);
        return {
          id: `${row.id}:${folder}`,
          sourceId: row.id,
          repo: row.repo,
          path: folder,
          commit: listing.commit,
          name: clean(fm.name, 64) ?? (s.dir.split('/').at(-1) || null),
          description,
          fileCount: s.files.length,
          totalBytes: s.files.reduce((n, f) => n + f.size, 0),
          fit: catalogFit(s.files),
          url: `https://github.com/${row.repo}/tree/${listing.commit}${folder === '' ? '' : `/${folder}`}`,
        };
      });
      await this.deps.pool.query(
        `UPDATE skill_catalog_sources SET listing = $2, listing_commit = $3, listed_at = $4, list_error = NULL,
                list_tried_at = $4 WHERE id = $1`,
        [id, JSON.stringify(entries), listing.commit, now],
      );
    } catch (err) {
      const message =
        err instanceof GitHubSourceError ? `${err.code}: ${err.message}` : 'error reading the catalog';
      await this.deps.pool.query(
        'UPDATE skill_catalog_sources SET list_error = $2, list_tried_at = $3 WHERE id = $1',
        [id, message.slice(0, 300), now],
      );
    }
  }

  // ------------------------------------------------------------------------------------------ admin

  /** Admin + step-up: add or change a source (audited). The built-in source can only be renamed / switched off. */
  async upsertSource(
    user: ContextActor,
    id: string,
    input: CatalogSourceInput,
    meta: RequestMeta = {},
  ): Promise<CatalogSourceView> {
    this.#privileged(user);
    if (!SOURCE_ID.test(id) || id.length > 40) {
      throw new HttpError(
        400,
        'invalid_catalog_source',
        'Invalid catalog source id.',
        {},
        {},
        { reason: 'id' },
      );
    }
    const title = input.title.trim();
    const ref =
      input.ref === undefined || input.ref === null || input.ref.trim() === '' ? null : input.ref.trim();
    const path = (input.path ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (
      title === '' ||
      title.length > 80 ||
      !REPO.test(input.repo) ||
      (ref !== null && (!REF.test(ref) || ref.includes('..'))) ||
      (path !== '' && (!PATH.test(path) || path.split('/').some((s) => s === '..' || s === '.')))
    ) {
      throw new HttpError(
        400,
        'invalid_catalog_source',
        'A catalog source is a GitHub repository (owner/name), an optional branch or tag and an optional folder.',
        {},
        {},
        { reason: 'fields' },
      );
    }
    const now = this.#clock();
    const existing = await this.#row(id);
    if (existing === null) {
      const { rows } = await this.deps.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM skill_catalog_sources',
      );
      if (Number(rows[0]?.n ?? 0) >= MAX_CATALOG_SOURCES) {
        throw new HttpError(
          409,
          'catalog_source_limit',
          `At most ${String(MAX_CATALOG_SOURCES)} catalog sources.`,
          {},
          {},
          { max: MAX_CATALOG_SOURCES },
        );
      }
      await this.deps.pool.query(
        `INSERT INTO skill_catalog_sources (id, title, repo, ref, path, enabled, builtin, created_by, created_at,
                                            updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $7, $8)`,
        [id, title, input.repo, ref, path, input.enabled !== false, user.id, now],
      );
    } else {
      if (
        existing.builtin &&
        (existing.repo !== input.repo || existing.ref !== ref || existing.path !== path)
      ) {
        throw new HttpError(
          409,
          'catalog_source_builtin',
          'The built-in catalog can only be renamed or switched off.',
        );
      }
      const moved = existing.repo !== input.repo || existing.ref !== ref || existing.path !== path;
      await this.deps.pool.query(
        `UPDATE skill_catalog_sources SET title = $2, repo = $3, ref = $4, path = $5, enabled = $6, updated_by = $7,
                updated_at = $8${moved ? ', listing = NULL, listing_commit = NULL, listed_at = NULL, list_error = NULL, list_tried_at = NULL' : ''}
          WHERE id = $1`,
        [id, title, input.repo, ref, path, input.enabled !== false, user.id, now],
      );
    }
    await this.#audit(
      user,
      'skill.catalog.source',
      'success',
      id,
      {
        sourceId: id,
        change: existing === null ? 'add' : 'update',
        repo: input.repo,
        ref,
        path,
        enabled: input.enabled !== false,
      },
      meta,
    );
    const row = await this.#row(id);
    if (row === null) throw notFound();
    return view(row);
  }

  async deleteSource(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<void> {
    this.#privileged(user);
    const row = await this.#row(id);
    if (row === null) throw notFound();
    if (row.builtin) {
      throw new HttpError(
        409,
        'catalog_source_builtin',
        'The built-in catalog can only be renamed or switched off.',
      );
    }
    await this.deps.pool.query('DELETE FROM skill_catalog_sources WHERE id = $1', [id]);
    await this.#audit(
      user,
      'skill.catalog.source',
      'success',
      id,
      { sourceId: id, change: 'delete', repo: row.repo },
      meta,
    );
  }

  // ---------------------------------------------------------------------------------------- helpers

  async #row(id: string): Promise<SourceRow | null> {
    if (!SOURCE_ID.test(id)) return null;
    const { rows } = await this.deps.pool.query<SourceRow>(
      `SELECT ${COLUMNS} FROM skill_catalog_sources WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  #spend(userId: string): void {
    const t = this.#clock().getTime();
    const b = this.#budget.get(userId);
    if (b === undefined || t - b.windowStart >= 60_000) {
      this.#budget.set(userId, { windowStart: t, n: 1 });
      return;
    }
    if (b.n >= CATALOG_REFRESHES_PER_MINUTE) {
      throw new HttpError(429, 'catalog_refresh_rate_limited', 'Too many catalog refreshes; wait a minute.');
    }
    b.n += 1;
  }

  #admin(user: ContextActor): void {
    if (user.role !== 'admin' && user.role !== 'owner') throw new HttpError(403, 'forbidden', 'Not allowed.');
  }

  #privileged(user: ContextActor): void {
    this.#admin(user);
    if (!stepUpFresh(user.mfaAt, this.#clock(), user.stepUpMaxAgeMs)) {
      throw new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.');
    }
  }

  async #audit(
    user: ContextActor,
    action: string,
    outcome: 'success' | 'denied',
    target: string,
    metadata: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: user.id },
      action,
      target: `skill-catalog:${target}`,
      outcome,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata,
    });
  }
}

function notFound(): HttpError {
  return new HttpError(404, 'catalog_entry_not_found', 'Catalog entry not found.');
}

function clean(v: string | undefined, max: number): string | null {
  if (v === undefined) return null;
  // Control characters out (untrusted text; the console renders it as text anyway).
  const t = Array.from(v, (ch) => {
    const c = ch.charCodeAt(0);
    return (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f ? ' ' : ch;
  })
    .join('')
    .trim();
  return t === '' ? null : t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function view(r: SourceRow): CatalogSourceView {
  return {
    id: r.id,
    title: r.title,
    repo: r.repo,
    ref: r.ref,
    path: r.path,
    enabled: r.enabled,
    builtin: r.builtin,
    commit: r.listing_commit,
    listedAt: r.listed_at?.toISOString() ?? null,
    error: r.list_error,
    entryCount: r.listing?.length ?? 0,
    updatedAt: r.updated_at.toISOString(),
  };
}
