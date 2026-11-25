import { SITE_UPLOAD_LIMITS } from '@remyral/protocol/site-files';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { blobs, rowContent } from '../blobs/registry.js';
import type { PagesFile } from '../ops/cloudflare.js';
import {
  checkContent,
  checkManifest,
  type DeclaredFile,
  describeRefusals,
  type ManifestFile,
  type Refusal,
} from './checks.js';

/**
 * p10-site-upload (ADR-0037): a ready-made static site uploaded by a person through Project → Deploy, kept by the
 * master until a `pages.deploy` ops action (`uploadId`) publishes it to Cloudflare Pages.
 *
 *   start (declared file list, checked before any byte) → parts (raw bytes ≤ 4 MiB each, with their SHA-256,
 *   resumable) → complete (assemble, per-file SHA-256, magic bytes, secret scan → per-file rows) → ready
 *
 * The bytes are never served back to the console (the HTML would run on the console origin): the API returns
 * metadata only, and only the ops service reads the files (to upload them to Cloudflare). Receiving uploads belong
 * to their uploader (others: 404) and expire after an hour without a part; ready uploads that were never deployed
 * are deleted after 7 days, and a project keeps at most its newest {@link SITE_UPLOADS_KEPT_PER_PROJECT}.
 */

export const SITE_UPLOAD_TTL_MS = 60 * 60_000;
export const SITE_UPLOAD_UNDEPLOYED_MS = 7 * 24 * 60 * 60_000;
export const SITE_UPLOADS_KEPT_PER_PROJECT = 5;
/** Receiving (unfinished) uploads per user. */
export const SITE_UPLOADS_PER_USER = 2;
/** The sweep runs at most this often from the orchestrator tick. */
const SWEEP_EVERY_MS = 60_000;

/**
 * An ops action still needs upload `u` (retention keeps it): a Pages deploy of it, or — p15-chat-zip — a publish bundle
 * of it that waits for its approval or whose chain still runs (its deploy step is requested only after the approval).
 */
const WAITING_FOR_UPLOAD = `SELECT 1 FROM ops_actions o WHERE o.kind IN ('pages.deploy', 'pages.publish')
  AND o.params->>'uploadId' = u.id::text AND o.state IN ('awaiting_approval', 'executing', 'deploying')`;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export interface SiteUploadActor {
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface SiteUploadFileView {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface SiteUploadView {
  readonly id: string;
  readonly project: string;
  readonly state: 'receiving' | 'ready';
  readonly label: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly partSize: number;
  readonly partCount: number;
  /** Receiving: the parts the master holds (to resume). */
  readonly received: number[] | null;
  readonly siteSha256: string;
  readonly uploadedBy: { readonly id: string; readonly username: string | null };
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly completedAt: string | null;
  readonly lastDeployedAt: string | null;
  readonly lastActionId: string | null;
  /** With `get` only. */
  readonly files: SiteUploadFileView[] | null;
}

interface Row {
  id: string;
  project: string;
  uploaded_by: string;
  username: string | null;
  state: 'receiving' | 'ready';
  label: string | null;
  manifest: ManifestFile[];
  file_count: number;
  total_bytes: string | number;
  part_size: number;
  part_count: number;
  site_sha256: string;
  created_at: Date;
  expires_at: Date | null;
  completed_at: Date | null;
  last_deployed_at: Date | null;
  last_action_id: string | null;
}

const COLS = `u.id::text AS id, u.project, u.uploaded_by::text AS uploaded_by,
  (SELECT username FROM users x WHERE x.id = u.uploaded_by) AS username, u.state, u.label, u.manifest, u.file_count,
  u.total_bytes, u.part_size, u.part_count, u.site_sha256, u.created_at, u.expires_at, u.completed_at,
  u.last_deployed_at, u.last_action_id::text AS last_action_id`;

export interface SiteUploadServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}

function notFound(): HttpError {
  return new HttpError(404, 'upload_not_found', 'Site upload not found.');
}

function refusedError(status: number, code: string, lead: string, refused: readonly Refusal[]): HttpError {
  return new HttpError(
    status,
    code,
    `${lead}: ${describeRefusals(refused)}`.slice(0, 2000),
    {},
    {
      refused: refused.slice(0, 100).map((r) => ({
        path: r.path,
        reason: r.reason,
        ...(r.rule === undefined ? {} : { rule: r.rule }),
        ...(r.line === undefined ? {} : { line: r.line }),
      })),
    },
  );
}

/** Expected length of part `n`. */
function partLength(total: number, size: number, n: number): number {
  const count = Math.ceil(total / size);
  return n < count - 1 ? size : total - size * (count - 1);
}

/** SHA-256 over the manifest's paths and hashes (identifies the site's content). */
export function siteSha256(manifest: readonly { path: string; sha256: string }[]): string {
  return sha256Hex(Buffer.from(JSON.stringify(manifest.map((f) => [f.path, f.sha256])), 'utf8'));
}

export class SiteUploadService {
  #lastSweep = 0;

  constructor(private readonly deps: SiteUploadServiceDeps) {}

  #view(r: Row, files: SiteUploadFileView[] | null, received: number[] | null): SiteUploadView {
    return {
      id: r.id,
      project: r.project,
      state: r.state,
      label: r.label,
      fileCount: r.file_count,
      totalBytes: Number(r.total_bytes),
      partSize: r.part_size,
      partCount: r.part_count,
      received,
      siteSha256: r.site_sha256,
      uploadedBy: { id: r.uploaded_by, username: r.username },
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
      lastDeployedAt: r.last_deployed_at?.toISOString() ?? null,
      lastActionId: r.last_action_id,
      files,
    };
  }

  async #row(project: string, id: string): Promise<Row | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM site_uploads u WHERE u.id = $1 AND u.project = $2`,
      [id, project],
    );
    return rows[0] ?? null;
  }

  /** A receiving upload of the caller (others: 404; expired: discarded, 410). */
  async #receiving(actor: SiteUploadActor, project: string, id: string): Promise<Row> {
    const r = await this.#row(project, id);
    if (r?.uploaded_by !== actor.userId) throw notFound();
    if (r.state !== 'receiving')
      throw new HttpError(409, 'upload_complete', 'This upload is already complete.');
    if (r.expires_at !== null && r.expires_at.getTime() <= this.deps.clock().getTime()) {
      await this.#discard(id);
      throw new HttpError(410, 'upload_expired', 'This upload expired. Start the upload again.');
    }
    return r;
  }

  async #audit(
    actor: SiteUploadActor | null,
    action: string,
    target: string,
    outcome: 'success' | 'denied' | 'failure',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: actor === null ? { type: 'system', id: 'site-uploads' } : { type: 'user', id: actor.userId },
      action,
      target,
      outcome,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      metadata,
    });
  }

  /** Starts an upload: the declared file list is checked completely before any byte is accepted. */
  async start(
    actor: SiteUploadActor,
    project: string,
    input: {
      readonly files: readonly DeclaredFile[];
      readonly label?: string | null | undefined;
      readonly partSize?: number | undefined;
    },
  ): Promise<SiteUploadView> {
    const checked = checkManifest(input.files);
    if (!checked.ok) {
      await this.#audit(actor, 'site.upload.start', `project:${project}`, 'denied', {
        reason: describeRefusals(checked.refused).slice(0, 500),
        files: input.files.length,
      });
      throw refusedError(400, 'site_refused', 'The site was refused', checked.refused);
    }
    const partSize = input.partSize ?? SITE_UPLOAD_LIMITS.partBytes;
    if (
      !Number.isInteger(partSize) ||
      partSize < SITE_UPLOAD_LIMITS.minPartBytes ||
      partSize > SITE_UPLOAD_LIMITS.partBytes
    ) {
      throw new HttpError(
        400,
        'invalid_request',
        `partSize must be between ${String(SITE_UPLOAD_LIMITS.minPartBytes)} and ${String(SITE_UPLOAD_LIMITS.partBytes)} bytes.`,
        {},
        {},
        { reason: 'part_size', min: SITE_UPLOAD_LIMITS.minPartBytes, max: SITE_UPLOAD_LIMITS.partBytes },
      );
    }
    await this.sweep(true);
    const now = this.deps.clock();
    const id = randomUUID();
    const partCount = Math.ceil(checked.totalBytes / partSize);
    const expiresAt = new Date(now.getTime() + SITE_UPLOAD_TTL_MS);
    const label = input.label?.trim().slice(0, 200) ?? null;
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('site-upload:' || $1, 0))`, [
        actor.userId,
      ]);
      const open = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM site_uploads WHERE uploaded_by = $1 AND state = 'receiving' AND expires_at > $2`,
        [actor.userId, now],
      );
      if ((open.rows[0]?.n ?? 0) >= SITE_UPLOADS_PER_USER) {
        throw new HttpError(
          409,
          'too_many_uploads',
          `You already have ${String(SITE_UPLOADS_PER_USER)} site uploads in progress. Finish or cancel one first.`,
          {},
          {},
          { reason: 'site', max: SITE_UPLOADS_PER_USER },
        );
      }
      await tx.query(
        `INSERT INTO site_uploads (id, project, uploaded_by, state, label, manifest, file_count, total_bytes, part_size,
                                   part_count, site_sha256, created_at, expires_at)
         VALUES ($1, $2, $3, 'receiving', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          project,
          actor.userId,
          label === '' ? null : label,
          JSON.stringify(checked.manifest),
          checked.manifest.length,
          checked.totalBytes,
          partSize,
          partCount,
          siteSha256(checked.manifest),
          now,
          expiresAt,
        ],
      );
    });
    await this.#audit(actor, 'site.upload.start', `site-upload:${id}`, 'success', {
      project,
      files: checked.manifest.length,
      bytes: checked.totalBytes,
    });
    const r = await this.#row(project, id);
    if (r === null) throw notFound();
    return this.#view(r, null, []);
  }

  /** Stores part `n` (a retry overwrites it) after checking its length and SHA-256. */
  async putPart(
    actor: SiteUploadActor,
    project: string,
    id: string,
    n: number,
    bytes: Buffer,
    sha256: string,
  ): Promise<{ n: number; received: number; partCount: number; expiresAt: string }> {
    const r = await this.#receiving(actor, project, id);
    const total = Number(r.total_bytes);
    if (!Number.isInteger(n) || n < 0 || n >= r.part_count) {
      throw new HttpError(
        400,
        'part_out_of_range',
        `Part ${String(n)} does not exist; this upload has parts 0–${String(r.part_count - 1)}.`,
        {},
        {},
        { part: n, last: r.part_count - 1 },
      );
    }
    const expected = partLength(total, r.part_size, n);
    if (bytes.byteLength !== expected) {
      throw new HttpError(
        400,
        'part_size_mismatch',
        `Part ${String(n)} must be ${String(expected)} bytes, got ${String(bytes.byteLength)}.`,
        {},
        {},
        { part: n, expected, got: bytes.byteLength },
      );
    }
    if (!SHA256_HEX.test(sha256) || sha256Hex(bytes) !== sha256) {
      throw new HttpError(
        422,
        'part_checksum_mismatch',
        `Part ${String(n)} does not match its SHA-256; send it again.`,
        {},
        {},
        { part: n },
      );
    }
    const expiresAt = new Date(this.deps.clock().getTime() + SITE_UPLOAD_TTL_MS);
    const received = await withTransaction(this.deps.pool, async (tx) => {
      const live = await tx.query(
        `SELECT 1 FROM site_uploads WHERE id = $1 AND state = 'receiving' FOR UPDATE`,
        [id],
      );
      if (live.rowCount === 0) throw notFound();
      await tx.query(
        `INSERT INTO site_upload_parts (upload_id, n, sha256, bytes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (upload_id, n) DO UPDATE SET sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes`,
        [id, n, sha256, bytes],
      );
      await tx.query('UPDATE site_uploads SET expires_at = $2 WHERE id = $1', [id, expiresAt]);
      const c = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM site_upload_parts WHERE upload_id = $1',
        [id],
      );
      return c.rows[0]?.n ?? 0;
    });
    return { n, received, partCount: r.part_count, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Assembles the parts, checks every file (size, SHA-256, magic bytes, secret scan) and stores it per file. Missing
   * parts: 409, the upload stays. Any refused file: the whole upload is discarded, audited and 422 names each file
   * with its reason (rule + line for a secret, never the value).
   */
  async complete(actor: SiteUploadActor, project: string, id: string): Promise<SiteUploadView> {
    const r = await this.#receiving(actor, project, id);
    const { rows } = await this.deps.pool.query<{ n: number; bytes: Buffer }>(
      'SELECT n, bytes FROM site_upload_parts WHERE upload_id = $1 ORDER BY n',
      [id],
    );
    const have = new Set(rows.map((x) => x.n));
    const missing: number[] = [];
    for (let i = 0; i < r.part_count; i++) if (!have.has(i)) missing.push(i);
    if (missing.length > 0) {
      throw new HttpError(
        409,
        'upload_incomplete',
        `Parts ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''} have not been received.`,
        {},
        {},
        { parts: `${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}` },
      );
    }
    const all = Buffer.concat(rows.map((x) => x.bytes));
    const refused: Refusal[] = [];
    const files: { f: ManifestFile; content: Buffer }[] = [];
    if (all.byteLength !== Number(r.total_bytes)) {
      refused.push({ path: '', reason: 'the received bytes do not add up to the declared size' });
    } else {
      let off = 0;
      for (const f of r.manifest) {
        const content = all.subarray(off, off + f.size);
        off += f.size;
        refused.push(...checkContent(f, content, sha256Hex(content)));
        files.push({ f, content });
      }
    }
    if (refused.length > 0) {
      await this.#discard(id);
      await this.#audit(actor, 'site.upload.complete', `site-upload:${id}`, 'denied', {
        project,
        // File names, reasons, rules and lines only — never content.
        refused: refused
          .slice(0, 50)
          .map((x) => ({ path: x.path, reason: x.reason, rule: x.rule ?? null, line: x.line ?? null })),
      });
      throw refusedError(422, 'site_refused', 'The site was refused (the upload was discarded)', refused);
    }
    const now = this.deps.clock();
    // p17-object-storage: every checked file goes to the blob store first (never Postgres); the rows keep the keys.
    const keys: string[] = [];
    for (const [idx, { f, content }] of files.entries()) {
      keys.push(
        await blobs().write(
          'site-upload',
          `site-uploads/${id}/${String(idx)}`,
          Buffer.from(content),
          f.contentType,
        ),
      );
    }
    await withTransaction(this.deps.pool, async (tx) => {
      const live = await tx.query(
        `SELECT 1 FROM site_uploads WHERE id = $1 AND state = 'receiving' FOR UPDATE`,
        [id],
      );
      if (live.rowCount === 0) throw notFound();
      for (const [idx, { f }] of files.entries()) {
        await tx.query(
          `INSERT INTO site_upload_files (upload_id, idx, path, content_type, size_bytes, sha256, content, blob_key)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
          [id, idx, f.path, f.contentType, f.size, f.sha256, keys[idx]],
        );
      }
      await tx.query('DELETE FROM site_upload_parts WHERE upload_id = $1', [id]);
      await tx.query(
        `UPDATE site_uploads SET state = 'ready', completed_at = $2, expires_at = NULL WHERE id = $1`,
        [id, now],
      );
    });
    await this.#audit(actor, 'site.upload.complete', `site-upload:${id}`, 'success', {
      project,
      files: r.file_count,
      bytes: Number(r.total_bytes),
      siteSha256: r.site_sha256,
    });
    await this.#keepNewest(project);
    return this.get(project, id);
  }

  /** Metadata of one upload with its file list (never the bytes). Receiving: also the received parts. */
  async get(project: string, id: string): Promise<SiteUploadView> {
    const r = await this.#row(project, id);
    if (r === null) throw notFound();
    let received: number[] | null = null;
    if (r.state === 'receiving') {
      const p = await this.deps.pool.query<{ n: number }>(
        'SELECT n FROM site_upload_parts WHERE upload_id = $1 ORDER BY n',
        [id],
      );
      received = p.rows.map((x) => x.n);
    }
    return this.#view(
      r,
      r.manifest.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, contentType: f.contentType })),
      received,
    );
  }

  /** The project's ready uploads, newest first (no file lists). */
  async list(project: string): Promise<SiteUploadView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM site_uploads u WHERE u.project = $1 AND u.state = 'ready' ORDER BY u.created_at DESC LIMIT 50`,
      [project],
    );
    return rows.map((r) => this.#view(r, null, null));
  }

  /** Deletes an upload: its uploader, or someone who may approve deploys in the project (`mayDeleteAny`). */
  async remove(actor: SiteUploadActor, project: string, id: string, mayDeleteAny: boolean): Promise<void> {
    const r = await this.#row(project, id);
    if (r === null || (r.uploaded_by !== actor.userId && !mayDeleteAny)) throw notFound();
    await this.#discard(id);
    await this.#audit(actor, 'site.upload.delete', `site-upload:${id}`, 'success', {
      project,
      state: r.state,
    });
  }

  async #discard(id: string): Promise<void> {
    await this.deps.pool.query('DELETE FROM site_uploads WHERE id = $1', [id]);
  }

  // ------------------------------------------------------------------------------------- deploys

  /**
   * The files of a ready upload of `project` for a Pages deploy (ops service only — nothing else reads the bytes).
   * Throws OpsError-compatible HttpErrors for a missing / unfinished upload.
   */
  async deployFiles(
    project: string,
    id: string,
  ): Promise<{ files: PagesFile[]; upload: SiteUploadView } | null> {
    const r = await this.#row(project, id);
    if (r?.state !== 'ready') return null;
    const { rows: stored } = await this.deps.pool.query<{
      path: string;
      content_type: string;
      content: Buffer | null;
      blob_key: string | null;
      sha256: string;
    }>(
      `SELECT path, content_type, content, blob_key, sha256 FROM site_upload_files WHERE upload_id = $1
        ORDER BY idx`,
      [id],
    );
    if (stored.length !== r.file_count) return null;
    // p17-object-storage: the bytes come from the blob store (or the legacy column until blobs:migrate ran).
    const rows: { path: string; content_type: string; content: Buffer }[] = [];
    for (const f of stored) {
      const content = await rowContent(f, 26 * 1024 * 1024).catch(() => null);
      // Defence in depth: what is published is exactly what was checked.
      if (content === null || sha256Hex(content) !== f.sha256) return null;
      rows.push({ path: f.path, content_type: f.content_type, content });
    }
    return {
      files: rows.map((f) => ({ path: f.path, content: f.content, contentType: f.content_type })),
      upload: this.#view(r, null, null),
    };
  }

  /** A `pages.deploy` of this upload was accepted by Cloudflare. */
  async markDeployed(id: string, actionId: string): Promise<void> {
    await this.deps.pool.query(
      'UPDATE site_uploads SET last_deployed_at = $2, last_action_id = $3 WHERE id = $1',
      [id, this.deps.clock(), actionId],
    );
  }

  // ------------------------------------------------------------------------------------ retention

  /** Keeps the project's newest ready uploads (and any an ops action still waits for); deletes the rest. */
  async #keepNewest(project: string): Promise<number> {
    const r = await this.deps.pool.query(
      `DELETE FROM site_uploads u WHERE u.project = $1 AND u.state = 'ready'
          AND u.id NOT IN (SELECT id FROM site_uploads WHERE project = $1 AND state = 'ready'
                            ORDER BY created_at DESC LIMIT $2)
          AND NOT EXISTS (${WAITING_FOR_UPLOAD})`,
      [project, SITE_UPLOADS_KEPT_PER_PROJECT],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Retention (orchestrator tick, at most once a minute unless `force`): expired receiving uploads; ready uploads
   * never deployed within 7 days (unless an ops action still waits for them); more than the newest
   * {@link SITE_UPLOADS_KEPT_PER_PROJECT} per project. Returns how many were deleted.
   */
  async sweep(force = false): Promise<number> {
    const now = this.deps.clock();
    if (!force && now.getTime() - this.#lastSweep < SWEEP_EVERY_MS) return 0;
    this.#lastSweep = now.getTime();
    const expired = await this.deps.pool.query(
      `DELETE FROM site_uploads WHERE state = 'receiving' AND expires_at <= $1`,
      [now],
    );
    const stale = await this.deps.pool.query(
      `DELETE FROM site_uploads u WHERE u.state = 'ready' AND u.last_deployed_at IS NULL AND u.created_at <= $1
          AND NOT EXISTS (${WAITING_FOR_UPLOAD})
        RETURNING u.id`,
      [new Date(now.getTime() - SITE_UPLOAD_UNDEPLOYED_MS)],
    );
    let extra = 0;
    const projects = await this.deps.pool.query<{ project: string }>(
      `SELECT project FROM site_uploads WHERE state = 'ready' GROUP BY project HAVING count(*) > $1`,
      [SITE_UPLOADS_KEPT_PER_PROJECT],
    );
    for (const p of projects.rows) extra += await this.#keepNewest(p.project);
    const n = (expired.rowCount ?? 0) + (stale.rowCount ?? 0) + extra;
    if ((stale.rowCount ?? 0) + extra > 0) {
      await this.#audit(null, 'site.upload.prune', 'site-uploads', 'success', {
        undeployed: stale.rowCount ?? 0,
        overLimit: extra,
        expiredReceiving: expired.rowCount ?? 0,
      });
    }
    return n;
  }
}
