import { z } from 'zod';
import { Timestamp } from './common.js';
import { VaultCredentialId } from './worker-config.js';
import { knownHostsProblem } from './git-central-rules.js';

export * from './git-central-rules.js';

/**
 * p15-git-central (docs/design/p15-git-central.md): the platform owns git authentication and git configuration of
 * every repository job, so the owner never has to set up git on a machine.
 *
 *  - Credentials are fetched on demand right before each fetch / push (CREDENTIAL_REQUEST `purpose`), retried once
 *    with a fresh one when the remote refuses them.
 *  - The agent's own git / gh run with a job-local configuration (machine system / global config, credential helpers,
 *    `gh` logins ignored).
 *  - Workers report their **git readiness** (CAPABILITIES.gitReadiness) and apply safe fixes on request
 *    (OPS_COMMAND `git.fix`).
 *  - Non-GitHub / SSH repositories use a project deploy key or HTTPS token from the vault (ASSIGN_JOB
 *    `execution.gitAuth`, a reference — never a value).
 *
 * Everything is additive in protocol 1.0 and sent only to workers that advertise `git-central-v1`.
 */
export const GIT_CENTRAL_FEATURE = 'git-central-v1';

// ------------------------------------------------------------------------------------------------ readiness

/**
 * What the worker found in the **worker account's** git setup. Detection never reads a secret value: credential
 * helpers are classified by kind, URL rewrites and OS-store entries are counted, identities reported as present.
 */
export const GitReadinessCode = z.enum([
  /** No git executable (configured, worker-installed or on PATH): repository jobs cannot run here. */
  'git_missing',
  /** git older than {@link MIN_GIT_VERSION}: the machine's global config cannot be kept away from jobs. */
  'git_too_old',
  /** Global `credential.helper` entries (Git Credential Manager, osxkeychain, store, …) — ignored by jobs. */
  'global_credential_helper',
  /** Global `url.<base>.insteadOf` / `pushInsteadOf` rewrites for github.com — ignored by jobs, confusing by hand. */
  'global_insteadof',
  /** A global URL rewrite whose base URL embeds credentials (`https://user:token@…`) — the value is never read out. */
  'insteadof_with_credentials',
  /** `safe.directory=*` globally: git's repository-ownership protection is off for this account. */
  'safe_directory_wildcard',
  /** Windows: `core.autocrlf=true` globally — jobs set their own (`false`), so it only affects manual work. */
  'autocrlf_true',
  /** A plain-text credential file (`~/.git-credentials`) exists for this account. */
  'credential_store_file',
  /** The OS credential store holds GitHub git credentials (Windows Credential Manager, macOS keychain). */
  'os_store_github',
  /** A global user.name / user.email is set — ignored: commits use the project / workspace identity. */
  'global_identity',
]);
export type GitReadinessCode = z.infer<typeof GitReadinessCode>;

/** Fixes the worker can apply to the worker account's own git setup (OPS_COMMAND `git.fix`). Nothing else. */
export const GitFixId = z.enum([
  /**
   * `git credential reject` for https://github.com through the account's configured helpers (Git Credential Manager,
   * osxkeychain, libsecret, store): removes stale GitHub logins without reading them.
   */
  'erase_github_credentials',
  /** Removes global `url.*.insteadOf` / `pushInsteadOf` entries that rewrite github.com URLs. */
  'remove_github_insteadof',
]);
export type GitFixId = z.infer<typeof GitFixId>;

/** Kind of a configured credential helper (never its command line, which could embed a secret). */
export const GitHelperKind = z.enum([
  'manager',
  'osxkeychain',
  'libsecret',
  'store',
  'cache',
  'wincred',
  'other',
]);
export type GitHelperKind = z.infer<typeof GitHelperKind>;

export const GitReadinessSeverity = z.enum(['blocking', 'warning', 'info']);
export type GitReadinessSeverity = z.infer<typeof GitReadinessSeverity>;

export const GitReadinessProblem = z.object({
  code: GitReadinessCode,
  severity: GitReadinessSeverity,
  /** The fix that resolves it (absent: informational, or only the owner can change it). */
  fix: GitFixId.optional(),
  /** How many entries (helpers, rewrites, store entries). */
  count: z.number().int().min(0).max(10_000).optional(),
  helpers: z.array(GitHelperKind).max(8).optional(),
});
export type GitReadinessProblem = z.infer<typeof GitReadinessProblem>;

export const GitReadinessReport = z.object({
  checkedAt: Timestamp,
  git: z.object({
    present: z.boolean(),
    version: z.string().min(1).max(64).optional(),
    /** Where jobs' git comes from: the worker config (`gitBinary`), a worker-installed copy, or the system. */
    source: z.enum(['config', 'managed', 'system']).optional(),
  }),
  problems: z.array(GitReadinessProblem).max(16),
  /**
   * The worker keeps the machine's system / global git config, credential helpers and `gh` logins away from every
   * git it runs and from the agent's git (true for `git-central-v1` workers with a supported git).
   */
  jobsIsolated: z.boolean(),
  /** The OS credential store could not be inspected here (Linux secret service, a locked keychain). */
  osStoreUnchecked: z.boolean().optional(),
});
export type GitReadinessReport = z.infer<typeof GitReadinessReport>;

/** Problems a one-click "Düzelt" applies: every problem that names a fix. */
export function fixesFor(report: Pick<GitReadinessReport, 'problems'>): GitFixId[] {
  const out = new Set<GitFixId>();
  for (const p of report.problems) if (p.fix !== undefined) out.add(p.fix);
  return GitFixId.options.filter((f) => out.has(f));
}

/** OPS_COMMAND `git.fix` (only to `git-central-v1` workers): the fixes to apply; nothing else is a parameter. */
export const GitFixOp = z.object({
  kind: z.literal('git.fix'),
  fixes: z.array(GitFixId).min(1).max(GitFixId.options.length),
});

/** OPS_UPDATE `gitFix`: per-fix outcome and the readiness found afterwards. */
export const GitFixReport = z.object({
  results: z
    .array(
      z.object({
        fix: GitFixId,
        outcome: z.enum(['applied', 'nothing_to_do', 'failed', 'unsupported']),
        reason: z
          .string()
          .regex(/^[a-z0-9_]{1,64}$/)
          .optional(),
      }),
    )
    .max(GitFixId.options.length),
  readiness: GitReadinessReport,
});
export type GitFixReport = z.infer<typeof GitFixReport>;

// ------------------------------------------------------------------------------------------- project credentials

/** How a project's non-GitHub repository authenticates (a vault credential sealed to the chosen workers). */
export const GitAuthKind = z.enum(['ssh-key', 'https-token']);
export type GitAuthKind = z.infer<typeof GitAuthKind>;

/** HTTPS username for a token (`git`, `oauth2`, `x-token-auth`, `x-access-token`, a user name). */
export const GitAuthUsername = z.string().regex(/^[A-Za-z0-9._@+-]{1,64}$/, 'git username');

/** Pinned known_hosts text (validated by {@link knownHostsProblem}). */
export const KnownHosts = z.string().refine((v) => knownHostsProblem(v) === null, 'known_hosts lines');

/**
 * ASSIGN_JOB `execution.gitAuth` (only to `git-central-v1` workers; repository jobs of projects with a repository
 * credential): which vault credential the worker uses for this job's fetch / push — a reference, never a value. The
 * worker reads `vault-<credentialId>` from its own secret store right before each network command.
 */
export const AssignedGitAuth = z
  .object({
    kind: GitAuthKind,
    credentialId: VaultCredentialId,
    /** https-token: the username sent with the token (default `git`). */
    username: GitAuthUsername.optional(),
    /** ssh-key: the pinned known_hosts lines (required). */
    knownHosts: KnownHosts.optional(),
  })
  .refine((v) => v.kind !== 'ssh-key' || v.knownHosts !== undefined, {
    message: 'an ssh-key credential needs pinned known_hosts lines',
  });
export type AssignedGitAuth = z.infer<typeof AssignedGitAuth>;

/**
 * Variables the worker sets in a repository job's runtime environment so the agent's own git / gh never read the
 * machine's configuration: no system config, a job-local global config (credential helpers reset, the project
 * identity, safe settings), no prompts (Git Credential Manager included), a job-local, empty `gh` config dir (the
 * machine's `gh auth` login is not used). Runtimes that build their env from an allowlist keep these names.
 */
export const GIT_JOB_CONFIG_ENV = [
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
  'GCM_INTERACTIVE',
  'GH_CONFIG_DIR',
  'GH_PROMPT_DISABLED',
] as const;

/** CREDENTIAL_REQUEST `purpose` (additive): which network command the credential is for (audit, telemetry). */
export const GitCredentialPurpose = z.enum(['fetch', 'push']);
export type GitCredentialPurpose = z.infer<typeof GitCredentialPurpose>;

/** Repository hosts whose URL the job-local helper and the readiness checks treat as GitHub. */
export const GITHUB_HOST = 'github.com';
