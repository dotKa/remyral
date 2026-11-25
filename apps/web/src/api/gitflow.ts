import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p4-git-flow (apps/master/src/gitflow/routes.ts, docs/design/p4-git-flow.md): a job's verified changes and
 * merge requests. Commit subjects, file paths and reasons come from the repository / runtime: untrusted
 * text, rendered as text only.
 */

export interface CommitRef {
  readonly sha: string;
  readonly subject: string;
}

export interface MergeRequestInfo {
  readonly id: string;
  /** Null when the owner's security policy approved the merge (no approval request, p15-merge-approvals). */
  readonly approvalRequestId: string | null;
  /** Null when the platform opened the request itself when the result was verified (p15-merge-approvals). */
  readonly requestedBy: string | null;
  readonly mode: string;
  readonly status: string;
  readonly headSha: string;
  readonly targetBranch: string;
  readonly resultReason: string | null;
  readonly mergeSha: string | null;
  readonly createdAt: string;
}

export interface JobChanges {
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly repository: string | null;
  readonly targetBranch: string | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly verification: { readonly status: string; readonly reason: string | null };
  readonly commits: readonly (CommitRef & { readonly author: string })[];
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
  readonly truncated: boolean;
  readonly flags: readonly { readonly path: string; readonly kind: string }[];
  readonly mergeCheck: {
    readonly state: string | null;
    readonly files: readonly string[];
    readonly headCommits: readonly CommitRef[];
    readonly baseCommits: readonly CommitRef[];
    readonly precision: string | null;
    readonly reason: string | null;
  };
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly ci: {
    readonly state: string | null;
    readonly required: boolean;
    readonly checks: readonly {
      readonly name: string;
      readonly conclusion: string | null;
      readonly status: string;
    }[];
  };
  readonly merged: { readonly sha: string } | null;
  readonly requests: readonly MergeRequestInfo[];
}

type Opts = Omit<RequestOptions, 'body'>;

function array<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(item);
}

function commitRef(x: unknown): CommitRef {
  const o = obj(x);
  return { sha: str(o, 'sha'), subject: str(o, 'subject') };
}

function bool(o: Record<string, unknown>, key: string): boolean {
  if (typeof o[key] !== 'boolean') throw new ShapeError(`expected boolean ${key}`);
  return o[key];
}

function parseRequest(x: unknown): MergeRequestInfo {
  const o = obj(x);
  return {
    id: str(o, 'id'),
    approvalRequestId: nullableStr(o, 'approvalRequestId'),
    requestedBy: nullableStr(o, 'requestedBy'),
    mode: str(o, 'mode'),
    status: str(o, 'status'),
    headSha: str(o, 'headSha'),
    targetBranch: str(o, 'targetBranch'),
    resultReason: nullableStr(o, 'resultReason'),
    mergeSha: nullableStr(o, 'mergeSha'),
    createdAt: str(o, 'createdAt'),
  };
}

export function parseChanges(v: unknown): JobChanges {
  const o = obj(v);
  const ver = obj(o.verification);
  const totals = obj(o.totals);
  const mc = obj(o.mergeCheck);
  const ci = obj(o.ci);
  const pr = o.pullRequest === null ? null : obj(o.pullRequest);
  const merged = o.merged === null ? null : obj(o.merged);
  return {
    enabled: bool(o, 'enabled'),
    provider: nullableStr(o, 'provider'),
    repository: nullableStr(o, 'repository'),
    targetBranch: nullableStr(o, 'targetBranch'),
    branch: nullableStr(o, 'branch'),
    headSha: nullableStr(o, 'headSha'),
    verification: { status: str(ver, 'status'), reason: nullableStr(ver, 'reason') },
    commits: array(o.commits, (x) => ({ ...commitRef(x), author: str(obj(x), 'author') })),
    files: array(o.files, (x) => {
      const f = obj(x);
      return {
        path: str(f, 'path'),
        status: str(f, 'status'),
        additions: int(f, 'additions'),
        deletions: int(f, 'deletions'),
      };
    }),
    totals: {
      files: int(totals, 'files'),
      additions: int(totals, 'additions'),
      deletions: int(totals, 'deletions'),
    },
    truncated: bool(o, 'truncated'),
    flags: array(o.flags, (x) => ({ path: str(obj(x), 'path'), kind: str(obj(x), 'kind') })),
    mergeCheck: {
      state: nullableStr(mc, 'state'),
      files: strArray(mc, 'files'),
      headCommits: array(mc.headCommits, commitRef),
      baseCommits: array(mc.baseCommits, commitRef),
      precision: nullableStr(mc, 'precision'),
      reason: nullableStr(mc, 'reason'),
    },
    pullRequest: pr === null ? null : { number: int(pr, 'number'), url: str(pr, 'url') },
    ci: {
      state: nullableStr(ci, 'state'),
      required: bool(ci, 'required'),
      checks: array(ci.checks, (x) => {
        const k = obj(x);
        return { name: str(k, 'name'), status: str(k, 'status'), conclusion: nullableStr(k, 'conclusion') };
      }),
    },
    merged: merged === null ? null : { sha: str(merged, 'sha') },
    requests: array(o.requests, parseRequest),
  };
}

export function getChanges(jobId: string, opts: Opts = {}): Promise<JobChanges> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(jobId)}/changes`, parseChanges, opts);
}

/** Opens the `git.merge` approval (the merge itself runs after an admin approves with step-up). */
export function requestMerge(
  jobId: string,
  mode: 'merge' | 'leave_open',
  opts: Opts = {},
): Promise<{ request: MergeRequestInfo; created: boolean }> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/merge`,
    (v) => {
      const o = obj(v);
      return { request: parseRequest(o.request), created: bool(o, 'created') };
    },
    { ...opts, body: { mode } },
  );
}

// ------------------------------------------------------------------ project git configuration (p5-project-git-ui)

/** p16-git-providers: GitLab (gitlab.com / self-managed) and Bitbucket Cloud next to GitHub and plain git. */
export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'git';
export const GIT_PROVIDERS: readonly GitProvider[] = ['github', 'gitlab', 'bitbucket', 'git'];

export interface ProjectGitConfig {
  readonly project: string;
  readonly version: number;
  readonly provider: GitProvider;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly mergeMethod: 'merge' | 'squash';
  readonly requireCi: boolean;
  readonly ciTimeoutSec: number;
  readonly github: {
    readonly appId: string;
    readonly installationId: number;
    readonly keyRef: string;
  } | null;
  /** p16-git-providers: the GitLab / Bitbucket connection (Ayarlar → Entegrasyonlar), null otherwise. */
  readonly hostConnectionId: string | null;
  readonly updatedAt: string;
}

export interface GitConfigInput {
  readonly expectedVersion: number;
  readonly provider: GitProvider;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly mergeMethod?: 'merge' | 'squash';
  readonly requireCi?: boolean;
  readonly ciTimeoutSec?: number;
  /** `appId` is sent by the repository picker (p5-github-connect) so the master can check it matches the key. */
  readonly github?: { readonly installationId: number; readonly keyRef?: string; readonly appId?: string };
  /** p16-git-providers: required for gitlab / bitbucket. */
  readonly hostConnectionId?: string;
}

function isProvider(v: string): v is GitProvider {
  return (GIT_PROVIDERS as readonly string[]).includes(v);
}

function parseGitConfig(v: unknown): ProjectGitConfig {
  const o = obj(v);
  const provider = str(o, 'provider');
  if (!isProvider(provider)) throw new ShapeError('bad provider');
  const merge = str(o, 'mergeMethod');
  if (merge !== 'merge' && merge !== 'squash') throw new ShapeError('bad mergeMethod');
  const gh = o.github === null ? null : obj(o.github);
  return {
    project: str(o, 'project'),
    version: int(o, 'version'),
    provider,
    repositoryUrl: str(o, 'repositoryUrl'),
    baseBranch: str(o, 'baseBranch'),
    mergeMethod: merge,
    requireCi: bool(o, 'requireCi'),
    ciTimeoutSec: int(o, 'ciTimeoutSec'),
    github:
      gh === null
        ? null
        : { appId: str(gh, 'appId'), installationId: int(gh, 'installationId'), keyRef: str(gh, 'keyRef') },
    // Absent from older masters: none.
    hostConnectionId: typeof o.hostConnectionId === 'string' ? o.hostConnectionId : null,
    updatedAt: str(o, 'updatedAt'),
  };
}

export function getProjectGitConfig(project: string, opts: Opts = {}): Promise<ProjectGitConfig | null> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/git`,
    (v) => {
      const c = obj(v).config;
      return c === null ? null : parseGitConfig(c);
    },
    opts,
  );
}

export function putProjectGitConfig(
  project: string,
  body: GitConfigInput,
  opts: Opts = {},
): Promise<ProjectGitConfig> {
  return apiRequest(
    'PUT',
    `/projects/${encodeURIComponent(project)}/git`,
    (v) => parseGitConfig(obj(v).config),
    { ...opts, body },
  );
}
