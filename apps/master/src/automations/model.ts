import { z } from 'zod';
import { DeployOnSuccessRequest } from '../ops/model.js';
import { Repository } from '../workflows/definition.js';
import { GitHubTrigger } from './github-events.js';
import { CHAIN_OUTCOMES, CONCURRENCY, type RunState } from './policy.js';

/**
 * Automation inputs and views (docs/design/p6-automations.md §2, §12). Inputs are strict: unknown fields are refused.
 */

export class AutomationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

export const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TRIGGER_KINDS = ['cron', 'at', 'github', 'webhook', 'chain'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const EXTERNAL_KINDS: ReadonlySet<TriggerKind> = new Set(['github', 'webhook']);
export const CATCH_UP = ['skip', 'once', 'all'] as const;
export const AUTOMATION_STATES = ['active', 'paused', 'done', 'failed', 'deleted'] as const;
export type AutomationState = (typeof AUTOMATION_STATES)[number];

/**
 * p16-workflow-quality: the IANA zone a schedule is read in (`Europe/Istanbul`; absent = UTC). The shape is checked
 * here, the zone itself against the runtime's tz database (`Intl`) when the automation is validated.
 */
export const TimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/);
export const CronTrigger = z.strictObject({
  kind: z.literal('cron'),
  cron: z.string().min(9).max(120),
  timeZone: TimeZoneName.optional(),
});
/**
 * A one-time run: an ISO date-time with an offset, or (p16-workflow-quality) a wall-clock time without one read in
 * `timeZone` ("2026-10-24T09:00" + Europe/Istanbul).
 */
export const AtTrigger = z.strictObject({
  kind: z.literal('at'),
  at: z.union([z.iso.datetime({ offset: true }), z.iso.datetime({ local: true })]),
  timeZone: TimeZoneName.optional(),
});
export const WebhookTrigger = z.strictObject({ kind: z.literal('webhook') });
export const ChainTrigger = z
  .strictObject({
    kind: z.literal('chain'),
    /** Another automation's runs … */
    automationId: z.string().regex(UUID).optional(),
    /**
     * … or (p14-workflow-engine 14.2, `trigger.workflow`) a workflow's runs — any start, by name (project default:
     * this automation's). Exactly one of the two.
     */
    workflow: z
      .strictObject({
        project: z.string().regex(PROJECT).optional(),
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      })
      .optional(),
    on: z.array(z.enum(CHAIN_OUTCOMES)).min(1).max(3),
  })
  .refine((t) => (t.automationId === undefined) !== (t.workflow === undefined), {
    message: 'exactly one of automationId and workflow',
    path: ['automationId'],
  });

export const AutomationTrigger = z.discriminatedUnion('kind', [
  CronTrigger,
  AtTrigger,
  GitHubTrigger,
  WebhookTrigger,
  ChainTrigger,
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/**
 * p5-research-workspace-next: an input file of an automation on a workspace project — a new upload, or a stored file
 * kept by id (updates). Every run's job (or workflow run) gets a fresh copy.
 */
export const AutomationFile = z.union([
  z.strictObject({ name: z.string().min(1).max(100), contentBase64: z.string().max(8 * 1024 * 1024) }),
  z.strictObject({ inputId: z.string().regex(/^in-[a-z0-9]{1,32}$/) }),
]);
export type AutomationFile = z.infer<typeof AutomationFile>;

/**
 * p5-research-workspace-next: whose artifacts become a run's inputs — a fixed job, this automation's last succeeded
 * run (job targets), or the run of the chained source automation that triggered this one (chain triggers).
 */
export const ContinueFrom = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('job'), jobId: z.string().regex(UUID) }),
  z.strictObject({ kind: z.literal('last-run') }),
  z.strictObject({ kind: z.literal('chain-source') }),
]);
export type ContinueFrom = z.infer<typeof ContinueFrom>;

const WorkspaceInputs = {
  /** Omitted on update: the stored files stay; [] removes them. */
  files: z.array(AutomationFile).max(10).optional(),
  continueFrom: ContinueFrom.nullable().optional(),
};

export const AutomationTarget = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('job'),
    spec: z.record(z.string(), z.unknown()),
    priority: z.number().int().min(-100).max(100).optional(),
    ...WorkspaceInputs,
    /**
     * p6-deploy-on-success (ADR-0030): deploy each run's job when it succeeds (saving is the approval, with the
     * same checks and step-up as creating such a job; each run re-checks the run-as user). null on update: off.
     */
    deployOnSuccess: DeployOnSuccessRequest.nullable().optional(),
    /**
     * p8-outputs-folders: an own folder each run's job files its outputs into (a project folder of this project or a
     * personal folder of the saving user; re-checked for the run-as user when linking). null on update: off.
     */
    outputFolderId: z.uuid().nullable().optional(),
    /**
     * p10-verify-health: "Verify when done" of each run's job — off, report or gate; null / absent: the project's
     * default.
     */
    verifyOnSuccess: z.enum(['off', 'report', 'gate']).nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal('workflow'),
    workflowId: z.string().regex(UUID),
    inputs: z.record(z.string(), z.string().max(64 * 1024)).default({}),
    repository: Repository.optional(),
    /** p9-queue-priority: the queue priority of the run's step jobs (class value or advanced number). */
    priority: z.number().int().min(-100).max(100).optional(),
    ...WorkspaceInputs,
  }),
  /**
   * p6-deploy-pipeline (ADR-0028): request an ops action with fixed parameters (e.g. push to main → preview deploy).
   * The master's deploy policy still decides (production waits for an approval); event content never reaches the
   * parameters; runs from untrusted sources are refused.
   */
  z.strictObject({
    kind: z.literal('deploy'),
    action: z.enum(['coolify.deploy', 'coolify.restart']),
    params: z.record(z.string(), z.unknown()),
  }),
]);
export type AutomationTarget = z.infer<typeof AutomationTarget>;

const Policies = {
  concurrency: z.enum(CONCURRENCY).optional(),
  catchUp: z.enum(CATCH_UP).optional(),
  maxRunsPerHour: z.number().int().min(1).max(120).optional(),
  notifyOnFailure: z.boolean().optional(),
  /**
   * p6-automation-defaults: minutes a run may wait for a human approval before its job is cancelled; null = no
   * timeout (the run waits until the approval itself expires). Default 60.
   */
  approvalTimeoutMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  /**
   * p6-automations-next (§18.5, webhook kind): client addresses / CIDRs allowed to call the webhook (null = any).
   * Parsed and checked by the service (IPv4 / IPv6).
   */
  webhookAllowIps: z.array(z.string().trim().min(2).max(64)).min(1).max(20).nullable().optional(),
  /**
   * p6-result-reuse (job targets): skip a run when an identical job of this project succeeded within this many hours
   * (same runtime, model profile, normalised prompt, repository base commit / input files). The run is recorded as
   * skipped with a link to that job. null / absent = off (the default). Runs from untrusted sources, GitHub / webhook /
   * chain runs (their event is input) and "Run now" always run.
   */
  reuseWithinHours: z.number().int().min(1).max(168).nullable().optional(),
};

/** p6-automation-defaults: an automation run paused on a human approval (design §11a). */
export interface WaitingApprovalView {
  readonly approvalId: string;
  /** Catalog action (e.g. `runtime.dangerous_tool`), never the runtime's summary text. */
  readonly action: string;
  readonly since: string;
  /** When the run is cancelled if nobody decides (null: no approval timeout). */
  readonly cancelsAt: string | null;
}

export const AutomationInput = z.strictObject({
  project: z.string().regex(PROJECT),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  trigger: AutomationTrigger,
  target: AutomationTarget,
  /** false: created paused. */
  enabled: z.boolean().optional(),
  ...Policies,
});
export type AutomationInput = z.infer<typeof AutomationInput>;

export const AutomationPatch = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  trigger: AutomationTrigger.optional(),
  target: AutomationTarget.optional(),
  ...Policies,
});
export type AutomationPatch = z.infer<typeof AutomationPatch>;

export interface LastRunView {
  readonly id: string;
  readonly state: RunState;
  readonly at: string;
}

export interface AutomationView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: AutomationState;
  readonly enabled: boolean;
  readonly trigger: AutomationTrigger;
  readonly triggerSummary: string;
  /** p16-workflow-quality: the zone of a cron / at schedule (UTC unless the trigger names one). */
  readonly timeZone: string;
  readonly target: {
    readonly kind: 'job' | 'workflow' | 'deploy';
    /** p6-deploy-pipeline: the ops action a deploy target requests (null otherwise). */
    readonly deployAction: { readonly kind: string; readonly params: Record<string, unknown> } | null;
    readonly runtime: string | null;
    readonly workflowId: string | null;
    /** First line of the job prompt (≤ 200 characters). */
    readonly title: string | null;
    /** p6-automation-defaults: the job template's approval policy (null for workflows). */
    readonly approvalPolicy: string | null;
    readonly sandboxProfile: string | null;
  };
  readonly approvalTimeoutMinutes: number | null;
  /** p6-result-reuse: the "skip if an identical successful run exists within N hours" policy (null = off). */
  readonly reuseWithinHours: number | null;
  /** p6-automation-defaults: the oldest run of this automation waiting for a human approval now. */
  readonly waiting: (WaitingApprovalView & { readonly runId: string }) | null;
  readonly concurrency: string;
  readonly catchUp: string;
  readonly maxRunsPerHour: number;
  readonly notifyOnFailure: boolean;
  readonly nextRunAt: string | null;
  readonly lastRun: LastRunView | null;
  readonly runCount: number;
  /** Succeeded / finished over the last 20 finished runs (0–1), null before the first finished run. */
  readonly successRate: number | null;
  readonly webhook: {
    readonly url: string;
    readonly secretHint: string;
    readonly rotatedAt: string;
    /** p6-automations-next (§18.1): the previous secret, still accepted until `expiresAt`. */
    readonly previous: { readonly secretHint: string; readonly expiresAt: string } | null;
    /** §18.5: allowed client addresses / CIDRs (null = any). */
    readonly allowIps: string[] | null;
  } | null;
  readonly runAs: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * p14-workflow-engine 14.2 (K2): the workflow trigger node this automation was created for ("Etkinleştir" on the
   * canvas). Such an automation is changed on the canvas: PATCH / DELETE answer 409 `automation_bound`.
   */
  readonly workflowBinding: {
    readonly workflowId: string;
    readonly project: string;
    readonly name: string;
    readonly triggerNode: string;
  } | null;
  /**
   * p18-multi-project W4: the automation group this automation belongs to ("Projeler" in the form: one automation per
   * project), its size (live siblings) and whether this one diverged from the group's last "Tümüne uygula".
   */
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly diverged: boolean;
  } | null;
}

export interface AutomationDetail extends AutomationView {
  readonly targetSpec: {
    readonly spec: Record<string, unknown> | null;
    readonly priority: number;
    readonly workflowInputs: Record<string, string> | null;
    readonly workflowRepository: { url: string; baseRef: string } | null;
    /** p5-research-workspace-next: stored input files (metadata) and the continue-from rule. */
    readonly files: { id: string; name: string; mediaType: string; sizeBytes: number }[];
    readonly continueFrom: ContinueFrom | null;
    /** p6-deploy-on-success: the job target's "deploy when done" (null: off). */
    readonly deployOnSuccess: {
      readonly target: 'pages' | 'coolify';
      readonly env: 'preview' | 'production';
      readonly directory: string | null;
      readonly approvedAt: string;
      /** p10-publish-bundle: publish as a bundle (Pages project, domain, DNS); null: a plain deploy. */
      readonly publish: {
        readonly pagesProject: string | null;
        readonly createIfMissing: boolean;
        readonly domain: string | null;
        readonly dns: 'auto' | 'skip';
      } | null;
    } | null;
    /** p8-outputs-folders: the job target's output folder (null: none). */
    readonly outputFolderId: string | null;
    /** p10-verify-health: the job target's "Verify when done" (null: the project's default). */
    readonly verifyOnSuccess: 'off' | 'report' | 'gate' | null;
  };
  readonly stats: {
    readonly finished: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
    readonly lastFailure: {
      readonly runId: string;
      readonly state: RunState;
      readonly reason: string | null;
      readonly jobId: string | null;
      /** The workflow run of a workflow-target automation (the screen links it). */
      readonly workflowRunId: string | null;
      /** The step of that workflow run that failed (its error code and message), when one is recorded. */
      readonly failedStep: {
        readonly nodeId: string;
        readonly label: string | null;
        readonly code: string | null;
        readonly message: string | null;
      } | null;
      readonly at: string;
    } | null;
  };
  /**
   * p6-automations-next (§18.4): the source may live in another project; a reader who cannot read that project
   * gets `hidden: true` with no id and name.
   */
  readonly chainSource:
    | {
        readonly id: string;
        readonly name: string;
        readonly state: string;
        readonly project: string;
        readonly hidden: false;
      }
    | {
        readonly id: null;
        readonly name: null;
        readonly state: null;
        readonly project: null;
        readonly hidden: true;
      }
    | null;
  readonly chainedBy: {
    id: string | null;
    name: string | null;
    on: string[];
    project: string | null;
    hidden: boolean;
  }[];
  /** GitHub kind: whether deliveries can arrive at all (panel App connected and its webhook secret known). */
  readonly github: { readonly receiving: boolean; readonly hookUrl: string } | null;
}

export interface RunView {
  readonly id: string;
  readonly automationId: string;
  readonly project: string;
  readonly triggerKind: string;
  readonly state: RunState;
  readonly reason: string | null;
  readonly sourceTrust: 'trusted' | 'untrusted';
  readonly eventSummary: Record<string, unknown> | null;
  readonly jobId: string | null;
  readonly jobState: string | null;
  readonly workflowRunId: string | null;
  readonly scheduledFor: string | null;
  readonly chainParentRunId: string | null;
  readonly chainDepth: number;
  readonly triggeredBy: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** p6-automation-defaults: the run is paused on a human approval now. */
  readonly waitingApproval: WaitingApprovalView | null;
  /** p6-result-reuse: the run was skipped because this identical job had succeeded (reuse policy). */
  readonly reusedJobId: string | null;
}

export interface RunDetail extends RunView {
  readonly payloadDigest: string | null;
  readonly eventData: Record<string, unknown> | null;
  readonly checkoutRef: string | null;
  /** p6-automations-next (§18.2): an untrusted pull request checked out at the event's head SHA. */
  readonly checkoutPullRequest: { readonly number: number; readonly headSha: string } | null;
  /** The failed step of a failed workflow run (null otherwise). */
  readonly failedStep: {
    readonly nodeId: string;
    readonly label: string | null;
    readonly code: string | null;
    readonly message: string | null;
  } | null;
}
