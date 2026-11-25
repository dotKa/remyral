import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuditRecorder } from '../audit/audit.js';
import { type HostSigner, isoSeconds, newNonce } from '../console-domain/host-files.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { compareVersions, type FeedRelease } from '../updates/feed.js';
import {
  type ApplierInfo,
  cleanLog,
  type HostActionKind,
  HOST_ACTION_KINDS,
  pendingHostRequestId,
  readApplierInfo,
  readHostResult,
  removeHostRequest,
  writeHostRequest,
} from './files.js';

/**
 * p17-host-actions (docs/design/p17-host-actions.md, ADR-0063 amendment 2026-10-26): requests the owner makes in the
 * console that a remyral-ctl host carries out — never the master: the master writes a signed request into the shared
 * directory, the root-owned applier verifies and runs it through its own code paths and reports back.
 *
 * - **No applier** (Coolify / EC2 like the vendor's own installation, or a host without a fresh heartbeat): every
 *   request is refused with `host_applier_unavailable`; the console shows what the operator does instead.
 * - **One open request at a time** (of any kind; a unique index), expiring after 15 minutes when nobody picks it up.
 * - Every request and every outcome is audited (`host.<kind>.request`, `host.<kind>.<state>`, `host.request.cancel`).
 */

export type HostActionState =
  | 'pending'
  | 'applying'
  | 'applied'
  /** p17-panel-settings Part 0: accepted; (a part of) it waits for the host time lock (72 h, the host's clock). */
  | 'scheduled'
  | 'rolled_back'
  | 'held'
  | 'failed'
  | 'refused'
  | 'expired'
  | 'cancelled';

const OPEN: readonly HostActionState[] = ['pending', 'applying'];

export type HostActionCode =
  | 'host_applier_unavailable'
  | 'host_applier_outdated'
  | 'host_request_in_progress'
  | 'host_request_not_found'
  | 'no_pending_host_request'
  | 'invalid_release_version'
  | 'release_not_in_feed'
  | 'breaking_not_accepted'
  | 'release_not_on_host'
  | 'invalid_backup_id'
  | 'restore_confirmation_required';

export class HostActionError extends Error {
  constructor(
    readonly code: HostActionCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostActionError';
  }
}

export interface HostActionActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface HostActionView {
  readonly id: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, string | boolean | number | null>>;
  readonly state: HostActionState;
  readonly step: string | null;
  readonly detail: string | null;
  readonly log: readonly string[];
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface ApplierView {
  /** A fresh heartbeat and a signing key: requests can be made. */
  readonly managed: boolean;
  readonly lastSeen: string | null;
  readonly version: string | null;
  readonly kinds: readonly string[];
  readonly current: string | null;
  readonly previous: string | null;
  readonly releases: readonly string[];
}

export interface HostActionsStatus {
  readonly applier: ApplierView;
  readonly open: HostActionView | null;
  readonly recent: readonly HostActionView[];
}

interface Row {
  id: string;
  kind: string;
  params: Record<string, string | boolean | number | null>;
  state: HostActionState;
  step: string | null;
  detail: string | null;
  log: string[];
  requested_at: Date;
  expires_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const COLUMNS =
  'id, kind, params, state, step, detail, log, requested_at, expires_at, updated_at, finished_at';

function view(r: Row): HostActionView {
  return {
    id: r.id,
    kind: r.kind,
    params: { ...r.params },
    state: r.state,
    step: r.step,
    detail: r.detail,
    log: [...r.log],
    requestedAt: r.requested_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** How long an `applying` request may stay without a final result before it is failed. */
const APPLYING_TIMEOUT_MS: Readonly<Record<string, number>> = {
  upgrade: 3 * 60 * 60_000,
  rollback: 3 * 60 * 60_000,
  'backup-run': 6 * 60 * 60_000,
  'backup-drill': 6 * 60 * 60_000,
  'backup-restore': 3 * 60 * 60_000,
  'backup-config': 30 * 60_000,
  'backup-offsite': 15 * 60_000,
  'backup-change-cancel': 15 * 60_000,
};

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const BACKUP_ID = /^remana-[a-z]+-\d{8}T\d{6}Z$/;

export interface HostActionDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** HOST_APPLIER_DIR (`requests/` writable, `status/` read-only); null: not a remyral-ctl layout. */
  readonly hostDir: string | null;
  readonly signer: HostSigner | null;
  /** The verified update feed (versions the owner may upgrade to). */
  readonly feedRelease: (version: string) => FeedRelease | null;
  readonly heartbeatMaxAgeMs?: number;
  readonly requestTtlMs?: number;
  readonly applyingTimeoutMs?: number;
  readonly log?: { warn(obj: unknown, msg: string): void };
}

export class HostActionService {
  #reconciling: Promise<void> | null = null;

  constructor(private readonly deps: HostActionDeps) {}

  private now(): Date {
    return this.deps.clock();
  }

  private get requestsDir(): string | null {
    return this.deps.hostDir === null ? null : join(this.deps.hostDir, 'requests');
  }

  private get statusDir(): string | null {
    return this.deps.hostDir === null ? null : join(this.deps.hostDir, 'status');
  }

  async applierInfo(): Promise<{ info: ApplierInfo | null; fresh: boolean }> {
    const dir = this.statusDir;
    if (dir === null) return { info: null, fresh: false };
    const info = await readApplierInfo(dir);
    if (info === null) return { info: null, fresh: false };
    const age = this.now().getTime() - info.at.getTime();
    return { info, fresh: age <= (this.deps.heartbeatMaxAgeMs ?? 5 * 60_000) && age > -5 * 60_000 };
  }

  async applier(): Promise<ApplierView> {
    const { info, fresh } = await this.applierInfo();
    return {
      managed: fresh && this.deps.signer !== null && this.requestsDir !== null,
      lastSeen: info?.at.toISOString() ?? null,
      version: info?.version ?? null,
      kinds: [...(info?.kinds ?? [])],
      current: info?.current ?? null,
      previous: info?.previous ?? null,
      releases: [...(info?.releases ?? [])],
    };
  }

  private async openRow(db: Queryable = this.deps.pool): Promise<Row | null> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM host_action_requests WHERE state = ANY($1::text[])`,
      [OPEN],
    );
    return rows[0] ?? null;
  }

  async status(kinds: readonly string[] = HOST_ACTION_KINDS): Promise<HostActionsStatus> {
    await this.reconcile();
    const open = await this.openRow();
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLUMNS} FROM host_action_requests WHERE kind = ANY($1::text[])
        ORDER BY requested_at DESC LIMIT 10`,
      [kinds],
    );
    return { applier: await this.applier(), open: open === null ? null : view(open), recent: rows.map(view) };
  }

  async get(id: string): Promise<HostActionView> {
    await this.reconcile();
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLUMNS} FROM host_action_requests WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HostActionError('host_request_not_found', 'No such request.');
    const v = view(r);
    // While it runs, the host's live step and output tail (the row keeps the last copy once it finished).
    if (
      OPEN.includes(r.state) &&
      this.statusDir !== null &&
      (HOST_ACTION_KINDS as readonly string[]).includes(r.kind)
    ) {
      const res = await readHostResult(this.statusDir, r.kind as HostActionKind);
      if (res !== null && res.id === r.id) return { ...v, step: res.step || v.step, log: res.log };
    }
    return v;
  }

  private auditActor(actor: HostActionActor) {
    return {
      actor: { type: 'user' as const, id: actor.userId },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    };
  }

  /**
   * Writes a signed request for the host. `fields`: what the host reads (may include a secret, part 3); `params`: what
   * the console and the audit trail keep (never a secret).
   */
  async submit(
    actor: HostActionActor,
    kind: HostActionKind,
    fields: Readonly<Record<string, string>>,
    params: Readonly<Record<string, string | boolean | number | null>>,
  ): Promise<HostActionView> {
    // An open request that finished or expired since the last tick no longer blocks this one.
    await this.reconcile();
    const { info, fresh } = await this.applierInfo();
    const requestsDir = this.requestsDir;
    const signer = this.deps.signer;
    if (!fresh || info === null || signer === null || requestsDir === null) {
      throw new HostActionError(
        'host_applier_unavailable',
        'This installation has no host applier (remyral-ctl): the operator runs this on the host.',
      );
    }
    if (!info.kinds.includes(kind)) {
      throw new HostActionError(
        'host_applier_outdated',
        'The host applier is older than this request: upgrade once by hand on the host (`sudo remyral-ctl upgrade`); its remyral-ctl brings these requests.',
      );
    }
    const now = this.now();
    const id = randomUUID();
    const nonce = newNonce();
    const expiresAt = new Date(now.getTime() + (this.deps.requestTtlMs ?? 15 * 60_000));
    const row = await withTransaction(this.deps.pool, async (tx) => {
      if ((await this.openRow(tx)) !== null) {
        throw new HostActionError(
          'host_request_in_progress',
          'Another request is waiting for the host or running; wait for it to finish.',
        );
      }
      const { rows } = await tx.query<Row>(
        `INSERT INTO host_action_requests (id, kind, params, nonce, state, requested_by, requested_at, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $6)
         RETURNING ${COLUMNS}`,
        [id, kind, JSON.stringify(params), nonce, actor.userId, now, expiresAt],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('host request was not stored');
      await this.deps.audit.record(
        {
          ...this.auditActor(actor),
          action: `host.${kind}.request`,
          target: id,
          outcome: 'success',
          metadata: { ...params },
        },
        tx,
      );
      try {
        await writeHostRequest(
          requestsDir,
          kind,
          { id, nonce, createdAt: isoSeconds(now), expiresAt: isoSeconds(expiresAt) },
          fields,
          signer,
        );
      } catch (err) {
        this.deps.log?.warn({ err, kind }, 'writing the host request failed');
        throw new HostActionError(
          'host_applier_unavailable',
          'The request could not be written for the host (is the host directory mounted writable?).',
        );
      }
      return r;
    }).catch((err: unknown) => {
      if ((err as { code?: string }).code === '23505') {
        throw new HostActionError(
          'host_request_in_progress',
          'Another request is waiting for the host or running; wait for it to finish.',
        );
      }
      throw err;
    });
    return view(row);
  }

  /** "Şimdi güncelle": to a newer release of the verified feed (default: the newest). */
  async upgrade(
    actor: HostActionActor,
    input: { readonly version: string; readonly acceptBreaking: boolean },
  ): Promise<HostActionView> {
    if (!VERSION.test(input.version))
      throw new HostActionError('invalid_release_version', 'Not a release version.');
    const { info } = await this.applierInfo();
    const current = info?.current ?? null;
    const release = this.deps.feedRelease(input.version);
    if (release === null || (current !== null && compareVersions(input.version, current) <= 0)) {
      throw new HostActionError(
        'release_not_in_feed',
        'This version is not a newer release of the verified update feed.',
      );
    }
    if (release.breaking.length > 0 && !input.acceptBreaking) {
      throw new HostActionError(
        'breaking_not_accepted',
        'This release has breaking changes: confirm them to upgrade.',
      );
    }
    return this.submit(
      actor,
      'upgrade',
      {
        version: input.version,
        fromVersion: current ?? '',
        acceptBreaking: input.acceptBreaking ? 'yes' : 'no',
      },
      { version: input.version, fromVersion: current, acceptBreaking: input.acceptBreaking },
    );
  }

  /**
   * "Geri al": to a release still on the host; with a backup id the database is restored first — destructive, so the
   * owner types the backup id as the second confirmation.
   */
  async rollback(
    actor: HostActionActor,
    input: {
      readonly version: string;
      readonly backupId?: string | null;
      readonly restoreDatabase?: boolean;
      readonly confirm?: string;
    },
  ): Promise<HostActionView> {
    if (!VERSION.test(input.version))
      throw new HostActionError('invalid_release_version', 'Not a release version.');
    const { info } = await this.applierInfo();
    const current = info?.current ?? null;
    if (info !== null && (!info.releases.includes(input.version) || input.version === current)) {
      throw new HostActionError(
        'release_not_on_host',
        'This release is not a previous release kept on the host.',
      );
    }
    const backupId = input.backupId ?? null;
    const restore = input.restoreDatabase === true;
    if (backupId !== null && !BACKUP_ID.test(backupId)) {
      throw new HostActionError('invalid_backup_id', 'Not a backup id.');
    }
    if (restore !== (backupId !== null) || (restore && input.confirm !== backupId)) {
      throw new HostActionError(
        'restore_confirmation_required',
        'Restoring the database needs the backup and its id typed again as confirmation.',
      );
    }
    return this.submit(
      actor,
      'rollback',
      {
        version: input.version,
        fromVersion: current ?? '',
        backupId: backupId ?? '',
        restoreDatabase: restore ? 'yes' : 'no',
      },
      { version: input.version, fromVersion: current, backupId, restoreDatabase: restore },
    );
  }

  /** Withdraws a request the host has not picked up yet. */
  async cancel(actor: HostActionActor, id: string): Promise<void> {
    const requestsDir = this.requestsDir;
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; kind: string }>(
        `UPDATE host_action_requests SET state = 'cancelled', updated_at = $2, finished_at = $2
          WHERE id = $1 AND state = 'pending' RETURNING id, kind`,
        [id, this.now()],
      );
      const r = rows[0];
      if (r === undefined)
        throw new HostActionError('no_pending_host_request', 'No such request is waiting for the host.');
      if (requestsDir !== null && (HOST_ACTION_KINDS as readonly string[]).includes(r.kind)) {
        const kind = r.kind as HostActionKind;
        if ((await pendingHostRequestId(requestsDir, kind)) === id)
          await removeHostRequest(requestsDir, kind);
      }
      await this.deps.audit.record(
        {
          ...this.auditActor(actor),
          action: 'host.request.cancel',
          target: id,
          outcome: 'success',
          metadata: { kind: r.kind },
        },
        tx,
      );
    });
  }

  /** Orchestrator tick: moves the open request by the host's result file and the clock. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.deps.log?.warn({ err }, 'host actions tick failed');
    }
  }

  reconcile(): Promise<void> {
    if (this.#reconciling) return this.#reconciling;
    this.#reconciling = this.doReconcile().finally(() => {
      this.#reconciling = null;
    });
    return this.#reconciling;
  }

  private async finish(
    open: Row,
    state: Exclude<HostActionState, 'pending' | 'applying'>,
    detail: string | null,
    step: string | null,
    log: readonly string[] | null,
  ): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const now = this.now();
      const { rowCount } = await tx.query(
        `UPDATE host_action_requests
            SET state = $2, detail = $3, step = coalesce($4, step), log = coalesce($5::jsonb, log),
                updated_at = $6, finished_at = $6
          WHERE id = $1 AND state = ANY($7::text[])`,
        [
          open.id,
          state,
          detail?.slice(0, 500) ?? null,
          step?.slice(0, 200) ?? null,
          log === null ? null : JSON.stringify(cleanLog(log)),
          now,
          OPEN,
        ],
      );
      if (rowCount === 0) return; // another instance got there first
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'host-applier' },
          action: `host.${open.kind}.${state}`,
          target: open.id,
          outcome: state === 'applied' || state === 'scheduled' ? 'success' : 'failure',
          metadata: { ...open.params, ...(detail === null ? {} : { detail: detail.slice(0, 300) }) },
        },
        tx,
      );
    });
  }

  private async doReconcile(): Promise<void> {
    const open = await this.openRow();
    if (open === null) return;
    const statusDir = this.statusDir;
    const requestsDir = this.requestsDir;
    const known = (HOST_ACTION_KINDS as readonly string[]).includes(open.kind);
    const kind = open.kind as HostActionKind;
    const now = this.now();
    const result = statusDir === null || !known ? null : await readHostResult(statusDir, kind);
    if (result !== null && result.at.getTime() >= open.requested_at.getTime() - 1_000) {
      const mine = result.id === open.id;
      const unattributed = result.id === '' && result.state === 'refused' && open.state === 'pending';
      if (mine || unattributed) {
        if (result.state === 'applying') {
          await this.deps.pool.query(
            `UPDATE host_action_requests SET state = 'applying', step = $2, updated_at = $3
              WHERE id = $1 AND state = ANY($4::text[]) AND (state = 'pending' OR step IS DISTINCT FROM $2)`,
            [open.id, result.step.slice(0, 200) || null, now, OPEN],
          );
          return;
        }
        if (requestsDir !== null && (await pendingHostRequestId(requestsDir, kind)) === open.id) {
          await removeHostRequest(requestsDir, kind);
        }
        await this.finish(open, result.state, result.detail || null, result.step || null, result.log);
        return;
      }
    }
    if (open.state === 'pending' && now.getTime() > open.expires_at.getTime()) {
      if (requestsDir !== null && known && (await pendingHostRequestId(requestsDir, kind)) === open.id) {
        await removeHostRequest(requestsDir, kind);
      }
      await this.finish(open, 'expired', 'the host applier did not pick the request up in time', null, null);
      return;
    }
    const timeout = this.deps.applyingTimeoutMs ?? APPLYING_TIMEOUT_MS[open.kind] ?? 60 * 60_000;
    if (open.state === 'applying' && now.getTime() - open.updated_at.getTime() > timeout) {
      await this.finish(open, 'failed', 'the host applier did not report a result', null, null);
    }
  }
}
