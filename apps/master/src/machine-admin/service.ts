import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import {
  type AdminOp,
  adminOpDigest,
  adminOpSummary,
  type AssignedMachineAdmin,
  ELEVATED_RECIPES,
  elevatedRecipePrompt,
  ROOTLESS_DOCKER_TITLE,
  rootlessDockerPrompt,
  JobSpec,
  MACHINE_ADMIN_FEATURE,
  MACHINES_PROJECT,
  MachineAdminReport,
  MAX_ADMIN_GRANT_TTL_MS,
  MAX_ADMIN_SESSION_MS,
  MAX_MACHINE_MEMORY,
  normalizeAdminPurpose,
  normalizeJobTitle,
  SandboxStatusReport,
  type ToolRecipeId,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { ApprovalError } from '../approvals/errors.js';
import type { ApprovalService } from '../approvals/service.js';
import type { AuditRecorder } from '../audit/audit.js';
import { ContextError } from '../context/errors.js';
import type { ContextStore } from '../context/store.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import { projectAllowsAutoApprove } from '../jobs/store.js';
import type { LeaseSigner } from '../orchestration/lease-signer.js';
import type { MachineAdminAssigner } from '../orchestration/orchestrator.js';
import type { RemoteOpsService } from '../remote-ops/service.js';
import type { WorkerConfigService } from '../worker-config/service.js';
import type { ActorContext } from '../workers/fleet.js';
import type { WorkerSession } from '../workers/types.js';
import { EFFECTIVE_APPROVAL_POLICY_SQL } from '../jobs/approval-mode-sql.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';

/** The Linux installer's service user (infra/worker/linux/install.sh SERVICE_USER). */
const INSTALLER_LINUX_USER = 'remyral-worker';

/**
 * AI machine administration, master side (p5-machine-admin, ADR-0021, docs/design/p5-machine-admin.md).
 *
 * - The owner switches it on per worker (WorkerConfigService.setMachineAdmin: always-fresh, audited, critical
 *   notification); the machine can veto it locally.
 * - An admin starts a machine-admin job (always-fresh): a workspace job of the built-in `machines` project, pinned
 *   to the one worker, Claude Code, `ask-all` by default.
 * - At dispatch the job gets a signed session grant (the root/SYSTEM helper starts the elevated broker only for it)
 *   and the machine's memory.
 * - Each elevated command the agent asks for arrives as MACHINE_ADMIN_REQUEST: fenced against the live lease,
 *   recorded (command log + audit), then auto-approved (job `allow-all` + the worker's and the Machines project's
 *   auto-approve) or put to an approval (`machine.admin`: admin + step-up). Only then is it signed — bound to the
 *   worker, job, attempt, epoch, request id, a 5-minute window and the operation digest — and answered with
 *   MACHINE_ADMIN_DECISION. The result comes back as MACHINE_ADMIN_RESULT (redacted again here, audited).
 */

const SYSTEM = { type: 'system', id: 'machine-admin' } as const;
const ACTIVE_STATES = [
  'DRAFT',
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'AWAITING_APPROVAL',
];
const MAX_COMMANDS_LISTED = 50;

export interface MachineCommandView {
  readonly requestId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly kind: AdminOp['kind'];
  readonly summary: string;
  /** p17-worker-1-1-1: the agent's stated purpose (unverified, redacted), null for older workers. */
  readonly purpose: string | null;
  readonly state: string;
  readonly autoApproved: boolean;
  readonly approvalId: string | null;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly file: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MachineMemoryView {
  readonly docId: string | null;
  readonly version: number;
  readonly content: string;
  readonly updatedAt: string | null;
}

export interface MachineAdminView {
  readonly workerId: string;
  readonly displayName: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly desired: { readonly enabled: boolean; readonly autoApprove: boolean; readonly generation: number };
  readonly reported: MachineAdminReport | null;
  readonly reportedAt: string | null;
  readonly projectAutoApprove: boolean;
  readonly activeJob: { readonly jobId: string; readonly state: string; readonly title: string } | null;
  readonly commands: MachineCommandView[];
  readonly memory: MachineMemoryView;
}

export interface MachineTaskInput {
  readonly title?: string | undefined;
  readonly prompt?: string | undefined;
  readonly approvalPolicy?: 'ask-all' | 'allow-all' | undefined;
  readonly maxDurationSec?: number | undefined;
  readonly recipe?: { readonly tool: ToolRecipeId; readonly version?: string | undefined } | undefined;
  /** The ops chat draft this task came from (audit). */
  readonly draftId?: string | undefined;
  /**
   * p17-worker-managed Part 4: a fixed setup task of this release instead of a free prompt — `rootless-docker` (Linux):
   * rootless Docker for the worker's service user, every elevated command approved per command.
   */
  readonly setup?: 'rootless-docker' | undefined;
  /**
   * p19-chat-machine-admin: the job was started by the user's OWN chat message while the security policy's
   * `autonomy.chatMachineAdmin` was on — its elevated commands pass by policy (re-checked per command: the switch still
   * on, the user still an active owner / admin) instead of waiting for a human approval.
   */
  readonly chatGrant?:
    | {
        readonly userId: string;
        readonly draftId?: string | undefined;
        readonly threadId?: string | undefined;
        /**
         * p20-scope-preview: started by a continuation turn that inherited the user turn's grant — its commands pass
         * only while that goal grant is not revoked and `autonomy.goalGrants` stays on.
         */
        readonly goalGrantId?: string | undefined;
      }
    | undefined;
}

/** p19-chat-machine-admin: why an elevated command passed without a human (audit and the command's state). */
export const CHAT_MACHINE_ADMIN_REASON =
  'autonomy.chatMachineAdmin: the user asked for this machine work in their own chat message';

interface CommandRow {
  request_id: string;
  job_id: string;
  attempt_id: string;
  epoch: number;
  worker_id: string;
  kind: AdminOp['kind'];
  op: Record<string, unknown>;
  op_digest: string;
  summary: string;
  purpose: string | null;
  state: string;
  auto_approved: boolean;
  approval_id: string | null;
  reason: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  output: string | null;
  truncated: boolean;
  file: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const COMMAND_COLUMNS = `request_id::text AS request_id, job_id::text AS job_id, attempt_id::text AS attempt_id, epoch,
  worker_id, kind, op, op_digest, summary, purpose, state, auto_approved, approval_id::text AS approval_id, reason, exit_code,
  duration_ms, output, truncated, file, created_at, updated_at`;

function commandView(r: CommandRow): MachineCommandView {
  return {
    requestId: r.request_id,
    jobId: r.job_id,
    attemptId: r.attempt_id,
    kind: r.kind,
    summary: r.summary,
    purpose: r.purpose,
    state: r.state,
    autoApproved: r.auto_approved,
    approvalId: r.approval_id,
    reason: r.reason,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    file: r.file,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** What is stored of an operation: everything but file content (its size and SHA-256 instead). */
export function storedOp(op: AdminOp): Record<string, unknown> {
  if (op.kind !== 'write_file') return { ...op };
  const bytes = Buffer.from(op.content, 'base64');
  return {
    kind: op.kind,
    path: op.path,
    mode: op.mode,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * p17-worker-1-1-1 / p10-approval-readable: the structured approval details of an elevated command — the agent's
 * purpose as `description` (shown above the command, labelled as its unverified explanation), the exact command and
 * shell, or the file path. Display only: the approval binds the request id and the master signs the operation digest.
 */
export function adminApprovalDetails(op: AdminOp, purpose: string | null): Record<string, unknown> {
  const description = purpose === null ? {} : { description: purpose };
  if (op.kind === 'exec') {
    return {
      tool: 'admin_exec',
      ...description,
      command: op.command,
      shell: op.shell === 'sh' || op.shell === 'bash' ? 'posix' : op.shell,
      ...(op.cwd === undefined ? {} : { cwd: op.cwd }),
    };
  }
  return {
    tool: op.kind === 'write_file' ? 'admin_write_file' : 'admin_read_file',
    ...description,
    paths: [op.path],
  };
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

export interface MachineAdminDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly signer: LeaseSigner;
  readonly jobs: JobStore;
  readonly approvals: ApprovalService;
  readonly context: ContextStore;
  readonly workerConfigs: () => WorkerConfigService;
  readonly remoteOps: () => RemoteOpsService | null;
  readonly dispatch: (jobId: string) => Promise<unknown>;
  readonly session: (workerId: string) => WorkerSession | undefined;
  /** p19-chat-machine-admin: the switch read per elevated command (absent: no command passes by policy). */
  readonly securityPolicy?: SecurityPolicyReader;
}

export class MachineAdminService implements MachineAdminAssigner {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(private readonly deps: MachineAdminDeps) {}

  // ------------------------------------------------------------------------------------------- reads

  async #worker(workerId: string): Promise<{
    id: string;
    display_name: string;
    features: unknown;
    machine_admin: unknown;
    machine_admin_at: Date | null;
    sandbox_status: unknown;
    os: string | null;
  }> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      display_name: string;
      features: unknown;
      machine_admin: unknown;
      machine_admin_at: Date | null;
      sandbox_status: unknown;
      os: string | null;
    }>(
      `SELECT id, display_name, features, machine_admin, machine_admin_at, sandbox_status, facts->>'os' AS os FROM workers
        WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw new HttpError(404, 'worker_not_found', 'No such worker.');
    return w;
  }

  async memory(workerId: string): Promise<MachineMemoryView> {
    const m = await this.deps.context.machineMemory(workerId);
    return m === null
      ? { docId: null, version: 0, content: '', updatedAt: null }
      : { docId: m.docId, version: m.version, content: m.content, updatedAt: m.updatedAt.toISOString() };
  }

  async view(workerId: string): Promise<MachineAdminView> {
    const w = await this.#worker(workerId);
    const desired = await this.deps.workerConfigs().machineAdmin(workerId);
    const reported = MachineAdminReport.safeParse(w.machine_admin);
    const { rows } = await this.deps.pool.query<CommandRow>(
      `SELECT ${COMMAND_COLUMNS} FROM machine_admin_commands WHERE worker_id = $1
        ORDER BY created_at DESC LIMIT ${String(MAX_COMMANDS_LISTED)}`,
      [workerId],
    );
    const active = await this.#activeJob(workerId);
    return {
      workerId: w.id,
      displayName: w.display_name,
      connected: this.deps.session(w.id) !== undefined,
      supported: features(w.features).includes(MACHINE_ADMIN_FEATURE),
      desired,
      reported: reported.success ? reported.data : null,
      reportedAt: w.machine_admin_at?.toISOString() ?? null,
      projectAutoApprove: await projectAllowsAutoApprove(this.deps.pool, MACHINES_PROJECT),
      activeJob: active,
      commands: rows.map(commandView),
      memory: await this.memory(workerId),
    };
  }

  async command(
    workerId: string,
    requestId: string,
  ): Promise<MachineCommandView & { op: Record<string, unknown>; output: string; truncated: boolean }> {
    const { rows } = await this.deps.pool.query<CommandRow>(
      `SELECT ${COMMAND_COLUMNS} FROM machine_admin_commands WHERE worker_id = $1 AND request_id::text = $2`,
      [workerId, requestId],
    );
    const r = rows[0];
    if (r === undefined)
      throw new HttpError(404, 'command_not_found', 'No such elevated command on this worker.');
    return {
      ...commandView(r),
      op: r.op,
      output: this.#redactor.redact(r.output ?? ''),
      truncated: r.truncated,
    };
  }

  async #activeJob(workerId: string): Promise<{ jobId: string; state: string; title: string } | null> {
    const { rows } = await this.deps.pool.query<{ id: string; state: string; prompt: string }>(
      `SELECT id::text AS id, state, spec->>'prompt' AS prompt FROM jobs
        WHERE project = $1 AND spec->>'kind' = 'machine-admin' AND spec->'machineAdmin'->>'workerId' = $2
          AND state = ANY($3) ORDER BY created_at DESC LIMIT 1`,
      [MACHINES_PROJECT, workerId, ACTIVE_STATES],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const title = /^Task: (.{1,200})$/m.exec(r.prompt)?.[1] ?? 'machine administration';
    return { jobId: r.id, state: r.state, title };
  }

  // ------------------------------------------------------------------------------------------ writes

  async setEnabled(
    workerId: string,
    input: {
      enabled: boolean;
      autoApprove: boolean;
      expectedGeneration: number;
      reason?: string | undefined;
    },
    actor: ActorContext,
  ): Promise<MachineAdminView> {
    await this.deps.workerConfigs().setMachineAdmin(workerId, input, actor);
    return this.view(workerId);
  }

  /** The sandbox profile a machine-admin job asks for: the best one ready on the worker. */
  #profile(rawStatus: unknown): JobSpec['sandboxProfile'] {
    const st = SandboxStatusReport.safeParse(rawStatus);
    const ready = new Set(st.success ? st.data.profiles.filter((p) => p.ready).map((p) => p.profile) : []);
    for (const p of ['host-restricted', 'runtime-sandbox', 'container'] as const) if (ready.has(p)) return p;
    return 'host-restricted';
  }

  async createTask(
    workerId: string,
    input: MachineTaskInput,
    actor: ActorContext,
  ): Promise<{ jobId: string; state: string }> {
    const w = await this.#worker(workerId);
    const refuse = async (code: string, message: string): Promise<never> => {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'machine.admin.task',
        target: `worker:${workerId}`,
        outcome: 'denied',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reason: code },
      });
      throw new HttpError(409, code, message);
    };
    if (!features(w.features).includes(MACHINE_ADMIN_FEATURE)) {
      return refuse(
        'worker_update_required',
        'This worker build cannot run machine administration jobs; update it first.',
      );
    }
    const desired = await this.deps.workerConfigs().machineAdmin(workerId);
    if (!desired.enabled) {
      return refuse(
        'machine_admin_not_enabled',
        'Machine administration is not enabled for this worker (the owner enables it in Machines > <machine> > Admin > Machine admin).',
      );
    }
    const reported = MachineAdminReport.safeParse(w.machine_admin);
    if (reported.success && reported.data.localVeto) {
      return refuse('machine_admin_not_enabled', 'The machine forbids machine administration locally.');
    }
    if (reported.success && reported.data.helper === 'missing') {
      return refuse(
        'helper_missing',
        reported.data.helperDetail ??
          'The privileged helper on this machine cannot run admin sessions; re-run the installer kit of this release once.',
      );
    }
    const policy = input.approvalPolicy ?? 'ask-all';
    if (
      policy === 'allow-all' &&
      !(desired.autoApprove && (await projectAllowsAutoApprove(this.deps.pool, MACHINES_PROJECT)))
    ) {
      return refuse(
        'auto_approve_not_allowed',
        'Commands without approval need auto-approve on the machine (Machines > <machine> > Admin > Machine admin) and on the Machines project (Projects > machines > Policy > Execution policy).',
      );
    }
    if ((await this.#activeJob(workerId)) !== null) {
      return refuse('machine_admin_busy', 'A machine administration job of this worker is still open.');
    }
    let title = (input.title ?? '').trim();
    let prompt = (input.prompt ?? '').trim();
    if (input.recipe !== undefined) {
      const recipe = ELEVATED_RECIPES.find(
        (r) =>
          r.tool === input.recipe?.tool &&
          (input.recipe.version === undefined || r.version === input.recipe.version),
      );
      if (recipe === undefined)
        throw new HttpError(
          400,
          'recipe_not_found',
          'No elevated recipe for this tool.',
          {},
          {},
          { reason: 'elevated' },
        );
      title = title === '' ? `Install ${recipe.title}` : title;
      prompt = `${elevatedRecipePrompt(recipe)}${prompt === '' ? '' : `\n\nAdditional instructions from the owner:\n${prompt}`}`;
    }
    if (input.setup === 'rootless-docker') {
      if (w.os !== 'linux') {
        return refuse('setup_unsupported_os', 'Rootless Docker is set up on Linux machines only.');
      }
      // Fixed steps of this release; the owner's prompt is only appended as additional instructions.
      title = title === '' ? ROOTLESS_DOCKER_TITLE : title;
      prompt = `${rootlessDockerPrompt(INSTALLER_LINUX_USER)}${prompt === '' ? '' : `\n\nAdditional instructions from the owner:\n${prompt}`}`;
    }
    if (title === '' || prompt === '')
      throw new HttpError(400, 'invalid_task', 'A title and a prompt are required.');
    const spec = {
      runtime: 'claude-code',
      prompt: `Task: ${title.slice(0, 200)}\n\n${prompt}`,
      // p15-job-titles: the task's title names the job.
      ...(normalizeJobTitle(title) === null ? {} : { title: normalizeJobTitle(title) }),
      sandboxProfile: this.#profile(w.sandbox_status),
      approvalPolicy: policy,
      limits: { maxDurationSec: Math.min(Math.max(input.maxDurationSec ?? 3600, 60), 12 * 3600) },
      sourceTrust: 'trusted',
      kind: 'machine-admin',
      machineAdmin: { workerId },
      requirements: { workers: [workerId] },
    };
    const { job } = await this.deps.jobs.create({
      project: MACHINES_PROJECT,
      spec,
      actor: { type: 'user', id: actor.userId },
      submit: true,
      machineAdmin: true,
    });
    if (input.chatGrant !== undefined) {
      // p19-chat-machine-admin: before the dispatch, so the job's first elevated command already finds it.
      await this.deps.pool.query(
        `INSERT INTO machine_admin_chat_grants (job_id, user_id, draft_id, thread_id, created_at, goal_grant_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (job_id) DO NOTHING`,
        [
          job.id,
          input.chatGrant.userId,
          input.chatGrant.draftId ?? null,
          input.chatGrant.threadId ?? null,
          this.deps.clock(),
          input.chatGrant.goalGrantId ?? null,
        ],
      );
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'machine.admin.task',
      target: `worker:${workerId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        jobId: job.id,
        approvalPolicy: policy,
        title: title.slice(0, 200),
        ...(input.recipe === undefined ? {} : { recipe: input.recipe.tool }),
        ...(input.setup === undefined ? {} : { setup: input.setup }),
        ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
        ...(input.chatGrant === undefined
          ? {}
          : {
              commandsApprovedBy: 'policy',
              policy: 'autonomy.chatMachineAdmin',
              via: 'chat',
              ...(input.chatGrant.goalGrantId === undefined
                ? {}
                : { inherited: { goalGrantId: input.chatGrant.goalGrantId } }),
            }),
      },
    });
    void this.deps.dispatch(job.id).catch(() => undefined);
    return { jobId: job.id, state: job.state };
  }

  async editMemory(
    workerId: string,
    input: { content: string; expectedVersion: number },
    actor: ActorContext,
  ): Promise<MachineMemoryView> {
    await this.#worker(workerId);
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        const out = await this.deps.context.writeMachineMemory(
          tx,
          workerId,
          { mode: 'replace', content: input.content, expectedVersion: input.expectedVersion },
          { type: 'user', userId: actor.userId },
          MAX_MACHINE_MEMORY,
        );
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'machine.memory.edit',
            target: `worker:${workerId}`,
            outcome: 'success',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: { docId: out.docId, version: out.version, contentHash: out.contentHash },
          },
          tx,
        );
        return out;
      });
    } catch (err) {
      if (err instanceof ContextError) throw new HttpError(err.httpStatus, err.code, err.publicMessage);
      throw err;
    }
    return this.memory(workerId);
  }

  // ---------------------------------------------------------------------------------- orchestration

  /** ASSIGN_JOB.machineAdmin: signed session grant (≤ 12 h), machine memory, whether commands are auto-approved. */
  async assignment(
    job: JobRecord,
    attemptId: string,
    epoch: number,
    workerId: string,
  ): Promise<AssignedMachineAdmin | undefined> {
    if (job.spec.kind !== 'machine-admin' || job.spec.machineAdmin?.workerId !== workerId) return undefined;
    const now = this.deps.clock();
    const sessionId = randomUUID();
    const issuedAt = now.toISOString();
    const ttl = Math.min(job.spec.limits.maxDurationSec * 1000 + 15 * 60_000, MAX_ADMIN_SESSION_MS);
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    const signature = this.deps.signer.signAdminSession({
      workerId,
      jobId: job.id,
      attemptId,
      epoch,
      sessionId,
      issuedAt,
      expiresAt,
    });
    // p19-chat-machine-admin: a job the user's own chat message started runs its commands by policy (prompt text).
    const autoApprove = (await this.#autoApprove(job, workerId)) || (await this.#chatGrant(job.id)) !== null;
    const memory = (await this.deps.context.machineMemory(workerId))?.content ?? '';
    await this.deps.audit.record({
      actor: SYSTEM,
      action: 'machine.admin.session',
      target: `job:${job.id}`,
      outcome: 'success',
      metadata: { workerId, attemptId, epoch, sessionId, expiresAt, autoApprove },
    });
    return {
      session: { sessionId, issuedAt, expiresAt, signature },
      memory: memory.slice(-MAX_MACHINE_MEMORY),
      autoApprove,
    };
  }

  async #autoApprove(job: Pick<JobRecord, 'spec'>, workerId: string): Promise<boolean> {
    if (job.spec.approvalPolicy !== 'allow-all') return false;
    const desired = await this.deps.workerConfigs().machineAdmin(workerId);
    return (
      desired.enabled &&
      desired.autoApprove &&
      (await projectAllowsAutoApprove(this.deps.pool, MACHINES_PROJECT))
    );
  }

  /**
   * p19-chat-machine-admin: the chat grant of a machine administration job that still holds — the job was started by
   * the user's own chat message, the security policy's `autonomy.chatMachineAdmin` is on NOW and that user is still an
   * active owner / admin. Null otherwise (the command asks a human as before).
   */
  async #chatGrant(
    jobId: string,
  ): Promise<{ userId: string; draftId: string | null; goalGrantId: string | null } | null> {
    const reader = this.deps.securityPolicy;
    if (reader === undefined) return null;
    // p20-scope-preview: a job started under an inherited goal grant needs that grant unrevoked.
    const { rows } = await this.deps.pool.query<{
      user_id: string;
      draft_id: string | null;
      goal_grant_id: string | null;
    }>(
      `SELECT g.user_id::text AS user_id, g.draft_id::text AS draft_id, g.goal_grant_id::text AS goal_grant_id
         FROM machine_admin_chat_grants g JOIN users u ON u.id = g.user_id
        WHERE g.job_id::text = $1 AND u.disabled_at IS NULL AND u.role IN ('owner', 'admin')
          AND (g.goal_grant_id IS NULL OR EXISTS (
                SELECT 1 FROM chat_goal_grants c WHERE c.id = g.goal_grant_id AND c.revoked_at IS NULL))`,
      [jobId],
    );
    const g = rows[0];
    if (g === undefined) return null;
    try {
      const a = (await reader.current()).autonomy;
      if (!a.chatMachineAdmin) return null;
      if (g.goal_grant_id !== null && !a.goalGrants) return null;
    } catch {
      return null; // fail closed: a human decides
    }
    return { userId: g.user_id, draftId: g.draft_id, goalGrantId: g.goal_grant_id };
  }

  // --------------------------------------------------------------------------------- worker messages

  /** CAPABILITIES.machineAdmin and .toolInventory. */
  async onReport(
    session: WorkerSession,
    payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
  ): Promise<void> {
    if (payload.machineAdmin !== undefined) {
      await this.deps.pool.query(
        'UPDATE workers SET machine_admin = $2, machine_admin_at = $3 WHERE id = $1',
        [session.workerId, JSON.stringify(payload.machineAdmin), this.deps.clock()],
      );
    }
    await this.deps.remoteOps()?.onToolsReport(session, payload.toolInventory);
  }

  async #send(
    session: WorkerSession,
    jobId: string,
    payload: Parameters<WorkerSession['send']>[1] & Record<string, unknown>,
  ): Promise<void> {
    try {
      await session.send('MACHINE_ADMIN_DECISION', payload as never, { jobId });
    } catch (err) {
      this.deps.log.warn({ err, jobId }, 'machine admin decision not sent (worker disconnected)');
    }
  }

  async onRequest(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'MACHINE_ADMIN_REQUEST' }>,
  ): Promise<void> {
    const p = message.payload;
    const jobId = message.jobId;
    const workerId = session.workerId;
    const base = { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId };
    const deny = async (reason: string, detail: string): Promise<void> => {
      await this.#send(session, jobId, { ...base, state: 'denied', reason, detail });
    };
    const now = this.deps.clock();
    // p6-approval-mode-switch: the job's effective approval mode decides auto-approval of each command.
    const { rows } = await this.deps.pool.query<{ spec: unknown; project: string }>(
      `SELECT jsonb_set(j.spec, '{approvalPolicy}', to_jsonb(${EFFECTIVE_APPROVAL_POLICY_SQL('j')})) AS spec, j.project
         FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [jobId, p.epoch, p.attemptId, workerId, now],
    );
    const row = rows[0];
    const spec = row === undefined ? null : JobSpec.safeParse(row.spec);
    if (
      row === undefined ||
      spec === null ||
      !spec.success ||
      spec.data.kind !== 'machine-admin' ||
      spec.data.machineAdmin?.workerId !== workerId ||
      row.project !== MACHINES_PROJECT
    ) {
      await this.deps.audit.record({
        actor: { type: 'worker', id: workerId },
        action: 'machine.admin.command',
        target: `job:${jobId}`,
        outcome: 'denied',
        metadata: { requestId: p.requestId, reason: 'not_live_machine_admin_lease' },
      });
      return deny(
        'stale_lease',
        'This is not the live lease of a machine administration job on this worker.',
      );
    }
    const desired = await this.deps.workerConfigs().machineAdmin(workerId);
    if (!desired.enabled) {
      return deny('machine_admin_not_enabled', 'Machine administration was switched off for this worker.');
    }
    const op = p.op;
    const digest = adminOpDigest(op);
    const summary = this.#redactor.redact(adminOpSummary(op, 600));
    // p17-worker-1-1-1: the agent's purpose — metadata, never part of the digest; redacted again here.
    const purpose = p.purpose === undefined ? null : normalizeAdminPurpose(this.#redactor.redact(p.purpose));
    const existing = await this.deps.pool.query<{ op_digest: string; state: string; attempt_id: string }>(
      'SELECT op_digest, state, attempt_id::text AS attempt_id FROM machine_admin_commands WHERE request_id = $1',
      [p.requestId],
    );
    const prior = existing.rows[0];
    if (prior !== undefined && (prior.op_digest !== digest || prior.attempt_id !== p.attemptId)) {
      return deny('request_mismatch', 'This request id was used for another command.');
    }
    if (prior?.state === 'denied') return deny('denied', 'This command was denied.');
    if (prior === undefined) {
      await withTransaction(this.deps.pool, async (tx) => {
        await tx.query(
          `INSERT INTO machine_admin_commands (request_id, job_id, attempt_id, epoch, worker_id, kind, op, op_digest,
                                               summary, purpose, state, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11, 'requested', $10, $10)
           ON CONFLICT (request_id) DO NOTHING`,
          [
            p.requestId,
            jobId,
            p.attemptId,
            p.epoch,
            workerId,
            op.kind,
            JSON.stringify(storedOp(op)),
            digest,
            summary,
            now,
            purpose,
          ],
        );
        await this.deps.audit.record(
          {
            actor: { type: 'worker', id: workerId },
            action: 'machine.admin.command',
            target: `job:${jobId}`,
            outcome: 'success',
            metadata: {
              requestId: p.requestId,
              attemptId: p.attemptId,
              kind: op.kind,
              digest,
              summary,
              ...(purpose === null ? {} : { purpose }),
            },
          },
          tx,
        );
      });
    }
    // Decide: auto-approve (job allow-all + worker + Machines project), else (p19-chat-machine-admin) by policy for a
    // job the user's own chat message started, else the approval engine.
    let auto = false;
    let approvalId: string | null = null;
    let byPolicy: { userId: string; draftId: string | null; goalGrantId: string | null } | null = null;
    if (await this.#autoApprove({ spec: spec.data }, workerId)) {
      auto = true;
    } else if ((byPolicy = await this.#chatGrant(jobId)) !== null) {
      auto = true;
    } else {
      try {
        const ev = await this.deps.approvals.evaluate({
          action: 'machine.admin',
          jobId,
          approvalKey: p.requestId,
          attemptId: p.attemptId,
          epoch: p.epoch,
          summary,
          risk: 'critical',
          requestedBy: { type: 'worker', id: workerId },
          // p17-worker-1-1-1: the purpose above the command (approval card and detail screen).
          details: adminApprovalDetails(op, purpose),
        });
        if (ev.outcome === 'pending') {
          await this.deps.pool.query(
            `UPDATE machine_admin_commands SET state = 'pending', approval_id = $2, updated_at = $3
              WHERE request_id = $1 AND state IN ('requested', 'pending')`,
            [p.requestId, ev.requestId, now],
          );
          await this.#send(session, jobId, { ...base, state: 'pending', approvalId: p.requestId });
          return;
        }
        approvalId = ev.requestId;
        if (ev.outcome === 'deny') {
          await this.#decided(
            p.requestId,
            'denied',
            ev.reason === 'policy' ? 'policy' : ev.reason,
            approvalId,
          );
          await deny(ev.reason === 'policy' ? 'policy' : 'denied', 'The command was not approved.');
          return;
        }
      } catch (err) {
        if (!(err instanceof ApprovalError)) throw err;
        await this.#decided(p.requestId, 'denied', err.code.slice(0, 64), null);
        return deny('approval_refused', err.publicMessage);
      }
    }
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + MAX_ADMIN_GRANT_TTL_MS).toISOString();
    const signature = this.deps.signer.signAdminCommand({
      workerId,
      jobId,
      attemptId: p.attemptId,
      epoch: p.epoch,
      requestId: p.requestId,
      issuedAt,
      expiresAt,
      op,
    });
    await this.deps.pool.query(
      `UPDATE machine_admin_commands SET state = 'granted', auto_approved = $2, approval_id = COALESCE($3, approval_id),
              granted_at = $4, updated_at = $4
        WHERE request_id = $1 AND state IN ('requested', 'pending', 'granted')`,
      [p.requestId, auto, approvalId, now],
    );
    await this.deps.audit.record({
      actor: auto ? SYSTEM : { type: 'system', id: 'approvals' },
      action: 'machine.admin.command.grant',
      target: `job:${jobId}`,
      outcome: 'success',
      metadata: {
        requestId: p.requestId,
        digest,
        autoApproved: auto,
        approvalId,
        expiresAt,
        ...(byPolicy === null
          ? {}
          : {
              approvedBy: 'policy',
              policy: 'autonomy.chatMachineAdmin',
              reason: CHAT_MACHINE_ADMIN_REASON,
              requestedBy: byPolicy.userId,
              ...(byPolicy.draftId === null ? {} : { draftId: byPolicy.draftId }),
              ...(byPolicy.goalGrantId === null ? {} : { inherited: { goalGrantId: byPolicy.goalGrantId } }),
              summary,
            }),
      },
    });
    await this.#send(session, jobId, {
      ...base,
      state: 'granted',
      grant: { issuedAt, expiresAt, signature },
    });
  }

  async #decided(
    requestId: string,
    state: 'denied',
    reason: string,
    approvalId: string | null,
  ): Promise<void> {
    await this.deps.pool.query(
      `UPDATE machine_admin_commands SET state = $2, reason = $3, approval_id = COALESCE($4, approval_id), updated_at = $5
        WHERE request_id = $1`,
      [requestId, state, /^[a-z0-9_]{1,64}$/.test(reason) ? reason : 'denied', approvalId, this.deps.clock()],
    );
  }

  async onResult(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'MACHINE_ADMIN_RESULT' }>,
  ): Promise<void> {
    const p = message.payload;
    const output = this.#redactor.redact(p.output).slice(-16_384);
    const { rowCount } = await this.deps.pool.query(
      `UPDATE machine_admin_commands
          SET state = $3, reason = $4, exit_code = $5, duration_ms = $6, output = $7, truncated = $8, file = $9,
              updated_at = $10
        WHERE request_id = $1 AND worker_id = $2 AND job_id::text = $11 AND state IN ('granted', 'requested', 'pending')`,
      [
        p.requestId,
        session.workerId,
        p.state,
        p.reason ?? null,
        p.exitCode ?? null,
        p.durationMs,
        output,
        p.truncated,
        p.file === undefined ? null : JSON.stringify(p.file),
        this.deps.clock(),
        message.jobId,
      ],
    );
    if ((rowCount ?? 0) === 0) {
      this.deps.log.warn(
        { workerId: session.workerId, requestId: p.requestId },
        'machine admin result for an unknown command',
      );
      return;
    }
    await this.deps.audit.record({
      actor: { type: 'worker', id: session.workerId },
      action: 'machine.admin.command.result',
      target: `job:${message.jobId}`,
      outcome: p.state === 'succeeded' ? 'success' : p.state === 'refused' ? 'denied' : 'failure',
      metadata: {
        requestId: p.requestId,
        state: p.state,
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        ...(p.exitCode === undefined ? {} : { exitCode: p.exitCode }),
        durationMs: p.durationMs,
        ...(p.file === undefined
          ? {}
          : {
              file: {
                path: p.file.path,
                bytes: p.file.bytes,
                sha256Before: p.file.sha256Before,
                sha256After: p.file.sha256After,
              },
            }),
      },
    });
  }

  /**
   * A `memory` event of a machine-admin job goes to the machine's memory (not the Machines project). Returns
   * false for every other job (the caller stores it as project memory as before). Idempotent per entry.
   */
  async recordNote(jobId: string, attemptId: string, workerId: string, text: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ spec: unknown }>(
      'SELECT spec FROM jobs WHERE id::text = $1',
      [jobId],
    );
    const spec = JobSpec.safeParse(rows[0]?.spec);
    if (!spec.success || spec.data.kind !== 'machine-admin') return false;
    if (spec.data.machineAdmin?.workerId !== workerId) return true; // never into another machine's memory
    const date = this.deps.clock().toISOString().slice(0, 10);
    const entry = `- ${date} job ${jobId.slice(0, 8)}: ${this.#redactor
      .redact(text)
      .trim()
      .replace(/\n{2,}/g, '\n')}`;
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        const current = await this.deps.context.machineMemory(workerId, tx);
        if (current?.content.includes(entry) === true) return;
        await this.deps.context.writeMachineMemory(
          tx,
          workerId,
          { mode: 'append', entry },
          { type: 'agent', jobId, attemptId, workerId },
          MAX_MACHINE_MEMORY,
        );
      });
    } catch (err) {
      if (!(err instanceof ContextError)) throw err;
      this.deps.log.warn({ jobId, workerId, code: err.code }, 'machine memory entry rejected');
    }
    return true;
  }
}
