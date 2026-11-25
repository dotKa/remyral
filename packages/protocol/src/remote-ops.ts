import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import {
  Ed25519Signature,
  NonNegativeInt,
  RuntimeKind,
  SandboxProfile,
  Sha256Hex,
  Timestamp,
  unlessRetired,
  withoutRetiredEntries,
} from './common.js';
import { DiskHygieneRun } from './disk-hygiene.js';
import { WorkerDoctorReport } from './doctor.js';
import { CustomToolInstall, CustomToolName } from './fleet-tools.js';
import { CodeImagesReport } from './function-job.js';
import { GitFixOp, GitFixReport } from './git-central.js';
import { LeaseKey } from './lease.js';
import {
  McpInstallOp,
  McpInstallReport,
  McpLockfile,
  McpProbeOp,
  McpProbeReport,
  McpRemoveOp,
  NPM_PACKAGE_NAME,
} from './mcp.js';
import { RuntimeAccountId } from './runtime-account-ids.js';
import { SignedCapabilityEvidence, VerificationBudget } from './runtime-verification.js';
import { canonicalPolicyJson } from './runtime-policy.js';
import { UsageRefreshReport } from './runtime-usage.js';
import { PrepareReport, SandboxStatusReport } from './sandbox-ops.js';
import { HelperManageOp, ManageReport, WorkerUninstallOp } from './worker-managed.js';
import {
  InspectSection,
  MachineInspectReport,
  ToolInventoryReport,
  ToolRecipeId,
  ToolVersion,
} from './tools.js';

/**
 * Remote operations (p5-remote-ops, ADR-0017, docs/design/p5-remote-ops.md): the panel operates a worker it
 * cannot reach physically — install / upgrade / remove a pinned agent runtime, start the runtime's own
 * subscription login and relay only its URL / device code, restart the worker service or a runtime, read
 * redacted logs and run diagnostics.
 *
 * Everything travels as one control message each way (additive in protocol 1.0, sent only to workers that
 * advertise `remote-ops-v1`):
 *  - `OPS_COMMAND` (master → worker): one signed operation, bound to the worker id, the command id and a short
 *    validity window. The worker verifies the master lease-key signature (pinned `masterLeaseKeys` if
 *    configured, else the session's keys), refuses expired and replayed commands and re-checks every argument
 *    itself (only pinned, checksummed runtime versions; downgrade only to the previous pin).
 *  - `OPS_UPDATE` (worker → master): progress and the result of a command, ordered by a per-command `seq`.
 *    A login update carries only an allow-listed https URL and/or a device code — never runtime output,
 *    never a token.
 *
 * Pure schemas and statements, shared by master, worker and (types only) the panel.
 */

export const REMOTE_OPS_FEATURE = 'remote-ops-v1';

/** A pinned runtime version (`1.54.0`, `2.1.296`, `0.162.1`, …). */
export const RuntimeVersion = z
  .string()
  .regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/, 'runtime version');
export type RuntimeVersion = z.infer<typeof RuntimeVersion>;

/** Runtimes with a subscription login of their own that the worker can relay (ADR-0014, ADR-0017). */
export const LoginRuntime = z.enum(['claude-code', 'codex']);
export type LoginRuntime = z.infer<typeof LoginRuntime>;

/** Login state of a runtime as its own status command reports it (never the identity or a token). */
export const LoginStatus = z.enum(['logged_in', 'logged_out', 'expired', 'unknown', 'unsupported']);
export type LoginStatus = z.infer<typeof LoginStatus>;

/**
 * Hosts a relayed login URL may point at (the providers' own sign-in pages, verified against the pinned CLIs
 * on 2026-10-14: Claude Code 2.1.296 `claude auth login` → claude.com / platform.claude.com, Codex 0.162.1
 * `codex login --device-auth` → auth.openai.com). Anything else is never relayed.
 */
export const LOGIN_URL_HOSTS: readonly string[] = [
  'claude.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com',
  'auth.openai.com',
];

export function isAllowedLoginUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    LOGIN_URL_HOSTS.includes(url.hostname)
  );
}

export const LoginUrl = z.string().max(2048).refine(isAllowedLoginUrl, 'login URL host not allowed');
/** A device / one-time code shown to the user (`ABCD-EFGHI`). */
export const LoginUserCode = z.string().regex(/^[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,2}$/, 'device code');
/**
 * What the owner pastes back into a login that asks for it (Claude Code's manual flow prints
 * `<authorization code>#<state>`). Exchanging it needs the PKCE verifier that never leaves the worker's login
 * process; the master holds it only in memory while relaying (never stored, logged or audited).
 */
export const LoginPasteCode = z.string().regex(/^[A-Za-z0-9._~#-]{8,1024}$/, 'login code');

export const MAX_LOG_LINES = 2000;
export const MAX_LOG_BYTES = 256 * 1024;
/**
 * p6-worker-boot-diagnostics: the log files `logs.tail` can read — `worker` (`<dataDir>/logs/worker.log`, the
 * daemon's redacted JSON log), `boot` (`<dataDir>/logs/boot.log`, start / fatal / early-exit records written before
 * the logger exists) and `updater` (`<installDir>/state/updater.log`, the privileged updater's own log). Fixed
 * names only: no path is ever a parameter.
 */
export const LogSource = z.enum(['worker', 'boot', 'updater']);
export type LogSource = z.infer<typeof LogSource>;
export const LOGS_SOURCE_FEATURE = 'logs-source-v1';

/** Lines per OPS_UPDATE (and bytes per line) so a log chunk stays far below the frame limit. */
export const LOG_LINES_PER_UPDATE = 200;
export const MAX_LOG_LINE = 4096;

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md; only to `runtime-unverified-v1` workers): workers that install
 * a runtime version outside their release's pinned set when the owner's security policy allows it
 * (`fleet.unverifiedRuntimeUpdates`), always marked `unverified`, and run the automatable verification checks
 * (`runtime.verify`).
 */
export const RUNTIME_UNVERIFIED_FEATURE = 'runtime-unverified-v1';

/** sha512 SRI of an npm tarball as the registry publishes it (`dist.integrity`). */
export const NpmIntegrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/, 'sha512 integrity');

/**
 * p16-runtime-updates: where an unverified runtime version comes from — the release's own npm package at one exact
 * version and the registry's integrity of its tarball (read by the master from the version document, never `latest`).
 * `lock`: the npm lockfile (v3) another machine resolved for exactly this release; absent = the worker resolves it with
 * its own npm (`--package-lock-only --ignore-scripts`) and reports the lock it made. Covered by the command signature.
 */
export const UnverifiedRuntimeSource = z.strictObject({
  package: z.string().max(214).regex(NPM_PACKAGE_NAME, 'npm package name'),
  packageVersion: RuntimeVersion,
  integrity: NpmIntegrity,
  lock: McpLockfile.optional(),
});
export type UnverifiedRuntimeSource = z.infer<typeof UnverifiedRuntimeSource>;

/** p16-runtime-updates: the checks of `runtime.verify` (docs/design/p16-runtime-updates.md §3). */
export const RuntimeVerifyCheckId = z.enum([
  'integrity',
  'version',
  'bundled_version',
  'help',
  'server_auth',
  'adapter_probe',
  'headless_prompt',
  'contract_suite',
]);
export type RuntimeVerifyCheckId = z.infer<typeof RuntimeVerifyCheckId>;

export const RuntimeVerifyCheck = z.object({
  id: RuntimeVerifyCheckId,
  status: z.enum(['passed', 'failed', 'skipped']),
  /** Whether the version counts as a verified candidate only when this check passed. */
  required: z.boolean(),
  detail: z.string().max(300).optional(),
});
export type RuntimeVerifyCheck = z.infer<typeof RuntimeVerifyCheck>;

/** OPS_UPDATE `runtimeVerify` of a finished `runtime.verify`. */
export const RuntimeVerifyReport = z.object({
  runtime: RuntimeKind,
  version: RuntimeVersion,
  /** Every required check passed. */
  passed: z.boolean(),
  checks: z.array(RuntimeVerifyCheck).max(12),
  lockSha256: Sha256Hex.optional(),
  /** The lock this run resolved (absent when the master sent one). */
  lock: McpLockfile.optional(),
});
export type RuntimeVerifyReport = z.infer<typeof RuntimeVerifyReport>;

/** OPS_UPDATE `runtimeInstall` of a finished unverified `runtime.install`. */
export const RuntimeInstallReport = z.object({
  runtime: RuntimeKind,
  version: RuntimeVersion,
  unverified: z.boolean(),
  lockSha256: Sha256Hex.optional(),
  /** The lock this install resolved (the first machine): the master keeps it for every other machine. */
  lock: McpLockfile.optional(),
});
export type RuntimeInstallReport = z.infer<typeof RuntimeInstallReport>;

/** One operation. Upgrade and rollback are `runtime.install` of another pinned version. */
export const OpsOperation = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('runtime.install'),
    runtime: RuntimeKind,
    version: RuntimeVersion,
    /**
     * p16-runtime-updates (only to `runtime-unverified-v1` workers): install `version` although it is not in this
     * release's pinned set, from exactly this source; the installed version is `unverified` (ADR-0012 amendment).
     */
    unverified: UnverifiedRuntimeSource.optional(),
  }),
  /**
   * p16-runtime-updates (only to `runtime-unverified-v1` workers): install `version` into a scratch dir (never active),
   * run the automatable checks, remove it again and report `runtimeVerify`.
   */
  z.object({
    kind: z.literal('runtime.verify'),
    runtime: RuntimeKind,
    version: RuntimeVersion,
    source: UnverifiedRuntimeSource,
  }),
  /**
   * p17-runtime-verify (only to `runtime-capability-verify-v1` workers): run the capability scenario set through the
   * real adapter of the active `version` (refused `version_changed` when another one is active) with the machine's
   * configured auth, in a throw-away repository under the workspace root, confined like a job, within `budget`; answered
   * with OPS_UPDATE `capabilityVerify` (evidence signed by the device key).
   */
  z.object({
    kind: z.literal('runtime.capabilities.verify'),
    runtime: RuntimeKind,
    version: RuntimeVersion,
    budget: VerificationBudget,
  }),
  z.object({ kind: z.literal('runtime.remove'), runtime: RuntimeKind, version: RuntimeVersion }),
  /** Re-detect the runtime and rebuild its adapter (running jobs keep theirs). */
  z.object({ kind: z.literal('runtime.restart'), runtime: RuntimeKind }),
  /**
   * p13-runtime-accounts (with `runtime-accounts-v1`): `account` = the login of that account (its own config dir on the
   * worker); absent = the machine's configured login (`default`). Older workers would ignore it, so the master sends it
   * only to workers advertising the feature.
   */
  z.object({ kind: z.literal('login.start'), runtime: LoginRuntime, account: RuntimeAccountId.optional() }),
  z.object({ kind: z.literal('login.input'), target: z.uuid(), code: LoginPasteCode }),
  z.object({ kind: z.literal('login.status'), runtime: LoginRuntime, account: RuntimeAccountId.optional() }),
  z.object({ kind: z.literal('login.logout'), runtime: LoginRuntime, account: RuntimeAccountId.optional() }),
  /** Stops a running command (a login waiting for the user, an install between steps). */
  z.object({ kind: z.literal('ops.cancel'), target: z.uuid() }),
  z.object({
    kind: z.literal('service.restart'),
    /** Wait for running jobs (no new ones start) before exiting; false = exit now (jobs are reconciled). */
    drain: z.boolean(),
    drainTimeoutSec: z
      .number()
      .int()
      .min(0)
      .max(24 * 3600),
  }),
  z.object({
    kind: z.literal('logs.tail'),
    lines: z.number().int().min(1).max(MAX_LOG_LINES),
    maxBytes: z.number().int().min(1024).max(MAX_LOG_BYTES),
    /** p6-worker-boot-diagnostics (with `logs-source-v1`): which log; absent = `worker`. */
    source: LogSource.optional(),
  }),
  z.object({ kind: z.literal('diagnostics.run') }),
  /**
   * p16-doctor (only to `doctor-v1` workers): the machine's doctor — config, master connectivity (DNS, TLS, HTTP), clock
   * against the master, service, data directory, disk, Node / npm, git, runtimes and their login state, sandbox
   * prerequisites — answered as OPS_UPDATE `doctor` (redacted, bounded). No parameter.
   */
  z.object({ kind: z.literal('doctor.run') }),
  /**
   * p5-sandbox-ops (with `sandbox-ops-v1`): prepare every sandbox profile this machine can support. The worker
   * runs its unprivileged steps; with `privileged` it hands this very command (signature included) to the
   * root/SYSTEM helper, which verifies the signature itself and runs its fixed allowlist of steps.
   * `localLogin`: a runtime of this worker uses its local subscription login (the helper then keeps the worker
   * user's HOME for host jobs, and on macOS allows the worker user's keychain). Nothing else is a parameter.
   */
  z.object({ kind: z.literal('sandbox.prepare'), privileged: z.boolean(), localLogin: z.boolean() }),
  /** p5-machine-admin (with `tools-v1`): detect the machine's tools again now (the cached inventory is replaced). */
  z.object({ kind: z.literal('tools.detect') }),
  /**
   * p5-machine-admin (with `tools-v1`): install a tool from this release's unprivileged recipe (one pinned,
   * checksummed archive into the worker-owned tools dir). Elevated recipes never travel here: they run as
   * machine-admin jobs. No URL, path or command is a parameter.
   */
  z.object({
    kind: z.literal('tool.install'),
    tool: ToolRecipeId,
    version: ToolVersion,
    /**
     * p17-update-channel (owner upgrade, only to `version-catalog-v1` workers): the asset of a version outside this
     * release's recipes — its URL must be the one the worker builds from the fixed template for the tool, platform and
     * version (protocol `toolAssetUrl`), its SHA-256 / size the upstream's published checksum the master read. Covered by
     * the command signature; the worker verifies the download against them before extracting anything.
     */
    asset: z
      .strictObject({
        url: z.string().max(512),
        sha256: Sha256Hex,
        size: z
          .number()
          .int()
          .min(1)
          .max(2 * 1024 * 1024 * 1024),
        build: z.string().max(32).optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('tool.remove'), tool: ToolRecipeId, version: ToolVersion }),
  /**
   * p13-fleet-tools (with `custom-tools-v1`, ADR-0052): an admin-defined download recipe — allowlisted https host,
   * mandatory SHA-256 and size, zip / tgz / raw, entry inside the install dir — installed unprivileged into
   * `<dataDir>/tools/custom/<name>/<version>/`. The worker re-validates it and refuses unless machine administration is
   * enabled for it by the owner and its local ceiling allows custom tools. Package-manager recipes never travel here.
   */
  z.object({ kind: z.literal('tool.install.custom'), recipe: CustomToolInstall }),
  z.object({ kind: z.literal('tool.remove.custom'), name: CustomToolName, version: ToolVersion }),
  /** p5-machine-admin (with `tools-v1`): read-only inspection (installed software, services, disk, logs, tools). */
  z.object({
    kind: z.literal('machine.inspect'),
    sections: z.array(InspectSection).min(1).max(InspectSection.options.length),
  }),
  /**
   * p14-mcp-core (ADR-0054; only to `mcp-v1` workers): discover the tools of one signed MCP server version (initialize +
   * tools/list) — the master never connects to an MCP server. The worker verifies the spec with its own skills keys,
   * resolves the secret slots from its vault, connects only to the spec's URL (no redirects) and reports `mcpProbe`.
   */
  McpProbeOp,
  /**
   * p14-mcp-stdio (ADR-0054 P4; only to `mcp-stdio-v1` workers): install one signed stdio MCP server version (npm /
   * PyPI) unprivileged into `<dataDir>/mcp/<id>/<version>/` — install scripts never run, every package is checked
   * against its lockfile hash before it is unpacked; without `lock` the worker resolves the lock itself (the canary).
   */
  McpInstallOp,
  McpRemoveOp,
  /**
   * p14-code-images (only to `code-images-v1` workers): pull FUNCTION_CODE_BASE_IMAGES by digest and build the code
   * node images from the build contexts in this worker's release. No parameter: the images, digests and build
   * contexts are fixed by the release.
   */
  z.object({ kind: z.literal('code.images.prepare') }),
  /**
   * p15-git-central (only to `git-central-v1` workers): apply safe fixes to the worker account's own git setup — erase
   * stale GitHub credentials from its credential helpers, remove github.com URL rewrites. The fix ids are the only
   * parameter; the worker re-detects before and after and reports `gitFix`.
   */
  GitFixOp,
  /**
   * p15-usage-refresh (only to `usage-refresh-v1` workers): read the usage-limit windows of the subscription logins now
   * with the runtimes' read-only probes (ADR-0046; no prompt, no model request) — all of them, one runtime, or one
   * account of it. The worker answers `usageRefresh` with the fresh snapshots.
   */
  z.object({
    kind: z.literal('usage.refresh'),
    runtime: LoginRuntime.optional(),
    account: RuntimeAccountId.optional(),
  }),
  /**
   * p17-disk-selfclean (only to `disk-hygiene-v1` workers): run the worker's disk hygiene now ("Şimdi temizle") — what
   * is always safe to drop, then, while free space is below the target, the rest in its fixed order. No parameter: what
   * may be deleted is fixed by the worker. Answered with OPS_UPDATE `diskClean`.
   */
  z.object({ kind: z.literal('disk.clean') }),
  /**
   * p17-worker-managed (only to `worker-managed-v1` workers): remove the worker from its machine through the privileged
   * helper (worker-managed.ts). The master then revokes the worker.
   */
  WorkerUninstallOp,
  /** p17-worker-managed (only to `worker-managed-v1` workers): install / remove the machine-admin helper's trigger. */
  HelperManageOp,
]);
export type OpsOperation = z.infer<typeof OpsOperation>;
export type OpsKind = OpsOperation['kind'];
export const OPS_KINDS = OpsOperation.options.map((o) => o.shape.kind.value);

export const OpsCommandSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });

/** `OPS_COMMAND` payload (master → worker, control). */
export const OpsCommandPayload = z.object({
  commandId: z.uuid(),
  issuedAt: Timestamp,
  /** The worker refuses the command after this time (and before `issuedAt` minus clock skew). */
  expiresAt: Timestamp,
  op: OpsOperation,
  /** Absent only when the master has no lease-signing key; workers with trusted keys then refuse it. */
  signature: OpsCommandSignature.optional(),
});
export type OpsCommandPayload = z.infer<typeof OpsCommandPayload>;

export const OPS_COMMAND_CONTEXT = 'remana-ops-command/v1\n';
/** Longest validity window the worker accepts (expiresAt − issuedAt). */
export const MAX_OPS_COMMAND_TTL_MS = 5 * 60_000;
/** Clock skew the worker tolerates around the window. */
export const OPS_CLOCK_SKEW_MS = 2 * 60_000;

/** SHA-256 (hex) of the canonical JSON of an operation. */
export function opsOperationDigest(op: OpsOperation): string {
  return createHash('sha256').update(canonicalPolicyJson(op), 'utf8').digest('hex');
}

/** Exact bytes a master signs for an OPS_COMMAND (bound to the worker, command id, window and operation). */
export function opsCommandStatement(input: {
  readonly workerId: string;
  readonly commandId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly op: OpsOperation;
}): Buffer {
  return Buffer.from(
    `${OPS_COMMAND_CONTEXT}${input.workerId}\n${input.commandId}\n${input.issuedAt}\n${input.expiresAt}\n${opsOperationDigest(input.op)}`,
    'utf8',
  );
}

export function signOpsCommand(
  input: Parameters<typeof opsCommandStatement>[0],
  kid: string,
  privateKey: KeyObject,
): z.infer<typeof OpsCommandSignature> {
  return { kid, signature: sign(null, opsCommandStatement(input), privateKey).toString('base64url') };
}

/** Verifies an OPS_COMMAND signature against trusted master keys. Never throws. */
export function verifyOpsCommand(
  input: Parameters<typeof opsCommandStatement>[0],
  signature: z.infer<typeof OpsCommandSignature> | undefined,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, opsCommandStatement(input), signature.signature)
    ? 'ok'
    : 'bad_signature';
}

/** Validity window check (worker side). */
export function opsCommandWindow(
  p: Pick<OpsCommandPayload, 'issuedAt' | 'expiresAt'>,
  now: Date,
): 'ok' | 'expired' | 'not_yet_valid' | 'window_too_long' {
  const issued = Date.parse(p.issuedAt);
  const expires = Date.parse(p.expiresAt);
  if (expires < issued || expires - issued > MAX_OPS_COMMAND_TTL_MS) return 'window_too_long';
  if (now.getTime() > expires + OPS_CLOCK_SKEW_MS) return 'expired';
  if (now.getTime() < issued - OPS_CLOCK_SKEW_MS) return 'not_yet_valid';
  return 'ok';
}

export const OpsState = z.enum([
  'accepted',
  'running',
  'waiting_for_user',
  'succeeded',
  'failed',
  'refused',
  'cancelled',
]);
export type OpsState = z.infer<typeof OpsState>;
export const TERMINAL_OPS_STATES: ReadonlySet<OpsState> = new Set([
  'succeeded',
  'failed',
  'refused',
  'cancelled',
]);

export const OpsReason = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const InstallIntegrity = z.enum(['ok', 'modified', 'unknown']);

/** One managed (worker-installed) runtime and what the pinned set offers for it on this host. */
export const ManagedRuntimeReport = z.object({
  runtime: RuntimeKind,
  /** How the pinned set installs it (npm lockfile, sha256 binary). ADR-0023 removed `pypi` (OpenHands only). */
  method: z.enum(['npm', 'binary']),
  /** Whether this OS/arch can install it. */
  supported: z.boolean(),
  unsupportedReason: z.string().max(300).optional(),
  /** The current pin and the previous one (the only allowed downgrade). */
  pinned: RuntimeVersion,
  previous: RuntimeVersion.optional(),
  /** Versions the worker can install (pinned set with checksums for this platform). */
  available: z.array(RuntimeVersion).max(8),
  installed: z
    .array(
      z.object({
        version: RuntimeVersion,
        installedAt: Timestamp,
        integrity: InstallIntegrity,
        /** p16-runtime-updates: installed outside the pinned set (owner policy) — the pin it was compared with. */
        unverified: z.object({ pin: RuntimeVersion }).optional(),
      }),
    )
    .max(8),
  /** The managed version in use (null: none; the runtime may still come from PATH / the local config). */
  active: RuntimeVersion.nullable(),
  /**
   * p16-runtime-updates (with `runtime-unverified-v1`): whether this machine can install a version outside the pinned
   * set (an npm install set and the npm CLI next to the worker's Node); absent = not known (older worker).
   */
  unverifiedSupported: z.boolean().optional(),
  /**
   * p17-update-channel (with `version-catalog-v1`): the release's own pin when an accepted catalog moved `pinned` to a
   * verified catalog version (absent: `pinned` is the release pin).
   */
  releasePin: RuntimeVersion.optional(),
  /** p17-update-channel: unverified catalog versions this host can install (owner policy decides; marked unverified). */
  catalogUnverified: z.array(RuntimeVersion).max(8).optional(),
});
export type ManagedRuntimeReport = z.infer<typeof ManagedRuntimeReport>;

export const LoginReport = z.object({
  runtime: LoginRuntime,
  /** p13-runtime-accounts (additive): the account (absent = `default`). */
  account: RuntimeAccountId.optional(),
  status: LoginStatus,
  /** The runtime's own auth method label (`claude.ai`, `chatgpt`, …), never an identity. */
  method: z
    .string()
    .regex(/^[A-Za-z0-9_. -]{1,32}$/)
    .optional(),
  checkedAt: Timestamp.optional(),
  /**
   * p5-claude-auth-health (additive): why the login is not usable although the status command may say logged in
   * — `login_expired`: a run failed refreshing the subscription's OAuth token (re-login on the worker).
   */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
});
export type LoginReport = z.infer<typeof LoginReport>;

/** CAPABILITIES.remoteOps (with the `remote-ops-v1` feature). */
export const RemoteOpsReport = z.object({
  /** ADR-0023: entries of retired runtimes (older workers still report OpenHands) are dropped when parsed. */
  runtimes: withoutRetiredEntries('runtime', z.array(ManagedRuntimeReport).max(8)),
  login: z.array(LoginReport).max(4),
  service: z.object({
    manager: z.enum(['systemd', 'launchd', 'scm', 'none']),
    /** The worker exits for its service manager to restart it; false when it runs in the foreground. */
    restartable: z.boolean(),
  }),
  logs: z.object({ available: z.boolean(), bytes: NonNegativeInt }),
  /** A command currently running (one at a time per worker for installs and logins). */
  activeCommand: z.uuid().optional(),
});
export type RemoteOpsReport = z.infer<typeof RemoteOpsReport>;

const ShortText = z.string().max(300);

/** Result of `diagnostics.run` (bounded; strings are redacted on the worker and again on the master). */
export const Diagnostics = z.object({
  collectedAt: Timestamp,
  workerVersion: z.string().max(64),
  node: z.object({ version: z.string().max(32), ok: z.boolean(), requiredMajor: z.number().int() }),
  os: z.object({ platform: z.string().max(32), release: z.string().max(128), arch: z.string().max(16) }),
  uptimeSec: NonNegativeInt,
  memory: z.object({ freeBytes: NonNegativeInt, totalBytes: NonNegativeInt }),
  disk: z
    .array(
      z.object({
        name: z.enum(['dataDir', 'workspaceRoot', 'runtimes']),
        freeBytes: NonNegativeInt.nullable(),
        totalBytes: NonNegativeInt.nullable(),
      }),
    )
    .max(4),
  sandbox: z
    .array(z.object({ profile: SandboxProfile, ready: z.boolean(), reason: ShortText.optional() }))
    .max(8),
  /** p5-sandbox-ops (additive): the detailed sandbox status (checks, codes, fixes). */
  sandboxStatus: SandboxStatusReport.optional(),
  runtimes: withoutRetiredEntries(
    'runtime',
    z
      .array(
        z.object({
          runtime: RuntimeKind,
          source: z.enum(['managed', 'config', 'path', 'none']),
          version: z.string().max(64).nullable(),
          enabled: z.boolean(),
          authenticated: z.enum(['yes', 'no', 'unknown']),
          integrity: InstallIntegrity.optional(),
          problem: ShortText.optional(),
        }),
      )
      .max(8),
  ),
  service: z.object({
    manager: z.enum(['systemd', 'launchd', 'scm', 'none']),
    state: z.string().max(32).optional(),
    restarts: z.number().int().nullable().optional(),
  }),
  problems: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z0-9_.]{1,64}$/),
        severity: z.enum(['info', 'warning', 'error']),
        message: ShortText,
      }),
    )
    .max(32),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

/** `OPS_UPDATE` payload (worker → master, control). */
export const OpsUpdatePayload = z.object({
  commandId: z.uuid(),
  /** Per command, starting at 1; the master ignores anything not newer than what it has. */
  seq: z.number().int().min(1).max(1_000_000),
  kind: z.enum(OPS_KINDS as [OpsKind, ...OpsKind[]]),
  state: OpsState,
  reason: OpsReason.optional(),
  detail: ShortText.optional(),
  /** Step of a multi-step command (`download`, `verify`, `extract`, `venv`, `activate`, …). */
  progress: z
    .object({
      step: z.string().regex(/^[a-z_]{1,32}$/),
      done: NonNegativeInt.optional(),
      total: NonNegativeInt.optional(),
    })
    .optional(),
  /** Login relay: only the provider's sign-in URL and/or device code, and whether a code is expected back. */
  login: z
    .object({
      runtime: LoginRuntime,
      /** p13-runtime-accounts (additive): the account the login is for (absent = `default`). */
      account: RuntimeAccountId.optional(),
      url: LoginUrl.optional(),
      userCode: LoginUserCode.optional(),
      expectsCode: z.boolean(),
      status: LoginStatus.optional(),
      /** p5-claude-auth-health (additive): see LoginReport.reason. */
      reason: OpsReason.optional(),
    })
    .optional(),
  /** One chunk of redacted log lines (logs.tail). */
  logs: z
    .object({
      lines: z.array(z.string().max(MAX_LOG_LINE)).max(LOG_LINES_PER_UPDATE),
      /** Older lines were left out to respect the requested bounds. */
      truncated: z.boolean(),
      redacted: z.literal(true),
      last: z.boolean(),
    })
    .optional(),
  diagnostics: Diagnostics.optional(),
  /** p16-doctor: the result of `doctor.run`. */
  doctor: WorkerDoctorReport.optional(),
  /** State of the runtime after an install / remove / restart. */
  runtime: unlessRetired('runtime', ManagedRuntimeReport.optional()),
  /** p5-sandbox-ops: steps of `sandbox.prepare` and, at the end, the resulting sandbox status. */
  prepare: PrepareReport.optional(),
  /** p5-machine-admin: the tool inventory after `tools.detect` / `tool.install` / `tool.remove`. */
  tools: ToolInventoryReport.optional(),
  /** p5-machine-admin: the result of `machine.inspect`. */
  inspect: MachineInspectReport.optional(),
  /** p14-mcp-core: the tools an `mcp.probe` found (untrusted server text). */
  mcpProbe: McpProbeReport.optional(),
  /** p14-mcp-stdio: the result of an `mcp.install` (tree digest, lock hash; the lock itself when this install made it). */
  mcpInstall: McpInstallReport.optional(),
  /** p14-code-images: the images `code.images.prepare` built. */
  codeImages: CodeImagesReport.optional(),
  /** p15-git-central: per-fix outcome of `git.fix` and the git readiness found afterwards. */
  gitFix: GitFixReport.optional(),
  /** p15-usage-refresh: per-login outcome of `usage.refresh` and the snapshots it read. */
  usageRefresh: UsageRefreshReport.optional(),
  /** p16-runtime-updates: the result of an unverified `runtime.install` (the lock it resolved, if any). */
  runtimeInstall: RuntimeInstallReport.optional(),
  /** p16-runtime-updates: the checks of a `runtime.verify`. */
  runtimeVerify: RuntimeVerifyReport.optional(),
  /**
   * p17-runtime-verify: the per-capability results of a `runtime.capabilities.verify` (with the final state; a progress
   * update carries the results so far, unsigned). Signed by the worker's device key.
   */
  capabilityVerify: z
    .union([
      z.strictObject({ final: z.literal(true), signed: SignedCapabilityEvidence }),
      z.strictObject({
        final: z.literal(false),
        results: SignedCapabilityEvidence.shape.evidence.shape.results,
      }),
    ])
    .optional(),
  /** p17-disk-selfclean: the run `disk.clean` made (bytes freed per category, free space before / after). */
  diskClean: DiskHygieneRun.optional(),
  /** p17-worker-managed: the privileged helper's steps of `worker.uninstall` / `helper.manage`. */
  manage: ManageReport.optional(),
});
export type OpsUpdatePayload = z.infer<typeof OpsUpdatePayload>;
