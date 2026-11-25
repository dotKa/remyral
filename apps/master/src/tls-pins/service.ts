import { randomUUID } from 'node:crypto';
import { type AssignedTlsPin, CertSha256, MAX_TLS_PINS } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p22-runtime-diagnostics (docs/design/p22-runtime-diagnostics.md): certificates a project trusts although they fail
 * verification — the self-signed certificate of an internal service its workflow HTTP nodes / watch checks call.
 *
 * Opt-in, narrow and audited: verification stays strict everywhere by default; a pin is created only from a failed
 * function job of the project whose worker reported `http_error` with `params.cause = "tls_untrusted"` and the
 * fingerprint of the certificate it saw ("Trust this certificate" — one click, nothing typed), bound to that exact
 * `host:port`. Creating and removing pins needs `projects.egress.write` (project admin; the security policy's step-up
 * of the project policy event) and is audited `project.tls_pin.add` / `project.tls_pin.remove`. The pins travel as
 * ASSIGN_JOB `execution.tlsPins` with every function job of the project (only to `function-tls-pins-v1` workers).
 */

export interface TlsPinView {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly sha256: string;
  readonly sourceJob: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

/** What a failed attempt reported about the certificate it refused (from JOB_RESULT `error.params`). */
export interface UntrustedCertificate {
  readonly host: string;
  readonly port: number;
  readonly sha256: string;
  readonly tlsCode: string | null;
}

const HOST = /^[a-z0-9.:-]{1,253}$/;

/** The refused certificate of a JOB_RESULT error, or null when the error is not a `tls_untrusted` report. Pure. */
export function untrustedCertificateOf(code: string | null, params: unknown): UntrustedCertificate | null {
  if (code !== 'http_error' || typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  if (p.cause !== 'tls_untrusted') return null;
  const host = typeof p.host === 'string' ? p.host : '';
  const port = typeof p.port === 'number' ? p.port : NaN;
  const sha256 = typeof p.certSha256 === 'string' ? p.certSha256 : '';
  if (!HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!CertSha256.safeParse(sha256).success) return null;
  return { host, port, sha256, tlsCode: typeof p.tlsCode === 'string' ? p.tlsCode.slice(0, 64) : null };
}

/** The pins a function job of `project` carries (newest first, at most MAX_TLS_PINS). */
export async function loadTlsPins(db: Queryable, project: string): Promise<AssignedTlsPin[]> {
  const { rows } = await db.query<{ host: string; port: number; sha256: string }>(
    `SELECT host, port, sha256 FROM project_tls_pins WHERE project = $1 ORDER BY created_at DESC, id LIMIT $2`,
    [project, MAX_TLS_PINS],
  );
  return rows.map((r) => ({ host: r.host, port: r.port, sha256: r.sha256 }));
}

export class TlsPinService {
  constructor(
    private readonly deps: {
      readonly pool: Parameters<typeof withTransaction>[0];
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  async list(project: string, db: Queryable = this.deps.pool): Promise<TlsPinView[]> {
    await this.#assertProject(db, project);
    const { rows } = await db.query<{
      id: string;
      host: string;
      port: number;
      sha256: string;
      source_job: string | null;
      created_at: Date;
      username: string | null;
    }>(
      `SELECT p.id, p.host, p.port, p.sha256, p.source_job, p.created_at, u.username
         FROM project_tls_pins p LEFT JOIN users u ON u.id = p.created_by
        WHERE p.project = $1 ORDER BY p.created_at DESC, p.id`,
      [project],
    );
    return rows.map((r) => ({
      id: r.id,
      host: r.host,
      port: r.port,
      sha256: r.sha256,
      sourceJob: r.source_job,
      createdAt: r.created_at.toISOString(),
      createdBy: r.username,
    }));
  }

  /**
   * "Trust this certificate": pins the certificate the latest failed attempt of `jobId` (a job of `project`) reported
   * as untrusted. Idempotent (the same pin again changes nothing and is not audited twice).
   */
  async trustFromJob(
    actor: { readonly userId: string },
    project: string,
    jobId: string,
  ): Promise<TlsPinView[]> {
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#assertProject(tx, project);
      const { rows } = await tx.query<{ code: string | null; params: unknown }>(
        `SELECT r.result->'error'->>'code' AS code, r.result->'error'->'params' AS params
           FROM job_runs r JOIN jobs j ON j.id = r.job_id
          WHERE j.id::text = $1 AND j.project = $2 AND r.result IS NOT NULL
          ORDER BY r.created_at DESC, r.attempt_id DESC LIMIT 1`,
        [jobId, project],
      );
      const row = rows[0];
      if (row === undefined) throw new HttpError(404, 'job_not_found', 'Job not found.');
      const cert = untrustedCertificateOf(row.code, row.params);
      if (cert === null)
        throw new HttpError(
          409,
          'no_untrusted_certificate',
          'The latest attempt of this job did not report an untrusted certificate with its fingerprint.',
        );
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM project_tls_pins WHERE project = $1',
        [project],
      );
      if ((count.rows[0]?.n ?? 0) >= MAX_TLS_PINS)
        throw new HttpError(
          409,
          'too_many_tls_pins',
          `A project trusts at most ${String(MAX_TLS_PINS)} certificates.`,
        );
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO project_tls_pins (id, project, host, port, sha256, source_job, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (project, host, port, sha256) DO NOTHING RETURNING id`,
        [randomUUID(), project, cert.host, cert.port, cert.sha256, jobId, actor.userId, this.deps.clock()],
      );
      // Already trusted: nothing changes, nothing to audit.
      if (inserted.rows.length === 0) return;
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.tls_pin.add',
          target: `project:${project}`,
          outcome: 'success',
          metadata: {
            project,
            host: cert.host,
            port: cert.port,
            sha256: cert.sha256,
            tlsCode: cert.tlsCode,
            sourceJob: jobId,
          },
        },
        tx,
      );
    });
    return this.list(project);
  }

  async remove(actor: { readonly userId: string }, project: string, id: string): Promise<TlsPinView[]> {
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#assertProject(tx, project);
      const { rows } = await tx.query<{ host: string; port: number; sha256: string }>(
        'DELETE FROM project_tls_pins WHERE project = $1 AND id::text = $2 RETURNING host, port, sha256',
        [project, id],
      );
      const r = rows[0];
      if (r === undefined) throw new HttpError(404, 'tls_pin_not_found', 'No such trusted certificate.');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.tls_pin.remove',
          target: `project:${project}`,
          outcome: 'success',
          metadata: { project, host: r.host, port: r.port, sha256: r.sha256 },
        },
        tx,
      );
    });
    return this.list(project);
  }

  async #assertProject(db: Queryable, project: string): Promise<void> {
    const { rows } = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if (rows.length === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
  }
}
