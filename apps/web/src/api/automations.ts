import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';
import type { DeployOnSuccessRequest } from './composer';

/**
 * p6-automations API (apps/master/src/automations/routes.ts, docs/design/p6-automations.md §12): automations with
 * their trigger (cron, one time, GitHub event, signed webhook, job chain), run history and the one-time webhook
 * secret. Event summaries and event data come from outside (GitHub, webhook callers): render as text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export type TriggerKind = 'cron' | 'at' | 'github' | 'webhook' | 'chain';
export type GitHubEvent =
  | 'pull_request'
  | 'push'
  | 'issues'
  | 'issue_comment'
  | 'pull_request_review'
  | 'release'
  | 'workflow_run'
  | 'check_suite';
export type ChainOutcome = 'succeeded' | 'failed' | 'cancelled';
export type RunState =
  'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'error';

export type Trigger =
  /** p16-workflow-quality: `timeZone` — the IANA zone the schedule is read in (absent: UTC). */
  | { readonly kind: 'cron'; readonly cron: string; readonly timeZone?: string }
  | { readonly kind: 'at'; readonly at: string; readonly timeZone?: string }
  | {
      readonly kind: 'github';
      readonly repository: string;
      readonly event: GitHubEvent;
      /** p6-automations-next: further events of the same trigger. */
      readonly additionalEvents?: readonly GitHubEvent[];
      readonly actions?: readonly string[];
      readonly branches?: readonly string[];
      readonly labels?: readonly string[];
      readonly command?: string;
      readonly allowUntrusted?: boolean;
      readonly checkout?: 'base' | 'event';
    }
  | { readonly kind: 'webhook' }
  | { readonly kind: 'chain'; readonly automationId: string; readonly on: readonly ChainOutcome[] };

/**
 * p5-research-workspace-next: an input file of an automation on a workspace project — a new upload, or a stored file
 * kept by id when editing. Omitted `files`: the stored ones stay.
 */
export type AutomationFile =
  { readonly name: string; readonly contentBase64: string } | { readonly inputId: string };

/** Whose artifacts become a run's inputs. */
export type ContinueFrom =
  | { readonly kind: 'job'; readonly jobId: string }
  | { readonly kind: 'last-run' }
  | { readonly kind: 'chain-source' };

interface TargetFiles {
  readonly files?: readonly AutomationFile[];
  readonly continueFrom?: ContinueFrom | null;
}

export type Target =
  | ({
      readonly kind: 'job';
      readonly spec: Readonly<Record<string, unknown>>;
      readonly priority?: number;
      /** p6-deploy-on-success (ADR-0030): deploy each run's job when it succeeds (null: off). */
      readonly deployOnSuccess?: DeployOnSuccessRequest | null;
      /** p10-verify-health: "Verify when done" of each run's job (null: the project's default). */
      readonly verifyOnSuccess?: 'off' | 'report' | 'gate' | null;
    } & TargetFiles)
  | ({
      readonly kind: 'workflow';
      readonly workflowId: string;
      readonly inputs: Readonly<Record<string, string>>;
      readonly repository?: { readonly url: string; readonly baseRef: string };
      /** p9-queue-priority: the queue priority of the run's step jobs. */
      readonly priority?: number;
    } & TargetFiles)
  /** p6-deploy-pipeline: request an ops action with fixed parameters (the master's deploy policy still applies). */
  | {
      readonly kind: 'deploy';
      readonly action: DeployAction;
      readonly params: { readonly env: 'preview' | 'production'; readonly force?: boolean };
    };

export interface StoredFile {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export type DeployAction = 'coolify.deploy' | 'coolify.restart';

/** "Deploy preview (Coolify)" / "Restart production (Coolify)". */
export function deployTargetText(d: {
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
}): string {
  const env = d.params.env === 'production' ? 'production' : 'preview';
  const verb = d.kind === 'coolify.restart' ? 'Restart' : 'Deploy';
  return `${verb} ${env} (Coolify)${d.kind !== 'coolify.restart' && d.params.force === true ? ', force rebuild' : ''}`;
}

export const GITHUB_EVENTS: readonly GitHubEvent[] = [
  'pull_request',
  'push',
  'issues',
  'issue_comment',
  'pull_request_review',
  'release',
  'workflow_run',
  'check_suite',
];
export const DEFAULT_ACTIONS: Readonly<Record<Exclude<GitHubEvent, 'push'>, readonly string[]>> = {
  pull_request: ['opened', 'synchronize', 'reopened'],
  issues: ['opened'],
  issue_comment: ['created'],
  pull_request_review: ['submitted'],
  release: ['published'],
  workflow_run: ['completed'],
  check_suite: ['completed'],
};
export const KNOWN_ACTIONS: Readonly<Record<Exclude<GitHubEvent, 'push'>, readonly string[]>> = {
  pull_request: [
    'opened',
    'synchronize',
    'reopened',
    'closed',
    'edited',
    'labeled',
    'unlabeled',
    'ready_for_review',
    'converted_to_draft',
    'assigned',
    'review_requested',
  ],
  issues: ['opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled', 'assigned'],
  issue_comment: ['created', 'edited'],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  release: ['published', 'created', 'released', 'prereleased', 'edited'],
  workflow_run: ['completed', 'requested', 'in_progress'],
  check_suite: ['completed', 'requested', 'rerequested'],
};

export interface AutomationInput {
  readonly project: string;
  readonly name: string;
  readonly description?: string;
  readonly trigger: Trigger;
  readonly target: Target;
  readonly enabled?: boolean;
  readonly concurrency?: 'skip' | 'queue' | 'parallel';
  readonly catchUp?: 'skip' | 'once' | 'all';
  readonly maxRunsPerHour?: number;
  readonly notifyOnFailure?: boolean;
  /** p6-automation-defaults: cancel a run nobody approves within this many minutes (null: no timeout). */
  readonly approvalTimeoutMinutes?: number | null;
  /** p6-result-reuse (job targets): skip a run when an identical job succeeded within this many hours (null: off). */
  readonly reuseWithinHours?: number | null;
  /** p6-automations-next: webhook kind — addresses / CIDRs allowed to call it (null: any). */
  readonly webhookAllowIps?: readonly string[] | null;
}

/** p6-automation-defaults: a run paused on a human approval (design §11a). */
export interface WaitingApproval {
  readonly approvalId: string;
  readonly action: string;
  readonly since: string;
  readonly cancelsAt: string | null;
}

export type AutomationPatch = Partial<Omit<AutomationInput, 'project' | 'enabled' | 'description'>> & {
  readonly description?: string | null;
};

export interface Automation {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: 'active' | 'paused' | 'done' | 'failed' | 'deleted';
  readonly enabled: boolean;
  readonly trigger: Trigger;
  readonly triggerSummary: string;
  /** p16-workflow-quality: the zone of a cron / at schedule (UTC unless the trigger names one). */
  readonly timeZone: string;
  readonly target: {
    readonly kind: 'job' | 'workflow' | 'deploy';
    /** p6-deploy-pipeline: the ops action of a deploy target (null otherwise). */
    readonly deployAction: {
      readonly kind: string;
      readonly params: Readonly<Record<string, unknown>>;
    } | null;
    readonly runtime: string | null;
    readonly workflowId: string | null;
    readonly title: string | null;
    readonly approvalPolicy: string | null;
    readonly sandboxProfile: string | null;
  };
  /** null: no approval timeout (older masters: null). */
  readonly approvalTimeoutMinutes: number | null;
  /** p6-result-reuse: null = off (older masters: null). */
  readonly reuseWithinHours: number | null;
  /** The oldest run waiting for a human approval now. */
  readonly waiting: (WaitingApproval & { readonly runId: string }) | null;
  readonly concurrency: string;
  readonly catchUp: string;
  readonly maxRunsPerHour: number;
  readonly notifyOnFailure: boolean;
  readonly nextRunAt: string | null;
  readonly lastRun: { readonly id: string; readonly state: RunState; readonly at: string } | null;
  readonly runCount: number;
  readonly successRate: number | null;
  readonly webhook: {
    readonly url: string;
    readonly secretHint: string;
    readonly rotatedAt: string;
    /** p6-automations-next: the previous secret, still accepted until `expiresAt` (older masters: null). */
    readonly previous: { readonly secretHint: string; readonly expiresAt: string } | null;
    readonly allowIps: readonly string[] | null;
  } | null;
  readonly runAs: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * p14-workflow-engine 14.2 (K2): the workflow trigger node this automation was created for ("Etkinleştir" on the
   * canvas); edits happen there (PATCH / DELETE answer 409 `automation_bound`). null: an ordinary automation.
   */
  readonly workflowBinding: {
    readonly workflowId: string;
    readonly project: string;
    readonly name: string;
    readonly triggerNode: string;
  } | null;
  /**
   * p18-multi-project W4: the automation group ("Projeler": the same automation in several projects), its live size
   * and whether this one diverged from the group's last "Tümüne uygula". null: not grouped (older masters: null).
   */
  readonly group: AutomationGroupRef | null;
}

export interface AutomationGroupRef {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly diverged: boolean;
}

/** The step of a failed workflow run (its error code and message), for the automation's "last failure". */
export interface AutomationFailedStep {
  readonly nodeId: string;
  readonly label: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

export interface AutomationDetail extends Automation {
  readonly targetSpec: {
    readonly spec: Record<string, unknown> | null;
    readonly priority: number;
    readonly workflowInputs: Record<string, string> | null;
    readonly workflowRepository: { readonly url: string; readonly baseRef: string } | null;
    /** p5-research-workspace-next: stored input files and the continue-from rule (workspace projects). */
    readonly files: readonly StoredFile[];
    readonly continueFrom: ContinueFrom | null;
    /** p6-deploy-on-success: the job target's "deploy when done" (null: off; older masters: null). */
    readonly deployOnSuccess: {
      readonly target: 'pages' | 'coolify';
      readonly env: 'preview' | 'production';
      readonly directory: string | null;
      readonly approvedAt: string;
      /** p10-publish-bundle: where the job's site is published (null: the Pages target, no domain). */
      readonly publish?: {
        readonly pagesProject: string | null;
        readonly createIfMissing: boolean;
        readonly domain: string | null;
        readonly dns: 'auto' | 'skip';
      } | null;
    } | null;
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
      readonly workflowRunId: string | null;
      readonly failedStep: AutomationFailedStep | null;
      readonly at: string;
    } | null;
  };
  /**
   * p6-automations-next: chains may cross projects; an automation of a project the reader cannot see is `hidden`
   * (no id, no name).
   */
  readonly chainSource: {
    readonly id: string | null;
    readonly name: string | null;
    readonly state: string | null;
    readonly project: string | null;
    readonly hidden: boolean;
  } | null;
  readonly chainedBy: readonly {
    readonly id: string | null;
    readonly name: string | null;
    readonly on: readonly string[];
    readonly project: string | null;
    readonly hidden: boolean;
  }[];
  readonly github: { readonly receiving: boolean; readonly hookUrl: string } | null;
}

export interface AutomationRun {
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
  readonly waitingApproval: WaitingApproval | null;
  /** p6-result-reuse: the run was skipped because this identical job had succeeded (older masters: null). */
  readonly reusedJobId: string | null;
}

export interface AutomationRunDetail extends AutomationRun {
  readonly payloadDigest: string | null;
  readonly eventData: Record<string, unknown> | null;
  readonly checkoutRef: string | null;
  /** p6-automations-next: an untrusted pull request checked out at its head SHA. */
  readonly checkoutPullRequest: { readonly number: number; readonly headSha: string } | null;
  /** The failed step of a failed workflow run (absent on older masters). */
  readonly failedStep: AutomationFailedStep | null;
}

export interface WebhookSecret {
  readonly url: string;
  readonly secret: string;
}

const RUN_STATES: readonly RunState[] = [
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'error',
];
const STATES = ['active', 'paused', 'done', 'failed', 'deleted'] as const;

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

function runState(v: unknown): RunState {
  if (typeof v !== 'string' || !(RUN_STATES as readonly string[]).includes(v))
    throw new ShapeError('run state');
  return v as RunState;
}

function nullableRecord(o: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  return obj(v);
}

/** Optional (absent on masters before p6-automation-defaults) nullable string. */
function optStr(o: Record<string, unknown>, key: string): string | null {
  return o[key] === undefined ? null : nullableStr(o, key);
}

export function parseWaiting(v: unknown): WaitingApproval | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    approvalId: str(o, 'approvalId'),
    action: str(o, 'action'),
    since: str(o, 'since'),
    cancelsAt: optStr(o, 'cancelsAt'),
  };
}

function optStrings(o: Record<string, unknown>, key: string): readonly string[] | undefined {
  return o[key] === undefined ? undefined : strArray(o, key);
}

export function parseTrigger(v: unknown): Trigger {
  const o = obj(v);
  const kind = str(o, 'kind');
  switch (kind) {
    case 'cron':
      return {
        kind,
        cron: str(o, 'cron'),
        ...(typeof o.timeZone === 'string' ? { timeZone: o.timeZone } : {}),
      };
    case 'at':
      return { kind, at: str(o, 'at'), ...(typeof o.timeZone === 'string' ? { timeZone: o.timeZone } : {}) };
    case 'webhook':
      return { kind };
    case 'chain':
      return {
        kind,
        automationId: str(o, 'automationId'),
        on: strArray(o, 'on').filter((x): x is ChainOutcome =>
          ['succeeded', 'failed', 'cancelled'].includes(x),
        ),
      };
    case 'github': {
      const event = str(o, 'event');
      if (!(GITHUB_EVENTS as readonly string[]).includes(event)) throw new ShapeError('event');
      const actions = optStrings(o, 'actions');
      const branches = optStrings(o, 'branches');
      const labels = optStrings(o, 'labels');
      const more = (optStrings(o, 'additionalEvents') ?? []).filter((e): e is GitHubEvent =>
        (GITHUB_EVENTS as readonly string[]).includes(e),
      );
      return {
        kind,
        repository: str(o, 'repository'),
        event: event as GitHubEvent,
        ...(more.length === 0 ? {} : { additionalEvents: more }),
        ...(actions === undefined ? {} : { actions }),
        ...(branches === undefined ? {} : { branches }),
        ...(labels === undefined ? {} : { labels }),
        ...(typeof o.command === 'string' ? { command: o.command } : {}),
        ...(typeof o.allowUntrusted === 'boolean' ? { allowUntrusted: o.allowUntrusted } : {}),
        ...(o.checkout === 'event' || o.checkout === 'base' ? { checkout: o.checkout } : {}),
      };
    }
    default:
      throw new ShapeError('trigger kind');
  }
}

export function parseAutomation(v: unknown): Automation {
  const o = obj(v);
  const t = obj(o.target);
  const state = str(o, 'state');
  if (!(STATES as readonly string[]).includes(state)) throw new ShapeError('state');
  const last = o.lastRun === null ? null : obj(o.lastRun);
  const hook = o.webhook === null ? null : obj(o.webhook);
  const rate = o.successRate;
  if (rate !== null && typeof rate !== 'number') throw new ShapeError('successRate');
  const kind = str(t, 'kind');
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    name: str(o, 'name'),
    description: nullableStr(o, 'description'),
    state: state as Automation['state'],
    enabled: bool(o, 'enabled'),
    trigger: parseTrigger(o.trigger),
    triggerSummary: str(o, 'triggerSummary'),
    timeZone: typeof o.timeZone === 'string' ? o.timeZone : 'UTC',
    target: {
      kind: kind === 'workflow' ? 'workflow' : kind === 'deploy' ? 'deploy' : 'job',
      deployAction:
        t.deployAction === null || t.deployAction === undefined
          ? null
          : { kind: str(obj(t.deployAction), 'kind'), params: obj(obj(t.deployAction).params) },
      runtime: nullableStr(t, 'runtime'),
      workflowId: nullableStr(t, 'workflowId'),
      title: nullableStr(t, 'title'),
      approvalPolicy: optStr(t, 'approvalPolicy'),
      sandboxProfile: optStr(t, 'sandboxProfile'),
    },
    approvalTimeoutMinutes: typeof o.approvalTimeoutMinutes === 'number' ? o.approvalTimeoutMinutes : null,
    reuseWithinHours: typeof o.reuseWithinHours === 'number' ? o.reuseWithinHours : null,
    waiting: (() => {
      const w = parseWaiting(o.waiting);
      return w === null ? null : { ...w, runId: str(obj(o.waiting), 'runId') };
    })(),
    concurrency: str(o, 'concurrency'),
    catchUp: str(o, 'catchUp'),
    maxRunsPerHour: int(o, 'maxRunsPerHour'),
    notifyOnFailure: bool(o, 'notifyOnFailure'),
    nextRunAt: nullableStr(o, 'nextRunAt'),
    lastRun: last === null ? null : { id: str(last, 'id'), state: runState(last.state), at: str(last, 'at') },
    runCount: int(o, 'runCount'),
    successRate: rate,
    webhook:
      hook === null
        ? null
        : {
            url: str(hook, 'url'),
            secretHint: str(hook, 'secretHint'),
            rotatedAt: str(hook, 'rotatedAt'),
            previous: (() => {
              const p = hook.previous === null || hook.previous === undefined ? null : obj(hook.previous);
              return p === null ? null : { secretHint: str(p, 'secretHint'), expiresAt: str(p, 'expiresAt') };
            })(),
            allowIps: Array.isArray(hook.allowIps) ? strArray(hook, 'allowIps') : null,
          },
    runAs: str(o, 'runAs'),
    createdBy: str(o, 'createdBy'),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
    workflowBinding: (() => {
      const b = o.workflowBinding;
      if (typeof b !== 'object' || b === null) return null;
      const r = b as Record<string, unknown>;
      if (typeof r.workflowId !== 'string' || typeof r.triggerNode !== 'string') return null;
      return {
        workflowId: r.workflowId,
        project: typeof r.project === 'string' ? r.project : '',
        name: typeof r.name === 'string' ? r.name : '',
        triggerNode: r.triggerNode,
      };
    })(),
    group: parseGroupRef(o.group),
  };
}

function parseGroupRef(v: unknown): AutomationGroupRef | null {
  if (typeof v !== 'object' || v === null) return null;
  const g = obj(v);
  return { id: str(g, 'id'), name: str(g, 'name'), size: int(g, 'size'), diverged: bool(g, 'diverged') };
}

export function parseContinueFrom(v: unknown): ContinueFrom | null {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'job' && typeof o.jobId === 'string') return { kind: 'job', jobId: o.jobId };
  if (o.kind === 'last-run') return { kind: 'last-run' };
  if (o.kind === 'chain-source') return { kind: 'chain-source' };
  return null;
}

function parseStoredDeploy(v: unknown): AutomationDetail['targetSpec']['deployOnSuccess'] {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  const d = obj(v);
  return {
    target: d.target === 'coolify' ? 'coolify' : 'pages',
    env: d.env === 'production' ? 'production' : 'preview',
    directory: typeof d.directory === 'string' ? d.directory : null,
    approvedAt: typeof d.approvedAt === 'string' ? d.approvedAt : '',
    publish: parsePublish(d.publish),
  };
}

/** p10-publish-bundle: the stored publish fields of a deploy on success (null: none). */
export function parsePublish(v: unknown): {
  readonly pagesProject: string | null;
  readonly createIfMissing: boolean;
  readonly domain: string | null;
  readonly dns: 'auto' | 'skip';
} | null {
  if (v === null || v === undefined || typeof v !== 'object') return null;
  const p = obj(v);
  return {
    pagesProject: typeof p.pagesProject === 'string' ? p.pagesProject : null,
    createIfMissing: p.createIfMissing === true,
    domain: typeof p.domain === 'string' ? p.domain : null,
    dns: p.dns === 'skip' ? 'skip' : 'auto',
  };
}

function parseFailedStep(v: unknown): AutomationFailedStep | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    nodeId: str(o, 'nodeId'),
    label: nullableStr(o, 'label'),
    code: nullableStr(o, 'code'),
    message: nullableStr(o, 'message'),
  };
}

export function parseAutomationDetail(v: unknown): AutomationDetail {
  const o = obj(v);
  const ts = obj(o.targetSpec);
  const st = obj(o.stats);
  const lf = st.lastFailure === null ? null : obj(st.lastFailure);
  const cs = o.chainSource === null ? null : obj(o.chainSource);
  const gh = o.github === null ? null : obj(o.github);
  const repo = ts.workflowRepository === null ? null : obj(ts.workflowRepository);
  const inputs = ts.workflowInputs === null ? null : obj(ts.workflowInputs);
  return {
    ...parseAutomation(o),
    targetSpec: {
      spec: nullableRecord(ts, 'spec'),
      priority: int(ts, 'priority'),
      workflowInputs:
        inputs === null
          ? null
          : Object.fromEntries(Object.entries(inputs).map(([k, x]) => [k, typeof x === 'string' ? x : ''])),
      workflowRepository: repo === null ? null : { url: str(repo, 'url'), baseRef: str(repo, 'baseRef') },
      files: Array.isArray(ts.files)
        ? ts.files.map((x) => {
            const f = obj(x);
            return {
              id: str(f, 'id'),
              name: str(f, 'name'),
              mediaType: str(f, 'mediaType'),
              sizeBytes: int(f, 'sizeBytes'),
            };
          })
        : [],
      continueFrom: parseContinueFrom(ts.continueFrom),
      deployOnSuccess: parseStoredDeploy(ts.deployOnSuccess),
      verifyOnSuccess:
        ts.verifyOnSuccess === 'off' || ts.verifyOnSuccess === 'report' || ts.verifyOnSuccess === 'gate'
          ? ts.verifyOnSuccess
          : null,
    },
    stats: {
      finished: int(st, 'finished'),
      succeeded: int(st, 'succeeded'),
      failed: int(st, 'failed'),
      skipped: int(st, 'skipped'),
      lastFailure:
        lf === null
          ? null
          : {
              runId: str(lf, 'runId'),
              state: runState(lf.state),
              reason: nullableStr(lf, 'reason'),
              jobId: nullableStr(lf, 'jobId'),
              workflowRunId: optStr(lf, 'workflowRunId'),
              failedStep: parseFailedStep(lf.failedStep),
              at: str(lf, 'at'),
            },
    },
    chainSource:
      cs === null
        ? null
        : {
            id: nullableStr(cs, 'id'),
            name: nullableStr(cs, 'name'),
            state: nullableStr(cs, 'state'),
            project: optStr(cs, 'project'),
            hidden: cs.hidden === true,
          },
    chainedBy: arr(o, 'chainedBy').map((x) => {
      const c = obj(x);
      return {
        id: nullableStr(c, 'id'),
        name: nullableStr(c, 'name'),
        on: strArray(c, 'on'),
        project: optStr(c, 'project'),
        hidden: c.hidden === true,
      };
    }),
    github: gh === null ? null : { receiving: bool(gh, 'receiving'), hookUrl: str(gh, 'hookUrl') },
  };
}

export function parseRun(v: unknown): AutomationRun {
  const o = obj(v);
  const trust = str(o, 'sourceTrust');
  return {
    id: str(o, 'id'),
    automationId: str(o, 'automationId'),
    project: str(o, 'project'),
    triggerKind: str(o, 'triggerKind'),
    state: runState(o.state),
    reason: nullableStr(o, 'reason'),
    sourceTrust: trust === 'untrusted' ? 'untrusted' : 'trusted',
    eventSummary: nullableRecord(o, 'eventSummary'),
    jobId: nullableStr(o, 'jobId'),
    jobState: nullableStr(o, 'jobState'),
    workflowRunId: nullableStr(o, 'workflowRunId'),
    scheduledFor: nullableStr(o, 'scheduledFor'),
    chainParentRunId: nullableStr(o, 'chainParentRunId'),
    chainDepth: int(o, 'chainDepth'),
    triggeredBy: nullableStr(o, 'triggeredBy'),
    createdAt: str(o, 'createdAt'),
    startedAt: nullableStr(o, 'startedAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
    waitingApproval: parseWaiting(o.waitingApproval),
    reusedJobId: typeof o.reusedJobId === 'string' ? o.reusedJobId : null,
  };
}

export function parseRunDetail(v: unknown): AutomationRunDetail {
  const o = obj(v);
  return {
    ...parseRun(o),
    payloadDigest: nullableStr(o, 'payloadDigest'),
    eventData: nullableRecord(o, 'eventData'),
    checkoutRef: nullableStr(o, 'checkoutRef'),
    failedStep: parseFailedStep(o.failedStep),
    checkoutPullRequest: (() => {
      const c =
        o.checkoutPullRequest === null || o.checkoutPullRequest === undefined
          ? null
          : obj(o.checkoutPullRequest);
      return c === null ? null : { number: int(c, 'number'), headSha: str(c, 'headSha') };
    })(),
  };
}

function parseWithSecret(v: unknown): { automation: AutomationDetail; webhook: WebhookSecret | null } {
  const o = obj(v);
  const w = o.webhook === null || o.webhook === undefined ? null : obj(o.webhook);
  return {
    automation: parseAutomationDetail(o.automation),
    webhook: w === null ? null : { url: str(w, 'url'), secret: str(w, 'secret') },
  };
}

const enc = encodeURIComponent;

export function listAutomations(
  filter: { project?: string; state?: string; kind?: TriggerKind; group?: string } = {},
  opts: Opts = {},
): Promise<Automation[]> {
  const q = new URLSearchParams();
  if (filter.project !== undefined) q.set('project', filter.project);
  if (filter.group !== undefined) q.set('group', filter.group);
  if (filter.state !== undefined) q.set('state', filter.state);
  if (filter.kind !== undefined) q.set('kind', filter.kind);
  const qs = q.toString();
  return apiRequest(
    'GET',
    `/automations${qs === '' ? '' : `?${qs}`}`,
    (v) => arr(obj(v), 'items').map(parseAutomation),
    opts,
  );
}

export function getAutomation(id: string, opts: Opts = {}): Promise<AutomationDetail> {
  return apiRequest('GET', `/automations/${enc(id)}`, parseAutomationDetail, opts);
}

export function automationCronPreview(
  cron: string,
  opts: Opts = {},
  /** p16-workflow-quality: the zone the expression is read in (absent: UTC). */
  timeZone?: string,
): Promise<{ cron: string; summary: string; nextRuns: string[] }> {
  return apiRequest(
    'GET',
    `/automations/cron-preview?cron=${enc(cron)}${timeZone === undefined || timeZone === 'UTC' ? '' : `&timeZone=${enc(timeZone)}`}`,
    (v) => {
      const o = obj(v);
      return { cron: str(o, 'cron'), summary: str(o, 'summary'), nextRuns: strArray(o, 'nextRuns') };
    },
    opts,
  );
}

export function createAutomation(
  body: AutomationInput,
  opts: Opts = {},
): Promise<{ automation: AutomationDetail; webhook: WebhookSecret | null }> {
  return apiRequest('POST', '/automations', parseWithSecret, { ...opts, body });
}

export function updateAutomation(
  id: string,
  body: AutomationPatch,
  opts: Opts = {},
): Promise<{ automation: AutomationDetail; webhook: WebhookSecret | null }> {
  return apiRequest('PATCH', `/automations/${enc(id)}`, parseWithSecret, { ...opts, body });
}

export function pauseAutomation(id: string, opts: Opts = {}): Promise<Automation> {
  return apiRequest('POST', `/automations/${enc(id)}/pause`, parseAutomation, { ...opts, body: {} });
}

export function resumeAutomation(id: string, opts: Opts = {}): Promise<Automation> {
  return apiRequest('POST', `/automations/${enc(id)}/resume`, parseAutomation, { ...opts, body: {} });
}

export function deleteAutomation(id: string, opts: Opts = {}): Promise<Automation> {
  return apiRequest('DELETE', `/automations/${enc(id)}`, parseAutomation, opts);
}

export function runAutomationNow(id: string, opts: Opts = {}): Promise<AutomationRunDetail> {
  return apiRequest('POST', `/automations/${enc(id)}/run`, parseRunDetail, { ...opts, body: {} });
}

/** Replaces the webhook secret; the previous one stays valid for `graceHours` (default 24, 0 = at once). */
export function rotateWebhookSecret(
  id: string,
  graceHours?: number,
  opts: Opts = {},
): Promise<{ automation: AutomationDetail; webhook: WebhookSecret | null }> {
  return apiRequest('POST', `/automations/${enc(id)}/webhook/rotate`, parseWithSecret, {
    ...opts,
    body: graceHours === undefined ? {} : { graceHours },
  });
}

/** p6-automations-next: ends the overlap window of a rotation now (only the current secret is accepted). */
export function endWebhookOverlap(id: string, opts: Opts = {}): Promise<Automation> {
  return apiRequest('DELETE', `/automations/${enc(id)}/webhook/previous`, parseAutomation, opts);
}

export function listAutomationRuns(
  id: string,
  filter: { limit?: number; before?: string } = {},
  opts: Opts = {},
): Promise<AutomationRun[]> {
  const q = new URLSearchParams();
  if (filter.limit !== undefined) q.set('limit', String(filter.limit));
  if (filter.before !== undefined) q.set('before', filter.before);
  const qs = q.toString();
  return apiRequest(
    'GET',
    `/automations/${enc(id)}/runs${qs === '' ? '' : `?${qs}`}`,
    (v) => arr(obj(v), 'items').map(parseRun),
    opts,
  );
}

/** p9-pagination: one keyset page of the run history, newest first. */
export function listAutomationRunsPage(
  id: string,
  page: { readonly cursor: string | null; readonly limit: number },
  opts: Opts = {},
): Promise<{ items: AutomationRun[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor !== null) q.set('cursor', page.cursor);
  return apiRequest(
    'GET',
    `/automations/${enc(id)}/runs?${q.toString()}`,
    (v) => {
      const o = obj(v);
      return {
        items: arr(o, 'items').map(parseRun),
        nextCursor: typeof o.nextCursor === 'string' ? o.nextCursor : null,
      };
    },
    opts,
  );
}

export function getAutomationRun(id: string, runId: string, opts: Opts = {}): Promise<AutomationRunDetail> {
  return apiRequest('GET', `/automations/${enc(id)}/runs/${enc(runId)}`, parseRunDetail, opts);
}

/** p6-automations: point the panel GitHub App's webhook at this master (owner/admin, always-fresh step-up). */
export function setUpGitHubWebhook(
  opts: Opts = {},
  /** p17-github-apps-ui: the connection whose App webhook is pointed here (absent: the first). */
  connectionId?: number,
): Promise<{ url: string; settingsUrl: string; events: string[] }> {
  return apiRequest(
    'POST',
    `/integrations/github/webhook${connectionId === undefined ? '' : `?connectionId=${String(connectionId)}`}`,
    (v) => {
      const o = obj(v);
      return { url: str(o, 'url'), settingsUrl: str(o, 'settingsUrl'), events: strArray(o, 'events') };
    },
    { ...opts, body: {} },
  );
}

/** "Every hour" … for the cron builder presets. */
export const CRON_PRESETS: readonly { readonly id: string; readonly label: string; readonly cron: string }[] =
  [
    { id: 'hourly', label: 'Every hour', cron: '0 * * * *' },
    { id: 'daily', label: 'Every day at 03:00', cron: '0 3 * * *' },
    { id: 'weekdays', label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
    { id: 'weekly', label: 'Mondays at 08:00', cron: '0 8 * * 1' },
  ];

/** Run state → chip tone / label (the StateChip mapping covers most; these are automation-specific). */
export const RUN_CHIP: Readonly<
  Record<string, { tone: 'signal' | 'attention' | 'danger' | 'ok' | 'neutral'; label: string }>
> = {
  skipped: { tone: 'neutral', label: 'Skipped' },
  error: { tone: 'danger', label: 'Could not start' },
  queued: { tone: 'neutral', label: 'Queued' },
};

/** The curl example for a signed webhook (bash + openssl). */
export function curlExample(url: string, secret = '$REMYRAL_WEBHOOK_SECRET'): string {
  return [
    // A literal secret in single quotes; the placeholder is an environment variable (expanded).
    secret.startsWith('$') ? `SECRET="${secret}"` : `SECRET='${secret}'`,
    `BODY='{"event":"deploy","ref":"main"}'`,
    'TS=$(date +%s)',
    'NONCE=$(openssl rand -hex 16)',
    'SIG=$(printf \'%s.%s.%s\' "$TS" "$NONCE" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed \'s/^.* //\')',
    `curl -sS -X POST '${url}' \\`,
    "  -H 'Content-Type: application/json' \\",
    '  -H "X-Remyral-Timestamp: $TS" \\',
    '  -H "X-Remyral-Nonce: $NONCE" \\',
    '  -H "X-Remyral-Signature: sha256=$SIG" \\',
    '  --data "$BODY"',
  ].join('\n');
}

// ------------------------------------------------------------------ p18-multi-project W4: automation groups

/** "Projeler": the same automation in several projects (one ordinary automation per project). */
export type AutomationGroupInput = Omit<AutomationInput, 'project'> & {
  readonly projects: readonly string[];
};

export interface GroupRefusal {
  readonly project: string;
  readonly code: string;
  readonly message: string;
}

export interface AutomationGroupCreated {
  readonly groupId: string;
  readonly created: readonly {
    readonly project: string;
    readonly automation: AutomationDetail;
    readonly webhook: WebhookSecret | null;
  }[];
  readonly refused: readonly GroupRefusal[];
}

export interface AutomationGroupMember {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly diverged: boolean;
  readonly triggerSummary: string;
  readonly nextRunAt: string | null;
  readonly canEdit: boolean;
}

export interface AutomationGroup {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly members: readonly AutomationGroupMember[];
  /** Siblings in projects the caller cannot read (a count). */
  readonly hidden: number;
}

export interface AutomationGroupApplied {
  readonly group: AutomationGroup;
  readonly applied: readonly {
    readonly id: string;
    readonly project: string;
    readonly webhook: WebhookSecret | null;
  }[];
  readonly skipped: readonly {
    readonly id: string;
    readonly project: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly hiddenSkipped: number;
}

function parseRefusal(v: unknown): GroupRefusal {
  const o = obj(v);
  return { project: str(o, 'project'), code: str(o, 'code'), message: str(o, 'message') };
}

function parseSecret(v: unknown): WebhookSecret | null {
  if (v === null || v === undefined) return null;
  const w = obj(v);
  return { url: str(w, 'url'), secret: str(w, 'secret') };
}

export function parseAutomationGroup(v: unknown): AutomationGroup {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    createdBy: str(o, 'createdBy'),
    createdAt: str(o, 'createdAt'),
    updatedAt: nullableStr(o, 'updatedAt'),
    members: arr(o, 'members').map((m) => {
      const r = obj(m);
      return {
        id: str(r, 'id'),
        project: str(r, 'project'),
        name: str(r, 'name'),
        state: str(r, 'state'),
        enabled: bool(r, 'enabled'),
        diverged: bool(r, 'diverged'),
        triggerSummary: str(r, 'triggerSummary'),
        nextRunAt: nullableStr(r, 'nextRunAt'),
        canEdit: bool(r, 'canEdit'),
      };
    }),
    hidden: int(o, 'hidden'),
  };
}

export function createAutomationGroup(
  body: AutomationGroupInput,
  opts: Opts = {},
): Promise<AutomationGroupCreated> {
  return apiRequest(
    'POST',
    '/automation-groups',
    (v) => {
      const o = obj(v);
      return {
        groupId: str(o, 'groupId'),
        created: arr(o, 'created').map((c) => {
          const r = obj(c);
          return {
            project: str(r, 'project'),
            automation: parseAutomationDetail(r.automation),
            webhook: parseSecret(r.webhook),
          };
        }),
        refused: arr(o, 'refused').map(parseRefusal),
      };
    },
    { ...opts, body },
  );
}

export function getAutomationGroup(id: string, opts: Opts = {}): Promise<AutomationGroup> {
  return apiRequest('GET', `/automation-groups/${enc(id)}`, parseAutomationGroup, opts);
}

/** "Tümüne uygula": the same change on every sibling the caller may change; the others are marked diverged. */
export function applyAutomationGroup(
  id: string,
  patch: AutomationPatch,
  opts: Opts = {},
): Promise<AutomationGroupApplied> {
  return apiRequest(
    'PATCH',
    `/automation-groups/${enc(id)}`,
    (v) => {
      const o = obj(v);
      return {
        group: parseAutomationGroup(o.group),
        applied: arr(o, 'applied').map((a) => {
          const r = obj(a);
          return { id: str(r, 'id'), project: str(r, 'project'), webhook: parseSecret(r.webhook) };
        }),
        skipped: arr(o, 'skipped').map((k) => {
          const r = obj(k);
          return {
            id: str(r, 'id'),
            project: str(r, 'project'),
            code: str(r, 'code'),
            message: str(r, 'message'),
          };
        }),
        hiddenSkipped: int(o, 'hiddenSkipped'),
      };
    },
    { ...opts, body: { patch } },
  );
}

// ------------------------------------------------------------------ p18-leftovers: grow a group, whole-group actions

/** "Projeye ekle": a sibling's automation in more projects (each checked there; refused ones listed). */
export interface AutomationGroupAdded {
  readonly group: AutomationGroup;
  readonly created: AutomationGroupCreated['created'];
  readonly refused: readonly GroupRefusal[];
}

export function addAutomationGroupProjects(
  id: string,
  body: { readonly projects: readonly string[]; readonly from?: string },
  opts: Opts = {},
): Promise<AutomationGroupAdded> {
  return apiRequest(
    'POST',
    `/automation-groups/${enc(id)}/projects`,
    (v) => {
      const o = obj(v);
      return {
        group: parseAutomationGroup(o.group),
        created: arr(o, 'created').map((c) => {
          const r = obj(c);
          return {
            project: str(r, 'project'),
            automation: parseAutomationDetail(r.automation),
            webhook: parseSecret(r.webhook),
          };
        }),
        refused: arr(o, 'refused').map(parseRefusal),
      };
    },
    { ...opts, body },
  );
}

export type AutomationGroupAction = 'pause' | 'resume' | 'delete';

/** The whole group in one action: what changed, what was already so, what was refused (and why), hidden count. */
export interface AutomationGroupLifecycle {
  readonly group: AutomationGroup | null;
  readonly done: readonly { readonly id: string; readonly project: string; readonly state: string }[];
  readonly unchanged: readonly { readonly id: string; readonly project: string; readonly state: string }[];
  readonly skipped: readonly {
    readonly id: string;
    readonly project: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly hiddenSkipped: number;
}

export function parseGroupLifecycle(v: unknown): AutomationGroupLifecycle {
  const o = obj(v);
  const row = (x: unknown) => {
    const r = obj(x);
    return { id: str(r, 'id'), project: str(r, 'project'), state: str(r, 'state') };
  };
  return {
    group: o.group === null || o.group === undefined ? null : parseAutomationGroup(o.group),
    done: arr(o, 'done').map(row),
    unchanged: arr(o, 'unchanged').map(row),
    skipped: arr(o, 'skipped').map((k) => {
      const r = obj(k);
      return {
        id: str(r, 'id'),
        project: str(r, 'project'),
        code: str(r, 'code'),
        message: str(r, 'message'),
      };
    }),
    hiddenSkipped: int(o, 'hiddenSkipped'),
  };
}

export function automationGroupAction(
  id: string,
  action: AutomationGroupAction,
  opts: Opts = {},
): Promise<AutomationGroupLifecycle> {
  return action === 'delete'
    ? apiRequest('DELETE', `/automation-groups/${enc(id)}`, parseGroupLifecycle, opts)
    : apiRequest('POST', `/automation-groups/${enc(id)}/${action}`, parseGroupLifecycle, {
        ...opts,
        body: {},
      });
}
