import { randomUUID } from 'node:crypto';
import {
  compareReleaseVersions,
  MAX_RELEASE_BUNDLE_BYTES,
  MAX_WORKER_FEED_BYTES,
  type ReleaseBump,
  releaseBump,
  verifyWorkerReleaseFeed,
  type WorkerFeedRelease,
  type WorkerReleaseFeed,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { AdminError } from '../cli/admin.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { InstallerService } from '../installers/service.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import { auditIdentity, type ReleaseActor, type SystemActor } from '../releases/actor.js';
import { parseReleaseDocument } from '../releases/import.js';
import { publishRelease } from '../releases/routes.js';
import type { ReleaseService } from '../releases/service.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerHub } from '../workers/hub.js';
import {
  checkBundle,
  type FetchFn,
  fetchSigned,
  getBytes,
  readSignedFile,
  type SignedDocument,
  SourceError,
} from './sources.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * p17-update-channel (ADR-0065 §1–3, docs/design/p17-update-channel.md §3): the master pulls the vendor's signed worker
 * release feed, imports the newest release exactly like a manual upload (`publishRelease`, RELEASE_PUBLIC_KEYS), and
 * the owner's policy decides whether it rolls out by itself — canary machines first, then the stable channel — or
 * waits for "Güncelle". Never a downgrade; the circuit breaker (p16-ops-safety) keeps judging the stable rollout.
 */

export const UPDATE_CHANNEL_ACTOR: SystemActor = { type: 'system', id: 'update-channel' };

export type UpdatePolicy = 'patch_auto' | 'manual' | 'auto';
export const UPDATE_POLICIES: readonly UpdatePolicy[] = ['patch_auto', 'manual', 'auto'];

const SIX_HOURS = 6 * 60 * 60_000;
const FIVE_MINUTES = 5 * 60_000;
/** A canary machine that never took the offer for this long does not block the rollout. */
export const CANARY_IDLE_MS = 6 * 60 * 60_000;

export interface UpdateChannelDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly hub: WorkerHub;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly releases: ReleaseService;
  readonly installers: InstallerService | null;
  readonly notifications?: () => NotificationService | null;
  /** RELEASE_PUBLIC_KEYS: the only keys a feed and a release may be signed with. */
  readonly releaseKeys: readonly string[];
  readonly feedUrl: string | null;
  readonly feedFile: string | null;
  readonly fetch?: FetchFn;
  readonly intervalMs?: number;
  readonly fileIntervalMs?: number;
  /** After a failed import the release is tried again after this long (default 6 h). */
  readonly retryMs?: number;
  /** Imports, decisions and rollout progress at most this often from the orchestrator tick (default 30 s). */
  readonly processIntervalMs?: number;
}

export type ReleaseState =
  | 'available'
  | 'imported'
  | 'awaiting_approval'
  | 'rolling_out'
  | 'done'
  | 'import_failed'
  | 'canary_failed'
  | 'skipped';

export interface ChannelReleaseView {
  readonly version: string;
  readonly bump: ReleaseBump;
  readonly state: ReleaseState;
  readonly error: string | null;
  readonly publishedAt: string;
  readonly summary: string;
  readonly notes: string;
  readonly protocolVersions: readonly string[];
  readonly imported: boolean;
}

export interface RolloutView {
  readonly id: string;
  readonly version: string;
  readonly stage: string;
  readonly trigger: 'policy' | 'owner';
  readonly startedAt: string;
  readonly stageAt: string;
  readonly finishedAt: string | null;
  readonly reason: string | null;
  readonly canary: readonly { workerId: string; status: string }[];
}

export interface UpdateChannelView {
  readonly configured: boolean;
  readonly policy: UpdatePolicy;
  readonly soakMinutes: number;
  readonly feed: {
    readonly source: 'url' | 'file' | null;
    readonly keyId: string | null;
    readonly generatedAt: string | null;
    readonly checkedAt: string | null;
    readonly error: string | null;
  };
  readonly stableVersion: string | null;
  readonly releases: readonly ChannelReleaseView[];
  readonly rollout: RolloutView | null;
}

interface FeedRow {
  feed: Buffer | null;
  signature: unknown;
  key_id: string | null;
  source: 'url' | 'file' | null;
  generated_at: Date | null;
  checked_at: Date | null;
  error: string | null;
}

interface RolloutRow {
  id: string;
  version: string;
  stage: string;
  canary_workers: string[];
  trigger: 'policy' | 'owner';
  started_at: Date;
  stage_at: Date;
  finished_at: Date | null;
  reason: string | null;
}

const ROLLOUT_COLUMNS =
  'id::text AS id, version, stage, canary_workers, trigger, started_at, stage_at, finished_at, reason';

export class UpdateChannelService {
  #feed: WorkerReleaseFeed | null = null;
  #feedLoaded = false;
  #lastUrl = 0;
  #lastFile = 0;
  #running: Promise<void> | null = null;
  #lastProcess = 0;

  constructor(private readonly d: UpdateChannelDeps) {}

  get configured(): boolean {
    return this.d.releaseKeys.length > 0 && (this.d.feedUrl !== null || this.d.feedFile !== null);
  }

  /** The catalog keys the verified feed vouches for (the release key signed them). */
  feedCatalogKeys(): readonly string[] {
    return this.#feed?.catalogKeys ?? [];
  }

  #now(): Date {
    return this.d.clock();
  }

  async #loadFeed(): Promise<void> {
    if (this.#feedLoaded) return;
    this.#feedLoaded = true;
    const { rows } = await this.d.pool.query<FeedRow>('SELECT * FROM update_channel_feed WHERE id = 1');
    const r = rows[0];
    if (r?.feed == null || r.signature == null) return;
    const v = verifyWorkerReleaseFeed(r.feed, r.signature, this.d.releaseKeys);
    this.#feed = v.ok ? v.feed : null;
  }

  // ---------------------------------------------------------------- settings

  async settings(): Promise<{ policy: UpdatePolicy; soakMinutes: number }> {
    const { rows } = await this.d.pool.query<{ policy: UpdatePolicy; soak_minutes: number }>(
      'SELECT policy, soak_minutes FROM update_channel_settings WHERE id = 1',
    );
    return { policy: rows[0]?.policy ?? 'patch_auto', soakMinutes: rows[0]?.soak_minutes ?? 30 };
  }

  async setPolicy(
    input: { policy: UpdatePolicy; soakMinutes?: number | undefined },
    actor: ActorContext,
  ): Promise<{ policy: UpdatePolicy; soakMinutes: number }> {
    const before = await this.settings();
    const soak = input.soakMinutes ?? before.soakMinutes;
    await withTransaction(this.d.pool, async (tx) => {
      await tx.query(
        `UPDATE update_channel_settings SET policy = $1, soak_minutes = $2, updated_at = $3, updated_by = $4 WHERE id = 1`,
        [input.policy, soak, this.#now(), actor.userId],
      );
      await this.d.audit.record(
        {
          ...auditIdentity(actor),
          action: 'update_channel.policy',
          outcome: 'success',
          target: null,
          metadata: { policy: input.policy, soakMinutes: soak, previous: before.policy },
        },
        tx,
      );
    });
    // A newly automatic policy applies to the release that waits right away.
    void this.tick({ feed: false, force: true }).catch((err: unknown) => {
      this.d.log.error({ err }, 'update channel tick after a policy change failed');
    });
    return { policy: input.policy, soakMinutes: soak };
  }

  // ---------------------------------------------------------------- feed

  /** Orchestrator step: due feed reads, then imports / decisions / rollout progress. */
  tick(opts: { feed?: boolean; force?: boolean } = {}): Promise<void> {
    if (!this.configured) return Promise.resolve();
    if (this.#running) return this.#running;
    const t = this.#now().getTime();
    if (opts.force !== true && t - this.#lastProcess < (this.d.processIntervalMs ?? 30_000)) {
      return opts.feed === false ? Promise.resolve() : this.#refreshFeedOnly();
    }
    this.#lastProcess = t;
    this.#running = this.#tick(opts.feed !== false).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** "Şimdi kontrol et": both sources now. */
  async check(): Promise<void> {
    await this.#running;
    this.#lastUrl = 0;
    this.#lastFile = 0;
    await this.tick({ force: true });
  }

  /** Between processing runs only a due feed read happens (cheap when nothing is due). */
  #refreshFeedOnly(): Promise<void> {
    this.#running = (async () => {
      await this.#loadFeed();
      await this.#refreshFeed();
    })().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #tick(readFeed: boolean): Promise<void> {
    await this.#loadFeed();
    if (readFeed) await this.#refreshFeed();
    await this.#process();
    await this.#advance();
  }

  async #refreshFeed(): Promise<void> {
    const t = this.#now();
    const url = t.getTime() - this.#lastUrl >= (this.d.intervalMs ?? SIX_HOURS) ? this.d.feedUrl : null;
    const file =
      t.getTime() - this.#lastFile >= (this.d.fileIntervalMs ?? FIVE_MINUTES) ? this.d.feedFile : null;
    if (url === null && file === null) return;
    const found: { doc: SignedDocument; feed: WorkerReleaseFeed; keyId: string }[] = [];
    const problems: string[] = [];
    const take = (doc: SignedDocument) => {
      const v = verifyWorkerReleaseFeed(doc.bytes, doc.signature, this.d.releaseKeys);
      if (v.ok) found.push({ doc, feed: v.feed, keyId: v.keyId });
      else problems.push(v.reason);
    };
    if (file !== null) {
      this.#lastFile = t.getTime();
      try {
        const doc = await readSignedFile(file, 'feed.sig.json', MAX_WORKER_FEED_BYTES);
        if (doc !== null) take(doc);
      } catch (err) {
        problems.push(err instanceof SourceError ? err.code : 'unreadable');
      }
    }
    if (url !== null) {
      this.#lastUrl = t.getTime();
      try {
        take(await fetchSigned(url, 'feed.sig.json', MAX_WORKER_FEED_BYTES, this.d.fetch));
      } catch (err) {
        problems.push(err instanceof SourceError ? err.code : 'unreachable');
      }
    }
    found.sort((a, b) => b.feed.generatedAt.localeCompare(a.feed.generatedAt));
    const best = found[0];
    const keep =
      best !== undefined && (this.#feed === null || best.feed.generatedAt >= this.#feed.generatedAt);
    if (keep) this.#feed = best.feed;
    await this.d.pool.query(
      `UPDATE update_channel_feed SET checked_at = $1, error = $2
         ${keep ? ', feed = $3, signature = $4, key_id = $5, source = $6, generated_at = $7' : ''}
        WHERE id = 1`,
      keep
        ? [
            t,
            problems[0] ?? null,
            best.doc.bytes,
            JSON.stringify(best.doc.signature),
            best.keyId,
            best.doc.source,
            new Date(best.feed.generatedAt),
          ]
        : [t, problems[0] ?? null],
    );
  }

  async #stableVersion(q: Queryable = this.d.pool): Promise<string | null> {
    const { rows } = await q.query<{ version: string }>(
      "SELECT version FROM worker_release_channels WHERE channel = 'stable'",
    );
    return rows[0]?.version ?? null;
  }

  /** Feed releases of the stable channel, newest first. */
  #feedReleases(): WorkerFeedRelease[] {
    const f = this.#feed;
    if (f === null) return [];
    return f.releases
      .filter((r) => r.channel === 'stable')
      .sort((a, b) => compareReleaseVersions(b.version, a.version));
  }

  async #process(): Promise<void> {
    const list = this.#feedReleases();
    if (list.length === 0) return;
    const now = this.#now();
    const stable = await this.#stableVersion();
    for (const r of list) {
      await this.d.pool.query(
        `INSERT INTO update_channel_releases (version, bump, state, first_seen_at, updated_at)
         VALUES ($1, $2, 'available', $3, $3)
         ON CONFLICT (version) DO UPDATE SET bump = EXCLUDED.bump
           WHERE update_channel_releases.state IN ('available', 'imported', 'awaiting_approval', 'import_failed')`,
        [r.version, releaseBump(stable, r.version), now],
      );
    }
    const newest = list[0];
    if (newest === undefined) return;
    // Older releases that never started are superseded by the newest.
    await this.d.pool.query(
      `UPDATE update_channel_releases SET state = 'skipped', updated_at = $2
        WHERE version <> $1 AND state IN ('available', 'imported', 'awaiting_approval', 'import_failed')`,
      [newest.version, now],
    );
    if (stable !== null && compareReleaseVersions(newest.version, stable) <= 0) {
      await this.#setState(newest.version, 'done', null);
      return;
    }
    const row = await this.#releaseRow(newest.version);
    if (row?.state === 'rolling_out' || row?.state === 'done' || row?.state === 'canary_failed') return;
    if (!(await this.#imported(newest.version))) {
      const retry = this.d.retryMs ?? SIX_HOURS;
      if (
        row?.state === 'import_failed' &&
        row.attempted_at !== null &&
        now.getTime() - row.attempted_at.getTime() < retry
      )
        return;
      const ok = await this.#import(newest).then(
        () => true,
        () => false,
      );
      if (!ok) return;
    }
    const { policy } = await this.settings();
    const bump = releaseBump(stable, newest.version);
    const auto = policy === 'auto' || (policy === 'patch_auto' && bump === 'patch');
    if (auto && bump !== 'prerelease') {
      await this.#start(newest.version, 'policy', null).catch((err: unknown) => {
        this.d.log.error({ err, version: newest.version }, 'automatic rollout could not start');
      });
      return;
    }
    if (row?.state !== 'awaiting_approval') {
      await this.#setState(newest.version, 'awaiting_approval', null);
      await this.#notify(newest.version, `release.update:await:${newest.version}`, {
        severity: 'info',
        title: `Worker ${newest.version} is available`,
        body: `A signed worker release (${bump}) arrived from the update channel and waits for “Güncelle”.`,
      });
    }
  }

  async #releaseRow(
    version: string,
  ): Promise<{ state: ReleaseState; attempted_at: Date | null } | undefined> {
    const { rows } = await this.d.pool.query<{ state: ReleaseState; attempted_at: Date | null }>(
      'SELECT state, attempted_at FROM update_channel_releases WHERE version = $1',
      [version],
    );
    return rows[0];
  }

  async #setState(version: string, state: ReleaseState, error: string | null, q: Queryable = this.d.pool) {
    await q.query(
      `UPDATE update_channel_releases SET state = $2, error = $3, updated_at = $4 WHERE version = $1`,
      [version, state, error, this.#now()],
    );
  }

  async #imported(version: string): Promise<boolean> {
    const { rowCount } = await this.d.pool.query('SELECT 1 FROM worker_releases WHERE version = $1', [
      version,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** Downloads the release's upload document (host cache first, then the release location) and imports it. */
  async #import(entry: WorkerFeedRelease): Promise<void> {
    const now = this.#now();
    await this.d.pool.query('UPDATE update_channel_releases SET attempted_at = $2 WHERE version = $1', [
      entry.version,
      now,
    ]);
    let code: string;
    try {
      const bytes = await this.#bundle(entry);
      checkBundle(bytes, entry.bundle);
      const doc = parseReleaseDocument(bytes);
      const { release } = await publishRelease(this.d.releases, this.d.installers, doc, UPDATE_CHANNEL_ACTOR);
      if (release.version !== entry.version || release.sha256 !== entry.sha256) {
        throw new SourceError('bundle_mismatch', 'the bundle is another release than the feed names');
      }
      await this.d.pool.query(
        `UPDATE update_channel_releases SET state = 'imported', error = NULL, imported_at = $2, updated_at = $2
          WHERE version = $1`,
        [entry.version, now],
      );
      await this.d.audit.record({
        actor: { type: 'system', id: UPDATE_CHANNEL_ACTOR.id },
        action: 'update_channel.import',
        outcome: 'success',
        target: entry.version,
        metadata: { sha256: entry.sha256 },
      });
      return;
    } catch (err) {
      code =
        err instanceof SourceError
          ? err.code
          : err instanceof HttpError
            ? err.code.slice(0, 64)
            : err instanceof AdminError
              ? 'invalid_bundle'
              : 'import_failed';
      this.d.log.warn({ err, version: entry.version, code }, 'update channel import failed');
    }
    await this.#setState(entry.version, 'import_failed', code);
    await this.d.audit.record({
      actor: { type: 'system', id: UPDATE_CHANNEL_ACTOR.id },
      action: 'update_channel.import',
      outcome: 'failure',
      target: entry.version,
      metadata: { reason: code },
    });
    throw new HttpError(
      502,
      'release_import_failed',
      `Release ${entry.version} could not be imported (${code}).`,
      {},
      {},
      {
        version: entry.version,
        reason: code,
      },
    );
  }

  async #bundle(entry: WorkerFeedRelease): Promise<Buffer> {
    if (this.d.feedFile !== null) {
      try {
        const bytes = await readFile(join(dirname(this.d.feedFile), entry.bundle.path));
        if (bytes.byteLength === entry.bundle.size) return bytes;
      } catch {
        // not cached on the host: the release location
      }
    }
    if (this.d.feedUrl === null)
      throw new SourceError('unreachable', 'the bundle is not cached and no URL is set');
    return getBytes(
      new URL(entry.bundle.path, this.d.feedUrl).toString(),
      MAX_RELEASE_BUNDLE_BYTES,
      this.d.fetch,
      120_000,
    );
  }

  // ---------------------------------------------------------------- rollout

  /** "Güncelle": import if needed and roll out (canary first); on an open canary stage: promote to the fleet now. */
  async install(version: string, actor: ActorContext): Promise<UpdateChannelView> {
    await this.#loadFeed();
    const open = await this.#openRollout();
    if (open !== null && open.version === version && open.stage === 'canary') {
      await this.#toFleet(open, actor);
      return this.view();
    }
    const stable = await this.#stableVersion();
    if (stable !== null && compareReleaseVersions(version, stable) <= 0) {
      throw new HttpError(
        409,
        'not_newer',
        `${version} is not newer than the stable channel's ${stable}.`,
        {},
        {},
        {
          version,
          current: stable,
        },
      );
    }
    if (!(await this.#imported(version))) {
      const entry = this.#feedReleases().find((r) => r.version === version);
      if (entry === undefined) {
        throw new HttpError(
          404,
          'release_not_found',
          `Release ${version} is neither stored nor in the feed.`,
          {},
          {},
          {
            version,
          },
        );
      }
      await this.#import(entry);
    }
    await this.#start(version, 'owner', actor);
    return this.view();
  }

  async #openRollout(q: Queryable = this.d.pool): Promise<RolloutRow | null> {
    const { rows } = await q.query<RolloutRow>(
      `SELECT ${ROLLOUT_COLUMNS} FROM update_channel_rollouts WHERE stage IN ('canary', 'fleet') LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /** Clears the targets a rollout set (only those still pointing at its version and set by the system). */
  async #clearTargets(q: Queryable, r: Pick<RolloutRow, 'version' | 'canary_workers'>): Promise<void> {
    if (r.canary_workers.length === 0) return;
    await q.query(
      `UPDATE worker_update_targets SET target_version = NULL, rollback = false, force = false, requested_at = $3
        WHERE worker_id = ANY($1::text[]) AND target_version = $2 AND requested_by IS NULL`,
      [r.canary_workers, r.version, this.#now()],
    );
  }

  async #start(version: string, trigger: 'policy' | 'owner', actor: ActorContext | null): Promise<void> {
    const now = this.#now();
    const who: ReleaseActor = actor ?? UPDATE_CHANNEL_ACTOR;
    const result = await withTransaction(this.d.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('remyral-update-channel'))");
      const open = await this.#openRollout(tx);
      if (open !== null) {
        if (open.version === version) return { canary: [] as string[], rolloutId: open.id, already: true };
        await this.#clearTargets(tx, open);
        await tx.query(
          `UPDATE update_channel_rollouts SET stage = 'superseded', stage_at = $2, finished_at = $2, reason = 'superseded'
            WHERE id = $1`,
          [open.id, now],
        );
        await this.#audit(tx, who, 'update_channel.rollout.superseded', open.version, { by: version });
      }
      const { rows } = await tx.query<{ id: string }>(
        `SELECT w.id FROM workers w
           LEFT JOIN worker_runtime_policies p ON p.worker_id = w.id
           LEFT JOIN worker_update_targets t ON t.worker_id = w.id
          WHERE w.revoked_at IS NULL AND w.archived_at IS NULL AND w.state NOT IN ('pending', 'quarantined')
            AND (COALESCE(p.canary, false) OR t.channel = 'canary') AND t.target_version IS NULL
          ORDER BY w.id`,
      );
      const canary = rows.map((r) => r.id);
      const id = randomUUID();
      await tx.query(
        `INSERT INTO update_channel_rollouts (id, version, stage, canary_workers, started_by, trigger, started_at, stage_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          id,
          version,
          canary.length > 0 ? 'canary' : 'fleet',
          JSON.stringify(canary),
          actor?.userId ?? null,
          trigger,
          now,
        ],
      );
      for (const w of canary) {
        await tx.query(
          `INSERT INTO worker_update_targets (worker_id, channel, target_version, rollback, force, requested_at, requested_by)
           VALUES ($1, 'stable', $2, false, false, $3, NULL)
           ON CONFLICT (worker_id) DO UPDATE SET target_version = EXCLUDED.target_version, rollback = false, force = false,
                  requested_at = EXCLUDED.requested_at, requested_by = NULL`,
          [w, version, now],
        );
      }
      await this.#setState(version, 'rolling_out', null, tx);
      await this.#audit(tx, who, 'update_channel.rollout.started', version, { trigger, canary });
      return { canary, rolloutId: id, already: false };
    });
    if (result.already) return;
    if (result.canary.length === 0) {
      const row = await this.#openRollout();
      if (row !== null) await this.#toFleet(row, actor);
      return;
    }
    for (const w of result.canary) {
      const session = this.d.hub.get(w)?.session;
      if (session === undefined || session === null) continue;
      await this.d.releases.offer(session).catch((err: unknown) => {
        this.d.log.error({ err, workerId: w }, 'canary update offer failed');
      });
    }
  }

  /** Stage 2: the stable channel at 100 %, the canary targets cleared. */
  async #toFleet(r: RolloutRow, actor: ActorContext | null): Promise<void> {
    const who: ReleaseActor = actor ?? UPDATE_CHANNEL_ACTOR;
    await this.d.releases.promote('stable', r.version, 100, who);
    const now = this.#now();
    await withTransaction(this.d.pool, async (tx) => {
      await this.#clearTargets(tx, r);
      await tx.query(
        `UPDATE update_channel_rollouts SET stage = 'done', stage_at = $2::timestamptz, finished_at = $2::timestamptz,
                canary_passed_at = COALESCE(canary_passed_at, CASE WHEN jsonb_array_length(canary_workers) > 0 THEN $2::timestamptz END)
          WHERE id = $1`,
        [r.id, now],
      );
      await this.#setState(r.version, 'done', null, tx);
      await this.#audit(tx, who, 'update_channel.rollout.done', r.version, {
        canary: r.canary_workers.length,
        forced: actor !== null && r.stage === 'canary',
      });
    });
  }

  async #canaryStatus(r: RolloutRow): Promise<{ workerId: string; status: string; at: Date | null }[]> {
    if (r.canary_workers.length === 0) return [];
    const { rows } = await this.d.pool.query<{
      worker_id: string;
      worker_version: string;
      status: string | null;
      at: Date | null;
    }>(
      `SELECT w.id AS worker_id, w.worker_version,
              (SELECT a.status FROM worker_update_attempts a WHERE a.worker_id = w.id AND a.to_version = $2
                  AND a.created_at >= $3 ORDER BY a.created_at DESC LIMIT 1) AS status,
              (SELECT COALESCE(a.finished_at, a.updated_at) FROM worker_update_attempts a WHERE a.worker_id = w.id
                  AND a.to_version = $2 AND a.created_at >= $3 ORDER BY a.created_at DESC LIMIT 1) AS at
         FROM workers w WHERE w.id = ANY($1::text[]) ORDER BY w.id`,
      [r.canary_workers, r.version, r.started_at],
    );
    return rows.map((x) => ({
      workerId: x.worker_id,
      status: x.worker_version === r.version ? 'succeeded' : (x.status ?? 'waiting'),
      at: x.at,
    }));
  }

  async #advance(): Promise<void> {
    const r = await this.#openRollout();
    if (r === null || r.stage !== 'canary') return;
    const now = this.#now();
    const status = await this.#canaryStatus(r);
    const failed = status.filter(
      (s) => s.status === 'failed' || s.status === 'rolled_back' || s.status === 'refused',
    );
    if (failed.length > 0) {
      await withTransaction(this.d.pool, async (tx) => {
        await this.#clearTargets(tx, r);
        await tx.query(
          `UPDATE update_channel_rollouts SET stage = 'canary_failed', stage_at = $2, finished_at = $2, reason = $3
            WHERE id = $1`,
          [r.id, now, failed[0]?.status ?? 'failed'],
        );
        await this.#setState(r.version, 'canary_failed', failed[0]?.status ?? 'failed', tx);
        await this.#audit(tx, UPDATE_CHANNEL_ACTOR, 'update_channel.rollout.canary_failed', r.version, {
          workers: failed.map((f) => f.workerId),
        });
      });
      await this.#notify(r.version, `release.update:canary:${r.version}`, {
        severity: 'warning',
        title: `Worker ${r.version}: the canary update failed`,
        body: `The update failed on ${failed.map((f) => f.workerId).join(', ')}; the rollout stopped and no other machine got it.`,
      });
      return;
    }
    const succeeded = status.filter((s) => s.status === 'succeeded');
    const idle = (s: { status: string }) =>
      s.status === 'waiting' && now.getTime() - r.started_at.getTime() >= CANARY_IDLE_MS;
    const blocking = status.filter((s) => s.status !== 'succeeded' && !idle(s));
    if (succeeded.length === 0 || blocking.length > 0) return;
    const last = Math.max(...succeeded.map((s) => s.at?.getTime() ?? r.started_at.getTime()));
    const { soakMinutes } = await this.settings();
    if (now.getTime() - last < soakMinutes * 60_000) return;
    const held = await this.d.pool.query(
      "SELECT 1 FROM release_rollout_holds WHERE channel = 'stable' AND resolved_at IS NULL",
    );
    if ((held.rowCount ?? 0) > 0) return;
    await this.d.pool.query('UPDATE update_channel_rollouts SET canary_passed_at = $2 WHERE id = $1', [
      r.id,
      now,
    ]);
    await this.#audit(this.d.pool, UPDATE_CHANNEL_ACTOR, 'update_channel.rollout.canary_passed', r.version, {
      workers: succeeded.map((s) => s.workerId),
    });
    await this.#toFleet(r, null);
  }

  async #audit(
    q: Queryable,
    actor: ReleaseActor,
    action: string,
    target: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.d.audit.record({ ...auditIdentity(actor), action, outcome: 'success', target, metadata }, q);
  }

  async #notify(
    version: string,
    dedupeKey: string,
    n: { severity: 'info' | 'warning'; title: string; body: string },
  ): Promise<void> {
    const notifier = this.d.notifications?.() ?? null;
    if (notifier === null) return;
    await notifier
      .notify(this.d.pool, await globalRecipients(this.d.pool, 'admin'), {
        kind: 'release.update',
        severity: n.severity,
        title: n.title,
        body: n.body,
        link: '/settings/releases?tab=channel',
        dedupeKey,
      })
      .catch((err: unknown) => {
        this.d.log.warn({ err, version }, 'update channel notification failed');
      });
  }

  // ---------------------------------------------------------------- view

  async view(): Promise<UpdateChannelView> {
    await this.#loadFeed();
    const { policy, soakMinutes } = await this.settings();
    const f = (await this.d.pool.query<FeedRow>('SELECT * FROM update_channel_feed WHERE id = 1')).rows[0];
    const states = new Map(
      (
        await this.d.pool.query<{
          version: string;
          bump: ReleaseBump;
          state: ReleaseState;
          error: string | null;
        }>('SELECT version, bump, state, error FROM update_channel_releases')
      ).rows.map((r) => [r.version, r]),
    );
    const stored = new Set(
      (await this.d.pool.query<{ version: string }>('SELECT version FROM worker_releases')).rows.map(
        (r) => r.version,
      ),
    );
    const stable = await this.#stableVersion();
    const releases = this.#feedReleases()
      .slice(0, 20)
      .map((r): ChannelReleaseView => {
        const s = states.get(r.version);
        return {
          version: r.version,
          bump: s?.bump ?? releaseBump(stable, r.version),
          state: s?.state ?? 'available',
          error: s?.error ?? null,
          publishedAt: r.publishedAt,
          summary: r.summary,
          notes: r.notes,
          protocolVersions: r.protocolVersions,
          imported: stored.has(r.version),
        };
      });
    const last = (
      await this.d.pool.query<RolloutRow>(
        `SELECT ${ROLLOUT_COLUMNS} FROM update_channel_rollouts
          ORDER BY stage IN ('canary', 'fleet') DESC, started_at DESC, finished_at DESC NULLS FIRST LIMIT 1`,
      )
    ).rows[0];
    const rollout: RolloutView | null =
      last === undefined
        ? null
        : {
            id: last.id,
            version: last.version,
            stage: last.stage,
            trigger: last.trigger,
            startedAt: last.started_at.toISOString(),
            stageAt: last.stage_at.toISOString(),
            finishedAt: last.finished_at?.toISOString() ?? null,
            reason: last.reason,
            canary: (await this.#canaryStatus(last)).map((c) => ({ workerId: c.workerId, status: c.status })),
          };
    return {
      configured: this.configured,
      policy,
      soakMinutes,
      feed: {
        source: f?.source ?? null,
        keyId: f?.key_id ?? null,
        generatedAt: f?.generated_at?.toISOString() ?? null,
        checkedAt: f?.checked_at?.toISOString() ?? null,
        error: f?.error ?? null,
      },
      stableVersion: stable,
      releases,
      rollout,
    };
  }
}
