import { isSafeCommandsMode, type SafeCommandsMode } from '@remyral/protocol/safe-commands';
import { apiRequest, obj, type RequestOptions, ShapeError } from './client';
import type { Op } from './remoteOps';

/**
 * Sandbox status, Prepare and the unconfined profile (p5-sandbox-ops, ADR-0019;
 * apps/master/src/sandbox-ops/routes.ts). Reading is fleet information; Prepare, the unconfined switch and a
 * project's execution policy are admin actions with always-fresh step-up.
 */

export const SANDBOX_PROFILE_ORDER = [
  'container',
  'runtime-sandbox',
  'host-restricted',
  'unconfined',
] as const;
export type SandboxProfile = (typeof SANDBOX_PROFILE_ORDER)[number];

export const PROFILE_LABEL: Record<SandboxProfile, string> = {
  container: 'Container',
  'runtime-sandbox': 'Runtime sandbox',
  'host-restricted': 'Host (restricted)',
  unconfined: 'Unconfined (full machine)',
};

export type SandboxFix = 'prepare' | 'prepare_privileged' | 'panel' | 'owner' | 'none';

export const FIX_LABEL: Record<SandboxFix, string> = {
  prepare: 'Fix: run Prepare',
  prepare_privileged: 'Fix: run Prepare (with the privileged helper)',
  panel: 'Fix: a panel setting',
  owner: 'Needs the machine owner',
  none: 'Nothing to do here',
};

export interface SandboxCheck {
  readonly id: string;
  readonly status: 'ok' | 'failed' | 'warning' | 'not_applicable';
  readonly code?: string;
  readonly detail?: string;
  readonly fix?: SandboxFix;
}

export interface SandboxProfileStatus {
  readonly profile: SandboxProfile;
  readonly ready: boolean;
  readonly runtimes?: readonly string[];
  readonly code?: string;
  readonly reason?: string;
  readonly remedy?: string;
  readonly fix?: SandboxFix;
  readonly checks: readonly string[];
  readonly confinement?: {
    readonly filesystem: 'container' | 'seatbelt' | 'bwrap' | 'os_user' | 'none';
    readonly egress: 'enforced' | 'proxy_env_only' | 'none';
    readonly limits: 'cgroup' | 'job_object' | 'rlimits' | 'none';
  };
  /** p9-windows-host-isolation: attempts of this profile at once, and why it is limited (older workers: absent). */
  readonly concurrency?: number;
  readonly concurrencyNote?: string;
}

export interface SandboxStatus {
  readonly checkedAt: string;
  readonly platform: string;
  readonly workerUser: { readonly running: string; readonly expected?: string; readonly source: string };
  readonly privilegedPrepare: { readonly available: boolean; readonly detail?: string };
  readonly profiles: readonly SandboxProfileStatus[];
  readonly checks: readonly SandboxCheck[];
}

export type PrepareStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'needs_owner';

export interface PrepareStep {
  readonly id: string;
  readonly state: PrepareStepState;
  readonly privileged: boolean;
  readonly code?: string;
  readonly detail?: string;
}

export interface WorkerSandbox {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly status: SandboxStatus | null;
  readonly statusAt: string | null;
  readonly readyProfiles: readonly string[];
  readonly unconfined: {
    readonly allowed: boolean;
    /** p19-unconfined-parallel: attempts without sandbox run in parallel (older masters: absent → false). */
    readonly parallel?: boolean;
    /** p19-unconfined-parallel: the worker build accepts the parallel setting (older masters: absent → false). */
    readonly parallelSupported?: boolean;
    readonly generation: number;
  };
  readonly localLogin: boolean;
  readonly lastPrepare: Op | null;
}

export interface ProjectExecution {
  readonly project: string;
  readonly hostExecution: boolean;
  readonly unconfined: boolean;
  /**
   * p5-full-access (ADR-0020): the project allows `approvalPolicy: "allow-all"` (no runtime tool call asks).
   * Absent from older masters → false.
   */
  readonly allowAutoApprove: boolean;
  /**
   * p6-safe-auto-approve: which shell commands of `ask-sensitive` jobs the master approves itself (audited). An older
   * master that does not send it is shown as `off` (nothing is auto-approved there).
   */
  readonly safeCommands: SafeCommandsMode;
  /** p8-orchestration (ADR-0031): agents may request sub-jobs (older masters: false). */
  readonly subtasks: boolean;
  /** p8-orchestration: runtimes agent-chosen work may use besides the job's own (older masters: []). */
  readonly delegationRuntimes: readonly string[];
}

export const STEP_LABEL: Record<string, string> = {
  worker_user: 'Dedicated worker account',
  job_runner: 'Windows job runner (Job Object) present and verified',
  seatbelt: 'macOS Seatbelt (sandbox-exec)',
  bubblewrap: 'Linux bubblewrap namespaces',
  container_engine: 'Rootless container engine',
  container_images: 'Pinned runtime images',
  disk_space: 'Free disk space',
  helper_request: 'Privileged helper (root / SYSTEM)',
  config_worker_user: 'Local config: sandbox.workerUser',
  config_local_login: 'Local config: keep the login of local-login runtimes',
  job_runner_install: 'Install the job runner next to the worker',
  workspace_acl: 'Data and workspace folder permissions',
  container_engine_install: 'Install Podman (distribution packages)',
  container_subids: 'Subordinate user ids for rootless containers',
  container_service: 'Worker service hardening vs rootless containers',
  job_slots: 'Per-job Windows accounts: cross-access self-test',
  job_slots_provision: 'Create / rotate the per-job Windows accounts',
  host_isolation: 'Per-attempt Linux isolation: cross-attempt self-check',
  bubblewrap_install: 'Install bubblewrap (distribution package)',
  recheck: 'Check again',
};

/** Prepare steps of a finished/running sandbox.prepare operation. */
export function prepareStepsOf(op: Op | null): readonly PrepareStep[] {
  const p = op?.result?.prepare;
  if (p === null || typeof p !== 'object') return [];
  const steps = (p as { steps?: unknown }).steps;
  return Array.isArray(steps) ? (steps as PrepareStep[]) : [];
}

function parseSandbox(body: unknown): WorkerSandbox {
  const o = obj(body);
  if (typeof o.supported !== 'boolean' || typeof o.unconfined !== 'object' || o.unconfined === null) {
    throw new ShapeError('worker sandbox');
  }
  return o as unknown as WorkerSandbox;
}

function parseExecution(body: unknown): ProjectExecution {
  const o = obj(body);
  if (typeof o.hostExecution !== 'boolean' || typeof o.unconfined !== 'boolean') {
    throw new ShapeError('project execution');
  }
  return {
    project: typeof o.project === 'string' ? o.project : '',
    hostExecution: o.hostExecution,
    unconfined: o.unconfined,
    allowAutoApprove: o.allowAutoApprove === true,
    safeCommands: isSafeCommandsMode(o.safeCommands) ? o.safeCommands : 'off',
    subtasks: o.subtasks === true,
    delegationRuntimes: Array.isArray(o.delegationRuntimes)
      ? o.delegationRuntimes.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

function parseOp(body: unknown): Op {
  const o = obj(body);
  if (typeof o.id !== 'string' || typeof o.state !== 'string') throw new ShapeError('op');
  return o as unknown as Op;
}

type Opts = Omit<RequestOptions, 'body'>;
const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

export function getWorkerSandbox(workerId: string, opts: Opts = {}): Promise<WorkerSandbox> {
  return apiRequest('GET', `${wid(workerId)}/sandbox`, parseSandbox, opts);
}

export function prepareSandbox(workerId: string, privileged: boolean, opts: Opts = {}): Promise<Op> {
  return apiRequest('POST', `${wid(workerId)}/sandbox/prepare`, parseOp, { ...opts, body: { privileged } });
}

export function setUnconfined(
  workerId: string,
  body: { allow: boolean; parallel?: boolean; expectedGeneration: number; reason?: string },
  opts: Opts = {},
): Promise<unknown> {
  return apiRequest('PUT', `${wid(workerId)}/sandbox/unconfined`, (b) => b, { ...opts, body });
}

export function getProjectExecution(project: string, opts: Opts = {}): Promise<ProjectExecution> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/execution`, parseExecution, opts);
}

export function setProjectExecution(
  project: string,
  body: {
    hostExecution: boolean;
    unconfined: boolean;
    allowAutoApprove: boolean;
    safeCommands?: SafeCommandsMode;
    subtasks?: boolean;
    delegationRuntimes?: readonly string[];
  },
  opts: Opts = {},
): Promise<ProjectExecution> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/execution`, parseExecution, {
    ...opts,
    body,
  });
}

/** The Fleet deep link to a worker's Sandbox card (also produced by the master for the chat assistant). */
export function sandboxCardHref(workerId: string): string {
  return `/machines?worker=${encodeURIComponent(workerId)}&section=sandbox`;
}
