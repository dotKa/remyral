import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, marker, Redactor } from '@remyral/observability';
import { JobSpec, normalizeJobTitle } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { rerunSpec } from '../chat/job-actions.js';
import type { ProjectDefaults } from '../composer/defaults.js';
import { loadGitConfig, type ProjectGitConfig } from '../gitflow/config-store.js';
import { isAttemptBranch, isTargetBranch } from '../gitflow/refs.js';
import { loadJobGit } from '../gitflow/store.js';
import {
  type BlobRead,
  type GitProvider,
  isRepoPath,
  type OpenPullRequest,
  ProviderError,
  type ProviderKind,
  type TreeEntry,
  type TreeListing,
  classifyBlob,
} from '../gitflow/types.js';
import { HttpError } from '../http/errors.js';
import type { JobStore } from '../jobs/store.js';
import type { JobMessageService } from '../jobs/messages.js';
import { jobTitle, titleColumns, titleOrDerived } from '../jobs/titles.js';
import type { WorkfilesService } from '../workfiles/service.js';
import {
  type CodeRef,
  codeRefId,
  codeRefLabel,
  languageOf,
  MAX_REFERENCE_LINES,
  sliceLines,
} from './reference.js';

/**
 * p19-ide W1 (docs/design/p19-ide.md §5, §6, "Implementation (W1)"): what the console's code viewer and diff reviewer
 * read, and the review that leaves it. Everything is read-only on the repository: files and directories come from the
 * project's git provider at a resolved commit (`GitProvider.tree` / `blob`, never a checkout — AGENTS.md rule 1), kept
 * working files of workspace jobs from their machine (WorkfilesService). Text is capped, binary files are summaries,
 * and every text is redacted with the same rules as `/jobs/:id/diff` before it leaves the master. "Değişiklik iste"
 * becomes a message to the job's agent or a follow-up job on the job's head — nothing writes to a branch from here.
 */

/** Bytes of one file the viewer reads (larger files are a summary, like the provider's own cap). */
/**
 * p18-leftovers (docs/design/p19-ide.md "Leftovers"): the code viewer's redaction keeps every line where it was — a
 * secret that spans lines (a PEM key) is masked line by line (each of its lines becomes the marker), so the line
 * numbers below it, the review's hunks, comments and code references still point at the right lines.
 */
export function redactKeepingLines(redactor: Redactor, text: string): string {
  if (text.length === 0) return text;
  const spans = redactor.spans(text);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    const mark = marker(s.label);
    const lines = text.slice(s.start, s.end).split('\n').length;
    out += text.slice(pos, s.start) + Array.from({ length: lines }, () => mark).join('\n');
    pos = s.end;
  }
  return out + text.slice(pos);
}

/** p18-leftovers: open pull requests the Kod tab lists, and how long a listing is reused. */
const MAX_PULLS = 30;
const PULLS_TTL_MS = 60_000;

export interface PullRequestListItem {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly author: string | null;
  readonly draft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly sameRepository: boolean;
  readonly updatedAt: string | null;
  /** The refs of `/projects/:id/code/compare` for it (null: its head cannot be read from this repository). */
  readonly compare: { readonly base: string; readonly head: string } | null;
}

export const MAX_CODE_FILE_BYTES = 1024 * 1024;
/** Directory entries the viewer lists at most. */
export const MAX_TREE_ENTRIES = 2000;
/** Changed files of one diff the reviewer lists. */
export const MAX_REVIEW_FILES = 300;
/** Comments of one job (or one compare view) at most (the reviewer is not a forum). */
const MAX_COMMENTS = 500;
/** The text "Değişiklik iste" sends: a job message takes 8 192 characters. */
const MAX_MESSAGE_CHARS = 8000;
const MAX_REJECTED_HUNKS = 20;
const MAX_HUNK_LINES = 60;
/** Cached reads (immutable by commit): entries and bytes. */
const CACHE_ENTRIES = 400;
const CACHE_BYTES = 48 * 1024 * 1024;

const SHA40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** States in which a job's agent runs or is about to: its review goes as a message (or waits for it). */
const BUSY_STATES = new Set(['STARTING', 'RUNNING', 'CANCELLING', 'VERIFYING']);

export interface CodeActor {
  readonly subject: Subject;
  readonly userId: string;
  readonly ip: string;
  readonly userAgent: string | null;
}

export interface CodeServiceDeps {
  readonly pool: Queryable;
  readonly audit: AuditRecorder;
  /** The project's git provider (GitFlowService.providerFor); null while git flow is not initialised. */
  readonly providers: () => {
    providerFor(project: string): Promise<{ provider: GitProvider; config: ProjectGitConfig } | null>;
  } | null;
  readonly workfiles?: () => WorkfilesService | null;
  /** p19-ide W2: files of IDE workspaces (`ide:` references), read from the machine. */
  readonly ide?: () => {
    referenceProject(subject: Subject, workspaceId: string): Promise<string | null>;
    readFile(subject: Subject, workspaceId: string, path: string): Promise<string | null>;
  } | null;
  readonly jobMessages?: () => JobMessageService | null;
  readonly jobs?: JobStore;
  /** Starts dispatching a job just created (the orchestrator). */
  readonly dispatch?: (jobId: string) => void;
  readonly clock?: () => Date;
  readonly redactor?: Redactor;
  /**
   * p18-last-gaps: the project's job defaults (runtime routing, sandbox, approval policy, limits) for the job a compare
   * view's "Değişiklik iste" starts on a pull request's branch (absent: that path is unavailable).
   */
  readonly defaults?: ProjectDefaults;
}

/**
 * p18-last-gaps: where "Değişiklik iste" of a compare view goes — the job whose branch (or verified head) the compare's
 * head is (its message / follow-up path), a pull request of the same repository whose head it is (a new job on that
 * branch), or nowhere (`reason`: `no_target`, `pull_fork`, `pull_branch`, `provider_unavailable`).
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

export interface CompareAnchor {
  readonly base: string;
  readonly head: string;
}

export interface FileSide {
  readonly sha: string | null;
  readonly state: 'text' | 'binary' | 'too_large' | 'absent';
  readonly size: number;
  readonly text: string | null;
}

export interface CodeFile {
  readonly project: string;
  readonly source: 'repo' | 'workfiles';
  /** Commit sha (repo) or job id (workfiles). */
  readonly ref: string;
  readonly path: string;
  readonly state: 'text' | 'binary' | 'too_large';
  readonly size: number;
  readonly text: string | null;
  readonly language: string | null;
  /** The redaction changed the text (secrets masked). */
  readonly redacted: boolean;
}

export interface ReviewFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
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

export interface CommentInput {
  readonly path: string;
  readonly side: 'old' | 'new';
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly parentId?: string | undefined;
}

export interface RejectedHunk {
  readonly path: string;
  readonly previousPath?: string | undefined;
  /** Lines of the base (old) side, or null when the hunk only adds. */
  readonly oldStart: number | null;
  readonly oldEnd: number | null;
  readonly newStart: number | null;
  readonly newEnd: number | null;
}

type Cached = { readonly bytes: number; readonly value: unknown };

function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message);
}

/** Provider failures → HTTP (transient: 503, a missing object: 404, anything else: 502). */
function providerHttp(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof ProviderError) {
    if (err.transient)
      throw new HttpError(503, 'provider_unavailable', 'The git provider did not answer; try again.');
    if (err.status === 404) throw notFound('code_not_found', 'Not found in the repository.');
    throw new HttpError(502, 'provider_error', 'The git provider refused the read.');
  }
  throw err;
}

export class CodeService {
  readonly #redactor: Redactor;
  /** p18-leftovers: open pull requests per project (+ config version), 60 s. */
  readonly #pulls = new Map<string, { at: number; items: PullRequestListItem[] }>();
  readonly #cache = new Map<string, Cached>();
  #cacheBytes = 0;

  constructor(private readonly deps: CodeServiceDeps) {
    this.#redactor = deps.redactor ?? new Redactor({ rules: DEFAULT_RULES });
  }

  #now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }

  // ------------------------------------------------------------------------------------------------ cache

  async #cached<T>(key: string, size: (v: T) => number, read: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit.value as T;
    }
    const value = await read();
    const bytes = size(value);
    if (bytes <= CACHE_BYTES / 8) {
      this.#cache.set(key, { bytes, value });
      this.#cacheBytes += bytes;
      while (this.#cache.size > CACHE_ENTRIES || this.#cacheBytes > CACHE_BYTES) {
        const first = this.#cache.keys().next();
        if (first.done === true) break;
        this.#cacheBytes -= this.#cache.get(first.value)?.bytes ?? 0;
        this.#cache.delete(first.value);
      }
    }
    return value;
  }

  // ------------------------------------------------------------------------------------------------ repository

  async #repo(project: string): Promise<{ provider: GitProvider; config: ProjectGitConfig }> {
    const source = this.deps.providers();
    let found: { provider: GitProvider; config: ProjectGitConfig } | null = null;
    try {
      found = source === null ? null : await source.providerFor(project);
    } catch (err) {
      if (err instanceof ProviderError && !err.transient)
        throw new HttpError(409, 'code_unavailable', 'This project has no repository the console can read.');
      providerHttp(err);
    }
    if (found === null)
      throw notFound('code_unavailable', 'This project has no repository the console can read.');
    if (found.provider.tree === undefined || found.provider.blob === undefined) {
      throw new HttpError(409, 'code_unsupported', 'This git provider cannot list files for the console.');
    }
    return found;
  }

  /** `ref`: a commit sha, a branch name, or empty for the project's base branch. */
  async #resolve(provider: GitProvider, config: ProjectGitConfig, ref: string | undefined): Promise<string> {
    const r = ref === undefined || ref === '' ? config.baseBranch : ref;
    if (SHA40.test(r)) return r;
    if (!isTargetBranch(r) && !isAttemptBranch(r))
      throw new HttpError(400, 'invalid_ref', 'Not a branch name or commit sha.');
    let sha: string | null;
    try {
      sha = await provider.branchHead(r);
    } catch (err) {
      providerHttp(err);
    }
    if (sha === null) throw notFound('ref_not_found', 'No such branch in the repository.');
    return sha;
  }

  async #blob(
    project: string,
    provider: GitProvider,
    config: ProjectGitConfig,
    sha: string,
    path: string,
  ): Promise<BlobRead | null> {
    if (provider.blob === undefined) return null;
    try {
      return await this.#cached(
        `${project}\0${String(config.version)}\0blob\0${sha}\0${path}`,
        (v: BlobRead | null) => (v?.state === 'text' ? v.text.length * 2 : 64),
        () => provider.blob?.(sha, path, MAX_CODE_FILE_BYTES) ?? Promise.resolve(null),
      );
    } catch (err) {
      providerHttp(err);
    }
  }

  #redact(text: string): { text: string; redacted: boolean } {
    const out = redactKeepingLines(this.#redactor, text);
    return { text: out, redacted: out !== text };
  }

  /** What the Kod tab shows first: the project's repository (or kept working files) and recent job branches. */
  async source(
    subject: Subject,
    project: string,
  ): Promise<{
    project: string;
    kind: 'repository' | 'workspace';
    provider: ProviderKind | null;
    repositoryUrl: string | null;
    defaultBranch: string | null;
    supported: boolean;
    reason: string | null;
    branches: {
      jobId: string;
      title: string;
      branch: string;
      headSha: string;
      baseSha: string | null;
      state: string;
      at: string;
    }[];
    workfiles: { jobId: string; title: string | null; keptAt: string; workerConnected: boolean }[];
  }> {
    const { rows } = await this.deps.pool.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [
      project,
    ]);
    const p = rows[0];
    if (p === undefined) throw notFound('project_not_found', 'Project not found.');
    if (p.kind === 'workspace') {
      const svc = this.deps.workfiles?.() ?? null;
      const kept =
        svc === null || !authorize(subject, 'workfiles.read', { project }).allow
          ? []
          : (await svc.list(subject, { project, limit: 50 })).items.filter((i) => i.state === 'kept');
      return {
        project,
        kind: 'workspace',
        provider: null,
        repositoryUrl: null,
        defaultBranch: null,
        supported: svc !== null,
        reason: null,
        branches: [],
        workfiles: kept.map((k) => ({
          jobId: k.jobId,
          title: k.jobTitle,
          keptAt: k.keptAt,
          workerConnected: k.workerConnected,
        })),
      };
    }
    const config = await loadGitConfig(this.deps.pool, project);
    let supported = false;
    let reason: string | null = config === null ? 'no_repository' : null;
    if (config !== null) {
      try {
        const found = await this.deps.providers()?.providerFor(project);
        supported =
          found !== undefined &&
          found !== null &&
          found.provider.tree !== undefined &&
          found.provider.blob !== undefined;
        if (!supported) reason = 'unsupported';
      } catch {
        reason = 'provider_unavailable';
      }
    }
    const { rows: jobs } = await this.deps.pool.query<{
      job_id: string;
      branch: string;
      head_sha: string;
      base_sha: string | null;
      state: string;
      updated_at: Date;
      title_stored: string | null;
      title_prompt: string | null;
    }>(
      `SELECT g.job_id::text AS job_id, g.branch, g.head_sha, g.base_sha, j.state::text AS state, g.updated_at,
              ${titleColumns()}
         FROM job_git g JOIN jobs j ON j.id = g.job_id LEFT JOIN job_titles jt ON jt.job_id = j.id
        WHERE g.project = $1 AND g.verification = 'passed' AND g.branch IS NOT NULL AND g.head_sha IS NOT NULL
        ORDER BY g.updated_at DESC LIMIT 20`,
      [project],
    );
    return {
      project,
      kind: 'repository',
      provider: config?.provider ?? null,
      repositoryUrl: config?.repositoryUrl ?? null,
      defaultBranch: config?.baseBranch ?? null,
      supported,
      reason,
      branches: jobs.map((j) => ({
        jobId: j.job_id,
        title: titleOrDerived(j),
        branch: j.branch,
        headSha: j.head_sha,
        baseSha: j.base_sha,
        state: j.state,
        at: j.updated_at.toISOString(),
      })),
      workfiles: [],
    };
  }

  /**
   * p18-leftovers: the repository's open pull / merge requests for the Kod tab (≤ 30, newest change first), each with
   * the refs its compare view opens (`base`: the target branch; `head`: the head commit, or the head branch of the same
   * repository; null when neither can be read here). Titles are redacted provider text. Cached 60 s per project.
   */
  async pullRequests(project: string): Promise<{ supported: boolean; items: PullRequestListItem[] }> {
    const { provider, config } = await this.#repo(project);
    if (provider.openPullRequests === undefined) return { supported: false, items: [] };
    const key = `${project}\0${String(config.version)}`;
    const now = this.#now().getTime();
    const hit = this.#pulls.get(key);
    if (hit !== undefined && now - hit.at < PULLS_TTL_MS) return { supported: true, items: hit.items };
    let list: readonly OpenPullRequest[];
    try {
      list = await provider.openPullRequests(MAX_PULLS);
    } catch (err) {
      providerHttp(err);
    }
    const items = list.slice(0, MAX_PULLS).map((pr): PullRequestListItem => {
      const base = isTargetBranch(pr.baseBranch) ? pr.baseBranch : null;
      const head =
        pr.headSha !== null && SHA40.test(pr.headSha)
          ? pr.headSha
          : pr.sameRepository && (isTargetBranch(pr.headBranch) || isAttemptBranch(pr.headBranch))
            ? pr.headBranch
            : null;
      return {
        number: pr.number,
        title: this.#redact(pr.title).text,
        url: /^https:\/\//.test(pr.url) ? pr.url : null,
        author: pr.author,
        draft: pr.draft,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        sameRepository: pr.sameRepository,
        updatedAt: pr.updatedAt,
        compare: base === null || head === null ? null : { base, head },
      };
    });
    if (this.#pulls.size > 200) this.#pulls.clear();
    this.#pulls.set(key, { at: now, items });
    return { supported: true, items };
  }

  /** One directory of the repository at `ref` (directories first, then files, by name). */
  async tree(
    project: string,
    ref: string | undefined,
    path: string,
  ): Promise<{ sha: string; path: string; entries: TreeEntry[]; truncated: boolean }> {
    if (!isRepoPath(path, true)) throw new HttpError(400, 'code_path_invalid', 'Not a repository path.');
    const { provider, config } = await this.#repo(project);
    const sha = await this.#resolve(provider, config, ref);
    let listing: TreeListing | null;
    try {
      listing = await this.#cached(
        `${project}\0${String(config.version)}\0tree\0${sha}\0${path}`,
        (v: TreeListing | null) => (v?.entries.length ?? 0) * 200,
        () => provider.tree?.(sha, path) ?? Promise.resolve(null),
      );
    } catch (err) {
      providerHttp(err);
    }
    if (listing === null) throw notFound('code_not_found', 'No such directory at this commit.');
    const entries = [...listing.entries]
      .sort((a, b) =>
        (a.kind === 'dir') !== (b.kind === 'dir')
          ? a.kind === 'dir'
            ? -1
            : 1
          : a.name.localeCompare(b.name),
      )
      .slice(0, MAX_TREE_ENTRIES);
    return { sha, path, entries, truncated: listing.truncated || listing.entries.length > MAX_TREE_ENTRIES };
  }

  /** One file of the repository at `ref`: redacted text ≤ 1 MiB, or a summary (binary / too large). */
  async file(project: string, ref: string | undefined, path: string): Promise<CodeFile> {
    if (!isRepoPath(path)) throw new HttpError(400, 'code_path_invalid', 'Not a repository path.');
    const { provider, config } = await this.#repo(project);
    const sha = await this.#resolve(provider, config, ref);
    const b = await this.#blob(project, provider, config, sha, path);
    if (b === null) throw notFound('code_not_found', 'No such file at this commit.');
    return this.#codeFile(project, 'repo', sha, path, b);
  }

  #codeFile(project: string, source: 'repo' | 'workfiles', ref: string, path: string, b: BlobRead): CodeFile {
    const base = { project, source, ref, path, size: b.size, language: languageOf(path) };
    if (b.state !== 'text') return { ...base, state: b.state, text: null, redacted: false };
    const r = this.#redact(b.text);
    return { ...base, state: 'text', text: r.text, redacted: r.redacted };
  }

  /** A kept working file of a workspace job (through its machine; the machine must be online). */
  async workfile(subject: Subject, jobId: string, path: string): Promise<CodeFile> {
    if (!isRepoPath(path)) throw new HttpError(400, 'code_path_invalid', 'Not a repository path.');
    const svc = this.deps.workfiles?.() ?? null;
    if (svc === null) throw notFound('code_unavailable', 'Working files are not available.');
    const f = await svc.open(subject, jobId, path);
    const project = (await svc.projectOfJob(jobId)) ?? '';
    if (f.size > MAX_CODE_FILE_BYTES)
      return this.#codeFile(project, 'workfiles', jobId, path, { state: 'too_large', size: f.size });
    const parts = [f.first];
    let total = f.first.length;
    for await (const c of f.rest()) {
      parts.push(c);
      total += c.length;
      if (total > MAX_CODE_FILE_BYTES) break;
    }
    return this.#codeFile(
      project,
      'workfiles',
      jobId,
      path,
      classifyBlob(Buffer.concat(parts), f.size, MAX_CODE_FILE_BYTES),
    );
  }

  // ------------------------------------------------------------------------------------------------ diffs

  /** Both sides of one changed file (`previousPath` for a rename). */
  async #sides(
    project: string,
    provider: GitProvider,
    config: ProjectGitConfig,
    base: string,
    head: string,
    path: string,
    previousPath: string | null,
  ): Promise<{ old: FileSide; new: FileSide }> {
    const side = async (sha: string, p: string): Promise<FileSide> => {
      const b = await this.#blob(project, provider, config, sha, p);
      if (b === null) return { sha, state: 'absent', size: 0, text: null };
      if (b.state !== 'text') return { sha, state: b.state, size: b.size, text: null };
      return { sha, state: 'text', size: b.size, text: this.#redact(b.text).text };
    };
    const [o, n] = await Promise.all([side(base, previousPath ?? path), side(head, path)]);
    return { old: o, new: n };
  }

  /** Two refs of the project compared (`base...head`): the changed files. */
  async compare(
    project: string,
    baseRef: string,
    headRef: string,
  ): Promise<{
    baseSha: string;
    headSha: string;
    mergeBase: string;
    files: ReviewFile[];
    truncated: boolean;
  }> {
    const { provider, config } = await this.#repo(project);
    const [baseSha, headSha] = await Promise.all([
      this.#resolve(provider, config, baseRef),
      this.#resolve(provider, config, headRef),
    ]);
    let c;
    try {
      c = await provider.compare(baseSha, headSha);
    } catch (err) {
      providerHttp(err);
    }
    return {
      baseSha,
      headSha,
      mergeBase: SHA40.test(c.mergeBase) ? c.mergeBase : baseSha,
      files: c.files.slice(0, MAX_REVIEW_FILES).map((f) => ({
        path: f.path,
        previousPath: f.previousPath ?? null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      truncated: c.truncated || c.files.length > MAX_REVIEW_FILES,
    };
  }

  /** One file of a compare: its two sides at the merge base and the head (both shas resolved by the caller). */
  async compareFile(
    project: string,
    base: string,
    head: string,
    path: string,
    previousPath: string | null,
  ): Promise<{ path: string; previousPath: string | null; old: FileSide; new: FileSide }> {
    if (!SHA40.test(base) || !SHA40.test(head))
      throw new HttpError(400, 'invalid_ref', 'Not a branch name or commit sha.');
    if (!isRepoPath(path) || (previousPath !== null && !isRepoPath(previousPath)))
      throw new HttpError(400, 'code_path_invalid', 'Not a repository path.');
    const { provider, config } = await this.#repo(project);
    return {
      path,
      previousPath,
      ...(await this.#sides(project, provider, config, base, head, path, previousPath)),
    };
  }

  async #verifiedJob(jobId: string): Promise<{
    project: string;
    baseSha: string;
    headSha: string;
    branch: string | null;
    targetBranch: string;
    files: ReviewFile[];
    truncated: boolean;
  }> {
    const record = await loadJobGit(this.deps.pool, jobId);
    if (
      record === null ||
      record.verification !== 'passed' ||
      record.baseSha === null ||
      record.headSha === null ||
      !SHA40.test(record.baseSha) ||
      !SHA40.test(record.headSha)
    ) {
      throw notFound(
        'review_unavailable',
        'This job has no verified changes to review (no git flow, not verified yet, or nothing changed).',
      );
    }
    const files = (record.changes?.files ?? []).slice(0, MAX_REVIEW_FILES).map((f) => ({
      path: f.path,
      previousPath: f.previousPath ?? null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
    return {
      project: record.project,
      baseSha: record.baseSha,
      headSha: record.headSha,
      branch: record.branch,
      targetBranch: record.targetBranch,
      files,
      truncated: record.changes?.truncated === true || (record.changes?.files.length ?? 0) > MAX_REVIEW_FILES,
    };
  }

  /** The job's verified changes for the reviewer: base / head, the changed files and the comment count. */
  async jobReview(jobId: string): Promise<{
    jobId: string;
    project: string;
    baseSha: string;
    headSha: string;
    branch: string | null;
    targetBranch: string;
    files: ReviewFile[];
    truncated: boolean;
    supported: boolean;
  }> {
    const v = await this.#verifiedJob(jobId);
    let supported: boolean;
    try {
      const found = await this.deps.providers()?.providerFor(v.project);
      supported = found !== undefined && found !== null && found.provider.blob !== undefined;
    } catch {
      supported = false;
    }
    return { jobId, ...v, supported };
  }

  async jobReviewFile(
    jobId: string,
    path: string,
    previousPath: string | null,
  ): Promise<{ path: string; previousPath: string | null; old: FileSide; new: FileSide }> {
    const v = await this.#verifiedJob(jobId);
    const listed = v.files.find((f) => f.path === path);
    if (listed === undefined && !v.truncated) throw notFound('code_not_found', 'This file did not change.');
    return this.compareFile(
      v.project,
      v.baseSha,
      v.headSha,
      path,
      previousPath ?? listed?.previousPath ?? null,
    );
  }

  // ------------------------------------------------------------------------------------------------ comments

  async comments(jobId: string, userId: string): Promise<ReviewComment[]> {
    const record = await loadJobGit(this.deps.pool, jobId);
    const head = record?.headSha ?? null;
    const { rows } = await this.deps.pool.query<CommentRow>(
      `SELECT c.*, c.id::text AS cid, c.parent_id::text AS pid, c.author_id::text AS aid, u.username
         FROM code_review_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.job_id = $1 ORDER BY c.created_at, c.id LIMIT $2`,
      [jobId, MAX_COMMENTS],
    );
    return rows.map((r) => commentView(r, userId, head));
  }

  async addComment(actor: CodeActor, jobId: string, input: CommentInput): Promise<ReviewComment> {
    const v = await this.#verifiedJob(jobId);
    if (!isRepoPath(input.path)) throw new HttpError(400, 'code_path_invalid', 'Not a repository path.');
    const body = input.body.trim();
    if (body === '') throw new HttpError(400, 'invalid_comment', 'A comment needs text.');
    const { rows: count } = await this.deps.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM code_review_comments WHERE job_id = $1',
      [jobId],
    );
    if (Number(count[0]?.n ?? 0) >= MAX_COMMENTS)
      throw new HttpError(409, 'too_many_comments', 'This review has too many comments.');
    let anchor = {
      path: input.path,
      side: input.side,
      start: input.startLine,
      end: input.endLine,
      sha: v.headSha,
    };
    if (input.parentId !== undefined) {
      if (!UUID.test(input.parentId)) throw notFound('comment_not_found', 'Comment not found.');
      const { rows } = await this.deps.pool.query<{
        path: string;
        side: 'old' | 'new';
        start_line: number;
        end_line: number;
        commit_sha: string;
        parent_id: string | null;
      }>(
        `SELECT path, side, start_line, end_line, commit_sha, parent_id::text AS parent_id
           FROM code_review_comments WHERE id = $1 AND job_id = $2`,
        [input.parentId, jobId],
      );
      const parent = rows[0];
      if (parent === undefined || parent.parent_id !== null)
        throw notFound('comment_not_found', 'Comment not found.');
      // A reply sits on its thread's anchor.
      anchor = {
        path: parent.path,
        side: parent.side,
        start: parent.start_line,
        end: parent.end_line,
        sha: parent.commit_sha,
      };
    }
    const id = randomUUID();
    const now = this.#now();
    await this.deps.pool.query(
      `INSERT INTO code_review_comments
         (id, project, job_id, commit_sha, path, side, start_line, end_line, parent_id, body, author_id, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
      [
        id,
        v.project,
        jobId,
        anchor.sha,
        anchor.path,
        anchor.side,
        anchor.start,
        anchor.end,
        input.parentId ?? null,
        body,
        actor.userId,
        now,
      ],
    );
    const all = await this.comments(jobId, actor.userId);
    const made = all.find((c) => c.id === id);
    if (made === undefined) throw new Error('comment not stored');
    return made;
  }

  /** Edit one's own comment, or (any reviewer) resolve / reopen a thread. */
  async updateComment(
    actor: CodeActor,
    jobId: string,
    id: string,
    patch: { readonly body?: string | undefined; readonly resolved?: boolean | undefined },
  ): Promise<ReviewComment> {
    const row = await this.#comment(jobId, id);
    const now = this.#now();
    if (patch.body !== undefined) {
      if (row.author_id !== actor.userId)
        throw new HttpError(403, 'comment_forbidden', 'Only the author edits or deletes a comment.');
      const body = patch.body.trim();
      if (body === '') throw new HttpError(400, 'invalid_comment', 'A comment needs text.');
      await this.deps.pool.query('UPDATE code_review_comments SET body = $2, updated_at = $3 WHERE id = $1', [
        id,
        body,
        now,
      ]);
    }
    if (patch.resolved !== undefined) {
      await this.deps.pool.query(
        `UPDATE code_review_comments SET resolved_at = $2, resolved_by = $3, updated_at = $4 WHERE id = $1`,
        [id, patch.resolved ? now : null, patch.resolved ? actor.userId : null, now],
      );
    }
    const made = (await this.comments(jobId, actor.userId)).find((c) => c.id === id);
    if (made === undefined) throw notFound('comment_not_found', 'Comment not found.');
    return made;
  }

  /** Delete one's own comment (owners / admins any comment); a thread's first comment takes its replies along. */
  async deleteComment(actor: CodeActor, jobId: string, id: string): Promise<void> {
    const row = await this.#comment(jobId, id);
    const admin = actor.subject.role === 'owner' || actor.subject.role === 'admin';
    if (row.author_id !== actor.userId && !admin)
      throw new HttpError(403, 'comment_forbidden', 'Only the author edits or deletes a comment.');
    await this.deps.pool.query('DELETE FROM code_review_comments WHERE id = $1', [id]);
  }

  async #comment(jobId: string, id: string): Promise<{ author_id: string | null }> {
    if (!UUID.test(id)) throw notFound('comment_not_found', 'Comment not found.');
    const { rows } = await this.deps.pool.query<{ author_id: string | null }>(
      'SELECT author_id::text AS author_id FROM code_review_comments WHERE id = $1 AND job_id = $2',
      [id, jobId],
    );
    const r = rows[0];
    if (r === undefined) throw notFound('comment_not_found', 'Comment not found.');
    return r;
  }

  // ------------------------------------------------------------------------------------------------ request changes

  /**
   * "Değişiklik iste": the open comment threads and the rejected hunks (exact old / new lines, re-read from the
   * provider — never the browser's copy) as one review text. While the job's agent runs (or will), the text goes to it
   * as a job message; when the job is over, a follow-up job starts from the job's verified head with the same
   * settings and the review in its prompt. Nothing is written to a branch here.
   */
  async requestChanges(
    actor: CodeActor,
    jobId: string,
    input: { readonly note?: string | undefined; readonly hunks?: readonly RejectedHunk[] | undefined },
  ): Promise<{ mode: 'message' | 'job'; messageId: string | null; jobId: string | null; comments: number }> {
    const v = await this.#verifiedJob(jobId);
    const { provider, config } = await this.#repo(v.project);
    // Open threads (their first comment not resolved) with their replies.
    const open = openThreads(await this.comments(jobId, actor.userId));
    const hunks = (input.hunks ?? []).slice(0, MAX_REJECTED_HUNKS);
    const note = (input.note ?? '').trim().slice(0, 4000);
    if (open.length === 0 && hunks.length === 0 && note === '')
      throw new HttpError(400, 'review_empty', 'Write a note, a comment or reject a change first.');
    const text = await this.#reviewText(v, provider, config, note, open, hunks);
    const out = await this.#toJob(actor, jobId, v, text);
    const now = this.#now();
    if (open.length > 0) {
      await this.deps.pool.query(
        'UPDATE code_review_comments SET sent_at = $2, updated_at = $2 WHERE id = ANY($1::uuid[])',
        [open.map((c) => c.id), now],
      );
    }
    await this.deps.audit
      .record({
        actor: { type: 'user', id: actor.userId },
        action: 'code.review.request_changes',
        target: `job:${jobId}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: {
          mode: out.mode,
          comments: open.length,
          hunks: hunks.length,
          headSha: v.headSha,
          ...(out.jobId === null ? {} : { newJobId: out.jobId }),
          ...(out.messageId === null ? {} : { messageId: out.messageId }),
        },
      })
      .catch(() => undefined);
    return { ...out, comments: open.length };
  }

  /**
   * The review text to a job: a message to its agent while it runs (or will), else a follow-up job from its verified
   * head with the same settings, the review in its prompt and the original target branch.
   */
  async #toJob(
    actor: CodeActor,
    jobId: string,
    v: { project: string; headSha: string; branch: string | null; targetBranch: string },
    text: string,
  ): Promise<{ mode: 'message' | 'job'; messageId: string | null; jobId: string | null }> {
    const { rows: jobRows } = await this.deps.pool.query<{
      state: string;
      spec: Record<string, unknown>;
      priority: number;
    }>('SELECT state::text AS state, spec, priority FROM jobs WHERE id = $1', [jobId]);
    const job = jobRows[0];
    if (job === undefined) throw notFound('job_not_found', 'Job not found.');
    const messages = this.deps.jobMessages?.() ?? null;
    const status = messages === null ? null : await messages.status(jobId);
    if (messages !== null && status?.supported === true) {
      if (!authorize(actor.subject, 'jobs.message', { project: v.project }).allow)
        throw new HttpError(403, 'forbidden', 'Not allowed.');
      const sent = await messages.send(
        jobId,
        text.slice(0, MAX_MESSAGE_CHARS),
        { userId: actor.userId, ip: actor.ip, userAgent: actor.userAgent },
        { source: 'panel' },
      );
      return { mode: 'message', messageId: sent.messageId, jobId: null };
    }
    if (BUSY_STATES.has(job.state))
      throw new HttpError(
        409,
        'job_busy',
        'The agent of this job is still working and cannot take a message; wait until it ends.',
      );
    if (!authorize(actor.subject, 'jobs.create', { project: v.project }).allow)
      throw new HttpError(403, 'forbidden', 'Not allowed.');
    const jobs = this.deps.jobs;
    if (jobs === undefined) throw new HttpError(503, 'unavailable', 'This is not available.');
    const title = (await jobTitle(this.deps.pool, jobId)) ?? jobId.slice(0, 8);
    const original = typeof job.spec.prompt === 'string' ? job.spec.prompt.slice(0, 100 * 1024) : '';
    const prompt = [
      original,
      '',
      '---',
      `[Remyral] This job continues job ${jobId} on its changes: the workspace starts at its verified head ${v.headSha.slice(0, 12)} (branch ${v.branch ?? '—'}).`,
      'A reviewer asked for changes. Address every point below, keep what was not questioned, and finish the task:',
      '',
      text,
    ].join('\n');
    const spec = rerunSpec(job.spec, prompt, `Review: ${title}`.slice(0, 120));
    const repo = spec.repository as Record<string, unknown> | undefined;
    if (repo === undefined)
      throw notFound(
        'review_unavailable',
        'This job has no verified changes to review (no git flow, not verified yet, or nothing changed).',
      );
    // p18-leftovers: the follow-up starts at the verified head (a commit) but its pull request targets the original
    // job's target branch, not the project's base branch.
    spec.repository = {
      ...repo,
      baseRef: v.headSha,
      workBranch: `agent/review-${randomUUID().slice(0, 8)}`,
      targetBranch: v.targetBranch,
    };
    const created = await jobs.create({
      project: v.project,
      spec,
      priority: job.priority,
      actor: { type: 'user', id: actor.userId },
      submit: true,
    });
    this.deps.dispatch?.(created.job.id);
    return { mode: 'job', messageId: null, jobId: created.job.id };
  }

  // ------------------------------------------------------------------------------------- compare comments (p18-last-gaps)

  /** The commit a compare's head ref resolves to now; null when the branch is gone or the provider is down. */
  async #headNow(project: string, headRef: string): Promise<string | null> {
    try {
      const { provider, config } = await this.#repo(project);
      return await this.#resolve(provider, config, headRef);
    } catch {
      return null; // nothing is shown as outdated then
    }
  }

  /** A compare ref as the view names it: a commit sha or a branch the console may read. */
  #compareRef(ref: string): string {
    const r = ref.trim();
    if (!SHA40.test(r) && !isTargetBranch(r) && !isAttemptBranch(r))
      throw new HttpError(400, 'invalid_ref', 'Not a branch name or commit sha.');
    return r;
  }

  /**
   * The comments of a compare view (threads; "outdated" when the head ref resolves to another commit now) and where its
   * "Değişiklik iste" goes ({@link compareTarget}).
   */
  async compareComments(
    project: string,
    anchor: CompareAnchor,
    userId: string,
  ): Promise<{ comments: ReviewComment[]; headSha: string | null; target: CompareReviewTarget }> {
    const base = this.#compareRef(anchor.base);
    const head = this.#compareRef(anchor.head);
    await this.#repo(project);
    const headSha = await this.#headNow(project, head);
    const comments = await this.#compareList(project, base, head, userId, headSha);
    return { comments, headSha, target: await this.compareTarget(project, head) };
  }

  async #compareList(
    project: string,
    base: string,
    head: string,
    userId: string,
    headSha: string | null,
  ): Promise<ReviewComment[]> {
    const { rows } = await this.deps.pool.query<CommentRow>(
      `SELECT c.*, c.head_sha AS commit_sha, c.id::text AS cid, c.parent_id::text AS pid, c.author_id::text AS aid,
              u.username
         FROM code_compare_comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.project = $1 AND c.base_ref = $2 AND c.head_ref = $3 ORDER BY c.created_at, c.id LIMIT $4`,
      [project, base, head, MAX_COMMENTS],
    );
    return rows.map((r) => commentView(r, userId, headSha));
  }

  /**
   * Where "Değişiklik iste" of a compare view goes: the job whose verified branch / head the compare's head is, else an
   * open pull request of the same repository whose head it is, else nowhere (with the reason).
   */
  async compareTarget(project: string, headRef: string): Promise<CompareReviewTarget> {
    const head = this.#compareRef(headRef);
    const { rows } = await this.deps.pool.query<{ job_id: string; branch: string | null }>(
      `SELECT g.job_id::text AS job_id, g.branch FROM job_git g
        WHERE g.project = $1 AND g.verification = 'passed' AND g.head_sha IS NOT NULL
          AND (g.branch = $2 OR g.head_sha = $2)
        ORDER BY g.updated_at DESC LIMIT 1`,
      [project, head],
    );
    const job = rows[0];
    if (job !== undefined) return { mode: 'job', jobId: job.job_id, branch: job.branch };
    let pulls: readonly PullRequestListItem[];
    try {
      pulls = (await this.pullRequests(project)).items;
    } catch {
      return { mode: 'none', reason: 'provider_unavailable' };
    }
    const pr = pulls.find((p) => p.compare?.head === head || (p.sameRepository && p.headBranch === head));
    if (pr === undefined) return { mode: 'none', reason: 'no_target' };
    if (!pr.sameRepository) return { mode: 'none', reason: 'pull_fork' };
    if (!isTargetBranch(pr.headBranch)) return { mode: 'none', reason: 'pull_branch' };
    return {
      mode: 'pull',
      number: pr.number,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      headSha: pr.compare !== null && SHA40.test(pr.compare.head) ? pr.compare.head : null,
    };
  }

  /** A comment on lines of a compare view (anchored to the commits the view showed), or a reply to a thread. */
  async addCompareComment(
    actor: CodeActor,
    project: string,
    anchor: CompareAnchor & { readonly baseSha: string; readonly headSha: string },
    input: CommentInput,
  ): Promise<ReviewComment> {
    const base = this.#compareRef(anchor.base);
    const head = this.#compareRef(anchor.head);
    if (!SHA40.test(anchor.baseSha) || !SHA40.test(anchor.headSha))
      throw new HttpError(400, 'invalid_ref', 'Not a branch name or commit sha.');
    if (!isRepoPath(input.path)) throw new HttpError(400, 'code_path_invalid', 'Not a repository path.');
    const body = input.body.trim();
    if (body === '') throw new HttpError(400, 'invalid_comment', 'A comment needs text.');
    // The project must have a repository the console reads (as the compare view itself).
    await this.#repo(project);
    const { rows: count } = await this.deps.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM code_compare_comments WHERE project = $1 AND base_ref = $2 AND head_ref = $3`,
      [project, base, head],
    );
    if (Number(count[0]?.n ?? 0) >= MAX_COMMENTS)
      throw new HttpError(409, 'too_many_comments', 'This review has too many comments.');
    let a = {
      path: input.path,
      side: input.side,
      start: input.startLine,
      end: input.endLine,
      baseSha: anchor.baseSha,
      headSha: anchor.headSha,
    };
    if (input.parentId !== undefined) {
      if (!UUID.test(input.parentId)) throw notFound('comment_not_found', 'Comment not found.');
      const { rows } = await this.deps.pool.query<{
        path: string;
        side: 'old' | 'new';
        start_line: number;
        end_line: number;
        base_sha: string;
        head_sha: string;
        parent_id: string | null;
      }>(
        `SELECT path, side, start_line, end_line, base_sha, head_sha, parent_id::text AS parent_id
           FROM code_compare_comments WHERE id = $1 AND project = $2 AND base_ref = $3 AND head_ref = $4`,
        [input.parentId, project, base, head],
      );
      const parent = rows[0];
      if (parent === undefined || parent.parent_id !== null)
        throw notFound('comment_not_found', 'Comment not found.');
      a = {
        path: parent.path,
        side: parent.side,
        start: parent.start_line,
        end: parent.end_line,
        baseSha: parent.base_sha,
        headSha: parent.head_sha,
      };
    }
    const id = randomUUID();
    const now = this.#now();
    await this.deps.pool.query(
      `INSERT INTO code_compare_comments
         (id, project, base_ref, head_ref, base_sha, head_sha, path, side, start_line, end_line, parent_id, body,
          author_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [
        id,
        project,
        base,
        head,
        a.baseSha,
        a.headSha,
        a.path,
        a.side,
        a.start,
        a.end,
        input.parentId ?? null,
        body,
        actor.userId,
        now,
      ],
    );
    return this.#compareOne(project, id, actor.userId);
  }

  async #compareRow(
    project: string,
    id: string,
  ): Promise<{ author_id: string | null; base_ref: string; head_ref: string }> {
    if (!UUID.test(id)) throw notFound('comment_not_found', 'Comment not found.');
    const { rows } = await this.deps.pool.query<{
      author_id: string | null;
      base_ref: string;
      head_ref: string;
    }>(
      `SELECT author_id::text AS author_id, base_ref, head_ref FROM code_compare_comments
        WHERE id = $1 AND project = $2`,
      [id, project],
    );
    const r = rows[0];
    if (r === undefined) throw notFound('comment_not_found', 'Comment not found.');
    return r;
  }

  /** One comment as the list shows it (outdated against the head ref's current commit). */
  async #compareOne(project: string, id: string, userId: string): Promise<ReviewComment> {
    const row = await this.#compareRow(project, id);
    const headSha = await this.#headNow(project, row.head_ref);
    const made = (await this.#compareList(project, row.base_ref, row.head_ref, userId, headSha)).find(
      (c) => c.id === id,
    );
    if (made === undefined) throw notFound('comment_not_found', 'Comment not found.');
    return made;
  }

  /** Edit one's own compare comment, or (any reviewer) resolve / reopen a thread. */
  async updateCompareComment(
    actor: CodeActor,
    project: string,
    id: string,
    patch: { readonly body?: string | undefined; readonly resolved?: boolean | undefined },
  ): Promise<ReviewComment> {
    const row = await this.#compareRow(project, id);
    const now = this.#now();
    if (patch.body !== undefined) {
      if (row.author_id !== actor.userId)
        throw new HttpError(403, 'comment_forbidden', 'Only the author edits or deletes a comment.');
      const body = patch.body.trim();
      if (body === '') throw new HttpError(400, 'invalid_comment', 'A comment needs text.');
      await this.deps.pool.query(
        'UPDATE code_compare_comments SET body = $2, updated_at = $3 WHERE id = $1',
        [id, body, now],
      );
    }
    if (patch.resolved !== undefined) {
      await this.deps.pool.query(
        `UPDATE code_compare_comments SET resolved_at = $2, resolved_by = $3, updated_at = $4 WHERE id = $1`,
        [id, patch.resolved ? now : null, patch.resolved ? actor.userId : null, now],
      );
    }
    return this.#compareOne(project, id, actor.userId);
  }

  /** Delete one's own compare comment (owners / admins any); a thread's first comment takes its replies along. */
  async deleteCompareComment(actor: CodeActor, project: string, id: string): Promise<void> {
    const row = await this.#compareRow(project, id);
    const admin = actor.subject.role === 'owner' || actor.subject.role === 'admin';
    if (row.author_id !== actor.userId && !admin)
      throw new HttpError(403, 'comment_forbidden', 'Only the author edits or deletes a comment.');
    await this.deps.pool.query('DELETE FROM code_compare_comments WHERE id = $1', [id]);
  }

  /**
   * "Değişiklik iste" of a compare view: the open threads, the rejected hunks (re-read from the provider at the
   * compare's merge base and head — never the browser's copy) and a note as one review text. If the head is a job's
   * branch, it takes that job's path (a message to its agent, or a follow-up job). If it is the head of an open pull
   * request of the same repository, a new job starts on that branch — at the pull request's head, its own pull request
   * targeting the pull request's branch — with the review in its prompt (the job create rules: `jobs.create`, the
   * project's job defaults, the JobSpec check). Otherwise 409 with the reason. Nothing is written to a branch here.
   */
  async compareRequestChanges(
    actor: CodeActor,
    project: string,
    anchor: CompareAnchor,
    input: { readonly note?: string | undefined; readonly hunks?: readonly RejectedHunk[] | undefined },
  ): Promise<{
    mode: 'message' | 'job';
    target: 'job' | 'pull';
    messageId: string | null;
    jobId: string | null;
    comments: number;
  }> {
    const base = this.#compareRef(anchor.base);
    const head = this.#compareRef(anchor.head);
    const target = await this.compareTarget(project, head);
    if (target.mode === 'none')
      throw new HttpError(
        409,
        'review_no_target',
        target.reason === 'pull_fork'
          ? 'This pull request comes from a fork; the console cannot start a job on its branch.'
          : target.reason === 'provider_unavailable'
            ? 'The git provider did not answer; try again.'
            : 'This compare is neither a job’s branch nor an open pull request of this repository; there is nobody to send the review to.',
        {},
        {},
        { reason: target.reason },
      );
    const { provider, config } = await this.#repo(project);
    const cmp = await this.compare(project, base, head);
    const open = openThreads(await this.#compareList(project, base, head, actor.userId, cmp.headSha));
    const hunks = (input.hunks ?? []).slice(0, MAX_REJECTED_HUNKS);
    const note = (input.note ?? '').trim().slice(0, 4000);
    if (open.length === 0 && hunks.length === 0 && note === '')
      throw new HttpError(400, 'review_empty', 'Write a note, a comment or reject a change first.');
    const text = await this.#reviewText(
      { project, baseSha: cmp.mergeBase, headSha: cmp.headSha },
      provider,
      config,
      note,
      open,
      hunks,
    );
    let out: { mode: 'message' | 'job'; messageId: string | null; jobId: string | null };
    if (target.mode === 'job') {
      out = await this.#toJob(actor, target.jobId, await this.#verifiedJob(target.jobId), text);
    } else {
      out = await this.#pullJob(actor, project, config, target, cmp.headSha, text);
    }
    const now = this.#now();
    if (open.length > 0) {
      await this.deps.pool.query(
        'UPDATE code_compare_comments SET sent_at = $2, updated_at = $2 WHERE id = ANY($1::uuid[])',
        [open.map((c) => c.id), now],
      );
    }
    await this.deps.audit
      .record({
        actor: { type: 'user', id: actor.userId },
        action: 'code.review.request_changes',
        target: target.mode === 'job' ? `job:${target.jobId}` : `project:${project}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: {
          source: 'compare',
          project,
          base,
          head,
          mode: out.mode,
          reason: target.mode === 'job' ? 'job_branch' : 'pull_request',
          ...(target.mode === 'pull' ? { pullRequest: target.number } : {}),
          comments: open.length,
          hunks: hunks.length,
          headSha: cmp.headSha,
          ...(out.jobId === null ? {} : { newJobId: out.jobId }),
          ...(out.messageId === null ? {} : { messageId: out.messageId }),
        },
      })
      .catch(() => undefined);
    return { ...out, target: target.mode, comments: open.length };
  }

  /** A new job on a pull request's branch with the review in its prompt (the job create rules). */
  async #pullJob(
    actor: CodeActor,
    project: string,
    config: ProjectGitConfig,
    pr: Extract<CompareReviewTarget, { mode: 'pull' }>,
    headSha: string,
    review: string,
  ): Promise<{ mode: 'job'; messageId: null; jobId: string }> {
    if (!authorize(actor.subject, 'jobs.create', { project }).allow)
      throw new HttpError(403, 'forbidden', 'Not allowed.');
    const jobs = this.deps.jobs;
    const defaults = this.deps.defaults;
    if (jobs === undefined || defaults === undefined)
      throw new HttpError(503, 'unavailable', 'This is not available.');
    const prompt = [
      `Review of pull request #${String(pr.number)} (branch ${pr.headBranch} into ${pr.baseBranch}).`,
      `The workspace starts at the pull request's head ${headSha.slice(0, 12)}. A reviewer asked for changes: address every point below and keep what was not questioned. Your changes become a pull request into ${pr.headBranch}.`,
      '',
      review,
    ].join('\n');
    const draft: Record<string, unknown> = {
      projectId: project,
      prompt,
      title: normalizeJobTitle(`Review: PR #${String(pr.number)}`) ?? `Review PR ${String(pr.number)}`,
      role: 'execute',
      limits: {},
      repository: {
        url: config.repositoryUrl,
        baseRef: headSha,
        workBranch: `agent/review-${randomUUID().slice(0, 8)}`,
        targetBranch: pr.headBranch,
      },
    };
    const applied = await defaults.apply(project, draft);
    const spec: Record<string, unknown> = { ...applied.spec };
    if (spec.runtime === undefined) {
      const facts = await defaults.facts(project);
      const ready =
        facts.runtimes?.find((r) => r.feasible.length > 0) ??
        facts.runtimes?.find((r) => r.eligible.length > 0);
      spec.runtime = ready?.runtime ?? 'claude-code';
    }
    const check = JobSpec.safeParse(spec);
    const issues = check.success
      ? ''
      : check.error.issues
          .slice(0, 5)
          .map((x) => `${x.path.join('.')}:${x.code}`)
          .join(', ');
    if (!check.success) throw new HttpError(400, 'invalid_job', `Invalid job: ${issues}`, {}, {}, { issues });
    const created = await jobs.create({
      project,
      spec,
      priority: 0,
      actor: { type: 'user', id: actor.userId },
      submit: true,
    });
    this.deps.dispatch?.(created.job.id);
    return { mode: 'job', messageId: null, jobId: created.job.id };
  }

  async #reviewText(
    v: { project: string; baseSha: string; headSha: string },
    provider: GitProvider,
    config: ProjectGitConfig,
    note: string,
    open: readonly ReviewComment[],
    hunks: readonly RejectedHunk[],
  ): Promise<string> {
    const parts: string[] = ['Review of the changes (from the console):'];
    if (note !== '') parts.push('', note);
    const threads = open.filter((c) => c.parentId === null);
    if (threads.length > 0) {
      parts.push('', 'Comments:');
      for (const t of threads) {
        const where = `${t.path}:${String(t.startLine)}${t.endLine === t.startLine ? '' : `-${String(t.endLine)}`} (${t.side === 'old' ? 'before' : 'after'} the change)`;
        parts.push(`- ${where}: ${t.body}`);
        for (const r of open.filter((c) => c.parentId === t.id)) parts.push(`  - reply: ${r.body}`);
      }
    }
    if (hunks.length > 0) {
      parts.push('', 'Rejected changes — undo or redo these:');
      for (const h of hunks) {
        if (!isRepoPath(h.path) || (h.previousPath !== undefined && !isRepoPath(h.previousPath))) continue;
        const read = async (
          sha: string,
          path: string,
          a: number | null,
          b: number | null,
        ): Promise<string> => {
          if (a === null || b === null || a < 1 || b < a) return '';
          const blob = await this.#blob(v.project, provider, config, sha, path);
          if (blob?.state !== 'text') return '';
          const s = sliceLines(this.#redact(blob.text).text, a, Math.min(b, a + MAX_HUNK_LINES - 1));
          return s.text;
        };
        const before = await read(v.baseSha, h.previousPath ?? h.path, h.oldStart, h.oldEnd);
        const after = await read(v.headSha, h.path, h.newStart, h.newEnd);
        const lines =
          h.newStart !== null && h.newEnd !== null
            ? `${String(h.newStart)}-${String(h.newEnd)}`
            : `old ${String(h.oldStart ?? 0)}-${String(h.oldEnd ?? 0)}`;
        parts.push(`- ${h.path} lines ${lines}:`);
        if (before !== '') parts.push('  before:', fence(before));
        if (after !== '') parts.push('  after (rejected):', fence(after));
      }
    }
    return parts.join('\n');
  }

  // ------------------------------------------------------------------------------------------------ references

  /**
   * p19-ide W1 §6: a chat `code` reference re-read at send time with the sender's current rights: the lines at the
   * pinned commit (or the kept working file), cut to 400 lines / 24 KiB, redacted. Null when it cannot be read
   * (no right, no such file / lines, offline machine) — the mention is then dropped like any other.
   */
  async reference(
    subject: Subject,
    project: string,
    ref: CodeRef,
  ): Promise<{ chip: { id: string; project: string; label: string }; data: Record<string, unknown> } | null> {
    if (!authorize(subject, 'code.read', { project }).allow) return null;
    let text: string;
    if (ref.source === 'repo') {
      const { provider, config } = await this.#repo(project);
      const b = await this.#blob(project, provider, config, ref.ref, ref.path);
      if (b?.state !== 'text') return null;
      text = b.text;
    } else if (ref.source === 'ide') {
      const ide = this.deps.ide?.() ?? null;
      if (ide === null || (await ide.referenceProject(subject, ref.ref)) !== project) return null;
      const t = await ide.readFile(subject, ref.ref, ref.path);
      if (t === null) return null;
      text = t;
    } else {
      const svc = this.deps.workfiles?.() ?? null;
      if (svc === null || (await svc.projectOfJob(ref.ref)) !== project) return null;
      const f = await this.workfile(subject, ref.ref, ref.path);
      if (f.state !== 'text' || f.text === null) return null;
      text = f.text;
    }
    const s = sliceLines(this.#redact(text).text, ref.startLine, ref.endLine);
    if (ref.startLine > s.totalLines) return null;
    const label = codeRefLabel(ref);
    return {
      chip: { id: codeRefId(ref), project, label },
      data: {
        type: 'code',
        project,
        path: ref.path,
        ...(ref.source === 'repo'
          ? { commit: ref.ref }
          : ref.source === 'ide'
            ? {
                ideWorkspace: ref.ref,
                note: 'the file as it is now in the IDE workspace (may be uncommitted)',
              }
            : { workingFilesOfJob: ref.ref }),
        lines: `${String(ref.startLine)}-${String(s.endLine)}`,
        language: languageOf(ref.path),
        ...(s.truncated
          ? {
              truncated: `cut to ${String(MAX_REFERENCE_LINES)} lines / 24 KiB; ask the user for more if needed`,
            }
          : {}),
        text: s.text,
      },
    };
  }
}

/** The open threads (their first comment not resolved) with their replies. */
function openThreads(all: readonly ReviewComment[]): ReviewComment[] {
  const roots = new Set(all.filter((c) => c.parentId === null && !c.resolved).map((c) => c.id));
  return all.filter((c) => roots.has(c.parentId ?? c.id));
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '~~~~' : '```';
  return `${ticks}\n${text}\n${ticks}`;
}

interface CommentRow {
  cid: string;
  pid: string | null;
  aid: string | null;
  username: string | null;
  path: string;
  side: 'old' | 'new';
  start_line: number;
  end_line: number;
  commit_sha: string;
  body: string;
  resolved_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function commentView(r: CommentRow, userId: string, head: string | null): ReviewComment {
  return {
    id: r.cid,
    parentId: r.pid,
    path: r.path,
    side: r.side,
    startLine: r.start_line,
    endLine: r.end_line,
    commitSha: r.commit_sha,
    body: r.body,
    author: { id: r.aid, name: r.username },
    mine: r.aid === userId,
    resolved: r.resolved_at !== null,
    outdated: head !== null && r.commit_sha !== head,
    sentAt: r.sent_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
