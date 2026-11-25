import {
  type LeaseKey,
  RuntimeKind,
  SANDBOX_OPS_FEATURE,
  UNCONFINED_PARALLEL_FEATURE,
  SandboxStatusReport,
  type SandboxProfile,
} from '@remyral/protocol';
import { isSafeCommandsMode, type SafeCommandsMode } from '@remyral/protocol/safe-commands';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { randomUUID } from 'node:crypto';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { OpView, RemoteOpsService } from '../remote-ops/service.js';
import type { WorkerConfigService, WorkerConfigView } from '../worker-config/service.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';
import { OUTBOX_TOPIC_PROJECT_EXECUTION, type ProjectExecutionOutboxPayload } from './outbox.js';

/**
 * p5-sandbox-ops (ADR-0019, docs/design/p5-sandbox-ops.md): the Fleet "Sandbox" card, its Prepare action, the
 * per-worker `unconfined` switch and the per-project execution policy (host-native / unconfined opt-ins).
 */

export interface WorkerSandboxView {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  /** The worker reports sandboxStatus and runs sandbox.prepare (`sandbox-ops-v1`). */
  readonly supported: boolean;
  readonly status: SandboxStatusReport | null;
  readonly statusAt: string | null;
  /** Ready profiles as the worker reports them (CAPABILITIES.sandboxProfiles). */
  readonly readyProfiles: readonly string[];
  /** Panel configuration: unconfined allowed, and the generation the switch must name. */
  readonly unconfined: {
    readonly allowed: boolean;
    /** p19-unconfined-parallel: attempts without sandbox run in parallel on this machine (desired configuration). */
    readonly parallel: boolean;
    /** p19-unconfined-parallel: the worker build accepts the parallel setting (`unconfined-parallel-v1`). */
    readonly parallelSupported: boolean;
    readonly generation: number;
  };
  /** Some runtime of the desired configuration uses its local subscription login. */
  readonly localLogin: boolean;
  /** The latest sandbox.prepare operation (steps, result). */
  readonly lastPrepare: OpView | null;
}

export interface ProjectExecutionView {
  readonly project: string;
  /** ADR-0007: host-native profiles (host-restricted, runtime-sandbox) allowed. */
  readonly hostExecution: boolean;
  /** ADR-0019: the unconfined profile allowed (only on workers that allow it too). */
  readonly unconfined: boolean;
  /**
   * ADR-0020: jobs may use `approvalPolicy: "allow-all"` (no runtime tool call asks; the platform's own gates stay).
   * Only for trusted sources, only on `full-access-v1` workers.
   */
  readonly allowAutoApprove: boolean;
  /**
   * p6-safe-auto-approve: which runtime shell commands of `ask-sensitive` jobs the master approves on its own
   * (proven read-only, or also workspace writes). Every such approval is audited `approval.auto_safe`.
   */
  readonly safeCommands: SafeCommandsMode;
  /** p8-orchestration (ADR-0031): agents of this project's jobs may request sub-jobs (`request_subtask`). */
  readonly subtasks: boolean;
  /**
   * p8-orchestration: runtimes agent-chosen work (sub-jobs, planned workflow tasks) may use besides the requester's
   * own runtime. Empty = only its own.
   */
  readonly delegationRuntimes: RuntimeKind[];
}

/**
 * Input of `PUT /projects/:id/execution`; an absent `allowAutoApprove` or `safeCommands` keeps the current value
 * (older clients).
 */
export interface ProjectExecutionInput {
  readonly hostExecution: boolean;
  readonly unconfined: boolean;
  readonly allowAutoApprove?: boolean | undefined;
  readonly safeCommands?: SafeCommandsMode | undefined;
  /** p8-orchestration; absent keeps the current value. */
  readonly subtasks?: boolean | undefined;
  readonly delegationRuntimes?: readonly RuntimeKind[] | undefined;
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

export class SandboxOpsService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      readonly remoteOps: () => RemoteOpsService;
      readonly workerConfigs: () => WorkerConfigService;
      readonly session: (workerId: string) => WorkerSession | undefined;
      readonly leaseKeys: () => readonly LeaseKey[];
    },
  ) {}

  /** Public lease-signing keys, for the privileged helper's signature check (no secret). */
  leaseKeys(): { keys: LeaseKey[] } {
    return { keys: this.deps.leaseKeys().map((k) => ({ kid: k.kid, publicKey: k.publicKey })) };
  }

  async worker(workerId: string): Promise<WorkerSandboxView> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      display_name: string;
      state: string;
      features: unknown;
      sandbox_status: unknown;
      sandbox_status_at: Date | null;
      sandbox_profiles: unknown;
    }>(
      `SELECT id, display_name, state, features, sandbox_status, sandbox_status_at, sandbox_profiles FROM workers
        WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw new HttpError(404, 'worker_not_found', 'No such worker.');
    const parsed = SandboxStatusReport.safeParse(w.sandbox_status);
    const ops = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM worker_ops WHERE worker_id = $1 AND kind = 'sandbox.prepare'
        ORDER BY requested_at DESC LIMIT 1`,
      [workerId],
    );
    const lastId = ops.rows[0]?.id;
    const cfg = this.deps.workerConfigs();
    return {
      workerId: w.id,
      displayName: w.display_name,
      state: w.state,
      connected: this.deps.session(w.id) !== undefined,
      supported: features(w.features).includes(SANDBOX_OPS_FEATURE),
      status: parsed.success ? parsed.data : null,
      statusAt: w.sandbox_status_at?.toISOString() ?? null,
      readyProfiles: Array.isArray(w.sandbox_profiles)
        ? w.sandbox_profiles.filter((p): p is string => typeof p === 'string')
        : [],
      unconfined: {
        ...(await cfg.unconfinedAllowed(workerId)),
        // p19-unconfined-parallel: the worker build accepts the parallel setting.
        parallelSupported: features(w.features).includes(UNCONFINED_PARALLEL_FEATURE),
      },
      localLogin: await cfg.usesLocalLogin(workerId),
      lastPrepare: lastId === undefined ? null : await this.deps.remoteOps().op(workerId, lastId),
    };
  }

  /** Sends sandbox.prepare (signed); `localLogin` comes from the desired configuration, never from the client. */
  async prepare(workerId: string, privileged: boolean, actor: ActorContext): Promise<OpView> {
    const localLogin = await this.deps.workerConfigs().usesLocalLogin(workerId);
    return this.deps
      .remoteOps()
      .request(workerId, { kind: 'sandbox.prepare', privileged, localLogin }, actor);
  }

  async setUnconfined(
    workerId: string,
    input: {
      allow: boolean;
      parallel?: boolean | undefined;
      expectedGeneration: number;
      reason?: string | undefined;
    },
    actor: ActorContext,
  ): Promise<WorkerConfigView> {
    return this.deps.workerConfigs().setUnconfined(workerId, input, actor);
  }

  async projectExecution(project: string): Promise<ProjectExecutionView> {
    return readProjectExecution(this.deps.pool, project);
  }

  /**
   * The project's execution policy. Admin + always-fresh step-up (route); audited `project.execution.update` with
   * before / after, and (ADR-0020) a `project.execution` outbox event -> owners/admins are notified, critically when
   * unconfined or auto-approve is switched on. `unconfined` needs `hostExecution` (an unconfined job is a host job
   * without the confinement). `allowAutoApprove` is independent of the profile (a container job may run without
   * prompts too); the one-switch "Full access" preset of the panel sets all three.
   */
  async setProjectExecution(
    project: string,
    input: ProjectExecutionInput,
    actor: ActorContext,
  ): Promise<ProjectExecutionView> {
    if (input.unconfined && !input.hostExecution) {
      throw new HttpError(
        400,
        'unconfined_needs_host_execution',
        'Unconfined execution is a form of host execution; allow host execution too.',
      );
    }
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const before = await readProjectExecution(tx, project, true);
      const after: ProjectExecutionView = {
        project,
        hostExecution: input.hostExecution,
        unconfined: input.unconfined,
        allowAutoApprove: input.allowAutoApprove ?? before.allowAutoApprove,
        safeCommands: input.safeCommands ?? before.safeCommands,
        subtasks: input.subtasks ?? before.subtasks,
        delegationRuntimes:
          input.delegationRuntimes === undefined
            ? before.delegationRuntimes
            : [...new Set(input.delegationRuntimes)].sort(),
      };
      await tx.query(
        `UPDATE projects SET host_execution = $2, unconfined_execution = $3, auto_approve_execution = $4,
                safe_commands = $5, subtasks_enabled = $6, delegation_runtimes = $7
          WHERE id = $1`,
        [
          project,
          after.hostExecution,
          after.unconfined,
          after.allowAutoApprove,
          after.safeCommands,
          after.subtasks,
          after.delegationRuntimes,
        ],
      );
      const changeId = randomUUID();
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.execution.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: { changeId, before: flags(before), after: flags(after) },
        },
        tx,
      );
      if (JSON.stringify(flags(before)) !== JSON.stringify(flags(after))) {
        const payload: ProjectExecutionOutboxPayload = {
          project,
          changeId,
          userId: actor.userId,
          before: flags(before),
          after: flags(after),
        };
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
          OUTBOX_TOPIC_PROJECT_EXECUTION,
          JSON.stringify(payload),
          this.deps.clock(),
        ]);
      }
      return { before, after };
    });
    if (result.after.unconfined && !result.before.unconfined) {
      this.deps.log.warn({ project }, 'project allows the unconfined profile');
    }
    if (result.after.allowAutoApprove && !result.before.allowAutoApprove) {
      this.deps.log.warn({ project }, 'project allows auto-approve (approval policy allow-all)');
    }
    if (result.after.subtasks && !result.before.subtasks) {
      this.deps.log.warn({ project }, 'project lets agents request sub-jobs');
    }
    return result.after;
  }
}

function flags(v: ProjectExecutionView): {
  hostExecution: boolean;
  unconfined: boolean;
  allowAutoApprove: boolean;
  safeCommands: SafeCommandsMode;
  subtasks: boolean;
  delegationRuntimes: string[];
} {
  return {
    hostExecution: v.hostExecution,
    unconfined: v.unconfined,
    allowAutoApprove: v.allowAutoApprove,
    safeCommands: v.safeCommands,
    subtasks: v.subtasks,
    delegationRuntimes: [...v.delegationRuntimes],
  };
}

/** A project's execution policy (404 when the project does not exist). */
export async function readProjectExecution(
  db: Queryable,
  project: string,
  forUpdate = false,
): Promise<ProjectExecutionView> {
  const { rows } = await db.query<{
    id: string;
    host_execution: boolean;
    unconfined_execution: boolean;
    auto_approve_execution: boolean;
    safe_commands: string;
    subtasks_enabled: boolean;
    delegation_runtimes: string[];
  }>(
    `SELECT id, host_execution, unconfined_execution, auto_approve_execution, safe_commands, subtasks_enabled,
            delegation_runtimes FROM projects WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [project],
  );
  const p = rows[0];
  if (p === undefined)
    throw new HttpError(404, 'project_not_found', 'No such project.', {}, {}, { reason: 'no_such' });
  return {
    project: p.id,
    hostExecution: p.host_execution,
    unconfined: p.unconfined_execution,
    allowAutoApprove: p.auto_approve_execution,
    // A value the code does not know (newer schema) fails closed to `off`.
    safeCommands: isSafeCommandsMode(p.safe_commands) ? p.safe_commands : 'off',
    subtasks: p.subtasks_enabled,
    delegationRuntimes: p.delegation_runtimes.filter(
      (r): r is RuntimeKind => RuntimeKind.safeParse(r).success,
    ),
  };
}

/** Profiles a project's policy lets a job ask for (placement explanations). */
export function profileAllowedByProject(
  profile: SandboxProfile,
  p: { readonly hostExecution: boolean; readonly unconfined: boolean },
): boolean {
  if (profile === 'container') return true;
  if (profile === 'unconfined') return p.unconfined;
  return p.hostExecution;
}
