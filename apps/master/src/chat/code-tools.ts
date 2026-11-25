import {
  type AssistantCodeCard,
  CODE_READ_MAX_LINES,
  CODE_REVIEW_MAX_COMMENTS,
  type IdeGitResultPayload,
} from '@remyral/protocol';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { authorize, type Subject } from '../authz/model.js';
import type { CodeService } from '../code/service.js';
import { redactKeepingLines } from '../code/service.js';
import type { Queryable } from '../db/pool.js';
import { loadJobGit } from '../gitflow/store.js';
import { isRepoPath, type TreeEntry } from '../gitflow/types.js';
import { HttpError } from '../http/errors.js';
import type { IdeWorkspaceView } from '../ide/service.js';
import { jobTitle } from '../jobs/titles.js';
import { adminCard, type ReadResult } from './admin-actions.js';
import type { OpsApplyContext } from './ops-tools.js';
import type { DraftPlan } from './settings-actions.js';

/**
 * p19-ide W4 (docs/design/p19-ide.md §6, §9 W4): the assistant and the code viewer / IDE. Everything runs for the user
 * who sent the turn, through the services the console's code routes use, with that user's rights:
 *
 * - `read_code` / `list_code`: the code service (`code.read`, provider reads by commit, ≤ 1 MiB files, redacted with
 *   the line-keeping redaction). A call returns at most {@link CODE_READ_MAX_LINES} lines / {@link MAX_READ_BYTES}.
 *   `list_code` with a query walks at most {@link MAX_SEARCH_DIRS} directories breadth-first (names only).
 * - `read_workspace_diff`: a Tam IDE workspace's uncommitted diff from its machine (IDE_GIT `diff`, `ide-diff-v1`) —
 *   the owner's own workspaces, or `ide.manage`; redacted here.
 * - `open_code` / `open_diff`: no navigation — they check the target and return an {@link AssistantCodeCard} the chat
 *   service stores on the tool message; the web renders it as an "Aç" card the user clicks.
 * - `draft_review_changes` → op `code.request_changes` (an administration card, `code.review`, event chat.cards): on
 *   confirmation the assistant's line comments become the job's review comments ("[Asistan] …", authored by the
 *   confirming user) and the review goes the console's "Değişiklik iste" path (CodeService.requestChanges) — a message to
 *   the running agent or a follow-up job on the job's head. Nothing writes to a branch.
 *
 * File contents and diffs are untrusted data: the chat service fences every tool result for the model.
 */

/** Bytes of text one read_code call returns at most (line-number prefixes included). */
export const MAX_READ_BYTES = 48 * 1024;
/** Directories a list_code search reads at most, and the matches it returns. */
export const MAX_SEARCH_DIRS = 60;
const MAX_SEARCH_MATCHES = 200;
/** Entries a plain list_code returns to the model (the code service lists ≤ 2000). */
const MAX_LIST_ENTRIES = 500;
/** The prefix of a comment the assistant wrote (the reviewer shows who confirmed it as the author). */
export const ASSISTANT_COMMENT_PREFIX = '[Asistan] ';

const SHA40 = /^[0-9a-f]{40}$/;

export interface ChatCodeToolsDeps {
  readonly db: Queryable;
  readonly code: () => CodeService | null;
  /** IDE workspaces (absent / null: read_workspace_diff is unavailable). */
  readonly ide?: () => {
    workspacesFor(subject: Subject, project: string): Promise<IdeWorkspaceView[]>;
    workspaceDiff(
      subject: Subject,
      workspaceId: string,
      path: string | undefined,
    ): Promise<
      | { readonly ok: false; readonly reason: string; readonly message: string }
      | { readonly ok: true; readonly workspace: IdeWorkspaceView; readonly result: IdeGitResultPayload }
      | null
    >;
  } | null;
  readonly redactor?: Redactor;
}

/** A read result, optionally with the "Aç" card of open_code / open_diff. */
export type CodeToolResult =
  | { readonly ok: true; readonly data: unknown; readonly codeCard?: AssistantCodeCard }
  | Extract<ReadResult, { ok: false }>;

type Fail = Extract<ReadResult, { ok: false }>;

function fail(code: Fail['code'], message: string): Fail {
  return {
    ok: false,
    code,
    message: code === 'forbidden' ? `The signed-in user is not allowed to ${message}.` : message,
  };
}

function can(subject: Subject, action: string, project: string): 'allow' | 'role' | 'hidden' {
  const d = authorize(subject, action, { project });
  if (d.allow) return 'allow';
  return d.reason === 'not_visible' ? 'hidden' : 'role';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;

/** A code service error as the tool's refusal (the console route's public message). */
function asFail(err: unknown): Fail {
  if (err instanceof HttpError) {
    const code: Fail['code'] =
      err.statusCode === 404
        ? 'not_found'
        : err.statusCode === 403
          ? 'forbidden'
          : err.statusCode === 400
            ? 'invalid'
            : 'unavailable';
    return { ok: false, code, message: err.publicMessage };
  }
  throw err;
}

/** The console link of the viewer / reviewer a card opens (the web builds the same from the card). */
export function codeCardHref(c: AssistantCodeCard): string {
  const q = new URLSearchParams();
  const p = encodeURIComponent(c.project);
  if (c.kind === 'code') {
    q.set('ref', c.sha);
    q.set('path', c.path);
    if (c.startLine !== undefined) {
      const end = c.endLine ?? c.startLine;
      q.set('L', end === c.startLine ? String(c.startLine) : `${String(c.startLine)}-${String(end)}`);
    }
    return `/projects/${p}/code?${q.toString()}`;
  }
  if (c.path !== undefined) q.set('path', c.path);
  if (c.job !== undefined) {
    const qs = q.toString();
    return `/projects/${p}/code/jobs/${c.job}${qs === '' ? '' : `?${qs}`}`;
  }
  const params = new URLSearchParams({ base: c.base ?? '', head: c.head ?? '' });
  if (c.path !== undefined) params.set('path', c.path);
  return `/projects/${p}/code/compare?${params.toString()}`;
}

export class ChatCodeTools {
  readonly #redactor: Redactor;

  constructor(private readonly deps: ChatCodeToolsDeps) {
    this.#redactor = deps.redactor ?? new Redactor({ rules: DEFAULT_RULES });
  }

  // ------------------------------------------------------------------------------------------------ reads

  async read(subject: Subject, tool: string, i: Record<string, unknown>): Promise<CodeToolResult> {
    try {
      switch (tool) {
        case 'read_code':
          return await this.#readCode(subject, i);
        case 'list_code':
          return await this.#listCode(subject, i);
        case 'read_workspace_diff':
          return await this.#workspaceDiff(subject, i);
        case 'open_code':
          return await this.#openCode(subject, i);
        case 'open_diff':
          return await this.#openDiff(subject, i);
        default:
          return fail('invalid', `${tool} is not a code tool.`);
      }
    } catch (err) {
      return asFail(err);
    }
  }

  #svc(): CodeService | null {
    return this.deps.code();
  }

  /**
   * The project's repository at `ref` / `job` for a reader: the ref the code service resolves (a job: its verified
   * head commit). A workspace project or a job of another project is refused.
   */
  async #target(
    subject: Subject,
    i: Record<string, unknown>,
  ): Promise<Fail | { project: string; ref: string | undefined; label: string | null }> {
    const project = str(i.project) ?? '';
    const c = can(subject, 'code.read', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'read the code of this project');
    const { rows } = await this.deps.db.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [
      project,
    ]);
    if (rows[0] === undefined) return fail('not_found', 'Project not found.');
    if (rows[0].kind === 'workspace')
      return fail(
        'invalid',
        'This is a workspace project (no repository): read its kept working files with list_workfiles instead.',
      );
    const job = str(i.job);
    const ref = str(i.ref);
    if (job !== undefined && ref !== undefined) return fail('invalid', 'Give ref or job, not both.');
    if (job === undefined) return { project, ref, label: ref ?? null };
    const record = await loadJobGit(this.deps.db, job);
    if (record === null || record.project !== project)
      return fail('not_found', 'Job not found in this project.');
    if (record.verification !== 'passed' || record.headSha === null || !SHA40.test(record.headSha))
      return fail(
        'invalid',
        'This job has no verified changes to read (no git flow, not verified yet, or nothing changed); use its branch as ref if it was pushed.',
      );
    return { project, ref: record.headSha, label: `job ${job.slice(0, 8)}` };
  }

  async #readCode(subject: Subject, i: Record<string, unknown>): Promise<CodeToolResult> {
    const svc = this.#svc();
    if (svc === null) return fail('unavailable', 'The code viewer is not available.');
    const t = await this.#target(subject, i);
    if ('ok' in t) return t;
    const path = str(i.path) ?? '';
    if (!isRepoPath(path)) return fail('invalid', 'Not a repository path.');
    const file = await svc.file(t.project, t.ref, path);
    const base = {
      project: t.project,
      path,
      commit: file.ref,
      ...(t.label === null ? {} : { ref: t.label }),
      size: file.size,
      language: file.language,
    };
    if (file.state !== 'text' || file.text === null)
      return {
        ok: true,
        data: {
          ...base,
          state: file.state,
          note:
            file.state === 'binary'
              ? 'A binary file: no text to show.'
              : 'Larger than 1 MiB: the viewer shows a summary only.',
        },
      };
    const lines = file.text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const total = lines.length;
    const start = int(i.startLine) ?? 1;
    const wantEnd = int(i.endLine) ?? start + CODE_READ_MAX_LINES - 1;
    if (wantEnd < start) return fail('invalid', 'endLine is before startLine.');
    if (start > total)
      return fail(
        'invalid',
        `The file has ${String(total)} lines; startLine ${String(start)} is past its end.`,
      );
    const last = Math.min(wantEnd, total, start + CODE_READ_MAX_LINES - 1);
    const width = String(last).length;
    const out: string[] = [];
    let bytes = 0;
    for (let n = start; n <= last; n++) {
      const line = `${String(n).padStart(width, ' ')}| ${lines[n - 1] ?? ''}`;
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + size > MAX_READ_BYTES) break;
      bytes += size;
      out.push(line);
    }
    const end = start + out.length - 1;
    return {
      ok: true,
      data: {
        ...base,
        state: 'text',
        totalLines: total,
        lines: `${String(start)}-${String(end)}`,
        ...(end < Math.min(wantEnd, total)
          ? {
              more: `cut at line ${String(end)} (≤ ${String(CODE_READ_MAX_LINES)} lines / 48 KiB per call): read on with startLine ${String(end + 1)}`,
            }
          : end < total && int(i.endLine) === undefined
            ? { more: `the file goes on to line ${String(total)}: read on with startLine ${String(end + 1)}` }
            : {}),
        ...(file.redacted ? { redacted: 'secret-looking values are masked (line numbers kept)' } : {}),
        text: out.join('\n'),
      },
    };
  }

  async #listCode(subject: Subject, i: Record<string, unknown>): Promise<CodeToolResult> {
    const svc = this.#svc();
    if (svc === null) return fail('unavailable', 'The code viewer is not available.');
    const t = await this.#target(subject, i);
    if ('ok' in t) return t;
    const path = typeof i.path === 'string' ? i.path : '';
    if (path !== '' && !isRepoPath(path)) return fail('invalid', 'Not a repository path.');
    const query = str(i.query)?.toLowerCase();
    const entry = (e: TreeEntry): Record<string, unknown> => ({
      path: e.path,
      kind: e.kind,
      ...(e.size === null || e.kind !== 'file' ? {} : { size: e.size }),
    });
    if (query === undefined) {
      const listing = await svc.tree(t.project, t.ref, path);
      return {
        ok: true,
        data: {
          project: t.project,
          commit: listing.sha,
          ...(t.label === null ? {} : { ref: t.label }),
          path,
          entries: listing.entries.slice(0, MAX_LIST_ENTRIES).map(entry),
          ...(listing.truncated || listing.entries.length > MAX_LIST_ENTRIES
            ? { truncated: 'more entries than listed: list a subdirectory' }
            : {}),
        },
      };
    }
    // Breadth-first over directory listings (names only), pinned to the first listing's commit.
    const first = await svc.tree(t.project, t.ref, path);
    const sha = first.sha;
    const queue: TreeEntry[][] = [first.entries];
    const matches: Record<string, unknown>[] = [];
    let dirs = 1;
    let stopped = false;
    while (queue.length > 0 && matches.length < MAX_SEARCH_MATCHES) {
      const entries = queue.shift() ?? [];
      for (const e of entries) {
        if (e.name.toLowerCase().includes(query)) {
          matches.push(entry(e));
          if (matches.length >= MAX_SEARCH_MATCHES) break;
        }
      }
      for (const e of entries) {
        if (e.kind !== 'dir' || matches.length >= MAX_SEARCH_MATCHES) continue;
        if (dirs >= MAX_SEARCH_DIRS) {
          stopped = true;
          break;
        }
        dirs += 1;
        const sub = await svc.tree(t.project, sha, e.path).catch(() => null);
        if (sub !== null) queue.push(sub.entries);
      }
      if (stopped) break;
    }
    return {
      ok: true,
      data: {
        project: t.project,
        commit: sha,
        ...(t.label === null ? {} : { ref: t.label }),
        path,
        query,
        matches,
        directoriesSearched: dirs,
        ...(stopped || queue.length > 0 || matches.length >= MAX_SEARCH_MATCHES
          ? {
              incomplete: `the search stopped early (≤ ${String(MAX_SEARCH_DIRS)} directories / ${String(MAX_SEARCH_MATCHES)} matches): search below a narrower path`,
            }
          : {}),
      },
    };
  }

  async #workspaceDiff(subject: Subject, i: Record<string, unknown>): Promise<CodeToolResult> {
    const ide = this.deps.ide?.() ?? null;
    if (ide === null) return fail('unavailable', 'Tam IDE is not available on this server.');
    const workspace = str(i.workspace);
    if (workspace === undefined) {
      const project = str(i.project);
      if (project === undefined) return fail('invalid', 'Give workspace (an id) or project (to list them).');
      const c = can(subject, 'code.read', project);
      if (c === 'hidden') return fail('not_found', 'Project not found.');
      if (c === 'role') return fail('forbidden', 'read the code of this project');
      const list = await ide.workspacesFor(subject, project);
      return {
        ok: true,
        data: {
          project,
          workspaces: list.map((w) => ({
            id: w.id,
            name: w.name,
            owner: w.username,
            state: w.state,
            source: w.source,
            branch: w.branch,
            machine: w.workerName,
            machineOnline: w.workerConnected,
            head: w.head,
          })),
          ...(list.length === 0
            ? { note: 'No IDE workspace of this user in this project (Projeler → proje → Kod → Tam IDE).' }
            : {}),
        },
      };
    }
    const path = str(i.path);
    if (path !== undefined && !isRepoPath(path)) return fail('invalid', 'Not a repository path.');
    const out = await ide.workspaceDiff(subject, workspace, path);
    if (out === null) return fail('not_found', 'IDE workspace not found.');
    if (!out.ok) return fail('unavailable', out.message);
    const r = out.result;
    const diff = redactKeepingLines(this.#redactor, r.diff ?? '');
    return {
      ok: true,
      data: {
        workspace: {
          id: out.workspace.id,
          name: out.workspace.name,
          project: out.workspace.project,
          branch: r.branch ?? out.workspace.branch,
          machine: out.workspace.workerName,
        },
        head: r.head ?? null,
        ...(path === undefined ? {} : { path }),
        files: r.files ?? [],
        untracked: r.untracked ?? [],
        ...(r.truncated === true ? { truncated: 'the file list or the diff was cut (≤ 96 KiB)' } : {}),
        ...(diff !== (r.diff ?? '') ? { redacted: 'secret-looking values are masked' } : {}),
        note: 'Uncommitted changes in the IDE (not pushed). Untracked files are not in the diff.',
        diff,
      },
    };
  }

  async #openCode(subject: Subject, i: Record<string, unknown>): Promise<CodeToolResult> {
    const svc = this.#svc();
    if (svc === null) return fail('unavailable', 'The code viewer is not available.');
    const t = await this.#target(subject, i);
    if ('ok' in t) return t;
    const path = str(i.path) ?? '';
    if (!isRepoPath(path)) return fail('invalid', 'Not a repository path.');
    const start = int(i.startLine);
    const end = int(i.endLine);
    if (end !== undefined && start === undefined) return fail('invalid', 'endLine needs startLine.');
    if (start !== undefined && end !== undefined && end < start)
      return fail('invalid', 'endLine is before startLine.');
    const file = await svc.file(t.project, t.ref, path);
    if (start !== undefined && file.state === 'text' && file.text !== null) {
      const total = file.text.split('\n').length;
      if (start > total)
        return fail(
          'invalid',
          `The file has ${String(total)} lines; startLine ${String(start)} is past its end.`,
        );
    }
    const note = str(i.note);
    const card: AssistantCodeCard = {
      kind: 'code',
      project: t.project,
      path,
      sha: file.ref,
      refLabel: (t.label ?? file.ref.slice(0, 7)).slice(0, 255),
      ...(start === undefined ? {} : { startLine: start }),
      ...(start === undefined || end === undefined ? {} : { endLine: end }),
      ...(note === undefined ? {} : { note: note.slice(0, 200) }),
    };
    return {
      ok: true,
      codeCard: card,
      data: {
        card: 'shown',
        project: t.project,
        path,
        commit: file.ref,
        link: codeCardHref(card),
        note: 'An "Aç" card is in the conversation now; it opens nothing by itself — the user clicks it.',
      },
    };
  }

  async #openDiff(subject: Subject, i: Record<string, unknown>): Promise<CodeToolResult> {
    const svc = this.#svc();
    if (svc === null) return fail('unavailable', 'The code viewer is not available.');
    const path = str(i.path);
    if (path !== undefined && !isRepoPath(path)) return fail('invalid', 'Not a repository path.');
    const note = str(i.note)?.slice(0, 200);
    const job = str(i.job);
    const shown = (card: AssistantCodeCard, extra: Record<string, unknown>): CodeToolResult => ({
      ok: true,
      codeCard: card,
      data: {
        card: 'shown',
        ...extra,
        link: codeCardHref(card),
        note: 'An "Aç" card is in the conversation now; it opens nothing by itself — the user clicks it.',
      },
    });
    const changed = (files: readonly { path: string }[], truncated: boolean): Fail | null =>
      path === undefined || truncated || files.some((f) => f.path === path)
        ? null
        : fail(
            'invalid',
            `${path} did not change here. Changed files: ${files
              .slice(0, 20)
              .map((f) => f.path)
              .join(', ')}.`,
          );
    if (job !== undefined) {
      if (str(i.base) !== undefined || str(i.head) !== undefined || i.pr !== undefined)
        return fail('invalid', 'Give job, or project with base + head / pr — not both.');
      const record = await loadJobGit(this.deps.db, job);
      if (record === null) return fail('not_found', 'Job not found (or it has no git changes).');
      const c = can(subject, 'code.read', record.project);
      if (c === 'hidden') return fail('not_found', 'Job not found (or it has no git changes).');
      if (c === 'role') return fail('forbidden', 'read the code of this project');
      const review = await svc.jobReview(job);
      const bad = changed(review.files, review.truncated);
      if (bad !== null) return bad;
      const title = (await jobTitle(this.deps.db, job)) ?? undefined;
      return shown(
        {
          kind: 'diff',
          project: review.project,
          job,
          ...(title === undefined ? {} : { title: title.slice(0, 200) }),
          ...(path === undefined ? {} : { path }),
          files: review.files.length,
          ...(note === undefined ? {} : { note }),
        },
        { job, project: review.project, files: review.files.length, headSha: review.headSha },
      );
    }
    const project = str(i.project);
    if (project === undefined) return fail('invalid', 'Give job, or project with base + head or pr.');
    const c = can(subject, 'code.read', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'read the code of this project');
    const pr = int(i.pr);
    let base = str(i.base);
    let head = str(i.head);
    let title: string | undefined;
    if (pr !== undefined) {
      if (base !== undefined || head !== undefined)
        return fail('invalid', 'Give pr, or base + head — not both.');
      const pulls = await svc.pullRequests(project);
      if (!pulls.supported) return fail('unavailable', 'This git provider cannot list pull requests here.');
      const found = pulls.items.find((p) => p.number === pr);
      if (found === undefined)
        return fail(
          'not_found',
          `No open pull request #${String(pr)}. Open ones: ${
            pulls.items
              .slice(0, 10)
              .map((p) => `#${String(p.number)}`)
              .join(', ') || 'none'
          }.`,
        );
      if (found.compare === null)
        return fail(
          'unavailable',
          `Pull request #${String(pr)}'s head cannot be read from this repository (a fork).`,
        );
      base = found.compare.base;
      head = found.compare.head;
      title = found.title;
    }
    if (base === undefined || head === undefined)
      return fail('invalid', 'A compare needs base and head (branches or commit shas), or pr.');
    const cmp = await svc.compare(project, base, head);
    const bad = changed(cmp.files, cmp.truncated);
    if (bad !== null) return bad;
    return shown(
      {
        kind: 'diff',
        project,
        base,
        head,
        ...(pr === undefined ? {} : { pr }),
        ...(title === undefined ? {} : { title: title.slice(0, 200) }),
        ...(path === undefined ? {} : { path }),
        files: cmp.files.length,
        ...(note === undefined ? {} : { note }),
      },
      { project, base, head, files: cmp.files.length },
    );
  }

  // ---------------------------------------------------------------------------------- draft_review_changes (card)

  async plan(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const svc = this.#svc();
    if (svc === null) return fail('unavailable', 'The code reviewer is not available.');
    const job = str(i.job) ?? '';
    const record = await loadJobGit(this.deps.db, job);
    if (record === null) return fail('not_found', 'Job not found (or it has no git changes).');
    const project = record.project;
    const c = can(subject, 'code.review', project);
    if (c === 'hidden') return fail('not_found', 'Job not found (or it has no git changes).');
    if (c === 'role') return fail('forbidden', 'ask for changes on this job (operators of the project)');
    let review;
    try {
      review = await svc.jobReview(job);
    } catch (err) {
      return asFail(err);
    }
    const raw = Array.isArray(i.comments) ? (i.comments as Record<string, unknown>[]) : [];
    const comments: {
      path: string;
      side: 'old' | 'new';
      startLine: number;
      endLine: number;
      body: string;
    }[] = [];
    for (const x of raw.slice(0, CODE_REVIEW_MAX_COMMENTS)) {
      const path = str(x.path) ?? '';
      if (!isRepoPath(path)) return fail('invalid', `${path}: not a repository path.`);
      if (!review.truncated && !review.files.some((f) => f.path === path))
        return fail(
          'invalid',
          `${path} did not change in this job. Changed files: ${review.files
            .slice(0, 20)
            .map((f) => f.path)
            .join(', ')}.`,
        );
      const startLine = int(x.startLine) ?? 1;
      const endLine = int(x.endLine) ?? startLine;
      if (endLine < startLine) return fail('invalid', `${path}: endLine is before startLine.`);
      const body = (str(x.body) ?? '').trim();
      if (body === '') return fail('invalid', `${path}: a comment needs text.`);
      comments.push({
        path,
        side: x.side === 'old' ? 'old' : 'new',
        startLine,
        endLine,
        body: body.slice(0, 2000),
      });
    }
    const note = (str(i.note) ?? '').trim().slice(0, 4000);
    const existing = (await svc.comments(job, subject.userId)).filter(
      (x) => x.parentId === null && !x.resolved && x.sentAt === null,
    );
    if (comments.length === 0 && note === '' && existing.length === 0)
      return fail(
        'invalid',
        'Write a note or at least one line comment (the job has no open review threads).',
      );
    const { rows } = await this.deps.db.query<{ state: string }>(
      'SELECT state::text AS state FROM jobs WHERE id = $1',
      [job],
    );
    const state = rows[0]?.state ?? 'UNKNOWN';
    const title = (await jobTitle(this.deps.db, job)) ?? job.slice(0, 8);
    const ended = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(state);
    return adminCard(
      'code.request_changes',
      `Değişiklik iste: ${title}`.slice(0, 200),
      {
        project,
        jobId: job,
        jobTitle: title.slice(0, 200),
        headSha: review.headSha,
        ...(note === '' ? {} : { note }),
        comments,
        openThreads: existing.length,
      },
      {
        project,
        job,
        state,
        comments: comments.length,
        ...(existing.length === 0
          ? {}
          : { alsoSends: `${String(existing.length)} open review thread(s) of the job` }),
        goesTo: ended
          ? 'a follow-up job on the job’s head (same settings, same target branch)'
          : 'a message to the job’s agent (when it can take messages; else the card fails with job_busy)',
        link: `/projects/${encodeURIComponent(project)}/code/jobs/${job}`,
      },
      project,
    );
  }

  /** Runs a confirmed card (ChatAdmin.run re-checked `code.review` for the confirming user in the project). */
  async apply(p: Record<string, unknown>, ctx: OpsApplyContext): Promise<Record<string, unknown>> {
    const svc = this.#svc();
    if (svc === null)
      throw new HttpError(
        503,
        'unavailable',
        'The code reviewer is not available.',
        {},
        {},
        { reason: 'admin' },
      );
    const job = String(p.jobId);
    const project = String(p.project);
    const review = await svc.jobReview(job);
    if (review.project !== project) throw new HttpError(404, 'job_not_found', 'Job not found.');
    // The comments are anchored to the lines the assistant read: a job whose changes moved since is not reviewed blind.
    if (typeof p.headSha === 'string' && p.headSha !== review.headSha)
      throw new HttpError(
        409,
        'review_outdated',
        'The job’s changes moved since this card was drafted; ask the assistant to review them again.',
      );
    const actor = {
      subject: ctx.subject,
      userId: ctx.actor.userId,
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
    };
    const list = Array.isArray(p.comments) ? (p.comments as Record<string, unknown>[]) : [];
    let added = 0;
    for (const x of list.slice(0, CODE_REVIEW_MAX_COMMENTS)) {
      const startLine = int(x.startLine) ?? 1;
      await svc.addComment(actor, job, {
        path: String(x.path),
        side: x.side === 'old' ? 'old' : 'new',
        startLine,
        endLine: int(x.endLine) ?? startLine,
        body: `${ASSISTANT_COMMENT_PREFIX}${String(x.body)}`,
      });
      added += 1;
    }
    const out = await svc.requestChanges(actor, job, typeof p.note === 'string' ? { note: p.note } : {});
    return {
      project,
      mode: out.mode,
      // The job the review went to (message) or the follow-up job (the card's result link).
      jobId: out.jobId ?? job,
      reviewedJob: job,
      ...(out.messageId === null ? {} : { messageId: out.messageId }),
      commentsAdded: added,
      threadsSent: out.comments,
      link: `/projects/${encodeURIComponent(project)}/code/jobs/${job}`,
    };
  }
}
