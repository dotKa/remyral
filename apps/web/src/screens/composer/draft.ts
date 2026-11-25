import type { JobLimitDefaults, PreviewDraft, ScheduleWhen } from '../../api/composer';
import type { ComposerZip, ReusedBundle } from './zip-input';
import { type InputFile, inputListError, UUID } from './inputs';

/**
 * The composer's draft and its validation (docs/design/p5-composer.md §2). `buildSpec` produces exactly the
 * protocol `JobSpec` (packages/protocol/src/master-messages.ts); the checks mirror its schema so the user
 * sees field errors before submitting, and the master validates again (authoritative). A contract test
 * parses the built spec with the real protocol schema.
 */

/** The runtimes a new job can use (ADR-0023: OpenHands was removed). */
export const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export const SANDBOX_PROFILES = ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'] as const;
export const APPROVAL_POLICIES = ['ask-sensitive', 'ask-all', 'deny-sensitive', 'allow-all'] as const;
/** p5-full-access (ADR-0020): the composer's one-switch "Full access". */
export const FULL_ACCESS = {
  sandboxProfile: 'unconfined',
  approvalPolicy: 'allow-all',
  sourceTrust: 'trusted',
} as const;

export function isFullAccess(d: Pick<Draft, 'sandboxProfile' | 'approvalPolicy'>): boolean {
  return d.sandboxProfile === FULL_ACCESS.sandboxProfile && d.approvalPolicy === FULL_ACCESS.approvalPolicy;
}

/**
 * The confined profile a trusted job should default to: the best host profile some worker has ready when the
 * project opted in to host execution (host-restricted, then runtime-sandbox), else container. `unconfined` is
 * never a default — only the explicit Full access toggle selects it.
 */
export function bestHostProfile(p: {
  readonly hostExecution: boolean;
  readonly sandbox: readonly { readonly profile: string; readonly workers: readonly string[] }[];
}): string {
  if (!p.hostExecution) return 'container';
  for (const profile of ['host-restricted', 'runtime-sandbox']) {
    if ((p.sandbox.find((s) => s.profile === profile)?.workers.length ?? 0) > 0) return profile;
  }
  return 'container';
}

/** Canonical form of a repository URL for comparison: scheme and host lowercased, no trailing `/` or `.git`. */
function canonicalRepo(url: string): string {
  const t = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]+)(.*)$/i.exec(t);
  return m === null ? t : `${(m[1] ?? '').toLowerCase()}${(m[2] ?? '').toLowerCase()}${m[3] ?? ''}`;
}

/**
 * p5-live-fixes-2: the job's repository is the project's registered one (Projects → Git). Its source is the
 * owner's own code, so the composer defaults it to trusted; any other repository stays untrusted.
 */
export function sameRepository(a: string, b: string): boolean {
  return a.trim() !== '' && canonicalRepo(a) === canonicalRepo(b);
}
export const OS_FAMILIES = ['linux', 'darwin', 'win32'] as const;
export const ARCHS = ['x64', 'arm64'] as const;

export type Mode = 'job' | 'workflow';
export type WhenKind = 'now' | 'at' | 'cron';

export interface Draft {
  mode: Mode;
  project: string;
  // Source.
  repoUrl: string;
  baseRef: string;
  workBranch: string;
  sourceTrust: 'trusted' | 'untrusted';
  // Workspace projects (p5-research-workspace): uploaded files and an optional job to continue from.
  inputFiles: InputFile[];
  continueFrom: string;
  /** p16-zip-job-input: a .zip whose files the job gets in in/ (workspace and repository projects; null: none). */
  inputZip: ComposerZip | null;
  /** p16-zip-job-input: "Run again" — the earlier job's input bundle, reused while it is kept (null: none). */
  inputBundleReuse: ReusedBundle | null;
  // Runtime.
  /** p6-smart-routing: the job kind (JobSpec.role); '' = from the prompt (the master's heuristic). */
  role: string;
  runtime: string;
  runtimeVersion: string;
  model: string;
  /** p6-quota-scheduling: runtimes to use, in order, when `runtime` is paused or not ready. */
  fallbacks: string[];
  /** p6-quota-scheduling: wait for the project's off-peak window. */
  deferrable: boolean;
  /**
   * p22-output-delivery (repository projects): `outputs` = the job produces files — they are delivered to Outputs and
   * the job succeeds without a merge approval; `merge` (default) = the protected merge, as before.
   */
  delivery: 'merge' | 'outputs';
  // Placement.
  sandboxProfile: string;
  os: string[];
  arch: string[];
  tools: string;
  workers: string[];
  // Limits and approval.
  maxDurationMin: string;
  maxCostUsd: string;
  maxTokens: string;
  maxTurns: string;
  approvalPolicy: string;
  priority: string;
  // Prompt.
  prompt: string;
  // Workflow mode.
  workflowId: string;
  inputs: Record<string, string>;
  // Schedule.
  when: WhenKind;
  at: string;
  cron: string;
  scheduleName: string;
}

export function emptyDraft(): Draft {
  return {
    mode: 'job',
    project: '',
    repoUrl: '',
    baseRef: '',
    workBranch: `agent/${Math.random().toString(36).slice(2, 8)}`,
    sourceTrust: 'untrusted',
    inputFiles: [],
    continueFrom: '',
    inputZip: null,
    inputBundleReuse: null,
    role: '',
    runtime: '',
    runtimeVersion: '',
    model: '',
    fallbacks: [],
    deferrable: false,
    delivery: 'merge',
    sandboxProfile: 'container',
    os: [],
    arch: [],
    tools: '',
    workers: [],
    maxDurationMin: '60',
    maxCostUsd: '',
    maxTokens: '',
    maxTurns: '',
    approvalPolicy: 'ask-sensitive',
    priority: '0',
    prompt: '',
    workflowId: '',
    inputs: {},
    when: 'now',
    at: '',
    cron: '0 3 * * 1-5',
    scheduleName: '',
  };
}

export type Errors = Partial<Record<keyof Draft | `input.${string}`, string>>;

const MAX_PROMPT = 256 * 1024;
const MAX_DURATION_SEC = 7 * 24 * 3600;
const TOOL = /^[A-Za-z0-9_.+-]{1,64}$/;
const GIT_REF = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\]{1,255}$/;

function hasControlChar(v: string): boolean {
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function splitTools(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((t) => t !== ''))];
}

/** JobSpec.repository.url: `z.url({ protocol: /^(https|ssh)$/ })`. */
export function repoUrlError(v: string): string | null {
  const t = v.trim();
  if (t === '') return 'Enter the repository URL.';
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return /^[\w.-]+@[\w.-]+:/.test(t)
      ? 'Use the ssh:// form (ssh://git@host/owner/repo.git); scp-style addresses are not accepted.'
      : 'Enter a full https:// or ssh:// URL.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return 'Only https:// and ssh:// repositories.';
  return null;
}

function refError(v: string, what: string): string | null {
  if (v.trim() === '') return `Enter the ${what}.`;
  if (v.length > 255) return `The ${what} is longer than 255 characters.`;
  if (!GIT_REF.test(v) || hasControlChar(v) || v.endsWith('/') || v.endsWith('.lock'))
    return `The ${what} is not a valid git ref name.`;
  return null;
}

function positiveInt(v: string, label: string, max?: number): string | null {
  if (v.trim() === '') return null;
  if (!/^\d+$/.test(v.trim())) return `${label} must be a whole number.`;
  const n = Number(v);
  if (n < 1) return `${label} must be at least 1.`;
  if (max !== undefined && n > max) return `${label} must be at most ${String(max)}.`;
  return null;
}

/**
 * p19-repo-inputs-composer-workflows: the input files / continue-from of a REPOSITORY project's job or run — the same
 * limits as a workspace's; only while a machine can take them (`blocked`: no machine has `repo-inputs-v1`), and only
 * with a job or run started now (schedules take files for workspace projects only).
 */
function repoFileErrors(d: Draft, e: Errors, blocked: boolean, what: 'job' | 'run'): void {
  const inputs = inputListError(d.inputFiles);
  if (inputs) e.inputFiles = inputs;
  const continueFrom = d.continueFrom.trim();
  if (continueFrom !== '' && !UUID.test(continueFrom)) {
    e.continueFrom = 'Enter a job id (a UUID such as 3f2b…-…), or leave it empty.';
  }
  if (d.inputFiles.length === 0 && continueFrom === '') return;
  if (blocked) {
    e.inputFiles = REPO_FILES_UPDATE;
  } else if (d.when !== 'now') {
    e.inputFiles = `Input files of a repository project only go with a ${what} started now; remove them to schedule it.`;
  }
}

/** p19-repo-inputs-composer-workflows: why the file field of a repository project is off. */
export const REPO_FILES_UPDATE =
  'No machine can take input files for a repository project yet: the machines must be updated first (makine güncellenmeli, repo-inputs-v1).';

/**
 * Field errors for the job steps (empty object = valid). A workspace project's job has no repository; it
 * may carry input files and continue from a previous job instead. p19-repo-inputs-composer-workflows: a repository
 * project's job may carry them too (`repoFilesBlocked`: no machine can take them yet).
 */
export function validateJob(d: Draft, workspace = false, repoFilesBlocked = false): Errors {
  const e: Errors = {};
  if (d.project === '') e.project = 'Choose a project.';
  // p16-zip-job-input: a .zip input goes with a job started now (a schedule could outlive the kept bundle).
  if (d.inputZip !== null) {
    if (d.when !== 'now') e.inputZip = 'A .zip of input files only goes with a job started now.';
    else if (d.inputZip.plan === null || d.inputZip.plan.problems.length > 0)
      e.inputZip = 'This .zip cannot be sent as input files; remove it or pick another one.';
  }
  if (workspace) {
    const inputs = inputListError(d.inputFiles);
    if (inputs) e.inputFiles = inputs;
    if (d.continueFrom.trim() !== '' && !UUID.test(d.continueFrom.trim())) {
      e.continueFrom = 'Enter a job id (a UUID such as 3f2b…-…), or leave it empty.';
    }
  } else {
    const repo = repoUrlError(d.repoUrl);
    if (repo) e.repoUrl = repo;
    const base = refError(d.baseRef, 'base branch');
    if (base) e.baseRef = base;
    const work = refError(d.workBranch, 'work branch');
    if (work) e.workBranch = work;
    repoFileErrors(d, e, repoFilesBlocked, 'job');
  }
  if (d.runtime === '') e.runtime = 'Choose a runtime.';
  if (d.runtimeVersion.length > 64) e.runtimeVersion = 'At most 64 characters.';
  if (d.fallbacks.length > 3) e.fallbacks = 'At most 3 fallback runtimes.';
  else if (d.fallbacks.includes(d.runtime)) e.fallbacks = 'A fallback must differ from the runtime.';
  if (d.model.length > 128) e.model = 'At most 128 characters.';
  if (d.sourceTrust === 'untrusted' && d.sandboxProfile !== 'container') {
    e.sandboxProfile = 'Untrusted source runs only in the container profile.';
  }
  if (d.approvalPolicy === 'allow-all' && d.sourceTrust !== 'trusted') {
    e.approvalPolicy = '“Never ask” is only for trusted sources.';
  }
  const tools = splitTools(d.tools);
  if (tools.length > 16) e.tools = 'At most 16 tools.';
  else if (tools.some((t) => !TOOL.test(t))) e.tools = 'Tool names: letters, digits, . _ + - only.';
  if (d.workers.length > 16) e.workers = 'At most 16 workers.';
  const dur = positiveInt(d.maxDurationMin, 'Max duration', MAX_DURATION_SEC / 60);
  if (d.maxDurationMin.trim() === '') e.maxDurationMin = 'Set a maximum duration.';
  else if (dur) e.maxDurationMin = dur;
  if (d.maxCostUsd.trim() !== '') {
    const n = Number(d.maxCostUsd);
    if (!Number.isFinite(n) || n < 0) e.maxCostUsd = 'Max cost must be a non-negative amount.';
  }
  const tok = positiveInt(d.maxTokens, 'Max tokens');
  if (tok) e.maxTokens = tok;
  const turns = positiveInt(d.maxTurns, 'Max turns');
  if (turns) e.maxTurns = turns;
  if (!/^-?\d+$/.test(d.priority.trim()) || Math.abs(Number(d.priority)) > 100) {
    e.priority = 'Priority is a whole number from -100 to 100.';
  }
  if (d.prompt.trim() === '') e.prompt = 'Describe the task.';
  else if (new TextEncoder().encode(d.prompt).length > MAX_PROMPT)
    e.prompt = 'The prompt is larger than 256 KiB.';
  return e;
}

export function validateWorkflow(
  d: Draft,
  inputs: readonly { readonly name: string; readonly required: boolean }[],
  /**
   * p16-workflow-quality: no longer decides anything — the repository is optional (the run falls back to the
   * workflow's default, then the project's repository, else its AI steps run without code). Kept for callers.
   */
  _hasDefaultRepo: boolean,
  workspace = false,
  /** p19-repo-inputs-composer-workflows: a repository project's run files cannot be taken yet. */
  repoFilesBlocked = false,
): Errors {
  const e: Errors = {};
  if (d.project === '') e.project = 'Choose a project.';
  if (d.workflowId === '') e.workflowId = 'Choose a workflow.';
  for (const i of inputs) {
    if (i.required && (d.inputs[i.name] ?? '').trim() === '') e[`input.${i.name}`] = 'Required.';
  }
  if (workspace) {
    // p5-research-workspace-next: a workspace run has no repository; it takes files handed to every step.
    const files = inputListError(d.inputFiles);
    if (files) e.inputFiles = files;
    if (d.continueFrom.trim() !== '' && !UUID.test(d.continueFrom.trim())) {
      e.continueFrom = 'Enter a job id (a UUID such as 3f2b…-…), or leave it empty.';
    }
    return e;
  }
  // p19-repo-inputs-composer-workflows: run files of a repository project's run (every AI step gets them).
  repoFileErrors(d, e, repoFilesBlocked, 'run');
  if (d.repoUrl.trim() !== '') {
    const repo = repoUrlError(d.repoUrl);
    if (repo) e.repoUrl = repo;
    const base = refError(d.baseRef, 'base branch');
    if (base) e.baseRef = base;
  }
  return e;
}

export function validateSchedule(d: Draft, now: Date = new Date()): Errors {
  const e: Errors = {};
  if (d.when === 'now') return e;
  if (d.scheduleName.trim() === '') e.scheduleName = 'Name the schedule.';
  else if (d.scheduleName.length > 200) e.scheduleName = 'At most 200 characters.';
  if (d.when === 'at') {
    const t = Date.parse(d.at);
    if (d.at === '' || Number.isNaN(t)) e.at = 'Choose a date and time.';
    else if (t <= now.getTime()) e.at = 'Choose a time in the future.';
  } else if (d.cron.trim().split(/\s+/).length !== 5) {
    e.cron = 'Five fields: minute hour day-of-month month day-of-week (UTC).';
  }
  return e;
}

function requirements(d: Draft): PreviewDraft['requirements'] {
  const tools = splitTools(d.tools);
  const r = {
    ...(d.os.length > 0 ? { os: d.os } : {}),
    ...(d.arch.length > 0 ? { arch: d.arch } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(d.workers.length > 0 ? { workers: d.workers } : {}),
  };
  return Object.keys(r).length > 0 ? r : undefined;
}

/**
 * The protocol JobSpec for a valid draft. For a workspace project the spec has no `repository`: the master
 * fills in `spec.workspace` (egress policy and the stored inputs) itself.
 */
export function buildSpec(d: Draft, workspace = false): Record<string, unknown> {
  const req = requirements(d);
  const limits: Record<string, number> = { maxDurationSec: Number(d.maxDurationMin) * 60 };
  if (d.maxCostUsd.trim() !== '') limits.maxCostUsd = Number(d.maxCostUsd);
  if (d.maxTokens.trim() !== '') limits.maxTokens = Number(d.maxTokens);
  if (d.maxTurns.trim() !== '') limits.maxTurns = Number(d.maxTurns);
  return {
    projectId: d.project,
    runtime: d.runtime,
    ...(d.role === '' ? {} : { role: d.role }),
    ...(d.runtimeVersion.trim() === '' ? {} : { runtimeVersion: d.runtimeVersion.trim() }),
    ...(d.model === '' ? {} : { model: d.model }),
    ...(d.fallbacks.length === 0 ? {} : { fallbacks: d.fallbacks.map((runtime) => ({ runtime })) }),
    ...(d.deferrable ? { deferrable: true } : {}),
    prompt: d.prompt,
    ...(workspace
      ? {}
      : {
          repository: { url: d.repoUrl.trim(), baseRef: d.baseRef.trim(), workBranch: d.workBranch.trim() },
          ...(d.delivery === 'outputs' ? { delivery: 'outputs' } : {}),
        }),
    sandboxProfile: d.sandboxProfile,
    approvalPolicy: d.approvalPolicy,
    limits,
    sourceTrust: d.sourceTrust,
    ...(req === undefined ? {} : { requirements: req }),
  };
}

/**
 * p6-smart-routing: what the master's kind heuristic reads — only the start of the first non-empty line (the
 * heuristic looks at the leading verb), so typing the rest of the prompt does not re-run the preview.
 */
export function promptHead(prompt: string): string {
  return (
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  ).slice(0, 60);
}

/**
 * What the placement preview needs (no repository; of the prompt only its start, for the kind heuristic when no
 * kind is chosen).
 */
export function previewDraft(d: Draft): PreviewDraft | null {
  if (d.project === '') return null;
  const req = requirements(d);
  const toolsOk = splitTools(d.tools).every((t) => TOOL.test(t));
  return {
    project: d.project,
    // p11-runtime-advice: "auto" is resolved by the master at submission; the preview evaluates every runtime.
    ...(d.runtime === '' || d.runtime === 'auto' ? {} : { runtime: d.runtime }),
    ...(d.runtimeVersion.trim() === '' ? {} : { runtimeVersion: d.runtimeVersion.trim() }),
    ...(d.model === '' ? {} : { model: d.model }),
    sandboxProfile: d.sandboxProfile,
    sourceTrust: d.sourceTrust,
    approvalPolicy: d.approvalPolicy,
    ...(req === undefined || !toolsOk ? {} : { requirements: req }),
    ...(d.role !== ''
      ? { role: d.role }
      : promptHead(d.prompt) === ''
        ? {}
        : { promptHead: promptHead(d.prompt) }),
  };
}

/** Applies the project's run-limit defaults to empty limit fields. */
export function withLimitDefaults(d: Draft, l: JobLimitDefaults): Draft {
  const fill = (cur: string, v: number | undefined): string =>
    cur === '' && v !== undefined ? String(v) : cur;
  return {
    ...d,
    maxCostUsd: fill(d.maxCostUsd, l.maxCostUsd),
    maxTokens: fill(d.maxTokens, l.maxTokens),
    maxTurns: fill(d.maxTurns, l.maxTurns),
    maxDurationMin:
      l.maxWallTimeSec !== undefined && Number(d.maxDurationMin) * 60 > l.maxWallTimeSec
        ? String(Math.max(1, Math.floor(l.maxWallTimeSec / 60)))
        : d.maxDurationMin,
  };
}

/**
 * Input files and continue-from of a submission (p5-research-workspace-next: also for workflow runs and schedules,
 * which store them with the automation; p19-repo-inputs-composer-workflows: repository jobs and runs started now).
 * Empty object: nothing to send.
 */
export function workspaceFiles(d: Draft): {
  files?: { name: string; contentBase64: string }[];
  continueFrom?: string;
} {
  const continueFrom = d.continueFrom.trim();
  return {
    ...(d.inputFiles.length > 0
      ? { files: d.inputFiles.map((f) => ({ name: f.name, contentBase64: f.contentBase64 })) }
      : {}),
    ...(continueFrom === '' ? {} : { continueFrom }),
  };
}

export function scheduleWhen(d: Draft): ScheduleWhen | null {
  if (d.when === 'at') return { kind: 'at', at: new Date(d.at).toISOString() };
  if (d.when === 'cron') return { kind: 'cron', cron: d.cron.trim().split(/\s+/).join(' ') };
  return null;
}
