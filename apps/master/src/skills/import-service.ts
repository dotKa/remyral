import { randomUUID } from 'node:crypto';
import {
  compareReleaseVersions,
  MAX_SKILL_FILE_BYTES_V2,
  MAX_SKILL_FILES_V2,
  MAX_SKILL_TOTAL_BYTES_V2,
  type RuntimeKind,
  type SkillLayout,
  skillLayoutOf,
  skillSha256,
} from '@remyral/protocol';
import type { SkillCatalogService } from './catalog.js';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { type ContextActor, stepUpFresh } from '../context/store.js';
import { bundleDiff } from './diff.js';
import { type GitHubSkillSource, GitHubSourceError, parseGitHubUrl } from './github-source.js';
import {
  analyseImport,
  type ExcludedFile,
  type ImportFinding,
  MAX_IMPORT_RAW_BYTES,
  MAX_IMPORT_RAW_FILES,
  type RawImportFile,
} from './import-analysis.js';
import type {
  RequestMeta,
  SkillAssignment,
  SkillProvenance,
  SkillService,
  SkillVersionSummary,
} from './service.js';
import { readZip, safeZipPath, ZipReadError } from './zip-read.js';

/**
 * p14-skill-import (ADR-0054, docs/design/p14-mcp-skills.md §3): skills imported from the panel without manual
 * signing. An admin (with step-up) gives a folder, a zip or a GitHub link; the master reads it — GitHub only through
 * the fixed host api.github.com, pinned to a commit — and stores a **preview** (`skill_imports`, 24 h): the files, the
 * findings (a secret blocks), the suggested id / title / description / version and a diff against the latest version.
 * Nothing is signed until an admin publishes the preview with an always-fresh step-up: then the panel skills key signs
 * it, the version records its provenance, the owners get a critical notification, and it is optionally assigned (never
 * to a project that accepts only offline-signed skills). The offline upload path (`POST /skills`) is unchanged.
 */

export type ImportSourceInput =
  | {
      readonly kind: 'files';
      readonly files: readonly { readonly path: string; readonly data: string }[];
    }
  | { readonly kind: 'zip'; readonly fileName?: string | undefined; readonly data: string }
  | { readonly kind: 'github'; readonly url: string; readonly ref?: string | undefined }
  /** p14-skill-catalogs: an entry of a configured catalog — a GitHub folder pinned to the listing's commit. */
  | { readonly kind: 'catalog'; readonly entryId: string };

export interface PublishImportInput {
  readonly skillId: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly runtimes: readonly RuntimeKind[];
  readonly assign?:
    | {
        readonly project: string;
        readonly runtimes?: readonly RuntimeKind[] | null | undefined;
      }
    | null
    | undefined;
}

export interface ImportSource {
  /** p14-skill-catalogs: the catalog source id of a catalog import. */
  readonly catalog?: string;
  readonly fileName?: string;
  readonly repo?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly url?: string;
}

export interface SkillImportView {
  readonly id: string;
  readonly sourceKind: 'upload' | 'zip' | 'github' | 'catalog';
  readonly source: ImportSource;
  readonly state: 'previewed' | 'published' | 'discarded' | 'expired';
  readonly blocked: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly suggested: {
    readonly skillId: string | null;
    readonly title: string | null;
    readonly description: string | null;
    readonly version: string;
  };
  /** The newest version of the suggested skill id, if that skill exists. */
  readonly latest: string | null;
  readonly files: {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly executable: boolean;
    readonly content: string;
  }[];
  readonly excluded: ExcludedFile[];
  readonly findings: ImportFinding[];
  readonly license: { readonly path: string | null; readonly name: string | null } | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Unified diff against `latest` (null when the skill is new). */
  readonly diff: string | null;
  readonly published: { readonly skillId: string; readonly version: string } | null;
  /** The layout-v2 limits imports are checked against (p14-skill-catalogs). */
  readonly limits: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  };
  /**
   * p14-skill-catalogs: 1 = fits today's layout (every worker), 2 = needs `skills-layout-v2` workers, null = over the
   * limits (blocked).
   */
  readonly layout: SkillLayout | null;
}

export const IMPORT_TTL_MS = 24 * 60 * 60_000;
/** Open previews per user. */
export const MAX_OPEN_IMPORTS = 20;
/** p14-mcp-skills §5.2: master-side outbound fetches (GitHub) per user. */
export const GITHUB_IMPORTS_PER_MINUTE = 30;
/** A zip upload: ≤ 2 MiB compressed. */
export const MAX_IMPORT_ZIP_BYTES = 2 * 1024 * 1024;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;

interface ImportRow {
  id: string;
  source_kind: 'upload' | 'zip' | 'github' | 'catalog';
  source: ImportSource;
  files: Record<string, string>;
  excluded: ExcludedFile[];
  findings: ImportFinding[];
  manifest_preview: {
    skillId: string | null;
    title: string | null;
    description: string | null;
    license: { path: string | null; name: string | null } | null;
  };
  blocked: boolean;
  state: 'previewed' | 'published' | 'discarded' | 'expired';
  published_skill: string | null;
  published_version: string | null;
  created_by: string;
  created_at: Date;
  expires_at: Date;
}

const COLUMNS =
  'id, source_kind, source, files, excluded, findings, manifest_preview, blocked, state, published_skill, published_version, created_by, created_at, expires_at';

function decodeBase64(data: string, max: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new HttpError(400, 'invalid_import', 'Invalid base64 data.');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > max)
    throw new HttpError(413, 'skill_import_too_large', 'The upload is too large for a skill.');
  return buf;
}

export class SkillImportService {
  readonly #clock: () => Date;
  readonly #budget = new Map<string, { windowStart: number; n: number }>();

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly skills: SkillService;
      /** null: GitHub imports are switched off (no outbound fetch configured). */
      readonly github: GitHubSkillSource | null;
      /** p14-skill-catalogs: catalog entries (absent: catalog imports are refused). */
      readonly catalog?: () => SkillCatalogService | null;
      readonly clock?: () => Date;
    },
  ) {
    this.#clock = deps.clock ?? (() => new Date());
  }

  get githubEnabled(): boolean {
    return this.deps.github !== null;
  }

  // ------------------------------------------------------------------------------------------ preview

  /**
   * `opts.via: 'chat'` (p14-skill-catalogs, propose_skill_install): the assistant's turn builds the preview for the card —
   * admin required, no step-up here (nothing is signed; the card's confirmation needs an always-fresh one).
   */
  async preview(
    user: ContextActor,
    input: ImportSourceInput,
    meta: RequestMeta = {},
    opts: { readonly via?: 'chat' } = {},
  ): Promise<SkillImportView> {
    if (opts.via === 'chat') this.#admin(user);
    else this.#privileged(user);
    const now = this.#clock();
    await this.#housekeeping(now);
    const open = await this.deps.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM skill_imports WHERE created_by = $1 AND state = 'previewed' AND expires_at > $2`,
      [user.id, now],
    );
    if (Number(open.rows[0]?.n ?? 0) >= MAX_OPEN_IMPORTS) {
      throw new HttpError(
        409,
        'skill_import_limit',
        `At most ${String(MAX_OPEN_IMPORTS)} open import previews per user; publish or discard one first.`,
        {},
        {},
        { max: MAX_OPEN_IMPORTS },
      );
    }
    let raw: RawImportFile[];
    let sourceKind: ImportRow['source_kind'];
    let source: ImportSource;
    const preSkipped: ExcludedFile[] = [];
    let fallbackName: string | undefined;
    if (input.kind === 'files') {
      sourceKind = 'upload';
      ({ raw, fallbackName } = this.#fromFiles(input.files));
      source = fallbackName === undefined ? {} : { fileName: fallbackName.slice(0, 200) };
    } else if (input.kind === 'zip') {
      sourceKind = 'zip';
      const buf = decodeBase64(input.data, MAX_IMPORT_ZIP_BYTES);
      try {
        const entries = readZip(buf);
        raw = [];
        for (const e of entries) {
          if (e.data === null)
            preSkipped.push({ path: e.path, size: e.size, reason: e.skipped ?? 'skipped' });
          else raw.push({ path: e.path, bytes: e.data });
        }
      } catch (err) {
        if (err instanceof ZipReadError) {
          await this.#audit(
            user,
            'skill.import.preview',
            'denied',
            { sourceKind, reason: 'zip_invalid' },
            meta,
          );
          throw new HttpError(
            400,
            'skill_import_zip_invalid',
            `The zip archive was refused: ${err.message}.`,
            {},
            {},
            { detail: err.message },
          );
        }
        throw err;
      }
      const name = input.fileName?.replace(/\.zip$/i, '');
      fallbackName = name === undefined || name === '' ? undefined : name;
      source = input.fileName === undefined ? {} : { fileName: input.fileName.slice(0, 200) };
    } else {
      sourceKind = input.kind === 'catalog' ? 'catalog' : 'github';
      const github = this.deps.github;
      if (github === null) {
        throw new HttpError(
          503,
          'github_import_disabled',
          'Importing from GitHub is not enabled on this master.',
        );
      }
      // p14-skill-catalogs: a catalog entry is its repository folder at the listing's commit (resolved before the
      // budget is spent: an unknown entry costs no GitHub request).
      let catalog: string | undefined;
      let loc: ReturnType<typeof parseGitHubUrl> | null = null;
      if (input.kind === 'catalog') {
        const service = this.deps.catalog?.() ?? null;
        if (service === null) {
          throw new HttpError(
            503,
            'github_import_disabled',
            'Importing from GitHub is not enabled on this master.',
          );
        }
        const entry = await service.entry(input.entryId);
        const [owner = '', repo = ''] = entry.repo.split('/');
        catalog = entry.sourceId;
        loc = {
          owner,
          repo,
          ref: entry.commit,
          path: entry.path,
          candidates: [{ ref: entry.commit, path: entry.path }],
        };
      }
      this.#spendBudget(user.id, now);
      try {
        loc ??= parseGitHubUrl(
          input.kind === 'github' ? input.url : '',
          input.kind === 'github' ? input.ref : undefined,
        );
        const snap = await github.snapshot(loc);
        raw = [...snap.files];
        for (const s of snap.skipped) preSkipped.push(s);
        fallbackName = snap.path === '' ? snap.repo : snap.path.split('/').at(-1);
        source = {
          ...(catalog === undefined ? {} : { catalog }),
          repo: `${snap.owner}/${snap.repo}`,
          path: snap.path,
          ref: snap.ref,
          commit: snap.commit,
          url: `https://github.com/${snap.owner}/${snap.repo}/tree/${snap.commit}${snap.path === '' ? '' : `/${snap.path}`}`,
        };
      } catch (err) {
        if (err instanceof GitHubSourceError) {
          await this.#audit(user, 'skill.import.preview', 'denied', { sourceKind, reason: err.code }, meta);
          const status =
            err.code === 'github_url_invalid'
              ? 400
              : err.code === 'github_not_found'
                ? 404
                : err.code === 'github_rate_limited'
                  ? 429
                  : err.code === 'github_too_large'
                    ? 413
                    : 502;
          throw new HttpError(status, err.code, err.message);
        }
        throw err;
      }
    }
    const analysis = analyseImport(raw, fallbackName);
    const excluded = [...preSkipped, ...analysis.excluded];
    const findings: ImportFinding[] = [
      ...preSkipped.map((s): ImportFinding =>
        s.reason === 'too_large'
          ? { kind: 'file_too_large', severity: 'block', path: s.path, size: s.size }
          : { kind: 'skipped', severity: 'info', path: s.path, rule: s.reason },
      ),
      ...analysis.findings,
    ];
    const blocked = findings.some((f) => f.severity === 'block');
    const id = randomUUID();
    const expires = new Date(now.getTime() + IMPORT_TTL_MS);
    await this.deps.pool.query(
      `INSERT INTO skill_imports (id, source_kind, source, files, excluded, findings, manifest_preview, blocked, state,
                                  created_by, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'previewed', $9, $10, $10, $11)`,
      [
        id,
        sourceKind,
        JSON.stringify(source),
        JSON.stringify(analysis.files),
        JSON.stringify(excluded.slice(0, 300)),
        JSON.stringify(findings.slice(0, 300)),
        JSON.stringify({ ...analysis.suggested, license: analysis.license }),
        blocked,
        user.id,
        now,
        expires,
      ],
    );
    await this.#audit(
      user,
      'skill.import.preview',
      'success',
      {
        importId: id,
        sourceKind,
        ...(source.repo === undefined ? {} : { repo: source.repo, path: source.path, commit: source.commit }),
        ...(source.catalog === undefined ? {} : { catalog: source.catalog }),
        files: analysis.fileCount,
        totalBytes: analysis.totalBytes,
        layout: analysis.layout,
        blocked,
        findings: countKinds(findings),
        ...(opts.via === undefined ? {} : { via: opts.via }),
      },
      meta,
    );
    return this.get(user, id);
  }

  #fromFiles(files: readonly { readonly path: string; readonly data: string }[]): {
    raw: RawImportFile[];
    fallbackName: string | undefined;
  } {
    if (files.length === 0)
      throw new HttpError(400, 'invalid_import', 'No files.', {}, {}, { reason: 'no_files' });
    if (files.length > MAX_IMPORT_RAW_FILES) {
      throw new HttpError(
        413,
        'skill_import_too_large',
        `At most ${String(MAX_IMPORT_RAW_FILES)} files.`,
        {},
        {},
        {
          reason: 'files',
          max: MAX_IMPORT_RAW_FILES,
        },
      );
    }
    const raw: RawImportFile[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const f of files) {
      let path: string | null;
      try {
        path = safeZipPath(f.path);
      } catch {
        throw new HttpError(
          400,
          'invalid_import',
          'A file path is not a safe relative path.',
          {},
          {},
          {
            reason: 'unsafe_path',
          },
        );
      }
      if (path === null) continue;
      if (seen.has(path.toLowerCase()))
        throw new HttpError(
          400,
          'invalid_import',
          'Duplicate file path.',
          {},
          {},
          { reason: 'duplicate_path' },
        );
      seen.add(path.toLowerCase());
      const bytes = decodeBase64(f.data, MAX_IMPORT_RAW_BYTES);
      total += bytes.length;
      if (total > MAX_IMPORT_RAW_BYTES)
        throw new HttpError(
          413,
          'skill_import_too_large',
          'The files are too large.',
          {},
          {},
          { reason: 'bytes' },
        );
      raw.push({ path, bytes });
    }
    const first = raw[0]?.path.split('/')[0];
    const folder =
      first !== undefined && raw.every((r) => r.path.includes('/') && r.path.split('/')[0] === first)
        ? first
        : undefined;
    return { raw, fallbackName: folder };
  }

  // --------------------------------------------------------------------------------------------- read

  async get(user: ContextActor, id: string): Promise<SkillImportView> {
    this.#admin(user);
    const row = await this.#row(id);
    const now = this.#clock();
    if (row.state === 'previewed' && row.expires_at.getTime() <= now.getTime()) {
      await this.deps.pool.query(
        `UPDATE skill_imports SET state = 'expired', files = '{}'::jsonb, updated_at = $2 WHERE id = $1 AND state = 'previewed'`,
        [id, now],
      );
      row.state = 'expired';
      row.files = {};
    }
    return this.#view(row);
  }

  async #view(row: ImportRow): Promise<SkillImportView> {
    const suggestedId = row.manifest_preview.skillId;
    let latest: string | null = null;
    let diff: string | null = null;
    if (suggestedId !== null) {
      const { rows } = await this.deps.pool.query<{ version: string }>(
        'SELECT version FROM skill_versions WHERE skill_id = $1',
        [suggestedId],
      );
      latest = rows.map((r) => r.version).sort((a, b) => compareReleaseVersions(b, a))[0] ?? null;
      if (latest !== null && row.state === 'previewed') {
        const before = await this.deps.skills.files(suggestedId, latest).catch(() => null);
        if (before !== null) {
          diff = bundleDiff(Object.fromEntries(before.files.map((f) => [f.path, f.content])), row.files);
        }
      }
    }
    const paths = Object.keys(row.files).sort();
    return {
      id: row.id,
      sourceKind: row.source_kind,
      source: row.source,
      state: row.state,
      blocked: row.blocked,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      suggested: {
        skillId: suggestedId,
        title: row.manifest_preview.title,
        description: row.manifest_preview.description,
        version: nextVersion(latest),
      },
      latest,
      files: paths.map((p) => {
        const content = row.files[p] ?? '';
        return {
          path: p,
          size: Buffer.byteLength(content, 'utf8'),
          sha256: skillSha256(content),
          executable: p.startsWith('scripts/'),
          content,
        };
      }),
      excluded: row.excluded,
      findings: row.findings,
      license: row.manifest_preview.license,
      fileCount: paths.length,
      totalBytes: paths.reduce((n, p) => n + Buffer.byteLength(row.files[p] ?? '', 'utf8'), 0),
      diff,
      published:
        row.published_skill === null || row.published_version === null
          ? null
          : { skillId: row.published_skill, version: row.published_version },
      limits: {
        maxFiles: MAX_SKILL_FILES_V2,
        maxFileBytes: MAX_SKILL_FILE_BYTES_V2,
        maxTotalBytes: MAX_SKILL_TOTAL_BYTES_V2,
      },
      layout:
        paths.length === 0
          ? null
          : skillLayoutOf(
              paths.map((p) => ({ path: p, size: Buffer.byteLength(row.files[p] ?? '', 'utf8') })),
            ),
    };
  }

  // ------------------------------------------------------------------------------------------ publish

  async publish(
    user: ContextActor,
    id: string,
    input: PublishImportInput,
    meta: RequestMeta = {},
  ): Promise<{ readonly version: SkillVersionSummary; readonly assignment: SkillAssignment | null }> {
    this.#privileged(user);
    const row = await this.#row(id);
    const now = this.#clock();
    if (row.state !== 'previewed') {
      throw new HttpError(
        409,
        'skill_import_closed',
        `This import is ${row.state}.`,
        {},
        {},
        { state: row.state },
      );
    }
    if (row.expires_at.getTime() <= now.getTime()) {
      throw new HttpError(409, 'skill_import_expired', 'This import preview expired; import it again.');
    }
    if (row.blocked) {
      await this.#audit(user, 'skill.import.publish', 'denied', { importId: id, reason: 'blocked' }, meta);
      throw new HttpError(
        409,
        'skill_import_blocked',
        'The preview has blocking findings (a secret, a file outside the layout, a binary file or a size limit).',
      );
    }
    // Claim the preview first: two concurrent publishes of one import cannot both sign.
    const claim = await this.deps.pool.query(
      `UPDATE skill_imports SET state = 'published', published_skill = $2, published_version = $3, updated_at = $4
        WHERE id = $1 AND state = 'previewed' RETURNING id`,
      [id, input.skillId, input.version, now],
    );
    if (claim.rowCount === 0)
      throw new HttpError(
        409,
        'skill_import_closed',
        'This import was already handled.',
        {},
        {},
        { reason: 'handled' },
      );
    const provenance: SkillProvenance = {
      kind: row.source_kind,
      importId: id,
      ...(row.source.repo === undefined ? {} : { repo: row.source.repo }),
      ...(row.source.path === undefined ? {} : { path: row.source.path }),
      ...(row.source.ref === undefined ? {} : { ref: row.source.ref }),
      ...(row.source.commit === undefined ? {} : { commit: row.source.commit }),
      ...(row.source.fileName === undefined ? {} : { fileName: row.source.fileName }),
      ...(row.source.catalog === undefined ? {} : { catalog: row.source.catalog }),
    };
    let out: { version: SkillVersionSummary; assignment: SkillAssignment | null };
    try {
      out = await this.deps.skills.publishPanel(
        user,
        {
          skillId: input.skillId,
          title: input.title,
          description: input.description,
          version: input.version,
          runtimes: input.runtimes,
          files: row.files,
          assign: input.assign ?? null,
        },
        provenance,
        meta,
      );
    } catch (err) {
      await this.deps.pool.query(
        `UPDATE skill_imports SET state = 'previewed', published_skill = NULL, published_version = NULL, updated_at = $2
          WHERE id = $1 AND state = 'published'`,
        [id, this.#clock()],
      );
      const code = err instanceof HttpError ? err.code : 'error';
      await this.#audit(user, 'skill.import.publish', 'denied', { importId: id, reason: code }, meta);
      throw err;
    }
    await this.deps.pool.query(`UPDATE skill_imports SET files = '{}'::jsonb WHERE id = $1`, [id]);
    await this.#audit(
      user,
      'skill.import.publish',
      'success',
      {
        importId: id,
        sourceKind: row.source_kind,
        ...(row.source.repo === undefined ? {} : { repo: row.source.repo, commit: row.source.commit }),
        skillId: input.skillId,
        version: out.version.version,
        manifestSha256: out.version.manifestSha256,
        keyId: out.version.keyId,
        assignedTo: out.assignment?.project ?? null,
      },
      meta,
    );
    return out;
  }

  async discard(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<void> {
    this.#admin(user);
    await this.#row(id);
    const res = await this.deps.pool.query(
      `UPDATE skill_imports SET state = 'discarded', files = '{}'::jsonb, updated_at = $2
        WHERE id = $1 AND state IN ('previewed', 'expired')`,
      [id, this.#clock()],
    );
    if (res.rowCount === 0)
      throw new HttpError(
        409,
        'skill_import_closed',
        'This import was already published.',
        {},
        {},
        { reason: 'published' },
      );
    await this.#audit(user, 'skill.import.discard', 'success', { importId: id }, meta);
  }

  // ---------------------------------------------------------------------------------------- helpers

  async #row(id: string): Promise<ImportRow> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new HttpError(404, 'skill_import_not_found', 'Import not found.');
    }
    const { rows } = await this.deps.pool.query<ImportRow>(
      `SELECT ${COLUMNS} FROM skill_imports WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new HttpError(404, 'skill_import_not_found', 'Import not found.');
    return row;
  }

  async #housekeeping(now: Date): Promise<void> {
    await this.deps.pool.query(
      `UPDATE skill_imports SET state = 'expired', files = '{}'::jsonb, updated_at = $1
        WHERE state = 'previewed' AND expires_at <= $1`,
      [now],
    );
    await this.deps.pool.query(
      `DELETE FROM skill_imports WHERE state IN ('expired', 'discarded') AND updated_at < $1`,
      [new Date(now.getTime() - KEEP_FINISHED_MS)],
    );
  }

  #spendBudget(userId: string, now: Date): void {
    const t = now.getTime();
    const b = this.#budget.get(userId);
    if (b === undefined || t - b.windowStart >= 60_000) {
      this.#budget.set(userId, { windowStart: t, n: 1 });
      return;
    }
    if (b.n >= GITHUB_IMPORTS_PER_MINUTE) {
      throw new HttpError(429, 'skill_import_rate_limited', 'Too many GitHub imports; wait a minute.');
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
    metadata: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: user.id },
      action,
      target: typeof metadata.importId === 'string' ? `skill-import:${metadata.importId}` : 'skills',
      outcome,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata,
    });
  }
}

function countKinds(findings: readonly ImportFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}

/** 1.0.0 for a new skill, else the next patch of the latest version. */
export function nextVersion(latest: string | null): string {
  const m = latest === null ? null : /^(\d+)\.(\d+)\.(\d+)/.exec(latest);
  return m === null ? '1.0.0' : `${m[1] ?? '0'}.${m[2] ?? '0'}.${String(Number(m[3] ?? '0') + 1)}`;
}
