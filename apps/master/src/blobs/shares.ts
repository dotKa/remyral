import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import type { BlobService } from './store.js';

/**
 * p17-object-storage: time-limited share links of a job output ("Paylaşılabilir bağlantı"). Created and revoked by
 * owners / admins of the project (`outputs.share`, audited), valid for at most the owner's `shareMaxDays`. The token
 * (32 random bytes, base64url) is shown once; only its SHA-256 is stored. Opening the link (`GET /share/f/:token`,
 * no session, rate-limited per IP) checks the link, the file and its retention again, counts the use, audits it and
 * answers with a short-lived presigned GET (object storage) or streams the file (local disk) — always as an
 * attachment. A pruned file or a revoked / expired link answers 410.
 */

export class ShareError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

export interface ShareView {
  readonly id: string;
  readonly jobId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
}

interface Row {
  id: string;
  job_id: string;
  artifact_id: string;
  attempt_id: string;
  project: string;
  name: string;
  username: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  use_count: number;
}

const view = (r: Row): ShareView => ({
  id: r.id,
  jobId: r.job_id,
  artifactId: r.artifact_id,
  name: r.name,
  createdBy: r.username,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  revokedAt: r.revoked_at?.toISOString() ?? null,
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  useCount: r.use_count,
});

const hashToken = (t: string): Buffer => createHash('sha256').update(t, 'utf8').digest();
export const SHARE_PATH = '/share/f/';
/** Active links per file (a runaway script cannot mint thousands). */
const MAX_ACTIVE_PER_FILE = 20;

export class ShareLinks {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly blobs: BlobService;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  async create(
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
    jobId: string,
    artifactId: string,
    days: number,
  ): Promise<{ link: ShareView; token: string; path: string }> {
    const limits = await this.deps.blobs.limits();
    if (!Number.isInteger(days) || days < 1 || days > limits.shareMaxDays) {
      throw new ShareError(
        400,
        'invalid_share',
        `A link is valid for 1–${String(limits.shareMaxDays)} days.`,
      );
    }
    const { rows } = await this.deps.pool.query<{
      attempt_id: string;
      name: string;
      project: string;
      stored: boolean;
    }>(
      `SELECT a.attempt_id::text AS attempt_id, a.name, j.project,
              (a.content IS NOT NULL OR a.blob_key IS NOT NULL) AS stored
         FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
        WHERE a.job_id = $1 AND a.artifact_id = $2 AND a.kind IN ('output', 'summary')
        ORDER BY a.created_at DESC LIMIT 1`,
      [jobId, artifactId],
    );
    const a = rows[0];
    if (a === undefined) throw new ShareError(404, 'not_found', 'Not found.');
    if (!a.stored) throw new ShareError(410, 'file_removed', 'This file was removed; it cannot be shared.');
    const active = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM blob_share_links WHERE job_id = $1 AND artifact_id = $2
          AND revoked_at IS NULL AND expires_at > $3`,
      [jobId, artifactId, this.deps.clock()],
    );
    if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_PER_FILE) {
      throw new ShareError(409, 'too_many_shares', 'This file has too many active links; revoke one first.');
    }
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const now = this.deps.clock();
    const expiresAt = new Date(now.getTime() + days * 86_400_000);
    await this.deps.pool.query(
      `INSERT INTO blob_share_links (id, token_hash, project, job_id, artifact_id, attempt_id, name, created_by,
                                     created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        hashToken(token),
        a.project,
        jobId,
        artifactId,
        a.attempt_id,
        a.name,
        actor.userId,
        now,
        expiresAt,
      ],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'outputs.share.create',
      target: `job:${jobId}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { shareId: id, artifactId, days, expiresAt: expiresAt.toISOString(), project: a.project },
    });
    const link = await this.#one(id);
    if (link === null) throw new Error('share link vanished');
    return { link, token, path: `${SHARE_PATH}${token}` };
  }

  async #one(id: string): Promise<ShareView | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT s.id, s.job_id::text AS job_id, s.artifact_id, s.attempt_id::text AS attempt_id, s.project, s.name,
              u.username, s.created_at, s.expires_at, s.revoked_at, s.last_used_at, s.use_count
         FROM blob_share_links s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : view(rows[0]);
  }

  async list(jobId: string, artifactId: string): Promise<ShareView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT s.id, s.job_id::text AS job_id, s.artifact_id, s.attempt_id::text AS attempt_id, s.project, s.name,
              u.username, s.created_at, s.expires_at, s.revoked_at, s.last_used_at, s.use_count
         FROM blob_share_links s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.job_id = $1 AND s.artifact_id = $2 ORDER BY s.created_at DESC LIMIT 50`,
      [jobId, artifactId],
    );
    return rows.map(view);
  }

  async revoke(
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
    jobId: string,
    shareId: string,
  ): Promise<ShareView> {
    const { rowCount } = await this.deps.pool.query(
      `UPDATE blob_share_links SET revoked_at = $3, revoked_by = $4
        WHERE id = $1 AND job_id = $2 AND revoked_at IS NULL`,
      [shareId, jobId, this.deps.clock(), actor.userId],
    );
    const link = await this.#one(shareId);
    if (link?.jobId !== jobId) throw new ShareError(404, 'not_found', 'Not found.');
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'outputs.share.revoke',
      target: `job:${jobId}`,
      outcome: (rowCount ?? 0) > 0 ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { shareId, artifactId: link.artifactId },
    });
    return link;
  }

  /**
   * Opens a link: the file's row for the download (null: unknown token). Throws 410 for a revoked or expired link
   * or a removed file. Counts the use and audits it.
   */
  async open(
    token: string,
    meta: { readonly ip: string; readonly userAgent?: string | null },
  ): Promise<{
    name: string;
    mediaType: string;
    content: Buffer | null;
    blobKey: string | null;
    jobId: string;
  } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.deps.pool.query<{
      id: string;
      job_id: string;
      artifact_id: string;
      attempt_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, job_id::text AS job_id, artifact_id, attempt_id::text AS attempt_id, expires_at, revoked_at
         FROM blob_share_links WHERE token_hash = $1`,
      [hashToken(token)],
    );
    const s = rows[0];
    if (s === undefined) return null;
    const now = this.deps.clock();
    const refuse = async (why: string): Promise<never> => {
      await this.deps.audit.record({
        actor: { type: 'anonymous' },
        action: 'outputs.share.open',
        target: `job:${s.job_id}`,
        outcome: 'denied',
        ip: meta.ip,
        userAgent: meta.userAgent ?? null,
        metadata: { shareId: s.id, reason: why },
      });
      throw new ShareError(410, 'share_expired', 'This link has expired or was revoked.');
    };
    if (s.revoked_at !== null) return refuse('revoked');
    if (s.expires_at.getTime() <= now.getTime()) return refuse('expired');
    const file = await this.deps.pool.query<{
      name: string;
      media_type: string;
      content: Buffer | null;
      blob_key: string | null;
    }>(
      `SELECT name, media_type, content, blob_key FROM job_artifacts
        WHERE job_id = $1 AND attempt_id = $2 AND artifact_id = $3`,
      [s.job_id, s.attempt_id, s.artifact_id],
    );
    const f = file.rows[0];
    if (f === undefined || (f.content === null && f.blob_key === null)) return refuse('file_removed');
    await this.deps.pool.query(
      'UPDATE blob_share_links SET use_count = use_count + 1, last_used_at = $2 WHERE id = $1',
      [s.id, now],
    );
    await this.deps.audit.record({
      actor: { type: 'anonymous' },
      action: 'outputs.share.open',
      target: `job:${s.job_id}`,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent ?? null,
      metadata: { shareId: s.id, artifactId: s.artifact_id },
    });
    return {
      name: f.name,
      mediaType: f.media_type,
      content: f.content,
      blobKey: f.blob_key,
      jobId: s.job_id,
    };
  }
}
