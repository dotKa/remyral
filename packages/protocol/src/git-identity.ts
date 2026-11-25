/**
 * p5-git-identity (docs/design/p5-git-identity.md): the git commit identity (author and committer) of a project's
 * agent work. Set per project in the panel, with an optional workspace-wide default; the master resolves it and
 * sends it in ASSIGN_JOB (`gitIdentity`, additive in 1.0). The worker uses it for the publish commit and exports it
 * as GIT_AUTHOR_* / GIT_COMMITTER_* into the runtime's environment, so the agent's own commits match.
 *
 * Plain functions (no Zod) so the console can import the same rules (`@remyral/protocol/git-identity`).
 */

export interface GitIdentityValue {
  readonly name: string;
  readonly email: string;
}

/** Used when neither the project nor the workspace default sets an identity. */
export const DEFAULT_GIT_IDENTITY: GitIdentityValue = Object.freeze({
  name: 'Remyral Agent',
  email: 'agent@remyral.invalid',
});

export const GIT_IDENTITY_NAME_MAX = 100;
export const GIT_IDENTITY_EMAIL_MAX = 254;

/** Variables the worker sets in a repository job's runtime environment (git reads them before any config). */
export const GIT_IDENTITY_ENV = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/* eslint-disable no-control-regex -- these patterns exist to refuse control characters */
// C0/C1 control characters (incl. newline, tab, DEL) and the angle brackets git uses to delimit the email.
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f<>]/;
/** A simple, sane address: local@domain.tld, no whitespace, no angle brackets, no control characters. */
const EMAIL =
  /^[^\s@<>",;:\\()[\]\u0000-\u001f\u007f]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
/* eslint-enable no-control-regex */

/**
 * p14-i18n-errors: why an identity part is invalid, as a code (the console says it in the user's language; the
 * master sends it as `params.reason` of `invalid_git_identity`) plus the limit it names.
 */
export type GitIdentityIssueCode =
  | 'name_required'
  | 'name_too_long'
  | 'name_forbidden'
  | 'name_spaces'
  | 'email_required'
  | 'email_too_long'
  | 'email_invalid';

export interface GitIdentityIssue {
  readonly code: GitIdentityIssueCode;
  /** The length limit, for `*_too_long`. */
  readonly max?: number;
}

/** Why `name` is not a valid commit name (null: valid). Leading/trailing whitespace counts as invalid. */
export function gitIdentityNameIssue(name: string): GitIdentityIssue | null {
  if (name.length === 0) return { code: 'name_required' };
  if (name.length > GIT_IDENTITY_NAME_MAX) return { code: 'name_too_long', max: GIT_IDENTITY_NAME_MAX };
  if (NAME_FORBIDDEN.test(name)) return { code: 'name_forbidden' };
  if (name.trim() !== name) return { code: 'name_spaces' };
  return null;
}

/** Why `email` is not a valid commit email (null: valid). */
export function gitIdentityEmailIssue(email: string): GitIdentityIssue | null {
  if (email.length === 0) return { code: 'email_required' };
  if (email.length > GIT_IDENTITY_EMAIL_MAX) return { code: 'email_too_long', max: GIT_IDENTITY_EMAIL_MAX };
  if (!EMAIL.test(email)) return { code: 'email_invalid' };
  return null;
}

/** The first issue of an identity, or null when both parts are valid. */
export function gitIdentityIssue(v: GitIdentityValue): GitIdentityIssue | null {
  return gitIdentityNameIssue(v.name) ?? gitIdentityEmailIssue(v.email);
}

/** The English sentence of an issue (the API / classic console text). */
export function describeGitIdentityIssue(issue: GitIdentityIssue): string {
  switch (issue.code) {
    case 'name_required':
      return 'Name is required.';
    case 'name_too_long':
      return `Name is at most ${String(issue.max ?? GIT_IDENTITY_NAME_MAX)} characters.`;
    case 'name_forbidden':
      return 'Name must not contain line breaks, control characters or < >.';
    case 'name_spaces':
      return 'Name must not start or end with spaces.';
    case 'email_required':
      return 'Email is required.';
    case 'email_too_long':
      return `Email is at most ${String(issue.max ?? GIT_IDENTITY_EMAIL_MAX)} characters.`;
    case 'email_invalid':
      return 'Enter an email address like name@example.com.';
  }
}

/** Why `name` is not a valid commit name, in English (null: valid). */
export function gitIdentityNameProblem(name: string): string | null {
  const issue = gitIdentityNameIssue(name);
  return issue === null ? null : describeGitIdentityIssue(issue);
}

/** Why `email` is not a valid commit email, in English (null: valid). */
export function gitIdentityEmailProblem(email: string): string | null {
  const issue = gitIdentityEmailIssue(email);
  return issue === null ? null : describeGitIdentityIssue(issue);
}

/** The first problem of an identity in English, or null when both parts are valid. */
export function gitIdentityProblem(v: GitIdentityValue): string | null {
  const issue = gitIdentityIssue(v);
  return issue === null ? null : describeGitIdentityIssue(issue);
}

/** GIT_AUTHOR_* / GIT_COMMITTER_* for a child process environment. */
export function gitIdentityEnv(v: GitIdentityValue): Record<(typeof GIT_IDENTITY_ENV)[number], string> {
  return {
    GIT_AUTHOR_NAME: v.name,
    GIT_AUTHOR_EMAIL: v.email,
    GIT_COMMITTER_NAME: v.name,
    GIT_COMMITTER_EMAIL: v.email,
  };
}
