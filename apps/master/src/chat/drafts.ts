import type { RuntimeAccountService } from '../runtime-accounts/service.js';
import type { InputUploadService } from '../input-uploads/service.js';
import type { AccountSwitchService } from '../runtime-accounts/switch.js';
import {
  PRIORITY_CLASS_VALUE,
  PriorityClass,
  SUPPORT_REPORT_SECTIONS,
  type SupportReportSection,
} from '@remyral/protocol';
import type { ApprovalService, HumanActor } from '../approvals/index.js';
import { ApprovalError } from '../approvals/errors.js';
import type { AuditRecorder } from '../audit/audit.js';
import { type Action, authorize, projectRoleOf, type Subject } from '../authz/model.js';
import { ContextError } from '../context/errors.js';
import type { MemoryRecordService } from '../memory-records/service.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { InvalidJobError, JobStoreError, RuntimeRemovedError } from '../jobs/errors.js';
import type { JobMessageService } from '../jobs/messages.js';
import type { JobStore } from '../jobs/store.js';
import type { Orchestrator } from '../orchestration/orchestrator.js';
import type { WorkerConfigService } from '../worker-config/index.js';
import { type WorkflowService, WorkflowError } from '../workflows/index.js';
import { stepUpFresh } from '../approvals/policy-store.js';
import { STEP_UP_ALWAYS_FRESH_MS } from '../auth/step-up.js';
import { eventOfDraft, type StepUpEvent } from '../security-policy/events.js';
import type { TimeLimitService } from '../jobs/time-limit.js';
import type { JobClockService } from '../jobs/job-clock.js';
import type { ConflictResolveService } from '../self-heal/conflict-resolve.js';
import type { ServiceRegistry, ServiceView } from '../services/service.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import type { MachineAdminService } from '../machine-admin/service.js';
import type { FleetToolsService } from '../fleet-tools/service.js';
import type { WebhookService } from '../webhooks-out/service.js';
import type { SupportService } from '../doctor/support.js';
import type { RemoteOpsService } from '../remote-ops/service.js';
import type { SkillService } from '../skills/service.js';
import type { SkillImportService } from '../skills/import-service.js';
import type { McpPreviewService } from '../mcp/previews.js';
import type { RuntimeKind, ToolRecipeId } from '@remyral/protocol';
import type { ActorContext } from '../workers/fleet.js';
import { AutomationError, AutomationInput, AutomationPatch } from '../automations/model.js';
import type { AutomationService } from '../automations/service.js';
import { AutomationGroupInput, type AutomationGroupService } from '../automations/groups.js';
import type { WorkflowTriggerService } from '../workflows/triggers.js';
import {
  type DeployOnSuccessService,
  OpsActionRequest,
  OpsError,
  type OpsService,
  type PreparedDeployOnSuccess,
} from '../ops/index.js';
import { MonitorInput } from '../uptime/model.js';
import type { UptimeService } from '../uptime/service.js';
import type { ApprovalPauseService } from '../approvals/pause.js';
import { hasInputRefs, inputRefsOf, prepareChatInputs } from './inputs.js';
import { readableKeptSource } from './workfiles-actions.js';
import type { TemplateService } from '../templates/service.js';
import { TemplateError } from '../templates/model.js';
import type { VerificationService } from '../verify/service.js';
import type { QueueService } from '../queue/service.js';
import { JobActionRunner } from './job-actions.js';
import { adminAlwaysFresh, type ChatAdmin } from './admin-actions.js';
import type { Queryable } from '../db/pool.js';
import {
  type ChatStore,
  type DraftKind,
  type DraftRecord,
  draftView,
  type DraftView,
  payloadHash,
} from './store.js';

/**
 * Confirming a draft card (docs/design/p5-ops-chat.md §5). The route requires a full session, CSRF and a
 * step-up; here the confirmation re-checks ownership, the draft's integrity (payload hash), that it is still
 * open, and the **target action for the confirming user** (exactly the rule of the normal route), then calls
 * the same service the normal API calls. Concurrent confirmations: the draft row is locked, one wins.
 * A failure leaves the draft open (e.g. a fresher step-up is needed for an approval rule) and is returned.
 */

const ACTION_OF: Readonly<Record<DraftKind, Action>> = {
  job: 'jobs.create',
  workflow_run: 'workflows.run',
  worker_config: 'workers.config.write',
  approval_decision: 'approvals.decide',
  job_message: 'jobs.message',
  // p5-machine-admin (ADR-0021).
  machine_task: 'machines.admin.run',
  tool_install: 'workers.ops.write',
  // p16-runtime-updates: exactly the right of POST /fleet/tools/actions.
  runtime_update: 'workers.ops.write',
  // p16-webhooks-out: exactly the right of POST /webhooks and its pause / resume.
  webhook: 'webhooks.write',
  // p16-doctor: exactly the right of POST /support/reports/:id/send.
  support_report: 'support.report',
  skill: 'skills.publish',
  // p6-automations (GitHub / webhook kinds: the service also checks `automations.external`).
  automation: 'automations.write',
  automation_change: 'automations.write',
  // p6-deploy-integrations: requesting; the action's own policy (approval, step-up) applies afterwards.
  ops_action: 'deploy.request',
  // p8-uptime.
  monitor: 'uptime.write',
  // p10-approval-pause.
  job_resume: 'jobs.resume',
  // p10-chat-job-actions: checked per job (a card may span projects) by JobActionRunner; this is the floor.
  job_action: 'jobs.read',
  // p11-memory-layers: the records service applies the document write role (global records need an admin).
  memory_change: 'context.write',
  // p13-runtime-accounts: checked per action (pause / resume: workers.config.write; switch: jobs.resume on the job).
  account_action: 'jobs.read',
  // p13-workflows-ui: saves a definition version (nothing runs).
  workflow: 'workflows.define',
  // p14-skill-catalogs: publishes an import preview (+ skills.assign when the card names a project).
  skill_import: 'skills.publish',
  // p14-mcp-chat: confirms an MCP install preview (+ mcp.assign when the card names a project).
  mcp_install: 'mcp.manage',
  // p19-install-scripts: approve npm install scripts for the whole platform (always-fresh code, a card only).
  install_script_approval: 'mcp.scripts',
  // p15-autonomy: checked per target by the settings runner (security.write, projects.execution.write, policy.write,
  // runtimes.write); this is the floor.
  settings_change: 'chat.use',
  // p15-autonomy: the time limit service re-checks the role per job.
  time_limit: 'jobs.timelimit',
  // p15-services: the service registry re-checks the project role (and a project admin for `unconfined`).
  service_action: 'services.manage',
  // p15-coolify-create (ADR-0057): create a Coolify application / set its variables or domains (project admin).
  coolify_change: 'deploy.coolify.manage',
  // p15-github-create-repo: open a GitHub repository (admin); the runner re-checks projects.git.write for the link.
  github_repo: 'integrations.github.write',
  // p17-chat-github: exactly the right of POST /projects (owner / admin); the runner re-checks projects.git.write for
  // the repository link, and the deploy targets service its own rules for the DNS zone.
  project_create: 'projects.create',
  // p15-workspace-retention: push a job's kept files to a repository (the exporter re-checks the target project).
  workfiles_export: 'workfiles.manage',
  // p15-chat-vault: a function job in the project (the runner re-checks vault.read when a credential is attached).
  http_request: 'jobs.create',
  // p15-chat-vault: completed by the browser through POST /vault/credentials (vault.write, always-fresh step-up).
  credential_save: 'vault.write',
  // p18-multi-project W3: the conversation's own working projects (each member readable — checked by the service).
  thread_projects: 'chat.use',
  // p18-multi-project W3: exactly the right of POST /projects/:project/workflow-attachments (target project admin).
  workflow_attach: 'workflows.attach',
  // p18-multi-project W5: the floor of POST /jobs/batches; every project is authorized on its own at submit.
  job_batch: 'jobs.create',
};

/**
 * Draft kinds whose normal route is in the always-fresh step-up class (checked again here). p14-skill-catalogs:
 * `skill_import` signs with the panel skills key like `POST /skills/imports/:id/publish`.
 */
const ALWAYS_FRESH_KINDS: ReadonlySet<DraftKind> = new Set([
  'machine_task',
  'skill_import',
  'mcp_install',
  // p19-install-scripts: like POST /mcp/install-scripts.
  'install_script_approval',
]);

export interface ConfirmContext {
  readonly subject: Subject;
  readonly human: HumanActor;
  readonly actor: ActorContext;
  /** p15-autonomy: executed by the assistant on the user's explicit instruction (no card click); audited as such. */
  readonly direct?: boolean;
  /**
   * p19-chat-machine-admin: set by ChatDirectActions only for a direct action of the user's OWN turn while the security
   * policy's `autonomy.chatMachineAdmin` is on (re-checked here). For machine administration cards
   * ({@link machinePolicyCard}) the always-fresh code is replaced by the switch (the event's normal code rule stays),
   * and a machine administration job started here gets its elevated commands approved by policy.
   */
  readonly machineAdminByPolicy?: boolean;
  /**
   * p20-scope-preview: `machineAdminByPolicy` was inherited by a continuation turn (an approved autonomous plan, a watch
   * follow-up) from this goal grant of the user's own turn — honoured only while `autonomy.goalGrants` is on too (read
   * again here); a machine administration job started here re-checks the grant per command.
   */
  readonly goalGrantId?: string;
}

/**
 * p19-chat-machine-admin: the cards "Makinede söylediğimi yap" covers — a machine administration task, a tool install
 * that needs root / Administrator, and the sandbox prepare of a machine (administration card `machine.prepare`).
 */
export function machinePolicyCard(d: Pick<DraftRecord, 'kind' | 'payload'>): boolean {
  return (
    d.kind === 'machine_task' ||
    (d.kind === 'tool_install' && d.payload.elevated === true) ||
    (d.kind === 'settings_change' && d.payload.target === 'admin' && d.payload.op === 'machine.prepare')
  );
}

/**
 * p6-approval-mode-switch: what the confirming user changed on the card before confirming. Only the approval mode, only
 * for job and machine-task drafts; the hash-protected payload stays as proposed and the override is audited.
 */
export interface ConfirmOverrides {
  readonly approvalPolicy?: 'ask-all' | 'ask-sensitive' | 'deny-sensitive' | 'allow-all';
  /**
   * p9-queue-priority: the class the user picked on a job / workflow run card (the assistant's
   * proposal is shown; the user may change it before confirming). Audited as an override like the approval mode.
   */
  readonly priorityClass?: PriorityClass;
  /**
   * p10-chat-job-actions: the jobs the user left checked on a job action card (a non-empty subset of the card's jobs;
   * absent: all). Audited as an override.
   */
  readonly jobIds?: readonly string[];
  /**
   * p14-mcp-chat: the "turn on MCP for this project" box of an MCP install card (unticked by default — by design,
   * the project switch stays off unless the person turns it on). Audited as an override.
   */
  readonly enableMcpProject?: boolean;
}

/** p9-queue-priority: drafts whose card carries a priority class. */
const PRIORITY_KINDS: ReadonlySet<string> = new Set(['job', 'workflow_run']);

/** The class a confirmed job / workflow-run draft runs with: the user's override, else the card's (Normal). */
export function draftPriority(d: DraftRecord, override?: PriorityClass): PriorityClass {
  if (override !== undefined) return override;
  const p = PriorityClass.safeParse(d.payload.priorityClass);
  return p.success ? p.data : 'normal';
}

const OVERRIDABLE_KINDS: ReadonlySet<string> = new Set(['job', 'machine_task']);

export interface DraftExecutorDeps {
  readonly pool: Pool;
  readonly store: ChatStore;
  readonly audit: AuditRecorder;
  readonly jobs: JobStore;
  readonly orchestrator: () => Orchestrator;
  readonly workflows: () => WorkflowService;
  readonly workerConfigs: () => WorkerConfigService;
  readonly approvals: ApprovalService;
  readonly jobMessages: JobMessageService;
  /** p5-machine-admin. */
  readonly machineAdmin?: () => MachineAdminService | null;
  readonly remoteOps?: () => RemoteOpsService | null;
  /** p16-runtime-updates: runtime update cards go through the fleet pipeline (absent: refused unavailable). */
  readonly fleetTools?: () => FleetToolsService | null;
  /** p16-webhooks-out: webhook cards go through the webhook service (absent: refused unavailable). */
  readonly webhooks?: () => WebhookService | null;
  /** p16-doctor: support report cards build and send through the support service (absent: refused unavailable). */
  readonly support?: () => SupportService | null;
  readonly skills?: () => SkillService | null;
  /** p14-skill-catalogs: skill_import cards. */
  readonly skillImports?: () => SkillImportService | null;
  /** p14-mcp-chat: mcp_install cards confirm an install preview. */
  readonly mcpPreviews?: () => McpPreviewService | null;
  /** p6-automations. */
  readonly automations?: () => AutomationService | null;
  /** p18-multi-project W4: the automation group card (draft_automation `projects`; absent: refused). */
  readonly automationGroups?: () => AutomationGroupService | null;
  /** p16-workflow-quality: a confirmed workflow card activates / re-syncs its trigger nodes (absent: never). */
  readonly workflowTriggers?: () => WorkflowTriggerService | null;
  /** p6-deploy-integrations. */
  readonly ops?: () => OpsService | null;
  /** p6-deploy-on-success. */
  readonly deployOnSuccess?: () => DeployOnSuccessService | null;
  /** p10-verify-health: the card's "Verify when done" (absent: none). */
  readonly verification?: () => VerificationService | null;
  /** p11-memory-layers: memory_change cards (absent: unavailable). */
  readonly memoryRecords?: () => MemoryRecordService | null;
  /** p8-templates: attribute job cards and automations drafted from a template. */
  readonly templates?: () => TemplateService | null;
  /** p8-uptime. */
  readonly uptime?: () => UptimeService | null;
  /** p10-approval-pause: resume now / restart from scratch of a paused job. */
  readonly approvalPause?: () => ApprovalPauseService | null;
  /** p10-chat-job-actions: class / move / run now of queued jobs. */
  readonly queue?: () => QueueService | null;
  /** p13-runtime-accounts: account_action cards (absent: unavailable). */
  readonly accounts?: () => RuntimeAccountService | null;
  readonly accountSwitch?: () => AccountSwitchService | null;
  /** p10-chat-job-actions: the step-up re-check of "run now" (default: the wall clock). */
  readonly clock?: () => Date;
  /**
   * p15-autonomy (ADR-0056): which card kinds ask for a code (the card's event, `eventOfDraft`). Absent: every card
   * asks within the session's window (the behaviour before ADR-0056).
   */
  readonly securityPolicy?: SecurityPolicyReader;
  /** p15-autonomy: `change_settings` cards (absent: unavailable). */
  readonly settings?: () => SettingsChangeRunner | null;
  /** p15-autonomy: `time_limit` cards (absent: unavailable). */
  readonly timeLimits?: () => TimeLimitService | null;
  /** p20-job-clock: the job action "continue" of a job that stopped on its time limit. */
  readonly jobClock?: () => JobClockService | null;
  /** p22-conflict-resolve: the job action "resolve_conflicts". */
  readonly conflictResolve?: () => ConflictResolveService | null;
  /** p15-services: `service_action` cards (absent: unavailable). */
  readonly services?: () => ServiceRegistry | null;
  /** p15-coolify-create: `coolify_change` cards (absent: unavailable). */
  readonly coolify?: () => CoolifyChangeRunner | null;
  /** p22-site-coolify: `coolify_change` cards of op `publish_site` (absent: unavailable). */
  readonly siteCoolify?: () => CoolifyChangeRunner | null;
  /** p15-github-create-repo: `github_repo` cards (absent: unavailable). */
  readonly githubRepo?: () => CoolifyChangeRunner | null;
  /** p17-chat-github: `project_create` cards (absent: unavailable). */
  readonly projectCreate?: () => CoolifyChangeRunner | null;
  /** p16-zip-job-input: the input bundle a job card names (absent: such a card is refused at confirm). */
  readonly inputUploads?: () => Pick<InputUploadService, 'forNewJob'> | null;
  /** p19-install-scripts: `install_script_approval` cards (absent: unavailable). */
  readonly installScripts?: () => CoolifyChangeRunner | null;
  /** p15-workspace-retention: `workfiles_export` cards (absent: unavailable). */
  readonly workfilesExport?: () => CoolifyChangeRunner | null;
  /** p15-chat-vault: `http_request` cards (absent: unavailable). */
  readonly httpRequests?: () => CoolifyChangeRunner | null;
  /** p16-assistant-admin: administration cards (`settings_change`, target "admin"; absent: unavailable). */
  readonly admin?: () => ChatAdmin | null;
  /** p18-multi-project W3: `thread_projects` cards (absent: unavailable). */
  readonly threadProjects?: () => CoolifyChangeRunner | null;
  /** p18-multi-project W3: `workflow_attach` cards (absent: unavailable). */
  readonly workflowAttach?: () => CoolifyChangeRunner | null;
  /** p18-multi-project W5: `job_batch` cards (absent: unavailable). */
  readonly jobBatch?: () => CoolifyChangeRunner | null;
}

/** p15-coolify-create: runs a confirmed `coolify_change` card (create application, variables, domains). */
export interface CoolifyChangeRunner {
  run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>>;
}

/** p15-autonomy: runs a confirmed `settings_change` card (security policy, project execution, approval rules …). */
export interface SettingsChangeRunner {
  run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>>;
}

/** The step-up a card needs (for the inline code field and the assistant's answer). */
export interface CardStepUp {
  readonly event: StepUpEvent;
  readonly required: boolean;
  readonly alwaysFresh: boolean;
}

/** What #execute produced: the stored/audited result, and values shown once in the HTTP answer only (secrets). */
interface Executed {
  readonly result: Record<string, unknown>;
  readonly reveal?: Record<string, unknown>;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toHttp(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  if (err instanceof RuntimeRemovedError) return new HttpError(400, 'runtime_removed', err.readable);
  if (err instanceof InvalidJobError) {
    return new HttpError(
      400,
      'invalid_job',
      `Invalid job: ${err.issues.map((i) => `${i.path || '(root)'}:${i.code}`).join(', ')}`.slice(0, 1000),
      {},
      {},
      {
        issues: err.issues
          .map((i) => `${i.path || '(root)'}:${i.code}`)
          .join(', ')
          .slice(0, 300),
      },
    );
  }
  if (err instanceof JobStoreError)
    return new HttpError(409, 'conflict', 'The job changed concurrently.', {}, {}, { reason: 'short' });
  if (err instanceof WorkflowError) return new HttpError(err.status, err.code, err.message);
  if (err instanceof ApprovalError) return new HttpError(err.httpStatus, err.code, err.publicMessage);
  if (err instanceof AutomationError) return new HttpError(err.status, err.code, err.message);
  if (err instanceof OpsError) return new HttpError(err.status, err.code, err.message, err.headers);
  if (err instanceof TemplateError) return new HttpError(err.status, err.code, err.message);
  return err;
}

export class DraftExecutor {
  readonly #jobActions: JobActionRunner;

  /** p16-zip-job-input: the bundle of a job card, re-checked at confirm (ready, the card's project). */
  async #inputBundle(project: string, id: string): Promise<{ id: string }> {
    const svc = this.deps.inputUploads?.() ?? null;
    if (svc === null) {
      throw new HttpError(409, 'input_upload_unsupported', 'Input bundles are not available on this master.');
    }
    return svc.forNewJob(project, id);
  }

  constructor(private readonly deps: DraftExecutorDeps) {
    this.#jobActions = new JobActionRunner({
      pool: deps.pool,
      audit: deps.audit,
      jobs: deps.jobs,
      orchestrator: deps.orchestrator,
      ...(deps.queue === undefined ? {} : { queue: deps.queue }),
      ...(deps.approvalPause === undefined ? {} : { approvalPause: deps.approvalPause }),
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.jobClock === undefined ? {} : { jobClock: deps.jobClock }),
      ...(deps.conflictResolve === undefined ? {} : { conflictResolve: deps.conflictResolve }),
    });
  }

  async dismiss(userId: string, draftId: string): Promise<DraftView> {
    const d = await this.deps.store.draft(userId, draftId);
    if (d.state !== 'proposed') {
      throw new HttpError(409, 'draft_not_open', `The draft is ${d.state}.`, {}, {}, { state: d.state });
    }
    await this.deps.store.decideDraft(draftId, 'dismissed', null);
    return draftView(await this.deps.store.draft(userId, draftId));
  }

  /**
   * `result` is stored on the draft, audited and noted in the thread; `reveal` (a new webhook secret) is only for
   * the HTTP answer of this confirmation — never stored, audited or shown to the assistant.
   */
  /** p15-autonomy: whether confirming `d` needs a code under the security policy, and of which class. */
  async stepUpOf(d: Pick<DraftRecord, 'kind' | 'payload'>): Promise<CardStepUp> {
    const event = eventOfDraft(d.kind, d.payload);
    const alwaysFresh =
      ALWAYS_FRESH_KINDS.has(d.kind) ||
      (d.kind === 'tool_install' && d.payload.elevated === true) ||
      // p16-assistant-admin: user account changes are always-fresh on their own routes too.
      (d.kind === 'settings_change' && adminAlwaysFresh(d.payload));
    const policy = this.deps.securityPolicy === undefined ? null : await this.deps.securityPolicy.current();
    return { event, required: policy === null ? true : policy.events[event], alwaysFresh };
  }

  async confirm(
    ctxIn: ConfirmContext,
    draftId: string,
    overrides: ConfirmOverrides = {},
  ): Promise<{ draft: DraftView; result: Record<string, unknown>; reveal: Record<string, unknown> | null }> {
    let ctx = ctxIn;
    const userId = ctx.subject.userId;
    return withTransaction(this.deps.pool, async (tx) => {
      // Lock the row: a concurrent confirmation waits here and then finds the draft decided.
      await tx.query('SELECT 1 FROM chat_drafts WHERE id = $1 AND user_id = $2 FOR UPDATE', [
        draftId,
        userId,
      ]);
      const d = await this.deps.store.draft(userId, draftId, tx);
      if (d.state !== 'proposed')
        throw new HttpError(409, 'draft_not_open', `The draft is ${d.state}.`, {}, {}, { state: d.state });
      if (payloadHash(d.payload) !== d.payloadHash) {
        throw new HttpError(
          409,
          'draft_tampered',
          'The draft changed after it was proposed; it cannot be confirmed.',
        );
      }
      // p17-coolify-full: a Coolify-wide card (`scope: connection`) needs the global `coolify.manage`.
      const action: Action =
        d.kind === 'coolify_change' && d.payload.scope === 'connection'
          ? 'coolify.manage'
          : ACTION_OF[d.kind];
      // p10-chat-job-actions: a job action card is authorized per job (and per action) for the confirming user.
      const decision =
        d.kind === 'coolify_change' && d.payload.scope === 'connection'
          ? authorize(ctx.subject, action)
          : d.kind === 'job_action' || d.kind === 'job_batch' || d.kind === 'thread_projects'
            ? authorize(ctx.subject, action)
            : d.kind === 'account_action'
              ? d.payload.action === 'switch_job'
                ? authorize(
                    ctx.subject,
                    'jobs.resume',
                    d.project === null ? undefined : { project: d.project },
                  )
                : authorize(ctx.subject, 'workers.config.write')
              : authorize(ctx.subject, action, d.project === null ? undefined : { project: d.project });
      if (!decision.allow) {
        await this.deps.audit.record({
          actor: { type: 'user', id: userId },
          action: 'chat.draft.confirm',
          target: `chat-draft:${d.id}`,
          outcome: 'denied',
          ip: ctx.actor.ip,
          userAgent: ctx.actor.userAgent,
          metadata: { kind: d.kind, authz: action, reason: decision.reason },
        });
        throw decision.reason === 'not_visible'
          ? new HttpError(404, 'draft_not_found', 'Draft not found.')
          : new HttpError(
              403,
              'forbidden',
              'You are not allowed to do what this draft proposes.',
              {},
              {},
              { reason: 'draft' },
            );
      }
      // p15-autonomy (ADR-0056): the card's event decides whether a code is needed (the security policy); a card
      // whose event is not protected runs with a waived step-up (the services behind it re-check `mfaAt`).
      // p5-machine-admin: root/Administrator work needs the always-fresh step-up its own route needs.
      const elevatedTool = d.kind === 'tool_install' && d.payload.elevated === true;
      const need = await this.stepUpOf(d);
      const now = this.deps.clock?.() ?? new Date();
      // p19-chat-machine-admin: the user's own message asked for this machine work and the switch is on (read again).
      // p20-scope-preview: an inherited grant also needs the goal-bound switch (read again).
      const autonomyNow =
        ctx.direct === true && ctx.machineAdminByPolicy === true && this.deps.securityPolicy !== undefined
          ? (await this.deps.securityPolicy.current()).autonomy
          : null;
      const byPolicy =
        autonomyNow !== null &&
        machinePolicyCard(d) &&
        autonomyNow.chatMachineAdmin &&
        (ctx.goalGrantId === undefined || autonomyNow.goalGrants);
      ctx = byPolicy ? ctx : { ...ctx, machineAdminByPolicy: false };
      if (!need.required) {
        ctx = {
          ...ctx,
          human: {
            ...ctx.human,
            mfaAt: now,
            stepUpMaxAgeMs: Number.POSITIVE_INFINITY,
            alwaysFreshMaxAgeMs: Number.POSITIVE_INFINITY,
          },
        };
      } else {
        const standard = ctx.human.stepUpMaxAgeMs ?? STEP_UP_ALWAYS_FRESH_MS;
        // p19-chat-machine-admin: the switch replaces the always-fresh code; the event's own window still applies.
        const maxAge =
          need.alwaysFresh && !byPolicy
            ? (ctx.human.alwaysFreshMaxAgeMs ?? Math.min(standard, STEP_UP_ALWAYS_FRESH_MS))
            : standard;
        if (!stepUpFresh(ctx.human.mfaAt, now, maxAge)) {
          await this.deps.audit.record({
            actor: { type: 'user', id: userId },
            action: 'chat.draft.confirm',
            target: `chat-draft:${d.id}`,
            outcome: 'denied',
            ip: ctx.actor.ip,
            userAgent: ctx.actor.userAgent,
            metadata: { kind: d.kind, reason: 'step_up_required', event: need.event },
          });
          throw new HttpError(
            403,
            'step_up_required',
            need.alwaysFresh
              ? 'Confirm with a current authenticator code (always-fresh).'
              : 'Confirm with a current authenticator code.',
            {},
            {},
            need.alwaysFresh ? { reason: 'always_fresh' } : {},
          );
        }
      }
      if (ALWAYS_FRESH_KINDS.has(d.kind) || elevatedTool) {
        if (elevatedTool && !authorize(ctx.subject, 'machines.admin.run').allow) {
          throw new HttpError(
            403,
            'forbidden',
            'You are not allowed to start machine administration jobs.',
            {},
            {},
            { reason: 'machine_admin' },
          );
        }
      }
      const jobIds = overrides.jobIds;
      if (jobIds !== undefined) {
        const listed = Array.isArray(d.payload.jobs)
          ? d.payload.jobs.flatMap((j: unknown) => {
              const id = (j as { id?: unknown }).id;
              return typeof id === 'string' ? [id] : [];
            })
          : [];
        if (d.kind !== 'job_action' || jobIds.length === 0 || !jobIds.every((id) => listed.includes(id))) {
          throw new HttpError(
            400,
            'invalid_override',
            'Choose at least one of the jobs listed on a job action card.',
          );
        }
      }
      const enableMcpProject = overrides.enableMcpProject;
      if (
        enableMcpProject !== undefined &&
        (d.kind !== 'mcp_install' || (enableMcpProject && (d.project === null || d.project === '*')))
      ) {
        throw new HttpError(
          400,
          'invalid_override',
          'Only an MCP install card for one project can turn on that project’s MCP switch.',
          {},
          {},
          { reason: 'mcp_project' },
        );
      }
      const priorityOverride = overrides.priorityClass;
      if (priorityOverride !== undefined && !PRIORITY_KINDS.has(d.kind)) {
        throw new HttpError(
          400,
          'invalid_override',
          'Only job and workflow run drafts take a priority class.',
          {},
          {},
          { reason: 'priority_class' },
        );
      }
      const override = overrides.approvalPolicy;
      let proposed: unknown;
      if (override !== undefined) {
        if (!OVERRIDABLE_KINDS.has(d.kind)) {
          throw new HttpError(
            400,
            'invalid_override',
            'Only job drafts take a changed approval mode.',
            {},
            {},
            { reason: 'approval_mode' },
          );
        }
        if (d.kind === 'machine_task' && override !== 'ask-all' && override !== 'allow-all') {
          throw new HttpError(
            400,
            'invalid_override',
            'A machine administration job runs only with “Ask for everything” or “Never ask”.',
            {},
            {},
            { reason: 'machine_admin_mode' },
          );
        }
        proposed =
          d.kind === 'job'
            ? (d.payload.spec as Record<string, unknown> | undefined)?.approvalPolicy
            : d.payload.approvalPolicy;
      }
      const withPolicy: DraftRecord =
        override === undefined
          ? d
          : d.kind === 'job'
            ? {
                ...d,
                payload: {
                  ...d.payload,
                  spec: { ...(d.payload.spec as Record<string, unknown>), approvalPolicy: override },
                },
              }
            : { ...d, payload: { ...d.payload, approvalPolicy: override } };
      const prioritized: DraftRecord =
        priorityOverride === undefined
          ? withPolicy
          : { ...withPolicy, payload: { ...withPolicy.payload, priorityClass: priorityOverride } };
      const effective: DraftRecord =
        enableMcpProject === undefined
          ? prioritized
          : { ...prioritized, payload: { ...prioritized.payload, enableProject: enableMcpProject } };
      let executed: Executed;
      try {
        executed =
          d.kind === 'job_action'
            ? { result: await this.#jobActions.run(ctx, effective, jobIds) }
            : await this.#run(ctx, effective);
      } catch (err) {
        throw toHttp(err);
      }
      // p19-autonomy-aware: a card that ran without the user's click is marked (the console shows it collapsed).
      const result =
        ctx.direct === true
          ? {
              ...executed.result,
              autoRun: true,
              // p19-chat-machine-admin: audited (below and as chat.direct_action) as run by the policy switch.
              ...(byPolicy ? { machineAdminByPolicy: true } : {}),
            }
          : executed.result;
      await this.deps.store.decideDraft(d.id, 'confirmed', result, tx);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'chat.draft.confirm',
          target: `chat-draft:${d.id}`,
          outcome: 'success',
          ip: ctx.actor.ip,
          userAgent: ctx.actor.userAgent,
          metadata: {
            kind: d.kind,
            project: d.project,
            threadId: d.threadId,
            via: ctx.direct === true ? 'chat-direct' : 'card',
            event: eventOfDraft(d.kind, d.payload),
            ...(byPolicy
              ? {
                  approvedBy: 'policy',
                  policy: 'autonomy.chatMachineAdmin',
                  reason: 'the user asked for this machine work in their own chat message',
                }
              : {}),
            result,
            ...(override === undefined
              ? {}
              : {
                  approvalPolicyOverride: {
                    from: typeof proposed === 'string' ? proposed : null,
                    to: override,
                  },
                }),
            ...(priorityOverride === undefined
              ? {}
              : { priorityClassOverride: { from: draftPriority(d), to: priorityOverride } }),
            ...(jobIds === undefined ? {} : { jobIdsOverride: [...jobIds] }),
            ...(enableMcpProject === undefined ? {} : { enableMcpProjectOverride: enableMcpProject }),
          },
        },
        tx,
      );
      return {
        draft: draftView(await this.deps.store.draft(userId, draftId, tx)),
        result,
        reveal: executed.reveal ?? null,
      };
    });
  }

  async #run(ctx: ConfirmContext, d: DraftRecord): Promise<Executed> {
    if (d.kind === 'automation' || d.kind === 'automation_change') return this.#automation(ctx, d);
    if (d.kind === 'workflow') return this.#workflow(ctx, d);
    if (d.kind === 'ops_action') return this.#opsAction(ctx, d);
    if (d.kind === 'monitor') return this.#monitor(ctx, d);
    if (d.kind === 'memory_change') return this.#memoryChange(ctx, d);
    if (d.kind === 'settings_change' && d.payload.target === 'admin') {
      // p16-assistant-admin: the console route's service, for the confirming user, audited with source chat.
      const admin = this.deps.admin?.() ?? null;
      if (admin === null)
        throw new HttpError(
          503,
          'unavailable',
          'Administration through the chat is not available.',
          {},
          {},
          { reason: 'admin' },
        );
      return admin.run(ctx, d);
    }
    if (d.kind === 'settings_change') {
      const runner = this.deps.settings?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'Settings changes are not available.',
          {},
          {},
          { reason: 'settings' },
        );
      return { result: await runner.run(ctx, d) };
    }
    // p22-site-coolify: the whole chain from a site upload to a live Coolify application.
    if (d.kind === 'coolify_change' && d.payload.op === 'publish_site') {
      const runner = this.deps.siteCoolify?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'Publishing on Coolify is not available.',
          {},
          {},
          { reason: 'coolify' },
        );
      return { result: await runner.run(ctx, d) };
    }
    if (d.kind === 'coolify_change') {
      const runner = this.deps.coolify?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'Coolify application management is not available.',
          {},
          {},
          { reason: 'coolify' },
        );
      return { result: await runner.run(ctx, d) };
    }
    if (d.kind === 'github_repo') {
      const runner = this.deps.githubRepo?.() ?? null;
      if (runner === null)
        throw new HttpError(503, 'unavailable', 'GitHub is not available.', {}, {}, { reason: 'github' });
      return { result: await runner.run(ctx, d) };
    }
    // p18-multi-project W3 + W5: working projects, attaching a shared workflow, a job batch.
    if (d.kind === 'thread_projects' || d.kind === 'workflow_attach' || d.kind === 'job_batch') {
      const runner =
        (d.kind === 'thread_projects'
          ? this.deps.threadProjects?.()
          : d.kind === 'workflow_attach'
            ? this.deps.workflowAttach?.()
            : this.deps.jobBatch?.()) ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'This card is not available on this master.',
          {},
          {},
          { reason: 'multi_project' },
        );
      return { result: await runner.run(ctx, d) };
    }
    if (d.kind === 'project_create') {
      const runner = this.deps.projectCreate?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'Creating projects from the chat is not available.',
          {},
          {},
          { reason: 'projects' },
        );
      return { result: await runner.run(ctx, d) };
    }
    if (d.kind === 'install_script_approval') {
      const runner = this.deps.installScripts?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'Install script approvals are not available.',
          {},
          {},
          { reason: 'install_scripts' },
        );
      return { result: await runner.run(ctx, d) };
    }
    if (d.kind === 'workfiles_export') {
      const runner = this.deps.workfilesExport?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'Kept working files are not available.',
          {},
          {},
          {
            reason: 'workfiles',
          },
        );
      return { result: await runner.run(ctx, d) };
    }
    if (d.kind === 'http_request') {
      const runner = this.deps.httpRequests?.() ?? null;
      if (runner === null)
        throw new HttpError(
          503,
          'unavailable',
          'HTTP requests from the chat are not available.',
          {},
          {},
          { reason: 'http' },
        );
      return { result: await runner.run(ctx, d) };
    }
    return { result: await this.#execute(ctx, d) };
  }

  /** p11-memory-layers: the same service calls as the Memory tab (add / replace / retire). */
  async #memoryChange(ctx: ConfirmContext, d: DraftRecord): Promise<Executed> {
    const svc = this.deps.memoryRecords?.() ?? null;
    if (svc === null)
      throw new HttpError(
        503,
        'unavailable',
        'Memory records are not available.',
        {},
        {},
        { reason: 'memory' },
      );
    const user = {
      id: ctx.subject.userId,
      role: ctx.human.role,
      mfaAt: ctx.human.mfaAt,
      ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
      projectRole: (p: string) => projectRoleOf(ctx.subject, p),
    };
    const meta = { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent };
    const p = d.payload;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    try {
      if (p.action === 'retire') {
        const r = await svc.setStatus(
          user,
          String(p.recordId),
          { status: 'expired', reason: str(p.reason) },
          meta,
        );
        return { result: { recordId: r.id, status: r.status } };
      }
      const out = await svc.create(
        user,
        {
          scope: String(p.scope),
          type: p.type as 'rule' | 'fact' | 'decision' | 'lesson',
          statement: String(p.statement),
          rationale: str(p.rationale) ?? null,
          consequences: str(p.consequences) ?? null,
          decidedOn: str(p.decidedOn) ?? null,
          reviewBy: str(p.reviewBy) ?? null,
          evidence: [{ kind: 'chat', ref: d.threadId }],
          supersedes: p.action === 'replace' ? String(p.recordId) : null,
        },
        meta,
      );
      return {
        result: {
          recordId: out.record.id,
          status: out.record.status,
          ...(out.record.supersedes === null ? {} : { supersedes: out.record.supersedes }),
          possibleConflicts: out.conflicts.length,
        },
      };
    } catch (err) {
      if (err instanceof ContextError) throw new HttpError(err.httpStatus, err.code, err.publicMessage);
      throw err;
    }
  }

  /** p8-uptime: the same service calls as the REST API (create a monitor, or the "Monitor this" set of a site). */
  async #monitor(ctx: ConfirmContext, d: DraftRecord): Promise<Executed> {
    const svc = this.deps.uptime?.() ?? null;
    if (svc === null)
      throw new HttpError(
        503,
        'unavailable',
        'Uptime monitoring is not available.',
        {},
        {},
        { reason: 'uptime' },
      );
    const actor = {
      type: 'user' as const,
      id: ctx.subject.userId,
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
    };
    const p = d.payload;
    if (p.mode === 'output') {
      const out = await svc.createFromOutput(actor, String(p.project), String(p.outputKey));
      const first = out.created[0] ?? out.existing[0];
      return {
        result: {
          ...(first === undefined ? {} : { monitorId: first.id }),
          created: out.created.map((m) => m.id),
          existing: out.existing.map((m) => m.id),
        },
      };
    }
    const m = await svc.create(actor, MonitorInput.parse(p.input));
    return { result: { monitorId: m.id, status: m.status } };
  }

  /** p6-automations drafts: the same service calls as the REST API (the confirmation carried a fresh step-up). */
  /**
   * p13-workflows-ui: the drafted document is validated again by define / update (as the normal routes); a card proposed
   * as invalid is refused here too. Update = new version of the saved workflow it was drafted from, refused (409) when
   * another version was saved meanwhile.
   *
   * p16-workflow-quality: then its trigger nodes — activated when the card asked for it (`activate`), re-synced when the
   * workflow's triggers already follow the latest version; the result says what they do now (never a silently dead
   * trigger). Webhook / GitHub activation is checked BEFORE saving (project admin + fresh code), so a refusal saves
   * nothing; a webhook secret created now is revealed once.
   */
  async #workflow(ctx: ConfirmContext, d: DraftRecord): Promise<Executed> {
    const p = d.payload;
    const userId = ctx.subject.userId;
    if (p.valid !== true) {
      throw new HttpError(
        400,
        'invalid_workflow',
        'The drafted workflow is not valid; ask the assistant to fix the issues on the card.',
      );
    }
    const actor = { type: 'user', id: userId } as const;
    const definition = p.definition as Record<string, unknown>;
    // p14-workflow-engine 14.5: a version-2 draft that adds or changes privileged nodes (HTTP, e-mail, GitHub,
    // deploy, code) needs the confirming user's `workflows.define.*` actions and a fresh step-up — exactly the
    // check of POST /workflows (refused 403 and audited by the workflow service otherwise).
    const fresh = stepUpFresh(
      ctx.human.mfaAt,
      this.deps.clock?.() ?? new Date(),
      ...(ctx.human.stepUpMaxAgeMs === undefined ? [] : [ctx.human.stepUpMaxAgeMs]),
    );
    const access = { subject: ctx.subject, stepUpFresh: fresh };
    const project = String(p.project);
    const activate = p.activate === true;
    if (activate && p.activateExternal === true) {
      if (!authorize(ctx.subject, 'automations.external', { project }).allow)
        throw new HttpError(
          403,
          'forbidden',
          'You are not allowed to do what this draft proposes.',
          {},
          {},
          { reason: 'draft' },
        );
      if (!fresh) throw new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.');
    }
    const saved =
      typeof p.workflowId === 'string'
        ? await this.deps.workflows().update(actor, p.workflowId, definition, Number(p.baseVersion), access)
        : await this.deps.workflows().define(actor, project, definition, { access });
    const result: Record<string, unknown> = {
      workflowId: saved.id,
      name: saved.name,
      version: saved.version,
    };
    const triggers = this.deps.workflowTriggers?.() ?? null;
    if (triggers === null) return { result };
    const after = await triggers.afterSave(
      {
        id: userId,
        subject: ctx.subject,
        stepUpFresh: fresh,
        mfaAt: ctx.human.mfaAt,
        ip: ctx.actor.ip,
        userAgent: ctx.actor.userAgent,
      },
      saved.id,
      { activate },
    );
    const first = after.webhookSecrets[0];
    return {
      result: {
        ...result,
        triggers: { state: after.state, warning: after.warning, nodes: after.triggers.map((t) => t.nodeId) },
      },
      ...(first === undefined ? {} : { reveal: { webhook: { url: first.url, secret: first.secret } } }),
    };
  }

  async #automation(ctx: ConfirmContext, d: DraftRecord): Promise<Executed> {
    const svc = this.deps.automations?.() ?? null;
    if (svc === null)
      throw new HttpError(
        503,
        'unavailable',
        'Automations are not available.',
        {},
        {},
        { reason: 'automations' },
      );
    const p = d.payload;
    const actor = {
      id: ctx.subject.userId,
      subject: ctx.subject,
      stepUpFresh: true,
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
    };
    const reveal = (id: string, secret: string | null): Pick<Executed, 'reveal'> =>
      secret === null ? {} : { reveal: { webhook: { url: svc.webhookUrl(id), secret } } };
    if (d.kind === 'automation') {
      // p18-multi-project W4: one ordinary automation per project, linked as a group (each checked there again).
      if (p.action === 'create_group') {
        const groups = this.deps.automationGroups?.() ?? null;
        if (groups === null)
          throw new HttpError(
            503,
            'unavailable',
            'Automation groups are not available.',
            {},
            {},
            { reason: 'automation_groups' },
          );
        const input = AutomationGroupInput.parse({ ...(p.input as object), projects: p.projects });
        const out = await groups.create(actor, input);
        const tpl = p.template as { id?: unknown; version?: unknown; params?: unknown } | undefined;
        const ts = this.deps.templates?.() ?? null;
        if (
          tpl !== undefined &&
          ts !== null &&
          typeof tpl.id === 'string' &&
          typeof tpl.version === 'number'
        ) {
          for (const c of out.created)
            await ts.linkAutomation(c.automation.id, {
              id: tpl.id,
              version: tpl.version,
              params: (tpl.params ?? {}) as Record<string, unknown>,
            });
        }
        const firstMade = out.created[0];
        return {
          result: {
            ...(firstMade === undefined ? {} : { automationId: firstMade.automation.id }),
            groupId: out.groupId,
            automationIds: out.created.map((c) => c.automation.id),
            projects: out.created.map((c) => c.project),
            refused: out.refused.map((r) => ({ project: r.project, code: r.code })),
          },
        };
      }
      if (p.action === 'create') {
        const input = AutomationInput.parse(p.input);
        const out = await svc.create(actor, input);
        // p8-templates: an automation drafted from a template counts for it.
        const tpl = p.template as { id?: unknown; version?: unknown; params?: unknown } | undefined;
        const ts = this.deps.templates?.() ?? null;
        if (
          tpl !== undefined &&
          ts !== null &&
          typeof tpl.id === 'string' &&
          typeof tpl.version === 'number'
        ) {
          await ts.linkAutomation(out.automation.id, {
            id: tpl.id,
            version: tpl.version,
            params: (tpl.params ?? {}) as Record<string, unknown>,
          });
        }
        return {
          result: {
            automationId: out.automation.id,
            state: out.automation.state,
            trigger: out.automation.triggerSummary,
          },
          ...reveal(out.automation.id, out.webhookSecret),
        };
      }
      const id = String(p.automationId);
      const out = await svc.update(actor, id, AutomationPatch.parse(p.patch));
      return {
        result: { automationId: id, state: out.automation.state, trigger: out.automation.triggerSummary },
        ...reveal(id, out.webhookSecret),
      };
    }
    const id = String(p.automationId);
    switch (p.action) {
      case 'pause':
        return { result: { automationId: id, state: (await svc.pause(actor, id)).state } };
      case 'resume':
        return { result: { automationId: id, state: (await svc.resume(actor, id)).state } };
      case 'delete':
        return { result: { automationId: id, state: (await svc.remove(actor, id)).state } };
      case 'run_now': {
        const run = await svc.runNow(actor, id);
        return { result: { automationId: id, runId: run.id, runState: run.state, jobId: run.jobId } };
      }
      default:
        throw new HttpError(
          400,
          'invalid_draft',
          'Unknown automation action.',
          {},
          {},
          { reason: 'automation_action' },
        );
    }
  }

  /**
   * p6-deploy-integrations: the confirmed card *requests* the ops action through the same service as the REST API;
   * the action's policy then decides (preview auto runs now; production / DNS wait for an approval).
   */
  async #opsAction(ctx: ConfirmContext, d: DraftRecord): Promise<Executed> {
    const svc = this.deps.ops?.() ?? null;
    if (svc === null)
      throw new HttpError(
        503,
        'unavailable',
        'Deploy integrations are not available.',
        {},
        {},
        { reason: 'ops' },
      );
    const actor = {
      type: 'user' as const,
      id: ctx.subject.userId,
      mfaAt: ctx.human.mfaAt,
      ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
    };
    const p = d.payload;
    const rb = p.rollback as { actionId?: unknown; idempotencyKey?: unknown } | undefined;
    let out: Awaited<ReturnType<typeof svc.request>>;
    if (rb === undefined) {
      const req = OpsActionRequest.parse(p.request);
      // p6-pages-create: "use as the Pages target" is a deploy-target change: the confirming user needs
      // deploy.targets.write (the confirmation itself carries the standard step-up, like PUT deploy-targets).
      const mayWriteTargets =
        req.kind === 'pages.create_project' &&
        req.params.useAsTarget === true &&
        authorize(ctx.subject, 'deploy.targets.write', { project: req.project }).allow;
      out = await svc.request(actor, req, 'chat', {
        mayWriteTargets,
        // p15-chat-zip: a publish from the chat reports its live link (or its failure) back into this conversation.
        ...(req.kind === 'pages.publish' ? { source: { chatThreadId: d.threadId, draftId: d.id } } : {}),
      });
    } else {
      out = await svc.rollback(actor, String(rb.actionId), String(rb.idempotencyKey), 'chat');
    }
    const a = out.action;
    return {
      result: {
        actionId: a.id,
        kind: a.kind,
        env: a.env,
        state: a.state,
        policy: a.policy.decision,
        ...(a.error === null ? {} : { error: a.error.slice(0, 300) }),
        link: `/deploys/${a.id}`,
      },
    };
  }

  async #execute(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const p = d.payload;
    const userId = ctx.subject.userId;
    switch (d.kind) {
      case 'job': {
        const project = String(p.project);
        // p5-ops-chat-next: input files are read and checked again for the confirming user (the source job may
        // have become invisible since the draft was made; the same rules as POST /jobs apply).
        const inputs = await prepareChatInputs(
          this.deps.pool,
          ctx.subject,
          project,
          inputRefsOf(p),
          d.threadId,
        );
        // p6-deploy-on-success (ADR-0030): confirming the card approves the deploy (checked for the confirming
        // user now, with this confirmation's step-up); refused → no job.
        let spec: unknown = p.spec;
        let deploy: PreparedDeployOnSuccess | null = null;
        const dos = this.deps.deployOnSuccess?.() ?? null;
        if (p.deployOnSuccess !== undefined && p.deployOnSuccess !== null) {
          if (dos === null)
            throw new HttpError(503, 'ops_unavailable', 'Deploy integrations are not available.');
          const out = await dos.prepare(
            {
              subject: ctx.subject,
              mfaAt: ctx.human.mfaAt,
              ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
              ip: ctx.actor.ip,
              userAgent: ctx.actor.userAgent,
            },
            project,
            p.deployOnSuccess,
            spec,
          );
          spec = out.spec;
          deploy = out.prepared;
        }
        const recorded: { id: string | null } = { id: null };
        const hooks: ((tx: Queryable, jobId: string) => Promise<void>)[] = [];
        if (deploy !== null && dos !== null) {
          const prepared = deploy;
          hooks.push(async (tx, jobId) => {
            recorded.id = await dos.record(
              tx,
              jobId,
              prepared,
              'chat',
              { chatThreadId: d.threadId, draftId: d.id },
              { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
            );
          });
        }
        // p10-verify-health: the card's mode (checked again here), else the project's default; noted in this thread.
        const verifier = this.deps.verification?.() ?? null;
        if (verifier !== null) {
          const raw = p.verifyOnSuccess;
          const requested: { mode: 'off' | 'report' | 'gate' } | undefined =
            raw === 'off' || raw === 'report' || raw === 'gate' ? { mode: raw } : undefined;
          const vp = await verifier.resolve(
            project,
            requested,
            p.template === undefined ? 'chat' : 'template',
            spec,
          );
          if (vp !== null) {
            hooks.push(async (tx, jobId) => {
              await verifier.record(tx, jobId, project, vp, userId, {
                chatThreadId: d.threadId,
                draftId: d.id,
              });
            });
          }
        }
        // p8-templates: a card drafted from a template is attributed to that version (re-checked for the confirmer).
        const tpl = p.template as { id?: unknown; version?: unknown } | undefined;
        const ts = this.deps.templates?.() ?? null;
        if (
          tpl !== undefined &&
          ts !== null &&
          typeof tpl.id === 'string' &&
          typeof tpl.version === 'number'
        ) {
          const ref = { id: tpl.id, version: tpl.version };
          hooks.push(async (tx, jobId) => {
            await ts.recordRun(tx, ctx.subject, jobId, project, ref, 'chat');
          });
        }
        const { job } = await this.deps.jobs.create({
          project,
          spec,
          // p9-queue-priority: the card's class (Normal unless the user asked for urgency or changed it).
          priority: PRIORITY_CLASS_VALUE[draftPriority(d)],
          actor: { type: 'user', id: userId },
          submit: true,
          ...(inputs.length > 0 ? { inputs } : {}),
          // p15-workspace-retention: from a job's kept working directory (readable by the confirming user).
          ...(typeof p.keptFilesFrom === 'string'
            ? { keptFilesFrom: await readableKeptSource(this.deps.pool, ctx.subject, p.keptFilesFrom) }
            : {}),
          // p16-zip-job-input: the card's input bundle, checked again for the confirming user (ready, same project).
          ...(typeof p.inputUpload === 'string'
            ? { inputUpload: (await this.#inputBundle(project, p.inputUpload)).id }
            : {}),
          ...(hooks.length === 0
            ? {}
            : {
                withinCreate: async (tx, jobId) => {
                  for (const h of hooks) await h(tx, jobId);
                },
              }),
        });
        void this.deps
          .orchestrator()
          .dispatch(job.id)
          .catch(() => undefined);
        return {
          jobId: job.id,
          project: job.project,
          state: job.state,
          ...(inputs.length > 0 ? { inputs: inputs.length } : {}),
          ...(deploy === null || recorded.id === null
            ? {}
            : {
                deployOnSuccess: {
                  id: recorded.id,
                  target: deploy.request.target,
                  env: deploy.request.env,
                },
              }),
        };
      }
      case 'workflow_run': {
        // p8-orchestration: run files of a workflow, read and checked again for the confirming user (p19-repo-inputs-
        // composer-workflows: repository projects too, while a machine advertises repo-inputs-v1).
        const refs = inputRefsOf(p);
        const files = hasInputRefs(refs)
          ? await prepareChatInputs(this.deps.pool, ctx.subject, String(p.project), refs)
          : [];
        const runId = await this.deps
          .workflows()
          .startRun({ type: 'user', id: userId }, String(p.workflowId), {
            // p18-multi-project W3: the run's project (an attaching project runs the owner's shared workflow there).
            ...(typeof p.ownerProject === 'string' && typeof p.project === 'string'
              ? { project: p.project }
              : {}),
            inputs: (p.inputs ?? {}) as Record<string, string>,
            ...(files.length > 0 ? { files } : {}),
            priority: PRIORITY_CLASS_VALUE[draftPriority(d)],
            // p14-workflow-engine 14.2: a v2 workflow's `trigger.chat` nodes fire (the user confirmed the card). The
            // inputs were drafted by the assistant from the conversation: untrusted data (design §6).
            trigger: {
              kind: 'chat',
              sourceTrust: 'untrusted',
              node: null,
              data: {
                threadId: d.threadId,
                draftId: d.id,
                inputs: (p.inputs ?? {}) as Record<string, string>,
              },
            },
          });
        return { runId, ...(files.length > 0 ? { files: files.length } : {}) };
      }
      case 'worker_config': {
        const workerId = String(p.workerId);
        const view = await this.deps.workerConfigs().get(workerId);
        const base = Number(p.baseGeneration);
        if (view.desired === null || view.desired.generation !== base) {
          throw new HttpError(
            409,
            'draft_stale',
            'The worker configuration changed since the draft was made; ask the assistant for a new draft.',
          );
        }
        const spec = { ...view.desired.spec, ...(p.patch as Record<string, unknown>) };
        const updated = await this.deps.workerConfigs().put(
          workerId,
          {
            spec,
            expectedGeneration: base,
            changeNote: `ops chat draft ${d.id}: ${text(p.reason)}`.slice(0, 1000),
          },
          ctx.actor,
        );
        return { workerId, generation: updated.desired?.generation ?? null };
      }
      case 'approval_decision': {
        const res = await this.deps.approvals.decide(
          String(p.approvalId),
          p.decision === 'approve' ? 'approve' : 'deny',
          ctx.human,
          { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent, reason: text(p.reason) },
        );
        return { approvalId: res.request.id, status: res.request.status, final: res.final };
      }
      case 'job_message': {
        const { messageId, status } = await this.deps.jobMessages.send(
          String(p.jobId),
          String(p.text),
          ctx.actor,
          {
            source: 'chat',
            // p15-message-delivery: confirming the same card twice never sends the message twice.
            clientId: d.id,
          },
        );
        return { jobId: String(p.jobId), messageId, delivery: status };
      }
      case 'time_limit': {
        const svc = this.deps.timeLimits?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Time limits cannot be changed here.',
            {},
            {},
            { reason: 'settings' },
          );
        const out = await svc.change(
          String(p.jobId),
          {
            ...(typeof p.maxDurationSec === 'number' ? { maxDurationSec: p.maxDurationSec } : {}),
            ...(typeof p.addSec === 'number' ? { addSec: p.addSec } : {}),
            ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
          },
          {
            subject: ctx.subject,
            ip: ctx.actor.ip,
            userAgent: ctx.actor.userAgent,
            via: ctx.direct === true ? 'chat' : 'console',
          },
        );
        return {
          jobId: String(p.jobId),
          changed: out.changed,
          maxDurationSec: out.timeLimit.maxDurationSec,
          live: out.timeLimit.changes.at(-1)?.delivery ?? null,
        };
      }
      case 'service_action':
        return this.#serviceAction(ctx, d);
      case 'job_resume': {
        const pause = this.deps.approvalPause?.() ?? null;
        if (pause === null)
          throw new HttpError(
            503,
            'unavailable',
            'Paused jobs cannot be resumed here.',
            {},
            {},
            { reason: 'resume' },
          );
        const out = await pause.requestResume(String(p.jobId), p.mode === 'restart' ? 'restart' : 'resume', {
          id: ctx.human.id,
          ip: ctx.actor.ip,
          userAgent: ctx.actor.userAgent ?? null,
        });
        return {
          jobId: String(p.jobId),
          mode: p.mode === 'restart' ? 'restart' : 'resume',
          state: out.state,
        };
      }
      case 'machine_task': {
        const ma = this.#machineAdmin();
        const out = await ma.createTask(
          String(p.workerId),
          {
            title: text(p.title),
            prompt: text(p.prompt),
            approvalPolicy: p.approvalPolicy === 'allow-all' ? 'allow-all' : 'ask-all',
            ...(typeof p.maxDurationSec === 'number' ? { maxDurationSec: p.maxDurationSec } : {}),
            draftId: d.id,
            ...this.#chatGrant(ctx, d),
          },
          ctx.actor,
        );
        return {
          workerId: String(p.workerId),
          jobId: out.jobId,
          state: out.state,
          ...(ctx.machineAdminByPolicy === true ? { commandsApprovedBy: 'policy' } : {}),
        };
      }
      case 'tool_install': {
        const workerId = String(p.workerId);
        const tool = String(p.tool) as ToolRecipeId;
        if (p.elevated === true) {
          const out = await this.#machineAdmin().createTask(
            workerId,
            { recipe: { tool, version: String(p.version) }, draftId: d.id, ...this.#chatGrant(ctx, d) },
            ctx.actor,
          );
          return {
            workerId,
            jobId: out.jobId,
            state: out.state,
            ...(ctx.machineAdminByPolicy === true ? { commandsApprovedBy: 'policy' } : {}),
          };
        }
        const ops = this.deps.remoteOps?.() ?? null;
        if (ops === null)
          throw new HttpError(
            503,
            'unavailable',
            'Remote operations are not available.',
            {},
            {},
            { reason: 'remote_ops' },
          );
        const op = await ops.request(
          workerId,
          { kind: 'tool.install', tool, version: String(p.version) },
          ctx.actor,
        );
        return { workerId, opId: op.id, state: op.state };
      }
      case 'support_report': {
        // p16-doctor: the same build and send as Ayarlar → Tanılama (redaction, sections, cap, audit).
        const svc = this.deps.support?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Diagnostics are not available.',
            {},
            {},
            { reason: 'doctor' },
          );
        const actor = { userId: ctx.actor.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent };
        const sections = (Array.isArray(p.sections) ? p.sections : []).filter(
          (s): s is SupportReportSection => (SUPPORT_REPORT_SECTIONS as readonly unknown[]).includes(s),
        );
        const preview = await svc.build(actor, {
          ...(sections.length === 0 ? {} : { sections }),
          hours: typeof p.hours === 'number' ? p.hours : 24,
          description: typeof p.description === 'string' ? p.description : null,
          source: 'chat',
        });
        const sent = await svc.send(actor, preview.id, { ccMe: p.ccMe === true, source: 'chat' });
        return {
          reportId: preview.id,
          sentTo: sent.to,
          cc: sent.cc,
          attached: sent.attached,
          sizeBytes: sent.sizeBytes,
          sha256: sent.sha256,
          ...(sent.attached
            ? {}
            : {
                note: 'Larger than 10 MB: only the summary was e-mailed; download the zip in Ayarlar → Tanılama.',
              }),
        };
      }
      case 'webhook': {
        // p16-webhooks-out: the same service path as Ayarlar → Webhook'lar (validation, egress floor, audit). The secret
        // of a created webhook is never in the card's result: the console shows it once.
        const svc = this.deps.webhooks?.() ?? null;
        if (svc === null)
          throw new HttpError(
            503,
            'unavailable',
            'Webhooks are not available.',
            {},
            {},
            { reason: 'webhooks' },
          );
        const actor = { userId: ctx.actor.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent };
        if (p.op === 'pause' || p.op === 'resume') {
          const w = await svc.setState(
            actor,
            String(p.webhookId),
            p.op === 'pause' ? 'paused' : 'active',
            'chat',
          );
          return { webhookId: w.id, name: w.name, state: w.state };
        }
        const out = await svc.create(
          actor,
          {
            name: String(p.name),
            url: String(p.url),
            project: typeof p.project === 'string' ? p.project : null,
            eventTypes: Array.isArray(p.eventTypes) ? p.eventTypes.map(String) : [],
            includeDetails: p.includeDetails === true,
          },
          { reveal: false, source: 'chat' },
        );
        return {
          webhookId: out.subscription.id,
          name: out.subscription.name,
          state: out.subscription.state,
          secret: 'shown once in Ayarlar → Webhook’lar (Gizli anahtarı göster)',
        };
      }
      case 'runtime_update': {
        // p16-runtime-updates: the fleet pipeline re-plans every machine now (policy, pinned set, worker build) — the
        // card cannot carry a weaker path than the screen.
        const fleet = this.deps.fleetTools?.() ?? null;
        if (fleet === null)
          throw new HttpError(
            503,
            'unavailable',
            'The fleet tools service is not available.',
            {},
            {},
            { reason: 'fleet' },
          );
        const workers = Array.isArray(p.workers)
          ? (p.workers as unknown[])
              .map((w): unknown => (typeof w === 'object' && w !== null ? (w as { id?: unknown }).id : w))
              .filter((w): w is string => typeof w === 'string')
          : 'all';
        const rollback = p.rollback === true;
        const action = await fleet.create(
          {
            kind: 'runtime.install',
            item: String(p.runtime),
            ...(typeof p.version === 'string' ? { version: p.version } : {}),
            ...(p.unverified === true && !rollback ? { unverified: true } : {}),
            workers,
            rollout: p.rollout === 'all' ? 'all' : 'canary-first',
          },
          false,
          ctx.actor,
        );
        return { actionId: action.id, state: action.state, counts: action.counts };
      }
      case 'automation':
      case 'automation_change':
        throw new Error('automation drafts are executed by #automation');
      case 'ops_action':
        throw new Error('ops drafts are executed by #opsAction');
      case 'coolify_change':
        throw new Error('coolify drafts are executed by the coolify runner');
      case 'github_repo':
        throw new Error('github repository drafts are executed by the github runner');
      case 'project_create':
        throw new Error('project drafts are executed by the project runner');
      case 'thread_projects':
      case 'workflow_attach':
      case 'job_batch':
        throw new Error('multi-project drafts are executed by their runners');
      case 'workfiles_export':
        throw new Error('workfiles export drafts are executed by the workfiles runner');
      case 'install_script_approval':
        throw new Error('install script drafts are executed by the install script runner');
      case 'http_request':
        throw new Error('http request drafts are executed by the http request runner');
      case 'credential_save':
        // p15-chat-vault: only the user's browser can seal the value (ADR-0016); the card is completed by
        // POST /chat/drafts/:id/credential-saved after the browser created the credential.
        throw new HttpError(
          409,
          'browser_only',
          'Only your browser can seal this value: save it with the card in the conversation.',
          {},
          {},
          { reason: 'credential_save' },
        );
      case 'monitor':
        throw new Error('monitor drafts are executed by #monitor');
      case 'job_action':
        throw new Error('job action drafts are executed by JobActionRunner');
      case 'account_action': {
        const accounts = this.deps.accounts?.() ?? null;
        const switcher = this.deps.accountSwitch?.() ?? null;
        if (accounts === null || switcher === null) {
          throw new HttpError(
            503,
            'unavailable',
            'Runtime accounts are not available.',
            {},
            {},
            { reason: 'runtime_accounts' },
          );
        }
        const actor = { userId: ctx.human.id, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent ?? null };
        if (p.action === 'switch_job') {
          try {
            const result = await switcher.switchAccount(
              String(p.jobId),
              { workerId: String(p.workerId), runtime: String(p.runtime), account: String(p.account) },
              actor,
            );
            return { jobId: String(p.jobId), account: String(p.account), result };
          } catch (err) {
            // p22-coolify-env-exists (the same class of failure): the job already runs with that
            // account — what the card asked for is true; it closes as done instead of failing.
            if (err instanceof HttpError && err.code === 'same_account') {
              return { jobId: String(p.jobId), account: String(p.account), result: 'unchanged' };
            }
            // The job finished before the card was confirmed: nothing left to move (closed, not an error).
            if (err instanceof HttpError && err.code === 'job_finished') {
              return { jobId: String(p.jobId), account: String(p.account), result: 'job_finished' };
            }
            throw err;
          }
        }
        const a = await accounts.update(
          String(p.workerId),
          String(p.runtime),
          String(p.account),
          {
            paused: p.action === 'pause',
            ...(typeof p.reason === 'string' ? { pausedReason: p.reason } : {}),
          },
          actor,
        );
        return { workerId: a.workerId, runtime: a.runtime, account: a.id, state: a.state };
      }
      case 'memory_change':
        throw new Error('memory drafts are executed by #memoryChange');
      case 'workflow':
        throw new Error('workflow drafts are executed by #workflow');
      case 'skill_import': {
        // p14-skill-catalogs: the card's import preview, published through the P1 pipeline (panel signature, provenance,
        // owners' notification, audit) and assigned if the card names a project. The files must still be the ones the
        // card showed (sha256 per path), so a preview can never be swapped under a confirmed card.
        const imports = this.deps.skillImports?.() ?? null;
        if (imports === null)
          throw new HttpError(503, 'unavailable', 'Skills are not available.', {}, {}, { reason: 'skills' });
        const user = {
          id: userId,
          role: ctx.human.role,
          mfaAt: ctx.human.mfaAt,
          ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
        };
        const view = await imports.get(user, String(p.importId));
        const shown = Array.isArray(p.files) ? (p.files as { path?: unknown; sha256?: unknown }[]) : [];
        const same =
          view.state === 'previewed' &&
          view.files.length === shown.length &&
          view.files.every((f) => shown.some((s) => s.path === f.path && s.sha256 === f.sha256));
        if (!same) {
          throw new HttpError(
            409,
            'skill_import_closed',
            'The import behind this card was published, discarded or changed; propose it again.',
            {},
            {},
            { reason: 'handled' },
          );
        }
        const project = typeof p.project === 'string' ? p.project : null;
        if (project !== null && !authorize(ctx.subject, 'skills.assign').allow) {
          throw new HttpError(
            403,
            'forbidden',
            'You are not allowed to do what this draft proposes.',
            {},
            {},
            { reason: 'draft' },
          );
        }
        const out = await imports.publish(
          user,
          String(p.importId),
          {
            skillId: String(p.skillId),
            title: String(p.title),
            description: String(p.description),
            version: String(p.version),
            runtimes: p.runtimes as RuntimeKind[],
            assign: project === null ? null : { project },
          },
          { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
        );
        return {
          skillId: String(p.skillId),
          version: out.version.version,
          signer: out.version.signer,
          layout: out.version.layout,
          assignedTo: out.assignment?.project ?? null,
        };
      }
      case 'mcp_install': {
        // p14-mcp-chat (design §4.3, §15): the card's install preview, confirmed exactly as shown (proposal sha256),
        // through the same service as Yetenekler → Keşfet: panel signature, assignment, the project switch only when
        // ticked, the canary-first install, tool discovery. The always-fresh step-up was checked above.
        const previews = this.deps.mcpPreviews?.() ?? null;
        if (previews === null)
          throw new HttpError(
            503,
            'unavailable',
            'MCP servers are not available.',
            {},
            {},
            { reason: 'mcp' },
          );
        const project = typeof p.project === 'string' ? p.project : null;
        if (project !== null && !authorize(ctx.subject, 'mcp.assign').allow) {
          throw new HttpError(
            403,
            'forbidden',
            'You are not allowed to do what this draft proposes.',
            {},
            {},
            { reason: 'draft' },
          );
        }
        const user = {
          id: userId,
          role: ctx.human.role,
          mfaAt: ctx.human.mfaAt,
          ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
        };
        const out = await previews.publish(
          user,
          String(p.previewId),
          {
            expectSha: String(p.proposalSha256),
            project,
            enableProject: p.enableProject === true,
            workers: 'all',
          },
          { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
        );
        return { ...out };
      }
      case 'skill': {
        const skills = this.deps.skills?.() ?? null;
        if (skills === null)
          throw new HttpError(503, 'unavailable', 'Skills are not available.', {}, {}, { reason: 'skills' });
        const out = await skills.publishPanelSigned(
          {
            id: userId,
            role: ctx.human.role,
            mfaAt: ctx.human.mfaAt,
            ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
          },
          {
            skillId: String(p.skillId),
            title: String(p.title),
            description: String(p.description),
            runtimes: p.runtimes as RuntimeKind[],
            version: String(p.version),
            files: p.files as Record<string, string>,
            assignAllProjects: p.assignAllProjects === true,
          },
          { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
        );
        return {
          skillId: String(p.skillId),
          version: out.version.version,
          signer: out.version.signer,
          assignedAllProjects: out.assignment !== null,
        };
      }
      case 'settings_change':
        // Runs in #run (the settings runner); never reaches here.
        throw new HttpError(
          400,
          'invalid_draft',
          'Unexpected settings card.',
          {},
          {},
          { reason: 'settings' },
        );
    }
  }

  /**
   * p15-services: start / stop / restart a service through the registry — the same checks as the console buttons
   * (project operator+, a project admin for `unconfined`, limits, spec validation), audited `via: chat`.
   */
  async #serviceAction(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const svc = this.deps.services?.() ?? null;
    if (svc === null)
      throw new HttpError(503, 'unavailable', 'Services are not available.', {}, {}, { reason: 'services' });
    const p = d.payload;
    const caller = {
      subject: ctx.subject,
      actor: { type: 'user' as const, id: ctx.subject.userId, ip: ctx.actor.ip === '' ? null : ctx.actor.ip },
      via: 'chat' as const,
    };
    const brief = (v: ServiceView) => ({
      serviceId: v.id,
      name: v.name,
      project: v.project,
      machine: v.workerName ?? v.workerId,
      state: v.state,
      url: v.url,
      expiresAt: v.expiresAt,
    });
    switch (p.op) {
      case 'start': {
        const v = await svc.create(caller, {
          project: String(p.project),
          worker: typeof p.worker === 'string' ? p.worker : undefined,
          fromJobId: typeof p.fromJobId === 'string' ? p.fromJobId : undefined,
          baseRef: typeof p.baseRef === 'string' ? p.baseRef : undefined,
          sandboxProfile:
            p.sandboxProfile === 'unconfined' || p.sandboxProfile === 'host-restricted'
              ? p.sandboxProfile
              : undefined,
          request: p.request as Parameters<ServiceRegistry['create']>[1]['request'],
        });
        return { op: 'start', ...brief(v) };
      }
      case 'stop': {
        const v = await svc.stop(caller, String(p.serviceId), {
          remove: p.remove === true,
          reason: 'stopped from chat',
        });
        return { op: 'stop', removed: p.remove === true, ...brief(v) };
      }
      case 'restart': {
        const v = await svc.restart(caller, String(p.serviceId), {
          extendMinutes: typeof p.extendMinutes === 'number' ? p.extendMinutes : undefined,
          untilStopped: p.untilStopped === true ? true : undefined,
        });
        return { op: 'restart', ...brief(v) };
      }
      default:
        throw new HttpError(400, 'invalid_draft', 'Unknown service action.', {}, {}, { reason: 'services' });
    }
  }

  /**
   * p19-chat-machine-admin: the grant a machine administration job started by the user's own chat message carries —
   * its elevated commands pass by policy while the switch stays on (MachineAdminService re-checks it per command).
   */
  #chatGrant(
    ctx: ConfirmContext,
    d: DraftRecord,
  ): { chatGrant?: { userId: string; draftId: string; threadId: string; goalGrantId?: string } } {
    return ctx.machineAdminByPolicy === true
      ? {
          chatGrant: {
            userId: ctx.subject.userId,
            draftId: d.id,
            threadId: d.threadId,
            // p20-scope-preview: inherited by a continuation — its commands pass only while that grant holds.
            ...(ctx.goalGrantId === undefined ? {} : { goalGrantId: ctx.goalGrantId }),
          },
        }
      : {};
  }

  #machineAdmin(): MachineAdminService {
    const ma = this.deps.machineAdmin?.() ?? null;
    if (ma === null)
      throw new HttpError(
        503,
        'unavailable',
        'Machine administration is not available.',
        {},
        {},
        { reason: 'machine_admin' },
      );
    return ma;
  }
}
