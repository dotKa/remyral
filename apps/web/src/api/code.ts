import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p19-ide W1 (apps/master/src/code/routes.ts): the code viewer and diff reviewer. Every text is repository content the
 * master already redacted — untrusted: rendered as text only (CodeMirror documents, never HTML).
 */

type Opts = Omit<RequestOptions, 'body'>;

const enc = encodeURIComponent;

export interface CodeSource {
  readonly project: string;
  readonly kind: 'repository' | 'workspace';
  readonly provider: string | null;
  readonly repositoryUrl: string | null;
  readonly defaultBranch: string | null;
  readonly supported: boolean;
  readonly reason: string | null;
  readonly branches: readonly {
    readonly jobId: string;
    readonly title: string;
    readonly branch: string;
    readonly headSha: string;
    readonly baseSha: string | null;
    readonly state: string;
    readonly at: string;
  }[];
  readonly workfiles: readonly {
    readonly jobId: string;
    readonly title: string | null;
    readonly keptAt: string;
    readonly workerConnected: boolean;
  }[];
}

export interface CodeEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink' | 'submodule';
  readonly size: number | null;
}

export interface CodeTree {
  readonly sha: string;
  readonly path: string;
  readonly entries: readonly CodeEntry[];
  readonly truncated: boolean;
}

export interface CodeFile {
  readonly project: string;
  readonly source: 'repo' | 'workfiles';
  readonly ref: string;
  readonly path: string;
  readonly state: 'text' | 'binary' | 'too_large';
  readonly size: number;
  readonly text: string | null;
  readonly language: string | null;
  readonly redacted: boolean;
}

export interface FileSide {
  readonly sha: string | null;
  readonly state: 'text' | 'binary' | 'too_large' | 'absent';
  readonly size: number;
  readonly text: string | null;
}

export interface FilePair {
  readonly path: string;
  readonly previousPath: string | null;
  readonly old: FileSide;
  readonly new: FileSide;
}

export interface ReviewFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface JobReview {
  readonly jobId: string;
  readonly project: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly targetBranch: string;
  readonly files: readonly ReviewFile[];
  readonly truncated: boolean;
  readonly supported: boolean;
}

export interface CompareResult {
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBase: string;
  readonly files: readonly ReviewFile[];
  readonly truncated: boolean;
}

export interface ReviewComment {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: string;
  readonly side: 'old' | 'new';
  readonly startLine: number;
  readonly endLine: number;
  readonly commitSha: string;
  readonly body: string;
  readonly author: { readonly id: string | null; readonly name: string | null };
  readonly mine: boolean;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly sentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RejectedHunk {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly oldStart: number | null;
  readonly oldEnd: number | null;
  readonly newStart: number | null;
  readonly newEnd: number | null;
}

const num = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${k}`);
  return v;
};
const bool = (o: Record<string, unknown>, k: string): boolean => o[k] === true;
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v;
};
function oneOf<T extends string>(o: Record<string, unknown>, k: string, values: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new ShapeError(`bad ${k}`);
  return v as T;
}

function parseSource(v: unknown): CodeSource {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    kind: oneOf(o, 'kind', ['repository', 'workspace'] as const),
    provider: nullableStr(o, 'provider'),
    repositoryUrl: nullableStr(o, 'repositoryUrl'),
    defaultBranch: nullableStr(o, 'defaultBranch'),
    supported: bool(o, 'supported'),
    reason: nullableStr(o, 'reason'),
    branches: list(o.branches).map((b) => {
      const x = obj(b);
      return {
        jobId: str(x, 'jobId'),
        title: str(x, 'title'),
        branch: str(x, 'branch'),
        headSha: str(x, 'headSha'),
        baseSha: nullableStr(x, 'baseSha'),
        state: str(x, 'state'),
        at: str(x, 'at'),
      };
    }),
    workfiles: list(o.workfiles).map((w) => {
      const x = obj(w);
      return {
        jobId: str(x, 'jobId'),
        title: nullableStr(x, 'title'),
        keptAt: str(x, 'keptAt'),
        workerConnected: bool(x, 'workerConnected'),
      };
    }),
  };
}

function parseFile(v: unknown): CodeFile {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    source: oneOf(o, 'source', ['repo', 'workfiles'] as const),
    ref: str(o, 'ref'),
    path: str(o, 'path'),
    state: oneOf(o, 'state', ['text', 'binary', 'too_large'] as const),
    size: num(o, 'size'),
    text: nullableStr(o, 'text'),
    language: nullableStr(o, 'language'),
    redacted: bool(o, 'redacted'),
  };
}

function parseSide(v: unknown): FileSide {
  const o = obj(v);
  return {
    sha: nullableStr(o, 'sha'),
    state: oneOf(o, 'state', ['text', 'binary', 'too_large', 'absent'] as const),
    size: num(o, 'size'),
    text: nullableStr(o, 'text'),
  };
}

function parsePair(v: unknown): FilePair {
  const o = obj(v);
  return {
    path: str(o, 'path'),
    previousPath: nullableStr(o, 'previousPath'),
    old: parseSide(o.old),
    new: parseSide(o.new),
  };
}

function parseReviewFile(v: unknown): ReviewFile {
  const o = obj(v);
  return {
    path: str(o, 'path'),
    previousPath: nullableStr(o, 'previousPath'),
    status: str(o, 'status'),
    additions: int(o, 'additions'),
    deletions: int(o, 'deletions'),
  };
}

export function parseComment(v: unknown): ReviewComment {
  const o = obj(v);
  const a = obj(o.author);
  return {
    id: str(o, 'id'),
    parentId: nullableStr(o, 'parentId'),
    path: str(o, 'path'),
    side: oneOf(o, 'side', ['old', 'new'] as const),
    startLine: int(o, 'startLine'),
    endLine: int(o, 'endLine'),
    commitSha: str(o, 'commitSha'),
    body: str(o, 'body'),
    author: { id: nullableStr(a, 'id'), name: nullableStr(a, 'name') },
    mine: bool(o, 'mine'),
    resolved: bool(o, 'resolved'),
    outdated: bool(o, 'outdated'),
    sentAt: nullableStr(o, 'sentAt'),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
  };
}

const qs = (p: Record<string, string | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') q.set(k, v);
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
};

export function getCodeSource(project: string, opts: Opts = {}): Promise<CodeSource> {
  return apiRequest('GET', `/projects/${enc(project)}/code`, parseSource, opts);
}

export function getCodeTree(
  project: string,
  ref: string | undefined,
  path: string,
  opts: Opts = {},
): Promise<CodeTree> {
  return apiRequest(
    'GET',
    `/projects/${enc(project)}/code/tree${qs({ ref, path })}`,
    (v) => {
      const o = obj(v);
      return {
        sha: str(o, 'sha'),
        path: str(o, 'path'),
        entries: list(o.entries).map((e) => {
          const x = obj(e);
          return {
            name: str(x, 'name'),
            path: str(x, 'path'),
            kind: oneOf(x, 'kind', ['file', 'dir', 'symlink', 'submodule'] as const),
            size: x.size === null ? null : num(x, 'size'),
          };
        }),
        truncated: bool(o, 'truncated'),
      };
    },
    opts,
  );
}

export function getCodeFile(
  project: string,
  ref: string | undefined,
  path: string,
  opts: Opts = {},
): Promise<CodeFile> {
  return apiRequest('GET', `/projects/${enc(project)}/code/file${qs({ ref, path })}`, parseFile, opts);
}

/** A kept working file of a workspace job (through its machine). */
export function getWorkfileText(jobId: string, path: string, opts: Opts = {}): Promise<CodeFile> {
  return apiRequest('GET', `/jobs/${enc(jobId)}/code/workfile${qs({ path })}`, parseFile, opts);
}

export function compareRefs(
  project: string,
  base: string,
  head: string,
  opts: Opts = {},
): Promise<CompareResult> {
  return apiRequest(
    'GET',
    `/projects/${enc(project)}/code/compare${qs({ base, head })}`,
    (v) => {
      const o = obj(v);
      return {
        baseSha: str(o, 'baseSha'),
        headSha: str(o, 'headSha'),
        mergeBase: str(o, 'mergeBase'),
        files: list(o.files).map(parseReviewFile),
        truncated: bool(o, 'truncated'),
      };
    },
    opts,
  );
}

export function compareFile(
  project: string,
  base: string,
  head: string,
  path: string,
  previousPath: string | null,
  opts: Opts = {},
): Promise<FilePair> {
  return apiRequest(
    'GET',
    `/projects/${enc(project)}/code/compare/file${qs({ base, head, path, previousPath: previousPath ?? undefined })}`,
    parsePair,
    opts,
  );
}

export function getJobReview(jobId: string, opts: Opts = {}): Promise<JobReview> {
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/review`,
    (v) => {
      const o = obj(v);
      return {
        jobId: str(o, 'jobId'),
        project: str(o, 'project'),
        baseSha: str(o, 'baseSha'),
        headSha: str(o, 'headSha'),
        branch: nullableStr(o, 'branch'),
        targetBranch: str(o, 'targetBranch'),
        files: list(o.files).map(parseReviewFile),
        truncated: bool(o, 'truncated'),
        supported: bool(o, 'supported'),
      };
    },
    opts,
  );
}

export function getJobReviewFile(
  jobId: string,
  path: string,
  previousPath: string | null,
  opts: Opts = {},
): Promise<FilePair> {
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/review/file${qs({ path, previousPath: previousPath ?? undefined })}`,
    parsePair,
    opts,
  );
}

export function listReviewComments(jobId: string, opts: Opts = {}): Promise<ReviewComment[]> {
  return apiRequest(
    'GET',
    `/jobs/${enc(jobId)}/review/comments`,
    (v) => list(obj(v).comments).map(parseComment),
    opts,
  );
}

export function addReviewComment(
  jobId: string,
  body: {
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly startLine: number;
    readonly endLine: number;
    readonly body: string;
    readonly parentId?: string;
  },
  opts: Opts = {},
): Promise<ReviewComment> {
  return apiRequest('POST', `/jobs/${enc(jobId)}/review/comments`, (v) => parseComment(obj(v).comment), {
    ...opts,
    body,
  });
}

export function updateReviewComment(
  jobId: string,
  id: string,
  body: { readonly body?: string; readonly resolved?: boolean },
  opts: Opts = {},
): Promise<ReviewComment> {
  return apiRequest(
    'PATCH',
    `/jobs/${enc(jobId)}/review/comments/${enc(id)}`,
    (v) => parseComment(obj(v).comment),
    { ...opts, body },
  );
}

export function deleteReviewComment(jobId: string, id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/jobs/${enc(jobId)}/review/comments/${enc(id)}`, () => undefined, opts);
}

export function requestChanges(
  jobId: string,
  body: { readonly note?: string; readonly hunks?: readonly RejectedHunk[] },
  opts: Opts = {},
): Promise<{ mode: 'message' | 'job'; messageId: string | null; jobId: string | null; comments: number }> {
  return apiRequest(
    'POST',
    `/jobs/${enc(jobId)}/review/request-changes`,
    (v) => {
      const o = obj(v);
      return {
        mode: oneOf(o, 'mode', ['message', 'job'] as const),
        messageId: nullableStr(o, 'messageId'),
        jobId: nullableStr(o, 'jobId'),
        comments: int(o, 'comments'),
      };
    },
    { ...opts, body },
  );
}

/** p18-leftovers: an open pull / merge request of the project repository (provider text, rendered as text). */
export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly author: string | null;
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly sameRepository: boolean;
  readonly updatedAt: string | null;
  /** The refs of its compare view (null: its head cannot be read from this repository). */
  readonly compare: { readonly base: string; readonly head: string } | null;
}

export function listOpenPullRequests(
  project: string,
  opts: Opts = {},
): Promise<{ supported: boolean; items: OpenPullRequest[] }> {
  return apiRequest(
    'GET',
    `/projects/${enc(project)}/code/pulls`,
    (v) => {
      const o = obj(v);
      return {
        supported: bool(o, 'supported'),
        items: list(o.items).map((x): OpenPullRequest => {
          const r = obj(x);
          const c = r.compare;
          const cmp = c !== null && typeof c === 'object' ? (c as Record<string, unknown>) : null;
          return {
            number: int(r, 'number'),
            title: str(r, 'title'),
            url: (() => {
              const u = nullableStr(r, 'url');
              return u !== null && /^https:\/\//.test(u) ? u : null;
            })(),
            author: nullableStr(r, 'author'),
            draft: bool(r, 'draft'),
            baseBranch: str(r, 'baseBranch'),
            headBranch: str(r, 'headBranch'),
            sameRepository: bool(r, 'sameRepository'),
            updatedAt: nullableStr(r, 'updatedAt'),
            compare:
              cmp !== null && typeof cmp.base === 'string' && typeof cmp.head === 'string'
                ? { base: cmp.base, head: cmp.head }
                : null,
          };
        }),
      };
    },
    opts,
  );
}

/**
 * p18-last-gaps: where a compare view's "Değişiklik iste" goes — the job whose branch the head is, an open pull request
 * of the repository (a new job on its branch), or nowhere with the reason (`no_target`, `pull_fork`, `pull_branch`,
 * `provider_unavailable`).
 */
export type CompareReviewTarget =
  | { readonly mode: 'job'; readonly jobId: string; readonly branch: string | null }
  | {
      readonly mode: 'pull';
      readonly number: number;
      readonly headBranch: string;
      readonly baseBranch: string;
      readonly headSha: string | null;
    }
  | { readonly mode: 'none'; readonly reason: string };

function parseTarget(v: unknown): CompareReviewTarget {
  const o = obj(v);
  const mode = oneOf(o, 'mode', ['job', 'pull', 'none'] as const);
  if (mode === 'job') return { mode, jobId: str(o, 'jobId'), branch: nullableStr(o, 'branch') };
  if (mode === 'pull')
    return {
      mode,
      number: int(o, 'number'),
      headBranch: str(o, 'headBranch'),
      baseBranch: str(o, 'baseBranch'),
      headSha: nullableStr(o, 'headSha'),
    };
  return { mode, reason: str(o, 'reason') };
}

/** The comments of a compare view and where its review goes. */
export function listCompareComments(
  project: string,
  base: string,
  head: string,
  opts: Opts = {},
): Promise<{ comments: ReviewComment[]; headSha: string | null; target: CompareReviewTarget }> {
  return apiRequest(
    'GET',
    `/projects/${enc(project)}/code/compare/comments${qs({ base, head })}`,
    (v) => {
      const o = obj(v);
      return {
        comments: list(o.comments).map(parseComment),
        headSha: nullableStr(o, 'headSha'),
        target: parseTarget(o.target),
      };
    },
    opts,
  );
}

export function addCompareComment(
  project: string,
  body: {
    readonly base: string;
    readonly head: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly startLine: number;
    readonly endLine: number;
    readonly body: string;
    readonly parentId?: string;
  },
  opts: Opts = {},
): Promise<ReviewComment> {
  return apiRequest(
    'POST',
    `/projects/${enc(project)}/code/compare/comments`,
    (v) => parseComment(obj(v).comment),
    { ...opts, body },
  );
}

export function updateCompareComment(
  project: string,
  id: string,
  body: { readonly body?: string; readonly resolved?: boolean },
  opts: Opts = {},
): Promise<ReviewComment> {
  return apiRequest(
    'PATCH',
    `/projects/${enc(project)}/code/compare/comments/${enc(id)}`,
    (v) => parseComment(obj(v).comment),
    { ...opts, body },
  );
}

export function deleteCompareComment(project: string, id: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'DELETE',
    `/projects/${enc(project)}/code/compare/comments/${enc(id)}`,
    () => undefined,
    opts,
  );
}

export function compareRequestChanges(
  project: string,
  body: {
    readonly base: string;
    readonly head: string;
    readonly note?: string;
    readonly hunks?: readonly RejectedHunk[];
  },
  opts: Opts = {},
): Promise<{
  mode: 'message' | 'job';
  target: 'job' | 'pull';
  messageId: string | null;
  jobId: string | null;
  comments: number;
}> {
  return apiRequest(
    'POST',
    `/projects/${enc(project)}/code/compare/request-changes`,
    (v) => {
      const o = obj(v);
      return {
        mode: oneOf(o, 'mode', ['message', 'job'] as const),
        target: oneOf(o, 'target', ['job', 'pull'] as const),
        messageId: nullableStr(o, 'messageId'),
        jobId: nullableStr(o, 'jobId'),
        comments: int(o, 'comments'),
      };
    },
    { ...opts, body },
  );
}
