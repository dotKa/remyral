/**
 * Git flow errors with a client-safe code and message (paths/codes only — never repository content or
 * provider responses that could carry tokens).
 */
export class GitFlowError extends Error {
  override name = 'GitFlowError';
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export const notConfigured = (): GitFlowError =>
  new GitFlowError(409, 'git_not_configured', 'The project has no git provider configured.');

export const invalidGitConfig = (issues: readonly string[]): GitFlowError =>
  new GitFlowError(
    400,
    'invalid_git_config',
    `Invalid git configuration: ${issues.join(', ')}`.slice(0, 1000),
  );

export const gitConfigConflict = (): GitFlowError =>
  new GitFlowError(409, 'version_conflict', 'The git configuration changed meanwhile. Reload and try again.');

export const projectNotFound = (): GitFlowError =>
  new GitFlowError(404, 'project_not_found', 'Project not found.');

export const jobNotFound = (): GitFlowError => new GitFlowError(404, 'job_not_found', 'Job not found.');

/** The destructive or protected action was refused (no approval / policy deny). */
export class DestructiveActionRefusedError extends GitFlowError {
  override name = 'DestructiveActionRefusedError';
  constructor(message: string) {
    super(403, 'approval_required', message);
  }
}
