import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { AttemptId, Ed25519Signature, Epoch, Identifier, NonNegativeInt, Timestamp } from './common.js';
import { LeaseKey } from './lease.js';
import { canonicalPolicyJson } from './runtime-policy.js';

/**
 * AI machine administration (p5-machine-admin, ADR-0021, docs/design/p5-machine-admin.md).
 *
 * A `machine-admin` job runs an agent runtime (Claude Code first) **as the worker's service account** — with its
 * own subscription login — on exactly one opted-in worker. The agent gets three extra tools (`admin_exec`,
 * `admin_write_file`, `admin_read_file`); each call becomes one **elevated command** that runs as root /
 * SYSTEM through the privileged helper of p2-signed-updates, and only after the master signed it:
 *
 *  1. worker → master `MACHINE_ADMIN_REQUEST {attemptId, epoch, requestId, op}` (control, fenced by the lease);
 *  2. the master checks the lease, the job, the worker's opt-in, records the command (job event + audit) and
 *     either signs it at once (`allow-all` with the project's *and* the worker's auto-approve) or opens an
 *     approval (`machine.admin`, admin + step-up) and signs it when a human approves;
 *  3. master → worker `MACHINE_ADMIN_DECISION {state: granted | pending | denied, grant?}` — the grant is an
 *     Ed25519 lease-key signature over worker, job, attempt, epoch, request id, a ≤ 5-minute window and the
 *     operation digest;
 *  4. the worker hands `{op, grant}` to the elevated broker, which verifies the signature itself (pinned
 *     `masterLeaseKeys`, else keys it fetches from the master over TLS — never keys the worker supplies),
 *     refuses replays and anything outside its session, runs it, and returns the result;
 *  5. worker → master `MACHINE_ADMIN_RESULT` (exit code, redacted bounded output, file digests).
 *
 * The broker itself is started per job attempt by the root/SYSTEM helper only for a **session grant** the
 * master put into the ASSIGN_JOB (bound to worker, job, attempt, epoch and a window ≤ 12 h). There is no
 * command channel outside a running machine-admin job.
 */

export const MACHINE_ADMIN_FEATURE = 'machine-admin-v1';
/**
 * p17-worker-1-1-1: MACHINE_ADMIN_REQUEST carries the agent's own `purpose` of an elevated command (why it is needed
 * now, one line). Metadata only: it is not part of the operation digest or of any signature, the master stores and
 * shows it labelled as the agent's unverified claim. Older workers send none (nothing is shown).
 */
export const MACHINE_ADMIN_PURPOSE_FEATURE = 'machine-admin-purpose-v1';
/** The built-in workspace project every machine-admin job belongs to (created by migration 0038). */
export const MACHINES_PROJECT = 'machines';
/** JobSpec.kind of an AI machine-administration job. */
export const MACHINE_ADMIN_KIND = 'machine-admin' as const;

export const MAX_ADMIN_COMMAND = 16 * 1024;
export const MAX_ADMIN_FILE_BYTES = 512 * 1024;
export const MAX_ADMIN_OUTPUT = 16 * 1024;
export const MAX_ADMIN_TIMEOUT_SEC = 3600;
/** Longest validity window of one command grant, and the clock skew the broker tolerates. */
export const MAX_ADMIN_GRANT_TTL_MS = 5 * 60_000;
export const ADMIN_CLOCK_SKEW_MS = 2 * 60_000;
/** Longest machine-admin session (the job's max duration plus slack, capped). */
export const MAX_ADMIN_SESSION_MS = 12 * 3600_000;
/** Per-machine memory injected into machine-admin jobs (and shown in Fleet). */
export const MAX_MACHINE_MEMORY = 64 * 1024;

/** Absolute path on any OS (`/…`, `C:\…`); the broker re-checks it before touching anything. */
export const AdminPath = z
  .string()
  .min(2)
  .max(1024)
  .refine((p) => !p.includes('\u0000'), 'no NUL')
  .refine((p) => /^(\/|[A-Za-z]:[\\/])/.test(p), 'an absolute path');

export const AdminShell = z.enum(['powershell', 'cmd', 'sh', 'bash']);
export type AdminShell = z.infer<typeof AdminShell>;

/** One elevated operation. Nothing else exists: no URL, no package, no "script from a file" indirection. */
export const AdminOp = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exec'),
    shell: AdminShell,
    command: z.string().min(1).max(MAX_ADMIN_COMMAND),
    cwd: AdminPath.optional(),
    timeoutSec: z.number().int().min(1).max(MAX_ADMIN_TIMEOUT_SEC),
  }),
  z.object({
    kind: z.literal('write_file'),
    path: AdminPath,
    /** base64 of the bytes to write. */
    content: z
      .string()
      .max(Math.ceil(MAX_ADMIN_FILE_BYTES / 3) * 4 + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
    mode: z.enum(['create', 'overwrite', 'append']),
  }),
  z.object({
    kind: z.literal('read_file'),
    path: AdminPath,
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024),
  }),
]);
export type AdminOp = z.infer<typeof AdminOp>;

/** Longest `purpose` of an elevated command (after normalising whitespace). */
export const MAX_ADMIN_PURPOSE = 300;

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused / removed here
const PURPOSE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
const PURPOSE_CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** Bidirectional overrides / isolates and zero-width characters (they can make displayed text lie). */
const PURPOSE_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * The agent's stated purpose of one elevated command (p17-worker-1-1-1): 1–300 characters on one line, no control or
 * invisible characters. An unverified claim — never part of the digest or a signature.
 */
export const AdminPurpose = z
  .string()
  .min(1)
  .max(MAX_ADMIN_PURPOSE)
  .refine((s) => !PURPOSE_CONTROL.test(s) && !PURPOSE_INVISIBLE.test(s), 'one line, no control characters')
  .refine((s) => s.trim() === s && s.trim() !== '', 'trimmed, not empty');

/**
 * Normalises a purpose the agent gave: control characters and runs of whitespace become one space, invisible
 * characters are dropped, the result is trimmed and cut to {@link MAX_ADMIN_PURPOSE} (with `…`). Null when nothing
 * is left. The result always satisfies {@link AdminPurpose}.
 */
export function normalizeAdminPurpose(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(PURPOSE_INVISIBLE, '').replace(PURPOSE_CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  if (s.length <= MAX_ADMIN_PURPOSE) return s;
  let end = MAX_ADMIN_PURPOSE - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end).trimEnd()}…`;
}

/** SHA-256 (hex) of the canonical JSON of an operation. */
export function adminOpDigest(op: AdminOp): string {
  return createHash('sha256').update(canonicalPolicyJson(op), 'utf8').digest('hex');
}

/** One line for audits, approvals and job events (bounded; the full command stays in the command log). */
export function adminOpSummary(op: AdminOp, max = 600): string {
  const text =
    op.kind === 'exec'
      ? `[${op.shell}${op.cwd === undefined ? '' : ` in ${op.cwd}`}] ${op.command}`
      : op.kind === 'write_file'
        ? `${op.mode} file ${op.path} (${String(Math.floor((op.content.length * 3) / 4))} bytes)`
        : `read file ${op.path}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const AdminSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });

/** The master's permission to run one operation (bound to the lease and the operation digest). */
export const AdminGrant = z.object({
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  signature: AdminSignature,
});
export type AdminGrant = z.infer<typeof AdminGrant>;

export interface AdminCommandBinding {
  readonly workerId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly requestId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly op: AdminOp;
}

export const ADMIN_COMMAND_CONTEXT = 'remana-machine-admin/v1\n';

/** Exact bytes a master signs for one elevated command. */
export function adminCommandStatement(b: AdminCommandBinding): Buffer {
  return Buffer.from(
    `${ADMIN_COMMAND_CONTEXT}${b.workerId}\n${b.jobId}\n${b.attemptId}\n${String(b.epoch)}\n${b.requestId}\n${b.issuedAt}\n${b.expiresAt}\n${adminOpDigest(b.op)}`,
    'utf8',
  );
}

export function signAdminCommand(
  b: AdminCommandBinding,
  kid: string,
  privateKey: KeyObject,
): z.infer<typeof AdminSignature> {
  return { kid, signature: sign(null, adminCommandStatement(b), privateKey).toString('base64url') };
}

/** Verifies a command grant against trusted master keys. Never throws. */
export function verifyAdminCommand(
  b: AdminCommandBinding,
  signature: z.infer<typeof AdminSignature> | undefined,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, adminCommandStatement(b), signature.signature) ? 'ok' : 'bad_signature';
}

/** Validity window of a command grant (broker side). */
export function adminGrantWindow(
  g: Pick<AdminGrant, 'issuedAt' | 'expiresAt'>,
  now: Date,
  maxTtlMs = MAX_ADMIN_GRANT_TTL_MS,
): 'ok' | 'expired' | 'not_yet_valid' | 'window_too_long' {
  const issued = Date.parse(g.issuedAt);
  const expires = Date.parse(g.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return 'window_too_long';
  if (expires < issued || expires - issued > maxTtlMs) return 'window_too_long';
  if (now.getTime() > expires + ADMIN_CLOCK_SKEW_MS) return 'expired';
  if (now.getTime() < issued - ADMIN_CLOCK_SKEW_MS) return 'not_yet_valid';
  return 'ok';
}

// ------------------------------------------------------------------------------------------- session

/** Session grant in ASSIGN_JOB: lets the root/SYSTEM helper start a broker for exactly this attempt. */
export const AdminSessionGrant = z.object({
  sessionId: z.uuid(),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  signature: AdminSignature.optional(),
});
export type AdminSessionGrant = z.infer<typeof AdminSessionGrant>;

export interface AdminSessionBinding {
  readonly workerId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export const ADMIN_SESSION_CONTEXT = 'remana-machine-admin-session/v1\n';

export function adminSessionStatement(b: AdminSessionBinding): Buffer {
  return Buffer.from(
    `${ADMIN_SESSION_CONTEXT}${b.workerId}\n${b.jobId}\n${b.attemptId}\n${String(b.epoch)}\n${b.sessionId}\n${b.issuedAt}\n${b.expiresAt}`,
    'utf8',
  );
}

export function signAdminSession(
  b: AdminSessionBinding,
  kid: string,
  privateKey: KeyObject,
): z.infer<typeof AdminSignature> {
  return { kid, signature: sign(null, adminSessionStatement(b), privateKey).toString('base64url') };
}

export function verifyAdminSession(
  b: AdminSessionBinding,
  signature: z.infer<typeof AdminSignature> | undefined,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, adminSessionStatement(b), signature.signature) ? 'ok' : 'bad_signature';
}

// ------------------------------------------------------------------------------------------- messages

const LeaseRef = { attemptId: AttemptId, epoch: Epoch };

/** `MACHINE_ADMIN_REQUEST` payload (worker → master, control, job-scoped). */
export const MachineAdminRequestPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  op: AdminOp,
  /**
   * `machine-admin-purpose-v1`: the agent's own one-line reason for this command (unverified; not in the digest or
   * any signature). Absent from older workers.
   */
  purpose: AdminPurpose.optional(),
});
export type MachineAdminRequestPayload = z.infer<typeof MachineAdminRequestPayload>;

export const AdminDecisionReason = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** `MACHINE_ADMIN_DECISION` payload (master → worker, control, job-scoped). */
export const MachineAdminDecisionPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  state: z.enum(['granted', 'pending', 'denied']),
  reason: AdminDecisionReason.optional(),
  /** Human-readable explanation for the agent (denials). */
  detail: z.string().max(500).optional(),
  /** `pending`: the approval request a human decides (APPROVAL_DECISION follows with this id). */
  approvalId: Identifier.optional(),
  grant: AdminGrant.optional(),
});
export type MachineAdminDecisionPayload = z.infer<typeof MachineAdminDecisionPayload>;

/** `MACHINE_ADMIN_RESULT` payload (worker → master, control, job-scoped). */
export const MachineAdminResultPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  state: z.enum(['succeeded', 'failed', 'refused']),
  reason: AdminDecisionReason.optional(),
  exitCode: z.number().int().optional(),
  durationMs: NonNegativeInt,
  /** Redacted, bounded tail of stdout + stderr (read_file: the redacted content). */
  output: z.string().max(MAX_ADMIN_OUTPUT),
  truncated: z.boolean(),
  /** write_file / read_file: what changed or was read. */
  file: z
    .object({
      path: AdminPath,
      bytes: NonNegativeInt,
      sha256Before: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      sha256After: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .optional(),
});
export type MachineAdminResultPayload = z.infer<typeof MachineAdminResultPayload>;

/** ASSIGN_JOB.machineAdmin (only for `kind: machine-admin` jobs, only to `machine-admin-v1` workers). */
export const AssignedMachineAdmin = z.object({
  session: AdminSessionGrant,
  /** The machine's memory document (`machine:<workerId>`), rendered; fenced by the worker as data. */
  memory: z.string().max(MAX_MACHINE_MEMORY),
  /** Elevated commands are signed without a human (project and worker allow auto-approve, job allow-all). */
  autoApprove: z.boolean(),
});
export type AssignedMachineAdmin = z.infer<typeof AssignedMachineAdmin>;

/**
 * p17-worker-1-1-1: reason codes of the root/SYSTEM helper readiness probe (worker `machine-admin/report.ts`).
 *
 * - `install_dir_unknown` — the worker does not know its install dir;
 * - `helper_missing` / `helper_outdated` — no updater, or one without the admin marker (re-run the installer kit);
 * - `admin_unit_missing` / `admin_unit_disabled` — Linux: `remyral-worker-admin.path` is not installed / not enabled;
 * - `state_dir_not_traversable` — Linux / macOS: the worker account cannot pass through `<install>/state/machine-admin`
 *   (the 0750 directory of older helpers: every session ended in `helper_not_started`);
 * - `admin_task_missing` / `admin_task_unreadable` — Windows: the `RemyralWorkerAdmin` task was not found / could not
 *   be queried;
 * - `admin_plist_missing` — macOS: `/Library/LaunchDaemons/com.remyral.worker.admin.plist` does not exist;
 * - `probe_failed` — the probe itself failed;
 * - `helper_not_bound` / `helper_bound_elsewhere` — a helper that binds sessions to the machine's worker id has no
 *   root-recorded id yet / records another one (`remyral-worker-updater admin-bind`, docs/ops/machine-admin.md);
 * - `host_unconfined` — host jobs run without filesystem confinement here and the owner has not opted in locally, so
 *   the worker and the helper refuse machine administration (docs/ops/machine-admin.md).
 */
export const ADMIN_HELPER_REASONS = [
  'install_dir_unknown',
  'helper_missing',
  'helper_outdated',
  'admin_unit_missing',
  'admin_unit_disabled',
  'state_dir_not_traversable',
  'admin_task_missing',
  'admin_task_unreadable',
  'admin_plist_missing',
  'probe_failed',
  'helper_not_bound',
  'helper_bound_elsewhere',
  'host_unconfined',
] as const;
export type AdminHelperReason = (typeof ADMIN_HELPER_REASONS)[number];

/** CAPABILITIES.machineAdmin (with `machine-admin-v1`). */
export const MachineAdminReport = z.object({
  /** Effective opt-in (panel ∩ local ceiling). */
  enabled: z.boolean(),
  autoApprove: z.boolean(),
  /** `localCeiling.allowMachineAdmin: false` in the root-owned local config. */
  localVeto: z.boolean(),
  /** The installed root/SYSTEM helper can run admin sessions (marker remana-admin-helper/v1). */
  helper: z.enum(['available', 'missing', 'unknown']),
  helperDetail: z.string().max(300).optional(),
  /**
   * p17-worker-1-1-1: why the helper is not ready (a closed code, {@link ADMIN_HELPER_REASONS}; the console translates
   * it, `helperDetail` is the English fallback). Absent when it is available or the worker predates the readiness
   * probe.
   */
  helperReason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  /** Runtimes that can drive machine-admin jobs on this worker (in-process tool channel). */
  runtimes: z.array(z.enum(['claude-code'])).max(4),
  activeSession: z
    .object({ jobId: Identifier, attemptId: AttemptId, sessionId: z.uuid(), since: Timestamp })
    .optional(),
});
export type MachineAdminReport = z.infer<typeof MachineAdminReport>;

/** The MCP server name of the admin tools inside a machine-admin job (tools are `mcp__remyral-admin__*`). */
export const ADMIN_MCP_SERVER = 'remyral-admin';
