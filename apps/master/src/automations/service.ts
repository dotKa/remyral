import { type OriginInput, originOf } from '../console-domain/origin.js';
import { isValidTimeZone, JobSpec, normalizeJobTitle, zonedToUtc } from '@remyral/protocol';
import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import type { Role } from '../auth/users.js';
import { loadSubject } from '../authz/authorizer.js';
import type { OutputFolders } from '../outputs/folders.js';
import { authorize, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { githubRepo } from '../gitflow/refs.js';
import type { PreviewDeps } from '../composer/preview.js';
import {
  IllegalTransitionError,
  InvalidJobError,
  namesRemovedRuntime,
  RUNTIME_REMOVED_MESSAGE,
  VersionConflictError,
} from '../jobs/errors.js';
import type { JobStore } from '../jobs/store.js';
import type { ResultReuseService } from '../reuse/service.js';
import { OpsError } from '../ops/model.js';
import type {
  DeployOnSuccessService,
  PreparedDeployOnSuccess,
  SavedDeployOnSuccess,
} from '../ops/on-success.js';
import type { TickStep } from '../orchestration/orchestrator.js';
import type { CancelSender } from '../quotas/service.js';
import {
  CronError,
  describeCron,
  minIntervalMinutes,
  nextRun,
  nextRuns,
  parseCron,
} from '../schedules/cron.js';
import {
  combineInputs,
  type PreparedInput,
  projectKind,
  type WorkspaceService,
} from '../workspaces/service.js';
import { requireReadableJob } from '../workspaces/submission.js';
import { clampLimit, decodeKeyset, keysetPage } from '../http/pagination.js';
import { type CatchUpPolicy, planCatchUp, planOneShot } from './catchup.js';
import { type AppliedDefaults, type PlacementAdvice, ProjectDefaults } from '../composer/defaults.js';
import {
  describeGitHubTrigger,
  eventRepository,
  type GitHubTrigger,
  matchGitHubEvent,
  triggerEvents,
  validateActions,
} from './github-events.js';
import {
  type AutomationDetail,
  AutomationError,
  type AutomationInput,
  type AutomationPatch,
  type AutomationState,
  type AutomationTarget,
  type AutomationTrigger,
  type AutomationView,
  type ContinueFrom,
  EXTERNAL_KINDS,
  type RunDetail,
  type RunView,
  type TriggerKind,
  UUID,
  type WaitingApprovalView,
} from './model.js';
import {
  type AutomationRunOutboxPayload,
  type AutomationWaitingOutboxPayload,
  OUTBOX_TOPIC_AUTOMATION_RUN,
  OUTBOX_TOPIC_AUTOMATION_WAITING,
} from './outbox.js';
import {
  AUTOMATION_LIMITS,
  type ChainOutcome,
  chainMatches,
  chainOutcomeOf,
  chainProblem,
  type Concurrency,
  type RunState,
  runStateOfJob,
  runStateOfWorkflow,
  startDecision,
} from './policy.js';
import {
  newWebhookSecret,
  payloadDigest,
  secretHint,
  verifyGitHubSignature,
  verifyRemyralWebhook,
} from './webhook-signature.js';
import type { VerificationService } from '../verify/service.js';
import { jobVaultRefIssues } from '../project-env/job-refs.js';

/**
 * Automations (docs/design/p6-automations.md, ADR-0024): triggers → runs → jobs / workflow runs.
 *
 * - Every trigger inserts one `automation_runs` row under UNIQUE (automation_id, dedup_key): at-least-once delivery
 *   (GitHub redelivery, webhook retry, racing sweepers, a chain evaluated twice) never makes a second run.
 * - The start pass claims `queued → starting` in its own transaction before anything is submitted: a run starts at
 *   most once (a crash leaves `starting`, swept to `error` after {@link AUTOMATION_LIMITS.startingTimeoutMs}).
 * - The run-as user's right to submit is re-checked at every start (account enabled, role and membership now).
 * - Event content stays data (`event_data`): it reaches the job only through {@link AutomationContextProvider}.
 */

const ONE_HOUR = 3_600_000;
const MIN_CRON_INTERVAL_MINUTES = 5;
const MAX_AHEAD_DAYS = 366;
/** A GitHub delivery body seen within this window does not start a second run (replay under a new id). */
const GITHUB_REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_EVENT_BYTES = 64 * 1024;
const SYSTEM = { type: 'system', id: 'automations' } as const;
/** Reason prefix of a run whose job was cancelled because nobody approved in time (kept when the job ends). */
export const APPROVAL_TIMEOUT_REASON = 'Approval timeout:';
const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 60;

export interface AutomationActor {
  readonly id: string;
  /** The caller's authorization subject (needed for GitHub / webhook triggers: `automations.external`). */
  readonly subject?: Subject;
  /** The request satisfies a standard step-up now (resume of an external automation). */
  readonly stepUpFresh?: boolean;
  /** p6-deploy-on-success: the session's TOTP time and accepted always-fresh age (production pre-approval). */
  readonly mfaAt?: Date | null;
  readonly stepUpMaxAgeMs?: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Starts a workflow run (WorkflowService.startRun); errors carry `status`/`code`. */
export type WorkflowStarter = (
  actor: { type: 'user'; id: string },
  definitionId: string,
  input: {
    inputs: Readonly<Record<string, string>>;
    repository?: { url: string; baseRef: string };
    /** p5-research-workspace-next: run files of a workspace project's run. */
    files?: readonly PreparedInput[];
    /** p9-queue-priority: the queue priority of every step job. */
    priority?: number;
    /** p18-multi-project: the project the run belongs to (the automation's; a shared workflow runs there). */
    project?: string;
    /**
     * p14-workflow-engine 14.2: the event the run starts from — the bound trigger node (null: the workflow's manual
     * triggers) and the event data (`$trigger`, untrusted for webhook / GitHub / workflow sources).
     */
    trigger?: {
      kind: 'schedule' | 'webhook' | 'github' | 'workflow' | 'automation';
      sourceTrust: 'trusted' | 'untrusted';
      node: string | null;
      data: Record<string, unknown> | null;
    };
  },
) => Promise<string>;

export interface AutomationServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly jobs: JobStore;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** Master key box; the webhook secrets use its HKDF sub-key `automation-webhook`. */
  readonly box: SecretBox;
  /** Orchestrator.dispatch (best effort; the loop dispatches anyway). */
  readonly dispatch: (jobId: string) => Promise<unknown>;
  readonly startWorkflow: () => WorkflowStarter;
  /** Public console origin for webhook URLs (null: shown relative; p17-domain-wizard: live). */
  readonly publicOrigin: OriginInput;
  /** The panel GitHub App's webhook secret (null: no App connected or no secret). */
  readonly githubWebhookSecret: () => Promise<string | null>;
  /**
   * p17-chat-github: the secrets a GitHub delivery is checked against — of the App it names (`null`: the delivery
   * names none, every connection's). Absent: the single {@link githubWebhookSecret}.
   */
  readonly githubWebhookSecrets?: (appId: string | null) => Promise<string[]>;
  /**
   * p22-github-webhook: every verified delivery with a repository is also handed to the git flow (results waiting for
   * approval are re-checked when their branches, pull request or CI change). Errors never fail the delivery.
   */
  readonly githubGitEvents?: (repo: string, event: string, payload: unknown) => Promise<unknown>;
  /**
   * p6-automation-defaults: the composer's placement preview facts (project defaults: the best ready host profile,
   * job limits; placement advice for drafts). Absent: defaults from the project row only (container).
   */
  readonly preview?: () => PreviewDeps;
  /** p6-automation-defaults: CANCEL_JOB to the lease holder (approval timeout). Absent: the state change only. */
  readonly cancel?: () => CancelSender;
  /**
   * p5-research-workspace-next: input files and continue-from of automations on workspace projects (absent: refused).
   */
  readonly workspaces?: WorkspaceService;
  /**
   * p6-automations-next (§18.3): cancels a whole workflow run (WorkflowService.cancelRun as the system actor
   * `automations`). Absent: only the waiting job is cancelled.
   */
  readonly cancelWorkflow?: () => (workflowRunId: string, reason: string) => Promise<void>;
  /** p6-deploy-pipeline: ops actions for deploy targets (absent: deploy targets are refused). */
  readonly deploy?: () => AutomationDeployPort | null;
  /** p6-result-reuse: the reuse policy's lookup (absent: the policy is stored but never skips a run). */
  readonly reuse?: ResultReuseService;
  /** p6-deploy-on-success: job targets that deploy each run's job when it succeeds (absent: refused). */
  readonly deployOnSuccess?: () => DeployOnSuccessService | null;
  /** p10-verify-health: each run's job gets the automation's "Verify when done" (or the project's default). */
  readonly verification?: () => VerificationService | null;
  /** p8-outputs-folders: job targets that file each run's outputs into a folder (absent: refused). */
  readonly outputFolders?: () => OutputFolders | null;
  /**
   * p8-cost-efficiency: why a run of `project` must not start now — an exhausted budget whose policy pauses new jobs
   * or blocks automations (QuotaService.automationBlocked) — or null. Absent: runs start (admission still holds).
   */
  readonly budgetGate?: () => ((project: string, runtime: string | null) => Promise<string | null>) | null;
}

/** The continue-from rule of a job / workflow target (deploy targets have none). */
function continueFromOf(t: AutomationTarget): ContinueFrom | null | undefined {
  return t.kind === 'deploy' ? undefined : t.continueFrom;
}

/** p6-deploy-pipeline (ADR-0028): what automations need from the ops service (wired in compose.ts). */
export interface AutomationDeployPort {
  /** null when the project can take this action (targets configured, parameters valid); else why not. */
  check(project: string, action: { kind: string; params: Record<string, unknown> }): Promise<string | null>;
  /** Requests the ops action for one run (idempotent per run). */
  request(input: {
    automationId: string;
    runId: string;
    project: string;
    runAs: string;
    action: { kind: string; params: Record<string, unknown> };
  }): Promise<{ actionId: string; state: string }>;
}

/** §18.1: grace period of the previous webhook secret after a rotation (hours). */
export const DEFAULT_WEBHOOK_GRACE_HOURS = 24;
export const MAX_WEBHOOK_GRACE_HOURS = 7 * 24;

/**
 * §18.5: parses a webhook IP allow-list (addresses or CIDRs, IPv4 / IPv6). Returns the normalised entries and the
 * block list, or the first invalid entry.
 */
export function parseAllowIps(
  entries: readonly string[],
): { ok: true; entries: string[]; list: BlockList } | { ok: false; entry: string } {
  const list = new BlockList();
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    const [addr = '', prefix, extra] = entry.split('/');
    const family = isIP(addr);
    if (family === 0 || extra !== undefined) return { ok: false, entry: raw };
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(addr, type);
    } else {
      if (!/^\d{1,3}$/.test(prefix)) return { ok: false, entry: raw };
      const bits = Number(prefix);
      if (bits > (family === 4 ? 32 : 128)) return { ok: false, entry: raw };
      list.addSubnet(addr, bits, type);
    }
    out.push(entry);
  }
  return { ok: true, entries: out, list };
}

/** Is `ip` (the request's client address; IPv4-mapped IPv6 unwrapped) in the allow-list? */
export function ipAllowed(list: BlockList, ip: string): boolean {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const addr = v4 ?? ip;
  const family = isIP(addr);
  if (family === 0) return false;
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

interface Row {
  id: string;
  project: string;
  name: string;
  description: string | null;
  state: AutomationState;
  trigger_kind: TriggerKind;
  trigger: Record<string, unknown>;
  cron: string | null;
  /** p16-workflow-quality: the zone of a cron / at schedule (migration 0140; existing rows: UTC). */
  time_zone: string;
  run_at: Date | null;
  next_run_at: Date | null;
  github_repo: string | null;
  github_event: string | null;
  chain_source_id: string | null;
  chain_source_name?: string | null;
  webhook_secret: Buffer | null;
  webhook_secret_hint: string | null;
  webhook_secret_rotated_at: Date | null;
  webhook_secret_previous: Buffer | null;
  webhook_secret_previous_hint: string | null;
  webhook_secret_previous_expires_at: Date | null;
  webhook_allow_ips: string[] | null;
  github_events: string[] | null;
  chain_source_project?: string | null;
  /** p14-workflow-engine 14.2 (migration 0103): a workflow's trigger node bound to this automation. */
  workflow_trigger_node: string | null;
  source_workflow_project: string | null;
  source_workflow_name: string | null;
  binding_name?: string | null;
  target_kind: 'job' | 'workflow' | 'deploy';
  deploy_action: { kind: string; params: Record<string, unknown> } | null;
  /** p6-deploy-on-success (migration 0058). */
  deploy_on_success: SavedDeployOnSuccess | null;
  /** p8-outputs-folders (migration 0070). */
  output_folder_id: string | null;
  /** p10-verify-health (migration 0077). */
  verify_on_success?: 'off' | 'report' | 'gate' | null;
  job_spec: Record<string, unknown> | null;
  priority: number;
  workflow_id: string | null;
  workflow_inputs: Record<string, string> | null;
  workflow_repository: { url: string; baseRef: string } | null;
  concurrency: Concurrency;
  catch_up: CatchUpPolicy;
  max_runs_per_hour: number;
  notify_on_failure: boolean;
  approval_timeout_minutes: number | null;
  reuse_within_hours: number | null;
  continue_from: ContinueFrom | null;
  run_as: string;
  run_count: number;
  last_run_id: string | null;
  last_run_state: RunState | null;
  last_run_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** p18-multi-project W4 (migration 0185): the automation group ("Projeler") and whether this sibling diverged. */
  group_id?: string | null;
  diverged?: boolean;
  group_name?: string | null;
  group_size?: number | null;
}

interface RunRow {
  id: string;
  automation_id: string;
  project: string;
  trigger_kind: string;
  dedup_key: string;
  scheduled_for: Date | null;
  payload_digest: string | null;
  event_summary: Record<string, unknown> | null;
  event_data: Record<string, unknown> | null;
  source_trust: 'trusted' | 'untrusted';
  state: RunState;
  reason: string | null;
  job_id: string | null;
  job_state?: string | null;
  workflow_run_id: string | null;
  chain_parent_run_id: string | null;
  chain_depth: number;
  checkout_ref: string | null;
  checkout_pull_request: number | null;
  checkout_head_sha: string | null;
  triggered_by: string | null;
  approval_waiting_at: Date | null;
  reused_job_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const SELECT_AUTOMATION = `SELECT a.*, src.name AS chain_source_name, src.project AS chain_source_project,
       b.name AS binding_name, g.name AS group_name,
       (SELECT count(*)::int FROM automations s WHERE s.group_id = a.group_id AND s.state <> 'deleted') AS group_size
  FROM automations a LEFT JOIN automations src ON src.id = a.chain_source_id
  LEFT JOIN workflow_trigger_bindings b ON b.automation_id = a.id
  LEFT JOIN automation_groups g ON g.id = a.group_id`;
/** Keyset scope of the run-history cursor (p9-pagination). */
const RUNS_SCOPE = 'automations.runs';

const SELECT_RUN = `SELECT r.*, j.state AS job_state FROM automation_runs r LEFT JOIN jobs j ON j.id = r.job_id`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** A trigger as stored (zod-validated on write) — a read model, so cast without re-validation. */
const triggerOf = (r: Row): AutomationTrigger =>
  ({ ...r.trigger, kind: r.trigger_kind }) as AutomationTrigger;

function firstLine(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  const t = line.trim();
  return t === '' ? null : t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

export interface EnqueueEvent {
  readonly triggerKind: 'cron' | 'at' | 'github' | 'webhook' | 'chain' | 'manual';
  readonly dedupKey: string;
  readonly scheduledFor?: Date | null;
  readonly payloadDigest?: string | null;
  readonly summary?: Record<string, unknown> | null;
  readonly data?: Record<string, unknown> | null;
  readonly trust?: 'trusted' | 'untrusted';
  readonly chainParentRunId?: string | null;
  readonly chainDepth?: number;
  readonly checkoutRef?: string | null;
  /** §18.2: untrusted pull request head, pinned to the event's head SHA. */
  readonly checkoutPullRequest?: { readonly number: number; readonly headSha: string } | null;
  readonly triggeredBy?: string | null;
  /** Record as skipped right away (missed occurrence …). */
  readonly skip?: string;
  /** Extra reason on a queued run (catch-up folding). */
  readonly note?: string | null;
}

export type HookResult =
  | { readonly status: 202; readonly body: { readonly accepted: true; readonly runs: readonly string[] } }
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401 | 404 | 409 | 413 | 503; readonly body: { error: string; message: string } };

const refuse = (status: 400 | 401 | 404 | 409 | 413 | 503, error: string, message: string): HookResult => ({
  status,
  body: { error, message },
});

export class AutomationService {
  readonly #box: SecretBox;
  #chain: Promise<void> = Promise.resolve();
  readonly #rejectAudited = new Map<string, number>();

  /** §2a: the shared project defaults / placement advice (composer/defaults.ts). */
  readonly #defaults: ProjectDefaults;

  constructor(private readonly deps: AutomationServiceDeps) {
    this.#box = new SecretBox(deps.box.deriveKey('automation-webhook'));
    this.#defaults = new ProjectDefaults({
      db: deps.pool,
      preview: deps.preview,
      onError: (err, what, project) => {
        deps.log.warn(
          { err, project },
          what === 'defaults'
            ? 'automation defaults: placement preview failed; container default'
            : 'automation placement preview failed',
        );
      },
    });
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** p14-workflow-engine 14.2: a bound automation is changed through its workflow's trigger nodes. */
  #bound(): AutomationError {
    return this.#err(
      409,
      'automation_bound',
      'This automation belongs to a workflow trigger node; change it on the workflow canvas.',
    );
  }

  #err(status: number, code: string, message: string): AutomationError {
    return new AutomationError(status, code, message);
  }

  #cron(text: string, timeZone = 'UTC') {
    let c;
    try {
      c = parseCron(text, timeZone);
    } catch (err) {
      if (err instanceof CronError) throw this.#err(400, 'invalid_trigger', `Invalid cron: ${err.message}.`);
      throw err;
    }
    const now = this.deps.clock();
    if (nextRun(c, now) === null) throw this.#err(400, 'invalid_trigger', 'The cron expression never runs.');
    const gap = minIntervalMinutes(c, now);
    if (gap !== null && gap < MIN_CRON_INTERVAL_MINUTES) {
      throw this.#err(
        400,
        'invalid_trigger',
        `The cron expression runs more often than every ${String(MIN_CRON_INTERVAL_MINUTES)} minutes.`,
      );
    }
    return c;
  }

  webhookUrl(id: string): string {
    return `${originOf(this.deps.publicOrigin) ?? ''}/v1/hooks/${id}`;
  }

  githubHookUrl(): string {
    return `${originOf(this.deps.publicOrigin) ?? ''}/v1/hooks/github`;
  }

  /** Next run times and a human summary of a cron expression (builder preview), read in `timeZone` (default UTC). */
  preview(
    cron: string,
    count = 5,
    timeZone = 'UTC',
  ): { cron: string; timeZone: string; summary: string; nextRuns: Date[] } {
    const c = this.#cron(cron, this.#zone(timeZone));
    return {
      cron: c.source,
      timeZone: c.timeZone,
      summary: describeCron(c),
      nextRuns: nextRuns(c, this.deps.clock(), count),
    };
  }

  /** p16-workflow-quality: an IANA zone the runtime knows, else a 400 `invalid_trigger`. */
  #zone(timeZone: string | undefined): string {
    const tz = timeZone ?? 'UTC';
    if (!isValidTimeZone(tz)) {
      throw this.#err(
        400,
        'invalid_trigger',
        `Unknown time zone "${tz.slice(0, 64)}": use an IANA name such as Europe/Istanbul or UTC.`,
      );
    }
    return tz;
  }

  #summary(r: Row): string {
    const t = triggerOf(r);
    switch (t.kind) {
      case 'cron': {
        try {
          return describeCron(parseCron(t.cron, r.time_zone));
        } catch {
          return `Cron ${t.cron}`;
        }
      }
      case 'at':
        return r.time_zone === 'UTC'
          ? `Once at ${(r.run_at ?? new Date(t.at)).toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : `Once at ${wallText(r.run_at ?? new Date(t.at), r.time_zone)} ${r.time_zone}`;
      case 'github':
        return describeGitHubTrigger(t);
      case 'webhook':
        return 'Signed webhook';
      case 'chain':
        // p14-workflow-engine 14.2: a workflow's runs (`trigger.workflow`).
        if (t.workflow !== undefined)
          return (t.workflow.project ?? r.project) === r.project
            ? `After workflow “${t.workflow.name}” ${t.on.join(' or ')}`
            : `After a workflow of another project ${t.on.join(' or ')}`;
        // §18.4: a source in another project is not named in summaries (lists go to that project's readers too).
        return r.chain_source_project !== undefined &&
          r.chain_source_project !== null &&
          r.chain_source_project !== r.project
          ? `After an automation of another project ${t.on.join(' or ')}`
          : `After “${r.chain_source_name ?? 'another automation'}” ${t.on.join(' or ')}`;
    }
  }

  #view(
    r: Row,
    successRate: number | null,
    waiting: (WaitingApprovalView & { runId: string }) | null = null,
  ): AutomationView {
    const runtime = typeof r.job_spec?.runtime === 'string' ? r.job_spec.runtime : null;
    const specText = (k: string): string | null => {
      const v = r.job_spec?.[k];
      return typeof v === 'string' ? v : null;
    };
    return {
      id: r.id,
      project: r.project,
      name: r.name,
      description: r.description,
      state: r.state,
      enabled: r.state === 'active',
      trigger: triggerOf(r),
      triggerSummary: this.#summary(r),
      timeZone: r.time_zone,
      target: {
        kind: r.target_kind,
        deployAction: r.deploy_action,
        runtime,
        workflowId: r.workflow_id,
        title: firstLine(r.job_spec?.prompt),
        approvalPolicy: specText('approvalPolicy'),
        sandboxProfile: specText('sandboxProfile'),
      },
      approvalTimeoutMinutes: r.approval_timeout_minutes,
      reuseWithinHours: r.reuse_within_hours ?? null,
      waiting,
      concurrency: r.concurrency,
      catchUp: r.catch_up,
      maxRunsPerHour: r.max_runs_per_hour,
      notifyOnFailure: r.notify_on_failure,
      nextRunAt: iso(r.next_run_at),
      lastRun:
        r.last_run_id === null || r.last_run_state === null || r.last_run_at === null
          ? null
          : { id: r.last_run_id, state: r.last_run_state, at: r.last_run_at.toISOString() },
      runCount: r.run_count,
      successRate,
      webhook:
        r.trigger_kind === 'webhook'
          ? {
              url: this.webhookUrl(r.id),
              secretHint: r.webhook_secret_hint ?? '',
              rotatedAt: (r.webhook_secret_rotated_at ?? r.created_at).toISOString(),
              previous: this.#previousLive(r)
                ? {
                    secretHint: r.webhook_secret_previous_hint ?? '',
                    expiresAt: (r.webhook_secret_previous_expires_at ?? r.updated_at).toISOString(),
                  }
                : null,
              allowIps: r.webhook_allow_ips,
            }
          : null,
      runAs: r.run_as,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      workflowBinding:
        r.workflow_trigger_node === null
          ? null
          : {
              workflowId: r.workflow_id ?? '',
              project: r.project,
              name: r.binding_name ?? '',
              triggerNode: r.workflow_trigger_node,
            },
      group:
        r.group_id == null
          ? null
          : {
              id: r.group_id,
              name: r.group_name ?? r.name,
              size: r.group_size ?? 1,
              diverged: r.diverged === true,
            },
    };
  }

  /** §18.1: the previous webhook secret is still accepted now. */
  #previousLive(r: Row): boolean {
    return (
      r.webhook_secret_previous !== null &&
      r.webhook_secret_previous_expires_at !== null &&
      r.webhook_secret_previous_expires_at.getTime() > this.deps.clock().getTime()
    );
  }

  #runView(r: RunRow, waiting: WaitingApprovalView | null = null): RunView {
    return {
      id: r.id,
      automationId: r.automation_id,
      project: r.project,
      triggerKind: r.trigger_kind,
      state: r.state,
      reason: r.reason,
      sourceTrust: r.source_trust,
      eventSummary: r.event_summary,
      jobId: r.job_id,
      jobState: r.job_state ?? null,
      workflowRunId: r.workflow_run_id,
      scheduledFor: iso(r.scheduled_for),
      chainParentRunId: r.chain_parent_run_id,
      chainDepth: r.chain_depth,
      triggeredBy: r.triggered_by,
      createdAt: r.created_at.toISOString(),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      waitingApproval: waiting,
      reusedJobId: r.reused_job_id ?? null,
    };
  }

  /**
   * p6-automation-defaults: running runs paused on a pending human approval (of their job, or of a job of their
   * workflow run): the oldest pending request per run. A run already cancelled for an approval timeout is not
   * "waiting" any more (its job is being stopped).
   */
  async #waiting(
    filter: { runIds: readonly string[] } | { automationIds: readonly string[] },
  ): Promise<Map<string, WaitingApprovalView & { runId: string; automationId: string }>> {
    const byRun = 'runIds' in filter;
    const ids = byRun ? filter.runIds : filter.automationIds;
    if (ids.length === 0) return new Map();
    const { rows } = await this.deps.pool.query<{
      run_id: string;
      automation_id: string;
      approval_id: string;
      action: string;
      since: Date;
      timeout: number | null;
    }>(
      `SELECT r.id AS run_id, r.automation_id, q.id AS approval_id, q.action, q.created_at AS since,
              a.approval_timeout_minutes AS timeout
         FROM automation_runs r
         JOIN automations a ON a.id = r.automation_id
         JOIN LATERAL (
           SELECT q.id, q.action, q.created_at FROM approval_requests q
            WHERE q.status = 'pending'
              AND (q.job_id = r.job_id
                   OR q.job_id IN (SELECT n.job_id FROM workflow_job_links n WHERE n.run_id = r.workflow_run_id))
            ORDER BY q.created_at, q.id LIMIT 1) q ON true
        WHERE r.state = 'running' AND (r.reason IS NULL OR r.reason NOT LIKE $2)
          AND ${byRun ? 'r.id' : 'r.automation_id'} = ANY($1::uuid[])
        ORDER BY q.created_at`,
      [[...ids], `${APPROVAL_TIMEOUT_REASON}%`],
    );
    const out = new Map<string, WaitingApprovalView & { runId: string; automationId: string }>();
    for (const w of rows) {
      const key = byRun ? w.run_id : w.automation_id;
      if (out.has(key)) continue; // oldest first
      out.set(key, {
        runId: w.run_id,
        automationId: w.automation_id,
        approvalId: w.approval_id,
        action: w.action,
        since: w.since.toISOString(),
        cancelsAt: w.timeout === null ? null : new Date(w.since.getTime() + w.timeout * 60_000).toISOString(),
      });
    }
    return out;
  }

  async #successRates(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.deps.pool.query<{ automation_id: string; ok: number; n: number }>(
      `SELECT automation_id, count(*) FILTER (WHERE state = 'succeeded')::int AS ok, count(*)::int AS n
         FROM (SELECT automation_id, state,
                      row_number() OVER (PARTITION BY automation_id ORDER BY created_at DESC, id DESC) AS rn
                 FROM automation_runs
                WHERE automation_id = ANY($1::uuid[]) AND state IN ('succeeded', 'failed', 'cancelled', 'error')) x
        WHERE rn <= 20 GROUP BY automation_id`,
      [[...ids]],
    );
    return new Map(rows.filter((r) => r.n > 0).map((r) => [r.automation_id, r.ok / r.n]));
  }

  async #row(db: Queryable, id: string, lock = false): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<Row>(
      lock ? 'SELECT * FROM automations WHERE id = $1 FOR UPDATE' : `${SELECT_AUTOMATION} WHERE a.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #require(db: Queryable, id: string, lock = false): Promise<Row> {
    const r = await this.#row(db, id, lock);
    if (r === null || r.state === 'deleted')
      throw this.#err(404, 'automation_not_found', 'Automation not found.');
    return r;
  }

  #requireExternal(actor: AutomationActor, project: string): void {
    const s = actor.subject;
    if (s === undefined || !authorize(s, 'automations.external', { project }).allow) {
      throw this.#err(
        403,
        'forbidden',
        'GitHub and webhook automations can be created, changed or resumed only by project admins (owner/admin).',
      );
    }
  }

  /** §18.4: a chain across projects needs `automations.crossproject` (admin) in both projects. */
  #requireCrossProject(actor: AutomationActor, project: string, sourceProject: string): void {
    const s = actor.subject;
    const ok =
      s !== undefined &&
      authorize(s, 'automations.crossproject', { project }).allow &&
      authorize(s, 'automations.crossproject', { project: sourceProject }).allow;
    if (!ok) {
      throw this.#err(
        403,
        'cross_project_chain_forbidden',
        'A chain to an automation of another project needs the admin role in both projects.',
      );
    }
  }

  async #auditUser(
    actor: AutomationActor,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
    tx?: Queryable,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.id },
        action,
        target: `automation:${id}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata,
      },
      tx,
    );
  }

  // ----------------------------------------------------------------------------------------- validation

  /** Validates trigger + target for `project`; returns the columns to store. */
  async #resolve(
    db: Queryable,
    project: string,
    trigger: AutomationTrigger,
    targetIn: AutomationTarget,
    selfId: string | null,
    actor: AutomationActor,
  ) {
    let target = targetIn;
    const now = this.deps.clock();
    let cron: string | null = null;
    let timeZone = 'UTC';
    let runAt: Date | null = null;
    let nextRunAt: Date | null = null;
    let githubRepoKey: string | null = null;
    let githubEvent: string | null = null;
    let githubEvents: string[] | null = null;
    let chainSourceId: string | null = null;
    let sourceWorkflow: { project: string; name: string } | null = null;
    let stored: Record<string, unknown> = { ...trigger };
    switch (trigger.kind) {
      case 'cron': {
        timeZone = this.#zone(trigger.timeZone);
        const c = this.#cron(trigger.cron, timeZone);
        cron = c.source;
        stored = { kind: 'cron', cron, ...(timeZone === 'UTC' ? {} : { timeZone }) };
        nextRunAt = nextRun(c, now);
        break;
      }
      case 'at': {
        timeZone = this.#zone(trigger.timeZone);
        runAt = atInstant(trigger.at, timeZone);
        if (Number.isNaN(runAt.getTime()) || runAt.getTime() <= now.getTime()) {
          throw this.#err(400, 'invalid_trigger', 'The run time must be in the future.');
        }
        if (runAt.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) {
          throw this.#err(400, 'invalid_trigger', 'The run time is more than a year ahead.');
        }
        stored = { kind: 'at', at: runAt.toISOString(), ...(timeZone === 'UTC' ? {} : { timeZone }) };
        nextRunAt = runAt;
        break;
      }
      case 'github': {
        const problem = validateActions(trigger);
        if (problem !== null) throw this.#err(400, 'invalid_trigger', `Invalid GitHub trigger: ${problem}.`);
        const { rows } = await db.query<{ repository_url: string }>(
          'SELECT repository_url FROM project_git_configs WHERE project = $1',
          [project],
        );
        const registered = rows[0] === undefined ? null : githubRepo(rows[0].repository_url);
        const key = trigger.repository.toLowerCase();
        if (registered !== null && `${registered.owner}/${registered.repo}`.toLowerCase() !== key) {
          throw this.#err(
            400,
            'invalid_trigger',
            `Project ${project} uses the repository ${registered.owner}/${registered.repo}; a GitHub trigger listens to that repository.`,
          );
        }
        if (trigger.checkout === 'event' && target.kind !== 'job') {
          throw this.#err(400, 'invalid_trigger', 'checkout "event" applies to job targets only.');
        }
        githubRepoKey = key;
        githubEvent = trigger.event;
        githubEvents = triggerEvents(trigger);
        break;
      }
      case 'webhook':
        stored = { kind: 'webhook' };
        break;
      case 'chain': {
        if (trigger.workflow !== undefined) {
          // p14-workflow-engine 14.2 (`trigger.workflow`): after a workflow's runs (by name).
          const wp = trigger.workflow.project ?? project;
          const readable =
            wp === project ||
            (actor.subject !== undefined &&
              authorize(actor.subject, 'workflows.read', { project: wp }).allow);
          // p18-multi-project: a project's workflow names are its own and the ones it attached.
          const { rows } = await db.query<{ id: string }>(
            `SELECT id::text AS id FROM workflow_definitions WHERE project = $1 AND name = $2
             UNION ALL
             SELECT id::text FROM workflow_attachments WHERE project = $1 AND name = $2 AND state <> 'detached'
             LIMIT 1`,
            [wp, trigger.workflow.name],
          );
          if (rows[0] === undefined || !readable)
            throw this.#err(400, 'invalid_trigger', 'The source workflow does not exist.');
          if (wp !== project) this.#requireCrossProject(actor, project, wp);
          if (target.kind === 'workflow') {
            const self = await db.query<{ name: string }>(
              'SELECT name FROM workflow_definitions WHERE id = $1',
              [target.workflowId],
            );
            // The target runs in this automation's project (own or attached workflow).
            if (self.rows[0]?.name === trigger.workflow.name && project === wp)
              throw this.#err(400, 'invalid_trigger', 'A workflow cannot start after its own runs.');
          }
          sourceWorkflow = { project: wp, name: trigger.workflow.name };
          stored = { kind: 'chain', workflow: sourceWorkflow, on: [...new Set(trigger.on)] };
          break;
        }
        const src = await this.#row(db, trigger.automationId ?? '');
        // An automation of a project the caller cannot read is reported like a missing one (no oracle).
        const readable =
          src !== null &&
          (src.project === project ||
            (actor.subject !== undefined &&
              authorize(actor.subject, 'automations.read', { project: src.project }).allow));
        if (src === null || src.state === 'deleted' || !readable) {
          throw this.#err(400, 'invalid_trigger', 'The chained automation does not exist.');
        }
        // p6-automations-next (§18.4): another project only for admins of both projects.
        if (src.project !== project) this.#requireCrossProject(actor, project, src.project);
        const problem = await chainProblem(selfId, src.id, async (id) => {
          const r = await db.query<{ chain_source_id: string | null }>(
            'SELECT chain_source_id FROM automations WHERE id = $1',
            [id],
          );
          return r.rows[0]?.chain_source_id ?? null;
        });
        if (problem !== null || src.id === selfId) {
          throw this.#err(400, 'invalid_trigger', problem ?? 'An automation cannot chain to itself.');
        }
        chainSourceId = src.id;
        stored = { kind: 'chain', automationId: src.id, on: [...new Set(trigger.on)] };
        break;
      }
    }

    let spec: Record<string, unknown> | null = null;
    let priority = 0;
    let workflowId: string | null = null;
    let workflowInputs: Record<string, string> | null = null;
    let workflowRepository: { url: string; baseRef: string } | null = null;
    let deployAction: { kind: string; params: Record<string, unknown> } | null = null;
    let deployOnSuccess: SavedDeployOnSuccess | null = null;
    if (target.kind === 'job' && target.deployOnSuccess != null) {
      // p6-deploy-on-success (ADR-0030): saving is the approval — the same checks (and step-up) as creating such a
      // job now; each run re-checks the run-as user. Pages adds the site bundle to the template.
      if (trigger.kind === 'github' && trigger.checkout === 'event' && trigger.allowUntrusted === true) {
        throw this.#err(
          400,
          'invalid_target',
          'An automation that checks out untrusted pull requests cannot deploy.',
        );
      }
      const dos = this.deps.deployOnSuccess?.() ?? null;
      if (dos === null) throw this.#err(503, 'unavailable', 'Deploy integrations are not available.');
      try {
        const out = await dos.prepare(
          {
            subject: await this.#subjectOf(actor),
            mfaAt: actor.mfaAt ?? null,
            ...(actor.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: actor.stepUpMaxAgeMs }),
            ...(actor.ip === undefined ? {} : { ip: actor.ip }),
            ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
          },
          project,
          target.deployOnSuccess,
          target.spec,
        );
        target = { ...target, spec: out.spec };
        deployOnSuccess = dos.toSaved(out.prepared);
      } catch (err) {
        if (err instanceof OpsError) throw this.#err(err.status, err.code, err.message);
        throw err;
      }
    }
    // p8-outputs-folders: the saving user must be able to add items to the folder now.
    let outputFolderId: string | null = null;
    if (target.kind === 'job' && target.outputFolderId != null) {
      const folders = this.deps.outputFolders?.() ?? null;
      if (folders === null) throw this.#err(404, 'folder_not_found', 'Folder not found.');
      await folders.checkJobTarget(
        {
          subject: await this.#subjectOf(actor),
          ...(actor.ip == null ? {} : { ip: actor.ip }),
          ...(actor.userAgent === undefined ? {} : { userAgent: actor.userAgent }),
        },
        project,
        target.outputFolderId,
      );
      outputFolderId = target.outputFolderId;
    }
    if (target.kind === 'job') {
      const specProject = target.spec.projectId;
      if (specProject !== undefined && specProject !== project) {
        throw this.#err(400, 'invalid_job', 'Invalid job: spec.projectId:does_not_match_project');
      }
      if (namesRemovedRuntime(target.spec) !== null) {
        throw this.#err(400, 'runtime_removed', RUNTIME_REMOVED_MESSAGE);
      }
      const kind = await projectKind(db, project);
      const { workspace: _w, modelProfile: _m, ...rest } = target.spec;
      // A workspace project's spec has no repository; the job store fills `workspace` from the project at submission.
      const probe = kind === 'workspace' ? { ...rest, workspace: { egress: 'none' } } : rest;
      const parsed = JobSpec.safeParse(probe);
      if (!parsed.success) {
        // Paths and codes only, never values (the prompt may be sensitive).
        const issues = parsed.error.issues.map((i) => `spec.${i.path.map(String).join('.')}:${i.code}`);
        throw this.#err(400, 'invalid_job', `Invalid job: ${issues.join(', ')}`.slice(0, 1000));
      }
      if (parsed.data.kind !== undefined) {
        throw this.#err(400, 'invalid_job', 'Invalid job: spec.kind:not_allowed');
      }
      // p6-automation-defaults: "Never ask" (ADR-0020) under the composer's opt-in rules, refused at write time
      // instead of failing every unattended run later.
      if (parsed.data.approvalPolicy === 'allow-all') {
        if (parsed.data.sourceTrust !== 'trusted') {
          throw this.#err(
            400,
            'invalid_job',
            'Invalid job: spec.sourceTrust:auto_approve_requires_trusted_source — “Never ask” is only for trusted sources.',
          );
        }
        const p = await db.query<{ auto_approve_execution: boolean }>(
          'SELECT auto_approve_execution FROM projects WHERE id = $1',
          [project],
        );
        if (p.rows[0]?.auto_approve_execution !== true) {
          throw this.#err(
            400,
            'auto_approve_not_allowed',
            `Project ${project} does not allow “Never ask” (auto-approve); an admin allows it in Projects > ${project} > Execution policy, or choose another approval policy.`,
          );
        }
      }
      const { workspace: _pw, ...clean } = parsed.data;
      spec = kind === 'workspace' ? clean : parsed.data;
      priority = target.priority ?? 0;
      // p6-automations-next (§18.2): a job that may check out a fork's head carries no secret references.
      if (
        trigger.kind === 'github' &&
        trigger.checkout === 'event' &&
        trigger.allowUntrusted === true &&
        Object.keys(parsed.data.secretRefs ?? {}).length > 0
      ) {
        throw this.#err(
          400,
          'invalid_job',
          'Invalid job: spec.secretRefs:not_allowed_with_untrusted_checkout — a job that checks out untrusted pull requests gets no secrets.',
        );
      }
      // p19-project-env "Job-level references": refused at write time with the job store's own rule (each run checks
      // again — a binding removed later fails that run with the same issue).
      const refIssues = await jobVaultRefIssues(db, project, parsed.data);
      if (refIssues.length > 0) {
        throw this.#err(
          400,
          'invalid_job',
          `Invalid job: ${refIssues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(0, 1000),
        );
      }
    } else if (target.kind === 'workflow') {
      // p18-multi-project: the project's own workflow, or one it attached (runs in this project through the attachment).
      const { rows } = await db.query<{ project: string; attached: boolean }>(
        `SELECT d.project,
                EXISTS (SELECT 1 FROM workflow_attachments a WHERE a.project = $2 AND a.owner_project = d.project
                           AND a.name = d.name AND a.state <> 'detached') AS attached
           FROM workflow_definitions d WHERE d.id = $1`,
        [target.workflowId, project],
      );
      if (rows[0] === undefined || (rows[0].project !== project && !rows[0].attached))
        throw this.#err(404, 'workflow_not_found', 'Workflow not found.');
      workflowId = target.workflowId;
      workflowInputs = target.inputs;
      workflowRepository = target.repository ?? null;
      // p9-queue-priority: a workflow run's class applies to every step job.
      priority = target.priority ?? 0;
    } else {
      // p6-deploy-pipeline (ADR-0028): the creator must be allowed to request deploys; the project must have the
      // target; the parameters are fixed here (never taken from events).
      if (actor.subject !== undefined && !authorize(actor.subject, 'deploy.request', { project }).allow) {
        throw this.#err(403, 'forbidden', 'You may not request deploys in this project.');
      }
      if (trigger.kind === 'github' && trigger.checkout === 'event') {
        throw this.#err(400, 'invalid_trigger', 'checkout "event" applies to job targets only.');
      }
      const deploy = this.deps.deploy?.() ?? null;
      if (deploy === null) throw this.#err(503, 'unavailable', 'Deploy integrations are not available.');
      const problem = await deploy.check(project, { kind: target.action, params: target.params });
      if (problem !== null) throw this.#err(400, 'invalid_target', problem);
      deployAction = { kind: target.action, params: target.params };
    }
    return {
      trigger: stored,
      cron,
      timeZone,
      runAt,
      nextRunAt,
      githubRepo: githubRepoKey,
      githubEvent,
      githubEvents,
      chainSourceId,
      sourceWorkflow,
      spec,
      priority,
      workflowId,
      workflowInputs,
      workflowRepository,
      deployAction,
      deployOnSuccess,
      outputFolderId,
      verifyOnSuccess: target.kind === 'job' ? (target.verifyOnSuccess ?? null) : null,
    };
  }

  // ------------------------------------------------------------------------------- project defaults (§2a)

  /**
   * Fills what a job template leaves out with the project's defaults, like the job composer (source trust, the
   * best ready host profile when the project opted in, approval policy, limits; the model stays the project's
   * default resolved at submission). Workflow targets are returned as they are.
   */
  async withDefaults(
    project: string,
    target: AutomationTarget,
  ): Promise<{ target: AutomationTarget; filled: AppliedDefaults['filled'] }> {
    if (target.kind !== 'job') return { target, filled: [] };
    const applied = await this.#defaults.apply(project, target.spec);
    return { target: { ...target, spec: applied.spec }, filled: applied.filled };
  }

  /** Where a job template could run now (no side effects); null for workflows or without preview facts. */
  async placement(project: string, target: AutomationTarget): Promise<PlacementAdvice | null> {
    if (target.kind !== 'job') return null;
    return this.#defaults.placement(project, target.spec);
  }

  /** Validates a create / update without writing anything (chat drafts). Throws AutomationError. */
  async validate(
    actor: AutomationActor,
    project: string,
    trigger: AutomationTrigger,
    target: AutomationTarget,
    selfId: string | null,
  ): Promise<void> {
    if (EXTERNAL_KINDS.has(trigger.kind)) this.#requireExternal(actor, project);
    const { target: filled } = await this.withDefaults(project, target);
    await this.#resolve(this.deps.pool, project, trigger, filled, selfId, actor);
    await this.#workspaceInputs(actor, project, trigger, filled, continueFromOf(filled) ?? null);
  }

  // ------------------------------------------------------------------- workspace inputs (p5-research-workspace-next)

  /**
   * Validates the input files and continue-from rule of a target (workspace projects only): uploads are validated and
   * secret-scanned now; a fixed job to continue from must be readable by the actor. `continueFrom` is the effective
   * rule (the patch's, else the stored one). Throws AutomationError / HttpError.
   */
  async #workspaceInputs(
    actor: AutomationActor,
    project: string,
    trigger: AutomationTrigger,
    target: AutomationTarget,
    continueFrom: ContinueFrom | null,
  ): Promise<{ uploads: PreparedInput[]; keep: string[] } | null> {
    // p6-deploy-pipeline: a deploy target has no files.
    const files = target.kind === 'deploy' ? undefined : target.files;
    const wants = (files !== undefined && files.length > 0) || continueFrom !== null;
    if (!wants) return files === undefined ? null : { uploads: [], keep: [] };
    const ws = this.deps.workspaces;
    if (ws === undefined || (await projectKind(this.deps.pool, project)) !== 'workspace') {
      throw this.#err(
        400,
        'invalid_target',
        'Input files and continue-from are for workspace projects (repository projects work on their repository).',
      );
    }
    if (continueFrom?.kind === 'chain-source' && trigger.kind !== 'chain') {
      throw this.#err(400, 'invalid_target', 'continueFrom "chain-source" needs a chain trigger.');
    }
    if (continueFrom?.kind === 'last-run' && target.kind !== 'job') {
      throw this.#err(400, 'invalid_target', 'continueFrom "last-run" applies to job targets only.');
    }
    if (continueFrom?.kind === 'job') {
      await requireReadableJob(this.deps.pool, await this.#subjectOf(actor), continueFrom.jobId);
    }
    if (files === undefined) return null;
    const uploads = ws.prepareUploads(
      files.flatMap((f) => ('contentBase64' in f ? [{ name: f.name, contentBase64: f.contentBase64 }] : [])),
    );
    const keep = files.flatMap((f) => ('inputId' in f ? [f.inputId] : []));
    return { uploads, keep };
  }

  async #subjectOf(actor: AutomationActor): Promise<Subject> {
    if (actor.subject !== undefined) return actor.subject;
    const { rows } = await this.deps.pool.query<{ id: string; role: Role }>(
      'SELECT id, role FROM users WHERE id = $1',
      [actor.id],
    );
    const u = rows[0];
    if (u === undefined) throw this.#err(403, 'forbidden', 'Not allowed.');
    return loadSubject(this.deps.pool, { id: u.id, role: u.role });
  }

  // ---------------------------------------------------------------------------------------------- writes

  async create(
    actor: AutomationActor,
    raw: AutomationInput,
    /** p14-workflow-engine 14.2: the workflow trigger node this automation is created for (trigger service only). */
    opts: {
      readonly bindingNode?: string;
      /** p18-multi-project W4: the automation group this row is created in (AutomationGroupService only). */
      readonly groupId?: string;
    } = {},
  ): Promise<{ automation: AutomationView; webhookSecret: string | null }> {
    if (EXTERNAL_KINDS.has(raw.trigger.kind)) this.#requireExternal(actor, raw.project);
    const defaults = await this.withDefaults(raw.project, raw.target);
    const input: AutomationInput = { ...raw, target: defaults.target };
    const continueFrom = continueFromOf(input.target) ?? null;
    const files = await this.#workspaceInputs(
      actor,
      input.project,
      input.trigger,
      input.target,
      continueFrom,
    );
    const id = randomUUID();
    const secret = input.trigger.kind === 'webhook' ? newWebhookSecret() : null;
    const row = await withTransaction(this.deps.pool, async (tx) => {
      const p = await tx.query('SELECT 1 FROM projects WHERE id = $1 FOR SHARE', [input.project]);
      if ((p.rowCount ?? 0) === 0) throw this.#err(404, 'project_not_found', 'Project not found.');
      const count = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM automations WHERE project = $1 AND state IN ('active', 'paused')",
        [input.project],
      );
      if ((count.rows[0]?.n ?? 0) >= AUTOMATION_LIMITS.maxActivePerProject) {
        throw this.#err(
          409,
          'too_many_automations',
          `The project already has ${String(AUTOMATION_LIMITS.maxActivePerProject)} automations.`,
        );
      }
      const v = await this.#resolve(tx, input.project, input.trigger, input.target, id, actor);
      const allowIps = this.#allowIps(input.trigger.kind, input.webhookAllowIps);
      const enabled = input.enabled !== false;
      const now = this.deps.clock();
      const { rows } = await tx.query<Row>(
        `INSERT INTO automations (id, project, name, description, state, trigger_kind, trigger, cron, run_at, next_run_at,
                                  github_repo, github_event, chain_source_id, webhook_secret, webhook_secret_hint,
                                  webhook_secret_rotated_at, target_kind, job_spec, priority, workflow_id,
                                  workflow_inputs, workflow_repository, concurrency, catch_up, max_runs_per_hour,
                                  notify_on_failure, run_as, created_by, created_at, updated_by, updated_at,
                                  approval_timeout_minutes, github_events, webhook_allow_ips, deploy_action,
                                  source_workflow_project, source_workflow_name, workflow_trigger_node)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
                 $23, $24, $25, $26, $27, $27, $28, $27, $28, $29, $30, $31, $32, $33, $34, $35)
         RETURNING *`,
        [
          id,
          input.project,
          input.name,
          input.description ?? null,
          enabled ? 'active' : 'paused',
          input.trigger.kind,
          JSON.stringify(v.trigger),
          v.cron,
          v.runAt,
          enabled ? v.nextRunAt : null,
          v.githubRepo,
          v.githubEvent,
          v.chainSourceId,
          secret === null ? null : this.#seal(id, secret),
          secret === null ? null : secretHint(secret),
          secret === null ? null : now,
          input.target.kind,
          v.spec === null ? null : JSON.stringify(v.spec),
          v.priority,
          v.workflowId,
          v.workflowInputs === null ? null : JSON.stringify(v.workflowInputs),
          v.workflowRepository === null ? null : JSON.stringify(v.workflowRepository),
          input.concurrency ?? 'skip',
          input.catchUp ?? 'once',
          input.maxRunsPerHour ?? 30,
          input.notifyOnFailure ?? true,
          actor.id,
          now,
          input.approvalTimeoutMinutes === undefined
            ? DEFAULT_APPROVAL_TIMEOUT_MINUTES
            : input.approvalTimeoutMinutes,
          v.githubEvents,
          allowIps,
          v.deployAction === null ? null : JSON.stringify(v.deployAction),
          v.sourceWorkflow?.project ?? null,
          v.sourceWorkflow?.name ?? null,
          opts.bindingNode ?? null,
        ],
      );
      const created = rows[0];
      if (created === undefined) throw new Error('automation insert returned no row');
      // p16-workflow-quality: the schedule's zone (UTC unless the trigger names one).
      if (v.timeZone !== 'UTC') {
        await tx.query('UPDATE automations SET time_zone = $2 WHERE id = $1', [id, v.timeZone]);
        created.time_zone = v.timeZone;
      }
      if (files !== null) {
        await this.deps.workspaces?.replaceAutomationFiles(tx, id, files.keep, files.uploads, now);
      }
      if (opts.groupId !== undefined) {
        await tx.query('UPDATE automations SET group_id = $2 WHERE id = $1', [id, opts.groupId]);
      }
      if (continueFrom !== null) {
        await tx.query('UPDATE automations SET continue_from = $2 WHERE id = $1', [
          id,
          JSON.stringify(continueFrom),
        ]);
      }
      if (v.deployOnSuccess !== null) {
        await tx.query('UPDATE automations SET deploy_on_success = $2 WHERE id = $1', [
          id,
          JSON.stringify(v.deployOnSuccess),
        ]);
      }
      if (v.verifyOnSuccess !== null) {
        await tx.query('UPDATE automations SET verify_on_success = $2 WHERE id = $1', [
          id,
          v.verifyOnSuccess,
        ]);
      }
      if (v.outputFolderId !== null) {
        await tx.query('UPDATE automations SET output_folder_id = $2 WHERE id = $1', [id, v.outputFolderId]);
      }
      const reuseHours = this.#reusePolicy(input.target.kind, input.reuseWithinHours ?? null);
      if (reuseHours !== null) {
        await tx.query('UPDATE automations SET reuse_within_hours = $2 WHERE id = $1', [id, reuseHours]);
      }
      await this.#auditUser(
        actor,
        'automation.create',
        id,
        {
          project: input.project,
          trigger: input.trigger.kind,
          ...(v.cron === null ? {} : { cron: v.cron }),
          ...(v.githubRepo === null
            ? {}
            : {
                repository: v.githubRepo,
                event: v.githubEvent,
                ...((v.githubEvents?.length ?? 0) > 1 ? { events: v.githubEvents } : {}),
              }),
          ...(allowIps === null ? {} : { allowIps }),
          ...(v.chainSourceId === null ? {} : { chainSource: v.chainSourceId }),
          target: input.target.kind,
          ...(v.spec === null
            ? { workflowId: v.workflowId }
            : {
                runtime: v.spec.runtime,
                sandboxProfile: v.spec.sandboxProfile,
                approvalPolicy: v.spec.approvalPolicy,
                ...(defaults.filled.length === 0 ? {} : { projectDefaults: defaults.filled }),
              }),
          approvalTimeoutMinutes:
            input.approvalTimeoutMinutes === undefined
              ? DEFAULT_APPROVAL_TIMEOUT_MINUTES
              : input.approvalTimeoutMinutes,
          enabled,
          ...(secret === null ? {} : { secretHint: secretHint(secret) }),
          ...(files === null || files.uploads.length === 0
            ? {}
            : {
                files: files.uploads.length,
                fileBytes: files.uploads.reduce((n, f) => n + f.ref.sizeBytes, 0),
              }),
          ...(continueFrom === null ? {} : { continueFrom: continueFrom.kind }),
          ...(reuseHours === null ? {} : { reuseWithinHours: reuseHours }),
          ...(opts.groupId === undefined ? {} : { group: opts.groupId }),
        },
        tx,
      );
      return created;
    });
    return { automation: await this.get(row.id), webhookSecret: secret };
  }

  async update(
    actor: AutomationActor,
    id: string,
    raw: AutomationPatch,
    /** p14-workflow-engine 14.2: the trigger service reconciles a bound automation (others get 409). */
    opts: {
      readonly binding?: boolean;
      /**
       * p18-multi-project W4: a change applied to every sibling of the group ("Tümüne uygula"); without it a grouped
       * automation changed on its own is marked diverged.
       */
      readonly group?: boolean;
    } = {},
  ): Promise<{ automation: AutomationView; webhookSecret: string | null }> {
    let secret: string | null = null;
    let patch = raw;
    if (raw.target !== undefined) {
      const project = await this.projectOf(id);
      if (project === null) throw this.#err(404, 'automation_not_found', 'Automation not found.');
      patch = { ...raw, target: (await this.withDefaults(project, raw.target)).target };
    }
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#require(tx, id, true);
      if (r.workflow_trigger_node !== null && opts.binding !== true) throw this.#bound();
      const trigger = patch.trigger ?? triggerOf(r);
      const target: AutomationTarget =
        patch.target ??
        (r.target_kind === 'job'
          ? { kind: 'job', spec: r.job_spec ?? {}, priority: r.priority }
          : r.target_kind === 'deploy'
            ? {
                kind: 'deploy',
                action: r.deploy_action?.kind === 'coolify.restart' ? 'coolify.restart' : 'coolify.deploy',
                params: r.deploy_action?.params ?? {},
              }
            : {
                kind: 'workflow',
                workflowId: r.workflow_id ?? '',
                inputs: r.workflow_inputs ?? {},
                ...(r.workflow_repository === null ? {} : { repository: r.workflow_repository }),
                priority: r.priority,
              });
      const reTargets = patch.trigger !== undefined || patch.target !== undefined;
      if (EXTERNAL_KINDS.has(trigger.kind) && reTargets) this.#requireExternal(actor, r.project);
      const v = await this.#resolve(tx, r.project, trigger, target, id, actor);
      // p5-research-workspace-next: files and continue-from (omitted in the patch: unchanged).
      const cfPatch = patch.target === undefined ? undefined : continueFromOf(patch.target);
      const continueFrom = cfPatch === undefined ? r.continue_from : cfPatch;
      const files = await this.#workspaceInputs(actor, r.project, trigger, target, continueFrom);
      const now = this.deps.clock();
      if (files !== null) {
        await this.deps.workspaces?.replaceAutomationFiles(tx, id, files.keep, files.uploads, now);
      }
      if (cfPatch !== undefined) {
        await tx.query('UPDATE automations SET continue_from = $2 WHERE id = $1', [
          id,
          cfPatch === null ? null : JSON.stringify(cfPatch),
        ]);
      }
      // p6-deploy-on-success: a new target replaces (or drops) the stored deploy-on-success approval.
      if (patch.target !== undefined) {
        await tx.query('UPDATE automations SET deploy_on_success = $2 WHERE id = $1', [
          id,
          v.deployOnSuccess === null ? null : JSON.stringify(v.deployOnSuccess),
        ]);
        await tx.query('UPDATE automations SET output_folder_id = $2 WHERE id = $1', [id, v.outputFolderId]);
        await tx.query('UPDATE automations SET verify_on_success = $2 WHERE id = $1', [
          id,
          v.verifyOnSuccess,
        ]);
      }
      // §18.5: the allow-list belongs to webhook triggers; kept unless patched, dropped when the kind changes.
      const allowIps =
        patch.webhookAllowIps !== undefined
          ? this.#allowIps(trigger.kind, patch.webhookAllowIps)
          : trigger.kind === 'webhook'
            ? r.webhook_allow_ips
            : null;
      if (patch.webhookAllowIps !== undefined && trigger.kind === 'webhook') {
        this.#requireExternal(actor, r.project);
      }
      if (trigger.kind === 'webhook' && r.trigger_kind !== 'webhook') secret = newWebhookSecret();
      const keepSecret = trigger.kind === 'webhook' && secret === null;
      await tx.query(
        `UPDATE automations SET name = $2, description = $3, trigger_kind = $4, trigger = $5, cron = $6, run_at = $7,
                next_run_at = $8, github_repo = $9, github_event = $10, chain_source_id = $11,
                webhook_secret = CASE WHEN $12 THEN webhook_secret ELSE $13 END,
                webhook_secret_hint = CASE WHEN $12 THEN webhook_secret_hint ELSE $14 END,
                webhook_secret_rotated_at = CASE WHEN $12 THEN webhook_secret_rotated_at ELSE $15 END,
                webhook_secret_previous = CASE WHEN $12 THEN webhook_secret_previous END,
                webhook_secret_previous_hint = CASE WHEN $12 THEN webhook_secret_previous_hint END,
                webhook_secret_previous_expires_at = CASE WHEN $12 THEN webhook_secret_previous_expires_at END,
                github_events = $32, webhook_allow_ips = $33, deploy_action = $34,
                source_workflow_project = $35, source_workflow_name = $36,
                target_kind = $16, job_spec = $17, priority = $18, workflow_id = $19, workflow_inputs = $20,
                workflow_repository = $21, concurrency = $22, catch_up = $23, max_runs_per_hour = $24,
                notify_on_failure = $25, run_as = CASE WHEN $26 THEN $27 ELSE run_as END,
                state = CASE WHEN state = 'done' AND $28 THEN 'active' ELSE state END,
                updated_by = $27, updated_at = $29,
                approval_timeout_minutes = CASE WHEN $30 THEN $31::integer ELSE approval_timeout_minutes END
          WHERE id = $1`,
        [
          id,
          patch.name ?? r.name,
          patch.description === undefined ? r.description : patch.description,
          trigger.kind,
          JSON.stringify(v.trigger),
          v.cron,
          v.runAt,
          r.state === 'active' || (r.state === 'done' && v.nextRunAt !== null) ? v.nextRunAt : null,
          v.githubRepo,
          v.githubEvent,
          v.chainSourceId,
          keepSecret,
          secret === null ? null : this.#seal(id, secret),
          secret === null ? null : secretHint(secret),
          secret === null ? null : now,
          target.kind,
          v.spec === null ? null : JSON.stringify(v.spec),
          v.priority,
          v.workflowId,
          v.workflowInputs === null ? null : JSON.stringify(v.workflowInputs),
          v.workflowRepository === null ? null : JSON.stringify(v.workflowRepository),
          patch.concurrency ?? r.concurrency,
          patch.catchUp ?? r.catch_up,
          patch.maxRunsPerHour ?? r.max_runs_per_hour,
          patch.notifyOnFailure ?? r.notify_on_failure,
          reTargets,
          actor.id,
          v.nextRunAt !== null && patch.trigger !== undefined,
          now,
          patch.approvalTimeoutMinutes !== undefined,
          patch.approvalTimeoutMinutes ?? null,
          v.githubEvents,
          allowIps,
          v.deployAction === null ? null : JSON.stringify(v.deployAction),
          v.sourceWorkflow?.project ?? null,
          v.sourceWorkflow?.name ?? null,
        ],
      );
      if (v.timeZone !== r.time_zone) {
        await tx.query('UPDATE automations SET time_zone = $2 WHERE id = $1', [id, v.timeZone]);
      }
      // p6-result-reuse: kept unless patched; a target that is no longer a job drops it.
      const reuseHours =
        patch.reuseWithinHours !== undefined
          ? this.#reusePolicy(target.kind, patch.reuseWithinHours)
          : target.kind === 'job'
            ? r.reuse_within_hours
            : null;
      if (reuseHours !== r.reuse_within_hours) {
        await tx.query('UPDATE automations SET reuse_within_hours = $2 WHERE id = $1', [id, reuseHours]);
      }
      // p18-multi-project W4: a sibling changed on its own no longer matches its group; "Tümüne uygula" re-aligns it.
      if (r.group_id != null) {
        await tx.query('UPDATE automations SET diverged = $2 WHERE id = $1', [id, opts.group !== true]);
      }
      await this.#auditUser(
        actor,
        'automation.update',
        id,
        {
          project: r.project,
          fields: Object.keys(patch).sort(),
          trigger: trigger.kind,
          ...(secret === null ? {} : { secretHint: secretHint(secret) }),
          ...(r.group_id == null ? {} : { group: r.group_id, viaGroup: opts.group === true }),
        },
        tx,
      );
    });
    return { automation: await this.get(id), webhookSecret: secret };
  }

  async pause(actor: AutomationActor, id: string): Promise<AutomationView> {
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#require(tx, id, true);
      if (r.state !== 'active') {
        throw this.#err(409, 'automation_not_active', `The automation is ${r.state}.`);
      }
      await tx.query(
        "UPDATE automations SET state = 'paused', next_run_at = NULL, updated_by = $2, updated_at = $3 WHERE id = $1",
        [id, actor.id, this.deps.clock()],
      );
      await this.#auditUser(actor, 'automation.pause', id, { project: r.project }, tx);
    });
    return this.get(id);
  }

  async resume(actor: AutomationActor, id: string): Promise<AutomationView> {
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#require(tx, id, true);
      if (r.state !== 'paused' && r.state !== 'failed') {
        throw this.#err(409, 'automation_not_paused', `The automation is ${r.state}.`);
      }
      if (EXTERNAL_KINDS.has(r.trigger_kind)) {
        this.#requireExternal(actor, r.project);
        if (actor.stepUpFresh !== true) {
          throw this.#err(403, 'step_up_required', 'Confirm with a current authenticator code.');
        }
      }
      const now = this.deps.clock();
      let next: Date | null = null;
      if (r.cron !== null) next = nextRun(this.#cron(r.cron, r.time_zone), now);
      if (r.run_at !== null) {
        if (r.run_at.getTime() <= now.getTime()) {
          throw this.#err(
            409,
            'automation_expired',
            'The one-time run is in the past; change its time first.',
          );
        }
        next = r.run_at;
      }
      // Resuming hands the automation to the resuming user when it stopped because its run-as user lost access.
      await tx.query(
        `UPDATE automations SET state = 'active', next_run_at = $2, updated_by = $3, updated_at = $4,
                run_as = CASE WHEN state = 'failed' THEN $3 ELSE run_as END WHERE id = $1`,
        [id, next, actor.id, now],
      );
      await this.#auditUser(actor, 'automation.resume', id, { project: r.project, from: r.state }, tx);
    });
    return this.get(id);
  }

  async remove(
    actor: AutomationActor,
    id: string,
    opts: { readonly binding?: boolean } = {},
  ): Promise<AutomationView> {
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#require(tx, id, true);
      if (r.workflow_trigger_node !== null && opts.binding !== true) throw this.#bound();
      const now = this.deps.clock();
      await tx.query(
        `UPDATE automations SET state = 'deleted', next_run_at = NULL, webhook_secret = CASE WHEN trigger_kind = 'webhook'
                THEN webhook_secret END, deleted_by = $2, deleted_at = $3, updated_by = $2, updated_at = $3 WHERE id = $1`,
        [id, actor.id, now],
      );
      // Queued runs never start (running jobs are not affected).
      await tx.query(
        `UPDATE automation_runs SET state = 'skipped', reason = 'The automation was deleted.', finished_at = $2
          WHERE automation_id = $1 AND state = 'queued'`,
        [id, now],
      );
      // p17-object-storage-rest: the stored input files go with it (a deleted automation never runs again and runs
      // already started hold their own copies); their blobs are then unreferenced and the blob GC deletes them.
      const files = await tx.query('DELETE FROM automation_files WHERE automation_id = $1', [id]);
      await this.#auditUser(
        actor,
        'automation.delete',
        id,
        {
          project: r.project,
          runs: r.run_count,
          ...((files.rowCount ?? 0) > 0 ? { files: files.rowCount } : {}),
        },
        tx,
      );
    });
    const r = await this.#row(this.deps.pool, id);
    if (r === null) throw this.#err(404, 'automation_not_found', 'Automation not found.');
    return this.#view(r, null);
  }

  /**
   * Replaces the webhook secret (§18.1). The current secret stays valid as the previous one for `graceHours`
   * (default 24, at most 7 days; 0 = cut over at once). Rotating during an open window replaces the previous secret.
   */
  async rotateSecret(
    actor: AutomationActor,
    id: string,
    opts: { readonly graceHours?: number | undefined } = {},
  ): Promise<{ automation: AutomationView; webhookSecret: string }> {
    const grace = opts.graceHours ?? DEFAULT_WEBHOOK_GRACE_HOURS;
    if (!Number.isInteger(grace) || grace < 0 || grace > MAX_WEBHOOK_GRACE_HOURS) {
      throw this.#err(
        400,
        'invalid_grace',
        `The grace period is 0 to ${String(MAX_WEBHOOK_GRACE_HOURS)} hours.`,
      );
    }
    const secret = newWebhookSecret();
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#require(tx, id, true);
      if (r.trigger_kind !== 'webhook') {
        throw this.#err(409, 'not_a_webhook', 'Only webhook automations have a secret.');
      }
      this.#requireExternal(actor, r.project);
      const now = this.deps.clock();
      const current = grace === 0 ? null : this.#unseal(r);
      if (grace > 0 && current === null) {
        // The current secret cannot be read (master key changed): nothing to keep valid.
        this.deps.log.warn({ automationId: id }, 'webhook rotation: current secret unreadable, no overlap');
      }
      const expiresAt = current === null ? null : new Date(now.getTime() + grace * ONE_HOUR);
      await tx.query(
        `UPDATE automations SET webhook_secret = $2, webhook_secret_hint = $3, webhook_secret_rotated_at = $4,
                webhook_secret_previous = $6, webhook_secret_previous_hint = $7,
                webhook_secret_previous_expires_at = $8, updated_by = $5, updated_at = $4 WHERE id = $1`,
        [
          id,
          this.#seal(id, secret),
          secretHint(secret),
          now,
          actor.id,
          current === null ? null : this.#seal(id, current, 'previous'),
          current === null ? null : r.webhook_secret_hint,
          expiresAt,
        ],
      );
      await this.#auditUser(
        actor,
        'automation.secret.rotate',
        id,
        {
          project: r.project,
          previousHint: r.webhook_secret_hint,
          secretHint: secretHint(secret),
          graceHours: current === null ? 0 : grace,
          previousExpiresAt: expiresAt === null ? null : expiresAt.toISOString(),
          ...(this.#previousLive(r) ? { droppedPreviousHint: r.webhook_secret_previous_hint } : {}),
        },
        tx,
      );
    });
    return { automation: await this.get(id), webhookSecret: secret };
  }

  /** Ends the overlap window of a rotation now (§18.1): only the current secret is accepted from now on. */
  async endOverlap(actor: AutomationActor, id: string): Promise<AutomationView> {
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#require(tx, id, true);
      if (r.trigger_kind !== 'webhook') {
        throw this.#err(409, 'not_a_webhook', 'Only webhook automations have a secret.');
      }
      this.#requireExternal(actor, r.project);
      if (!this.#previousLive(r)) {
        throw this.#err(409, 'no_previous_secret', 'No previous secret is accepted any more.');
      }
      const now = this.deps.clock();
      await tx.query(
        `UPDATE automations SET webhook_secret_previous = NULL, webhook_secret_previous_hint = NULL,
                webhook_secret_previous_expires_at = NULL, updated_by = $2, updated_at = $3 WHERE id = $1`,
        [id, actor.id, now],
      );
      await this.#auditUser(
        actor,
        'automation.secret.end_overlap',
        id,
        { project: r.project, previousHint: r.webhook_secret_previous_hint },
        tx,
      );
    });
    return this.get(id);
  }

  /** Clears previous webhook secrets whose window ended (tick; the verification ignores them anyway). */
  async expirePreviousSecrets(): Promise<number> {
    const res = await this.deps.pool.query(
      `UPDATE automations SET webhook_secret_previous = NULL, webhook_secret_previous_hint = NULL,
              webhook_secret_previous_expires_at = NULL
        WHERE webhook_secret_previous_expires_at IS NOT NULL AND webhook_secret_previous_expires_at <= $1`,
      [this.deps.clock()],
    );
    return res.rowCount ?? 0;
  }

  /** "Run now": a manual run under the same policies (concurrency, rate limit, run-as re-check). */
  async runNow(actor: AutomationActor, id: string): Promise<RunDetail> {
    const r = await this.#require(this.deps.pool, id);
    if (r.state !== 'active' && r.state !== 'paused') {
      throw this.#err(409, 'automation_not_active', `The automation is ${r.state}.`);
    }
    if (EXTERNAL_KINDS.has(r.trigger_kind)) this.#requireExternal(actor, r.project);
    const run = await this.enqueue(this.deps.pool, r, {
      triggerKind: 'manual',
      dedupKey: `manual:${randomUUID()}`,
      triggeredBy: actor.id,
      data: { event: 'manual', requestedBy: actor.id },
      summary: { event: 'manual' },
    });
    if (run === null) throw new Error('manual run insert conflicted');
    await this.#auditUser(actor, 'automation.run.manual', id, { project: r.project, runId: run.id });
    await this.#startFor(id, { includePaused: true });
    return this.run(id, run.id);
  }

  /** §18.5: validates a webhook IP allow-list for a trigger kind (null = any address). */
  #allowIps(kind: TriggerKind, entries: readonly string[] | null | undefined): string[] | null {
    if (entries === undefined || entries === null) return null;
    if (kind !== 'webhook') {
      throw this.#err(400, 'invalid_trigger', 'An IP allow-list applies to webhook triggers only.');
    }
    const parsed = parseAllowIps(entries);
    if (!parsed.ok) {
      throw this.#err(
        400,
        'invalid_trigger',
        `Invalid IP allow-list entry "${parsed.entry.slice(0, 64)}": use an IPv4/IPv6 address or CIDR.`,
      );
    }
    return parsed.entries;
  }

  /** Seals a webhook secret; the previous one has its own AAD so ciphertexts cannot be swapped between columns. */
  #seal(id: string, secret: string, slot: 'current' | 'previous' = 'current'): Buffer {
    const aad = slot === 'current' ? `automation-webhook:${id}` : `automation-webhook-previous:${id}`;
    return this.#box.encrypt(Buffer.from(secret, 'utf8'), aad);
  }

  #unseal(r: Row, slot: 'current' | 'previous' = 'current'): string | null {
    const sealed = slot === 'current' ? r.webhook_secret : r.webhook_secret_previous;
    if (sealed === null) return null;
    const aad = slot === 'current' ? `automation-webhook:${r.id}` : `automation-webhook-previous:${r.id}`;
    try {
      return this.#box.decrypt(sealed, aad).toString('utf8');
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------------------------------------- reads

  async list(
    projects: readonly string[] | null,
    filter: {
      project?: string | undefined;
      state?: string | undefined;
      kind?: string | undefined;
      /** p18-multi-project W4: the siblings of one automation group. */
      group?: string | undefined;
    } = {},
  ): Promise<AutomationView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `${SELECT_AUTOMATION}
        WHERE ($1::text[] IS NULL OR a.project = ANY($1)) AND ($2::text IS NULL OR a.project = $2)
          AND (($3::text IS NULL AND a.state <> 'deleted') OR a.state = $3)
          AND ($4::text IS NULL OR a.trigger_kind = $4)
          AND ($5::uuid IS NULL OR a.group_id = $5)
        ORDER BY (a.state = 'active') DESC, a.created_at DESC LIMIT 500`,
      [
        projects === null ? null : [...projects],
        filter.project ?? null,
        filter.state ?? null,
        filter.kind ?? null,
        filter.group ?? null,
      ],
    );
    const rates = await this.#successRates(rows.map((r) => r.id));
    const waiting = await this.#waiting({ automationIds: rows.map((r) => r.id) });
    return rows.map((r) => this.#view(r, rates.get(r.id) ?? null, waiting.get(r.id) ?? null));
  }

  async get(id: string, canRead: (project: string) => boolean = () => true): Promise<AutomationDetail> {
    const r = await this.#row(this.deps.pool, id);
    if (r === null) throw this.#err(404, 'automation_not_found', 'Automation not found.');
    const rates = await this.#successRates([id]);
    const stats = await this.deps.pool.query<{
      finished: number;
      succeeded: number;
      failed: number;
      skipped: number;
    }>(
      `SELECT count(*) FILTER (WHERE state IN ('succeeded', 'failed', 'cancelled', 'error'))::int AS finished,
              count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE state IN ('failed', 'error'))::int AS failed,
              count(*) FILTER (WHERE state = 'skipped')::int AS skipped
         FROM automation_runs WHERE automation_id = $1`,
      [id],
    );
    const lastFailure = await this.deps.pool.query<RunRow>(
      `${SELECT_RUN} WHERE r.automation_id = $1 AND r.state IN ('failed', 'error')
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
      [id],
    );
    const chainedBy = await this.deps.pool.query<{
      id: string;
      name: string;
      project: string;
      trigger: { on?: string[] };
    }>(
      "SELECT id, name, project, trigger FROM automations WHERE chain_source_id = $1 AND state <> 'deleted' ORDER BY name",
      [id],
    );
    const srcRow =
      r.chain_source_id === null
        ? null
        : ((
            await this.deps.pool.query<{ id: string; name: string; state: string; project: string }>(
              'SELECT id, name, state, project FROM automations WHERE id = $1',
              [r.chain_source_id],
            )
          ).rows[0] ?? null);
    // §18.4: another project's automation is named only to readers of that project.
    const src: AutomationDetail['chainSource'] =
      srcRow === null
        ? null
        : srcRow.project === r.project || canRead(srcRow.project)
          ? { ...srcRow, hidden: false }
          : { id: null, name: null, state: null, project: null, hidden: true };
    const lf = lastFailure.rows[0];
    // A workflow run's own reason is generic ("ended failed"): name the step that failed and its error.
    const failedRow =
      lf === undefined || lf.workflow_run_id === null ? null : await this.#failedStepRow(lf.workflow_run_id);
    const failedStep = failedRow;
    const s = stats.rows[0] ?? { finished: 0, succeeded: 0, failed: 0, skipped: 0 };
    const waiting = await this.#waiting({ automationIds: [id] });
    return {
      ...this.#view(r, rates.get(id) ?? null, waiting.get(id) ?? null),
      targetSpec: {
        spec: r.job_spec,
        priority: r.priority,
        workflowInputs: r.workflow_inputs,
        workflowRepository: r.workflow_repository,
        files: (this.deps.workspaces === undefined ? [] : await this.deps.workspaces.automationFiles(id)).map(
          (f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, sizeBytes: f.sizeBytes }),
        ),
        continueFrom: r.continue_from,
        deployOnSuccess:
          r.deploy_on_success === null
            ? null
            : {
                target: r.deploy_on_success.target,
                env: r.deploy_on_success.env,
                directory: r.deploy_on_success.directory,
                approvedAt: r.deploy_on_success.approvedAt,
                publish: r.deploy_on_success.publish ?? null,
              },
        outputFolderId: r.output_folder_id ?? null,
        verifyOnSuccess: r.verify_on_success ?? null,
      },
      stats: {
        ...s,
        lastFailure:
          lf === undefined
            ? null
            : {
                runId: lf.id,
                state: lf.state,
                reason: lf.reason,
                jobId: lf.job_id,
                workflowRunId: lf.workflow_run_id,
                failedStep:
                  failedStep === null
                    ? null
                    : {
                        nodeId: failedStep.node_id,
                        label: failedStep.label,
                        code: failedStep.code,
                        message: failedStep.message,
                      },
                at: lf.created_at.toISOString(),
              },
      },
      chainSource: src,
      chainedBy: chainedBy.rows.map((c) =>
        c.project === r.project || canRead(c.project)
          ? { id: c.id, name: c.name, on: c.trigger.on ?? [], project: c.project, hidden: false }
          : { id: null, name: null, on: c.trigger.on ?? [], project: null, hidden: true },
      ),
      github:
        r.trigger_kind === 'github'
          ? { receiving: (await this.deps.githubWebhookSecret()) !== null, hookUrl: this.githubHookUrl() }
          : null,
    };
  }

  /** The project of an automation (route authorization), or null. */
  async projectOf(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.pool.query<{ project: string }>(
      "SELECT project FROM automations WHERE id = $1 AND state <> 'deleted'",
      [id],
    );
    return rows[0]?.project ?? null;
  }

  async runs(
    id: string,
    opts: { limit?: number | undefined; before?: string | undefined; state?: string | undefined } = {},
  ): Promise<RunView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const { rows } = await this.deps.pool.query<RunRow>(
      `${SELECT_RUN} WHERE r.automation_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
          AND ($3::text IS NULL OR r.state = $3)
        ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
      [id, opts.before ?? null, opts.state ?? null, limit],
    );
    const waiting = await this.#waiting({
      runIds: rows.filter((r) => r.state === 'running').map((r) => r.id),
    });
    return rows.map((r) => this.#runView(r, waiting.get(r.id) ?? null));
  }

  /**
   * p9-pagination: one page of the run history, newest first by `(created_at, id)` (keyset; stable while new
   * runs are appended). `runs` stays for the chat tools and other callers that only need the latest few.
   */
  async runsPage(
    id: string,
    opts: { limit?: number | undefined; cursor?: string | undefined; state?: string | undefined } = {},
  ): Promise<{ items: RunView[]; nextCursor: string | null }> {
    const limit = clampLimit(opts.limit, 50, 200);
    const after = opts.cursor === undefined ? null : decodeKeyset(RUNS_SCOPE, opts.cursor, 'uuid');
    const { rows } = await this.deps.pool.query<RunRow & { page_key: string }>(
      `SELECT r.*, j.state AS job_state, to_json(r.created_at) #>> '{}' AS page_key
         FROM automation_runs r LEFT JOIN jobs j ON j.id = r.job_id
        WHERE r.automation_id = $1 AND ($2::text IS NULL OR r.state = $2)
          AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
      [id, opts.state ?? null, after?.k ?? null, after?.id ?? null, limit + 1],
    );
    const shown = rows.slice(0, limit);
    const waiting = await this.#waiting({
      runIds: shown.filter((r) => r.state === 'running').map((r) => r.id),
    });
    return keysetPage(
      rows,
      limit,
      RUNS_SCOPE,
      (r) => ({ k: r.page_key, id: r.id }),
      (r) => this.#runView(r, waiting.get(r.id) ?? null),
    );
  }

  /** The step of a workflow run that failed, with its error and the step's label from the run's definition. */
  async #failedStepRow(
    workflowRunId: string,
  ): Promise<{ node_id: string; label: string | null; code: string | null; message: string | null } | null> {
    const { rows } = await this.deps.pool.query<{
      node_id: string;
      label: string | null;
      code: string | null;
      message: string | null;
    }>(
      `SELECT n.node_id, n.error->>'code' AS code, coalesce(n.error->>'message', n.reason) AS message,
              (SELECT x->>'label'
                 FROM workflow_runs wr
                 JOIN workflow_definitions d ON d.id = wr.definition_id AND d.version = wr.version,
                      jsonb_array_elements(d.definition->'nodes') x
                WHERE wr.id = n.run_id AND x->>'id' = n.node_id
                LIMIT 1) AS label
         FROM workflow_node_runs n
        WHERE n.run_id = $1 AND n.state = 'failed'
        ORDER BY n.ended_at DESC NULLS LAST, n.updated_at DESC
        LIMIT 1`,
      [workflowRunId],
    );
    return rows[0] ?? null;
  }

  async run(id: string, runId: string): Promise<RunDetail> {
    if (!UUID.test(runId)) throw this.#err(404, 'run_not_found', 'Run not found.');
    const { rows } = await this.deps.pool.query<RunRow>(
      `${SELECT_RUN} WHERE r.automation_id = $1 AND r.id = $2`,
      [id, runId],
    );
    const r = rows[0];
    if (r === undefined) throw this.#err(404, 'run_not_found', 'Run not found.');
    const waiting = r.state === 'running' ? (await this.#waiting({ runIds: [r.id] })).get(r.id) : undefined;
    return {
      ...this.#runView(r, waiting ?? null),
      payloadDigest: r.payload_digest,
      eventData: r.event_data,
      checkoutRef: r.checkout_ref,
      checkoutPullRequest:
        r.checkout_pull_request === null || r.checkout_head_sha === null
          ? null
          : { number: r.checkout_pull_request, headSha: r.checkout_head_sha },
      failedStep: await (async () => {
        if (r.workflow_run_id === null || (r.state !== 'failed' && r.state !== 'error')) return null;
        const f = await this.#failedStepRow(r.workflow_run_id);
        return f === null ? null : { nodeId: f.node_id, label: f.label, code: f.code, message: f.message };
      })(),
    };
  }

  // -------------------------------------------------------------------------------------------- triggers

  /**
   * Records one trigger occurrence. Returns the new run, or null when `dedupKey` was already used for this
   * automation (a redelivery / retry / racing sweeper).
   */
  async enqueue(db: Queryable, a: Row, ev: EnqueueEvent): Promise<RunRow | null> {
    const now = this.deps.clock();
    let state: RunState = 'queued';
    let reason: string | null = ev.note ?? null;
    if (ev.skip !== undefined) {
      state = 'skipped';
      reason = ev.skip;
    } else if ((ev.chainDepth ?? 0) > AUTOMATION_LIMITS.maxChainDepth) {
      state = 'skipped';
      reason = `The chain is deeper than ${String(AUTOMATION_LIMITS.maxChainDepth)} automations.`;
    } else {
      const q = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM automation_runs WHERE automation_id = $1 AND state = 'queued'",
        [a.id],
      );
      if ((q.rows[0]?.n ?? 0) >= AUTOMATION_LIMITS.queueLimit) {
        state = 'skipped';
        reason = `The queue is full (${String(AUTOMATION_LIMITS.queueLimit)} runs waiting).`;
      }
    }
    const data = ev.data ?? null;
    if (data !== null && Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_EVENT_BYTES) {
      throw this.#err(413, 'payload_too_large', 'The event data is larger than 64 KiB.');
    }
    const { rows } = await db.query<RunRow>(
      `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, scheduled_for, payload_digest,
                                    event_summary, event_data, source_trust, state, reason, chain_parent_run_id,
                                    chain_depth, checkout_ref, triggered_by, created_at, finished_at,
                                    checkout_pull_request, checkout_head_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (automation_id, dedup_key) DO NOTHING
       RETURNING *`,
      [
        a.id,
        a.project,
        ev.triggerKind,
        ev.dedupKey.slice(0, 200),
        ev.scheduledFor ?? null,
        ev.payloadDigest ?? null,
        ev.summary === undefined || ev.summary === null ? null : JSON.stringify(ev.summary),
        data === null ? null : JSON.stringify(data),
        ev.trust ?? 'trusted',
        state,
        reason === null ? null : reason.slice(0, 1000),
        ev.chainParentRunId ?? null,
        Math.min(ev.chainDepth ?? 0, 16),
        ev.checkoutRef ?? null,
        ev.triggeredBy ?? null,
        now,
        state === 'skipped' ? now : null,
        ev.checkoutPullRequest?.number ?? null,
        ev.checkoutPullRequest?.headSha ?? null,
      ],
    );
    const run = rows[0] ?? null;
    if (run !== null) await this.#touchLast(db, a.id);
    return run;
  }

  /** Sweeper: due schedules (cron / at) are claimed, advanced and their runs recorded; then started. */
  async fireDue(): Promise<number> {
    const now = this.deps.clock();
    const claimed = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT * FROM automations WHERE state = 'active' AND next_run_at <= $1
          ORDER BY next_run_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, AUTOMATION_LIMITS.batch],
      );
      for (const r of rows) {
        const due = r.next_run_at ?? now;
        if (r.trigger_kind === 'cron' && r.cron !== null) {
          const plan = planCatchUp(parseCron(r.cron, r.time_zone), due, now, r.catch_up);
          await tx.query('UPDATE automations SET next_run_at = $2, state = $3 WHERE id = $1', [
            r.id,
            plan.next,
            plan.next === null ? 'done' : 'active',
          ]);
          if (plan.skipped !== null) {
            await this.enqueue(tx, r, {
              triggerKind: 'cron',
              dedupKey: `cron:${plan.skipped.at.toISOString()}`,
              scheduledFor: plan.skipped.at,
              summary: { event: 'schedule', missed: plan.skipped.count },
              skip: `Missed ${String(plan.skipped.count)} scheduled time(s) while the master was not running (catch-up: ${r.catch_up}).`,
            });
          }
          for (const at of plan.fire) {
            await this.enqueue(tx, r, {
              triggerKind: 'cron',
              dedupKey: `cron:${at.toISOString()}`,
              scheduledFor: at,
              summary: { event: 'schedule', scheduledFor: at.toISOString() },
              data: { event: 'schedule', scheduledFor: at.toISOString() },
              note:
                plan.folded > 0
                  ? `${String(plan.folded)} earlier missed time(s) folded into this run (catch-up: once).`
                  : null,
            });
          }
        } else if (r.trigger_kind === 'at') {
          const decision = planOneShot(due, now, r.catch_up);
          await tx.query("UPDATE automations SET next_run_at = NULL, state = 'done' WHERE id = $1", [r.id]);
          await this.enqueue(tx, r, {
            triggerKind: 'at',
            dedupKey: `at:${due.toISOString()}`,
            scheduledFor: due,
            summary: { event: 'schedule', scheduledFor: due.toISOString() },
            data: { event: 'schedule', scheduledFor: due.toISOString() },
            ...(decision === 'skip'
              ? { skip: 'The one-time run was missed while the master was not running (catch-up: skip).' }
              : {}),
          });
        } else {
          // Not a schedule (changed concurrently): clear the due time.
          await tx.query('UPDATE automations SET next_run_at = NULL WHERE id = $1', [r.id]);
        }
      }
      return rows;
    });
    for (const r of claimed) await this.#startFor(r.id);
    return claimed.length;
  }

  /** `POST /v1/hooks/<id>`: a signed webhook call (raw body). */
  async receiveWebhook(
    id: string,
    headers: { timestamp?: string | undefined; nonce?: string | undefined; signature?: string | undefined },
    raw: Buffer,
    meta: { ip: string },
  ): Promise<HookResult> {
    const notFound = refuse(404, 'not_found', 'Unknown webhook.');
    if (!UUID.test(id)) return notFound;
    const r = await this.#row(this.deps.pool, id);
    if (r === null || r.trigger_kind !== 'webhook' || r.state === 'deleted') return notFound;
    // §18.5: a caller outside the allow-list gets the unknown-id answer (no oracle), checked before any secret.
    if (r.webhook_allow_ips !== null) {
      const parsed = parseAllowIps(r.webhook_allow_ips);
      if (!parsed.ok || !ipAllowed(parsed.list, meta.ip)) {
        await this.#auditReject(r, 'ip_not_allowed', meta.ip);
        return notFound;
      }
    }
    const secret = this.#unseal(r);
    if (secret === null) {
      this.deps.log.error(
        { automationId: id },
        'automation webhook secret cannot be unsealed (master key changed?)',
      );
      return refuse(503, 'secret_unavailable', 'The webhook secret cannot be read; rotate it.');
    }
    const now = this.deps.clock();
    const hdrs = { timestamp: headers.timestamp, nonce: headers.nonce, signature: headers.signature };
    let verdict = verifyRemyralWebhook(secret, hdrs, raw, now);
    let signedWith: 'current' | 'previous' = 'current';
    // §18.1: during the overlap window the previous secret is tried — only for a wrong signature (timestamp and
    // nonce rules are the same for both secrets).
    if (!verdict.ok && verdict.code === 'bad_signature' && this.#previousLive(r)) {
      const previous = this.#unseal(r, 'previous');
      if (previous !== null) {
        const second = verifyRemyralWebhook(previous, hdrs, raw, now);
        if (second.ok) {
          verdict = second;
          signedWith = 'previous';
          this.deps.log.warn({ automationId: id }, 'automation webhook signed with the previous secret');
        }
      }
    }
    if (!verdict.ok) {
      await this.#auditReject(r, verdict.code, meta.ip);
      return refuse(401, 'invalid_signature', 'The request signature is missing, stale or wrong.');
    }
    if (r.state !== 'active') {
      return refuse(409, 'automation_inactive', `The automation is ${r.state}.`);
    }
    let body: unknown;
    try {
      body = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      return refuse(400, 'invalid_body', 'The body must be a JSON object.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return refuse(400, 'invalid_body', 'The body must be a JSON object.');
    }
    if (raw.length > MAX_EVENT_BYTES)
      return refuse(413, 'payload_too_large', 'The body is larger than 64 KiB.');
    const keys = Object.keys(body).slice(0, 20);
    const run = await this.enqueue(this.deps.pool, r, {
      triggerKind: 'webhook',
      dedupKey: `webhook:${verdict.nonce}`,
      payloadDigest: payloadDigest(raw),
      summary: {
        event: 'webhook',
        bytes: raw.length,
        keys,
        ...(signedWith === 'previous' ? { signedWith: 'previous' } : {}),
      },
      data: { event: 'webhook', receivedAt: now.toISOString(), body },
      trust: 'trusted',
    });
    if (run === null) return { status: 200, body: { duplicate: true } };
    this.kick();
    return { status: 202, body: { accepted: true, runs: [run.id] } };
  }

  async #auditReject(r: Row, code: string, ip: string): Promise<void> {
    this.deps.log.warn({ automationId: r.id, code }, 'automation webhook refused');
    const now = this.deps.clock().getTime();
    const last = this.#rejectAudited.get(r.id) ?? 0;
    if (now - last < 60_000) return;
    this.#rejectAudited.set(r.id, now);
    if (this.#rejectAudited.size > 10_000) this.#rejectAudited.clear();
    await this.deps.audit.record({
      actor: { type: 'anonymous' },
      action: 'automation.webhook.reject',
      target: `automation:${r.id}`,
      outcome: 'denied',
      ip,
      // `refusal`, not `code`: the audit redactor treats a `code` key as a one-time code.
      metadata: { project: r.project, refusal: code },
    });
  }

  /** `POST /v1/hooks/github`: a GitHub App delivery (raw body). */
  async receiveGitHub(
    headers: {
      event?: string | undefined;
      delivery?: string | undefined;
      signature?: string | undefined;
      contentType?: string | undefined;
      hookTargetType?: string | undefined;
      hookTargetId?: string | undefined;
    },
    raw: Buffer,
  ): Promise<HookResult> {
    // p17-chat-github: a delivery is verified with the secret of the App it comes from (header
    // X-GitHub-Hook-Installation-Target-ID); an App no connection knows has no secret and is refused like a wrong
    // signature. Without the header every connection's secret is tried (bounded by the connection limit).
    const appId =
      headers.hookTargetId !== undefined &&
      /^[0-9]{1,20}$/.test(headers.hookTargetId) &&
      (headers.hookTargetType === undefined || headers.hookTargetType === 'integration')
        ? headers.hookTargetId
        : null;
    const many = this.deps.githubWebhookSecrets;
    const secrets =
      many === undefined
        ? [await this.deps.githubWebhookSecret()].filter((x): x is string => x !== null)
        : await many(appId);
    if (secrets.length === 0 && (many === undefined || (await many(null)).length === 0)) {
      return refuse(503, 'github_not_configured', 'No GitHub App webhook secret is configured.');
    }
    if (!secrets.some((secret) => verifyGitHubSignature(secret, headers.signature, raw))) {
      this.deps.log.warn({ delivery: headers.delivery?.slice(0, 64) }, 'github webhook signature refused');
      return refuse(401, 'invalid_signature', 'The X-Hub-Signature-256 signature is missing or wrong.');
    }
    const event = headers.event ?? '';
    if (event === 'ping') return { status: 200, body: { pong: true } };
    const delivery = headers.delivery ?? '';
    if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery) || !/^[a-z_]{1,64}$/.test(event)) {
      return refuse(400, 'invalid_delivery', 'X-GitHub-Event and X-GitHub-Delivery are required.');
    }
    let payload: unknown;
    try {
      const text = raw.toString('utf8');
      payload = (headers.contentType ?? '').startsWith('application/x-www-form-urlencoded')
        ? (JSON.parse(new URLSearchParams(text).get('payload') ?? 'null') as unknown)
        : (JSON.parse(text) as unknown);
    } catch {
      return refuse(400, 'invalid_body', 'The delivery body is not JSON.');
    }
    const repo = eventRepository(payload);
    if (repo === null) return { status: 200, body: { ignored: 'no repository' } };
    if (this.deps.githubGitEvents !== undefined) {
      try {
        await this.deps.githubGitEvents(repo, event, payload);
      } catch (err) {
        this.deps.log.warn(
          { delivery: delivery.slice(0, 64), err: err instanceof Error ? err.message : String(err) },
          'github webhook: git flow re-check not marked',
        );
      }
    }
    const { rows } = await this.deps.pool.query<Row>(
      `${SELECT_AUTOMATION} WHERE a.github_repo = $1 AND $2 = ANY(a.github_events) AND a.state = 'active'`,
      [repo, event],
    );
    const runs: string[] = [];
    let duplicates = 0;
    const digest = payloadDigest(raw);
    for (const a of rows) {
      const m = matchGitHubEvent(triggerOf(a) as GitHubTrigger, event, payload);
      if (!m.match) continue;
      // The signature covers the body only, not X-GitHub-Delivery: a captured delivery replayed under a new id is
      // recognised by the digest of its signed body (24 h; GitHub's own "Redeliver" sends the same body and is a
      // duplicate as well). The lock serialises concurrent copies of one body for this automation.
      const run = await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`automation-github:${a.id}:${digest}`]);
        const seen = await tx.query(
          `SELECT 1 FROM automation_runs
            WHERE automation_id = $1 AND trigger_kind = 'github' AND payload_digest = $2 AND created_at > $3
            LIMIT 1`,
          [a.id, digest, new Date(this.deps.clock().getTime() - GITHUB_REPLAY_WINDOW_MS)],
        );
        if (seen.rows.length > 0) return null;
        return this.enqueue(tx, a, {
          triggerKind: 'github',
          dedupKey: `github:${delivery}`,
          payloadDigest: digest,
          summary: { ...m.summary, delivery },
          data: m.data,
          trust: m.trust,
          checkoutRef: m.checkoutRef,
          checkoutPullRequest: m.checkoutPullRequest,
        });
      });
      if (run === null) duplicates++;
      else runs.push(run.id);
    }
    if (runs.length > 0) this.kick();
    if (runs.length === 0) {
      return {
        status: 200,
        body: duplicates > 0 ? { duplicate: true } : { ignored: 'no automation matched' },
      };
    }
    return { status: 202, body: { accepted: true, runs } };
  }

  // -------------------------------------------------------------------------------------------- start pass

  /** The orchestrator tick step: sweep interrupted starts, fire due schedules, sync runs, start queued runs. */
  step(): TickStep {
    return { name: 'automations', run: () => this.tick() };
  }

  async tick(): Promise<void> {
    await this.expirePreviousSecrets();
    await this.sweepStarting();
    await this.fireDue();
    await this.fireWorkflowChains();
    await this.syncRuns();
    await this.watchApprovals();
    await this.startQueued();
  }

  /**
   * p14-workflow-engine 14.2 (`trigger.workflow`): chain automations on a workflow's runs. Every finished run of the
   * source workflow (by project + name, after the automation was last changed, within a day) with a chosen outcome
   * enqueues one run (dedup key `workflow:<run>`, so a restart or a second master never fires twice). The source
   * run's outputs are the event data (untrusted: produced by a workflow that may have read untrusted input).
   */
  async fireWorkflowChains(): Promise<number> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      automation_id: string;
      run_id: string;
      state: string;
      outputs: unknown;
      ended_at: Date;
      depth: number | null;
      project: string;
      name: string;
    }>(
      `SELECT a.id AS automation_id, r.id AS run_id, r.state, r.outputs, r.ended_at, r.project, r.name,
              (SELECT max(ar.chain_depth) FROM automation_runs ar WHERE ar.workflow_run_id = r.id) AS depth
         FROM automations a
         JOIN workflow_runs r ON r.project = a.source_workflow_project AND r.name = a.source_workflow_name
        WHERE a.state = 'active' AND a.trigger_kind = 'chain' AND a.source_workflow_name IS NOT NULL
          AND r.state IN ('succeeded', 'failed', 'cancelled') AND r.ended_at >= a.updated_at
          AND r.ended_at > $1 AND (a.trigger -> 'on') ? r.state
          AND NOT EXISTS (SELECT 1 FROM automation_runs x WHERE x.automation_id = a.id
                            AND x.dedup_key = 'workflow:' || r.id::text)
        ORDER BY r.ended_at LIMIT $2`,
      [new Date(now.getTime() - 86_400_000), AUTOMATION_LIMITS.batch],
    );
    const fired = new Set<string>();
    for (const x of rows) {
      await withTransaction(this.deps.pool, async (tx) => {
        const a = await this.#row(tx, x.automation_id, true);
        if (a?.state !== 'active') return;
        const outputs =
          x.outputs !== null && typeof x.outputs === 'object' && '$payload' in x.outputs
            ? null
            : (x.outputs ?? null);
        const base = {
          event: 'workflow',
          runId: x.run_id,
          workflow: { project: x.project, name: x.name },
          outcome: x.state,
          endedAt: x.ended_at.toISOString(),
        };
        const fits =
          Buffer.byteLength(JSON.stringify({ ...base, outputs }), 'utf8') <= MAX_EVENT_BYTES - 1024;
        const run = await this.enqueue(tx, a, {
          triggerKind: 'chain',
          dedupKey: `workflow:${x.run_id}`,
          summary: { event: 'workflow', runId: x.run_id, outcome: x.state },
          data: { ...base, outputs: fits ? outputs : null, ...(fits ? {} : { outputsOmitted: true }) },
          trust: 'untrusted',
          chainDepth: (x.depth ?? 0) + 1,
        });
        if (run !== null) fired.add(a.id);
      });
    }
    for (const id of fired) await this.#startFor(id);
    return fired.size;
  }

  /**
   * p14-workflow-engine 14.2: the definition a bound automation runs — the workflow's latest version at fire time,
   * or the binding's pinned version (null: not bound, or the workflow is gone — the stored target applies).
   */
  async #boundDefinition(a: Row): Promise<string | null> {
    if (a.workflow_trigger_node === null) return null;
    // p18-multi-project: a binding of a project that attached the workflow runs the attachment's version.
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT d.id FROM workflow_trigger_bindings b
         LEFT JOIN workflow_attachments wa ON wa.project = b.project AND wa.name = b.name AND wa.state <> 'detached'
         JOIN workflow_definitions d ON d.project = coalesce(wa.owner_project, b.project) AND d.name = b.name
        WHERE b.automation_id = $1
          AND (CASE WHEN wa.id IS NOT NULL THEN d.version = wa.version
                    ELSE (b.pinned_version IS NULL OR d.version = b.pinned_version) END)
        ORDER BY d.version DESC LIMIT 1`,
      [a.id],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * p14-workflow-engine 14.2: the current (and, during a rotation, previous) secrets of a workflow's bound, active
   * webhook triggers — a signed webhook wait verifies its caller with them. Never leaves the master.
   */
  async workflowWebhookSecrets(project: string, name: string): Promise<string[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT a.* FROM automations a JOIN workflow_trigger_bindings b ON b.automation_id = a.id
        WHERE b.project = $1 AND b.name = $2 AND b.enabled AND a.trigger_kind = 'webhook' AND a.state = 'active'`,
      [project, name],
    );
    const out: string[] = [];
    for (const r of rows) {
      const cur = this.#unseal(r);
      if (cur !== null) out.push(cur);
      if (this.#previousLive(r)) {
        const prev = this.#unseal(r, 'previous');
        if (prev !== null) out.push(prev);
      }
    }
    return out;
  }

  /** Starts queued runs soon (after an inbound trigger), serialised. */
  kick(): void {
    this.#chain = this.#chain
      .then(() => this.startQueued())
      .then(() => undefined)
      .catch((err: unknown) => {
        this.deps.log.warn({ err }, 'automation start pass failed');
      });
  }

  /** Resolves when the kicked start passes have finished (tests). */
  idle(): Promise<void> {
    return this.#chain;
  }

  async startQueued(): Promise<number> {
    const { rows } = await this.deps.pool.query<{ automation_id: string }>(
      `SELECT automation_id FROM automation_runs WHERE state = 'queued'
        GROUP BY automation_id ORDER BY min(created_at) LIMIT $1`,
      [AUTOMATION_LIMITS.batch],
    );
    let started = 0;
    for (const r of rows) started += await this.#startFor(r.automation_id);
    return started;
  }

  /** Applies the start policy to the queued runs of one automation (oldest first). Returns the number started. */
  async #startFor(id: string, opts: { includePaused?: boolean } = {}): Promise<number> {
    let started = 0;
    for (let i = 0; i < AUTOMATION_LIMITS.batch; i++) {
      const now = this.deps.clock();
      const step = await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 23))', [`automation-start:${id}`]);
        const a = (await tx.query<Row>('SELECT * FROM automations WHERE id = $1', [id])).rows[0];
        const run = (
          await tx.query<RunRow>(
            `SELECT * FROM automation_runs WHERE automation_id = $1 AND state = 'queued'
              ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (a === undefined || run === undefined) return null;
        const runnable =
          a.state === 'active' ||
          a.state === 'done' ||
          (a.state === 'paused' && (opts.includePaused === true || run.trigger_kind === 'manual'));
        if (!runnable) {
          await this.#setRun(tx, run.id, 'skipped', `The automation is ${a.state}.`);
          return { kind: 'skipped' as const, a, run };
        }
        const counts = await tx.query<{ active: number; recent: number }>(
          `SELECT count(*) FILTER (WHERE state IN ('starting', 'running'))::int AS active,
                  count(*) FILTER (WHERE started_at >= $2)::int AS recent
             FROM automation_runs WHERE automation_id = $1`,
          [id, new Date(now.getTime() - ONE_HOUR)],
        );
        const d = startDecision({
          concurrency: a.concurrency,
          active: counts.rows[0]?.active ?? 0,
          startedLastHour: counts.rows[0]?.recent ?? 0,
          maxRunsPerHour: a.max_runs_per_hour,
        });
        if (d.action === 'wait') return null;
        if (d.action === 'skip') {
          await this.#setRun(tx, run.id, 'skipped', d.reason);
          return { kind: 'skipped' as const, a, run };
        }
        await tx.query("UPDATE automation_runs SET state = 'starting', started_at = $2 WHERE id = $1", [
          run.id,
          now,
        ]);
        await tx.query('UPDATE automations SET run_count = run_count + 1 WHERE id = $1', [id]);
        return { kind: 'start' as const, a, run };
      });
      if (step === null) break;
      if (step.kind === 'skipped') {
        await this.#touchLast(this.deps.pool, id);
        continue;
      }
      await this.#launch(step.a, step.run);
      started++;
    }
    return started;
  }

  async #setRun(
    db: Queryable,
    runId: string,
    state: RunState,
    reason: string | null,
  ): Promise<RunRow | null> {
    const finished = state !== 'queued' && state !== 'starting' && state !== 'running';
    const { rows } = await db.query<RunRow>(
      `UPDATE automation_runs SET state = $2, reason = COALESCE($3, reason),
              finished_at = CASE WHEN $4 THEN $5::timestamptz ELSE finished_at END
        WHERE id = $1 AND state IN ('queued', 'starting', 'running') RETURNING *`,
      [runId, state, reason === null ? null : reason.slice(0, 1000), finished, this.deps.clock()],
    );
    return rows[0] ?? null;
  }

  async #touchLast(db: Queryable, id: string): Promise<void> {
    await db.query(
      `UPDATE automations a SET last_run_id = r.id, last_run_state = r.state, last_run_at = r.created_at
         FROM (SELECT id, state, created_at FROM automation_runs WHERE automation_id = $1
                ORDER BY (state = 'skipped'), created_at DESC, id DESC LIMIT 1) r
        WHERE a.id = $1`,
      [id],
    );
  }

  /** null when the run-as user may still start this automation; else the reason. */
  async #mayStillRun(db: Queryable, a: Row): Promise<string | null> {
    const { rows } = await db.query<{ id: string; role: Role; disabled_at: Date | null }>(
      'SELECT id, role, disabled_at FROM users WHERE id = $1',
      [a.run_as],
    );
    const user = rows[0];
    if (user === undefined || user.disabled_at !== null) return 'the automation’s run-as account is disabled';
    const subject = await loadSubject(db, { id: user.id, role: user.role });
    const action =
      a.target_kind === 'job'
        ? 'jobs.create'
        : a.target_kind === 'deploy'
          ? 'deploy.request'
          : 'workflows.run';
    if (!authorize(subject, action, { project: a.project }).allow) {
      const what =
        action === 'jobs.create'
          ? 'submit jobs'
          : action === 'deploy.request'
            ? 'request deploys'
            : 'start workflow runs';
      return `the automation’s run-as user may no longer ${what} in ${a.project}`;
    }
    if (
      EXTERNAL_KINDS.has(a.trigger_kind) &&
      !authorize(subject, 'automations.external', { project: a.project }).allow
    ) {
      return `the automation’s run-as user may no longer run GitHub or webhook automations in ${a.project}`;
    }
    // p14-workflow-engine 14.2: a workflow source of another project needs the same cross-project rights, now.
    if (
      a.trigger_kind === 'chain' &&
      a.source_workflow_project !== null &&
      a.source_workflow_project !== a.project &&
      !(
        authorize(subject, 'automations.crossproject', { project: a.project }).allow &&
        authorize(subject, 'automations.crossproject', { project: a.source_workflow_project }).allow
      )
    ) {
      return `the automation’s run-as user is no longer admin in both ${a.project} and ${a.source_workflow_project} (cross-project chain)`;
    }
    // §18.4: a chain across projects needs the run-as user to be admin in both projects, now.
    if (a.trigger_kind === 'chain' && a.chain_source_id !== null) {
      const src = await db.query<{ project: string }>('SELECT project FROM automations WHERE id = $1', [
        a.chain_source_id,
      ]);
      const sourceProject = src.rows[0]?.project ?? null;
      if (sourceProject === null) return 'the chained source automation no longer exists';
      if (
        sourceProject !== a.project &&
        !(
          authorize(subject, 'automations.crossproject', { project: a.project }).allow &&
          authorize(subject, 'automations.crossproject', { project: sourceProject }).allow
        )
      ) {
        return `the automation’s run-as user is no longer admin in both ${a.project} and ${sourceProject} (cross-project chain)`;
      }
    }
    return null;
  }

  /** p6-result-reuse: the reuse policy is for job targets only (a workflow / deploy target refuses it). */
  #reusePolicy(kind: AutomationTarget['kind'], hours: number | null): number | null {
    if (hours === null) return null;
    if (kind !== 'job') {
      throw this.#err(
        400,
        'reuse_job_targets_only',
        'Skipping runs with an identical successful result is available for job targets only.',
      );
    }
    return hours;
  }

  /**
   * p6-result-reuse: a recent identical successful job for this run, when the automation opted in — never for
   * "Run now" (the user asked for a run), untrusted sources, or runs that carry event data other than a schedule's
   * due time (a GitHub / webhook / chain event is part of the job's input, so no earlier job saw the same thing).
   */
  async #identical(a: Row, run: RunRow, spec: Record<string, unknown>, inputs: readonly PreparedInput[]) {
    const reuse = this.deps.reuse;
    if (reuse === undefined || a.reuse_within_hours === null || a.target_kind !== 'job') return null;
    if (run.trigger_kind === 'manual' || run.source_trust !== 'trusted') return null;
    // Schedule runs carry only their due time; GitHub, webhook and chain data is input the earlier job never saw.
    if (run.event_data !== null && run.event_data.event !== 'schedule') return null;
    const verdict = await reuse.find({
      project: a.project,
      spec,
      inputs: inputs.map((i) => ({ name: i.ref.name, sha256: i.ref.sha256 })),
      withinHours: a.reuse_within_hours,
    });
    return verdict.kind === 'match' ? verdict : null;
  }

  /** The job spec of one run: the template, the event's checkout branch, untrusted sources confined (ADR-0010). */
  #jobSpec(a: Row, run: RunRow): Record<string, unknown> {
    const spec: Record<string, unknown> = { ...(a.job_spec ?? {}) };
    // p15-job-titles: the automation's job title, else the automation's name (never event data).
    if (typeof spec.title !== 'string') {
      const named = normalizeJobTitle(a.name);
      if (named !== null) spec.title = named;
    }
    const repo = spec.repository as { url: string; baseRef: string; workBranch: string } | undefined;
    if (run.checkout_ref !== null && repo !== undefined)
      spec.repository = { ...repo, baseRef: run.checkout_ref };
    if (run.source_trust === 'untrusted') {
      spec.sourceTrust = 'untrusted';
      spec.sandboxProfile = 'container';
      if (spec.approvalPolicy === 'allow-all') spec.approvalPolicy = 'ask-sensitive';
    }
    // §18.2 (ADR-0026): an untrusted pull request's head, pinned to the event's SHA; no secrets, container only.
    if (run.checkout_pull_request !== null && run.checkout_head_sha !== null && repo !== undefined) {
      spec.repository = {
        url: repo.url,
        workBranch: repo.workBranch,
        baseRef: run.checkout_head_sha,
        pullRequest: { number: run.checkout_pull_request, headSha: run.checkout_head_sha },
      };
      spec.sourceTrust = 'untrusted';
      spec.sandboxProfile = 'container';
      if (spec.approvalPolicy === 'allow-all') spec.approvalPolicy = 'ask-sensitive';
      delete spec.secretRefs;
    }
    return spec;
  }

  async #launch(a: Row, run: RunRow): Promise<void> {
    const reason = await this.#mayStillRun(this.deps.pool, a);
    if (reason !== null) {
      await this.#setRun(this.deps.pool, run.id, 'error', `Not started: ${reason}.`);
      await this.deps.pool.query(
        "UPDATE automations SET state = 'failed', next_run_at = NULL, updated_at = $2 WHERE id = $1 AND state <> 'deleted'",
        [a.id, this.deps.clock()],
      );
      await this.#auditFire(a, run, 'denied', { reason });
      await this.#afterFinish(a.id, run.id, true);
      return;
    }
    try {
      const { inputs, note } = await this.#runInputs(a, run);
      if (note !== null) {
        await this.deps.pool.query(
          `UPDATE automation_runs SET reason = left(concat_ws('; ', reason, $2::text), 1000) WHERE id = $1`,
          [run.id, note],
        );
      }
      if (a.target_kind === 'job') {
        const spec = this.#jobSpec(a, run);
        const same = await this.#identical(a, run, spec, inputs);
        if (same !== null) {
          // Recorded, linked and audited — never a silent skip.
          await this.deps.pool.query(
            `UPDATE automation_runs SET state = 'skipped', reused_job_id = $2, finished_at = $3,
                    reason = left(concat_ws('; ', reason, $4::text), 1000)
              WHERE id = $1 AND state = 'starting'`,
            [
              run.id,
              same.jobId,
              this.deps.clock(),
              `Skipped: an identical job succeeded ${same.age} (job ${same.jobId}); reuse policy: within ${String(a.reuse_within_hours)} h.`,
            ],
          );
          await this.#auditFire(a, run, 'success', { skipped: 'identical_result', reusedJobId: same.jobId });
          await this.#afterFinish(a.id, run.id, false);
          return;
        }
        if (await this.#budgetSkip(a, run, typeof spec.runtime === 'string' ? spec.runtime : null)) return;
        // p6-deploy-on-success (ADR-0030): the save-time approval, re-checked for the run-as user now. A run that may
        // not deploy still runs its job (the run says why); an untrusted source never deploys.
        let jobSpec: Record<string, unknown> = spec;
        let deploy: PreparedDeployOnSuccess | null = null;
        const dos = this.deps.deployOnSuccess?.() ?? null;
        if (a.deploy_on_success !== null) {
          let skip: string | null = null;
          if (run.source_trust === 'untrusted') skip = 'an untrusted source never deploys';
          else if (dos === null) skip = 'deploy integrations are not available';
          else {
            try {
              const out = await dos.prepareForRun(a.run_as, a.project, a.deploy_on_success, spec);
              jobSpec = out.spec;
              deploy = out.prepared;
            } catch (err) {
              if (!(err instanceof OpsError)) throw err;
              skip = err.message;
            }
          }
          if (skip !== null) {
            await this.deps.pool.query(
              `UPDATE automation_runs SET reason = left(concat_ws('; ', reason, $2::text), 1000) WHERE id = $1`,
              [run.id, `Not deploying on success: ${skip}`],
            );
          }
        }
        const verifier = this.deps.verification?.() ?? null;
        const verifyMode = a.verify_on_success ?? null;
        const verifyPrepared =
          verifier === null
            ? null
            : await verifier.resolve(
                a.project,
                verifyMode === null ? undefined : { mode: verifyMode },
                'automation',
                jobSpec,
              );
        const { job } = await this.deps.jobs.create({
          project: a.project,
          spec: jobSpec,
          priority: a.priority,
          actor: { type: 'user', id: a.run_as },
          submit: true,
          ...(inputs.length > 0 ? { inputs } : {}),
          ...((deploy === null || dos === null) && a.output_folder_id == null && verifyPrepared === null
            ? {}
            : {
                withinCreate: async (tx, jobId) => {
                  // p10-verify-health: the automation's mode, else the project's default.
                  if (verifyPrepared !== null && verifier !== null) {
                    await verifier.record(tx, jobId, a.project, verifyPrepared, a.run_as, {
                      automationId: a.id,
                      runId: run.id,
                    });
                  }
                  if (deploy !== null && dos !== null) {
                    await dos.record(tx, jobId, deploy, 'automation', { automationId: a.id, runId: run.id });
                  }
                  // p8-outputs-folders: linked when the job ends, re-checked for the run-as user then.
                  const folders = this.deps.outputFolders?.() ?? null;
                  if (a.output_folder_id != null && folders !== null) {
                    await folders.recordJobTarget(tx, jobId, a.output_folder_id, a.run_as, 'automation');
                  }
                },
              }),
        });
        await this.deps.pool.query(
          "UPDATE automation_runs SET state = 'running', job_id = $2 WHERE id = $1 AND state = 'starting'",
          [run.id, job.id],
        );
        void this.deps.dispatch(job.id).catch(() => undefined);
        await this.#auditFire(a, run, 'success', { jobId: job.id });
      } else if (a.target_kind === 'deploy' && a.deploy_action !== null) {
        // p6-deploy-pipeline (ADR-0028): untrusted sources (forks, outside authors) never deploy.
        if (run.source_trust === 'untrusted') {
          await this.#setRun(
            this.deps.pool,
            run.id,
            'error',
            'Not started: an untrusted source cannot trigger a deploy.',
          );
          await this.#auditFire(a, run, 'denied', { reason: 'untrusted_source' });
          await this.#afterFinish(a.id, run.id, false);
          return;
        }
        const deploy = this.deps.deploy?.() ?? null;
        if (deploy === null) throw new Error('deploy integrations are not available');
        const out = await deploy.request({
          automationId: a.id,
          runId: run.id,
          project: a.project,
          runAs: a.run_as,
          action: a.deploy_action,
        });
        await this.deps.pool.query(
          "UPDATE automation_runs SET state = 'running', ops_action_id = $2 WHERE id = $1 AND state = 'starting'",
          [run.id, out.actionId],
        );
        await this.#auditFire(a, run, 'success', { opsActionId: out.actionId, opsState: out.state });
        await this.syncRuns();
      } else if (a.workflow_id !== null) {
        if (await this.#budgetSkip(a, run, null)) return;
        // p14-workflow-engine 14.2: a bound trigger runs the workflow's latest version at fire time (or the pinned one).
        const definitionId = (await this.#boundDefinition(a)) ?? a.workflow_id;
        const wfRun = await this.deps.startWorkflow()({ type: 'user', id: a.run_as }, definitionId, {
          // p18-multi-project: the run belongs to the automation's project (an attachment's runs never the owner's).
          project: a.project,
          inputs: a.workflow_inputs ?? {},
          ...(a.workflow_repository === null ? {} : { repository: a.workflow_repository }),
          ...(inputs.length > 0 ? { files: inputs } : {}),
          priority: a.priority,
          trigger: {
            kind:
              a.trigger_kind === 'cron' || a.trigger_kind === 'at'
                ? 'schedule'
                : a.trigger_kind === 'webhook' || a.trigger_kind === 'github'
                  ? a.trigger_kind
                  : a.source_workflow_name !== null
                    ? 'workflow'
                    : 'automation',
            // Design §6: event data from outside (webhook / GitHub / another workflow) is untrusted data in the run,
            // whatever the automation's own trust (a signed webhook is authentic, its content still untrusted).
            sourceTrust:
              a.trigger_kind === 'webhook' || a.trigger_kind === 'github' || a.source_workflow_name !== null
                ? 'untrusted'
                : run.source_trust,
            node: a.workflow_trigger_node,
            data: run.event_data,
          },
        });
        await this.deps.pool.query(
          "UPDATE automation_runs SET state = 'running', workflow_run_id = $2 WHERE id = $1 AND state = 'starting'",
          [run.id, wfRun],
        );
        await this.#auditFire(a, run, 'success', { workflowRunId: wfRun });
      }
      await this.#touchLast(this.deps.pool, a.id);
    } catch (err) {
      const message =
        err instanceof InvalidJobError
          ? `invalid job: ${err.issues.map((i) => `${i.path}:${i.code}`).join(', ')}`
          : err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
            ? `${(err as { code: string }).code}: ${err.message}`
            : 'submission failed';
      this.deps.log.warn({ err, automationId: a.id, runId: run.id }, 'automation run could not start');
      await this.#setRun(this.deps.pool, run.id, 'error', `Not started: ${message}`.slice(0, 1000));
      await this.#auditFire(a, run, 'failure', { reason: message.slice(0, 200) });
      await this.#afterFinish(a.id, run.id, false);
    }
  }

  /**
   * p5-research-workspace-next: the inputs of one run — the automation's stored files, then the artifacts of the job
   * it continues from (a fixed job, re-checked against the run-as user's rights now; its last succeeded run; the
   * chained source run). What is missing or does not fit is noted on the run instead of failing it, except a fixed
   * job without artifacts left (the automation was built on it: `error`).
   */
  async #runInputs(a: Row, run: RunRow): Promise<{ inputs: PreparedInput[]; note: string | null }> {
    const ws = this.deps.workspaces;
    if (ws === undefined) return { inputs: [], note: null };
    const stored = await ws.automationFileInputs(a.id);
    const cf = a.continue_from;
    const notes: string[] = [];
    let continued: PreparedInput[] = [];
    if (cf !== null) {
      let source: string | null;
      if (cf.kind === 'job') {
        await requireReadableJob(this.deps.pool, await this.#subjectOf({ id: a.run_as }), cf.jobId);
        source = cf.jobId;
      } else if (cf.kind === 'last-run') {
        const { rows } = await this.deps.pool.query<{ job_id: string }>(
          `SELECT job_id FROM automation_runs
            WHERE automation_id = $1 AND id <> $2 AND state = 'succeeded' AND job_id IS NOT NULL
            ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1`,
          [a.id, run.id],
        );
        source = rows[0]?.job_id ?? null;
        if (source === null) notes.push('no earlier succeeded run to continue from yet');
      } else {
        const { rows } = await this.deps.pool.query<{ job_id: string | null }>(
          'SELECT job_id FROM automation_runs WHERE id = $1',
          [run.chain_parent_run_id],
        );
        source = rows[0]?.job_id ?? null;
        if (source === null) notes.push('the triggering run started no job to continue from');
        // Chains may cross projects (p6-automations-next): the run-as user must be able to read the source job.
        if (source !== null) {
          await requireReadableJob(this.deps.pool, await this.#subjectOf({ id: a.run_as }), source);
        }
      }
      if (source !== null) {
        continued = await ws.inputsFromJob(source, new Set(stored.map((s) => s.ref.name)), {
          optional: cf.kind !== 'job',
        });
        if (continued.length === 0) notes.push(`job ${source} has no artifacts left to continue from`);
      }
    }
    const combined = combineInputs(stored, continued);
    if (combined.dropped.length > 0) {
      notes.push(
        `${String(combined.dropped.length)} file(s) not attached (input limits): ${combined.dropped.join(', ')}`,
      );
    }
    return { inputs: combined.inputs, note: notes.length === 0 ? null : `Inputs: ${notes.join('; ')}.` };
  }

  /**
   * p8-cost-efficiency: an exhausted budget pauses or blocks automation runs → the run is skipped with the reason
   * (recorded, audited, never silent); the next trigger tries again.
   */
  async #budgetSkip(a: Row, run: RunRow, runtime: string | null): Promise<boolean> {
    const gate = this.deps.budgetGate?.() ?? null;
    if (gate === null) return false;
    const why = await gate(a.project, runtime);
    if (why === null) return false;
    await this.deps.pool.query(
      `UPDATE automation_runs SET state = 'skipped', finished_at = $2,
              reason = left(concat_ws('; ', reason, $3::text), 1000)
        WHERE id = $1 AND state = 'starting'`,
      [run.id, this.deps.clock(), `Skipped: ${why}.`],
    );
    await this.#auditFire(a, run, 'denied', { skipped: 'budget_exhausted' });
    await this.#afterFinish(a.id, run.id, false);
    return true;
  }

  async #auditFire(
    a: Row,
    run: RunRow,
    outcome: 'success' | 'failure' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: SYSTEM,
      action: 'automation.fire',
      target: `automation:${a.id}`,
      outcome,
      metadata: {
        project: a.project,
        runAs: a.run_as,
        runId: run.id,
        trigger: run.trigger_kind,
        dedupKey: run.dedup_key,
        sourceTrust: run.source_trust,
        target: a.target_kind,
        ...metadata,
      },
    });
  }

  /** Interrupted starts (a crash between claim and submission): `error`, never a second submission. */
  async sweepStarting(): Promise<number> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<RunRow>(
      `UPDATE automation_runs SET state = 'error', finished_at = $1,
              reason = 'Interrupted while starting (the master stopped); not retried to avoid a duplicate job.'
        WHERE state = 'starting' AND started_at < $2 RETURNING *`,
      [now, new Date(now.getTime() - AUTOMATION_LIMITS.startingTimeoutMs)],
    );
    for (const r of rows) await this.#afterFinish(r.automation_id, r.id, false);
    return rows.length;
  }

  /** Running runs whose job / workflow run ended: finished, then chains and failure notifications. */
  async syncRuns(): Promise<number> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      automation_id: string;
      reason: string | null;
      job_state: string | null;
      wf_state: string | null;
      ops_state: string | null;
    }>(
      `SELECT r.id, r.automation_id, r.reason, j.state AS job_state, w.state AS wf_state, o.state AS ops_state
         FROM automation_runs r
         LEFT JOIN jobs j ON j.id = r.job_id
         LEFT JOIN workflow_runs w ON w.id = r.workflow_run_id
         LEFT JOIN ops_actions o ON o.id = r.ops_action_id
        WHERE r.state = 'running'
          AND (j.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') OR w.state IN ('succeeded', 'failed', 'cancelled')
               OR o.state IN ('succeeded', 'failed', 'refused', 'denied', 'expired'))
        ORDER BY r.created_at LIMIT 200`,
    );
    let n = 0;
    for (const r of rows) {
      // p6-deploy-pipeline: a deploy target's run ends with its ops action.
      if (r.ops_state !== null) {
        const ok = r.ops_state === 'succeeded';
        const done = await this.#setRun(
          this.deps.pool,
          r.id,
          ok ? 'succeeded' : 'failed',
          ok ? null : `The deploy ended ${r.ops_state}.`,
        );
        if (done === null) continue;
        n++;
        await this.#afterFinish(r.automation_id, r.id, false);
        continue;
      }
      const state =
        (r.job_state === null ? null : runStateOfJob(r.job_state)) ??
        (r.wf_state === null ? null : runStateOfWorkflow(r.wf_state));
      if (state === null) continue;
      // An approval timeout already says why the job was cancelled (§11a): keep it.
      const reason =
        state === 'succeeded' || r.reason?.startsWith(APPROVAL_TIMEOUT_REASON) === true
          ? null
          : r.job_state !== null
            ? `The job ended ${r.job_state.toLowerCase()}.`
            : `The workflow run ended ${String(r.wf_state)}.`;
      const done = await this.#setRun(this.deps.pool, r.id, state, reason);
      if (done === null) continue; // another pass got it
      n++;
      await this.#afterFinish(r.automation_id, r.id, false);
    }
    return n;
  }

  /**
   * p6-automation-defaults (design §11a): running runs paused on a pending human approval. The first time a run is
   * seen waiting, the project's operators are notified (once per run); a run waiting longer than its automation's
   * approval timeout gets its waiting job(s) cancelled with a clear reason (the run then ends `cancelled` through
   * the sync pass). Normal jobs and the approval engine are not touched: the approval request itself stays as it is
   * and closes with the job.
   */
  async watchApprovals(): Promise<{ notified: number; cancelled: number }> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      run_id: string;
      automation_id: string;
      waiting_at: Date | null;
      timeout: number | null;
      approval_id: string;
      approval_job_id: string;
      action: string;
      since: Date;
    }>(
      `SELECT r.id AS run_id, r.automation_id, r.approval_waiting_at AS waiting_at,
              a.approval_timeout_minutes AS timeout,
              q.id AS approval_id, q.job_id AS approval_job_id, q.action, q.created_at AS since
         FROM automation_runs r
         JOIN automations a ON a.id = r.automation_id
         JOIN LATERAL (
           SELECT q.id, q.job_id, q.action, q.created_at FROM approval_requests q
            WHERE q.status = 'pending'
              AND (q.job_id = r.job_id
                   OR q.job_id IN (SELECT n.job_id FROM workflow_job_links n WHERE n.run_id = r.workflow_run_id))
            ORDER BY q.created_at, q.id LIMIT 1) q ON true
        WHERE r.state = 'running' AND (r.reason IS NULL OR r.reason NOT LIKE $1)
        ORDER BY q.created_at LIMIT 200`,
      [`${APPROVAL_TIMEOUT_REASON}%`],
    );
    let notified = 0;
    let cancelled = 0;
    for (const w of rows) {
      if (w.waiting_at === null) {
        const first = await withTransaction(this.deps.pool, async (tx) => {
          const u = await tx.query(
            'UPDATE automation_runs SET approval_waiting_at = $2 WHERE id = $1 AND approval_waiting_at IS NULL',
            [w.run_id, now],
          );
          if ((u.rowCount ?? 0) === 0) return false; // another pass got it
          const payload: AutomationWaitingOutboxPayload = {
            automationId: w.automation_id,
            runId: w.run_id,
            approvalId: w.approval_id,
          };
          await tx.query(
            'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
            [OUTBOX_TOPIC_AUTOMATION_WAITING, JSON.stringify(payload), now],
          );
          return true;
        });
        if (first) notified++;
      }
      if (w.timeout === null || now.getTime() - w.since.getTime() < w.timeout * 60_000) continue;
      if (await this.#approvalTimeout(w.automation_id, w.run_id, w.approval_job_id, w.action, w.timeout)) {
        cancelled++;
      }
    }
    return { notified, cancelled };
  }

  /** Cancels the job waiting on an approval for longer than the automation allows. True when this pass did it. */
  async #approvalTimeout(
    automationId: string,
    runId: string,
    jobId: string,
    action: string,
    minutes: number,
  ): Promise<boolean> {
    const reason = `${APPROVAL_TIMEOUT_REASON} nobody approved ${action} within ${String(minutes)} minutes, so the job was cancelled. Choose “Refuse sensitive actions” or “Never ask” for unattended runs, or a longer approval timeout.`;
    const claimed = await this.deps.pool.query(
      `UPDATE automation_runs SET reason = $2
        WHERE id = $1 AND state = 'running' AND (reason IS NULL OR reason NOT LIKE $3)`,
      [runId, reason.slice(0, 1000), `${APPROVAL_TIMEOUT_REASON}%`],
    );
    if ((claimed.rowCount ?? 0) === 0) return false;
    const jobReason = `automation approval timeout: no decision within ${String(minutes)} minutes`;
    const wf = await this.deps.pool.query<{ workflow_run_id: string | null }>(
      'SELECT workflow_run_id FROM automation_runs WHERE id = $1',
      [runId],
    );
    const workflowRunId = wf.rows[0]?.workflow_run_id ?? null;
    const cancelWorkflow = workflowRunId === null ? undefined : this.deps.cancelWorkflow?.();
    let workflowCancelled = false;
    if (workflowRunId !== null && cancelWorkflow !== undefined) {
      // §18.3: the whole workflow run stops (every open node's job), not only the waiting job.
      try {
        await cancelWorkflow(workflowRunId, jobReason);
        workflowCancelled = true;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        // Already finished: the sync pass records the outcome.
        if (code !== 'run_finished' && code !== 'run_not_found') throw err;
      }
    }
    if (!workflowCancelled) {
      try {
        const { job } = await this.deps.jobs.transition(jobId, 'cancel_requested', {
          actor: SYSTEM,
          reason: jobReason,
        });
        if (job.state === 'CANCELLING') await this.deps.cancel?.().sendCancel(job, jobReason);
      } catch (err) {
        // Someone (a user, a quota, the job itself) already ended it; the sync pass records the outcome.
        if (!(err instanceof IllegalTransitionError) && !(err instanceof VersionConflictError)) throw err;
      }
    }
    const a = await this.#row(this.deps.pool, automationId);
    await this.deps.audit.record({
      actor: SYSTEM,
      action: 'automation.approval_timeout',
      target: `automation:${automationId}`,
      outcome: 'success',
      metadata: {
        project: a?.project ?? null,
        runId,
        jobId,
        action,
        minutes,
        ...(workflowRunId === null ? {} : { workflowRunId, workflowCancelled }),
      },
    });
    const payload: AutomationRunOutboxPayload = {
      automationId,
      runId,
      state: 'cancelled',
      stopped: false,
      approvalTimeoutMinutes: minutes,
    };
    await this.deps.pool.query(
      'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
      [OUTBOX_TOPIC_AUTOMATION_RUN, JSON.stringify(payload), this.deps.clock()],
    );
    return true;
  }

  /** After a run ended: last-run columns, failure notification, chained automations. */
  async #afterFinish(automationId: string, runId: string, stopped: boolean): Promise<void> {
    await this.#touchLast(this.deps.pool, automationId);
    const run = (await this.deps.pool.query<RunRow>('SELECT * FROM automation_runs WHERE id = $1', [runId]))
      .rows[0];
    const a = await this.#row(this.deps.pool, automationId);
    if (run === undefined || a === null) return;
    // p16-webhooks-out: the end of a run is audited (the automation.run.succeeded / failed webhook events).
    await this.deps.audit.record({
      actor: { type: 'system', id: 'automations' },
      action: 'automation.run.finish',
      target: `automation:${automationId}`,
      outcome: 'success',
      metadata: {
        project: a.project,
        runId,
        state: run.state,
        ...(run.job_id === null ? {} : { jobId: run.job_id }),
        ...(run.workflow_run_id === null ? {} : { workflowRunId: run.workflow_run_id }),
        ...(stopped ? { stopped: true } : {}),
      },
    });
    if ((run.state === 'failed' || run.state === 'error') && (a.notify_on_failure || stopped)) {
      const payload: AutomationRunOutboxPayload = {
        automationId,
        runId,
        state: run.state,
        stopped,
      };
      await this.deps.pool.query(
        'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
        [OUTBOX_TOPIC_AUTOMATION_RUN, JSON.stringify(payload), this.deps.clock()],
      );
    }
    const outcome = chainOutcomeOf(run.state);
    if (outcome === null) return;
    const { rows } = await this.deps.pool.query<Row>(
      `${SELECT_AUTOMATION} WHERE a.chain_source_id = $1 AND a.state = 'active'`,
      [automationId],
    );
    let queued = false;
    for (const next of rows) {
      const on = (next.trigger.on ?? []) as ChainOutcome[];
      if (!chainMatches(on, run.state)) continue;
      const created = await this.enqueue(this.deps.pool, next, {
        triggerKind: 'chain',
        dedupKey: `chain:${run.id}`,
        chainParentRunId: run.id,
        chainDepth: run.chain_depth + 1,
        // §18.4: run lists of another project do not name this project's automation.
        summary: {
          event: 'chain',
          source: next.project === a.project ? a.name : 'an automation of another project',
          outcome,
        },
        data: {
          event: 'chain',
          source: {
            automationId: a.id,
            automation: a.name,
            runId: run.id,
            outcome,
            state: run.state,
            reason: run.reason,
            jobId: run.job_id,
            workflowRunId: run.workflow_run_id,
          },
        },
        trust: run.source_trust,
      });
      if (created !== null) queued = true;
    }
    if (queued) this.kick();
  }
}

/**
 * p16-workflow-quality: the instant of a one-time trigger — an ISO time with an offset as given, a wall-clock time
 * without one read in `timeZone` (daylight saving: a skipped time moves forward by the gap, a repeated one is the
 * first occurrence).
 */
export function atInstant(at: string, timeZone: string): Date {
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(at)) return new Date(at);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  if (m === null) return new Date(Number.NaN);
  return zonedToUtc(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) },
    timeZone,
  );
}

/** `2026-10-24 09:00` on the wall clock of `timeZone`. */
function wallText(at: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const g = (t: string): string => f.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}
