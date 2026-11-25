import { compareReleaseVersions, type ReleaseChannel, ReleaseVersion } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import type { RolloutSettings } from '../security-policy/model.js';
import type { ActorContext } from '../workers/fleet.js';
import type { ReleaseService } from './service.js';

/**
 * p16-ops-safety §2 (docs/design/p16-ops-safety.md): the worker rollout circuit breaker.
 *
 * For every channel whose version is being rolled out, the machines that took that version through the channel are
 * judged: an update that failed / rolled back / timed out, a crash loop (≥ 4 sessions within the watch window after
 * the update) or a heartbeat lost within the watch window count as failing; their job failure rate after the update is
 * compared with the same machines' rate in the 7 days before. Crossing the owner's thresholds (security policy
 * `rollout`) **holds** the rollout: no further machine is offered the version (ReleaseService.offer), the percentage
 * cannot be raised (ReleaseService.promote answers `rollout_paused`), the open offers are withdrawn, admins are
 * notified, the hold is audited and shown with its evidence. It never promotes anything by itself. An admin resumes
 * (the evidence so far is not counted again) or rolls back (the channel points at the previous version again and every
 * machine that runs the held version gets an explicit rollback target).
 */

export type MachineVerdict = 'ok' | 'pending' | 'update_failed' | 'crash_loop' | 'heartbeat_lost';

export interface MachineEvidence {
  readonly workerId: string;
  readonly verdict: MachineVerdict;
  /** The attempt's status / reason (identifiers only). */
  readonly status: string;
  readonly reason: string | null;
  readonly fromVersion: string;
  readonly finishedAt: string | null;
}

export interface JobRates {
  readonly before: { readonly total: number; readonly failed: number };
  readonly after: { readonly total: number; readonly failed: number };
}

export interface BreakerVerdict {
  readonly trip: 'update_failures' | 'job_failures' | null;
  readonly judged: number;
  readonly failing: number;
  readonly pending: number;
  /** Failing share of the judged machines, percent (0 when none judged). */
  readonly failurePercent: number;
  /** Job failure rates in percent (null: no jobs). */
  readonly jobFailurePercent: { readonly before: number | null; readonly after: number | null };
}

const FAILING: ReadonlySet<MachineVerdict> = new Set(['update_failed', 'crash_loop', 'heartbeat_lost']);
const pctOf = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

/** The breaker's decision (pure). */
export function breakerVerdict(
  machines: readonly MachineEvidence[],
  jobs: JobRates,
  s: RolloutSettings,
): BreakerVerdict {
  const judged = machines.filter((m) => m.verdict !== 'pending');
  const failing = judged.filter((m) => FAILING.has(m.verdict)).length;
  const failurePercent = pctOf(failing, judged.length) ?? 0;
  const before = pctOf(jobs.before.failed, jobs.before.total);
  const after = pctOf(jobs.after.failed, jobs.after.total);
  let trip: BreakerVerdict['trip'] = null;
  if (s.breaker && failing >= s.minFailures && failurePercent >= s.failurePercent) trip = 'update_failures';
  else if (
    s.breaker &&
    jobs.after.total >= s.minJobs &&
    after !== null &&
    after - (before ?? 0) >= s.jobFailureDelta
  )
    trip = 'job_failures';
  return {
    trip,
    judged: judged.length,
    failing,
    pending: machines.length - judged.length,
    failurePercent,
    jobFailurePercent: { before, after },
  };
}

export interface HoldView {
  readonly id: string;
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly rolloutPercent: number;
  readonly previousVersion: string | null;
  readonly reason: 'update_failures' | 'job_failures' | 'manual';
  readonly evidence: Record<string, unknown>;
  readonly trippedAt: string;
  readonly trippedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolution: 'resumed' | 'rolled_back' | 'superseded' | null;
}

export interface ChannelBreakerView {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly rolloutPercent: number;
  readonly hold: HoldView | null;
  readonly verdict: BreakerVerdict;
  readonly machines: readonly MachineEvidence[];
  readonly jobs: JobRates;
}

export interface RolloutBreakerDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly releases: ReleaseService;
  readonly settings: () => Promise<RolloutSettings>;
  readonly connected: (workerId: string) => boolean;
  readonly notifications: () => NotificationService | null;
  readonly log?: FastifyBaseLogger;
}

/** Sessions within the watch window after an update that make it a crash loop. */
export const CRASH_LOOP_SESSIONS = 4;
/** A machine silent this long while disconnected counts as having lost its heartbeat. */
const SILENT_MS = 2 * 60_000;
const BEFORE_WINDOW_MS = 7 * 86_400_000;

interface HoldRow {
  id: string;
  channel: ReleaseChannel;
  version: string;
  rollout_percent: number;
  previous_version: string | null;
  reason: HoldView['reason'];
  evidence: Record<string, unknown>;
  tripped_at: Date;
  tripped_by: string | null;
  resolved_at: Date | null;
  resolution: HoldView['resolution'];
}

const HOLD_COLS = `id::text AS id, channel, version, rollout_percent, previous_version, reason, evidence, tripped_at,
  tripped_by::text AS tripped_by, resolved_at, resolution`;

function holdView(r: HoldRow): HoldView {
  return {
    id: r.id,
    channel: r.channel,
    version: r.version,
    rolloutPercent: r.rollout_percent,
    previousVersion: r.previous_version,
    reason: r.reason,
    evidence: r.evidence,
    trippedAt: r.tripped_at.toISOString(),
    trippedBy: r.tripped_by,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    resolution: r.resolution,
  };
}

export class RolloutBreaker {
  #running: Promise<HoldView[]> | null = null;

  constructor(private readonly deps: RolloutBreakerDeps) {}

  /** Evaluates every rolling channel; trips the ones over the thresholds. One pass at a time (calls coalesce). */
  evaluate(): Promise<HoldView[]> {
    this.#running ??= this.#evaluate().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #evaluate(): Promise<HoldView[]> {
    const settings = await this.deps.settings();
    if (!settings.breaker) return [];
    const tripped: HoldView[] = [];
    for (const c of await this.#channels()) {
      if (c.hold !== null || c.rollout_percent === 0) continue;
      const { machines, jobs } = await this.#evidence(this.deps.pool, c.channel, c.version, settings);
      const verdict = breakerVerdict(machines, jobs, settings);
      if (verdict.trip === null) continue;
      const hold = await this.#trip(c.channel, c.version, c.rollout_percent, verdict, machines, jobs, null);
      if (hold !== null) tripped.push(hold);
    }
    return tripped;
  }

  async #channels(): Promise<
    { channel: ReleaseChannel; version: string; rollout_percent: number; hold: HoldRow | null }[]
  > {
    const { rows } = await this.deps.pool.query<{
      channel: ReleaseChannel;
      version: string;
      rollout_percent: number;
    }>('SELECT channel, version, rollout_percent FROM worker_release_channels ORDER BY channel');
    const holds = await this.deps.pool.query<HoldRow>(
      `SELECT ${HOLD_COLS} FROM release_rollout_holds WHERE resolved_at IS NULL`,
    );
    return rows.map((r) => ({ ...r, hold: holds.rows.find((h) => h.channel === r.channel) ?? null }));
  }

  /** The machines that took `version` through `channel` since the last resolved hold of it, judged; their jobs. */
  async #evidence(
    db: Queryable,
    channel: ReleaseChannel,
    version: string,
    s: RolloutSettings,
  ): Promise<{ machines: MachineEvidence[]; jobs: JobRates }> {
    const now = this.deps.clock();
    const since = await db.query<{ at: Date | null }>(
      `SELECT max(resolved_at) AS at FROM release_rollout_holds
        WHERE channel = $1 AND version = $2 AND resolution = 'resumed'`,
      [channel, version],
    );
    const from = since.rows[0]?.at ?? new Date(0);
    const { rows } = await db.query<{
      worker_id: string;
      status: string;
      reason: string | null;
      from_version: string;
      finished_at: Date | null;
      updated_at: Date;
      last_seen_at: Date | null;
    }>(
      `SELECT DISTINCT ON (a.worker_id) a.worker_id, a.status, a.reason, a.from_version, a.finished_at, a.updated_at,
              w.last_seen_at
         FROM worker_update_attempts a
         JOIN workers w ON w.id = a.worker_id
         LEFT JOIN worker_update_targets t ON t.worker_id = a.worker_id
        WHERE a.to_version = $1 AND a.source = 'channel' AND a.created_at >= $2
          AND COALESCE(t.channel, 'stable') = $3 AND a.status <> 'superseded'
        ORDER BY a.worker_id, a.created_at DESC`,
      [version, from, channel],
    );
    const watchMs = s.watchMinutes * 60_000;
    const machines: MachineEvidence[] = [];
    const succeeded: { workerId: string; at: Date }[] = [];
    for (const r of rows) {
      let verdict: MachineVerdict;
      if (r.status === 'failed' || r.status === 'rolled_back' || r.status === 'timed_out')
        verdict = 'update_failed';
      else if (r.status !== 'succeeded') verdict = 'pending';
      else {
        const at = r.finished_at ?? r.updated_at;
        succeeded.push({ workerId: r.worker_id, at });
        const sessions = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_events
            WHERE action = 'worker.session.start' AND target = $1 AND occurred_at >= $2 AND occurred_at <= $3`,
          [r.worker_id, at, new Date(at.getTime() + watchMs)],
        );
        const seen = r.last_seen_at;
        const silent =
          !this.deps.connected(r.worker_id) &&
          (seen === null || now.getTime() - seen.getTime() >= SILENT_MS) &&
          (seen === null || seen.getTime() <= at.getTime() + watchMs);
        verdict =
          (sessions.rows[0]?.n ?? 0) >= CRASH_LOOP_SESSIONS ? 'crash_loop' : silent ? 'heartbeat_lost' : 'ok';
      }
      machines.push({
        workerId: r.worker_id,
        verdict,
        status: r.status,
        reason: r.reason,
        fromVersion: r.from_version,
        finishedAt: r.finished_at?.toISOString() ?? null,
      });
    }
    const jobs: JobRates = { before: { total: 0, failed: 0 }, after: { total: 0, failed: 0 } };
    if (succeeded.length > 0) {
      const { rows: j } = await db.query<{ after: boolean; total: number; failed: number }>(
        `SELECT (ja.started_at >= u.at) AS after, count(*)::int AS total,
                count(*) FILTER (WHERE ja.outcome = 'failed')::int AS failed
           FROM unnest($1::text[], $2::timestamptz[]) AS u(worker_id, at)
           JOIN job_attempts ja ON ja.worker_id = u.worker_id
          WHERE ja.state = 'ended' AND ja.outcome IN ('succeeded', 'failed')
            AND ja.started_at >= u.at - make_interval(secs => $3::double precision / 1000)
          GROUP BY 1`,
        [succeeded.map((x) => x.workerId), succeeded.map((x) => x.at), BEFORE_WINDOW_MS],
      );
      for (const r of j) {
        const slot = r.after ? jobs.after : jobs.before;
        (slot as { total: number }).total = r.total;
        (slot as { failed: number }).failed = r.failed;
      }
    }
    return { machines, jobs };
  }

  /** The version the machines came from (the most common registered, lower version) — the rollback target. */
  async #previousVersion(
    db: Queryable,
    machines: readonly MachineEvidence[],
    version: string,
  ): Promise<string | null> {
    const counts = new Map<string, number>();
    for (const m of machines) {
      if (!ReleaseVersion.safeParse(m.fromVersion).success) continue;
      if (compareReleaseVersions(m.fromVersion, version) >= 0) continue;
      counts.set(m.fromVersion, (counts.get(m.fromVersion) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareReleaseVersions(b[0], a[0]));
    for (const [v] of ranked) {
      const r = await db.query('SELECT 1 FROM worker_releases WHERE version = $1', [v]);
      if ((r.rowCount ?? 0) > 0) return v;
    }
    // No machine reported one: the newest registered release below the held version.
    const { rows } = await db.query<{ version: string }>('SELECT version FROM worker_releases');
    const lower = rows
      .map((r) => r.version)
      .filter((v) => ReleaseVersion.safeParse(v).success && compareReleaseVersions(v, version) < 0)
      .sort((a, b) => compareReleaseVersions(b, a));
    return lower[0] ?? null;
  }

  async #trip(
    channel: ReleaseChannel,
    version: string,
    percent: number,
    verdict: BreakerVerdict | null,
    machines: readonly MachineEvidence[],
    jobs: JobRates,
    actor: ActorContext | null,
  ): Promise<HoldView | null> {
    const now = this.deps.clock();
    const reason: HoldView['reason'] = verdict?.trip ?? 'manual';
    const hold = await withTransaction(this.deps.pool, async (tx) => {
      const previous = await this.#previousVersion(tx, machines, version);
      const evidence = {
        ...(verdict === null
          ? {}
          : {
              judged: verdict.judged,
              failing: verdict.failing,
              pending: verdict.pending,
              failurePercent: verdict.failurePercent,
              jobFailurePercent: verdict.jobFailurePercent,
            }),
        jobs,
        machines: machines
          .filter((m) => m.verdict !== 'ok' && m.verdict !== 'pending')
          .slice(0, 50)
          .map((m) => ({ workerId: m.workerId, verdict: m.verdict, status: m.status, reason: m.reason })),
      };
      const ins = await tx.query<HoldRow>(
        `INSERT INTO release_rollout_holds (channel, version, rollout_percent, previous_version, reason, evidence,
                                            tripped_at, tripped_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (channel) WHERE resolved_at IS NULL DO NOTHING
         RETURNING ${HOLD_COLS}`,
        [channel, version, percent, previous, reason, JSON.stringify(evidence), now, actor?.userId ?? null],
      );
      const row = ins.rows[0];
      if (row === undefined) return null;
      // Offers not yet being installed are withdrawn (an activating update finishes and is judged).
      const withdrawn = await tx.query(
        `UPDATE worker_update_attempts SET status = 'superseded', token_hash = NULL, token_expires_at = NULL,
                updated_at = $2, finished_at = $2
          WHERE to_version = $1 AND source = 'channel' AND status IN ('offered', 'downloading', 'deferred')`,
        [version, now],
      );
      await this.deps.audit.record(
        {
          actor:
            actor === null ? { type: 'system', id: 'rollout-breaker' } : { type: 'user', id: actor.userId },
          action: 'release.rollout.paused',
          outcome: 'success',
          target: version,
          ip: actor?.ip ?? null,
          userAgent: actor?.userAgent ?? null,
          metadata: {
            channel,
            holdId: row.id,
            reason,
            rolloutPercent: percent,
            previousVersion: previous,
            withdrawnOffers: withdrawn.rowCount ?? 0,
            failing: verdict?.failing ?? null,
            judged: verdict?.judged ?? null,
          },
        },
        tx,
      );
      const n = this.deps.notifications();
      if (n !== null) {
        const why =
          reason === 'update_failures'
            ? `${String(verdict?.failing ?? 0)} of ${String(verdict?.judged ?? 0)} updated machines failed (${String(verdict?.failurePercent ?? 0)} %)`
            : reason === 'job_failures'
              ? `the job failure rate on updated machines rose from ${String(verdict?.jobFailurePercent.before ?? 0)} % to ${String(verdict?.jobFailurePercent.after ?? 0)} %`
              : 'an administrator paused it';
        await n.notify(tx, await globalRecipients(tx, 'admin'), {
          kind: 'release.rollout_paused',
          severity: 'critical',
          title: `Worker rollout ${version} on ${channel} paused`,
          body: `The rollout of worker ${version} on the ${channel} channel was held at ${String(percent)} %: ${why}. No further machine is updated until an administrator resumes or rolls back (Settings → Worker releases).`,
          link: '/settings/releases',
          dedupeKey: `release.rollout_paused:${row.id}`,
        });
      }
      return holdView(row);
    });
    if (hold !== null)
      this.deps.log?.warn({ channel, version, reason }, 'worker rollout held by the circuit breaker');
    return hold;
  }

  // ------------------------------------------------------------------------------------------------ admin actions

  /** Pauses a channel's rollout by hand (same effect as a trip; reason `manual`). */
  async pause(actor: ActorContext, channel: ReleaseChannel): Promise<HoldView> {
    const c = (await this.#channels()).find((x) => x.channel === channel);
    if (c === undefined) throw new HttpError(404, 'not_found', 'Not found.');
    if (c.hold !== null) return holdView(c.hold);
    const settings = await this.deps.settings();
    const { machines, jobs } = await this.#evidence(this.deps.pool, channel, c.version, settings);
    const hold = await this.#trip(channel, c.version, c.rollout_percent, null, machines, jobs, actor);
    if (hold === null)
      throw new HttpError(
        409,
        'rollout_paused',
        'The rollout is already held.',
        {},
        {},
        { version: c.version, channel },
      );
    return hold;
  }

  async #openHold(db: Queryable, channel: ReleaseChannel): Promise<HoldRow> {
    const { rows } = await db.query<HoldRow>(
      `SELECT ${HOLD_COLS} FROM release_rollout_holds WHERE channel = $1 AND resolved_at IS NULL FOR UPDATE`,
      [channel],
    );
    const row = rows[0];
    if (row === undefined) throw new HttpError(409, 'rollout_not_paused', 'This rollout is not held.');
    return row;
  }

  /** Resumes a held rollout: offers continue; the evidence so far is not counted again. */
  async resume(actor: ActorContext, channel: ReleaseChannel): Promise<HoldView> {
    const now = this.deps.clock();
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const h = await this.#openHold(tx, channel);
      const { rows } = await tx.query<HoldRow>(
        `UPDATE release_rollout_holds SET resolved_at = $2, resolved_by = $3, resolution = 'resumed' WHERE id = $1
         RETURNING ${HOLD_COLS}`,
        [h.id, now, actor.userId],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'release.rollout.resumed',
          outcome: 'success',
          target: h.version,
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { channel, holdId: h.id, reason: h.reason },
        },
        tx,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('hold vanished');
      return holdView(row);
    });
    await this.deps.releases.offerToConnected();
    return out;
  }

  /**
   * Rolls a held rollout back: the channel points at the previous version again (at the held percentage) and every
   * machine that runs the held version gets an explicit rollback target to the version it updated from (the one its
   * updater retains and the only rollback it accepts) — the channel's previous version when that is unknown.
   */
  async rollback(
    actor: ActorContext,
    channel: ReleaseChannel,
  ): Promise<{ hold: HoldView; channelVersion: string; machines: string[] }> {
    const now = this.deps.clock();
    const open = await withTransaction(this.deps.pool, (tx) => this.#openHold(tx, channel));
    if (open.previous_version === null) {
      throw new HttpError(
        409,
        'rollback_target_unknown',
        'No earlier release is known for this rollout; roll machines back one by one.',
      );
    }
    const previous = open.previous_version;
    // The channel first: if it cannot point at the previous version (e.g. a canary-only build on stable), the hold
    // stays as it was. Promoting another version supersedes the hold; it is then recorded as rolled back.
    await this.deps.releases.promote(channel, previous, open.rollout_percent, actor);
    const resolved = await this.deps.pool.query<HoldRow>(
      `UPDATE release_rollout_holds SET resolved_at = COALESCE(resolved_at, $2), resolved_by = $3,
              resolution = 'rolled_back'
        WHERE id = $1 RETURNING ${HOLD_COLS}`,
      [open.id, now, actor.userId],
    );
    const held = resolved.rows[0];
    if (held === undefined) throw new Error('hold vanished');
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT w.id FROM workers w LEFT JOIN worker_update_targets t ON t.worker_id = w.id
        WHERE w.worker_version = $1 AND COALESCE(t.channel, 'stable') = $2
          AND w.state NOT IN ('pending', 'quarantined') ORDER BY w.id`,
      [held.version, channel],
    );
    const machines: string[] = [];
    for (const r of rows) {
      try {
        // A worker accepts a rollback only to the version it ran before (its retained previous version): a machine that
        // skipped the channel's previous version is sent back to the version it came from, when that release is known.
        const own = await this.deps.pool.query<{ from_version: string }>(
          `SELECT a.from_version FROM worker_update_attempts a
             JOIN worker_releases rel ON rel.version = a.from_version
            WHERE a.worker_id = $1 AND a.to_version = $2 AND a.status = 'succeeded' AND a.from_version <> $2
            ORDER BY a.finished_at DESC NULLS LAST, a.updated_at DESC LIMIT 1`,
          [r.id, held.version],
        );
        const version = own.rows[0]?.from_version ?? previous;
        await this.deps.releases.target(r.id, { version, rollback: true }, actor);
        machines.push(r.id);
      } catch (err) {
        this.deps.log?.error({ err, workerId: r.id }, 'rollback target failed');
      }
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'release.rollout.rolled_back',
      outcome: 'success',
      target: held.version,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { channel, holdId: held.id, to: previous, machines: machines.length },
    });
    return { hold: holdView(held), channelVersion: previous, machines };
  }

  // ------------------------------------------------------------------------------------------------ reading

  async status(): Promise<{ settings: RolloutSettings; channels: ChannelBreakerView[]; recent: HoldView[] }> {
    const settings = await this.deps.settings();
    const channels: ChannelBreakerView[] = [];
    for (const c of await this.#channels()) {
      const { machines, jobs } = await this.#evidence(this.deps.pool, c.channel, c.version, settings);
      channels.push({
        channel: c.channel,
        version: c.version,
        rolloutPercent: c.rollout_percent,
        hold: c.hold === null ? null : holdView(c.hold),
        verdict: breakerVerdict(machines, jobs, settings),
        machines: machines.slice(0, 100),
        jobs,
      });
    }
    const recent = await this.deps.pool.query<HoldRow>(
      `SELECT ${HOLD_COLS} FROM release_rollout_holds ORDER BY tripped_at DESC LIMIT 20`,
    );
    return { settings, channels, recent: recent.rows.map(holdView) };
  }
}
