import {
  type AssignedVerifiedCapabilities,
  Capability,
  DEFAULT_VERIFICATION_BUDGET,
  RUNTIME_CAPABILITY_VERIFY_FEATURE,
  RuntimeKind,
  type SignedCapabilityEvidence,
  VERIFICATION_ESTIMATE,
  type VerificationKey,
  verificationKeyId,
  verifyCapabilityEvidence,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { OpView, RemoteOpsService } from '../remote-ops/service.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';
import {
  type EffectiveCapability,
  cachedVerifiedIndex,
  effectiveCapabilities,
  invalidateVerifiedIndex,
  keyOf,
  loadVerifiedIndex,
  type ReportedRuntime,
  type VerifiedIndex,
  verifiedList,
} from './overlay.js';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md): "Doğrula" on Makine → Runtime’lar and what follows.
 *
 *  - `start`: owner / admin with step-up (route), only on workers advertising `runtime-capability-verify-v1`, only for
 *    the installed version, one open run per (machine, runtime), at most {@link RUN_LIMIT} runs per (machine, runtime)
 *    per hour; audited (`runtime.capabilities.verify.start`) and sent as the signed OPS_COMMAND through remote ops
 *    (audited there as `worker.ops.runtime.capabilities.verify`, rate-limited per worker as a heavy op).
 *  - `onVerifyUpdate`: the final OPS_UPDATE carries evidence signed by the device key. It is stored only when the
 *    signature verifies with the key of the session that sent it, names that worker and that operation, and the tuple
 *    is the one the operation asked for; anything else is audited as refused and dropped.
 *  - reads: the machine's runtimes with reported / declared / effective status per capability, the last run of the
 *    tuple (fleet-wide), the machine's history, the platforms view, the policy dependence count, the catalog marks.
 */

/** Runs per (machine, runtime) and hour. */
export const RUN_LIMIT = { max: 4, windowMs: 60 * 60_000 };
/** Capabilities every job needs (placement / the worker gate, approval unless the job never asks). */
const REQUIRED: readonly Capability[] = ['streaming', 'cancel', 'approval'];
const OPEN_STATES = ['sent', 'accepted', 'running', 'waiting_for_user'];

export interface EvidenceRun {
  readonly id: string;
  readonly workerId: string;
  readonly machine: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly platform: string;
  readonly workerVersion: string;
  readonly authMode: string;
  readonly sandboxProfile: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly stoppedBy: string | null;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly {
    readonly capability: string;
    readonly status: string;
    readonly reason: string;
    readonly durationMs: number;
  }[];
}

export interface RuntimeVerificationView {
  readonly runtime: string;
  readonly version: string;
  readonly platform: string | null;
  readonly adapterVersion: string | null;
  /** `verified`: every capability the adapter declares supported / degraded is proven (or reported so already). */
  readonly state: 'verified' | 'partial' | 'unverified' | 'not_applicable';
  readonly capabilities: readonly EffectiveCapability[];
  /** The latest run of exactly this tuple (any machine of the platform). */
  readonly lastRun: EvidenceRun | null;
  /** Runs of this machine for this runtime (any version), newest first. */
  readonly history: readonly (EvidenceRun & { readonly applies: boolean })[];
  readonly running: { readonly opId: string; readonly state: string } | null;
  readonly estimate: {
    readonly tokens: number;
    readonly durationSec: number;
    readonly maxTokens: number;
    readonly maxDurationSec: number;
  };
}

export interface WorkerVerificationView {
  readonly workerId: string;
  /** The worker advertises `runtime-capability-verify-v1` (otherwise: no button, "update the machine"). */
  readonly supported: boolean;
  readonly connected: boolean;
  /** How the machine's jobs authenticate each runtime (what a run spends: subscription quota or the API key). */
  readonly runtimes: readonly (RuntimeVerificationView & { readonly authMode: string | null })[];
}

interface RunRow {
  id: string;
  worker_id: string;
  machine: string;
  runtime: string;
  runtime_version: string;
  adapter_version: string;
  os: string;
  arch: string;
  worker_version: string;
  auth_mode: string;
  sandbox_profile: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | null;
  stopped_by: string | null;
  passed: number;
  failed: number;
  results: EvidenceRun['results'];
}

const RUN_COLUMNS = `e.id::text AS id, e.worker_id, COALESCE(w.display_name, e.worker_id) AS machine, e.runtime,
  e.runtime_version, e.adapter_version, e.os, e.arch, e.worker_version, e.auth_mode, e.sandbox_profile, e.started_at,
  e.finished_at, e.duration_ms, e.input_tokens, e.output_tokens, e.cost_usd::text AS cost_usd, e.stopped_by, e.passed,
  e.failed, e.results`;

function run(r: RunRow): EvidenceRun {
  return {
    id: r.id,
    workerId: r.worker_id,
    machine: r.machine,
    runtime: r.runtime,
    runtimeVersion: r.runtime_version,
    adapterVersion: r.adapter_version,
    platform: `${r.os}-${r.arch}`,
    workerVersion: r.worker_version,
    authMode: r.auth_mode,
    sandboxProfile: r.sandbox_profile,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at.toISOString(),
    durationMs: Number(r.duration_ms),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    stoppedBy: r.stopped_by,
    passed: r.passed,
    failed: r.failed,
    results: r.results,
  };
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

function actorOf(actor: ActorContext): { type: 'user' | 'system'; id: string } {
  return actor.system === undefined
    ? { type: 'user', id: actor.userId }
    : { type: 'system', id: actor.system };
}

/** `verified` when every declared supported / degraded capability is effective supported / degraded. */
export function verificationState(caps: readonly EffectiveCapability[]): RuntimeVerificationView['state'] {
  const relevant = caps.filter((c) => c.declared === 'supported' || c.declared === 'degraded');
  if (relevant.length === 0 || caps.every((c) => c.reported === 'unknown')) return 'not_applicable';
  const ok = relevant.filter((c) => c.effective === 'supported' || c.effective === 'degraded');
  if (ok.length === relevant.length) return 'verified';
  return ok.some((c) => c.verified) ? 'partial' : 'unverified';
}

interface WorkerRuntimeRow {
  runtime: string;
  version: string;
  os: string | null;
  arch: string | null;
  adapter_version: string | null;
  evidence_version: string | null;
  declared_capabilities: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
}

function reported(r: WorkerRuntimeRow): ReportedRuntime {
  return {
    runtime: r.runtime,
    version: r.version,
    os: r.os,
    arch: r.arch,
    adapterVersion: r.adapter_version,
    evidenceVersion: r.evidence_version,
    declared: r.declared_capabilities,
    capabilities: r.capabilities,
  };
}

export class CapabilityEvidenceService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly limiter: RateLimiter;
      readonly remoteOps: () => RemoteOpsService;
      readonly connected: (workerId: string) => boolean;
    },
  ) {}

  /** The current verified index (placement, the compatibility matrix, ASSIGN_JOB); cached per pool, see overlay. */
  index(q: Queryable = this.deps.pool): Promise<VerifiedIndex> {
    return q === this.deps.pool ? cachedVerifiedIndex(q) : loadVerifiedIndex(q);
  }

  async #worker(workerId: string): Promise<{ id: string; features: unknown; state: string }> {
    const { rows } = await this.deps.pool.query<{ id: string; features: unknown; state: string }>(
      `SELECT id, features, state FROM workers
        WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw new HttpError(404, 'worker_not_found', 'No such worker.');
    return w;
  }

  async #runtimes(workerId: string): Promise<WorkerRuntimeRow[]> {
    const { rows } = await this.deps.pool.query<WorkerRuntimeRow>(
      `SELECT r.runtime, r.version, w.facts->>'os' AS os, w.facts->>'arch' AS arch, r.adapter_version, r.evidence_version,
              r.declared_capabilities, r.capabilities
         FROM worker_runtimes r JOIN workers w ON w.id = r.worker_id
        WHERE r.worker_id = $1 AND r.present AND r.installed
        ORDER BY r.runtime`,
      [workerId],
    );
    return rows.filter((r) => RuntimeKind.safeParse(r.runtime).success);
  }

  /** Makine → Runtime’lar: per installed runtime, the effective status, the last run, history and a running op. */
  async status(workerId: string): Promise<WorkerVerificationView> {
    const w = await this.#worker(workerId);
    const index = await this.index();
    const runtimes = await this.#runtimes(workerId);
    // The same open set as the ops list (a stale op is `lost`, not "running" forever).
    await this.deps.remoteOps().expire(workerId);
    const { rows: open } = await this.deps.pool.query<{ id: string; runtime: string; state: string }>(
      `SELECT id::text AS id, params->>'runtime' AS runtime, state FROM worker_ops
        WHERE worker_id = $1 AND kind = 'runtime.capabilities.verify' AND state = ANY($2::text[])
        ORDER BY requested_at DESC`,
      [workerId, OPEN_STATES],
    );
    const { rows: auth } = await this.deps.pool.query<{ spec: unknown }>(
      `SELECT cv.spec FROM worker_configs c
         JOIN worker_config_versions cv ON cv.worker_id = c.worker_id AND cv.generation = c.generation
        WHERE c.worker_id = $1`,
      [workerId],
    );
    const authModes = (auth[0]?.spec as { runtimeAuth?: Record<string, { mode?: string }> } | undefined)
      ?.runtimeAuth;
    // Two queries for all runtimes of the machine (not two per runtime): the latest run of each reported tuple
    // (fleet-wide) and the machine's last 10 runs per runtime.
    const keys = runtimes.map((r) => keyOf(reported(r)));
    const tuples = keys.filter((k): k is VerificationKey => k !== null);
    const { rows: lastRows } =
      tuples.length === 0
        ? { rows: [] as RunRow[] }
        : await this.deps.pool.query<RunRow>(
            `SELECT DISTINCT ON (e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version) ${RUN_COLUMNS}
               FROM runtime_capability_evidence e LEFT JOIN workers w ON w.id = e.worker_id
               JOIN unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
                      AS k(runtime, runtime_version, os, arch, adapter_version)
                 ON k.runtime = e.runtime AND k.runtime_version = e.runtime_version AND k.os = e.os
                AND k.arch = e.arch AND k.adapter_version = e.adapter_version
              ORDER BY e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version, e.finished_at DESC`,
            [
              tuples.map((k) => k.runtime),
              tuples.map((k) => k.runtimeVersion),
              tuples.map((k) => k.os),
              tuples.map((k) => k.arch),
              tuples.map((k) => k.adapterVersion),
            ],
          );
    const lastByKey = new Map(
      lastRows.map((h) => [
        verificationKeyId({
          runtime: h.runtime,
          runtimeVersion: h.runtime_version,
          os: h.os,
          arch: h.arch,
          adapterVersion: h.adapter_version,
        }),
        h,
      ]),
    );
    const { rows: histRows } = await this.deps.pool.query<RunRow>(
      `SELECT * FROM (
         SELECT ${RUN_COLUMNS},
                row_number() OVER (PARTITION BY e.runtime ORDER BY e.finished_at DESC) AS n
           FROM runtime_capability_evidence e LEFT JOIN workers w ON w.id = e.worker_id
          WHERE e.worker_id = $1 AND e.runtime = ANY($2::text[])) x
        WHERE x.n <= 10 ORDER BY x.runtime, x.finished_at DESC`,
      [workerId, runtimes.map((r) => r.runtime)],
    );
    const out: (RuntimeVerificationView & { authMode: string | null })[] = [];
    for (const [i, r] of runtimes.entries()) {
      const rep = reported(r);
      const caps = effectiveCapabilities(rep, index);
      const key = keys[i] ?? null;
      const last = key === null ? undefined : lastByKey.get(verificationKeyId(key));
      const hist = histRows.filter((h) => h.runtime === r.runtime);
      const kind = RuntimeKind.parse(r.runtime);
      const est = VERIFICATION_ESTIMATE[kind];
      const running = open.find((o) => o.runtime === r.runtime);
      out.push({
        runtime: r.runtime,
        version: r.version,
        platform: r.os === null || r.arch === null ? null : `${r.os}-${r.arch}`,
        adapterVersion: r.adapter_version,
        state: key === null ? 'not_applicable' : verificationState(caps),
        capabilities: caps,
        lastRun: last === undefined ? null : run(last),
        history: hist.map((h) => {
          const x = run(h);
          return {
            ...x,
            applies:
              key !== null &&
              verificationKeyId({
                runtime: x.runtime,
                runtimeVersion: x.runtimeVersion,
                os: h.os,
                arch: h.arch,
                adapterVersion: x.adapterVersion,
              }) === verificationKeyId(key),
          };
        }),
        running: running === undefined ? null : { opId: running.id, state: running.state },
        estimate: {
          tokens: est.tokens,
          durationSec: est.durationSec,
          maxTokens: DEFAULT_VERIFICATION_BUDGET.maxTokens,
          maxDurationSec: DEFAULT_VERIFICATION_BUDGET.maxDurationSec,
        },
        authMode: authModes?.[r.runtime]?.mode ?? null,
      });
    }
    return {
      workerId: w.id,
      supported: features(w.features).includes(RUNTIME_CAPABILITY_VERIFY_FEATURE),
      connected: this.deps.connected(w.id),
      runtimes: out,
    };
  }

  /** "Doğrula": checks, rate limit, audit, then the signed OPS_COMMAND. */
  async start(workerId: string, runtime: RuntimeKind, actor: ActorContext): Promise<OpView> {
    const w = await this.#worker(workerId);
    const remoteOps = this.deps.remoteOps();
    if (!features(w.features).includes(RUNTIME_CAPABILITY_VERIFY_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot verify runtime capabilities; update it first (runtime-capability-verify-v1).',
        {},
        {},
        { reason: 'runtime_verify' },
      );
    }
    const installed = (await this.#runtimes(workerId)).find((r) => r.runtime === runtime);
    if (installed === undefined) {
      throw new HttpError(
        409,
        'runtime_not_installed',
        `${runtime} is not installed on this machine.`,
        {},
        {},
        {
          runtime,
        },
      );
    }
    // The tuple the evidence will name: the adapter probe's version when the worker reports it (Claude Code with a
    // non-pinned SDK: `<cli>+sdk.<sdk>`) — the worker refuses `version_changed` for anything else.
    const version = installed.evidence_version ?? installed.version;
    // The open-run check and the op's insert are one critical section per (machine, runtime): a second click waits
    // here until the first op is stored, then sees it and gets 409 (never two ops, never two runs).
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 17))', [
        `runtime-capabilities-verify:${workerId}:${runtime}`,
      ]);
      // An op the worker stopped answering (restarted mid-run, gone) is `lost` after the remote-ops window, exactly as
      // the ops list shows it; it no longer blocks a new run.
      await remoteOps.expire(workerId);
      const { rows: open } = await tx.query<{ id: string }>(
        `SELECT id::text AS id FROM worker_ops
          WHERE worker_id = $1 AND kind = 'runtime.capabilities.verify' AND params->>'runtime' = $2
            AND state = ANY($3::text[])`,
        [workerId, runtime, OPEN_STATES],
      );
      if (open.length > 0)
        throw new HttpError(409, 'verification_running', 'A verification is already running.');
      const limit = await this.deps.limiter.hit(
        'runtime-verify',
        `${workerId}:${runtime}`,
        RUN_LIMIT.max,
        RUN_LIMIT.windowMs,
      );
      if (!limit.allowed) {
        await this.deps.audit.record({
          actor: actorOf(actor),
          action: 'runtime.capabilities.verify.start',
          target: `worker:${workerId}`,
          outcome: 'denied',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { runtime, denial: 'rate_limited' },
        });
        throw new HttpError(
          429,
          'rate_limited',
          'Too many verification runs for this runtime on this machine; try again later.',
          { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) },
          {},
          { reason: 'runtime_verify' },
        );
      }
      await this.deps.audit.record({
        actor: actorOf(actor),
        action: 'runtime.capabilities.verify.start',
        target: `worker:${workerId}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { runtime, version, budget: DEFAULT_VERIFICATION_BUDGET },
      });
      // The op row is written (and committed) by remote ops on the pool before this lock is released.
      return remoteOps.request(
        workerId,
        {
          kind: 'runtime.capabilities.verify',
          runtime,
          version,
          budget: DEFAULT_VERIFICATION_BUDGET,
        },
        actor,
      );
    });
  }

  /**
   * Every update of a `runtime.capabilities.verify` (from the remote-ops service, before it writes the op's state).
   * Stores the final, verified evidence. Never throws.
   */
  async onVerifyUpdate(input: {
    readonly session: WorkerSession;
    readonly opId: string;
    readonly params: Record<string, unknown>;
    readonly signed: SignedCapabilityEvidence;
  }): Promise<{ readonly stored: boolean; readonly reason?: string }> {
    const { session, opId, signed } = input;
    const e = signed.evidence;
    const refuse = async (reason: string) => {
      this.deps.log.error({ workerId: session.workerId, opId, reason }, 'capability evidence refused');
      await this.deps.audit
        .record({
          actor: { type: 'worker', id: session.workerId },
          action: 'runtime.capabilities.evidence',
          target: `worker:${session.workerId}`,
          outcome: 'failure',
          metadata: { opId, reason, runtime: e.runtime, version: e.runtimeVersion },
        })
        .catch(() => undefined);
      return { stored: false, reason };
    };
    try {
      const verdict = verifyCapabilityEvidence({
        workerId: session.workerId,
        opId,
        devicePublicKey: session.publicKey,
        signed,
      });
      if (verdict !== 'ok') return await refuse(verdict);
      if (input.params.runtime !== e.runtime || input.params.version !== e.runtimeVersion) {
        return await refuse('tuple_mismatch');
      }
      const { rows: op } = await this.deps.pool.query<{ requested_by: string | null }>(
        `SELECT requested_by::text AS requested_by FROM worker_ops
          WHERE id = $1 AND worker_id = $2 AND kind = 'runtime.capabilities.verify'`,
        [opId, session.workerId],
      );
      if (op[0] === undefined) return await refuse('unknown_op');
      const passed = e.results.filter((r) => r.status === 'passed');
      const failed = e.results.filter((r) => r.status === 'failed');
      await this.deps.pool.query(
        `INSERT INTO runtime_capability_evidence
           (id, worker_id, runtime, runtime_version, adapter_version, os, arch, worker_version, auth_mode,
            sandbox_profile, started_at, finished_at, duration_ms, input_tokens, output_tokens, cost_usd, stopped_by,
            passed, failed, results, declared, evidence, signature, requested_by, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
                 $23, $24, $25)
         ON CONFLICT (id) DO NOTHING`,
        [
          opId,
          session.workerId,
          e.runtime,
          e.runtimeVersion,
          e.adapterVersion,
          e.os,
          e.arch,
          e.workerVersion,
          e.authMode,
          e.sandboxProfile,
          e.startedAt,
          e.finishedAt,
          e.durationMs,
          e.usage.inputTokens,
          e.usage.outputTokens,
          e.usage.costUsd ?? null,
          e.stoppedBy ?? null,
          passed.length,
          failed.length,
          JSON.stringify(e.results),
          JSON.stringify(e.declared),
          JSON.stringify(e),
          signed.signature,
          op[0].requested_by,
          this.deps.clock(),
        ],
      );
      invalidateVerifiedIndex(this.deps.pool);
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'runtime.capabilities.evidence',
        target: `worker:${session.workerId}`,
        outcome: 'success',
        metadata: {
          opId,
          runtime: e.runtime,
          version: e.runtimeVersion,
          adapterVersion: e.adapterVersion,
          platform: `${e.os}-${e.arch}`,
          passed: passed.map((r) => r.capability),
          failed: failed.map((r) => r.capability),
          ...(e.stoppedBy === undefined ? {} : { stoppedBy: e.stoppedBy }),
          tokens: e.usage.inputTokens + e.usage.outputTokens,
        },
      });
      return { stored: true };
    } catch (err) {
      this.deps.log.error({ err, workerId: session.workerId, opId }, 'capability evidence not stored');
      return { stored: false, reason: 'store_failed' };
    }
  }

  /**
   * ASSIGN_JOB `execution.verifiedCapabilities` for one worker and runtime: what the evidence lifts on exactly its tuple
   * (undefined: an older worker, nothing verified, no tuple).
   */
  async verifiedFor(
    workerId: string,
    runtime: string,
    index?: VerifiedIndex,
  ): Promise<AssignedVerifiedCapabilities | undefined> {
    const { rows } = await this.deps.pool.query<WorkerRuntimeRow & { features: unknown }>(
      `SELECT r.runtime, r.version, w.facts->>'os' AS os, w.facts->>'arch' AS arch, r.adapter_version, r.evidence_version,
              r.declared_capabilities, r.capabilities, w.features
         FROM worker_runtimes r JOIN workers w ON w.id = r.worker_id
        WHERE r.worker_id = $1 AND r.runtime = $2 AND r.present AND r.installed
        ORDER BY r.last_reported_at DESC LIMIT 1`,
      [workerId, runtime],
    );
    const r = rows[0];
    if (r === undefined || !features(r.features).includes(RUNTIME_CAPABILITY_VERIFY_FEATURE))
      return undefined;
    const rep = reported(r);
    const key = keyOf(rep);
    const kind = RuntimeKind.safeParse(r.runtime);
    if (key === null || !kind.success) return undefined;
    const caps = verifiedList(rep, index ?? (await this.index()));
    if (caps.length === 0) return undefined;
    const os = key.os === 'darwin' || key.os === 'linux' || key.os === 'win32' ? key.os : null;
    const arch = key.arch === 'x64' || key.arch === 'arm64' ? key.arch : null;
    if (os === null || arch === null) return undefined;
    return {
      runtime: kind.data,
      runtimeVersion: key.runtimeVersion,
      os,
      arch,
      adapterVersion: key.adapterVersion,
      capabilities: caps,
    };
  }

  /** Araçlar ve sürümler / Runtime politikası: per runtime and platform, which versions are proven (latest run each). */
  async platforms(): Promise<
    {
      readonly runtime: string;
      readonly platform: string;
      readonly version: string;
      readonly adapterVersion: string;
      /** A connected or known machine still reports this adapter revision (else: the adapter changed, expired). */
      readonly current: boolean;
      readonly verified: readonly string[];
      readonly failed: readonly string[];
      readonly at: string;
      readonly machine: string;
      readonly workerId: string;
    }[]
  > {
    const index = await this.index();
    const { rows } = await this.deps.pool.query<RunRow>(
      `SELECT DISTINCT ON (e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version) ${RUN_COLUMNS}
         FROM runtime_capability_evidence e LEFT JOIN workers w ON w.id = e.worker_id
        ORDER BY e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version, e.finished_at DESC`,
    );
    const { rows: revs } = await this.deps.pool.query<{ runtime: string; adapter_version: string }>(
      `SELECT DISTINCT runtime, adapter_version FROM worker_runtimes WHERE present AND adapter_version IS NOT NULL`,
    );
    return rows.map((r) => {
      const decided = index.get(
        verificationKeyId({
          runtime: r.runtime,
          runtimeVersion: r.runtime_version,
          os: r.os,
          arch: r.arch,
          adapterVersion: r.adapter_version,
        }),
      );
      const caps = [...(decided?.entries() ?? [])];
      return {
        runtime: r.runtime,
        platform: `${r.os}-${r.arch}`,
        version: r.runtime_version,
        adapterVersion: r.adapter_version,
        current: revs.some((x) => x.runtime === r.runtime && x.adapter_version === r.adapter_version),
        verified: caps.filter(([, d]) => d.outcome === 'passed').map(([c]) => c),
        failed: caps.filter(([, d]) => d.outcome === 'failed').map(([c]) => c),
        at: r.finished_at.toISOString(),
        machine: r.machine,
        workerId: r.worker_id,
      };
    });
  }

  /**
   * Ayarlar → Runtime politikası: the installed (machine, runtime) pairs whose job-required capabilities are still
   * `unverified` after evidence — they run only because a policy rule allows unverified capabilities.
   */
  async policyDependence(): Promise<{
    readonly total: number;
    readonly dependent: number;
    readonly items: readonly {
      readonly workerId: string;
      readonly machine: string;
      readonly runtime: string;
      readonly version: string;
      readonly platform: string | null;
      readonly unverified: readonly string[];
      readonly canVerify: boolean;
    }[];
  }> {
    const index = await this.index();
    const { rows } = await this.deps.pool.query<
      WorkerRuntimeRow & { worker_id: string; machine: string; features: unknown }
    >(
      `SELECT r.worker_id, w.display_name AS machine, r.runtime, r.version, w.facts->>'os' AS os,
              w.facts->>'arch' AS arch, r.adapter_version, r.evidence_version, r.declared_capabilities, r.capabilities, w.features
         FROM worker_runtimes r JOIN workers w ON w.id = r.worker_id
        WHERE r.present AND r.installed AND w.approved_at IS NOT NULL AND w.revoked_at IS NULL
          AND w.archived_at IS NULL
        ORDER BY w.display_name, r.runtime`,
    );
    const items = [];
    let total = 0;
    for (const r of rows) {
      if (!RuntimeKind.safeParse(r.runtime).success) continue;
      total += 1;
      const caps = effectiveCapabilities(reported(r), index);
      const unverified = caps
        .filter((c) => REQUIRED.includes(c.capability) && c.effective === 'unverified')
        .map((c) => c.capability);
      if (unverified.length === 0) continue;
      items.push({
        workerId: r.worker_id,
        machine: r.machine,
        runtime: r.runtime,
        version: r.version,
        platform: r.os === null || r.arch === null ? null : `${r.os}-${r.arch}`,
        unverified,
        canVerify: features(r.features).includes(RUNTIME_CAPABILITY_VERIFY_FEATURE),
      });
    }
    return { total, dependent: items.length, items };
  }

  /** Version catalog: per runtime version, the latest run of any platform and the owner's local mark. */
  async catalog(): Promise<
    {
      readonly runtime: string;
      readonly version: string;
      readonly evidence: 'passed' | 'failed' | 'partial';
      readonly at: string;
      readonly machine: string;
      readonly platform: string;
      readonly evidenceId: string;
      readonly marked: { readonly at: string; readonly by: string | null } | null;
    }[]
  > {
    const { rows } = await this.deps.pool.query<
      RunRow & { marked_at: Date | null; marked_by: string | null }
    >(
      `SELECT DISTINCT ON (e.runtime, e.runtime_version) ${RUN_COLUMNS}, m.marked_at, m.marked_by::text AS marked_by
         FROM runtime_capability_evidence e LEFT JOIN workers w ON w.id = e.worker_id
         LEFT JOIN runtime_catalog_verifications m ON m.runtime = e.runtime AND m.version = e.runtime_version
        ORDER BY e.runtime, e.runtime_version, e.finished_at DESC`,
    );
    return rows.map((r) => ({
      runtime: r.runtime,
      version: r.runtime_version,
      evidence: catalogOutcome(r),
      at: r.finished_at.toISOString(),
      machine: r.machine,
      platform: `${r.os}-${r.arch}`,
      evidenceId: r.id,
      marked: r.marked_at === null ? null : { at: r.marked_at.toISOString(), by: r.marked_by },
    }));
  }

  /**
   * The owner marks an unverified catalog runtime version as verified on this installation — only after a run of it
   * passed (no failed check; streaming, cancel and approval-or-declared-unsupported proven). Never changes the signed
   * catalog: promoting it for every installation is the vendor's routine (docs/ops/update-channel.md §4).
   */
  async markCatalogVerified(runtime: RuntimeKind, version: string, actor: ActorContext): Promise<void> {
    const { rows } = await this.deps.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runtime_capability_evidence e LEFT JOIN workers w ON w.id = e.worker_id
        WHERE e.runtime = $1 AND e.runtime_version = $2 ORDER BY e.finished_at DESC LIMIT 1`,
      [runtime, version],
    );
    const r = rows[0];
    if (r === undefined || catalogOutcome(r) !== 'passed') {
      await this.deps.audit.record({
        actor: actorOf(actor),
        action: 'runtime.catalog.verified.mark',
        target: `runtime:${runtime}@${version}`,
        outcome: 'denied',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reason: r === undefined ? 'no_run' : 'not_passed' },
      });
      throw new HttpError(
        409,
        'verification_not_passed',
        `${runtime} ${version} has no passed verification run yet; run "Doğrula" on the canary machine first.`,
        {},
        {},
        { runtime, version },
      );
    }
    await this.deps.pool.query(
      `INSERT INTO runtime_catalog_verifications (runtime, version, evidence_id, marked_by, marked_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (runtime, version) DO UPDATE SET evidence_id = EXCLUDED.evidence_id,
         marked_by = EXCLUDED.marked_by, marked_at = EXCLUDED.marked_at`,
      [runtime, version, r.id, actor.system === undefined ? actor.userId : null, this.deps.clock()],
    );
    await this.deps.audit.record({
      actor: actorOf(actor),
      action: 'runtime.catalog.verified.mark',
      target: `runtime:${runtime}@${version}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { evidenceId: r.id, platform: `${r.os}-${r.arch}`, machine: r.worker_id },
    });
  }
}

/** A run counts as passed for the catalog when nothing failed and streaming + cancel passed. */
function catalogOutcome(r: Pick<RunRow, 'results' | 'failed'>): 'passed' | 'failed' | 'partial' {
  if (r.failed > 0) return 'failed';
  const ok = (cap: string) => r.results.some((x) => x.capability === cap && x.status === 'passed');
  return ok('streaming') && ok('cancel') ? 'passed' : 'partial';
}
