import {
  INPUT_BUNDLE_LIMITS,
  type InputBundleEntry,
  type InputBundleFinding,
  type InputBundleOp,
} from '@remyral/protocol';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import { blobs } from '../blobs/registry.js';
import { blobKeys } from '../blobs/store.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  checkContent,
  checkManifest,
  type DeclaredFile,
  describeFindings,
  describeRefusals,
  MAX_FINDINGS,
  type Refusal,
} from './checks.js';

/**
 * p16-zip-job-input (ADR-0060, docs/design/p16-zip-job-input.md): job input bundles — the files of a .zip the owner
 * dropped into the chat or the job composer, unpacked in the browser, kept by the master and pulled by the worker into
 * a job's `in/` before the agent runs.
 *
 *   start (declared file list, checked before any byte) → parts (raw bytes ≤ 4 MiB each, with their SHA-256,
 *   resumable) → complete (stream the parts, per file: size, SHA-256, executables, secret scan) → ready
 *
 * A secret finding does not discard the upload: `complete` answers 422 `input_secrets_found` naming file, rule and line
 * and keeps the parts, and the uploader may call it again with `allowSecrets` ("Yine de gönder") — the override is
 * audited and the findings stay on the bundle (the job page and the assistant name them). Any other refusal discards
 * the upload. The bytes are never served back to the console; only the worker relay of a job that names the bundle
 * (lease-checked by the session handler) reads them.
 */

export const INPUT_UPLOAD_TTL_MS = 60 * 60_000;
export const INPUT_UPLOAD_RETENTION_MS = INPUT_BUNDLE_LIMITS.retentionDays * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** A job still needs the bundle (its retention waits): any job that names it and has not ended. */
const NEEDED_BY_A_JOB = `SELECT 1 FROM job_input_uploads x JOIN jobs j ON j.id = x.job_id
  WHERE x.upload_id = u.id AND j.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST')`;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** SHA-256 over the JSON array of [path, sha256] in bundle order (the worker checks its listing against it). */
export function bundleSha256(manifest: readonly { path: string; sha256: string }[]): string {
  return sha256Hex(Buffer.from(JSON.stringify(manifest.map((f) => [f.path, f.sha256])), 'utf8'));
}

export interface InputUploadActor {
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface InputUploadView {
  readonly id: string;
  readonly project: string;
  readonly state: 'receiving' | 'ready';
  readonly label: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly received: number[] | null;
  readonly bundleSha256: string;
  readonly uploadedBy: { readonly id: string; readonly username: string | null };
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly lastUsedAt: string | null;
  /** When the retention removes it unless a job uses it again (ready only). */
  readonly keptUntil: string | null;
  /** Secret findings the uploader sent anyway (never a value). */
  readonly secretFindings: InputBundleFinding[];
  readonly sentWithSecrets: boolean;
  /** With `get` only. */
  readonly files: { path: string; size: number; sha256: string }[] | null;
}

interface Row {
  id: string;
  project: string;
  uploaded_by: string;
  username: string | null;
  state: 'receiving' | 'ready';
  label: string | null;
  manifest: DeclaredFile[];
  file_count: number;
  total_bytes: string | number;
  part_size: number;
  part_count: number;
  bundle_sha256: string;
  created_at: Date;
  expires_at: Date | null;
  completed_at: Date | null;
  last_used_at: Date | null;
  secret_findings: InputBundleFinding[];
  secrets_override_at: Date | null;
  chat_thread_id: string | null;
}

const COLS = `u.id::text AS id, u.project, u.uploaded_by::text AS uploaded_by,
  (SELECT username FROM users x WHERE x.id = u.uploaded_by) AS username, u.state, u.label, u.manifest, u.file_count,
  u.total_bytes, u.part_size, u.part_count, u.bundle_sha256, u.created_at, u.expires_at, u.completed_at,
  u.last_used_at, u.secret_findings, u.secrets_override_at, u.chat_thread_id::text AS chat_thread_id`;

export interface InputUploadServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** The security policy's `inputs.executables` (native executables may be job inputs). Absent: never. */
  readonly allowExecutables?: () => Promise<boolean>;
}

function notFound(): HttpError {
  return new HttpError(404, 'input_upload_not_found', 'Input bundle not found (or no longer kept).');
}

function refusedError(status: number, lead: string, refused: readonly Refusal[]): HttpError {
  return new HttpError(
    status,
    'input_refused',
    `${lead}: ${describeRefusals(refused)}`.slice(0, 2000),
    {},
    { refused: refused.slice(0, 100).map((r) => ({ path: r.path, reason: r.reason })) },
  );
}

function partLength(total: number, size: number, n: number): number {
  const count = Math.ceil(total / size);
  return n < count - 1 ? size : total - size * (count - 1);
}

/** Sentinel to roll a `complete` transaction back after the checks (nothing stored). */
class Rollback extends Error {
  constructor(
    readonly refused: Refusal[],
    readonly findings: InputBundleFinding[],
  ) {
    super('rollback');
  }
}

export class InputUploadService {
  #lastSweep = 0;

  constructor(private readonly deps: InputUploadServiceDeps) {}

  async #allowExecutables(): Promise<boolean> {
    return (await this.deps.allowExecutables?.().catch(() => false)) === true;
  }

  #keptUntil(r: Row): string | null {
    if (r.state !== 'ready') return null;
    const base = r.last_used_at ?? r.completed_at ?? r.created_at;
    return new Date(base.getTime() + INPUT_UPLOAD_RETENTION_MS).toISOString();
  }

  #view(r: Row, files: InputUploadView['files'], received: number[] | null): InputUploadView {
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
      bundleSha256: r.bundle_sha256,
      uploadedBy: { id: r.uploaded_by, username: r.username },
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      keptUntil: this.#keptUntil(r),
      secretFindings: Array.isArray(r.secret_findings) ? r.secret_findings : [],
      sentWithSecrets: r.secrets_override_at !== null,
      files,
    };
  }

  async #rowById(id: string, db: Queryable = this.deps.pool): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<Row>(`SELECT ${COLS} FROM input_uploads u WHERE u.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async #row(project: string, id: string): Promise<Row | null> {
    const r = await this.#rowById(id);
    return r?.project === project ? r : null;
  }

  async #receiving(actor: InputUploadActor, project: string, id: string): Promise<Row> {
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
    actor: InputUploadActor | null,
    action: string,
    target: string,
    outcome: 'success' | 'denied' | 'failure',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: actor === null ? { type: 'system', id: 'input-uploads' } : { type: 'user', id: actor.userId },
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
    actor: InputUploadActor,
    project: string,
    input: {
      readonly files: readonly DeclaredFile[];
      readonly label?: string | null | undefined;
      readonly partSize?: number | undefined;
    },
  ): Promise<InputUploadView> {
    const checked = checkManifest(input.files, await this.#allowExecutables());
    if (!checked.ok) {
      await this.#audit(actor, 'input.upload.start', `project:${project}`, 'denied', {
        reason: describeRefusals(checked.refused).slice(0, 500),
        files: input.files.length,
      });
      throw refusedError(400, 'The files were refused', checked.refused);
    }
    const L = INPUT_BUNDLE_LIMITS;
    const partSize = input.partSize ?? L.partBytes;
    if (!Number.isInteger(partSize) || partSize < L.minPartBytes || partSize > L.partBytes) {
      throw new HttpError(
        400,
        'invalid_request',
        `partSize must be between ${String(L.minPartBytes)} and ${String(L.partBytes)} bytes.`,
        {},
        {},
        { reason: 'part_size', min: L.minPartBytes, max: L.partBytes },
      );
    }
    await this.sweep(true);
    const now = this.deps.clock();
    const id = randomUUID();
    const partCount = Math.ceil(checked.totalBytes / partSize);
    const label = input.label?.trim().slice(0, 200) ?? null;
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('input-upload:' || $1, 0))`, [
        actor.userId,
      ]);
      const open = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM input_uploads WHERE uploaded_by = $1 AND state = 'receiving' AND expires_at > $2`,
        [actor.userId, now],
      );
      if ((open.rows[0]?.n ?? 0) >= L.receivingPerUser) {
        throw new HttpError(
          409,
          'too_many_uploads',
          `You already have ${String(L.receivingPerUser)} uploads in progress. Finish or cancel one first.`,
          {},
          {},
          { reason: 'input', max: L.receivingPerUser },
        );
      }
      await tx.query(
        `INSERT INTO input_uploads (id, project, uploaded_by, state, label, manifest, file_count, total_bytes,
                                    part_size, part_count, bundle_sha256, created_at, expires_at)
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
          bundleSha256(checked.manifest),
          now,
          new Date(now.getTime() + INPUT_UPLOAD_TTL_MS),
        ],
      );
    });
    await this.#audit(actor, 'input.upload.start', `input-upload:${id}`, 'success', {
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
    actor: InputUploadActor,
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
    const expiresAt = new Date(this.deps.clock().getTime() + INPUT_UPLOAD_TTL_MS);
    const received = await withTransaction(this.deps.pool, async (tx) => {
      const live = await tx.query(
        `SELECT 1 FROM input_uploads WHERE id = $1 AND state = 'receiving' FOR UPDATE`,
        [id],
      );
      if (live.rowCount === 0) throw notFound();
      await tx.query(
        `INSERT INTO input_upload_parts (upload_id, n, sha256, bytes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (upload_id, n) DO UPDATE SET sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes`,
        [id, n, sha256, bytes],
      );
      await tx.query('UPDATE input_uploads SET expires_at = $2 WHERE id = $1', [id, expiresAt]);
      const c = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM input_upload_parts WHERE upload_id = $1',
        [id],
      );
      return c.rows[0]?.n ?? 0;
    });
    return { n, received, partCount: r.part_count, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Streams the parts in order, checks every file and stores it. Missing parts: 409 (the upload stays). A refused file
   * (size, SHA-256, executable): the upload is discarded, audited, 422 `input_refused`. Secret findings without
   * `allowSecrets`: nothing stored, the parts stay, audited, 422 `input_secrets_found` (file, rule, line per finding);
   * with `allowSecrets`: stored with its findings, the override audited (`input.upload.secrets_override`).
   */
  async complete(
    actor: InputUploadActor,
    project: string,
    id: string,
    opts: { readonly allowSecrets?: boolean | undefined } = {},
  ): Promise<InputUploadView> {
    const r = await this.#receiving(actor, project, id);
    const have = await this.deps.pool.query<{ n: number }>(
      'SELECT n FROM input_upload_parts WHERE upload_id = $1 ORDER BY n',
      [id],
    );
    const got = new Set(have.rows.map((x) => x.n));
    const missing: number[] = [];
    for (let i = 0; i < r.part_count; i++) if (!got.has(i)) missing.push(i);
    if (missing.length > 0) {
      const list = `${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`;
      throw new HttpError(
        409,
        'upload_incomplete',
        `Parts ${list} have not been received.`,
        {},
        {},
        { parts: list },
      );
    }
    const allowExecutables = await this.#allowExecutables();
    const allowSecrets = opts.allowSecrets === true;
    const now = this.deps.clock();
    let findings: InputBundleFinding[];
    try {
      findings = await withTransaction(this.deps.pool, async (tx) => {
        const live = await tx.query(
          `SELECT 1 FROM input_uploads WHERE id = $1 AND state = 'receiving' FOR UPDATE`,
          [id],
        );
        if (live.rowCount === 0) throw notFound();
        const refused: Refusal[] = [];
        const found: InputBundleFinding[] = [];
        const files = r.manifest;
        let fi = 0;
        let chunks: Buffer[] = [];
        let have = 0;
        let received = 0;
        const finish = async (): Promise<void> => {
          // Every file that is complete now (empty files included); the bytes are joined once per part.
          const next = files[fi];
          if (next === undefined || have < next.size) return;
          const all = chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks);
          let off = 0;
          while (fi < files.length) {
            const f = files[fi];
            if (f === undefined || all.length - off < f.size) break;
            const content = all.subarray(off, off + f.size);
            off += f.size;
            const c = checkContent(f, content, sha256Hex(content), allowExecutables);
            refused.push(...c.refused);
            found.push(...c.findings);
            if (refused.length === 0) {
              // p17-object-storage-rest: the checked file goes to the blob store; a bundle refused / rolled back
              // later leaves unreferenced blobs, which the blob GC removes.
              const key = await blobs().write('input-bundle', blobKeys.inputBundle(id, fi), content);
              await tx.query(
                `INSERT INTO input_upload_files (upload_id, idx, path, size_bytes, sha256, content, blob_key)
                 VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
                [id, fi, f.path, f.size, f.sha256, key],
              );
            }
            fi += 1;
          }
          const rest = all.subarray(off);
          chunks = rest.length > 0 ? [rest] : [];
          have = rest.length;
        };
        for (let n = 0; n < r.part_count; n++) {
          const part = await tx.query<{ bytes: Buffer }>(
            'SELECT bytes FROM input_upload_parts WHERE upload_id = $1 AND n = $2',
            [id, n],
          );
          const bytes = part.rows[0]?.bytes;
          if (bytes === undefined) throw new Rollback([{ path: '', reason: 'a part disappeared' }], []);
          received += bytes.length;
          chunks.push(bytes);
          have += bytes.length;
          await finish();
        }
        await finish();
        if (received !== Number(r.total_bytes) || fi !== files.length || have !== 0) {
          refused.push({ path: '', reason: 'the received bytes do not add up to the declared files' });
        }
        if (refused.length > 0 || (found.length > 0 && !allowSecrets)) throw new Rollback(refused, found);
        await tx.query('DELETE FROM input_upload_parts WHERE upload_id = $1', [id]);
        await tx.query(
          `UPDATE input_uploads SET state = 'ready', completed_at = $2, expires_at = NULL, secret_findings = $3,
                  secrets_override_by = $4, secrets_override_at = $5
            WHERE id = $1`,
          [
            id,
            now,
            JSON.stringify(found.slice(0, MAX_FINDINGS)),
            found.length > 0 ? actor.userId : null,
            found.length > 0 ? now : null,
          ],
        );
        return found;
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
      if (err.refused.length > 0) {
        await this.#discard(id);
        await this.#audit(actor, 'input.upload.complete', `input-upload:${id}`, 'denied', {
          project,
          refused: err.refused.slice(0, 50).map((x) => ({ path: x.path, reason: x.reason })),
        });
        throw refusedError(422, 'The files were refused (the upload was discarded)', err.refused);
      }
      await this.#audit(actor, 'input.upload.complete', `input-upload:${id}`, 'denied', {
        project,
        reason: 'secrets_found',
        // File names, rules and lines only — never content.
        findings: err.findings.slice(0, 50),
        total: err.findings.length,
      });
      throw new HttpError(
        422,
        'input_secrets_found',
        `Possible secrets were found: ${describeFindings(err.findings)}. Remove them, or send the files anyway.`.slice(
          0,
          2000,
        ),
        {},
        { findings: err.findings.slice(0, 100), total: err.findings.length },
      );
    }
    if (findings.length > 0) {
      await this.#audit(actor, 'input.upload.secrets_override', `input-upload:${id}`, 'success', {
        project,
        findings: findings.slice(0, 50),
        total: findings.length,
      });
    }
    await this.#audit(actor, 'input.upload.complete', `input-upload:${id}`, 'success', {
      project,
      files: r.file_count,
      bytes: Number(r.total_bytes),
      bundleSha256: r.bundle_sha256,
      ...(findings.length > 0 ? { sentWithSecrets: findings.length } : {}),
    });
    await this.#keepNewest(project);
    return this.get(project, id);
  }

  /** Metadata of one bundle with its file list (never the bytes). Receiving: also the received parts. */
  async get(project: string, id: string): Promise<InputUploadView> {
    const r = await this.#row(project, id);
    if (r === null) throw notFound();
    let received: number[] | null = null;
    if (r.state === 'receiving') {
      const p = await this.deps.pool.query<{ n: number }>(
        'SELECT n FROM input_upload_parts WHERE upload_id = $1 ORDER BY n',
        [id],
      );
      received = p.rows.map((x) => x.n);
    }
    return this.#view(
      r,
      r.manifest.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      received,
    );
  }

  /** The project's ready bundles, newest first (no file lists). */
  async list(project: string): Promise<InputUploadView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM input_uploads u WHERE u.project = $1 AND u.state = 'ready'
        ORDER BY u.created_at DESC LIMIT 50`,
      [project],
    );
    return rows.map((r) => this.#view(r, null, null));
  }

  /** Deletes a bundle: its uploader, or a project admin (`mayDeleteAny`). Jobs keep their facts. */
  async remove(actor: InputUploadActor, project: string, id: string, mayDeleteAny: boolean): Promise<void> {
    const r = await this.#row(project, id);
    if (r === null || (r.uploaded_by !== actor.userId && !mayDeleteAny)) throw notFound();
    await this.#discard(id);
    await this.#audit(actor, 'input.upload.delete', `input-upload:${id}`, 'success', {
      project,
      state: r.state,
    });
  }

  async #discard(id: string): Promise<void> {
    await this.deps.pool.query('DELETE FROM input_uploads WHERE id = $1', [id]);
  }

  // ---------------------------------------------------------------------------------------------- chat

  /**
   * The bundles a chat message names, checked for its sender: each exists, is theirs, is ready and lies in a project
   * where they may create jobs. Anything else is 404 `input_upload_not_found` (one answer for all cases).
   */
  async resolveForMessage(subject: Subject, ids: readonly string[]): Promise<InputUploadView[]> {
    const out: InputUploadView[] = [];
    for (const id of new Set(ids)) {
      const r = await this.#rowById(id);
      if (
        r === null ||
        r.uploaded_by !== subject.userId ||
        r.state !== 'ready' ||
        !authorize(subject, 'jobs.create', { project: r.project }).allow
      ) {
        throw notFound();
      }
      out.push(this.#view(r, null, null));
    }
    return out;
  }

  /** Links bundles to the chat message that carried them. */
  async bind(tx: Queryable, ids: readonly string[], threadId: string, messageId: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.query(
      'UPDATE input_uploads SET chat_thread_id = $2, chat_message_id = $3 WHERE id = ANY($1::uuid[])',
      [[...new Set(ids)], threadId, messageId],
    );
  }

  /** A bundle any project member may read the jobs of (the assistant's paging tool, the job page). */
  async readable(
    subject: Subject,
    id: string,
  ): Promise<(InputUploadView & { files: DeclaredFile[] }) | null> {
    const r = await this.#rowById(id);
    if (r === null || !authorize(subject, 'jobs.read', { project: r.project }).allow) return null;
    const v = this.#view(
      r,
      r.manifest.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      null,
    );
    return { ...v, files: v.files ?? [] };
  }

  /** Jobs that took the bundle (newest first). */
  async jobsOf(id: string): Promise<{ jobId: string; state: string; attachedAt: string }[]> {
    const { rows } = await this.deps.pool.query<{ job_id: string; state: string; attached_at: Date }>(
      `SELECT x.job_id::text AS job_id, j.state, x.attached_at FROM job_input_uploads x JOIN jobs j ON j.id = x.job_id
        WHERE x.source_id = $1 ORDER BY x.attached_at DESC LIMIT 20`,
      [id],
    );
    return rows.map((r) => ({ jobId: r.job_id, state: r.state, attachedAt: r.attached_at.toISOString() }));
  }

  // ---------------------------------------------------------------------------------------------- jobs

  /**
   * The bundle a new job of `project` may take: ready and in the same project (404 / 409 otherwise). The caller has
   * already checked `jobs.create` on the project.
   */
  async forNewJob(project: string, id: string): Promise<InputUploadView> {
    const r = await this.#rowById(id);
    if (r?.state !== 'ready') {
      throw notFound();
    }
    if (r.project !== project) {
      throw new HttpError(
        409,
        'input_upload_wrong_project',
        `That input bundle belongs to project ${r.project}; a job of ${project} cannot use it.`,
        {},
        {},
        { project: r.project },
      );
    }
    return this.#view(r, null, null);
  }

  /** The job's bundle as the job page shows it (facts stay after the bundle was pruned). */
  async forJob(jobId: string): Promise<{
    readonly sourceId: string;
    readonly label: string | null;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly attachedAt: string;
    readonly pulledAt: string | null;
    readonly kept: boolean;
    readonly upload: InputUploadView | null;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      upload_id: string | null;
      source_id: string;
      label: string | null;
      file_count: number;
      total_bytes: string | number;
      attached_at: Date;
      pulled_at: Date | null;
    }>(
      `SELECT upload_id::text AS upload_id, source_id::text AS source_id, label, file_count, total_bytes, attached_at,
              pulled_at
         FROM job_input_uploads WHERE job_id = $1`,
      [jobId],
    );
    const x = rows[0];
    if (x === undefined) return null;
    const r = x.upload_id === null ? null : await this.#rowById(x.upload_id);
    return {
      sourceId: x.source_id,
      label: x.label,
      fileCount: x.file_count,
      totalBytes: Number(x.total_bytes),
      attachedAt: x.attached_at.toISOString(),
      pulledAt: x.pulled_at?.toISOString() ?? null,
      kept: r?.state === 'ready',
      upload:
        r?.state === 'ready'
          ? this.#view(
              r,
              r.manifest.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
              null,
            )
          : null,
    };
  }

  /** ASSIGN_JOB `execution.inputBundle` of a job (null: none, or the bundle is gone — the job then runs without it). */
  async assignment(
    jobId: string,
  ): Promise<{ uploadId: string; files: number; totalBytes: number; bundleSha256: string } | null> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      file_count: number;
      total_bytes: string | number;
      bundle_sha256: string;
    }>(
      `SELECT u.id::text AS id, u.file_count, u.total_bytes, u.bundle_sha256
         FROM job_input_uploads x JOIN input_uploads u ON u.id = x.upload_id
        WHERE x.job_id = $1 AND u.state = 'ready'`,
      [jobId],
    );
    const u = rows[0];
    return u === undefined
      ? null
      : {
          uploadId: u.id,
          files: u.file_count,
          totalBytes: Number(u.total_bytes),
          bundleSha256: u.bundle_sha256,
        };
  }

  /** Whether the job names a bundle (placement: only `input-bundle-v1` workers). */
  async hasBundle(jobId: string): Promise<boolean> {
    const { rowCount } = await this.deps.pool.query(
      'SELECT 1 FROM job_input_uploads WHERE job_id = $1 AND upload_id IS NOT NULL',
      [jobId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * One relay answer for a job's INPUT_BUNDLE_REQUEST (the session handler has checked the live lease): a page of the
   * listing, or a slice of one file. Null: the job has no (kept) bundle, or the file / offset does not exist.
   */
  async slice(
    jobId: string,
    op: InputBundleOp,
  ): Promise<
    | { readonly kind: 'list'; readonly entries: InputBundleEntry[]; readonly total: number }
    | { readonly kind: 'read'; readonly data: Buffer; readonly eof: boolean }
    | null
  > {
    const { rows } = await this.deps.pool.query<{ id: string; manifest: DeclaredFile[] }>(
      `SELECT u.id::text AS id, u.manifest FROM job_input_uploads x JOIN input_uploads u ON u.id = x.upload_id
        WHERE x.job_id = $1 AND u.state = 'ready'`,
      [jobId],
    );
    const u = rows[0];
    if (u === undefined) return null;
    if (op.op === 'list') {
      const entries = u.manifest
        .slice(op.offset, op.offset + INPUT_BUNDLE_LIMITS.listPage)
        .map((f, i) => ({ index: op.offset + i, path: f.path, size: f.size, sha256: f.sha256 }));
      if (op.offset === 0) {
        const now = this.deps.clock();
        await this.deps.pool.query('UPDATE input_uploads SET last_used_at = $2 WHERE id = $1', [u.id, now]);
        await this.deps.pool.query(
          'UPDATE job_input_uploads SET pulled_at = COALESCE(pulled_at, $2) WHERE job_id = $1',
          [jobId, now],
        );
      }
      return { kind: 'list', entries, total: u.manifest.length };
    }
    const f = await this.deps.pool.query<{
      size_bytes: number;
      data: Buffer | null;
      blob_key: string | null;
    }>(
      `SELECT size_bytes, substring(content FROM $3::int + 1 FOR $4::int) AS data, blob_key
         FROM input_upload_files WHERE upload_id = $1 AND idx = $2`,
      [u.id, op.index, op.offset, INPUT_BUNDLE_LIMITS.chunkBytes],
    );
    const row = f.rows[0];
    if (row === undefined || op.offset > row.size_bytes) return null;
    // The legacy bytea slice, or the same range of the blob.
    const data =
      row.blob_key !== null
        ? await blobs().range(
            row.blob_key,
            op.offset,
            Math.min(INPUT_BUNDLE_LIMITS.chunkBytes, row.size_bytes - op.offset),
          )
        : (row.data ?? Buffer.alloc(0));
    return { kind: 'read', data, eof: op.offset + data.length >= row.size_bytes };
  }

  // ------------------------------------------------------------------------------------ retention

  /** Keeps the project's newest ready bundles (and any an unfinished job needs); deletes the rest. */
  async #keepNewest(project: string): Promise<number> {
    const r = await this.deps.pool.query(
      `DELETE FROM input_uploads u WHERE u.project = $1 AND u.state = 'ready'
          AND u.id NOT IN (SELECT id FROM input_uploads WHERE project = $1 AND state = 'ready'
                            ORDER BY COALESCE(last_used_at, completed_at, created_at) DESC LIMIT $2)
          AND NOT EXISTS (${NEEDED_BY_A_JOB})`,
      [project, INPUT_BUNDLE_LIMITS.keptPerProject],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Retention (orchestrator tick, at most once a minute unless `force`): expired receiving uploads; ready bundles not
   * used for {@link INPUT_BUNDLE_LIMITS.retentionDays} days (unless an unfinished job still needs them); more than the
   * newest {@link INPUT_BUNDLE_LIMITS.keptPerProject} per project. Returns how many were deleted.
   */
  async sweep(force = false): Promise<number> {
    const now = this.deps.clock();
    if (!force && now.getTime() - this.#lastSweep < SWEEP_EVERY_MS) return 0;
    this.#lastSweep = now.getTime();
    const expired = await this.deps.pool.query(
      `DELETE FROM input_uploads WHERE state = 'receiving' AND expires_at <= $1`,
      [now],
    );
    const stale = await this.deps.pool.query(
      `DELETE FROM input_uploads u WHERE u.state = 'ready'
          AND COALESCE(u.last_used_at, u.completed_at, u.created_at) <= $1
          AND NOT EXISTS (${NEEDED_BY_A_JOB})`,
      [new Date(now.getTime() - INPUT_UPLOAD_RETENTION_MS)],
    );
    let extra = 0;
    const projects = await this.deps.pool.query<{ project: string }>(
      `SELECT project FROM input_uploads WHERE state = 'ready' GROUP BY project HAVING count(*) > $1`,
      [INPUT_BUNDLE_LIMITS.keptPerProject],
    );
    for (const p of projects.rows) extra += await this.#keepNewest(p.project);
    if ((stale.rowCount ?? 0) + extra > 0) {
      await this.#audit(null, 'input.upload.prune', 'input-uploads', 'success', {
        unused: stale.rowCount ?? 0,
        overLimit: extra,
        expiredReceiving: expired.rowCount ?? 0,
      });
    }
    return (expired.rowCount ?? 0) + (stale.rowCount ?? 0) + extra;
  }
}

/**
 * Records the bundle a new job starts with, inside the job's creation transaction (the jobs store). The bundle must be
 * ready and in the job's project (the caller checked it; a bundle pruned in between is refused here, 404).
 */
export async function attachInputUpload(
  tx: Queryable,
  jobId: string,
  project: string,
  uploadId: string,
  now: Date,
): Promise<{ fileCount: number; totalBytes: number }> {
  const { rows } = await tx.query<{
    label: string | null;
    file_count: number;
    total_bytes: string | number;
    bundle_sha256: string;
  }>(
    `SELECT label, file_count, total_bytes, bundle_sha256 FROM input_uploads
      WHERE id = $1 AND project = $2 AND state = 'ready' FOR SHARE`,
    [uploadId, project],
  );
  const u = rows[0];
  if (u === undefined) throw notFound();
  await tx.query(
    `INSERT INTO job_input_uploads (job_id, upload_id, source_id, label, file_count, total_bytes, bundle_sha256,
                                    attached_at)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7)`,
    [jobId, uploadId, u.label, u.file_count, u.total_bytes, u.bundle_sha256, now],
  );
  await tx.query('UPDATE input_uploads SET last_used_at = $2 WHERE id = $1', [uploadId, now]);
  return { fileCount: u.file_count, totalBytes: Number(u.total_bytes) };
}

/** The bundle an earlier job took (follow-ups reuse it while it is kept). */
export async function inputUploadOfJob(db: Queryable, jobId: string): Promise<string | null> {
  if (!UUID.test(jobId)) return null;
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id::text AS id FROM job_input_uploads x JOIN input_uploads u ON u.id = x.upload_id
      WHERE x.job_id = $1 AND u.state = 'ready'`,
    [jobId],
  );
  return rows[0]?.id ?? null;
}
