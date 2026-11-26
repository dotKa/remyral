import { z } from 'zod';
import { AttemptId, Epoch, Identifier, NonNegativeInt, Timestamp } from './common.js';

/**
 * p11-session-continuity (docs/design/p11-session-continuity.md, ADR-0042): a running attempt survives a worker
 * restart (crash, update, reboot). While it runs, the worker takes cheap periodic checkpoints (a WIP commit on a hidden
 * ref for repository jobs, a snapshot manifest for workspace jobs, the runtime session pointer and the recent tool
 * calls) recorded durably on its disk; after a restart it re-validates the workspace and reports the attempt as
 * resumable in its first HEARTBEAT; the master parks the job (PAUSED, cause `worker_restart`) and resumes the same
 * attempt on the same machine under a new epoch (`execution.resume{cause: "worker_restart"}`).
 *
 * Pure schemas and rules shared by master, worker and web. All additive in protocol 1.0:
 * - feature `session-continuity-v1`;
 * - ASSIGN_JOB `execution.continuity` (checkpoint policy; only to workers with the feature — its presence is also what
 *   lets the worker report checkpoints and recover the attempt after a restart);
 * - CHECKPOINT_REPORT (worker → master, control job message, seq 0; small metadata only);
 * - HEARTBEAT `recoverableJobs` (attempts the restarted worker can resume, or why not);
 * - ASSIGN_JOB `execution.resume` with `cause: "worker_restart"`.
 */

export const SESSION_CONTINUITY_FEATURE = 'session-continuity-v1';

/** Bounds of the checkpoint policy. */
export const CONTINUITY_LIMITS = {
  minIntervalSec: 15,
  maxIntervalSec: 3600,
  maxBytes: 4 * 1024 * 1024 * 1024,
  maxFiles: 200_000,
  maxKeep: 50,
  maxRestarts: 5,
} as const;

/** Platform defaults: a checkpoint every 2 minutes (when something changed), up to 512 MiB / 50 000 changed files. */
export const CONTINUITY_DEFAULTS = {
  intervalSec: 120,
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 50_000,
  keep: 10,
  maxRestarts: 2,
} as const;

/** ASSIGN_JOB `execution.continuity`: checkpoint and restart-recovery policy of this attempt. */
export const ContinuityPolicy = z.object({
  /** Take a checkpoint this often (skipped when nothing changed since the last one). */
  intervalSec: z.number().int().min(CONTINUITY_LIMITS.minIntervalSec).max(CONTINUITY_LIMITS.maxIntervalSec),
  /** Skip a checkpoint whose changed files (vs. the base / the last snapshot) exceed this size. */
  maxBytes: z.number().int().min(0).max(CONTINUITY_LIMITS.maxBytes),
  maxFiles: z.number().int().min(0).max(CONTINUITY_LIMITS.maxFiles),
  /** Checkpoints kept per attempt (older hidden refs / snapshots are dropped). */
  keep: z.number().int().min(1).max(CONTINUITY_LIMITS.maxKeep),
  /** How many worker restarts one attempt may resume from (a crash loop then falls back to the old reconciliation). */
  maxRestarts: z.number().int().min(0).max(CONTINUITY_LIMITS.maxRestarts),
});
export type ContinuityPolicy = z.infer<typeof ContinuityPolicy>;

export function defaultContinuityPolicy(): ContinuityPolicy {
  return { ...CONTINUITY_DEFAULTS };
}

// ------------------------------------------------------------------------------------------------- tool classes

/**
 * How safe it is to run a tool call again after a restart:
 * - `idempotent`: reads, searches, listings — re-running changes nothing;
 * - `workspace_write`: edits / writes inside the attempt's workspace — safe to redo from the checkpoint;
 * - `external`: side effects outside the workspace (git push, deploy / publish, network writes, package installs, ops
 *   and sub-job tools, approvals) — never re-run silently: surfaced to the agent as "unknown outcome";
 * - `unknown`: anything not recognised (treated like `external`).
 */
export const ToolClass = z.enum(['idempotent', 'workspace_write', 'external', 'unknown']);
export type ToolClass = z.infer<typeof ToolClass>;

const READ_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'list',
  'find',
  'view',
  'websearch',
  'web_search',
  'webfetch',
  'web_fetch',
  'todoread',
  'todowrite',
  'notebookread',
  'wait_subtask',
  'list_subtasks',
  // p12-deploy-feedback: read-only deploy tools.
  'deploy_status',
  'deploy_logs',
  // p14-ask-user: waiting for an answer reads its state.
  'wait_for_answer',
  // p15-services: reading the project's services and a service's logs.
  'list_services',
  'service_logs',
  'task',
  'exitplanmode',
]);
const WRITE_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'patch',
  'str_replace_editor',
  'create',
]);
const EXTERNAL_TOOLS = new Set([
  'request_subtask',
  'cancel_subtask',
  'publish_site',
  'request_redeploy',
  // p14-ask-user: asking shows a card and notifies people.
  'ask_user',
  // p15-services: starting / stopping / restarting a service outlives the job.
  'start_service',
  'stop_service',
  'restart_service',
  'open_preview',
  'share_preview',
  'machine_admin',
  'run_admin',
  'admin_run',
]);
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'exec', 'command', 'terminal', 'run_command']);

/** The command of a shell tool call from its input summary (a JSON object with `command`, or the plain command). */
export function shellCommandOf(inputSummary: string): string {
  const m = /"(?:command|cmd)"\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/.exec(inputSummary);
  if (m?.[1] !== undefined) {
    try {
      const v: unknown = JSON.parse(m[1]);
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map(String).join(' ');
    } catch {
      return m[1];
    }
  }
  return inputSummary;
}

/** Shell commands with effects outside the workspace (checked first; any match = external). */
const EXTERNAL_COMMAND: readonly RegExp[] = [
  /\bgit\s+(?:-c\s+\S+\s+)*(?:push|send-email|request-pull)\b/,
  /\bgh\s+(?:pr|release|repo|issue|api|workflow|secret|gist)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|deploy|login|adduser|dist-tag)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|upgrade|remove|rm|uninstall)\b/,
  /\b(?:pip3?|uv|poetry|pipx|conda|gem|cargo|go|brew|apt|apt-get|yum|dnf|apk|choco|winget|scoop|composer)\s+(?:install|add|get|update|upgrade|publish|remove|uninstall)\b/,
  /\b(?:docker|podman)\s+(?:push|login|run|compose|build|rm|stop|kill)\b/,
  /\b(?:kubectl|helm|terraform|pulumi|ansible-playbook|flyctl|fly|vercel|netlify|wrangler|firebase|heroku|railway|coolify|serverless|sls)\b/,
  /\b(?:aws|gcloud|az|doctl)\s+\S+/,
  /\b(?:ssh|scp|sftp|rsync|ftp)\b/,
  /\bcurl\b.*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|\s--request\s+(?:POST|PUT|PATCH|DELETE)|\s(?:-d|--data\S*|-F|--form|-T|--upload-file)\b)/i,
  /\bwget\b.*--(?:post|method)/i,
  /\bInvoke-(?:WebRequest|RestMethod)\b.*-Method\s+(?:Post|Put|Patch|Delete)/i,
  /\b(?:systemctl|service|launchctl|sc(?:\.exe)?|shutdown|reboot|sudo|doas|runas)\b/,
  /\b(?:deploy|publish|release)(?:\.sh|\.ps1)?\b/,
];

/** Shell commands that only read (all segments of the command must match). */
const READ_COMMAND =
  /^(?:cd|pwd|ls|dir|cat|type|head|tail|less|more|wc|grep|rg|ag|find|fd|tree|stat|file|echo|printf|which|where|whoami|date|env|printenv|sort|uniq|cut|tr|diff|cmp|jq|true|false|test|\[|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|blame|grep|describe|remote\s+-v|config\s+--get)|Get-(?:ChildItem|Content|Item|Location)|Select-String)(?:\s|$)/i;

function classifyShell(command: string): ToolClass {
  const cmd = command.trim();
  if (cmd === '') return 'unknown';
  if (EXTERNAL_COMMAND.some((re) => re.test(cmd))) return 'external';
  const segments = cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length > 0 && segments.every((s) => READ_COMMAND.test(s)) && !/[>]/.test(cmd)) {
    return 'idempotent';
  }
  // A local command of unknown effect: build, test, script… It may write outside the workspace or call out.
  return 'unknown';
}

/**
 * Classifies one tool call by the runtime's tool name and its (redacted, bounded) input summary. Deterministic and
 * conservative: anything not recognised is `unknown` (treated like `external` on a resume).
 */
export function classifyToolCall(toolName: string, inputSummary: string): ToolClass {
  const raw = toolName.trim();
  const name = raw.toLowerCase();
  if (name.startsWith('mcp:') || name.startsWith('mcp__')) {
    const leaf = name.split(/\/|__/).pop() ?? '';
    if (EXTERNAL_TOOLS.has(leaf)) return 'external';
    if (READ_TOOLS.has(leaf)) return 'idempotent';
    if (/^(?:get|list|read|search|find|view|wait|status|describe)/.test(leaf)) return 'idempotent';
    return 'external';
  }
  if (EXTERNAL_TOOLS.has(name)) return 'external';
  if (READ_TOOLS.has(name)) return 'idempotent';
  if (WRITE_TOOLS.has(name)) return 'workspace_write';
  if (SHELL_TOOLS.has(name)) return classifyShell(shellCommandOf(inputSummary));
  return 'unknown';
}

/** A class whose in-flight call is never re-run silently after a restart. */
export function needsVerification(c: ToolClass): boolean {
  return c === 'external' || c === 'unknown';
}

// ------------------------------------------------------------------------------------------------- reports

/** One tool call as a checkpoint / restart report carries it (no input text; the master shows the summary it has). */
export const ToolCallNote = z.object({
  callId: Identifier.optional(),
  toolName: z.string().min(1).max(128),
  class: ToolClass,
  /** `running`: started, no result yet (in flight at the checkpoint or the crash). */
  state: z.enum(['running', 'done', 'failed']),
});
export type ToolCallNote = z.infer<typeof ToolCallNote>;

const RuntimeSessionId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const CheckpointRef = z
  .string()
  .regex(/^refs\/remana\/checkpoints\/[A-Za-z0-9_.:-]{1,128}\/[0-9]{1,6}$/)
  .max(200);
const CommitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** CHECKPOINT_REPORT payload (control job message, fenced by the live lease): one checkpoint the worker recorded. */
export const CheckpointReportPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  /** 1, 2, … per attempt. */
  n: z.number().int().min(1).max(999_999),
  at: Timestamp,
  /** `git`: WIP commit on a hidden ref (never the work branch, never pushed); `snapshot`: workspace manifest (+copy). */
  kind: z.enum(['git', 'snapshot']),
  ref: CheckpointRef.optional(),
  commit: CommitSha.optional(),
  /** Files changed since the attempt's base (git) / files in the snapshot. */
  files: NonNegativeInt,
  bytes: NonNegativeInt,
  runtimeSessionId: RuntimeSessionId.optional(),
  /** The last tool call that completed, and how many were still in flight. */
  lastTool: ToolCallNote.optional(),
  inFlight: z.number().int().min(0).max(1000),
  activeMs: NonNegativeInt,
});
export type CheckpointReportPayload = z.infer<typeof CheckpointReportPayload>;

/** HEARTBEAT `recoverableJobs[]`: an attempt the restarted worker found on its disk. */
export const RecoverableJob = z.object({
  jobId: Identifier,
  attemptId: AttemptId,
  /** The epoch it ran under before the restart. */
  epoch: Epoch,
  /** Last checkpoint (0: none was taken; the workspace is still resumable from its current state). */
  checkpoint: z.number().int().min(0).max(999_999),
  checkpointAt: Timestamp.optional(),
  activeMs: NonNegativeInt,
  /** `session`: the runtime's own session can be resumed (verified for this runtime/version); else a fresh one. */
  resume: z.enum(['session', 'continuation']),
  runtimeSessionId: RuntimeSessionId.optional(),
  /** Restarts this attempt already resumed from (the next resume is restarts + 1). */
  restarts: z.number().int().min(0).max(100),
  /** Tool calls that were in flight at the crash and need verification (external / unknown). */
  unknownOutcome: z.array(ToolCallNote).max(20),
  /** Set when the attempt cannot be resumed here (integrity check failed, leftovers, too many restarts). */
  problem: z.string().min(1).max(500).optional(),
});
export type RecoverableJob = z.infer<typeof RecoverableJob>;

/** ASSIGN_JOB `execution.resume` after a worker restart (only to `session-continuity-v1` workers). */
export const WorkerRestartResume = z.object({
  cause: z.literal('worker_restart'),
  /** The epoch the attempt ran under before the restart (the worker's record must match). */
  pausedEpoch: Epoch,
  /** The checkpoint the worker reported (display / audit; the worker uses its own record). */
  checkpoint: z.number().int().min(0).max(999_999),
  /** Run time already used; the run gets `maxDurationSec` minus this. */
  activeMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600 * 1000),
  /** Which restart this is (1 = first). */
  restart: z.number().int().min(1).max(100),
});
export type WorkerRestartResume = z.infer<typeof WorkerRestartResume>;

/** Plain-language "Worker restarted — resumed from checkpoint 7 (2 min ago)". */
export function restartSummary(
  checkpoint: number,
  checkpointAt: string | null | undefined,
  now: Date,
): string {
  if (checkpoint <= 0 || checkpointAt === null || checkpointAt === undefined) {
    return 'Worker restarted — resuming from the kept workspace (no checkpoint yet)';
  }
  const ago = Math.max(0, now.getTime() - Date.parse(checkpointAt));
  const min = Math.round(ago / 60_000);
  const when =
    min < 1
      ? 'less than a minute ago'
      : min < 120
        ? `${String(min)} min ago`
        : `${String(Math.round(min / 60))} h ago`;
  return `Worker restarted — resuming from checkpoint ${String(checkpoint)} (${when})`;
}
