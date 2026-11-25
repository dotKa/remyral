import { z } from 'zod';
import { runtimeKindList, SandboxProfile, Timestamp } from './common.js';

/**
 * Sandbox status and preparation (p5-sandbox-ops, ADR-0019, docs/design/p5-sandbox-ops.md).
 *
 *  - `CAPABILITIES.sandboxStatus` (additive in 1.0, with the `sandbox-ops-v1` feature): per profile whether it is
 *    ready and, if not, a machine-readable code, a human reason and what fixes it (the panel's "Prepare", the
 *    machine owner, or a panel setting); plus the individual host checks behind it (identity, job runner,
 *    Seatbelt, bubblewrap, container engine, images, disk, privileged helper).
 *  - `OPS_COMMAND sandbox.prepare` (remote-ops.ts) fixes what can be fixed and reports each step in
 *    `OPS_UPDATE.prepare`. Unprivileged steps run in the worker; privileged steps are a fixed, versioned
 *    allowlist the root/SYSTEM helper of p2-signed-updates runs after verifying the master's signature on the
 *    very same command.
 *
 * Old masters ignore `sandboxStatus` (unknown keys are stripped); `sandboxReadiness` keeps carrying only the
 * ADR-0007 profiles for them.
 */

export const SANDBOX_OPS_FEATURE = 'sandbox-ops-v1';

/** Stable lower-case code (`worker_identity_unsafe`, `job_runner_missing`, …). */
export const SandboxCode = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** Who or what can fix a failed check / an unready profile. */
export const SandboxFix = z.enum([
  /** The panel's Sandbox → Prepare (worker, unprivileged). */
  'prepare',
  /** Prepare with the privileged helper (root/SYSTEM, fixed allowlist). */
  'prepare_privileged',
  /** A panel setting (allowUnconfined, project opt-in, sandbox profiles of the worker configuration). */
  'panel',
  /** Only the machine owner can (OS feature missing, installer re-run, hardware). */
  'owner',
  /** Nothing to do (informational). */
  'none',
]);
export type SandboxFix = z.infer<typeof SandboxFix>;

export const SandboxCheckId = z.enum([
  'worker_identity',
  'worker_user',
  'job_runner',
  'workspace_acl',
  'seatbelt',
  'bubblewrap',
  'container_engine',
  'container_rootless',
  'container_images',
  'disk_space',
  'privileged_helper',
  'unconfined_policy',
  // p9-windows-host-isolation: per-job Windows accounts (pool provisioned, cross-access self-test passed).
  'job_slots',
  // p19-linux-host-isolation (ADR-0066): per-attempt bubblewrap view on Linux (bwrap present, cross-attempt self-check).
  'host_isolation',
]);
export type SandboxCheckId = z.infer<typeof SandboxCheckId>;

const Short = z.string().max(300);

export const SandboxCheck = z.object({
  id: SandboxCheckId,
  status: z.enum(['ok', 'failed', 'warning', 'not_applicable']),
  code: SandboxCode.optional(),
  detail: Short.optional(),
  fix: SandboxFix.optional(),
});
export type SandboxCheck = z.infer<typeof SandboxCheck>;

export const SandboxProfileStatus = z.object({
  profile: SandboxProfile,
  ready: z.boolean(),
  /** For per-runtime profiles: the runtimes it is ready for. */
  runtimes: runtimeKindList(8).optional(),
  code: SandboxCode.optional(),
  reason: Short.optional(),
  remedy: Short.optional(),
  fix: SandboxFix.optional(),
  /** Checks this profile depends on (the card links them). */
  checks: z.array(SandboxCheckId).max(12),
  /** Confinement the profile gives on this host (shown next to the profile). */
  confinement: z
    .object({
      // p19-linux-host-isolation: `bwrap` = each attempt in its own bubblewrap view (Linux).
      filesystem: z.enum(['container', 'seatbelt', 'bwrap', 'os_user', 'none']),
      egress: z.enum(['enforced', 'proxy_env_only', 'none']),
      limits: z.enum(['cgroup', 'job_object', 'rlimits', 'none']),
    })
    .optional(),
  /**
   * p9-windows-host-isolation: most attempts of this profile the worker runs at the same time (1 = one at a time,
   * T-SBX-4) and, when it is limited, why and what raises it. Old masters strip both.
   */
  concurrency: z.number().int().min(0).max(64).optional(),
  concurrencyNote: Short.optional(),
});
export type SandboxProfileStatus = z.infer<typeof SandboxProfileStatus>;

export const SandboxStatusReport = z.object({
  checkedAt: Timestamp,
  platform: z.enum(['linux', 'darwin', 'win32', 'other']),
  /** The OS account the worker runs as and where `sandbox.workerUser` came from. */
  workerUser: z.object({
    running: z.string().max(128),
    expected: z.string().max(128).optional(),
    source: z.enum(['config', 'inferred', 'none']),
  }),
  /** The root/SYSTEM helper can run privileged prepare steps on this machine. */
  privilegedPrepare: z.object({ available: z.boolean(), detail: Short.optional() }),
  profiles: z.array(SandboxProfileStatus).max(8),
  checks: z.array(SandboxCheck).max(24),
});
export type SandboxStatusReport = z.infer<typeof SandboxStatusReport>;

/**
 * Steps of `sandbox.prepare`, a fixed allowlist. `*_privileged` steps run only in the root/SYSTEM helper, only
 * after it verified the master's signature on the command, and take no argument from the panel or the worker.
 */
export const PrepareStepId = z.enum([
  // unprivileged (worker)
  'worker_user',
  'job_runner',
  'seatbelt',
  'bubblewrap',
  'container_engine',
  'container_images',
  'disk_space',
  // p9-windows-host-isolation: cross-access self-test of the per-job Windows accounts (after the helper)
  'job_slots',
  // p19-linux-host-isolation: cross-attempt self-check of the per-attempt bubblewrap view (after the helper)
  'host_isolation',
  // privileged (helper)
  'helper_request',
  'config_worker_user',
  'config_local_login',
  'job_runner_install',
  'workspace_acl',
  'container_engine_install',
  'container_subids',
  'container_service',
  // p9-windows-host-isolation: create / rotate the per-job Windows accounts (helper)
  'job_slots_provision',
  // p19-linux-host-isolation: install bubblewrap from the distribution's packages (helper, Linux)
  'bubblewrap_install',
  // final
  'recheck',
]);
export type PrepareStepId = z.infer<typeof PrepareStepId>;

export const PrepareStepState = z.enum(['pending', 'running', 'done', 'skipped', 'failed', 'needs_owner']);
export type PrepareStepState = z.infer<typeof PrepareStepState>;

export const PrepareStep = z.object({
  id: PrepareStepId,
  state: PrepareStepState,
  privileged: z.boolean(),
  code: SandboxCode.optional(),
  detail: Short.optional(),
});
export type PrepareStep = z.infer<typeof PrepareStep>;

/** `OPS_UPDATE.prepare`: the steps so far and, at the end, the resulting status. */
export const PrepareReport = z.object({
  steps: z.array(PrepareStep).max(24),
  status: SandboxStatusReport.optional(),
});
export type PrepareReport = z.infer<typeof PrepareReport>;

/** Profiles ordered as the panel lists them. */
export const SANDBOX_PROFILE_ORDER: readonly SandboxProfile[] = [
  'container',
  'runtime-sandbox',
  'host-restricted',
  'unconfined',
];
