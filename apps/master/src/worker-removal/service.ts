import { randomUUID } from 'node:crypto';
import { type HelperManageAction, manualUninstallCommands, WORKER_MANAGED_FEATURE } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { OpView, RemoteOpsService } from '../remote-ops/service.js';
import type { ActorContext, FleetService } from '../workers/fleet.js';
import { WORKER_ID_PATTERN } from '../workers/ids.js';

/**
 * p17-worker-managed Parts 3 and 4 (docs/design/p17-worker-managed.md §3, §4): removing a worker from the panel, and
 * installing / removing its machine-admin helper.
 *
 * Removal: an admin with an always-fresh step-up (the machine-admin approval rule: privileged work on the machine)
 * asks for it; the request is stored and audited, the worker is drained (no new jobs) and — now if it is connected,
 * else when it next connects — gets the signed `worker.uninstall` OPS_COMMAND. The worker hands it to its privileged
 * helper; once the helper accepted it (the machine goes away about 15 s later) the master revokes the worker (every
 * credential, the socket closed) as the requesting admin. A refusal or failure (no / an older helper, a local veto,
 * timeout) keeps the worker: the panel shows why, the kit's manual uninstall command, and "Revoke now". A request
 * that was not sent yet can be cancelled.
 */

export interface RemovalRecord {
  readonly id: string;
  readonly purge: boolean;
  readonly state: 'requested' | 'sent' | 'done' | 'refused' | 'failed' | 'cancelled';
  readonly opId: string | null;
  /** The remote operation's state (`sent`, `running`, `lost` …) while the removal is in flight. */
  readonly opState: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface RemovalView {
  readonly workerId: string;
  readonly os: string | null;
  /** The worker can be removed from the panel (`worker-managed-v1`). */
  readonly supported: boolean;
  readonly connected: boolean;
  readonly revoked: boolean;
  readonly removal: RemovalRecord | null;
  /** The kit's uninstall for this machine's OS (by hand: no helper, an older build, offline for good). */
  readonly manual: string[];
}

interface Row {
  id: string;
  purge: boolean;
  state: RemovalRecord['state'];
  op_id: string | null;
  op_state: string | null;
  reason: string | null;
  detail: string | null;
  requested_by: string | null;
  requested_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

function record(r: Row): RemovalRecord {
  return {
    id: r.id,
    purge: r.purge,
    state: r.state,
    opId: r.op_id,
    opState: r.op_state,
    reason: r.reason,
    detail: r.detail,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

const notFound = (): HttpError =>
  new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });

export class WorkerRemovalService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly remoteOps: () => RemoteOpsService | null;
      readonly fleet: () => FleetService | null;
      readonly connected: (workerId: string) => boolean;
    },
  ) {}

  async #worker(workerId: string): Promise<{
    state: string;
    os: string | null;
    features: unknown;
    archived_at: Date | null;
    quarantine_reason: string | null;
  }> {
    if (!WORKER_ID_PATTERN.test(workerId)) throw notFound();
    const { rows } = await this.deps.pool.query<{
      state: string;
      os: string | null;
      features: unknown;
      archived_at: Date | null;
      quarantine_reason: string | null;
    }>(
      "SELECT state, facts->>'os' AS os, features, archived_at, quarantine_reason FROM workers WHERE id = $1",
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw notFound();
    return w;
  }

  async #latest(workerId: string): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT r.id, r.purge, r.state, r.op_id, o.state AS op_state, r.reason, r.detail, r.requested_by::text AS requested_by,
              r.requested_at, r.updated_at, r.finished_at
         FROM worker_removals r LEFT JOIN worker_ops o ON o.id = r.op_id
        WHERE r.worker_id = $1 ORDER BY r.requested_at DESC LIMIT 1`,
      [workerId],
    );
    return rows[0] ?? null;
  }

  async view(workerId: string): Promise<RemovalView> {
    const w = await this.#worker(workerId);
    const latest = await this.#latest(workerId);
    return {
      workerId,
      os: w.os,
      supported: features(w.features).includes(WORKER_MANAGED_FEATURE),
      connected: this.deps.connected(workerId),
      revoked: w.quarantine_reason === 'revoked',
      removal: latest === null ? null : record(latest),
      manual: manualUninstallCommands(w.os, latest?.purge ?? false),
    };
  }

  /** Stores the removal, drains the worker and sends the signed uninstall now if it is connected. */
  async request(workerId: string, input: { purge: boolean }, actor: ActorContext): Promise<RemovalView> {
    const w = await this.#worker(workerId);
    const refuse = async (status: number, code: string, message: string, reason?: string): Promise<never> => {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'worker.remove.request',
        target: workerId,
        outcome: 'denied',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reason: code },
      });
      throw new HttpError(status, code, message, {}, {}, reason === undefined ? {} : { reason });
    };
    if (w.state === 'pending') {
      return refuse(409, 'pending', 'Deny a pending enrollment instead of removing it.');
    }
    if (w.quarantine_reason === 'revoked' || w.archived_at !== null) {
      return refuse(409, 'already_revoked', 'This worker is already revoked.');
    }
    if (!features(w.features).includes(WORKER_MANAGED_FEATURE)) {
      return refuse(
        409,
        'worker_update_required',
        'This worker build cannot be removed or have its helper managed from the panel; update it first (worker-managed-v1).',
        'worker_managed',
      );
    }
    const now = this.deps.clock();
    const id = randomUUID();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('remyral-worker-removal:' || $1))", [workerId]);
      const open = await tx.query(
        "SELECT 1 FROM worker_removals WHERE worker_id = $1 AND state IN ('requested', 'sent')",
        [workerId],
      );
      if ((open.rowCount ?? 0) > 0) {
        throw new HttpError(409, 'removal_in_progress', 'A removal of this worker is already in progress.');
      }
      await tx.query(
        `INSERT INTO worker_removals (id, worker_id, purge, state, requested_by, requested_at, updated_at)
         VALUES ($1, $2, $3, 'requested', $4, $5, $5)`,
        [id, workerId, input.purge, actor.userId === '' ? null : actor.userId, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'worker.remove.request',
          target: workerId,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { removalId: id, purge: input.purge },
        },
        tx,
      );
    });
    this.deps.log.warn({ workerId, purge: input.purge }, 'worker removal requested');
    // No new jobs while it goes away (an already drained / quarantined worker stays as it is).
    await this.deps
      .fleet()
      ?.drain(workerId, 'removal requested from the panel', actor)
      .catch((err: unknown) => {
        this.deps.log.info({ err, workerId }, 'removal: worker not drained');
      });
    if (this.deps.connected(workerId)) await this.#send(workerId, id, input.purge, actor);
    return this.view(workerId);
  }

  /** p17-worker-managed: a worker with a removal that waited for it connected — send the signed uninstall now. */
  async onWorkerConnected(workerId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: string; purge: boolean; requested_by: string | null }>(
      `SELECT id, purge, requested_by::text AS requested_by FROM worker_removals
        WHERE worker_id = $1 AND state = 'requested' ORDER BY requested_at DESC LIMIT 1`,
      [workerId],
    );
    const r = rows[0];
    if (r === undefined) return;
    await this.#send(workerId, r.id, r.purge, {
      userId: r.requested_by ?? '',
      ip: '',
      userAgent: 'worker-removal',
      ...(r.requested_by === null ? { system: 'worker-removal' } : {}),
    });
  }

  async #send(workerId: string, removalId: string, purge: boolean, actor: ActorContext): Promise<void> {
    const ops = this.deps.remoteOps();
    if (ops === null) return;
    let op: OpView;
    try {
      op = await ops.request(workerId, { kind: 'worker.uninstall', purge }, actor);
    } catch (err) {
      // Offline meanwhile: the request waits for the next connection; anything else ends it.
      if (err instanceof HttpError && err.code === 'worker_offline') return;
      const code = err instanceof HttpError ? err.code : 'send_failed';
      await this.#finish(removalId, 'failed', code, err instanceof Error ? err.message : String(err));
      return;
    }
    const now = this.deps.clock();
    if (op.state === 'failed') {
      await this.#finish(
        removalId,
        'failed',
        op.reason ?? 'send_failed',
        op.detail ?? 'the worker disconnected',
      );
      return;
    }
    await this.deps.pool.query(
      "UPDATE worker_removals SET state = 'sent', op_id = $2, updated_at = $3 WHERE id = $1 AND state = 'requested'",
      [removalId, op.id, now],
    );
  }

  async #finish(
    removalId: string,
    state: 'done' | 'refused' | 'failed' | 'cancelled',
    reason: string | null,
    detail: string | null,
  ): Promise<void> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE worker_removals SET state = $2, reason = $3, detail = $4, updated_at = $5, finished_at = $5
        WHERE id = $1 AND state IN ('requested', 'sent')`,
      [
        removalId,
        state,
        reason === null ? null : /^[a-z0-9_]{1,64}$/.test(reason) ? reason : 'failed',
        detail?.slice(0, 500) ?? null,
        now,
      ],
    );
  }

  /**
   * The outcome of a `worker.uninstall` (RemoteOpsService.onManageFinished): accepted by the helper → revoke the worker
   * as the requesting admin; refused / failed / cancelled → the removal ends with the reason (the worker stays).
   */
  async onManageFinished(input: {
    readonly workerId: string;
    readonly opId: string;
    readonly kind: 'worker.uninstall' | 'helper.manage';
    readonly state: string;
    readonly reason: string | null;
    readonly detail: string | null;
  }): Promise<void> {
    if (input.kind !== 'worker.uninstall') return;
    const { rows } = await this.deps.pool.query<{ id: string; requested_by: string | null; purge: boolean }>(
      `SELECT id, requested_by::text AS requested_by, purge FROM worker_removals
        WHERE worker_id = $1 AND op_id = $2 AND state = 'sent'`,
      [input.workerId, input.opId],
    );
    const r = rows[0];
    if (r === undefined) return;
    if (input.state !== 'succeeded') {
      await this.#finish(
        r.id,
        input.state === 'refused' ? 'refused' : input.state === 'cancelled' ? 'cancelled' : 'failed',
        input.reason ?? input.state,
        input.detail,
      );
      await this.deps.audit.record({
        actor: { type: 'worker', id: input.workerId },
        action: 'worker.remove.result',
        target: input.workerId,
        outcome: 'failure',
        metadata: { removalId: r.id, state: input.state, reason: input.reason },
      });
      return;
    }
    await this.#finish(r.id, 'done', null, input.detail);
    await this.deps.audit.record({
      actor: { type: 'worker', id: input.workerId },
      action: 'worker.remove.result',
      target: input.workerId,
      outcome: 'success',
      metadata: { removalId: r.id, purge: r.purge },
    });
    this.deps.log.warn(
      { workerId: input.workerId },
      'worker removal accepted by its helper; revoking the worker',
    );
    if (r.requested_by === null) {
      this.deps.log.error(
        { workerId: input.workerId },
        'worker removal: the requesting user is gone; revoke by hand',
      );
      return;
    }
    await this.deps
      .fleet()
      ?.revoke(input.workerId, 'removed from the panel', {
        userId: r.requested_by,
        ip: '',
        userAgent: 'worker-removal',
      })
      .catch((err: unknown) => {
        if (err instanceof HttpError && err.code === 'already_revoked') return;
        this.deps.log.error({ err, workerId: input.workerId }, 'worker removal: revoke failed');
      });
  }

  /** Cancels a removal that was not sent yet (the worker stays drained; resume it from Access). */
  async cancel(workerId: string, actor: ActorContext): Promise<RemovalView> {
    await this.#worker(workerId);
    const now = this.deps.clock();
    const { rowCount } = await this.deps.pool.query(
      `UPDATE worker_removals SET state = 'cancelled', updated_at = $2, finished_at = $2
        WHERE worker_id = $1 AND state = 'requested'`,
      [workerId, now],
    );
    if ((rowCount ?? 0) === 0) {
      throw new HttpError(
        409,
        'removal_not_cancellable',
        'Only a removal that has not reached the machine yet can be cancelled.',
      );
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'worker.remove.cancel',
      target: workerId,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {},
    });
    return this.view(workerId);
  }

  /** Part 4: install or remove the machine-admin helper's trigger through the privileged helper (connected only). */
  async manageHelper(workerId: string, action: HelperManageAction, actor: ActorContext): Promise<OpView> {
    const ops = this.deps.remoteOps();
    if (ops === null)
      throw new HttpError(
        503,
        'unavailable',
        'Remote operations are not available.',
        {},
        {},
        { reason: 'remote_ops' },
      );
    return ops.request(workerId, { kind: 'helper.manage', action }, actor);
  }
}
