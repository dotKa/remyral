import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WorkerToMaster } from '@remyral/protocol';
import { publicKeyFingerprint, verifyRotation } from '@remyral/protocol/auth';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from './fleet.js';
import { notFound } from './fleet.js';
import type { WorkerHub } from './hub.js';
import { WORKER_ID_PATTERN } from './ids.js';
import type { WorkerSession } from './types.js';

/** A rotation request (ROTATE_CREDENTIAL) must be answered within this window. */
export const ROTATION_TTL_MS = 10 * 60_000;

function nonceHash(nonce: string): Buffer {
  return createHash('sha256').update(`remyral-rotation-nonce/v1\n${nonce}`).digest();
}

type RotateKey = Extract<WorkerToMaster, { type: 'ROTATE_KEY' }>;

/**
 * Device key rotation (ADR-0005 §5, p2-identity-rotation).
 *
 * An admin requests it (`POST /workers/:id/rotate`, step-up); the master sends
 * `ROTATE_CREDENTIAL{nonce}` (single use, 10 min; only its hash is stored and a
 * fresh nonce is issued if the worker reconnects meanwhile). The worker answers
 * `ROTATE_KEY` with a new public key and two signatures over the rotation
 * statement (worker id, old key, new key, nonce): the old key vouches for the
 * new one, the new key proves possession. Policy `rotationRequiresApproval`
 * decides whether the new key becomes active at once (old → superseded) or waits
 * as `pending` until `POST /workers/:id/approve-rotation`. Every step is audited.
 */
export class RotationService {
  constructor(
    private readonly deps: {
      pool: Pool;
      audit: AuditRecorder;
      hub: WorkerHub;
      clock: () => Date;
      log: FastifyBaseLogger;
      /** p17-panel-settings: a function is read per rotation (Ayarlar → Güvenlik → Oturumlar ve makine anahtarları). */
      requiresApproval: boolean | (() => boolean);
    },
  ) {}

  get requiresApproval(): boolean {
    const r = this.deps.requiresApproval;
    return typeof r === 'function' ? r() : r;
  }

  async #issue(
    tx: Queryable,
    workerId: string,
    userId: string | null,
  ): Promise<{ nonce: string; deadline: Date }> {
    const nonce = randomBytes(32).toString('base64url');
    const deadline = new Date(this.deps.clock().getTime() + ROTATION_TTL_MS);
    await tx.query(
      `UPDATE workers SET rotation_nonce_hash = $2, rotation_expires_at = $3,
              rotation_requested_by = COALESCE($4, rotation_requested_by), updated_at = $5
        WHERE id = $1`,
      [workerId, nonceHash(nonce), deadline, userId, this.deps.clock()],
    );
    return { nonce, deadline };
  }

  /** Admin request: the worker must be connected (it signs with its current key). */
  async request(id: string, actor: ActorContext): Promise<void> {
    if (!WORKER_ID_PATTERN.test(id)) throw notFound();
    const session = this.deps.hub.get(id)?.session;
    const issued = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ state: string }>(
        'SELECT state FROM workers WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (row === undefined) throw notFound();
      if (row.state === 'pending' || row.state === 'quarantined') {
        throw new HttpError(
          409,
          'not_rotatable',
          'Only an enrolled, non-quarantined worker can rotate its key.',
        );
      }
      if (!session) throw new HttpError(409, 'not_connected', 'The worker must be online to rotate its key.');
      const pending = await tx.query(
        `SELECT 1 FROM worker_credentials WHERE worker_id = $1 AND status = 'pending'`,
        [id],
      );
      if ((pending.rowCount ?? 0) > 0) {
        throw new HttpError(409, 'rotation_pending', 'A rotated key is already waiting for approval.');
      }
      const out = await this.#issue(tx, id, actor.userId);
      await this.#audit(
        tx,
        { type: 'user', id: actor.userId },
        'worker.rotate.request',
        'success',
        id,
        {
          deadline: out.deadline.toISOString(),
          requiresApproval: this.requiresApproval,
        },
        actor,
      );
      return out;
    });
    await session?.send('ROTATE_CREDENTIAL', {
      deadline: issued.deadline.toISOString(),
      reason: 'requested by an administrator',
      nonce: issued.nonce,
    });
  }

  /** An outstanding request survives reconnects: re-issue a fresh nonce to the new session. */
  async onSessionStart(session: WorkerSession): Promise<void> {
    const now = this.deps.clock();
    const issued = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ pending: boolean }>(
        `SELECT rotation_expires_at > $2 AS pending FROM workers WHERE id = $1 FOR UPDATE`,
        [session.workerId, now],
      );
      if (rows[0]?.pending !== true) return null;
      return this.#issue(tx, session.workerId, null);
    });
    if (issued !== null) {
      await session.send('ROTATE_CREDENTIAL', {
        deadline: issued.deadline.toISOString(),
        reason: 'requested by an administrator',
        nonce: issued.nonce,
      });
    }
  }

  async onRotateKey(session: WorkerSession, message: RotateKey): Promise<void> {
    const p = message.payload;
    const now = this.deps.clock();
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const refuse = async (reason: string) => {
        // Single use: a failed attempt consumes the request too.
        await tx.query(
          'UPDATE workers SET rotation_nonce_hash = NULL, rotation_expires_at = NULL WHERE id = $1',
          [session.workerId],
        );
        await this.#audit(
          tx,
          { type: 'worker', id: session.workerId },
          'worker.rotate',
          'denied',
          session.workerId,
          {
            reason,
          },
        );
        return { ok: false as const, reason };
      };
      const { rows } = await tx.query<{
        nonce_hash: Buffer | null;
        expires_at: Date | null;
        state: string;
        credential_id: string | null;
        fingerprint: string | null;
      }>(
        `SELECT w.rotation_nonce_hash AS nonce_hash, w.rotation_expires_at AS expires_at, w.state,
                c.id::text AS credential_id, c.fingerprint
           FROM workers w
           LEFT JOIN worker_credentials c ON c.worker_id = w.id AND c.public_key = $2 AND c.status = 'active'
          WHERE w.id = $1 FOR UPDATE OF w`,
        [session.workerId, session.publicKey],
      );
      const row = rows[0];
      if (row === undefined || row.state === 'quarantined') return refuse('worker_not_active');
      if (row.credential_id === null) return refuse('session_key_not_active');
      if (row.nonce_hash === null || row.expires_at === null || row.expires_at <= now) {
        return refuse('no_outstanding_request');
      }
      const presented = nonceHash(p.nonce);
      if (!timingSafeEqual(presented, row.nonce_hash)) return refuse('nonce_mismatch');
      const statement = {
        workerId: session.workerId,
        oldPublicKey: session.publicKey,
        newPublicKey: p.newPublicKey,
        nonce: p.nonce,
      };
      if (!verifyRotation(statement, p.oldKeySignature, p.newKeySignature)) return refuse('bad_signature');
      const used = await tx.query('SELECT 1 FROM worker_credentials WHERE public_key = $1', [p.newPublicKey]);
      if ((used.rowCount ?? 0) > 0) return refuse('key_already_used');

      const fingerprint = publicKeyFingerprint(p.newPublicKey);
      const status = this.requiresApproval ? 'pending' : 'active';
      if (status === 'active') {
        await tx.query(`UPDATE worker_credentials SET status = 'superseded', retired_at = $2 WHERE id = $1`, [
          row.credential_id,
          now,
        ]);
      }
      await tx.query(
        `INSERT INTO worker_credentials (worker_id, public_key, fingerprint, status, created_at, activated_at,
                                         rotated_from, rotation_signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.workerId,
          p.newPublicKey,
          fingerprint,
          status,
          now,
          status === 'active' ? now : null,
          row.credential_id,
          p.oldKeySignature,
        ],
      );
      // The nonce is single use, whatever the outcome above.
      await tx.query(
        'UPDATE workers SET rotation_nonce_hash = NULL, rotation_expires_at = NULL, updated_at = $2 WHERE id = $1',
        [session.workerId, now],
      );
      await this.#audit(
        tx,
        { type: 'worker', id: session.workerId },
        'worker.rotate',
        'success',
        session.workerId,
        {
          oldFingerprint: row.fingerprint,
          newFingerprint: fingerprint,
          status,
        },
      );
      return { ok: true as const, fingerprint, status };
    });
    if (!result.ok) {
      this.deps.log.warn({ workerId: session.workerId, reason: result.reason }, 'key rotation refused');
      await session.send('ERROR', { code: 'rotation_refused', message: result.reason, retryable: false });
      return;
    }
    await session.send('CREDENTIAL_ROTATED', {
      fingerprint: result.fingerprint,
      status: result.status === 'active' ? 'active' : 'pending_approval',
    });
  }

  /** Approve a rotated key that waits (policy `rotationRequiresApproval`). */
  async approve(id: string, actor: ActorContext): Promise<void> {
    if (!WORKER_ID_PATTERN.test(id)) throw notFound();
    const now = this.deps.clock();
    const fingerprint = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ state: string }>(
        'SELECT state FROM workers WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (rows[0] === undefined) throw notFound();
      if (rows[0].state === 'quarantined')
        throw new HttpError(409, 'quarantined', 'This worker is quarantined.');
      const pending = await tx.query<{ id: string; fingerprint: string; rotated_from: string }>(
        `SELECT id::text AS id, fingerprint, rotated_from::text AS rotated_from FROM worker_credentials
          WHERE worker_id = $1 AND status = 'pending' AND rotated_from IS NOT NULL`,
        [id],
      );
      const cred = pending.rows[0];
      if (cred === undefined)
        throw new HttpError(409, 'no_rotation_pending', 'No rotated key is waiting for approval.');
      await tx.query(
        `UPDATE worker_credentials SET status = 'superseded', retired_at = $2 WHERE worker_id = $1 AND status = 'active'`,
        [id, now],
      );
      await tx.query(`UPDATE worker_credentials SET status = 'active', activated_at = $2 WHERE id = $1`, [
        cred.id,
        now,
      ]);
      await this.#audit(
        tx,
        { type: 'user', id: actor.userId },
        'worker.rotate.approve',
        'success',
        id,
        {
          fingerprint: cred.fingerprint,
        },
        actor,
      );
      return cred.fingerprint;
    });
    // A live session (still on the old key) switches now; an offline worker switches on its next connect.
    await this.deps.hub
      .get(id)
      ?.session?.send('CREDENTIAL_ROTATED', { fingerprint, status: 'active' })
      .catch(() => undefined);
  }

  async #audit(
    tx: Queryable,
    actor: { type: 'user' | 'worker'; id: string },
    action: string,
    outcome: 'success' | 'denied',
    workerId: string,
    metadata: Record<string, unknown>,
    ctx?: ActorContext,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor,
        action,
        outcome,
        target: workerId,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        metadata,
      },
      tx,
    );
  }
}
