import { PRIORITY_CLASS_VALUE, type PriorityClass, priorityClassOf } from '../../api/queue';
import { browserTimeZone, isTimeZone } from '../../lib/schedule';
import {
  type AutomationDetail,
  type ChainOutcome,
  DEFAULT_ACTIONS,
  type GitHubEvent,
  KNOWN_ACTIONS,
  type DeployAction,
  type Target,
  type Trigger,
  type TriggerKind,
} from '../../api/automations';
import { type PlacementPreview, type PreviewDraft, type ProjectGit } from '../../api/composer';
import {
  type DeployChoice,
  deployError,
  deployRequest,
  NO_DEPLOY,
  publishStateOf,
  type VerifyChoice,
} from '../composer/deploy';
import { EMPTY_FILES, type FilesState, filesFromDetail, filesTarget, validateFiles } from './files';

/**
 * p6-automations create / edit form (`/automations/new`, `/automations/:id/edit`): what starts it (schedule with a
 * cron builder, one time, GitHub event, signed webhook, after another automation), what it runs (a job or a
 * workflow) and its policies. Creating and changing need a fresh authenticator code; GitHub and webhook triggers
 * need a project admin. A webhook secret is shown once, right after it is created.
 */

export type TargetKind = 'job' | 'workflow' | 'deploy';

export interface FormState {
  project: string;
  name: string;
  description: string;
  kind: TriggerKind;
  cron: string;
  /** p16-workflow-quality: the zone a cron schedule is read in (IANA; default the browser's, else UTC). */
  timeZone: string;
  at: string;
  repository: string;
  event: GitHubEvent;
  /** p6-automations-next: further events of the same trigger. */
  additionalEvents: GitHubEvent[];
  actions: string[];
  branches: string;
  labels: string;
  command: string;
  allowUntrusted: boolean;
  checkout: 'base' | 'event';
  chainSource: string;
  chainOn: ChainOutcome[];
  /** p6-automations-next: webhook callers allowed (comma separated addresses / CIDRs; empty = any). */
  allowIps: string;
  target: TargetKind;
  runtime: string;
  prompt: string;
  sandboxProfile: string;
  /** p22-output-delivery: each run's job delivers its files to Outputs (repository projects; no merge approval). */
  delivery: 'merge' | 'outputs';
  approvalPolicy: string;
  /** p6-automation-defaults: cancel a run nobody approves (minutes; off = wait until the approval expires). */
  approvalTimeoutOn: boolean;
  approvalTimeoutMin: string;
  maxDurationMin: string;
  workflowId: string;
  /** p6-deploy-pipeline: the ops action of a deploy target. */
  deployAction: DeployAction;
  deployEnv: 'preview' | 'production';
  deployForce: boolean;
  concurrency: 'skip' | 'queue' | 'parallel';
  catchUp: 'skip' | 'once' | 'all';
  maxRunsPerHour: string;
  notifyOnFailure: boolean;
  /** p6-result-reuse (job targets): skip a run when an identical job succeeded recently (off by default). */
  reuseOn: boolean;
  reuseHours: string;
  enabled: boolean;
  /** p5-research-workspace-next: input files and continue-from (workspace projects). */
  files: FilesState;
  /** p6-deploy-on-success (job targets): deploy each run's job when it succeeds (off by default). */
  deploy: DeployChoice;
  /** p10-verify-health: '' = the project's default. */
  verify: VerifyChoice;
  /** p9-queue-priority (job and workflow targets): the runs' queue class (Normal by default). */
  priorityClass: PriorityClass;
}

export const EMPTY: FormState = {
  project: '',
  name: '',
  description: '',
  kind: 'cron',
  cron: '0 3 * * *',
  timeZone: browserTimeZone() ?? 'UTC',
  at: '',
  repository: '',
  event: 'pull_request',
  additionalEvents: [],
  actions: [...DEFAULT_ACTIONS.pull_request],
  branches: '',
  labels: '',
  command: '/remyral',
  allowUntrusted: false,
  checkout: 'base',
  chainSource: '',
  chainOn: ['succeeded'],
  allowIps: '',
  target: 'job',
  priorityClass: 'normal',
  runtime: 'claude-code',
  prompt: '',
  sandboxProfile: 'container',
  delivery: 'merge',
  approvalPolicy: 'ask-sensitive',
  approvalTimeoutOn: true,
  approvalTimeoutMin: '60',
  maxDurationMin: '60',
  workflowId: '',
  deployAction: 'coolify.deploy',
  deployEnv: 'preview',
  deployForce: false,
  concurrency: 'skip',
  catchUp: 'once',
  maxRunsPerHour: '30',
  notifyOnFailure: true,
  reuseOn: false,
  deploy: NO_DEPLOY,
  verify: '',
  reuseHours: '24',
  enabled: true,
  files: EMPTY_FILES,
};

export const KINDS: readonly TriggerKind[] = ['cron', 'at', 'github', 'webhook', 'chain'];

const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** `owner/name` from a GitHub repository URL, or ''. */
export function repoFromUrl(url: string): string {
  const m = /github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m === null ? '' : `${m[1] ?? ''}/${m[2] ?? ''}`;
}

function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDetail(a: AutomationDetail): FormState {
  const t = a.trigger;
  const spec = a.targetSpec.spec ?? {};
  const limits =
    typeof spec.limits === 'object' && spec.limits !== null ? (spec.limits as Record<string, unknown>) : {};
  return {
    ...EMPTY,
    project: a.project,
    name: a.name,
    description: a.description ?? '',
    kind: t.kind,
    ...(t.kind === 'cron' ? { cron: t.cron, timeZone: t.timeZone ?? a.timeZone } : {}),
    ...(t.kind === 'at' ? { at: localDateTime(t.at) } : {}),
    ...(t.kind === 'github'
      ? {
          repository: t.repository,
          event: t.event,
          additionalEvents: [...(t.additionalEvents ?? [])],
          actions: (() => {
            const evs = [t.event, ...(t.additionalEvents ?? [])].filter(
              (e): e is Exclude<GitHubEvent, 'push'> => e !== 'push',
            );
            return t.actions !== undefined
              ? [...t.actions]
              : [...new Set(evs.flatMap((e) => DEFAULT_ACTIONS[e]))];
          })(),
          branches: (t.branches ?? []).join(', '),
          labels: (t.labels ?? []).join(', '),
          command: t.command ?? '',
          allowUntrusted: t.allowUntrusted === true,
          checkout: t.checkout ?? 'base',
        }
      : {}),
    ...(t.kind === 'chain' ? { chainSource: t.automationId, chainOn: [...t.on] } : {}),
    allowIps: (a.webhook?.allowIps ?? []).join(', '),
    target: a.target.kind,
    priorityClass: priorityClassOf(a.targetSpec.priority),
    runtime: typeof spec.runtime === 'string' ? spec.runtime : EMPTY.runtime,
    prompt: typeof spec.prompt === 'string' ? spec.prompt : '',
    sandboxProfile: typeof spec.sandboxProfile === 'string' ? spec.sandboxProfile : 'container',
    approvalPolicy: typeof spec.approvalPolicy === 'string' ? spec.approvalPolicy : 'ask-sensitive',
    delivery: spec.delivery === 'outputs' ? 'outputs' : 'merge',
    maxDurationMin:
      typeof limits.maxDurationSec === 'number' ? String(Math.round(limits.maxDurationSec / 60)) : '60',
    approvalTimeoutOn: a.approvalTimeoutMinutes !== null,
    approvalTimeoutMin: a.approvalTimeoutMinutes === null ? '60' : String(a.approvalTimeoutMinutes),
    workflowId: a.target.workflowId ?? '',
    deployAction: a.target.deployAction?.kind === 'coolify.restart' ? 'coolify.restart' : 'coolify.deploy',
    deployEnv: a.target.deployAction?.params.env === 'production' ? 'production' : 'preview',
    deployForce: a.target.deployAction?.params.force === true,
    concurrency: a.concurrency === 'queue' || a.concurrency === 'parallel' ? a.concurrency : 'skip',
    catchUp: a.catchUp === 'skip' || a.catchUp === 'all' ? a.catchUp : 'once',
    maxRunsPerHour: String(a.maxRunsPerHour),
    notifyOnFailure: a.notifyOnFailure,
    reuseOn: a.reuseWithinHours !== null,
    reuseHours: a.reuseWithinHours === null ? '24' : String(a.reuseWithinHours),
    enabled: a.enabled,
    files: filesFromDetail(a.targetSpec.files, a.targetSpec.continueFrom),
    deploy:
      a.targetSpec.deployOnSuccess === null
        ? NO_DEPLOY
        : {
            enabled: true,
            target: a.targetSpec.deployOnSuccess.target,
            env: a.targetSpec.deployOnSuccess.env,
            directory: a.targetSpec.deployOnSuccess.directory ?? 'site',
            ...publishStateOf(a.targetSpec.deployOnSuccess.publish ?? null),
          },
    verify: a.targetSpec.verifyOnSuccess ?? '',
  };
}

/** Every GitHub event the form selects (`event` first). */
export function selectedEvents(f: Pick<FormState, 'event' | 'additionalEvents'>): GitHubEvent[] {
  return [...new Set([f.event, ...f.additionalEvents])];
}

/** The actions offered for the selected events (their union). */
export function actionChoices(f: Pick<FormState, 'event' | 'additionalEvents'>): string[] {
  return [
    ...new Set(
      selectedEvents(f)
        .filter((e): e is Exclude<GitHubEvent, 'push'> => e !== 'push')
        .flatMap((e) => KNOWN_ACTIONS[e]),
    ),
  ];
}

/** p6-automations-next: the webhook IP allow-list to send (null: any address). */
export function allowIpList(f: Pick<FormState, 'allowIps'>): string[] | null {
  const l = list(f.allowIps);
  return l.length === 0 ? null : l;
}

export function buildTrigger(f: FormState): Trigger {
  switch (f.kind) {
    case 'cron':
      return {
        kind: 'cron',
        cron: f.cron.trim(),
        ...(f.timeZone.trim() === '' || f.timeZone.trim() === 'UTC' ? {} : { timeZone: f.timeZone.trim() }),
      };
    case 'at':
      return { kind: 'at', at: new Date(f.at).toISOString() };
    case 'webhook':
      return { kind: 'webhook' };
    case 'chain':
      return { kind: 'chain', automationId: f.chainSource, on: f.chainOn };
    case 'github': {
      const branches = list(f.branches);
      const labels = list(f.labels);
      return {
        kind: 'github',
        repository: f.repository.trim(),
        event: f.event,
        ...(f.additionalEvents.length === 0 ? {} : { additionalEvents: f.additionalEvents }),
        ...(actionChoices(f).length === 0 ? {} : { actions: f.actions }),
        ...(branches.length === 0 ? {} : { branches }),
        ...(labels.length === 0 ? {} : { labels }),
        ...(selectedEvents(f).includes('issue_comment') && f.command.trim() !== ''
          ? { command: f.command.trim() }
          : {}),
        ...(f.allowUntrusted ? { allowUntrusted: true } : {}),
        ...(f.checkout === 'event' ? { checkout: 'event' as const } : {}),
      };
    }
  }
}

/** The job spec: the existing one (edit) with the form's fields, or a new one like the assistant's job drafts. */
export function buildTarget(
  f: FormState,
  git: ProjectGit | null,
  existing: Record<string, unknown> | null,
  workspace = false,
): Target {
  // p5-research-workspace-next: a workspace automation sends its full file set and continue-from rule.
  const files = workspace ? filesTarget(f.files) : {};
  const priority = PRIORITY_CLASS_VALUE[f.priorityClass];
  if (f.target === 'workflow') {
    return { kind: 'workflow', workflowId: f.workflowId, inputs: {}, priority, ...files };
  }
  if (f.target === 'deploy') {
    return {
      kind: 'deploy',
      action: f.deployAction,
      params: {
        env: f.deployEnv,
        ...(f.deployAction === 'coolify.deploy' && f.deployForce ? { force: true } : {}),
      },
    };
  }
  // p22-output-delivery: the form decides the delivery (an edit that switches it off drops the stored one).
  const { delivery: _delivery, ...base } = existing ?? {};
  const limits =
    typeof base.limits === 'object' && base.limits !== null ? (base.limits as Record<string, unknown>) : {};
  const repository =
    existing !== null
      ? base.repository
      : git === null
        ? undefined
        : {
            url: git.repositoryUrl,
            baseRef: git.baseBranch,
            workBranch: `agent/auto-${Math.random().toString(36).slice(2, 10)}`,
          };
  return {
    kind: 'job',
    spec: {
      ...base,
      projectId: f.project,
      runtime: f.runtime,
      prompt: f.prompt,
      sandboxProfile: f.sandboxProfile,
      approvalPolicy: f.approvalPolicy,
      sourceTrust: typeof base.sourceTrust === 'string' ? base.sourceTrust : 'trusted',
      limits: { ...limits, maxDurationSec: Math.max(1, Number(f.maxDurationMin) || 60) * 60 },
      ...(repository === undefined ? {} : { repository }),
      ...(repository !== undefined && f.delivery === 'outputs' ? { delivery: 'outputs' } : {}),
    },
    priority,
    // p6-deploy-on-success: sent when on; null when switched off (an untouched form leaves it out).
    ...(f.deploy.enabled
      ? { deployOnSuccess: deployRequest(f.deploy) ?? null }
      : f.deploy === NO_DEPLOY
        ? {}
        : { deployOnSuccess: null }),
    // p10-verify-health: always sent with the target (null: the project's default).
    verifyOnSuccess: f.verify === '' ? null : f.verify,
    ...files,
  };
}

export function validate(f: FormState, editing: boolean, workspace = false): Record<string, string> {
  const e: Record<string, string> = workspace
    ? validateFiles(f.files, { target: f.target === 'deploy' ? 'job' : f.target, trigger: f.kind })
    : {};
  if (!editing && f.project === '') e.project = 'Choose a project.';
  if (f.name.trim() === '') e.name = 'Give it a name.';
  if (f.kind === 'cron' && f.cron.trim().split(/\s+/).length !== 5)
    e.cron = 'Five fields: minute hour day month weekday.';
  if (f.kind === 'cron' && f.timeZone.trim() !== '' && !isTimeZone(f.timeZone.trim())) e.timeZone = 'zone';
  if (f.kind === 'at' && (f.at === '' || Number.isNaN(new Date(f.at).getTime())))
    e.at = 'Choose a date and time.';
  if (f.kind === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(f.repository.trim()))
    e.repository = 'owner/name, e.g. acme/app.';
  if (f.kind === 'github' && actionChoices(f).length > 0 && f.actions.length === 0)
    e.actions = 'Choose at least one.';
  if (f.kind === 'webhook' && list(f.allowIps).some((x) => !/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/.test(x)))
    e.allowIps = 'Addresses or CIDRs, e.g. 203.0.113.7, 198.51.100.0/24.';
  if (f.kind === 'chain' && f.chainSource === '') e.chainSource = 'Choose the automation it follows.';
  if (f.kind === 'chain' && f.chainOn.length === 0) e.chainOn = 'Choose at least one outcome.';
  if (f.target === 'job' && f.prompt.trim() === '') e.prompt = 'Say what the agent should do.';
  if (f.target === 'workflow' && f.workflowId === '') e.workflowId = 'Choose a workflow.';
  if (f.target === 'deploy' && f.kind === 'github' && f.checkout === 'event')
    e.deployAction = 'A deploy does not check anything out; use the default checkout.';
  const rate = Number(f.maxRunsPerHour);
  if (!Number.isInteger(rate) || rate < 1 || rate > 120) e.maxRunsPerHour = '1 to 120.';
  if (f.approvalTimeoutOn) {
    const t = Number(f.approvalTimeoutMin);
    if (!Number.isInteger(t) || t < 5 || t > 1440) e.approvalTimeoutMin = '5 to 1440 minutes.';
  }
  if (f.target === 'job') {
    const d = deployError(f.deploy);
    if (d !== null) e.deploy = d;
  }
  if (f.target === 'job' && f.reuseOn) {
    const h = Number(f.reuseHours);
    if (!Number.isInteger(h) || h < 1 || h > 168) e.reuseHours = '1 to 168 hours.';
  }
  return e;
}

/** p6-result-reuse: the reuse policy to send (null: off; only job targets have it). */
export function reusePolicy(f: Pick<FormState, 'target' | 'reuseOn' | 'reuseHours'>): number | null {
  return f.target === 'job' && f.reuseOn ? Number(f.reuseHours) : null;
}

/** The approval timeout to send (null: no timeout). */
export function approvalTimeout(
  f: Pick<FormState, 'approvalTimeoutOn' | 'approvalTimeoutMin'>,
): number | null {
  return f.approvalTimeoutOn ? Number(f.approvalTimeoutMin) : null;
}

/** What the placement preview needs for the form's job target (the composer's preview, no side effects). */
export function formPreviewDraft(f: FormState): PreviewDraft | null {
  if (f.target !== 'job' || f.project === '') return null;
  return {
    project: f.project,
    runtime: f.runtime,
    sandboxProfile: f.sandboxProfile,
    // The form's job runs the project's own repository or a workspace: trusted source, like the composer.
    sourceTrust: 'trusted',
    approvalPolicy: f.approvalPolicy,
  };
}

/** Why no machine can run the form's job (null: some machine can, or not known yet). */
export function placementProblem(preview: PlacementPreview | null, f: FormState): string | null {
  if (preview?.project !== f.project || preview.sandboxProfile !== f.sandboxProfile) return null;
  if (preview.issues.length > 0) return preview.issues.map((i) => i.message).join('; ');
  const p = preview.placement;
  if (p?.runtime !== f.runtime || p.verdict !== 'infeasible') return null;
  const reasons = p.summary.filter((r) => r.permanent).map((r) => r.message);
  return reasons.length > 0 ? reasons.slice(0, 3).join('; ') : 'no machine can run it';
}
