import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { AttemptId, Ed25519Signature, Identifier, JobId, Timestamp } from './common.js';
import { LeaseKey } from './lease.js';
import { AssignedRepoEgress } from './repo-egress.js';
import { canonicalPolicyJson } from './runtime-policy.js';

/**
 * p19-ide W2 (docs/design/p19-ide.md §3, §7, ADR-0066): "Tam IDE" — openvscode-server as a sandboxed workspace per
 * (project, user) on a Linux worker, reached by the browser only through the master over the STREAM_* plane.
 *
 * Wire (all control messages, never in the durable outbox; the master's desired state lives in Postgres and is
 * reconciled against CAPABILITIES.ide after every reconnect, like services):
 *
 *  master → worker  IDE_START        {spec, revision, issuedAt, gitToken?, signature}   prepare + start the IDE server
 *  master → worker  IDE_CONTROL      {workspaceId, op: stop | remove, reason, issuedAt, signature}
 *  master → worker  IDE_GIT          {requestId, workspaceId, op: status | push | diff, message?, gitToken?, signature}
 *  master → worker  IDE_FILE_REQUEST {requestId, workspaceId, path}   lines of a workspace file for a chat reference
 *  master → worker  IDE_NOTICE       {workspaceId, eventId, status, message, url?}   answer to a bridge request
 *  worker → master  IDE_STATUS       {workspaceId, revision, state, …}   on every change and every minute while alive
 *  worker → master  IDE_GIT_RESULT   {requestId, status, branch, head, …}
 *  worker → master  IDE_FILE_DATA    {requestId, status, text?}
 *  worker → master  IDE_EVENT        {workspaceId, eventId, kind: terminal.open | reference | push, …}   from the bridge
 *
 * Every master message that changes something on the machine is signed with the lease key (like SERVICE_*), at most
 * 5 minutes old. Git write tokens travel only in IDE_GIT (push) and never enter the IDE's environment: the daemon pushes
 * for the IDE through its hardened git path.
 */

export const IDE_FEATURE = 'ide-v1';

export const IDE_LIMITS = {
  /** Running IDE servers per machine (the worker refuses more). */
  perMachine: 2,
  /** Memory per IDE server (MiB): default and bounds (default 4 GB). */
  memoryMb: 4096,
  minMemoryMb: 1024,
  maxMemoryMb: 16384,
  /** Idle stop (minutes): default and bounds (default 30 min). */
  idleMinutes: 30,
  minIdleMinutes: 10,
  maxIdleMinutes: 240,
  /** Workspaces per (project, user) that are not deleted (the master refuses more). */
  perUserProject: 3,
  commitMessageMaxChars: 2000,
  /** A workspace file returned for a chat reference (bytes). */
  fileMaxBytes: 256 * 1024,
  /** p19-ide W4: the unified diff IDE_GIT `diff` returns at most (characters) and the files it lists. */
  diffMaxChars: 96 * 1024,
  diffMaxFiles: 300,
} as const;

/** A workspace name: lower-case letters, digits and hyphens (unique per project and user). */
export const IdeWorkspaceName = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    'workspace name: 1–32 lower-case letters, digits, hyphens',
  );
export type IdeWorkspaceName = z.infer<typeof IdeWorkspaceName>;

/** The user part of an IDE branch (derived from the username by the master). */
export const IdeUserSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'user slug');

/** `remyral/ide/<user slug>/<workspace name>` — the only branch an IDE workspace pushes. */
export const IdeBranch = z
  .string()
  .max(80)
  .regex(
    /^remyral\/ide\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    'IDE branch',
  );
export type IdeBranch = z.infer<typeof IdeBranch>;

/** Lower-cased, dash-separated slug of a username (≤ 32 chars); `user` when nothing is left. */
export function ideUserSlug(username: string): string {
  const s = username
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return s === '' ? 'user' : s;
}

export function ideBranch(userSlug: string, name: string): string {
  return `remyral/ide/${userSlug}/${name}`;
}

/** The URL path prefix the IDE server is served under on the IDE origin (`--server-base-path`). */
export function ideBasePath(workspaceId: string): string {
  return `/w/${workspaceId}`;
}

/** A repository-relative path (no absolute paths, no `..`, no NUL / backslash). */
export const IdeRelPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
    'a relative path inside the workspace',
  );

/** Where the workspace's files come from. */
export const IdeSource = z.discriminatedUnion('kind', [
  /** Repository project: a worktree of the worker's mirror on the workspace's own branch. */
  z.strictObject({
    kind: z.literal('repository'),
    repositoryUrl: z.string().min(1).max(2048),
    /** Where a new branch starts (a branch / tag name or a full sha). An existing remote branch is continued. */
    baseRef: z.string().min(1).max(256),
    branch: IdeBranch,
  }),
  /**
   * Workspace project: a working directory on the machine, optionally seeded (copied once, at creation) from a kept
   * working directory of a job on this machine (p15-workspace-retention).
   */
  z.strictObject({
    kind: z.literal('files'),
    seed: z.strictObject({ jobId: JobId, attemptId: AttemptId }).nullable(),
  }),
]);
export type IdeSource = z.infer<typeof IdeSource>;

/** What the worker runs (master-built, signed). Every field is explicit so both sides hash the same bytes. */
export const IdeSpec = z.strictObject({
  workspaceId: z.uuid(),
  projectId: Identifier,
  /** The user the workspace belongs to (the console user id). */
  userId: z.string().min(1).max(128),
  name: IdeWorkspaceName,
  source: IdeSource,
  memoryMb: z.number().int().min(IDE_LIMITS.minMemoryMb).max(IDE_LIMITS.maxMemoryMb),
  idleMinutes: z.number().int().min(IDE_LIMITS.minIdleMinutes).max(IDE_LIMITS.maxIdleMinutes),
  /** The sandbox profile of the server (the container profile is a later stretch: the port is not on the host). */
  sandboxProfile: z.literal('host-restricted'),
  /** Author and committer of the commits "Gönder" makes (the user's git identity). */
  gitAuthor: z.strictObject({ name: z.string().min(1).max(128), email: z.string().min(3).max(254) }),
  /**
   * p21-service-egress: the project's effective repository egress policy (p14-repo-egress, as for its jobs), set by
   * the master when it sends the start to a worker with `service-egress-v1`; signed with the spec. Absent: model
   * APIs only.
   */
  network: AssignedRepoEgress.optional(),
});
export type IdeSpec = z.infer<typeof IdeSpec>;

export function ideSpecHash(spec: IdeSpec): string {
  return createHash('sha256').update(canonicalPolicyJson(spec), 'utf8').digest('hex');
}

export const IdeSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });
export type IdeSignature = z.infer<typeof IdeSignature>;

// ------------------------------------------------------------------------------------------ W3: extensions + settings

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): IDE extensions from the master's Open VSX cache and per-user settings sync.
 * Workers with it accept IDE_START `profile` + `downloadToken` (the profile is covered by the signature), download the
 * listed VSIX blobs from the master (`GET /v1/worker/ide/extensions/<sha256>`, bearer = the start's download token),
 * verify their SHA-256, keep them in an offline cache, install exactly that set into the workspace's extensions dir,
 * write VS Code's `extensions.allowed` and the project's enforced settings as machine settings, and run the bridge
 * extension v2 (settings sync: IDE_EVENT `settings`, answered with IDE_NOTICE).
 */
export const IDE_EXTENSIONS_FEATURE = 'ide-extensions-v1';

/**
 * p19-ide W2b (docs/design/p19-ide.md "Implementation (W2b)"): the worker runs IDE workspaces on macOS and Windows
 * too (code-server, MIT, pinned per platform) when its sandbox can host the server. Without it the master treats a
 * non-Linux machine as one whose worker release cannot run the IDE ("update the machine"), whatever CAPABILITIES.ide
 * says; with it the machine's own report decides (`available`, `reasonCode`).
 */
export const IDE_PLATFORMS_FEATURE = 'ide-platforms-v1';

export const IDE_EXTENSION_LIMITS = {
  /** Largest VSIX the master caches (bytes). */
  vsixMaxBytes: 100 * 1024 * 1024,
  /** Extensions one workspace start installs (required + the user's list + their allowed dependencies). */
  perWorkspace: 100,
  /** A user's own extension list. */
  perUser: 100,
  /** Entries of the admin allowlist. */
  allowlist: 500,
  /** One synced settings file (settings.json / keybindings.json), UTF-8 bytes. */
  settingsMaxBytes: 256 * 1024,
  /** The project's enforced settings (JSON bytes). */
  enforcedMaxBytes: 32 * 1024,
} as const;

/** `publisher.name` of an extension (lower-cased; Open VSX namespace + name). */
export const IdeExtensionId = z
  .string()
  .max(129)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9._-]{0,63}$/, 'extension id: publisher.name');
export type IdeExtensionId = z.infer<typeof IdeExtensionId>;

/** An extension version (semver-like; Open VSX allows build parts). */
export const IdeExtensionVersion = z
  .string()
  .max(64)
  .regex(/^[0-9][0-9A-Za-z.+-]{0,63}$/, 'extension version');

/**
 * The VS Code target platforms the master caches (`universal` fits every machine). W3: the Linux builds; W2b adds the
 * macOS and Windows builds (`ide-platforms-v1` machines).
 */
export const IdeTargetPlatform = z.enum([
  'universal',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
]);
export type IdeTargetPlatform = z.infer<typeof IdeTargetPlatform>;

/** One extension a workspace start installs: the master's cached, verified VSIX. */
export const IdeExtensionRef = z.strictObject({
  id: IdeExtensionId,
  version: IdeExtensionVersion,
  targetPlatform: IdeTargetPlatform,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(1).max(IDE_EXTENSION_LIMITS.vsixMaxBytes),
});
export type IdeExtensionRef = z.infer<typeof IdeExtensionRef>;

/** VS Code setting keys of the enforced settings (no `[language]` blocks with odd keys beyond this shape). */
const SettingKey = z.string().min(1).max(200);

/** What a start installs and enforces besides the spec (W3; signed together with it). */
export const IdeProfile = z.strictObject({
  /** Exactly the set to install (required + the user's list + allowed dependencies), resolved by the master. */
  extensions: z.array(IdeExtensionRef).max(IDE_EXTENSION_LIMITS.perWorkspace),
  /** Ids written into VS Code's `extensions.allowed` (the bridge extension is always added by the worker). */
  allowed: z.array(IdeExtensionId).max(IDE_EXTENSION_LIMITS.allowlist),
  /** The project's enforced settings (written as machine settings; a folder's `.vscode/settings.json` still wins). */
  enforcedSettings: z
    .record(SettingKey, z.unknown())
    .refine(
      (o) => JSON.stringify(o).length <= IDE_EXTENSION_LIMITS.enforcedMaxBytes,
      'enforced settings too large',
    ),
  /** Settings sync on: the worker fetches the user's settings at start and the bridge saves changes back. */
  settingsSync: z.boolean(),
});
export type IdeProfile = z.infer<typeof IdeProfile>;

export function ideProfileHash(profile: IdeProfile): string {
  // Settings values are JSON (parsed from JSON on both sides), so the canonical form is defined for them.
  return createHash('sha256')
    .update(canonicalPolicyJson(profile as unknown as Parameters<typeof canonicalPolicyJson>[0]), 'utf8')
    .digest('hex');
}

/** The download token of a start (32 random bytes, base64url). */
export const IdeDownloadToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `GET /v1/worker/ide/settings/<workspaceId>` answer: the user's synced settings files (null: none stored). */
export const IdeSyncedSettings = z.object({
  settings: z.string().max(IDE_EXTENSION_LIMITS.settingsMaxBytes).nullable(),
  keybindings: z.string().max(IDE_EXTENSION_LIMITS.settingsMaxBytes).nullable(),
});
export type IdeSyncedSettings = z.infer<typeof IdeSyncedSettings>;

/** master → worker `IDE_START` (control). A higher `revision` replaces the spec; the same one restarts a stopped IDE. */
export const IdeStartPayload = z.object({
  spec: IdeSpec,
  revision: z.number().int().min(1).max(1_000_000),
  issuedAt: Timestamp,
  /** Repository sources: a short-lived **read-only** token for the worker's own fetch (never in the IDE's env). */
  gitToken: z.string().min(1).max(4096).optional(),
  gitTokenUsername: z.string().min(1).max(128).optional(),
  /** W3 (`ide-extensions-v1` workers only): extensions + enforced settings; covered by the signature. */
  profile: IdeProfile.optional(),
  /** W3: bearer token for this start's downloads (VSIX blobs, the user's settings); 30 minutes, this worker only. */
  downloadToken: IdeDownloadToken.optional(),
  signature: IdeSignature.optional(),
});
export type IdeStartPayload = z.infer<typeof IdeStartPayload>;

/** master → worker `IDE_CONTROL` (control). `stop` keeps the files; `remove` deletes the checkout and the IDE state. */
export const IdeControlPayload = z.object({
  workspaceId: z.uuid(),
  op: z.enum(['stop', 'remove']),
  reason: z.string().max(200),
  issuedAt: Timestamp,
  signature: IdeSignature.optional(),
});
export type IdeControlPayload = z.infer<typeof IdeControlPayload>;

/**
 * master → worker `IDE_GIT` (control). `push` commits everything (with `message`) and pushes the IDE branch. p19-ide W4:
 * `diff` reads the uncommitted changes (read-only; only to machines with `ide-diff-v1`).
 */
export const IdeGitPayload = z.object({
  requestId: z.uuid(),
  workspaceId: z.uuid(),
  op: z.enum(['status', 'push', 'diff']),
  message: z.string().min(1).max(IDE_LIMITS.commitMessageMaxChars).optional(),
  /** p19-ide W4 (`diff`): one path to narrow the diff to (signed with the request). */
  path: IdeRelPath.optional(),
  /** `push`: a just-minted write token for the project's repository (used once, never stored, never in the IDE). */
  gitToken: z.string().min(1).max(4096).optional(),
  gitTokenUsername: z.string().min(1).max(128).optional(),
  issuedAt: Timestamp,
  signature: IdeSignature.optional(),
});
export type IdeGitPayload = z.infer<typeof IdeGitPayload>;

/** master → worker `IDE_FILE_REQUEST` (control): a file of the workspace for a chat reference (owner only). */
export const IdeFileRequestPayload = z.object({
  requestId: z.uuid(),
  workspaceId: z.uuid(),
  path: IdeRelPath,
});
export type IdeFileRequestPayload = z.infer<typeof IdeFileRequestPayload>;

/** master → worker `IDE_NOTICE` (control): the answer to a bridge request (IDE_EVENT `push`). */
export const IdeNoticePayload = z.object({
  workspaceId: z.uuid(),
  eventId: z.uuid(),
  status: z.enum(['ok', 'refused', 'failed']),
  message: z.string().max(300),
  url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});
export type IdeNoticePayload = z.infer<typeof IdeNoticePayload>;

export const IdeState = z.enum([
  /** Checkout / working dir and the pinned server being prepared. */
  'preparing',
  /** The server process started; waiting for it to listen. */
  'starting',
  /** Up: streams reach it. */
  'running',
  /** Stopped (on request, idle, memory, worker restart); files kept. */
  'stopped',
  /** Gave up (checkout failed, server exited, install failed). */
  'failed',
  /** The worker would not start it (signature, limits, platform …). */
  'refused',
  /** Files deleted (after IDE_CONTROL remove). */
  'removed',
]);
export type IdeState = z.infer<typeof IdeState>;

export const IdeStopReason = z.enum(['requested', 'idle', 'memory', 'worker', 'exited', 'error']);
export type IdeStopReason = z.infer<typeof IdeStopReason>;

/** States in which the server process is (meant to be) alive. */
export const LIVE_IDE_STATES: readonly IdeState[] = ['preparing', 'starting', 'running'];

/** worker → master `IDE_STATUS` (control). */
export const IdeStatusPayload = z.object({
  workspaceId: z.uuid(),
  revision: z.number().int().min(0).max(1_000_000),
  state: IdeState,
  /** Plain-language reason (refusals, exits); never the server's own output. */
  detail: z.string().max(300).optional(),
  stopReason: IdeStopReason.optional(),
  startedAt: Timestamp.optional(),
  /** Open browser streams on this worker right now. */
  streams: z.number().int().min(0).max(10_000).optional(),
  /** Last stream / request activity the worker saw. */
  lastActivityAt: Timestamp.optional(),
  branch: z.string().max(256).optional(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  cpuPercent: z.number().min(0).max(100_000).optional(),
  memoryBytes: z.number().int().min(0).optional(),
  /** W3: what the start installed and what it could not (id + plain reason); sent once the server runs. */
  extensions: z
    .object({
      installed: z.array(IdeExtensionId).max(IDE_EXTENSION_LIMITS.perWorkspace),
      failed: z
        .array(z.object({ id: IdeExtensionId, reason: z.string().max(200) }))
        .max(IDE_EXTENSION_LIMITS.perWorkspace),
    })
    .optional(),
  at: Timestamp,
});
export type IdeStatusPayload = z.infer<typeof IdeStatusPayload>;

/** worker → master `IDE_GIT_RESULT` (control). */
export const IdeGitResultPayload = z.object({
  requestId: z.uuid(),
  workspaceId: z.uuid(),
  status: z.enum(['ok', 'refused', 'failed']),
  /** Machine-readable reason (`secret_found`, `rejected`, `nothing_to_push`, `not_found`, `no_repository` …). */
  reason: z.string().max(64).optional(),
  detail: z.string().max(300).optional(),
  branch: z.string().max(256).optional(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** `push`: a commit was made from uncommitted changes. */
  committed: z.boolean().optional(),
  /** `push`: the branch reached the remote. */
  pushed: z.boolean().optional(),
  /** Uncommitted changed files and commits not on the remote branch (status). */
  changedFiles: z.number().int().min(0).max(1_000_000).optional(),
  ahead: z.number().int().min(0).max(1_000_000).nullable().optional(),
  /** p19-ide W4 (`diff`): the changed tracked files against HEAD with their line counts (binary: null counts). */
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        status: z.enum(['added', 'modified', 'deleted', 'renamed', 'other']),
        additions: z.number().int().min(0).nullable(),
        deletions: z.number().int().min(0).nullable(),
      }),
    )
    .max(IDE_LIMITS.diffMaxFiles)
    .optional(),
  /** p19-ide W4 (`diff`): files git does not track yet (not in the unified diff). */
  untracked: z.array(z.string().min(1).max(1024)).max(IDE_LIMITS.diffMaxFiles).optional(),
  /** p19-ide W4 (`diff`): `git diff HEAD` (no external diff / textconv), cut to {@link IDE_LIMITS.diffMaxChars}. */
  diff: z.string().max(IDE_LIMITS.diffMaxChars).optional(),
  /** p19-ide W4 (`diff`): the file list or the diff text was cut. */
  truncated: z.boolean().optional(),
});
export type IdeGitResultPayload = z.infer<typeof IdeGitResultPayload>;

/** worker → master `IDE_FILE_DATA` (control). */
export const IdeFileDataPayload = z.object({
  requestId: z.uuid(),
  workspaceId: z.uuid(),
  status: z.enum(['ok', 'not_found', 'too_large', 'binary', 'refused']),
  text: z.string().max(IDE_LIMITS.fileMaxBytes).optional(),
});
export type IdeFileDataPayload = z.infer<typeof IdeFileDataPayload>;

/** worker → master `IDE_EVENT` (control): what the bridge extension reports or asks for. */
export const IdeEventPayload = z.discriminatedUnion('kind', [
  /** A terminal was opened in the IDE (audit, best effort). */
  z.object({
    kind: z.literal('terminal.open'),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    at: Timestamp,
    name: z.string().max(80).optional(),
  }),
  /** "Sohbete ekle": lines of a workspace file become a pending chat reference of the owner. */
  z.object({
    kind: z.literal('reference'),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    at: Timestamp,
    path: IdeRelPath,
    startLine: z.number().int().min(1).max(1_000_000),
    endLine: z.number().int().min(1).max(1_000_000),
  }),
  /** "Gönder": commit + push the IDE branch, optionally open / update a pull request. Answered with IDE_NOTICE. */
  z.object({
    kind: z.literal('push'),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    at: Timestamp,
    message: z.string().min(1).max(IDE_LIMITS.commitMessageMaxChars),
    pullRequest: z.boolean(),
  }),
  /**
   * W3 (`ide-extensions-v1`): the bridge saves the user's settings.json / keybindings.json (≤ 256 KiB, secret-scanned
   * by the master; a secret-looking value is refused). Answered with IDE_NOTICE.
   */
  z.object({
    kind: z.literal('settings'),
    workspaceId: z.uuid(),
    eventId: z.uuid(),
    at: Timestamp,
    file: z.enum(['settings', 'keybindings']),
    content: z.string().max(IDE_EXTENSION_LIMITS.settingsMaxBytes),
  }),
]);
export type IdeEventPayload = z.infer<typeof IdeEventPayload>;

/** CAPABILITIES.ide (with `ide-v1`): whether this machine can run IDEs and which workspaces it holds. */
/**
 * p19-ide W2b: why a machine cannot run an IDE, as a code the console translates (`reason` stays the English detail).
 * `disabled_locally` — the machine owner refused it (local ceiling); `platform_unsupported` — no pinned server build for
 * this OS / CPU; `sandbox_unavailable` — the host-restricted sandbox is not ready; `seatbelt_required` — macOS without
 * Seatbelt; `windows_accounts_required` — Windows without the per-job account pool; `profile_not_allowed` — the
 * host-restricted profile is off for the machine; `no_workspace_root` — no usable workspace root.
 */
export const IdeUnavailableCode = z.enum([
  'disabled_locally',
  'platform_unsupported',
  'sandbox_unavailable',
  'seatbelt_required',
  'windows_accounts_required',
  'profile_not_allowed',
  'no_workspace_root',
]);
export type IdeUnavailableCode = z.infer<typeof IdeUnavailableCode>;

/** p19-ide W2b: the IDE server a worker runs on this machine. */
export const IdeServerKind = z.enum(['openvscode-server', 'code-server']);
export type IdeServerKind = z.infer<typeof IdeServerKind>;

export const IdeReport = z.object({
  /** False: the machine cannot run the IDE (no server build, no sandbox, owner refused it locally …). */
  available: z.boolean(),
  reason: z.string().max(200).optional(),
  /** W2b (additive): {@link IdeUnavailableCode} for `available: false`. */
  reasonCode: IdeUnavailableCode.optional(),
  /** The pinned server version of this worker release (openvscode-server on Linux, code-server on macOS / Windows). */
  serverVersion: z.string().max(64).optional(),
  /** W2b (additive): which server that version names. */
  serverKind: IdeServerKind.optional(),
  max: z.number().int().min(0).max(16),
  workspaces: z
    .array(
      z.object({
        workspaceId: z.uuid(),
        revision: z.number().int().min(0).max(1_000_000),
        state: IdeState,
        since: Timestamp,
      }),
    )
    .max(64),
});
export type IdeReport = z.infer<typeof IdeReport>;

// ------------------------------------------------------------------------------------------ signatures

export const IDE_START_CONTEXT = 'remyral-ide-start/v1';
export const IDE_CONTROL_CONTEXT = 'remyral-ide-control/v1';
export const IDE_GIT_CONTEXT = 'remyral-ide-git/v1';
/** An IDE_START / CONTROL / GIT older than this is refused (re-sends carry a fresh `issuedAt`). */
export const IDE_MESSAGE_MAX_AGE_MS = 5 * 60_000;
export const IDE_CLOCK_SKEW_MS = 2 * 60_000;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface IdeStartBinding {
  readonly workerId: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly spec: IdeSpec;
  /** W3: the start's extension profile; when present its hash is a further line of the statement. */
  readonly profile?: IdeProfile | undefined;
}

export function ideStartStatement(b: IdeStartBinding): Buffer {
  return Buffer.from(
    [
      IDE_START_CONTEXT,
      b.workerId,
      b.spec.workspaceId,
      String(b.revision),
      b.issuedAt,
      ideSpecHash(b.spec),
      ...(b.profile === undefined ? [] : [`profile:${ideProfileHash(b.profile)}`]),
    ].join('\n'),
    'utf8',
  );
}

export interface IdeControlBinding {
  readonly workerId: string;
  readonly workspaceId: string;
  readonly op: IdeControlPayload['op'];
  readonly issuedAt: string;
}

export function ideControlStatement(b: IdeControlBinding): Buffer {
  return Buffer.from([IDE_CONTROL_CONTEXT, b.workerId, b.workspaceId, b.op, b.issuedAt].join('\n'), 'utf8');
}

export interface IdeGitBinding {
  readonly workerId: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly op: IdeGitPayload['op'];
  readonly message: string | undefined;
  readonly issuedAt: string;
  /** p19-ide W4: the `diff` path (only then part of the statement, so status / push statements are unchanged). */
  readonly path?: string | undefined;
}

export function ideGitStatement(b: IdeGitBinding): Buffer {
  return Buffer.from(
    [
      IDE_GIT_CONTEXT,
      b.workerId,
      b.workspaceId,
      b.requestId,
      b.op,
      sha256Hex(b.message ?? ''),
      b.issuedAt,
      ...(b.path === undefined ? [] : [sha256Hex(b.path)]),
    ].join('\n'),
    'utf8',
  );
}

const signWith = (statement: Buffer, kid: string, key: KeyObject): IdeSignature => ({
  kid,
  signature: sign(null, statement, key).toString('base64url'),
});

export function signIdeStart(b: IdeStartBinding, kid: string, key: KeyObject): IdeSignature {
  return signWith(ideStartStatement(b), kid, key);
}
export function signIdeControl(b: IdeControlBinding, kid: string, key: KeyObject): IdeSignature {
  return signWith(ideControlStatement(b), kid, key);
}
export function signIdeGit(b: IdeGitBinding, kid: string, key: KeyObject): IdeSignature {
  return signWith(ideGitStatement(b), kid, key);
}

export type IdeVerdict = 'ok' | 'missing' | 'unknown_key' | 'bad_signature';

function verifyWith(
  statement: Buffer,
  signature: IdeSignature | undefined,
  keys: readonly LeaseKey[],
): IdeVerdict {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, statement, signature.signature) ? 'ok' : 'bad_signature';
}

/** Never throws. */
export function verifyIdeStart(
  b: IdeStartBinding,
  s: IdeSignature | undefined,
  keys: readonly LeaseKey[],
): IdeVerdict {
  return verifyWith(ideStartStatement(b), s, keys);
}
export function verifyIdeControl(
  b: IdeControlBinding,
  s: IdeSignature | undefined,
  keys: readonly LeaseKey[],
): IdeVerdict {
  return verifyWith(ideControlStatement(b), s, keys);
}
export function verifyIdeGit(
  b: IdeGitBinding,
  s: IdeSignature | undefined,
  keys: readonly LeaseKey[],
): IdeVerdict {
  return verifyWith(ideGitStatement(b), s, keys);
}

/** `issuedAt` within the accepted window (worker side). */
export function ideMessageFresh(issuedAt: string, now: Date, maxAgeMs = IDE_MESSAGE_MAX_AGE_MS): boolean {
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime() + IDE_CLOCK_SKEW_MS && now.getTime() - t <= maxAgeMs + IDE_CLOCK_SKEW_MS;
}
