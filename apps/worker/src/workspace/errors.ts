/**
 * Typed workspace errors. Messages never contain credentials: repository URLs are
 * validated to carry no userinfo password before they reach any message, and git
 * output is redacted before it is attached (see git.ts).
 */
export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

/** A job/attempt/project id that cannot safely be a path segment or branch component. */
export class InvalidWorkspaceIdError extends WorkspaceError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`invalid ${field}: ${reason}`);
    this.name = 'InvalidWorkspaceIdError';
  }
}

/** Malformed or unsupported repository URL (credentials, query, unsupported scheme, ...). */
export class InvalidRepositoryUrlError extends WorkspaceError {
  constructor(reason: string) {
    super(`invalid repository URL: ${reason}`);
    this.name = 'InvalidRepositoryUrlError';
  }
}

/** The repository (or a submodule) is not on the project's allowlist, or the project is unknown. */
export class RepositoryNotAllowedError extends WorkspaceError {
  constructor(
    readonly projectId: string,
    readonly repository: string,
    reason = 'not on the project allowlist',
  ) {
    super(`repository ${repository} is not allowed for project ${projectId}: ${reason}`);
    this.name = 'RepositoryNotAllowedError';
  }
}

/** A path would resolve outside the workspace root (traversal, planted symlink, ...). */
export class UnsafePathError extends WorkspaceError {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`refusing path ${path}: ${reason}`);
    this.name = 'UnsafePathError';
  }
}

/** The checkout contains a symlink that points outside its worktree. */
export class UnsafeSymlinkError extends WorkspaceError {
  constructor(readonly entries: readonly { path: string; target: string }[]) {
    super(
      `checkout contains ${String(entries.length)} symlink(s) pointing outside the workspace: ${entries
        .slice(0, 5)
        .map((e) => e.path)
        .join(', ')}`,
    );
    this.name = 'UnsafeSymlinkError';
  }
}

export class WorkspaceExistsError extends WorkspaceError {
  constructor(readonly path: string) {
    super(`workspace ${path} already exists (attempt ids must be unique; reconcile instead of re-preparing)`);
    this.name = 'WorkspaceExistsError';
  }
}

export class DiskQuotaError extends WorkspaceError {
  constructor(
    readonly freeBytes: number,
    readonly requiredBytes: number,
  ) {
    super(
      `not enough free disk space under the workspace root: ${String(freeBytes)} bytes free, ${String(requiredBytes)} required`,
    );
    this.name = 'DiskQuotaError';
  }
}

export class BaseRefNotFoundError extends WorkspaceError {
  constructor(
    readonly baseRef: string,
    /** p18-project-bootstrap: the remote has no branches and no tags at all (an empty repository). */
    readonly emptyRepository = false,
  ) {
    super(
      `base ref ${JSON.stringify(baseRef)} was not found in the repository${
        emptyRepository ? ' (the repository is empty: it has no branches yet)' : ''
      }`,
    );
    this.name = 'BaseRefNotFoundError';
  }
}

/** A git command failed. `stderr` is already redacted and truncated. */
export class GitCommandError extends WorkspaceError {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${command} failed (${exitCode === null ? 'killed' : `exit ${String(exitCode)}`}): ${stderr.trim().slice(0, 500)}`,
    );
    this.name = 'GitCommandError';
  }
}

/** p5-live-fixes-2: no git executable (not in the config, not installed by the worker, not on PATH). */
export class GitNotFoundError extends WorkspaceError {
  constructor(readonly binary: string) {
    super(
      `git executable not found (${binary}): install git on this worker (Machines → <machine> → Tools → git) or set gitBinary in the worker config`,
    );
    this.name = 'GitNotFoundError';
  }
}

/** Pre-push scan found secrets; nothing was pushed. Findings carry locations and rule ids only. */
export class SecretScanError extends WorkspaceError {
  constructor(readonly findings: readonly SecretFinding[]) {
    super(
      `pre-push secret scan found ${String(findings.length)} potential secret(s); push refused: ${findings
        .slice(0, 5)
        .map((f) => `${f.commit.slice(0, 12)} ${f.location} [${f.label}]`)
        .join('; ')}`,
    );
    this.name = 'SecretScanError';
  }
}

export interface SecretFinding {
  commit: string;
  /** `path:line` of an added line, or `message` for the commit message. */
  location: string;
  /** Rule id or registered secret label — never the value. */
  label: string;
}

/** The remote refused the push (stale lease, non-fast-forward, protection, ...). */
export class PushRejectedError extends WorkspaceError {
  constructor(
    readonly branch: string,
    readonly reason: 'stale-lease' | 'rejected',
    detail: string,
  ) {
    super(`push of ${branch} rejected (${reason}): ${detail}`);
    this.name = 'PushRejectedError';
  }
}

/** The branch tip does not carry this attempt's `Remyral-Attempt` trailer (ADR-0004 §3). */
export class AttemptTrailerError extends WorkspaceError {
  constructor(
    readonly branch: string,
    readonly expected: string,
  ) {
    super(`tip of ${branch} does not carry the trailer "Remyral-Attempt: ${expected}"; commit with it first`);
    this.name = 'AttemptTrailerError';
  }
}

/** Another process holds the mirror lock and did not release it in time. */
export class LockTimeoutError extends WorkspaceError {
  constructor(readonly path: string) {
    super(`timed out waiting for lock ${path}`);
    this.name = 'LockTimeoutError';
  }
}

/**
 * p6-automations-next (ADR-0026): the pinned head SHA of a pull request is not reachable from
 * `refs/pull/<n>/head` any more (force-pushed); the next event runs on the new head.
 */
export class PullRequestHeadMovedError extends WorkspaceError {
  constructor(
    readonly pullRequest: number,
    readonly headSha: string,
  ) {
    super(
      `pr_head_moved: pull request #${String(pullRequest)} no longer contains the pinned head ${headSha}; the next event runs on the new head`,
    );
    this.name = 'PullRequestHeadMovedError';
  }
}

/**
 * p15-git-central §4: the project's repository credential (`vault-<id>`) is not held by this worker — the vault
 * credential was not shared with it (Ayarlar → Kimlik bilgileri) or not applied yet.
 */
export class GitCredentialMissingError extends WorkspaceError {
  constructor(readonly credentialId: string) {
    super(
      `git_credential_missing: this worker does not hold the project's repository credential ${credentialId}; share it with this machine in the credential vault`,
    );
    this.name = 'GitCredentialMissingError';
  }
}
