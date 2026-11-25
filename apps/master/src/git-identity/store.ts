import {
  DEFAULT_GIT_IDENTITY,
  describeGitIdentityIssue,
  type GitIdentityValue,
  gitIdentityIssue,
} from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p5-git-identity (docs/design/p5-git-identity.md): where a project's commit identity comes from. The project's
 * own setting wins, then the workspace-wide default (Settings → Integrations), then Remyral Agent.
 */
export type GitIdentitySource = 'project' | 'workspace' | 'default';

export interface ResolvedGitIdentity {
  readonly identity: GitIdentityValue;
  readonly source: GitIdentitySource;
}

export interface StoredGitIdentity {
  readonly identity: GitIdentityValue | null;
  readonly updatedAt: Date | null;
  /** Username of the last editor (null: never set, or the account was removed). */
  readonly updatedBy: string | null;
}

/**
 * Validates an identity from a client: trims both parts, then applies the shared rules (`gitIdentityProblem`).
 * Throws 400 `invalid_git_identity` with the readable reason.
 */
export function validateGitIdentity(input: {
  readonly name: string;
  readonly email: string;
}): GitIdentityValue {
  const v = { name: input.name.trim(), email: input.email.trim() };
  const issue = gitIdentityIssue(v);
  if (issue !== null) {
    // p14-i18n-errors: the issue code is the variant (`params.reason`), `max` the limit it names.
    throw new HttpError(
      400,
      'invalid_git_identity',
      describeGitIdentityIssue(issue),
      {},
      {},
      {
        reason: issue.code,
        ...(issue.max === undefined ? {} : { max: issue.max }),
      },
    );
  }
  return v;
}

/** The project's own identity (404 when the project does not exist). */
export async function readProjectGitIdentity(
  db: Queryable,
  project: string,
  forUpdate = false,
): Promise<StoredGitIdentity> {
  const { rows } = await db.query<{
    git_author_name: string | null;
    git_author_email: string | null;
    git_identity_updated_at: Date | null;
    username: string | null;
  }>(
    `SELECT p.git_author_name, p.git_author_email, p.git_identity_updated_at, u.username
       FROM projects p LEFT JOIN users u ON u.id = p.git_identity_updated_by
      WHERE p.id = $1${forUpdate ? ' FOR UPDATE OF p' : ''}`,
    [project],
  );
  const r = rows[0];
  if (r === undefined)
    throw new HttpError(404, 'project_not_found', 'No such project.', {}, {}, { reason: 'no_such' });
  return {
    identity:
      r.git_author_name === null || r.git_author_email === null
        ? null
        : { name: r.git_author_name, email: r.git_author_email },
    updatedAt: r.git_identity_updated_at,
    updatedBy: r.username,
  };
}

/** The workspace-wide default (identity null when none is set). */
export async function readDefaultGitIdentity(db: Queryable, forUpdate = false): Promise<StoredGitIdentity> {
  const { rows } = await db.query<{ name: string; email: string; updated_at: Date; username: string | null }>(
    `SELECT d.name, d.email, d.updated_at, u.username
       FROM git_identity_default d LEFT JOIN users u ON u.id = d.updated_by
      WHERE d.id = 1${forUpdate ? ' FOR UPDATE OF d' : ''}`,
  );
  const r = rows[0];
  return r === undefined
    ? { identity: null, updatedAt: null, updatedBy: null }
    : { identity: { name: r.name, email: r.email }, updatedAt: r.updated_at, updatedBy: r.username };
}

/**
 * The identity a project's jobs commit with, and where it came from. A project that does not exist resolves to the
 * workspace default / Remyral Agent (dispatch never fails over the identity).
 */
export async function resolveGitIdentity(db: Queryable, project: string): Promise<ResolvedGitIdentity> {
  const { rows } = await db.query<{
    p_name: string | null;
    p_email: string | null;
    d_name: string | null;
    d_email: string | null;
  }>(
    `SELECT p.git_author_name AS p_name, p.git_author_email AS p_email, d.name AS d_name, d.email AS d_email
       FROM (SELECT 1) one
       LEFT JOIN projects p ON p.id = $1
       LEFT JOIN git_identity_default d ON d.id = 1`,
    [project],
  );
  const r = rows[0];
  if (r?.p_name != null && r.p_email != null) {
    return { identity: { name: r.p_name, email: r.p_email }, source: 'project' };
  }
  if (r?.d_name != null && r.d_email != null) {
    return { identity: { name: r.d_name, email: r.d_email }, source: 'workspace' };
  }
  return { identity: { ...DEFAULT_GIT_IDENTITY }, source: 'default' };
}
