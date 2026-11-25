import { DEFAULT_RULES, Redactor, redactDeep } from '@remyral/observability';
import {
  isAllowedLoginUrl,
  type LoginReport,
  LoginUserCode,
  type LoginRuntime,
  MAX_LOG_BYTES,
  OPS_KINDS,
  type OpsCommandPayload,
  type OpsKind,
  type OpsOperation,
  type OpsState,
  type OpsUpdatePayload,
  REMOTE_OPS_FEATURE,
  RUNTIME_ACCOUNTS_FEATURE,
  LOGS_SOURCE_FEATURE,
  SANDBOX_OPS_FEATURE,
  LoginRuntime as LoginRuntimeSchema,
  RemoteOpsReport,
  type RuntimeKind,
  TERMINAL_OPS_STATES,
  TOOLS_FEATURE,
  CUSTOM_TOOLS_FEATURE,
  ToolInventoryReport,
  MCP_FEATURE,
  MCP_STDIO_FEATURE,
  CODE_IMAGES_FEATURE,
  FUNCTION_CODE_FEATURE,
  GIT_CENTRAL_FEATURE,
  USAGE_REFRESH_FEATURE,
  DOCTOR_FEATURE,
  DISK_HYGIENE_FEATURE,
  WORKER_MANAGED_FEATURE,
  type McpInstallReport,
  type McpProbeReport,
  RUNTIME_UNVERIFIED_FEATURE,
  RUNTIME_CAPABILITY_VERIFY_FEATURE,
  type SignedCapabilityEvidence,
  type RuntimeInstallReport,
  type RuntimeVerifyReport,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';

/**
 * Master side of remote operations (p5-remote-ops, ADR-0017). Every operation is an admin request (step-up,
 * CSRF, audited, rate-limited) that becomes one signed OPS_COMMAND to a connected worker advertising
 * `remote-ops-v1`. The worker re-validates everything and reports OPS_UPDATE; the panel polls the operation.
 *
 * Secrets boundary: a code the owner pastes into a login is relayed in memory only (never stored, logged or
 * audited); login URLs / device codes are relayed from memory and expire with the login; log lines are
 * redacted again here (pattern pass — the worker already removed exact secrets) and kept in memory for a few
 * minutes; diagnostics are redacted before they are stored.
 */

export interface OpsSigner {
  signOpsCommand(input: {
    workerId: string;
    commandId: string;
    issuedAt: string;
    expiresAt: string;
    op: OpsOperation;
  }): { kid: string; signature: string };
}

export interface RemoteOpsLimits {
  /** Commands per worker (any kind). */
  readonly perWorker: { readonly max: number; readonly windowMs: number };
  /** Install / remove / restart commands per worker. */
  readonly heavyPerWorker: { readonly max: number; readonly windowMs: number };
  /** Commands per administrator. */
  readonly perUser: { readonly max: number; readonly windowMs: number };
}

export const DEFAULT_REMOTE_OPS_LIMITS: RemoteOpsLimits = {
  perWorker: { max: 60, windowMs: 10 * 60_000 },
  heavyPerWorker: { max: 10, windowMs: 10 * 60_000 },
  perUser: { max: 120, windowMs: 10 * 60_000 },
};

/** How long a command is valid on the worker. */
const COMMAND_TTL_MS = 2 * 60_000;
/** Non-terminal operations without news for this long are shown (and stored) as `lost`. */
const LOST_AFTER_MS: Readonly<Partial<Record<OpsKind, number>>> = {
  'runtime.install': 45 * 60_000,
  // p16-runtime-updates: a candidate install into a scratch dir plus its checks.
  'runtime.verify': 45 * 60_000,
  // p17-runtime-verify: the budget is at most 30 min; progress updates keep it alive.
  'runtime.capabilities.verify': 40 * 60_000,
  'login.start': 20 * 60_000,
  'service.restart': 26 * 60 * 60_000,
  // Privileged prepare waits for the helper (Windows: a scheduled task each minute; apt can take minutes).
  'sandbox.prepare': 30 * 60_000,
  // p5-machine-admin: a browser archive is ~200 MB.
  'tool.install': 45 * 60_000,
  // p13-fleet-tools: a custom download may be up to 1 GiB.
  'tool.install.custom': 45 * 60_000,
  // p14-code-images: two base image pulls (~80 MB / ~50 MB) and two small builds.
  'code.images.prepare': 45 * 60_000,
  // p17-disk-selfclean: sizing and removing large trees (package caches, kept directories) takes a while.
  'disk.clean': 30 * 60_000,
  // p17-worker-managed: the privileged helper answers through its trigger (Windows: a task once a minute).
  'worker.uninstall': 15 * 60_000,
  'helper.manage': 15 * 60_000,
};
const DEFAULT_LOST_AFTER_MS = 10 * 60_000;
/** Log lines and login relays are kept in memory this long after the last update. */
const MEMORY_TTL_MS = 15 * 60_000;
const MAX_LOG_LINES_KEPT = 2000;

const HEAVY: ReadonlySet<OpsKind> = new Set([
  'runtime.install',
  'runtime.verify',
  // p17-runtime-verify: runs the agent and spends tokens.
  'runtime.capabilities.verify',
  'runtime.remove',
  'runtime.restart',
  'service.restart',
  'sandbox.prepare',
  'tool.install',
  'tool.remove',
  'tool.install.custom',
  'tool.remove.custom',
  // p14-mcp-stdio: a package install downloads and unpacks a whole dependency tree.
  'mcp.install',
  'mcp.remove',
  // p14-code-images: pulls and builds container images.
  'code.images.prepare',
  // p17-worker-managed: privileged changes of the machine.
  'worker.uninstall',
  'helper.manage',
]);

const TOOL_KINDS: ReadonlySet<OpsKind> = new Set([
  'tools.detect',
  'tool.install',
  'tool.remove',
  'machine.inspect',
  'tool.install.custom',
  'tool.remove.custom',
]);

export interface LoginRelayView {
  readonly runtime: LoginRuntime;
  readonly url: string | null;
  readonly userCode: string | null;
  readonly expectsCode: boolean;
  /** Whether a pasted code was already relayed (the field is then disabled). */
  readonly codeSent: boolean;
}

export interface OpView {
  readonly id: string;
  readonly workerId: string;
  readonly kind: OpsKind;
  readonly params: Record<string, unknown>;
  readonly state: OpsState | 'sent' | 'lost';
  readonly reason: string | null;
  readonly detail: string | null;
  readonly progress: { step: string; done?: number; total?: number } | null;
  readonly result: Record<string, unknown> | null;
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** Login relay (only while the login is open). */
  readonly login: LoginRelayView | null;
  /** Log lines after the requested cursor (logs.tail). */
  readonly logs: {
    readonly lines: string[];
    readonly next: number;
    readonly complete: boolean;
    readonly truncated: boolean;
  } | null;
}

export interface RemoteOpsStatus {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly report: RemoteOpsReport | null;
  readonly reportedAt: string | null;
  readonly ops: OpView[];
  /**
   * p14-code-images: code node images of this machine — `supported`: the worker can build them (`code-images-v1`);
   * `ready`: it runs code nodes now (`function-code-v1`).
   */
  readonly codeImages: { readonly supported: boolean; readonly ready: boolean };
}

interface OpRow {
  id: string;
  worker_id: string;
  kind: OpsKind;
  params: Record<string, unknown>;
  state: OpView['state'];
  reason: string | null;
  detail: string | null;
  progress: OpView['progress'];
  result: Record<string, unknown> | null;
  last_seq: number;
  requested_by: string | null;
  requested_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

interface Memory {
  login: LoginRelayView | null;
  logs: string[];
  logsComplete: boolean;
  logsTruncated: boolean;
  touchedAt: number;
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

const TERMINAL = new Set<string>([...TERMINAL_OPS_STATES, 'lost']);

export class RemoteOpsService {
  readonly #memory = new Map<string, Memory>();
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });
  readonly #limits: RemoteOpsLimits;

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly signer: OpsSigner;
      readonly limiter: RateLimiter;
      readonly session: (workerId: string) => WorkerSession | undefined;
      readonly limits?: RemoteOpsLimits;
      /**
       * p5-sandbox-ops: a subscription login finished successfully on the worker (the worker-config service then
       * sets the runtime's auth to local-login when it is unset).
       */
      readonly onLoginSucceeded?: (workerId: string, runtime: LoginRuntime) => Promise<unknown>;
      /**
       * p14-mcp-core: a finished `mcp.probe` (the MCP service stores the tools it found as untrusted text). Late-bound:
       * the MCP service itself sends probes through this service.
       */
      readonly onMcpProbe?: () => {
        onProbeFinished(input: {
          readonly workerId: string;
          readonly opId: string;
          readonly params: Record<string, unknown>;
          readonly state: string;
          readonly reason: string | null;
          readonly report: McpProbeReport | undefined;
        }): Promise<void>;
      } | null;
      /**
       * p14-mcp-stdio: every update of an `mcp.install` / `mcp.remove` (the MCP service records the install state, and
       * on success the canary's lockfile).
       */
      readonly onMcpInstall?: () => {
        onInstallUpdate(input: {
          readonly workerId: string;
          readonly opId: string;
          readonly kind: 'mcp.install' | 'mcp.remove';
          readonly params: Record<string, unknown>;
          readonly state: string;
          readonly reason: string | null;
          readonly detail: string | null;
          readonly report: McpInstallReport | undefined;
        }): Promise<void>;
      } | null;
      /**
       * p15-usage-refresh: the snapshots a `usage.refresh` read (the runtime-usage service stores them before the
       * operation's final state is written, so a finished operation always has its numbers in the overview).
       */
      readonly onUsageRefresh?: (workerId: string, snapshots: readonly unknown[]) => Promise<void>;
      /**
       * p17-worker-managed: every terminal update of a `worker.uninstall` / `helper.manage` (the removal service revokes
       * the worker once the helper accepted its removal). Never throws into the update path.
       */
      readonly onManageFinished?: (input: {
        readonly workerId: string;
        readonly opId: string;
        readonly kind: 'worker.uninstall' | 'helper.manage';
        readonly state: string;
        readonly reason: string | null;
        readonly detail: string | null;
      }) => Promise<void>;
      /**
       * p16-runtime-updates: every terminal update of an unverified `runtime.install` or a `runtime.verify` (the fleet
       * service keeps the lock the first machine resolved and records the verification checks).
       */
      /**
       * p17-runtime-verify: the final, signed evidence of a `runtime.capabilities.verify` (the evidence service verifies
       * the device-key signature and stores it before the op's final state is written). Late-bound.
       */
      readonly onCapabilityVerify?: () => {
        onVerifyUpdate(input: {
          readonly session: WorkerSession;
          readonly opId: string;
          readonly params: Record<string, unknown>;
          readonly signed: SignedCapabilityEvidence;
        }): Promise<{ readonly stored: boolean; readonly reason?: string }>;
      } | null;
      readonly onRuntimeUpdate?: () => {
        onRuntimeUpdate(input: {
          readonly workerId: string;
          readonly opId: string;
          readonly kind: 'runtime.install' | 'runtime.verify';
          readonly params: Record<string, unknown>;
          readonly state: string;
          readonly reason: string | null;
          readonly detail: string | null;
          readonly install: RuntimeInstallReport | undefined;
          readonly verify: RuntimeVerifyReport | undefined;
        }): Promise<void>;
      } | null;
    },
  ) {
    this.#limits = deps.limits ?? DEFAULT_REMOTE_OPS_LIMITS;
  }

  #now(): Date {
    return this.deps.clock();
  }

  #sweepMemory(): void {
    const cutoff = this.#now().getTime() - MEMORY_TTL_MS;
    for (const [id, m] of this.#memory) if (m.touchedAt < cutoff) this.#memory.delete(id);
  }

  #mem(id: string): Memory {
    let m = this.#memory.get(id);
    if (m === undefined) {
      m = {
        login: null,
        logs: [],
        logsComplete: false,
        logsTruncated: false,
        touchedAt: this.#now().getTime(),
      };
      this.#memory.set(id, m);
    }
    m.touchedAt = this.#now().getTime();
    return m;
  }

  // ------------------------------------------------------------------------------------------- reads

  async #worker(workerId: string): Promise<{
    id: string;
    display_name: string;
    state: string;
    features: unknown;
    remote_ops: unknown;
    remote_ops_at: Date | null;
  }> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      display_name: string;
      state: string;
      features: unknown;
      remote_ops: unknown;
      remote_ops_at: Date | null;
    }>(
      `SELECT id, display_name, state, features, remote_ops, remote_ops_at FROM workers
        WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw new HttpError(404, 'worker_not_found', 'No such worker.');
    return w;
  }

  /**
   * Marks stale non-terminal operations `lost` (no news from the worker for longer than expected). Public so that a
   * caller deciding "is one already open?" (p17-runtime-verify's one run per machine and runtime) sees the same open set
   * as the ops list.
   */
  async expire(workerId: string): Promise<void> {
    const now = this.#now();
    const { rows } = await this.deps.pool.query<{ id: string; kind: OpsKind; updated_at: Date }>(
      `SELECT id, kind, updated_at FROM worker_ops
        WHERE worker_id = $1 AND state IN ('sent', 'accepted', 'running', 'waiting_for_user')`,
      [workerId],
    );
    for (const r of rows) {
      const limit = LOST_AFTER_MS[r.kind] ?? DEFAULT_LOST_AFTER_MS;
      if (now.getTime() - r.updated_at.getTime() > limit) {
        await this.deps.pool.query(
          `UPDATE worker_ops SET state = 'lost', reason = 'no_answer', updated_at = $2, finished_at = $2
            WHERE id = $1 AND state IN ('sent', 'accepted', 'running', 'waiting_for_user')`,
          [r.id, now],
        );
        this.#memory.delete(r.id);
      }
    }
  }

  #view(r: OpRow, after = 0): OpView {
    const m = this.#memory.get(r.id);
    const open = !TERMINAL.has(r.state);
    return {
      id: r.id,
      workerId: r.worker_id,
      kind: r.kind,
      params: r.params,
      state: r.state,
      reason: r.reason,
      detail: r.detail === null ? null : this.#redactor.redact(r.detail),
      progress: r.progress,
      result: r.result === null ? null : (redactDeep(r.result, this.#redactor) as Record<string, unknown>),
      requestedBy: r.requested_by,
      requestedAt: r.requested_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      login: open && m?.login !== null && m?.login !== undefined ? m.login : null,
      logs:
        r.kind === 'logs.tail'
          ? {
              // Second redaction pass on every read too (defence in depth).
              lines: (m?.logs ?? []).slice(after).map((l) => this.#redactor.redact(l)),
              next: m?.logs.length ?? 0,
              complete: m?.logsComplete ?? TERMINAL.has(r.state),
              truncated: m?.logsTruncated ?? false,
            }
          : null,
    };
  }

  async status(workerId: string): Promise<RemoteOpsStatus> {
    this.#sweepMemory();
    const w = await this.#worker(workerId);
    await this.expire(workerId);
    const { rows } = await this.deps.pool.query<OpRow>(
      `SELECT id::text AS id, worker_id, kind, params, state, reason, detail, progress, result, last_seq,
              requested_by::text AS requested_by, requested_at, updated_at, finished_at
         FROM worker_ops WHERE worker_id = $1 AND kind NOT IN ('login.input', 'ops.cancel')
        ORDER BY requested_at DESC LIMIT 25`,
      [workerId],
    );
    const parsed = RemoteOpsReport.safeParse(w.remote_ops);
    return {
      workerId: w.id,
      displayName: w.display_name,
      state: w.state,
      connected: this.deps.session(w.id) !== undefined,
      supported: features(w.features).includes(REMOTE_OPS_FEATURE),
      report: parsed.success ? parsed.data : null,
      reportedAt: w.remote_ops_at?.toISOString() ?? null,
      ops: rows.map((r) => this.#view(r)),
      codeImages: {
        supported: features(w.features).includes(CODE_IMAGES_FEATURE),
        ready: features(w.features).includes(FUNCTION_CODE_FEATURE),
      },
    };
  }

  async op(workerId: string, opId: string, after = 0): Promise<OpView> {
    this.#sweepMemory();
    await this.expire(workerId);
    const { rows } = await this.deps.pool.query<OpRow>(
      `SELECT id::text AS id, worker_id, kind, params, state, reason, detail, progress, result, last_seq,
              requested_by::text AS requested_by, requested_at, updated_at, finished_at
         FROM worker_ops WHERE id = $1 AND worker_id = $2`,
      [opId, workerId],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'op_not_found', 'No such operation on this worker.');
    return this.#view(r, Math.max(0, after));
  }

  // ------------------------------------------------------------------------------------------ writes

  async #limit(workerId: string, kind: OpsKind, actor: ActorContext): Promise<void> {
    const hits: [string, string, { max: number; windowMs: number }][] = [
      ['remote-ops-worker', workerId, this.#limits.perWorker],
      [
        'remote-ops-user',
        actor.system === undefined ? actor.userId : `system:${actor.system}`,
        this.#limits.perUser,
      ],
      ...(HEAVY.has(kind)
        ? ([['remote-ops-heavy', workerId, this.#limits.heavyPerWorker]] as [
            string,
            string,
            { max: number; windowMs: number },
          ][])
        : []),
    ];
    for (const [bucket, key, rule] of hits) {
      const r = await this.deps.limiter.hit(bucket, key, rule.max, rule.windowMs);
      if (!r.allowed) {
        await this.deps.audit.record({
          actor: actorOf(actor),
          action: `worker.ops.${kind}`,
          target: `worker:${workerId}`,
          outcome: 'denied',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { denial: 'rate_limited', bucket },
        });
        throw new HttpError(
          429,
          'rate_limited',
          'Too many remote operations; try again later.',
          {
            'retry-after': String(Math.ceil(r.retryAfterMs / 1000)),
          },
          {},
          { reason: 'remote_ops' },
        );
      }
    }
  }

  /**
   * Creates, audits, signs and sends one operation. `op` was validated by the route against the protocol schema.
   */
  async request(workerId: string, op: OpsOperation, actor: ActorContext): Promise<OpView> {
    const w = await this.#worker(workerId);
    if (w.state === 'quarantined')
      throw new HttpError(409, 'worker_quarantined', 'The worker is quarantined.');
    if (!features(w.features).includes(REMOTE_OPS_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot be operated remotely; update it first.',
        {},
        {},
        { reason: 'remote_ops' },
      );
    }
    // p13-runtime-accounts: an account's login only on a worker that knows accounts (an older one would ignore the
    // field and log the configured login in or out instead).
    if (
      (op.kind === 'login.start' || op.kind === 'login.status' || op.kind === 'login.logout') &&
      op.account !== undefined &&
      !features(w.features).includes(RUNTIME_ACCOUNTS_FEATURE)
    ) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build has no runtime accounts; update it first (runtime-accounts-v1).',
        {},
        {},
        { reason: 'runtime_accounts' },
      );
    }
    if (op.kind === 'sandbox.prepare' && !features(w.features).includes(SANDBOX_OPS_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot prepare its sandbox from the panel; update it first.',
        {},
        {},
        { reason: 'sandbox' },
      );
    }
    if (
      op.kind === 'logs.tail' &&
      op.source !== undefined &&
      op.source !== 'worker' &&
      !features(w.features).includes(LOGS_SOURCE_FEATURE)
    ) {
      // p6-worker-boot-diagnostics: an older worker would ignore `source` and answer with its worker log.
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build can only show its worker log; update it to read the boot or updater log.',
        {},
        {},
        { reason: 'logs' },
      );
    }
    if (TOOL_KINDS.has(op.kind) && !features(w.features).includes(TOOLS_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build has no tool inventory or recipes; update it first.',
        {},
        {},
        { reason: 'tools' },
      );
    }
    if (
      (op.kind === 'tool.install.custom' || op.kind === 'tool.remove.custom') &&
      !features(w.features).includes(CUSTOM_TOOLS_FEATURE)
    ) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot install custom tools; update it first.',
        {},
        {},
        { reason: 'custom_tools' },
      );
    }
    // p14-mcp-core: tool discovery only on workers that understand external MCP servers.
    if (op.kind === 'mcp.probe' && !features(w.features).includes(MCP_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot use external MCP servers; update it first (mcp-v1).',
        {},
        {},
        { reason: 'mcp' },
      );
    }
    // p14-mcp-stdio: local MCP server packages only on workers that install and run them.
    if (
      (op.kind === 'mcp.install' ||
        op.kind === 'mcp.remove' ||
        (op.kind === 'mcp.probe' && mcpProbeTransport(op) === 'stdio')) &&
      !features(w.features).includes(MCP_STDIO_FEATURE)
    ) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot install or run local MCP servers; update it first (mcp-stdio-v1).',
        {},
        {},
        { reason: 'mcp_stdio' },
      );
    }
    // p14-code-images: only workers that ship the code image build contexts (an older one cannot parse the op).
    if (op.kind === 'code.images.prepare' && !features(w.features).includes(CODE_IMAGES_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot prepare code node images, or it has no container engine configured; update it or configure its container engine first (code-images-v1).',
        {},
        {},
        { reason: 'code_images' },
      );
    }
    // p15-git-central: only workers that know the op (an older one cannot parse it).
    if (op.kind === 'git.fix' && !features(w.features).includes(GIT_CENTRAL_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot check or fix its git setup; update it first (git-central-v1).',
        {},
        {},
        { reason: 'git_central' },
      );
    }
    // p15-usage-refresh: only workers that know the op (an older one cannot parse it).
    if (op.kind === 'usage.refresh' && !features(w.features).includes(USAGE_REFRESH_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot read its usage windows on request; update it first (usage-refresh-v1).',
        {},
        {},
        { reason: 'usage_refresh' },
      );
    }
    // p16-runtime-updates: a version outside the pinned set and the verification op only where the worker knows them
    // (an older one would refuse the unknown op or the stripped field's signature).
    if (
      (op.kind === 'runtime.verify' || (op.kind === 'runtime.install' && op.unverified !== undefined)) &&
      !features(w.features).includes(RUNTIME_UNVERIFIED_FEATURE)
    ) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build installs only the runtime versions pinned in its release; update it first (runtime-unverified-v1).',
        {},
        {},
        { reason: 'runtime_unverified' },
      );
    }
    // p17-runtime-verify: only workers that know the op (an older one cannot parse it).
    if (
      op.kind === 'runtime.capabilities.verify' &&
      !features(w.features).includes(RUNTIME_CAPABILITY_VERIFY_FEATURE)
    ) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot verify runtime capabilities; update it first (runtime-capability-verify-v1).',
        {},
        {},
        { reason: 'runtime_verify' },
      );
    }
    // p16-doctor: only workers that know the op (older ones answer diagnostics.run instead).
    if (op.kind === 'doctor.run' && !features(w.features).includes(DOCTOR_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build has no doctor; update it first (doctor-v1).',
        {},
        {},
        { reason: 'doctor' },
      );
    }
    // p17-disk-selfclean: only workers that know the op (an older one cannot parse it).
    if (op.kind === 'disk.clean' && !features(w.features).includes(DISK_HYGIENE_FEATURE)) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot clean its own disk space; update it first (disk-hygiene-v1).',
        {},
        {},
        { reason: 'disk_hygiene' },
      );
    }
    // p17-worker-managed: removal and helper management only where the worker knows them (an older one cannot parse them).
    if (
      (op.kind === 'worker.uninstall' || op.kind === 'helper.manage') &&
      !features(w.features).includes(WORKER_MANAGED_FEATURE)
    ) {
      throw new HttpError(
        409,
        'worker_update_required',
        'This worker build cannot be removed or have its helper managed from the panel; update it first (worker-managed-v1).',
        {},
        {},
        { reason: 'worker_managed' },
      );
    }
    const session = this.deps.session(workerId);
    if (session === undefined) throw new HttpError(409, 'worker_offline', 'The worker is not connected.');
    await this.#preflight(workerId, op, w.remote_ops);
    await this.#limit(workerId, op.kind, actor);

    const now = this.#now();
    const commandId = randomUUID();
    const params = this.#params(op);
    await this.deps.pool.query(
      `INSERT INTO worker_ops (id, worker_id, kind, params, state, requested_by, requested_at, updated_at)
       VALUES ($1, $2, $3, $4, 'sent', $5, $6, $6)`,
      [
        commandId,
        workerId,
        op.kind,
        JSON.stringify(params),
        actor.system === undefined ? actor.userId : null,
        now,
      ],
    );
    await this.deps.audit.record({
      actor: actorOf(actor),
      action: `worker.ops.${op.kind}`,
      target: `worker:${workerId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { opId: commandId, ...params },
    });
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + COMMAND_TTL_MS).toISOString();
    const payload: OpsCommandPayload = {
      commandId,
      issuedAt,
      expiresAt,
      op,
      signature: this.deps.signer.signOpsCommand({ workerId, commandId, issuedAt, expiresAt, op }),
    };
    try {
      await session.send('OPS_COMMAND', payload);
      this.deps.log.info({ workerId, opId: commandId, kind: op.kind }, 'remote operation sent');
    } catch (err) {
      this.deps.log.warn({ err, workerId, opId: commandId }, 'remote operation could not be sent');
      await this.deps.pool.query(
        `UPDATE worker_ops SET state = 'failed', reason = 'send_failed', detail = 'the worker disconnected',
                updated_at = $2, finished_at = $2 WHERE id = $1`,
        [commandId, this.#now()],
      );
    }
    if (op.kind === 'logs.tail') this.#mem(commandId);
    return this.op(workerId, commandId);
  }

  /** Never stores a secret: a pasted login code is dropped from the parameters. */
  #params(op: OpsOperation): Record<string, unknown> {
    if (op.kind === 'login.input') return { target: op.target };
    // p14-mcp-core: the signed spec stays out of the stored parameters and the audit row (ids and hashes only).
    if (op.kind === 'mcp.probe') return mcpProbeParams(op);
    // p14-mcp-stdio: ids and hashes only (never the spec or the lockfile bytes).
    if (op.kind === 'mcp.install') return mcpInstallParams(op);
    if (op.kind === 'mcp.remove') return { serverId: op.id, version: op.version };
    // p16-runtime-updates: the source without the lock bytes (its hash only).
    if (op.kind === 'runtime.install' && op.unverified !== undefined) {
      const { lock, ...source } = op.unverified;
      return {
        runtime: op.runtime,
        version: op.version,
        unverified: { ...source, ...(lock === undefined ? {} : { lockSha256: lock.sha256 }) },
      };
    }
    if (op.kind === 'runtime.verify') {
      const { lock, ...source } = op.source;
      return {
        runtime: op.runtime,
        version: op.version,
        source: { ...source, ...(lock === undefined ? {} : { lockSha256: lock.sha256 }) },
      };
    }
    const { kind: _kind, ...rest } = op;
    return rest;
  }

  /** Early, explanatory refusals (the worker re-checks everything itself). */
  async #preflight(workerId: string, op: OpsOperation, rawReport: unknown): Promise<void> {
    const report = RemoteOpsReport.safeParse(rawReport);
    if (op.kind === 'runtime.install' && op.unverified === undefined && report.success) {
      const rt = report.data.runtimes.find((r) => r.runtime === op.runtime);
      if (rt !== undefined && !rt.available.includes(op.version)) {
        throw new HttpError(
          409,
          'version_not_available',
          `${op.runtime} ${op.version} is not in the pinned set this worker can install (${rt.available.join(', ') || 'none'}).`,
          {},
          {},
          { runtime: op.runtime, version: op.version, available: rt.available.join(', ') || 'none' },
        );
      }
    }
    if (op.kind === 'service.restart' && report.success && !report.data.service.restartable) {
      throw new HttpError(
        409,
        'not_restartable',
        'The worker does not run under its service manager; it cannot be restarted remotely.',
      );
    }
    if (op.kind === 'login.start') {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM worker_ops WHERE worker_id = $1 AND kind = 'login.start'
            AND state IN ('sent', 'accepted', 'running', 'waiting_for_user') AND updated_at > $2`,
        [workerId, new Date(this.#now().getTime() - (LOST_AFTER_MS['login.start'] ?? 0))],
      );
      if (rows.length > 0) {
        throw new HttpError(409, 'login_in_progress', 'A login is already in progress on this worker.');
      }
    }
  }

  /**
   * Waits (bounded) until an operation reaches a terminal state — for callers that need its result now (the ops
   * chat's machine_inspect). Returns the last view either way.
   */
  async waitFor(workerId: string, opId: string, timeoutMs: number, pollMs = 300): Promise<OpView> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.op(workerId, opId);
      if (TERMINAL.has(v.state) || Date.now() >= until) return v;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** p5-machine-admin: CAPABILITIES.toolInventory (stored for the Tools tab, placement and the ops chat). */
  async onToolsReport(session: WorkerSession, report: ToolInventoryReport | undefined): Promise<void> {
    if (report === undefined) return;
    await this.deps.pool.query(
      'UPDATE workers SET tool_inventory = $2, tool_inventory_at = $3 WHERE id = $1',
      [session.workerId, JSON.stringify(redactDeep(report, this.#redactor)), this.#now()],
    );
  }

  /** Paste-back of a login code (relayed in memory, never stored, logged or audited). */
  async input(workerId: string, opId: string, code: string, actor: ActorContext): Promise<OpView> {
    const login = await this.op(workerId, opId);
    const relay = this.#memory.get(opId)?.login;
    if (login.kind !== 'login.start' || login.state !== 'waiting_for_user' || relay?.expectsCode !== true) {
      throw new HttpError(409, 'login_not_waiting', 'This login is not waiting for a code.');
    }
    if (relay.codeSent)
      throw new HttpError(409, 'code_already_sent', 'A code was already sent for this login.');
    await this.request(workerId, { kind: 'login.input', target: opId, code }, actor);
    const m = this.#mem(opId);
    if (m.login !== null) m.login = { ...m.login, codeSent: true };
    return this.op(workerId, opId);
  }

  async cancel(workerId: string, opId: string, actor: ActorContext): Promise<OpView> {
    const target = await this.op(workerId, opId);
    if (TERMINAL.has(target.state))
      throw new HttpError(409, 'op_finished', 'The operation already finished.');
    await this.request(workerId, { kind: 'ops.cancel', target: opId }, actor);
    return this.op(workerId, opId);
  }

  // --------------------------------------------------------------------------------- worker messages

  /** CAPABILITIES.remoteOps. */
  async onReport(session: WorkerSession, report: RemoteOpsReport | undefined): Promise<void> {
    if (report === undefined) return;
    await this.deps.pool.query(`UPDATE workers SET remote_ops = $2, remote_ops_at = $3 WHERE id = $1`, [
      session.workerId,
      JSON.stringify(report),
      this.#now(),
    ]);
  }

  /** Replaces one runtime's login entry in the stored CAPABILITIES.remoteOps report (if there is one). */
  async #recordLogin(workerId: string, entry: LoginReport): Promise<void> {
    const { rows } = await this.deps.pool.query<{ remote_ops: unknown }>(
      `SELECT remote_ops FROM workers WHERE id = $1`,
      [workerId],
    );
    const parsed = RemoteOpsReport.safeParse(rows[0]?.remote_ops);
    if (!parsed.success) return;
    const report: RemoteOpsReport = {
      ...parsed.data,
      login: [...parsed.data.login.filter((l) => l.runtime !== entry.runtime), entry],
    };
    await this.deps.pool.query(`UPDATE workers SET remote_ops = $2 WHERE id = $1`, [
      workerId,
      JSON.stringify(report),
    ]);
  }

  /** OPS_UPDATE: ordered by seq per command; only commands this master sent to this worker. */
  async onUpdate(session: WorkerSession, u: OpsUpdatePayload): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      kind: OpsKind;
      last_seq: number;
      state: string;
      params: Record<string, unknown>;
    }>(`SELECT kind, last_seq, state, params FROM worker_ops WHERE id = $1 AND worker_id = $2`, [
      u.commandId,
      session.workerId,
    ]);
    const row = rows[0];
    if (row === undefined || row.kind !== u.kind) {
      this.deps.log.warn(
        { workerId: session.workerId, opId: u.commandId },
        'OPS_UPDATE for an unknown operation',
      );
      return;
    }
    if (u.seq <= row.last_seq) return; // duplicate / reordered
    const now = this.#now();
    const terminal = TERMINAL_OPS_STATES.has(u.state);
    const m = this.#mem(u.commandId);
    if (u.login !== undefined) {
      if (u.state === 'waiting_for_user') {
        // Re-validated here (schema already did): only the provider's sign-in page and a device code.
        const url = u.login.url !== undefined && isAllowedLoginUrl(u.login.url) ? u.login.url : null;
        const code =
          u.login.userCode !== undefined && LoginUserCode.safeParse(u.login.userCode).success
            ? u.login.userCode
            : null;
        m.login = {
          runtime: u.login.runtime,
          url,
          userCode: code,
          expectsCode: u.login.expectsCode,
          codeSent: false,
        };
      } else if (terminal) {
        m.login = null;
      }
    }
    if (u.logs !== undefined) {
      for (const line of u.logs.lines) {
        if (m.logs.length >= MAX_LOG_LINES_KEPT) break;
        m.logs.push(this.#redactor.redact(line).slice(0, 4096));
      }
      m.logsTruncated ||= u.logs.truncated;
      if (u.logs.last) m.logsComplete = true;
      const bytes = m.logs.reduce((n, l) => n + l.length, 0);
      if (bytes > MAX_LOG_BYTES * 2) m.logs.splice(0, m.logs.length - MAX_LOG_LINES_KEPT / 2);
    }
    if (u.tools !== undefined) await this.onToolsReport(session, u.tools);
    // p15-usage-refresh: the fresh readings are stored before the operation's state says it is done.
    if (u.usageRefresh !== undefined && row.kind === 'usage.refresh') {
      await this.deps.onUsageRefresh?.(session.workerId, u.usageRefresh.snapshots).catch((err: unknown) => {
        this.deps.log.warn({ err, workerId: session.workerId }, 'usage refresh readings not stored');
      });
    }
    const base: Record<string, unknown> | null =
      u.tools !== undefined
        ? { tools: redactDeep(u.tools, this.#redactor) }
        : u.inspect !== undefined
          ? { inspect: redactDeep(u.inspect, this.#redactor) }
          : u.mcpInstall !== undefined
            ? {
                mcpInstall: {
                  digest: u.mcpInstall.digest,
                  lockSha256: u.mcpInstall.lockSha256,
                  lockProduced: u.mcpInstall.lock !== undefined,
                  files: u.mcpInstall.files,
                  bytes: u.mcpInstall.bytes,
                  ...(u.mcpInstall.acl === undefined ? {} : { acl: u.mcpInstall.acl }),
                },
              }
            : u.mcpProbe !== undefined
              ? {
                  mcpProbe: {
                    toolCount: u.mcpProbe.tools.length + (u.mcpProbe.moreTools ?? 0),
                    transport: u.mcpProbe.transport,
                    durationMs: u.mcpProbe.durationMs,
                  },
                }
              : u.gitFix !== undefined
                ? { gitFix: u.gitFix }
                : u.diskClean !== undefined && row.kind === 'disk.clean'
                  ? { diskClean: u.diskClean }
                  : u.usageRefresh !== undefined
                    ? { usageRefresh: { results: u.usageRefresh.results } }
                    : u.codeImages !== undefined
                      ? { codeImages: u.codeImages }
                      : u.prepare !== undefined
                        ? { prepare: redactDeep(u.prepare, this.#redactor) }
                        : u.manage !== undefined
                          ? { manage: redactDeep(u.manage, this.#redactor) }
                          : u.diagnostics !== undefined
                            ? { diagnostics: redactDeep(u.diagnostics, this.#redactor) }
                            : u.doctor !== undefined && row.kind === 'doctor.run'
                              ? { doctor: redactDeep(u.doctor, this.#redactor) }
                              : u.runtime !== undefined
                                ? { runtime: u.runtime }
                                : u.login?.status !== undefined
                                  ? {
                                      login: {
                                        runtime: u.login.runtime,
                                        status: u.login.status,
                                        ...(u.login.reason === undefined ? {} : { reason: u.login.reason }),
                                      },
                                    }
                                  : null;
    // p17-runtime-verify: progress results so far, or the final results with whether the evidence was stored (its
    // signature verified). The signed document itself lives in runtime_capability_evidence only.
    let verify: Record<string, unknown> | null = null;
    if (u.capabilityVerify !== undefined && row.kind === 'runtime.capabilities.verify') {
      if (u.capabilityVerify.final) {
        const e = u.capabilityVerify.signed.evidence;
        const stored = (await this.deps
          .onCapabilityVerify?.()
          ?.onVerifyUpdate({
            session,
            opId: u.commandId,
            params: row.params,
            signed: u.capabilityVerify.signed,
          })
          .catch(() => ({ stored: false, reason: 'store_failed' }))) ?? { stored: false, reason: 'no_store' };
        verify = {
          capabilityVerify: {
            final: true,
            results: redactDeep(e.results, this.#redactor),
            usage: e.usage,
            durationMs: e.durationMs,
            ...(e.stoppedBy === undefined ? {} : { stoppedBy: e.stoppedBy }),
            evidenceStored: stored.stored,
            ...(stored.reason === undefined ? {} : { evidenceRefused: stored.reason }),
          },
        };
      } else {
        verify = {
          capabilityVerify: { final: false, results: redactDeep(u.capabilityVerify.results, this.#redactor) },
        };
      }
    }
    // p16-runtime-updates: the unverified install's lock hash and the verification checks (never the lock bytes).
    const result: Record<string, unknown> | null =
      verify !== null
        ? { ...(base ?? {}), ...verify }
        : u.runtimeInstall === undefined && u.runtimeVerify === undefined
          ? base
          : {
              ...(base ?? {}),
              ...(u.runtimeInstall === undefined
                ? {}
                : {
                    runtimeInstall: {
                      unverified: u.runtimeInstall.unverified,
                      ...(u.runtimeInstall.lockSha256 === undefined
                        ? {}
                        : { lockSha256: u.runtimeInstall.lockSha256 }),
                      lockProduced: u.runtimeInstall.lock !== undefined,
                    },
                  }),
              ...(u.runtimeVerify === undefined
                ? {}
                : {
                    runtimeVerify: {
                      passed: u.runtimeVerify.passed,
                      checks: u.runtimeVerify.checks,
                      ...(u.runtimeVerify.lockSha256 === undefined
                        ? {}
                        : { lockSha256: u.runtimeVerify.lockSha256 }),
                    },
                  }),
            };
    await this.deps.pool.query(
      `UPDATE worker_ops
          SET state = $3, reason = $4, detail = $5, progress = COALESCE($6, progress),
              result = COALESCE($7, result), last_seq = $8, updated_at = $9,
              finished_at = CASE WHEN $10 THEN $9 ELSE finished_at END
        WHERE id = $1 AND worker_id = $2`,
      [
        u.commandId,
        session.workerId,
        u.state,
        u.reason ?? null,
        u.detail === undefined ? null : this.#redactor.redact(u.detail).slice(0, 500),
        u.progress === undefined ? null : JSON.stringify(u.progress),
        result === null ? null : JSON.stringify(result),
        u.seq,
        now,
        terminal,
      ],
    );
    // p17-disk-selfclean: the run is the machine page's "last cleanup" right away (CAPABILITIES follows anyway).
    if (u.diskClean !== undefined && row.kind === 'disk.clean') {
      await this.deps.pool.query(
        `UPDATE workers SET disk_hygiene = jsonb_set(disk_hygiene, '{lastRun}', $2::jsonb), disk_hygiene_at = $3
          WHERE id = $1 AND jsonb_typeof(disk_hygiene) = 'object'`,
        [session.workerId, JSON.stringify(u.diskClean), now],
      );
    }
    // p17-worker-managed: the removal / helper service learns the outcome (revoke after an accepted removal).
    if (terminal && (row.kind === 'worker.uninstall' || row.kind === 'helper.manage')) {
      await this.deps
        .onManageFinished?.({
          workerId: session.workerId,
          opId: u.commandId,
          kind: row.kind,
          state: u.state,
          reason: u.reason ?? null,
          detail: u.detail === undefined ? null : this.#redactor.redact(u.detail).slice(0, 500),
        })
        .catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'removal / helper outcome not processed');
        });
    }
    // p15-git-central: the readiness after a fix is the Git card's new state (CAPABILITIES follows anyway).
    if (u.gitFix !== undefined) {
      await this.deps.pool.query(
        'UPDATE workers SET git_readiness = $2, git_readiness_at = $3 WHERE id = $1',
        [session.workerId, JSON.stringify(u.gitFix.readiness), now],
      );
    }
    if (
      terminal &&
      row.kind !== 'logs.tail' &&
      row.kind !== 'diagnostics.run' &&
      row.kind !== 'doctor.run' &&
      row.kind !== 'login.status' &&
      row.kind !== 'machine.inspect' &&
      row.kind !== 'tools.detect' &&
      row.kind !== 'usage.refresh'
    ) {
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'worker.ops.result',
        target: `worker:${session.workerId}`,
        outcome: u.state === 'succeeded' ? 'success' : u.state === 'refused' ? 'denied' : 'failure',
        metadata: {
          opId: u.commandId,
          kind: u.kind,
          state: u.state,
          ...(u.reason ? { reason: u.reason } : {}),
        },
      });
    }
    this.deps.log.info(
      { workerId: session.workerId, opId: u.commandId, kind: u.kind, state: u.state, reason: u.reason },
      'remote operation update',
    );
    // p5-claude-auth-health: a finished login / check / logout carries the runtime's login state; it goes into
    // the stored report right away (the next CAPABILITIES may come later than the panel's refresh).
    if (terminal && u.login?.status !== undefined) {
      const account = u.login.account;
      if (account === undefined || account === 'default') {
        await this.#recordLogin(session.workerId, {
          runtime: u.login.runtime,
          status: u.login.status,
          checkedAt: now.toISOString(),
          ...(u.login.reason === undefined ? {} : { reason: u.login.reason }),
        });
      } else {
        // p13-runtime-accounts: an added account's login state (the stored account row).
        await this.deps.pool.query(
          `UPDATE runtime_accounts SET login_status = $4, login_reason = $5, login_checked_at = $6
            WHERE worker_id = $1 AND runtime = $2 AND account_id = $3`,
          [session.workerId, u.login.runtime, account, u.login.status, u.login.reason ?? null, now],
        );
      }
    }
    // p14-mcp-core: the tools a probe found go to the MCP catalog (untrusted text); a failure is shown on the server.
    if (terminal && row.kind === 'mcp.probe') {
      try {
        await this.deps.onMcpProbe?.()?.onProbeFinished({
          workerId: session.workerId,
          opId: u.commandId,
          params: row.params,
          state: u.state,
          reason: u.reason ?? null,
          report: u.mcpProbe,
        });
      } catch (err) {
        this.deps.log.warn(
          { err, workerId: session.workerId, opId: u.commandId },
          'MCP probe result not stored',
        );
      }
    }
    // p14-mcp-stdio: install state per machine (every update) and, on success, the canary's lockfile.
    if (row.kind === 'mcp.install' || row.kind === 'mcp.remove') {
      try {
        await this.deps.onMcpInstall?.()?.onInstallUpdate({
          workerId: session.workerId,
          opId: u.commandId,
          kind: row.kind,
          params: row.params,
          state: u.state,
          reason: u.reason ?? null,
          detail: u.detail === undefined ? null : this.#redactor.redact(u.detail).slice(0, 300),
          report: u.mcpInstall,
        });
      } catch (err) {
        this.deps.log.warn(
          { err, workerId: session.workerId, opId: u.commandId },
          'MCP install result not stored',
        );
      }
    }
    // p16-runtime-updates: the lock of an unverified install / the checks of a verification run.
    if (
      terminal &&
      (row.kind === 'runtime.verify' ||
        (row.kind === 'runtime.install' && row.params.unverified !== undefined))
    ) {
      try {
        await this.deps.onRuntimeUpdate?.()?.onRuntimeUpdate({
          workerId: session.workerId,
          opId: u.commandId,
          kind: row.kind,
          params: row.params,
          state: u.state,
          reason: u.reason ?? null,
          detail: u.detail === undefined ? null : this.#redactor.redact(u.detail).slice(0, 300),
          install: u.runtimeInstall,
          verify: u.runtimeVerify,
        });
      } catch (err) {
        this.deps.log.warn(
          { err, workerId: session.workerId, opId: u.commandId },
          'runtime update result not stored',
        );
      }
    }
    // p5-sandbox-ops: login → auth (the configuration change is audited with cause `login`). Only the configured
    // login (an added account is already in the configuration).
    if (
      row.kind === 'login.start' &&
      u.state === 'succeeded' &&
      row.params.account === undefined &&
      this.deps.onLoginSucceeded !== undefined
    ) {
      const rt = LoginRuntimeSchema.safeParse(row.params.runtime);
      if (rt.success) await this.deps.onLoginSucceeded(session.workerId, rt.data);
    }
  }
}

/** The runtimes a login can be started for (exported for the routes). */
export const LOGIN_RUNTIMES: readonly LoginRuntime[] = ['claude-code', 'codex'];
export const ALL_OPS_KINDS: readonly OpsKind[] = OPS_KINDS;
export type { RuntimeKind };

function specIdOf(spec: string): { id: unknown; version: unknown; transport: unknown } {
  try {
    const s = JSON.parse(Buffer.from(spec, 'base64').toString('utf8')) as Record<string, unknown>;
    return { id: s.id ?? null, version: s.version ?? null, transport: s.transport ?? null };
  } catch {
    return { id: null, version: null, transport: null };
  }
}

/** p14-mcp-stdio: the transport the probed spec declares (the worker verifies the signature itself). */
function mcpProbeTransport(op: Extract<OpsOperation, { kind: 'mcp.probe' }>): unknown {
  return specIdOf(op.server.spec).transport;
}

/** Stored parameters of an `mcp.install`: server id, version, spec hash and the sent lock's hash (never bytes). */
function mcpInstallParams(op: Extract<OpsOperation, { kind: 'mcp.install' }>): Record<string, unknown> {
  const s = specIdOf(op.server.spec);
  return {
    serverId: typeof s.id === 'string' ? s.id : null,
    version: typeof s.version === 'string' ? s.version : null,
    specSha256: createHash('sha256').update(Buffer.from(op.server.spec, 'base64')).digest('hex'),
    lockSha256: op.lock?.sha256 ?? null,
  };
}

/** Stored parameters of an `mcp.probe`: server id, version and spec hash, the secret slots (never the spec bytes). */
function mcpProbeParams(op: Extract<OpsOperation, { kind: 'mcp.probe' }>): Record<string, unknown> {
  let id: unknown = null;
  let version: unknown = null;
  try {
    const spec = JSON.parse(Buffer.from(op.server.spec, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    id = typeof spec.id === 'string' ? spec.id : null;
    version = typeof spec.version === 'string' ? spec.version : null;
  } catch {
    // An unreadable spec is refused by the worker; the row still records the op.
  }
  return {
    serverId: id,
    version,
    specSha256: createHash('sha256').update(Buffer.from(op.server.spec, 'base64')).digest('hex'),
    slots: op.secrets.map((x) => x.slot),
  };
}

/** p16-runtime-updates: a system actor (the automatic verification) is audited as such, never as a user. */
function actorOf(actor: ActorContext): { type: 'user' | 'system'; id: string } {
  return actor.system === undefined
    ? { type: 'user', id: actor.userId }
    : { type: 'system', id: actor.system };
}
