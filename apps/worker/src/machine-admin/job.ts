import { type AssignedMachineAdmin, fenceData, type JobSpec, MACHINES_PROJECT } from '@remyral/protocol';
import type { FileOps } from '../fs/ops.js';

/** What the job runner needs for machine-admin jobs (p5-machine-admin, ADR-0021). */
export interface MachineAdminPort {
  readonly ops: FileOps;
  readonly dataDir: string;
  /** The install dir of the root/SYSTEM helper (where the broker answers). */
  readonly installDir: string | undefined;
  /** Panel opt-in ∩ local veto, read per job. */
  effective(): {
    readonly enabled: boolean;
    readonly autoApprove: boolean;
    readonly forbiddenLocally: boolean;
    /**
     * Security fix: host jobs here run without filesystem confinement (the cause), and the owner has not opted in
     * locally (`localCeiling.allowMachineAdmin: true`); null otherwise. `pending`: the isolation is still being checked.
     */
    readonly hostUnconfined?: { readonly cause: string; readonly pending: boolean } | null;
  };
}

export function isMachineAdminSpec(spec: JobSpec): boolean {
  return spec.kind === 'machine-admin';
}

/**
 * Why this worker refuses a machine-admin lease (null: it may run). Checked before anything is prepared, in
 * addition to everything the master checked: the worker's own opt-in (panel ∩ local veto), its own id, the
 * signed session grant, the runtime (an in-process tool channel is needed) and one admin job at a time.
 */
export function machineAdminRefusal(input: {
  readonly spec: JobSpec;
  readonly assigned: AssignedMachineAdmin | undefined;
  readonly port: MachineAdminPort | undefined;
  readonly workerId: string | null;
  readonly adminJobRunning: boolean;
}): string | null {
  const { spec, assigned, port } = input;
  if (!isMachineAdminSpec(spec)) {
    return assigned === undefined
      ? null
      : 'machine_admin_unexpected: only machine-admin jobs carry a session grant';
  }
  if (port === undefined || port.installDir === undefined) {
    return 'machine_admin_unsupported: this worker cannot run machine administration jobs';
  }
  const e = port.effective();
  if (e.forbiddenLocally) {
    return 'machine_admin_disabled_locally: the local config forbids machine administration (localCeiling.allowMachineAdmin: false)';
  }
  if (!e.enabled) {
    return 'machine_admin_not_enabled: machine administration is not enabled for this worker (Machines → <machine> → Admin → Machine admin)';
  }
  if (e.hostUnconfined != null) {
    // The helper refuses too (root's own check); saying it here gives the reason before anything starts.
    return e.hostUnconfined.pending
      ? 'machine_admin_busy: the host sandbox self-check is still running; retry in a minute'
      : `machine_admin_host_unconfined: host jobs on this machine run without filesystem confinement (${e.hostUnconfined.cause.slice(0, 200)}); machine administration is refused in this state unless the owner sets localCeiling.allowMachineAdmin: true in the local config (Machines → <machine> → Sandbox & policy shows how to get confinement)`;
  }
  if (spec.projectId !== MACHINES_PROJECT)
    return `machine_admin_wrong_project: machine-admin jobs belong to ${MACHINES_PROJECT}`;
  if (spec.machineAdmin?.workerId === undefined || spec.machineAdmin.workerId !== input.workerId) {
    return 'machine_admin_wrong_worker: the job administers another machine';
  }
  if (spec.runtime !== 'claude-code') {
    return `machine_admin_runtime_unsupported: ${spec.runtime} has no in-process tool channel; use claude-code`;
  }
  if (spec.workspace === undefined) return 'machine_admin_malformed: machine-admin jobs are workspace jobs';
  if (assigned === undefined) return 'machine_admin_unsigned: the assignment carries no session grant';
  if (spec.approvalPolicy === 'allow-all' && !e.autoApprove) {
    return 'machine_admin_auto_approve_not_allowed: this worker does not allow machine administration without approvals';
  }
  if (input.adminJobRunning)
    return 'machine_admin_busy: another machine administration job runs on this worker';
  return null;
}

/** Instructions for the agent of a machine-admin job, with the machine's memory fenced as data. */
export function machineAdminPreamble(
  memory: string,
  platform: NodeJS.Platform,
  autoApprove: boolean,
): string {
  const shells = platform === 'win32' ? '"powershell" (preferred) or "cmd"' : '"sh" or "bash"';
  return [
    '[Remyral machine administration job] You administer THIS machine for its owner.',
    `Your own tools run as the worker's service account. Anything that needs ${platform === 'win32' ? 'Administrator/SYSTEM' : 'root'} rights goes through`,
    `the admin tools: admin_exec (shells: ${shells}), admin_write_file, admin_read_file.`,
    autoApprove
      ? 'Full access is allowed for this job: elevated commands run without a human approval, but every one is logged.'
      : 'Every elevated command waits for a human approval in the console: make each command self-explanatory and do one step per call.',
    'Be careful and reversible: check before you change, prefer idempotent commands, never disable security software, never',
    'touch the Remyral worker service, its files or its credentials, and never print secrets.',
    'Record what you installed, configured or found with machine_note (one short paragraph each) — later jobs read it.',
    'Write a short report to ./out/report.md at the end.',
    memory.trim() === ''
      ? 'This machine has no recorded memory yet.'
      : fenceData('machine memory (what earlier admin jobs recorded)', memory),
  ].join('\n');
}
