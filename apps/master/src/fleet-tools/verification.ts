import { randomUUID } from 'node:crypto';
import {
  compareVersions,
  RemoteOpsReport,
  RUNTIME_PINS,
  RUNTIME_UNVERIFIED_FEATURE,
  type RuntimeKind,
  type RuntimeVerifyCheck,
  type RuntimeVerifyReport,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { RemoteOpsService } from '../remote-ops/service.js';
import type { ActorContext } from '../workers/fleet.js';
import { CATALOG } from './catalog.js';
import type { VersionFeedService } from './feed.js';
import { RuntimeReleases } from './releases.js';

/**
 * p16-runtime-updates §3 (docs/design/p16-runtime-updates.md): the automatic verification of runtime versions newer
 * than the worker release's pin. Every hour (self-throttled) and right after a feed refresh changed a runtime's latest
 * version, for each runtime whose feed version is above the pin: resolve the release (exact version document, sha512),
 * pick ONE connected canary machine (`worker_runtime_policies.canary`, `runtime-unverified-v1`, platform supported) and
 * send it `runtime.verify` as the system actor `runtime-verify`. The worker installs the candidate into a scratch dir,
 * runs the automatable checks and removes it again; the result is recorded here.
 *
 * Honest by construction: "passed" means every *required automatable* check passed on that machine — integrity,
 * version, (Claude Code) bundled version, help / loopback server auth, the adapter's probe. A prompt against a model and
 * the contract suite are reported `skipped` by the worker; the version stays `unverified` in capabilities until it is
 * promoted into RUNTIME_PINS by a worker release (scripts/release/promote-runtime-pin.mjs). A pass is final; after a
 * failure or an error the version is tried again after 24 h at the earliest. Only while the security policy allows
 * unverified runtime updates (the check runs upstream code on a machine).
 */

export const VERIFY_ACTOR: ActorContext = { userId: '', ip: '', userAgent: null, system: 'runtime-verify' };
const TICK_MS = 60 * 60_000;
const RETRY_AFTER_MS = 24 * 3600_000;
/** A run without a result for this long is closed as `error` (`lost`). */
const RUN_TIMEOUT_MS = 60 * 60_000;

export interface VerificationRunView {
  readonly id: string;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly os: string | null;
  readonly arch: string | null;
  readonly trigger: 'schedule' | 'feed' | 'manual';
  readonly state: 'running' | 'passed' | 'failed' | 'error';
  readonly checks: readonly RuntimeVerifyCheck[];
  readonly reason: string | null;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface CandidateView {
  readonly runtime: RuntimeKind;
  readonly version: string;
  readonly pin: string;
  readonly package: string;
  readonly packageVersion: string;
  readonly integrity: string;
  readonly resolvedAt: string;
  /** passed = a verified candidate (automatable checks only), ready to be promoted by a worker release. */
  readonly verifyState: 'none' | 'running' | 'passed' | 'failed';
  readonly verifiedAt: string | null;
  readonly lock: { readonly sha256: string; readonly bytes: number; readonly workerId: string | null } | null;
  /** The latest run (null: never run). */
  readonly lastRun: VerificationRunView | null;
}

interface RunRow {
  id: string;
  runtime: string;
  version: string;
  worker_id: string;
  worker_name: string | null;
  op_id: string | null;
  os: string | null;
  arch: string | null;
  trigger: VerificationRunView['trigger'];
  state: VerificationRunView['state'];
  checks: unknown;
  reason: string | null;
  detail: string | null;
  started_at: Date;
  finished_at: Date | null;
}

function runView(r: RunRow): VerificationRunView {
  return {
    id: r.id,
    workerId: r.worker_id,
    workerName: r.worker_name,
    os: r.os,
    arch: r.arch,
    trigger: r.trigger,
    state: r.state,
    checks: Array.isArray(r.checks) ? (r.checks as RuntimeVerifyCheck[]) : [],
    reason: r.reason,
    detail: r.detail,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export interface VerificationDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly releases: RuntimeReleases;
  readonly feed: VersionFeedService;
  readonly remoteOps: () => RemoteOpsService | null;
  readonly connected: (workerId: string) => boolean;
  /** The security policy's `fleet.unverifiedRuntimeUpdates`. */
  readonly allowed: () => Promise<boolean>;
}

export class RuntimeVerificationService {
  #lastTick = 0;
  #running: Promise<number> | null = null;

  constructor(private readonly d: VerificationDeps) {}

  /** Candidates with their latest run, newest first (the console's "Doğrulama adayları"). */
  async candidates(): Promise<CandidateView[]> {
    const list = await this.d.releases.list();
    if (list.length === 0) return [];
    const { rows } = await this.d.pool.query<RunRow>(
      `SELECT DISTINCT ON (v.runtime, v.version) v.id::text AS id, v.runtime, v.version, v.worker_id,
              w.display_name AS worker_name, v.op_id::text AS op_id, v.os, v.arch, v.trigger, v.state, v.checks,
              v.reason, v.detail, v.started_at, v.finished_at
         FROM runtime_verifications v LEFT JOIN workers w ON w.id = v.worker_id
        ORDER BY v.runtime, v.version, v.started_at DESC`,
    );
    return list
      .map((c) => {
        const last = rows.find((r) => r.runtime === c.runtime && r.version === c.version);
        return {
          runtime: c.runtime,
          version: c.version,
          pin: RUNTIME_PINS[c.runtime].version,
          package: c.package,
          packageVersion: c.packageVersion,
          integrity: c.integrity,
          resolvedAt: c.resolvedAt,
          verifyState: c.verifyState,
          verifiedAt: c.verifiedAt,
          lock:
            c.lock === null ? null : { sha256: c.lock.sha256, bytes: c.lock.bytes, workerId: c.lockWorkerId },
          lastRun: last === undefined ? null : runView(last),
        };
      })
      .sort((a, b) => (a.resolvedAt < b.resolvedAt ? 1 : a.resolvedAt > b.resolvedAt ? -1 : 0));
  }

  /** Scheduler step (hourly, self-throttled); `force` after a feed change. Returns how many runs were started. */
  tick(force = false, trigger: 'schedule' | 'feed' = 'schedule'): Promise<number> {
    const now = this.d.clock().getTime();
    if (!force && now - this.#lastTick < TICK_MS) return Promise.resolve(0);
    this.#lastTick = now;
    this.#running ??= this.#tick(trigger).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #tick(trigger: 'schedule' | 'feed'): Promise<number> {
    await this.#closeStale();
    if (!(await this.d.allowed().catch(() => false))) return 0;
    if (!this.d.releases.enabled) return 0;
    const feed = await this.d.feed.rows();
    let started = 0;
    for (const entry of CATALOG) {
      if (entry.runtime === undefined) continue;
      const latest = feed.get(entry.id)?.latest ?? null;
      if (latest === null) continue;
      if ((compareVersions(latest, RUNTIME_PINS[entry.runtime].version) ?? 0) <= 0) continue;
      try {
        if (await this.#due(entry.runtime, latest)) {
          const r = await this.#start(entry.runtime, latest, trigger, null);
          if (r !== null) started += 1;
        }
      } catch (err) {
        this.d.log.warn({ err, runtime: entry.runtime, version: latest }, 'runtime verification not started');
      }
    }
    return started;
  }

  /** A version is due unless it passed, a run is open, or a run finished within the last 24 h. */
  async #due(runtime: RuntimeKind, version: string): Promise<boolean> {
    const c = await this.d.releases.get(runtime, version);
    if (c?.verifyState === 'passed') return false;
    const { rows } = await this.d.pool.query<{ state: string; started_at: Date; finished_at: Date | null }>(
      `SELECT state, started_at, finished_at FROM runtime_verifications WHERE runtime = $1 AND version = $2
        ORDER BY started_at DESC LIMIT 1`,
      [runtime, version],
    );
    const last = rows[0];
    if (last === undefined) return true;
    if (last.state === 'running') return false;
    return this.d.clock().getTime() - (last.finished_at ?? last.started_at).getTime() >= RETRY_AFTER_MS;
  }

  /** One connected canary machine that can verify `runtime` (name order), or null. */
  async #canary(
    runtime: RuntimeKind,
  ): Promise<{ id: string; os: string | null; arch: string | null } | null> {
    const { rows } = await this.d.pool.query<{
      id: string;
      os: string | null;
      arch: string | null;
      features: unknown;
      remote_ops: unknown;
    }>(
      `SELECT w.id, w.facts->>'os' AS os, w.facts->>'arch' AS arch, w.features, w.remote_ops
         FROM workers w JOIN worker_runtime_policies p ON p.worker_id = w.id
        WHERE p.canary AND w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL
          AND w.state IN ('online', 'busy', 'draining')
        ORDER BY w.display_name, w.id`,
    );
    for (const r of rows) {
      if (!Array.isArray(r.features) || !r.features.includes(RUNTIME_UNVERIFIED_FEATURE)) continue;
      if (!this.d.connected(r.id)) continue;
      const report = RemoteOpsReport.safeParse(r.remote_ops);
      const rt = report.success ? report.data.runtimes.find((x) => x.runtime === runtime) : undefined;
      if (rt === undefined || !rt.supported || rt.unverifiedSupported === false) continue;
      return { id: r.id, os: r.os, arch: r.arch };
    }
    return null;
  }

  async #start(
    runtime: RuntimeKind,
    version: string,
    trigger: 'schedule' | 'feed' | 'manual',
    actor: ActorContext | null,
  ): Promise<{ id: string; workerId: string } | null> {
    const ops = this.d.remoteOps();
    if (ops === null) return null;
    const machine = await this.#canary(runtime);
    if (machine === null) {
      if (trigger === 'manual') {
        throw new HttpError(
          409,
          'no_canary_machine',
          'No connected canary machine can verify this runtime (mark one as canary in its runtime policy; it needs a worker build with runtime-unverified-v1).',
          {},
          {},
          { reason: 'runtime_verify' },
        );
      }
      this.d.log.info({ runtime, version }, 'no canary machine for the runtime verification');
      return null;
    }
    const candidate = await this.d.releases.resolve(runtime, version);
    const op = await ops.request(
      machine.id,
      { kind: 'runtime.verify', runtime, version, source: RuntimeReleases.source(candidate) },
      VERIFY_ACTOR,
    );
    const id = randomUUID();
    const now = this.d.clock();
    await this.d.pool.query(
      `INSERT INTO runtime_verifications (id, runtime, version, worker_id, op_id, os, arch, trigger, state,
                                          requested_by, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        runtime,
        version,
        machine.id,
        op.id,
        machine.os,
        machine.arch,
        trigger,
        op.state === 'failed' ? 'error' : 'running',
        actor === null || actor.system !== undefined ? null : actor.userId,
        now,
      ],
    );
    if (op.state === 'failed') {
      await this.d.pool.query(
        `UPDATE runtime_verifications SET reason = $2, detail = $3, finished_at = $4 WHERE id = $1`,
        [id, op.reason ?? 'send_failed', op.detail, now],
      );
    } else {
      await this.d.releases.setVerifyState(runtime, version, 'running');
    }
    await this.d.audit.record({
      actor:
        actor === null || actor.system !== undefined
          ? { type: 'system', id: 'runtime-verify' }
          : { type: 'user', id: actor.userId },
      action: 'fleet.runtime.verify',
      target: `runtime:${runtime}@${version}`,
      outcome: op.state === 'failed' ? 'failure' : 'success',
      ...(actor === null || actor.system !== undefined ? {} : { ip: actor.ip, userAgent: actor.userAgent }),
      metadata: { runtime, version, workerId: machine.id, opId: op.id, trigger, runId: id },
    });
    return { id, workerId: machine.id };
  }

  /** "Şimdi doğrula" (admin + step-up): the version (default: the feed's latest) on a canary now. */
  async verifyNow(
    runtime: RuntimeKind,
    version: string | undefined,
    actor: ActorContext,
  ): Promise<{ id: string; workerId: string }> {
    if (!(await this.d.allowed())) {
      throw new HttpError(
        409,
        'unverified_updates_disabled',
        'The security policy does not allow runtime versions outside the release pins (Settings → Security).',
      );
    }
    const v = version ?? (await this.d.feed.rows()).get(runtime)?.latest ?? null;
    if (v === null)
      throw new HttpError(409, 'version_unknown', 'No newer version of this runtime is known yet.');
    if ((compareVersions(v, RUNTIME_PINS[runtime].version) ?? 0) <= 0) {
      throw new HttpError(
        409,
        'version_not_newer',
        `${runtime} ${v} is not newer than the pin ${RUNTIME_PINS[runtime].version}.`,
        {},
        {},
        { runtime, version: v, pin: RUNTIME_PINS[runtime].version },
      );
    }
    const open = await this.d.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM runtime_verifications WHERE runtime = $1 AND version = $2 AND state = 'running'`,
      [runtime, v],
    );
    if (open.rows.length > 0)
      throw new HttpError(409, 'verification_running', 'A verification is already running.');
    const r = await this.#start(runtime, v, 'manual', actor);
    if (r === null)
      throw new HttpError(
        503,
        'unavailable',
        'Remote operations are not available.',
        {},
        {},
        { reason: 'remote_ops' },
      );
    return r;
  }

  /** The result of a `runtime.verify` (terminal OPS_UPDATE). */
  async onResult(input: {
    readonly workerId: string;
    readonly opId: string;
    readonly state: string;
    readonly reason: string | null;
    readonly detail: string | null;
    readonly verify: RuntimeVerifyReport | undefined;
  }): Promise<void> {
    const { rows } = await this.d.pool.query<{ id: string; runtime: string; version: string }>(
      `SELECT id::text AS id, runtime, version FROM runtime_verifications WHERE op_id = $1 AND worker_id = $2`,
      [input.opId, input.workerId],
    );
    const run = rows[0];
    if (run === undefined) return;
    const report = input.verify;
    const state: VerificationRunView['state'] =
      input.state === 'succeeded' && report !== undefined ? (report.passed ? 'passed' : 'failed') : 'error';
    const now = this.d.clock();
    await this.d.pool.query(
      `UPDATE runtime_verifications SET state = $2, checks = $3, reason = $4, detail = $5, finished_at = $6
        WHERE id = $1 AND state = 'running'`,
      [
        run.id,
        state,
        JSON.stringify(report?.checks ?? []),
        state === 'error' ? (input.reason ?? input.state).slice(0, 64) : null,
        input.detail?.slice(0, 500) ?? null,
        now,
      ],
    );
    if (report?.lock !== undefined) {
      await this.d.releases.storeLock(run.runtime, run.version, input.workerId, report.lock);
    }
    await this.d.releases.setVerifyState(
      run.runtime,
      run.version,
      state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : 'none',
    );
    await this.d.audit.record({
      actor: { type: 'worker', id: input.workerId },
      action: 'fleet.runtime.verify.done',
      target: `runtime:${run.runtime}@${run.version}`,
      outcome: state === 'passed' ? 'success' : 'failure',
      metadata: {
        runId: run.id,
        state,
        ...(report === undefined
          ? { reason: input.reason ?? input.state }
          : {
              failed: report.checks.filter((c) => c.status === 'failed').map((c) => c.id),
              skipped: report.checks.filter((c) => c.status === 'skipped').map((c) => c.id),
            }),
      },
    });
  }

  /** Runs whose operation ended without a result (lost, refused before the report) or took too long. */
  async #closeStale(): Promise<void> {
    const { rows } = await this.d.pool.query<{
      id: string;
      runtime: string;
      version: string;
      worker_id: string;
      op_id: string | null;
      started_at: Date;
    }>(
      `SELECT id::text AS id, runtime, version, worker_id, op_id::text AS op_id, started_at FROM runtime_verifications
        WHERE state = 'running'`,
    );
    const ops = this.d.remoteOps();
    const now = this.d.clock();
    for (const r of rows) {
      let reason: string | null = null;
      if (r.op_id !== null && ops !== null) {
        const op = await ops.op(r.worker_id, r.op_id).catch(() => null);
        if (op !== null && ['failed', 'refused', 'cancelled', 'lost'].includes(op.state)) {
          reason = op.reason ?? op.state;
        }
      }
      if (reason === null && now.getTime() - r.started_at.getTime() > RUN_TIMEOUT_MS) reason = 'timeout';
      if (reason === null) continue;
      await this.d.pool.query(
        `UPDATE runtime_verifications SET state = 'error', reason = $2, finished_at = $3 WHERE id = $1 AND state = 'running'`,
        [r.id, reason.slice(0, 64), now],
      );
      await this.d.releases.setVerifyState(r.runtime, r.version, 'none');
    }
  }
}
