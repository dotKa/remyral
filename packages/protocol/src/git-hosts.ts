import { z } from 'zod';
import { GIT_HOST_KINDS, GIT_HOST_TOKEN_KINDS, GIT_PROVIDER_KINDS } from './git-host-rules.js';

/**
 * p16-git-providers (docs/design/p16-git-providers.md, ADR-0061): GitLab (gitlab.com and self-managed) and Bitbucket
 * Cloud next to GitHub — the schemas of connections; the pure rules are in git-host-rules.ts (console: subpath
 * `@remyral/protocol/git-host-rules`, no zod).
 *
 * A *git host connection* is a master-held access token for one host — never shown again after it is entered, never
 * sent to a model — plus the non-secret facts the platform needs: the API base, the token kind and the scope the token
 * was created for (a GitLab project / group, a Bitbucket repository / workspace).
 */

export * from './git-host-rules.js';

export const GitHostKind = z.enum(GIT_HOST_KINDS);
export type GitHostKind = z.infer<typeof GitHostKind>;
export const GitProviderKind = z.enum(GIT_PROVIDER_KINDS);
export type GitProviderKind = z.infer<typeof GitProviderKind>;
export const GitHostTokenKind = z.enum(GIT_HOST_TOKEN_KINDS);
export type GitHostTokenKind = z.infer<typeof GitHostTokenKind>;

const IsoDate = z.iso.datetime({ offset: true });

/** Create / replace a connection (admin, always-fresh step-up). Tokens are write-only. */
export const GitHostConnectionInput = z.strictObject({
  kind: GitHostKind,
  label: z.string().trim().min(1).max(80),
  /** GitLab: instance URL (default gitlab.com). Bitbucket: ignored (Cloud). */
  baseUrl: z.string().max(300).optional(),
  tokenKind: GitHostTokenKind,
  scope: z.string().max(300),
  /** API token (GitLab scope `api`; Bitbucket `repository:write` + `pullrequest:write` + `pipeline`). */
  token: z.string().min(8).max(4096),
  /** Optional push-only token for workers (GitLab `write_repository`; Bitbucket `repository:write`). */
  pushToken: z.string().min(8).max(4096).optional(),
  /** Expiry the admin knows (Bitbucket does not report one); GitLab reports its own. */
  expiresAt: IsoDate.optional(),
  pushExpiresAt: IsoDate.optional(),
});
export type GitHostConnectionInput = z.infer<typeof GitHostConnectionInput>;

/** Change a connection without retyping its token (label, expiry dates) or with a new token (rotation by hand). */
export const GitHostConnectionPatch = z.strictObject({
  label: z.string().trim().min(1).max(80).optional(),
  token: z.string().min(8).max(4096).optional(),
  /** null removes the push token (workers then get the API token). */
  pushToken: z.string().min(8).max(4096).nullable().optional(),
  expiresAt: IsoDate.nullable().optional(),
  pushExpiresAt: IsoDate.nullable().optional(),
  expectedVersion: z.number().int().min(1),
});
export type GitHostConnectionPatch = z.infer<typeof GitHostConnectionPatch>;

export const GitHostTestResult = z.object({
  ok: z.boolean(),
  /** Short secret-free code: `ok`, `unauthorized`, `forbidden`, `not_found`, `unreachable`, `scope_mismatch` … */
  code: z.string().max(64),
  detail: z.string().max(300).nullable(),
  /** What the host says about the token (GitLab: name, scopes, expiry; Bitbucket: nothing beyond access). */
  tokenName: z.string().max(200).nullable(),
  scopes: z.array(z.string().max(64)).max(32),
  expiresAt: z.string().nullable(),
  /** Missing scopes the git flow needs (GitLab only: Bitbucket does not report a token's scopes). */
  missingScopes: z.array(z.string().max(64)).max(32),
  checkedAt: z.string(),
});
export type GitHostTestResult = z.infer<typeof GitHostTestResult>;

export const GitHostConnectionView = z.object({
  id: z.uuid(),
  kind: GitHostKind,
  label: z.string(),
  baseUrl: z.string(),
  webHost: z.string(),
  tokenKind: GitHostTokenKind,
  scope: z.string(),
  /** First 12 hex characters of SHA-256 of the token — to recognise a token, never to recover it. */
  tokenFingerprint: z.string(),
  pushTokenFingerprint: z.string().nullable(),
  /** Workers get a separate push-only token (false: the API token is handed to workers). */
  separatePushToken: z.boolean(),
  expiresAt: z.string().nullable(),
  pushExpiresAt: z.string().nullable(),
  /** The master can rotate the token through the host API (GitLab tokens with `api` / `self_rotate`). */
  rotatable: z.boolean(),
  tokenUpdatedAt: z.string(),
  lastTest: GitHostTestResult.nullable(),
  /** The stored tokens could be decrypted (false: the master key changed — enter the token again). */
  usable: z.boolean(),
  projects: z.array(z.string()),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitHostConnectionView = z.infer<typeof GitHostConnectionView>;

export const GitHostRepository = z.object({
  /** `group/sub/project` or `workspace/repo`. */
  fullPath: z.string(),
  cloneUrl: z.string(),
  webUrl: z.string(),
  defaultBranch: z.string().nullable(),
  private: z.boolean(),
  archived: z.boolean(),
});
export type GitHostRepository = z.infer<typeof GitHostRepository>;
