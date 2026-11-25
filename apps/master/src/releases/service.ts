import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  compareReleaseVersions,
  type ReleaseChannel,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ProtocolVersion,
  ReleaseVersion,
  type UpdateDiagnostics,
  UpdateDiagnostics as UpdateDiagnosticsSchema,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  type WorkerToMaster,
} from '@remyral/protocol';
import { Redactor } from '@remyral/observability';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { blobs, rowContent } from '../blobs/registry.js';
import { clampLimit, decodeKeyset, keysetPage } from '../http/pagination.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerHub } from '../workers/hub.js';
import { WORKER_ID_PATTERN } from '../workers/ids.js';
import type { WorkerSession } from '../workers/types.js';
import { actorUserId, auditIdentity, type ReleaseActor } from './actor.js';
import { type ChannelState, desiredUpdate, type TargetState } from './rollout.js';

/** Download tokens are single-worker, single-release and short-lived. */
export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60_000;
/** An attempt without a final report after this long is closed as timed out (and may be re-offered). */
export const ATTEMPT_TIMEOUT_MS = 60 * 60_000;

export const OPEN_STATUSES = ['offered', 'downloading', 'deferred', 'activating'] as const;
const TERMINAL = new Set(['succeeded', 'rolled_back', 'failed', 'refused', 'superseded', 'timed_out']);

type UpdateStatusMessage = Extract<WorkerToMaster, { type: 'UPDATE_STATUS' }>;

export interface ReleaseSummary {
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly keyId: string;
  readonly protocolVersions: string[];
  readonly minNode: string;
  readonly builtAt: string;
  readonly uploadedAt: string;
}

export interface ChannelSummary {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly rolloutPercent: number;
  readonly updatedAt: string;
}

export interface AttemptSummary {
  readonly id: string;
  readonly workerId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly source: 'channel' | 'target';
  readonly rollback: boolean;
  readonly force: boolean;
  readonly status: string;
  readonly reason: string | null;
  readonly detail: string | null;
  /** p6-worker-boot-diagnostics: the boot verdict of the attached evidence (null: none attached). */
  readonly verdict: string | null;
  readonly hasDiagnostics: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface ReleaseUpload {
  readonly manifest: Buffer;
  readonly signature: unknown;
  readonly artifact: Buffer;
}

export interface TargetRequest {
  readonly version?: string | undefined;
  readonly channel?: ReleaseChannel | undefined;
  readonly rollback?: boolean | undefined;
  readonly force?: boolean | undefined;
}

export interface ReleaseServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly hub: WorkerHub;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** RELEASE_PUBLIC_KEYS: the master verifies uploads but holds no signing key. Empty = uploads refused. */
  readonly publicKeys: readonly string[];
  readonly supportedVersions?: readonly ProtocolVersion[];
}

/** Every channel's version and rollout percentage as one comparable string. */
async function channelMarker(q: Queryable): Promise<string> {
  const { rows } = await q.query<{ marker: string | null }>(
    `SELECT string_agg(channel || '=' || version || '@' || rollout_percent::text, ',' ORDER BY channel) AS marker
       FROM worker_release_channels`,
  );
  return rows[0]?.marker ?? '';
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(`remyral-release-download/v1\n${token}`).digest();
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Not found.');
}

interface ReleaseRow {
  version: string;
  channel: ReleaseChannel;
  sha256: string;
  size_bytes: number;
  key_id: string;
  protocol_versions: string[];
  min_node: string;
  built_at: Date;
  uploaded_at: Date;
}

const RELEASE_COLUMNS =
  'version, channel, sha256, size_bytes, key_id, protocol_versions, min_node, built_at, uploaded_at';

function releaseSummary(r: ReleaseRow): ReleaseSummary {
  return {
    version: r.version,
    channel: r.channel,
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    keyId: r.key_id,
    protocolVersions: r.protocol_versions,
    minNode: r.min_node,
    builtAt: r.built_at.toISOString(),
    uploadedAt: r.uploaded_at.toISOString(),
  };
}

interface AttemptRow {
  id: string;
  worker_id: string;
  from_version: string;
  to_version: string;
  source: 'channel' | 'target';
  rollback: boolean;
  force: boolean;
  status: string;
  reason: string | null;
  detail: string | null;
  verdict: string | null;
  has_diagnostics: boolean;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** The attempt columns of the list (the diagnostics themselves only by id: up to 32 KiB each). */
/** Keyset scope of the update-attempt cursor (p9-pagination). */
const ATTEMPTS_SCOPE = 'releases.attempts';

const ATTEMPT_LIST_COLUMNS = `id, worker_id, from_version, to_version, source, rollback, force, status, reason, detail,
  diagnostics->>'verdict' AS verdict, diagnostics IS NOT NULL AS has_diagnostics, created_at, updated_at, finished_at`;

const diagnosticsRedactor = new Redactor();

/** The master redacts the worker's (already redacted) evidence again and re-validates its bounds. */
function storedDiagnostics(d: UpdateDiagnostics | undefined): UpdateDiagnostics | null {
  if (d === undefined) return null;
  const lines = (l: readonly string[] | undefined) =>
    l === undefined ? undefined : l.map((x) => diagnosticsRedactor.redact(x));
  const out = {
    ...d,
    ...(d.bootLog === undefined ? {} : { bootLog: lines(d.bootLog) }),
    ...(d.serviceOutput === undefined ? {} : { serviceOutput: lines(d.serviceOutput) }),
    ...(d.updaterLog === undefined ? {} : { updaterLog: lines(d.updaterLog) }),
    ...(d.restartErrors === undefined ? {} : { restartErrors: lines(d.restartErrors) }),
  };
  const parsed = UpdateDiagnosticsSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

function attemptSummary(a: AttemptRow): AttemptSummary {
  return {
    id: a.id,
    workerId: a.worker_id,
    fromVersion: a.from_version,
    toVersion: a.to_version,
    source: a.source,
    rollback: a.rollback,
    force: a.force,
    status: a.status,
    reason: a.reason,
    detail: a.detail,
    verdict: a.verdict,
    hasDiagnostics: a.has_diagnostics,
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at.toISOString(),
    finishedAt: iso(a.finished_at),
  };
}

/**
 * Worker release registry and update orchestration (p2-signed-updates, threat model T-SUP-2).
 *
 * - **Registry**: an admin uploads a release signed offline with the release key; it is accepted only if
 *   the signature verifies against `RELEASE_PUBLIC_KEYS`, the artifact matches the manifest and the build
 *   speaks a protocol version this master supports. The master never signs.
 * - **Intent**: channels (`stable`/`canary`) with a rollout percentage, per-worker channel membership and
 *   explicit targets (pin / rollback / force). Every change is audited.
 * - **Offers**: on every worker session and after every intent change the master computes the desired
 *   version, opens an attempt and sends UPDATE_AVAILABLE with a fresh download token. The worker reports
 *   progress and the outcome with UPDATE_STATUS; failed versions are not re-offered automatically.
 */
export class ReleaseService {
  readonly #supported: readonly ProtocolVersion[];
  /** The channel state last offered from this process ({@link offerIfChannelsChanged}). */
  #channelsSeen: string | null = null;

  /** p16-ops-safety: called after a worker reported a final update outcome (the rollout circuit breaker). */
  #onOutcome: (() => void) | null = null;
  /** p17-worker-managed: notifies owners/admins of a rolled-back or failed update (bound once notifications exist). */
  #notifications: (() => NotificationService | null) | null = null;

  constructor(private readonly deps: ReleaseServiceDeps) {
    this.#supported = deps.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
  }

  /** p16-ops-safety: observe final update outcomes (the breaker evaluates the rollout right away). */
  observeOutcomes(fn: () => void): void {
    this.#onOutcome = fn;
  }

  /**
   * p17-worker-managed: a machine's update that was rolled back or failed raises a notification (owners and admins,
   * once per attempt) — a silent rollback such as 1.1.4 → 1.1.3 must not go unnoticed.
   */
  notifyFailuresWith(fn: () => NotificationService | null): void {
    this.#notifications = fn;
  }

  // ---------------------------------------------------------------- registry

  async upload(
    input: ReleaseUpload,
    actor: ReleaseActor,
  ): Promise<{ release: ReleaseSummary; created: boolean }> {
    if (this.deps.publicKeys.length === 0) {
      throw new HttpError(
        503,
        'release_keys_not_configured',
        'RELEASE_PUBLIC_KEYS is not configured on the master; releases cannot be verified.',
        {},
        {},
        { reason: 'verify' },
      );
    }
    const v = verifyReleaseManifest(input.manifest, input.signature, this.deps.publicKeys);
    if (!v.ok) {
      await this.#auditUser(actor, 'release.upload', 'denied', null, { reason: v.reason });
      throw new HttpError(
        422,
        'signature_invalid',
        `The release is not validly signed (${v.reason}).`,
        {},
        {},
        { detail: v.reason },
      );
    }
    const m = v.manifest;
    const integrity = verifyReleaseArtifact(m, input.artifact);
    if (!integrity.ok) {
      await this.#auditUser(actor, 'release.upload', 'denied', m.version, { reason: integrity.reason });
      throw new HttpError(
        422,
        'artifact_mismatch',
        `The artifact does not match the signed manifest (${integrity.reason}).`,
        {},
        {},
        { detail: integrity.reason },
      );
    }
    if (!m.protocolVersions.some((p) => this.#supported.includes(p))) {
      await this.#auditUser(actor, 'release.upload', 'denied', m.version, {
        reason: 'protocol_incompatible',
      });
      throw new HttpError(
        422,
        'protocol_incompatible',
        `The release speaks protocol ${m.protocolVersions.join(', ')}; this master supports ${this.#supported.join(', ')}.`,
        {},
        {},
        { release: m.protocolVersions.join(', '), supported: this.#supported.join(', ') },
      );
    }
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      const existing = await tx.query<{ sha256: string; channel: ReleaseChannel }>(
        'SELECT sha256, channel FROM worker_releases WHERE version = $1 FOR UPDATE',
        [m.version],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (prior.sha256 !== m.sha256) {
          throw new HttpError(
            409,
            'version_exists',
            `Release ${m.version} already exists with different content.`,
            {},
            {},
            { version: m.version },
          );
        }
        if (prior.channel === m.channel || m.channel === 'canary') {
          return { release: await this.#release(tx, m.version), created: false };
        }
        // Same bytes re-signed for stable (promotion of a canary build).
        await tx.query(
          `UPDATE worker_releases SET channel = $2, manifest = $3, signature = $4, key_id = $5, built_at = $6
            WHERE version = $1`,
          [
            m.version,
            m.channel,
            input.manifest,
            JSON.stringify(input.signature),
            v.keyId,
            new Date(m.createdAt),
          ],
        );
        await this.#auditUser(
          actor,
          'release.upload',
          'success',
          m.version,
          { channel: m.channel, resigned: true, keyId: v.keyId },
          tx,
        );
        return { release: await this.#release(tx, m.version), created: false };
      }
      // p17-object-storage: the release bundle goes to the blob store (never Postgres); the row keeps the key.
      const key = await blobs().write(
        'release',
        `releases/${m.version}/bundle-${randomBytes(6).toString('hex')}`,
        input.artifact,
      );
      await tx.query(
        `INSERT INTO worker_releases (version, channel, manifest, signature, key_id, sha256, size_bytes,
                                      protocol_versions, min_node, artifact, blob_key, built_at, uploaded_at,
                                      uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13)`,
        [
          m.version,
          m.channel,
          input.manifest,
          JSON.stringify(input.signature),
          v.keyId,
          m.sha256,
          m.size,
          JSON.stringify(m.protocolVersions),
          m.minNode,
          key,
          new Date(m.createdAt),
          now,
          actorUserId(actor),
        ],
      );
      await this.#auditUser(
        actor,
        'release.upload',
        'success',
        m.version,
        { channel: m.channel, sha256: m.sha256, keyId: v.keyId, size: m.size },
        tx,
      );
      return { release: await this.#release(tx, m.version), created: true };
    });
  }

  async #release(q: Queryable, version: string): Promise<ReleaseSummary> {
    const { rows } = await q.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS} FROM worker_releases WHERE version = $1`,
      [version],
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    return releaseSummary(row);
  }

  async list(
    workerId?: string,
    /** p9-pagination: the update-attempt history is keyset-paged (newest first by `(created_at, id)`). */
    attemptsPage: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<{
    releases: ReleaseSummary[];
    channels: ChannelSummary[];
    attempts: AttemptSummary[];
    attemptsNextCursor: string | null;
  }> {
    const limit = clampLimit(attemptsPage.limit, 100, 200);
    const after =
      attemptsPage.cursor === undefined ? null : decodeKeyset(ATTEMPTS_SCOPE, attemptsPage.cursor, 'uuid');
    const releases = await this.deps.pool.query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM worker_releases`);
    const channels = await this.deps.pool.query<{
      channel: ReleaseChannel;
      version: string;
      rollout_percent: number;
      updated_at: Date;
    }>('SELECT channel, version, rollout_percent, updated_at FROM worker_release_channels ORDER BY channel');
    const attempts = await this.deps.pool.query<AttemptRow & { page_key: string }>(
      `SELECT ${ATTEMPT_LIST_COLUMNS}, to_json(created_at) #>> '{}' AS page_key
         FROM worker_update_attempts
        WHERE ($1::text IS NULL OR worker_id = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [workerId ?? null, after?.k ?? null, after?.id ?? null, limit + 1],
    );
    const attemptPage = keysetPage(
      attempts.rows,
      limit,
      ATTEMPTS_SCOPE,
      (r) => ({ k: r.page_key, id: r.id }),
      attemptSummary,
    );
    return {
      releases: releases.rows
        .map(releaseSummary)
        .sort((a, b) => compareReleaseVersions(b.version, a.version)),
      channels: channels.rows.map((c) => ({
        channel: c.channel,
        version: c.version,
        rolloutPercent: c.rollout_percent,
        updatedAt: c.updated_at.toISOString(),
      })),
      attempts: attemptPage.items,
      attemptsNextCursor: attemptPage.nextCursor,
    };
  }

  /** Point a channel at a release with a rollout percentage, then offer it to connected workers. */
  async promote(
    channel: ReleaseChannel,
    version: string,
    rolloutPercent: number,
    actor: ReleaseActor,
  ): Promise<ChannelSummary> {
    const now = this.deps.clock();
    const summary = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ channel: ReleaseChannel }>(
        'SELECT channel FROM worker_releases WHERE version = $1',
        [version],
      );
      const release = rows[0];
      if (release === undefined)
        throw new HttpError(
          404,
          'release_not_found',
          `Release ${version} does not exist.`,
          {},
          {},
          { version },
        );
      if (channel === 'stable' && release.channel !== 'stable') {
        throw new HttpError(
          409,
          'channel_mismatch',
          `Release ${version} is signed for canary only; re-sign it for stable (sign.mjs sign --channel stable) and upload it again.`,
          {},
          {},
          { version },
        );
      }
      const prev = await tx.query<{ version: string; rollout_percent: number }>(
        'SELECT version, rollout_percent FROM worker_release_channels WHERE channel = $1',
        [channel],
      );
      // p16-ops-safety: a held rollout is never raised further; promoting another version supersedes the hold.
      const hold = await tx.query<{ id: string; version: string }>(
        'SELECT id::text AS id, version FROM release_rollout_holds WHERE channel = $1 AND resolved_at IS NULL FOR UPDATE',
        [channel],
      );
      const held = hold.rows[0];
      if (held !== undefined) {
        const current = prev.rows[0];
        if (held.version === version) {
          if (current === undefined || rolloutPercent > current.rollout_percent) {
            throw new HttpError(
              409,
              'rollout_paused',
              `The rollout of ${version} on ${channel} is held by the circuit breaker; resume it or roll back first.`,
              {},
              {},
              { version, channel },
            );
          }
        } else {
          await tx.query(
            `UPDATE release_rollout_holds SET resolved_at = $2, resolved_by = $3, resolution = 'superseded'
              WHERE id = $1`,
            [held.id, now, actorUserId(actor)],
          );
          await this.#auditUser(
            actor,
            'release.rollout.superseded',
            'success',
            held.version,
            { channel, holdId: held.id, newVersion: version },
            tx,
          );
        }
      }
      await tx.query(
        `INSERT INTO worker_release_channels (channel, version, rollout_percent, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel) DO UPDATE SET version = EXCLUDED.version, rollout_percent = EXCLUDED.rollout_percent,
                                             updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [channel, version, rolloutPercent, now, actorUserId(actor)],
      );
      await this.#auditUser(
        actor,
        'release.promote',
        'success',
        version,
        {
          channel,
          rolloutPercent,
          previousVersion: prev.rows[0]?.version ?? null,
          previousRolloutPercent: prev.rows[0]?.rollout_percent ?? null,
        },
        tx,
      );
      return {
        summary: { channel, version, rolloutPercent, updatedAt: now.toISOString() },
        marker: await channelMarker(tx),
      };
    });
    // This process offers right away; the poll must not offer the same change a second time.
    this.#channelsSeen = summary.marker;
    await this.offerToConnected();
    return summary.summary;
  }

  /**
   * p6-release-import: a channel changed outside this process (the host-side `release-import --rollout`,
   * or another master replica) reaches connected workers here — compose.ts polls this on a timer. The
   * first call only records the current state (sessions are offered when they start). Returns whether
   * it offered.
   */
  async offerIfChannelsChanged(): Promise<boolean> {
    const before = this.#channelsSeen;
    const marker = await channelMarker(this.deps.pool);
    // A promote in this process ran meanwhile: it offered and recorded its own marker.
    if (this.#channelsSeen !== before) return false;
    this.#channelsSeen = marker;
    if (before === null || before === marker) return false;
    await this.offerToConnected();
    return true;
  }

  /** Set a worker's channel and/or explicit target (pin, rollback, force), then offer at once if connected. */
  async target(
    workerId: string,
    req: TargetRequest,
    actor: ActorContext,
  ): Promise<{
    workerId: string;
    channel: ReleaseChannel;
    targetVersion: string | null;
    rollback: boolean;
    force: boolean;
  }> {
    if (!WORKER_ID_PATTERN.test(workerId)) throw notFound();
    const now = this.deps.clock();
    const result = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('remyral-worker-update:' || $1))", [workerId]);
      const w = await tx.query<{ state: string; worker_version: string }>(
        'SELECT state, worker_version FROM workers WHERE id = $1',
        [workerId],
      );
      const worker = w.rows[0];
      if (worker === undefined) throw notFound();
      if (worker.state === 'pending' || worker.state === 'quarantined') {
        throw new HttpError(409, 'not_updatable', 'Only an enrolled, non-quarantined worker can be updated.');
      }
      const existing = await tx.query<{ channel: ReleaseChannel }>(
        'SELECT channel FROM worker_update_targets WHERE worker_id = $1',
        [workerId],
      );
      const channel = req.channel ?? existing.rows[0]?.channel ?? 'stable';
      const version = req.version ?? null;
      const rollback = req.rollback === true;
      const force = req.force === true;
      if (version === null && (rollback || force)) {
        throw new HttpError(400, 'version_required', 'rollback/force need an explicit version.');
      }
      if (version !== null) {
        const r = await tx.query('SELECT 1 FROM worker_releases WHERE version = $1', [version]);
        if ((r.rowCount ?? 0) === 0)
          throw new HttpError(
            404,
            'release_not_found',
            `Release ${version} does not exist.`,
            {},
            {},
            { version },
          );
        const current = ReleaseVersion.safeParse(worker.worker_version);
        if (current.success && compareReleaseVersions(version, current.data) < 0 && !rollback) {
          throw new HttpError(
            409,
            'downgrade_requires_rollback',
            `${version} is lower than the running ${current.data}; send rollback: true to roll back explicitly.`,
            {},
            {},
            { version, current: current.data },
          );
        }
      }
      await tx.query(
        `INSERT INTO worker_update_targets (worker_id, channel, target_version, rollback, force, requested_at, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (worker_id) DO UPDATE SET channel = EXCLUDED.channel, target_version = EXCLUDED.target_version,
                rollback = EXCLUDED.rollback, force = EXCLUDED.force, requested_at = EXCLUDED.requested_at,
                requested_by = EXCLUDED.requested_by`,
        [workerId, channel, version, rollback, force, now, actor.userId],
      );
      // A new intent supersedes whatever was in flight (the worker ignores a second offer while busy).
      await tx.query(
        `UPDATE worker_update_attempts SET status = 'superseded', token_hash = NULL, token_expires_at = NULL,
                updated_at = $2, finished_at = $2
          WHERE worker_id = $1 AND status IN ('offered', 'downloading', 'deferred')`,
        [workerId, now],
      );
      await this.#auditUser(
        actor,
        'worker.update.target',
        'success',
        workerId,
        {
          channel,
          targetVersion: version,
          rollback,
          force,
        },
        tx,
      );
      return { workerId, channel, targetVersion: version, rollback, force };
    });
    const session = this.deps.hub.get(workerId)?.session;
    if (session)
      await this.offer(session).catch((err: unknown) => {
        this.deps.log.error({ err, workerId }, 'update offer failed');
      });
    return result;
  }

  // ---------------------------------------------------------------- offers

  async onSessionStart(session: WorkerSession): Promise<void> {
    await this.offer(session);
  }

  async offerToConnected(): Promise<void> {
    for (const workerId of this.deps.hub.connectedWorkers) {
      const session = this.deps.hub.get(workerId)?.session;
      if (!session) continue;
      await this.offer(session).catch((err: unknown) => {
        this.deps.log.error({ err, workerId }, 'update offer failed');
      });
    }
  }

  /** Computes the desired version for a session and sends UPDATE_AVAILABLE when there is one. */
  async offer(session: WorkerSession): Promise<boolean> {
    const now = this.deps.clock();
    const offer = await withTransaction(this.deps.pool, async (tx) => {
      // Serialise update decisions per worker with an advisory lock — never a row lock on `workers`,
      // which session start/end and heartbeats update concurrently (a row lock here reorders them).
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('remyral-worker-update:' || $1))", [
        session.workerId,
      ]);
      const w = await tx.query<{ state: string }>('SELECT state FROM workers WHERE id = $1', [
        session.workerId,
      ]);
      const state = w.rows[0]?.state;
      if (state === undefined || state === 'pending' || state === 'quarantined') return null;
      await tx.query(
        `UPDATE worker_update_attempts SET status = 'timed_out', token_hash = NULL, token_expires_at = NULL,
                updated_at = $2, finished_at = $2
          WHERE worker_id = $1 AND status IN ('offered', 'downloading', 'deferred', 'activating')
            AND updated_at < $3`,
        [session.workerId, now, new Date(now.getTime() - ATTEMPT_TIMEOUT_MS)],
      );
      const t = await tx.query<{
        channel: ReleaseChannel;
        target_version: string | null;
        rollback: boolean;
        force: boolean;
        requested_at: Date;
      }>(
        'SELECT channel, target_version, rollback, force, requested_at FROM worker_update_targets WHERE worker_id = $1',
        [session.workerId],
      );
      const targetRow = t.rows[0];
      const target: TargetState | null =
        targetRow === undefined
          ? null
          : {
              channel: targetRow.channel,
              targetVersion: targetRow.target_version,
              rollback: targetRow.rollback,
              force: targetRow.force,
            };
      const c = await tx.query<{ channel: ReleaseChannel; version: string; rollout_percent: number }>(
        'SELECT channel, version, rollout_percent FROM worker_release_channels',
      );
      const channels = new Map<ReleaseChannel, ChannelState>(
        c.rows.map((r) => [r.channel, { version: r.version, rolloutPercent: r.rollout_percent }]),
      );
      const wanted = desiredUpdate(session.workerId, session.workerVersion, target, channels);
      if (wanted === null) return null;
      // p16-ops-safety: no new machine takes a channel version while its rollout is held.
      if (wanted.source === 'channel') {
        const held = await tx.query(
          'SELECT 1 FROM release_rollout_holds WHERE channel = $1 AND version = $2 AND resolved_at IS NULL',
          [target?.channel ?? 'stable', wanted.version],
        );
        if ((held.rowCount ?? 0) > 0) return null;
      }

      type OfferRelease = {
        channel: ReleaseChannel;
        sha256: string;
        size_bytes: number;
        protocol_versions: string[];
      };
      const rel = (
        await tx.query<OfferRelease>(
          'SELECT channel, sha256, size_bytes, protocol_versions FROM worker_releases WHERE version = $1',
          [wanted.version],
        )
      ).rows[0];
      if (rel === undefined) return null;
      const desired = wanted;
      if (!rel.protocol_versions.includes(session.negotiatedVersion)) {
        this.deps.log.warn(
          { workerId: session.workerId, version: desired.version, negotiated: session.negotiatedVersion },
          'release does not speak the session protocol; not offered',
        );
        return null;
      }
      // No automatic retry of a version that already failed on this worker (an admin re-targets to retry).
      const since =
        desired.source === 'target' && targetRow !== undefined ? targetRow.requested_at : new Date(0);
      const failed = await tx.query(
        `SELECT 1 FROM worker_update_attempts
          WHERE worker_id = $1 AND to_version = $2 AND status IN ('failed', 'rolled_back', 'refused')
            AND created_at >= $3 LIMIT 1`,
        [session.workerId, desired.version, since],
      );
      if ((failed.rowCount ?? 0) > 0) return null;

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_MS);
      const open = await tx.query<{ id: string; to_version: string; status: string }>(
        `SELECT id, to_version, status FROM worker_update_attempts
          WHERE worker_id = $1 AND status IN ('offered', 'downloading', 'deferred', 'activating') FOR UPDATE`,
        [session.workerId],
      );
      let attemptId: string;
      const current = open.rows[0];
      if (current !== undefined && current.to_version === desired.version) {
        // The update is mid-flight (or the worker restarted into it): wait for the worker's report.
        if (current.status === 'activating') return null;
        attemptId = current.id;
        await tx.query(
          `UPDATE worker_update_attempts SET status = 'offered', token_hash = $2, token_expires_at = $3, updated_at = $4
            WHERE id = $1`,
          [attemptId, tokenHash(token), expiresAt, now],
        );
      } else {
        if (current !== undefined) {
          if (current.status === 'activating') return null;
          await tx.query(
            `UPDATE worker_update_attempts SET status = 'superseded', token_hash = NULL, token_expires_at = NULL,
                    updated_at = $2, finished_at = $2 WHERE id = $1`,
            [current.id, now],
          );
        }
        attemptId = randomUUID();
        await tx.query(
          `INSERT INTO worker_update_attempts (id, worker_id, from_version, to_version, source, rollback, force, status,
                                               token_hash, token_expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'offered', $8, $9, $10, $10)`,
          [
            attemptId,
            session.workerId,
            session.workerVersion.slice(0, 64),
            desired.version,
            desired.source,
            desired.rollback,
            desired.force,
            tokenHash(token),
            expiresAt,
            now,
          ],
        );
        await this.deps.audit.record(
          {
            actor: { type: 'system' },
            action: 'worker.update.offer',
            outcome: 'success',
            target: session.workerId,
            metadata: {
              attemptId,
              from: session.workerVersion,
              to: desired.version,
              source: desired.source,
              rollback: desired.rollback,
              force: desired.force,
            },
          },
          tx,
        );
      }
      return { attemptId, token, expiresAt, desired, rel };
    });
    if (offer === null) return false;
    const v = offer.desired.version;
    await session.send('UPDATE_AVAILABLE', {
      attemptId: offer.attemptId,
      version: v,
      channel: offer.rel.channel,
      sha256: offer.rel.sha256,
      size: offer.rel.size_bytes,
      manifestUrl: `/v1/worker/releases/${v}/manifest`,
      artifactUrl: `/v1/worker/releases/${v}/artifact`,
      downloadToken: offer.token,
      tokenExpiresAt: offer.expiresAt.toISOString(),
      rollback: offer.desired.rollback,
      force: offer.desired.force,
    });
    return true;
  }

  /** p6-worker-boot-diagnostics: the evidence attached to an attempt; null when none (404 for an unknown id). */
  async attemptDiagnostics(attemptId: string): Promise<{
    attemptId: string;
    workerId: string;
    toVersion: string;
    diagnostics: UpdateDiagnostics | null;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      worker_id: string;
      to_version: string;
      diagnostics: unknown;
    }>('SELECT id, worker_id, to_version, diagnostics FROM worker_update_attempts WHERE id = $1', [
      attemptId,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = row.diagnostics === null ? null : UpdateDiagnosticsSchema.safeParse(row.diagnostics);
    return {
      attemptId: row.id,
      workerId: row.worker_id,
      toVersion: row.to_version,
      diagnostics: parsed?.success === true ? parsed.data : null,
    };
  }

  /** UPDATE_STATUS from the worker: progress or final outcome of one of *its* attempts. */
  async onStatus(session: WorkerSession, message: UpdateStatusMessage): Promise<void> {
    const p = message.payload;
    const now = this.deps.clock();
    const outcome = { final: false };
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ status: string; to_version: string }>(
        'SELECT status, to_version FROM worker_update_attempts WHERE id = $1 AND worker_id = $2 FOR UPDATE',
        [p.attemptId, session.workerId],
      );
      const attempt = rows[0];
      if (attempt === undefined || attempt.to_version !== p.version) {
        this.deps.log.warn(
          { workerId: session.workerId, attemptId: p.attemptId },
          'UPDATE_STATUS for an unknown attempt',
        );
        return;
      }
      const terminal = TERMINAL.has(p.phase);
      // A worker outcome is final (reports are re-sent after reconnects). A superseded / timed-out
      // attempt still takes the worker's final outcome (it may have activated meanwhile), never progress.
      const closedByMaster = attempt.status === 'superseded' || attempt.status === 'timed_out';
      if (TERMINAL.has(attempt.status) && !closedByMaster) return;
      if (closedByMaster && !terminal) return;
      const diagnostics = terminal ? storedDiagnostics(p.diagnostics) : null;
      await tx.query(
        `UPDATE worker_update_attempts
            SET status = $2, reason = $3, detail = $4, updated_at = $5,
                finished_at = CASE WHEN $6 THEN $5 ELSE finished_at END,
                token_hash = CASE WHEN $6 THEN NULL ELSE token_hash END,
                token_expires_at = CASE WHEN $6 THEN NULL ELSE token_expires_at END,
                diagnostics = COALESCE($7::jsonb, diagnostics)
          WHERE id = $1`,
        [
          p.attemptId,
          p.phase,
          p.reason ?? null,
          p.detail?.slice(0, 500) ?? null,
          now,
          terminal,
          diagnostics === null ? null : JSON.stringify(diagnostics),
        ],
      );
      if (terminal) {
        outcome.final = true;
        await this.deps.audit.record(
          {
            actor: { type: 'worker', id: session.workerId },
            action: `worker.update.${p.phase}`,
            outcome: p.phase === 'succeeded' ? 'success' : 'failure',
            target: session.workerId,
            metadata: {
              attemptId: p.attemptId,
              version: p.version,
              reason: p.reason ?? null,
              runningVersion: p.currentVersion,
              // p6-worker-boot-diagnostics: the boot verdict (the evidence itself stays in the attempt row).
              verdict: diagnostics?.verdict ?? null,
            },
          },
          tx,
        );
        if (p.phase === 'rolled_back' || p.phase === 'failed') {
          await this.#notifyFailure(tx, session.workerId, {
            attemptId: p.attemptId,
            phase: p.phase,
            version: p.version,
            running: p.currentVersion,
            reason: p.reason ?? null,
            detail: p.detail ?? null,
          });
        }
      }
    });
    if (outcome.final) this.#onOutcome?.();
  }

  // ---------------------------------------------------------------- downloads

  /** Resolves a download token for `version` (worker-scoped, unexpired, open attempt, live worker). */
  async authorizeDownload(
    token: string,
    version: string,
  ): Promise<{ workerId: string; attemptId: string } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !ReleaseVersion.safeParse(version).success) return null;
    const { rows } = await this.deps.pool.query<{ id: string; worker_id: string }>(
      `SELECT a.id, a.worker_id FROM worker_update_attempts a JOIN workers w ON w.id = a.worker_id
        WHERE a.token_hash = $1 AND a.to_version = $2 AND a.token_expires_at > $3
          AND a.status IN ('offered', 'downloading', 'deferred') AND w.state NOT IN ('pending', 'quarantined')`,
      [tokenHash(token), version, this.deps.clock()],
    );
    const row = rows[0];
    return row === undefined ? null : { workerId: row.worker_id, attemptId: row.id };
  }

  async manifestDocument(version: string): Promise<{ manifest: string; signature: unknown } | null> {
    const { rows } = await this.deps.pool.query<{ manifest: Buffer; signature: unknown }>(
      'SELECT manifest, signature FROM worker_releases WHERE version = $1',
      [version],
    );
    const r = rows[0];
    return r === undefined ? null : { manifest: r.manifest.toString('base64'), signature: r.signature };
  }

  async artifact(version: string): Promise<Buffer | null> {
    const { rows } = await this.deps.pool.query<{ content: Buffer | null; blob_key: string | null }>(
      'SELECT artifact AS content, blob_key FROM worker_releases WHERE version = $1',
      [version],
    );
    // p17-object-storage: the bundle is in the blob store (or the legacy column until blobs:migrate ran).
    return rows[0] === undefined ? null : rowContent(rows[0], 64 * 1024 * 1024);
  }

  async #notifyFailure(
    tx: Queryable,
    workerId: string,
    a: {
      attemptId: string;
      phase: 'rolled_back' | 'failed';
      version: string;
      running: string;
      reason: string | null;
      detail: string | null;
    },
  ): Promise<void> {
    const n = this.#notifications?.() ?? null;
    if (n === null) return;
    const { rows } = await tx.query<{ display_name: string }>(
      'SELECT display_name FROM workers WHERE id = $1',
      [workerId],
    );
    const name = rows[0]?.display_name ?? workerId;
    const why = a.reason === null ? '' : ` (${a.reason.replaceAll('_', ' ')})`;
    const detail = a.detail === null ? '' : ` ${diagnosticsRedactor.redact(a.detail).slice(0, 300)}`;
    await n.notify(tx, await globalRecipients(tx, 'admin'), {
      kind: 'worker.update_failed',
      severity: 'warning',
      title:
        a.phase === 'rolled_back'
          ? `${name}: update to ${a.version} was rolled back`
          : `${name}: update to ${a.version} failed`,
      body: `The machine runs ${a.running}${why}.${detail} Retry, pin a version or roll back in Machines → ${name} → Admin → Version.`,
      link: `/machines/${encodeURIComponent(workerId)}?tab=admin`,
      dedupeKey: `worker.update_failed:${a.attemptId}`,
    });
  }

  async #auditUser(
    actor: ReleaseActor,
    action: string,
    outcome: 'success' | 'denied',
    target: string | null,
    metadata: Record<string, unknown>,
    tx?: Queryable,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        ...auditIdentity(actor),
        action,
        outcome,
        target,
        metadata,
      },
      tx,
    );
  }
}
