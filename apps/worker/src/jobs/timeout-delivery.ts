import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger, Redactor, SecretSet } from '@remyral/observability';
import {
  commitSubject,
  DEFAULT_GIT_IDENTITY,
  KEPT_REF,
  TIMEOUT_DELIVERY_GRACE_SEC,
  type TimeoutPartial,
} from '@remyral/protocol';
import type { GitAuthSource } from '../workspace/git-auth.js';
import type { GitRunner } from '../workspace/git.js';
import type { Workspace } from '../workspace/manager.js';
import { SecretScanError } from '../workspace/errors.js';
import type { PublishPort } from '../workspace/publish.js';

/**
 * p22-timeout-continuity (docs/design/p22-timeout-continuity.md; production 2026-11-01: the agent had
 * finished — lint, types, 435 tests, build, browser check — when its time limit stopped it; nothing was committed or
 * pushed and the 26 checkpoints of the run stayed in that machine's cached clone): a git-flow repository attempt that
 * stops on its time limit keeps its work.
 *
 * Within {@link TIMEOUT_DELIVERY_GRACE_SEC} after the runtime stopped, the worktree is committed as one
 * work-in-progress commit on the attempt branch (`rac/<job>/<attempt>`) — the publish commit's own path: the worker-side
 * `commit` (attempt trailer, the job's git identity, hooks never run) after the caller's trusted-git check, then the
 * normal `push` (exactly the attempt branch, force-with-lease on an absent ref, pre-push secret scan with the job's
 * exact secret values). It is never pushed anywhere else and nothing merges it (AGENTS.md rule 10): it waits on its
 * branch for a continuation ("Aynı yerden devam et") that starts from it.
 *
 * When the commit is not possible (changes above the size caps, git failure) the last continuity checkpoint stands in;
 * when the push fails (secret scan, remote refusal, network, grace exceeded) the commit is kept in this worker's mirror
 * under `refs/remana/kept/<attempt>` (the attempt's checkpoint refs and its local branch are removed when the attempt
 * ends) and the result says so: the master then pins the continuation to this machine.
 */

/** Size caps of the work-in-progress commit (the continuity checkpoint's defaults). */
export const TIMEOUT_COMMIT_CAPS = { maxFiles: 50_000, maxBytes: 512 * 1024 * 1024 } as const;

/** Kept refs older than this are removed when a new one is written in the same mirror (days). */
export const KEPT_REF_MAX_AGE_DAYS = 14;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A run stopped by its time limit: the worker's run clock, or the master's wall-time backstop. */
export function isTimeLimitStop(job: {
  readonly failure: { readonly code: string } | null;
  readonly cancelReason: string | null;
}): boolean {
  if (job.failure?.code === 'max_duration_exceeded') return true;
  return job.cancelReason !== null && job.cancelReason.startsWith('budget_exceeded: wall time');
}

/** The hidden ref an unpushed timeout commit of `attemptId` is kept under. */
export function keptRef(attemptId: string): string {
  const ref = `refs/remana/kept/${attemptId}`;
  if (!KEPT_REF.test(ref)) throw new Error('invalid attempt id');
  return ref;
}

export interface TimeoutDeliveryInput {
  /** The attempt's worktree, with the epoch the attempt holds now (the trailer names it). */
  readonly ws: Workspace;
  readonly jobTitle?: string | undefined;
  readonly jobPrompt: string;
  readonly author?: { readonly name: string; readonly email: string } | undefined;
  readonly gitAuth?: GitAuthSource | undefined;
  readonly secrets?: SecretSet | undefined;
  readonly redactor?: Redactor | undefined;
  /** The last continuity checkpoint commit (null: none) — kept when the commit itself is not possible. */
  readonly checkpoint: string | null;
  readonly caps?: { readonly maxFiles: number; readonly maxBytes: number } | undefined;
  /** The delivery grace (ms); default {@link TIMEOUT_DELIVERY_GRACE_SEC}. */
  readonly graceMs?: number | undefined;
  /** The reason the run stopped, for the commit message. */
  readonly why: 'run_clock' | 'backstop';
}

class GraceExceeded extends Error {
  constructor() {
    super('the delivery grace ran out');
    this.name = 'GraceExceeded';
  }
}

function within<T>(p: Promise<T>, deadline: number): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new GraceExceeded());
  let timer: NodeJS.Timeout | null = null;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new GraceExceeded());
    }, left);
    timer.unref();
  });
  return Promise.race([p, t]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** Changed (modified, deleted, untracked — not ignored) files of the worktree with their size. */
async function worktreeChanges(git: GitRunner, ws: Workspace): Promise<{ files: number; bytes: number }> {
  const r = await git.run({
    cwd: ws.path,
    ceiling: dirname(ws.path),
    args: ['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard'],
  });
  const seen = new Set<string>();
  let bytes = 0;
  for (const rel of r.stdout.split('\0')) {
    if (rel === '' || seen.has(rel)) continue;
    seen.add(rel);
    const st = await lstat(join(ws.path, rel)).catch(() => null);
    if (st?.isFile() === true) bytes += st.size;
  }
  return { files: seen.size, bytes };
}

async function head(git: GitRunner, ws: Workspace): Promise<string | null> {
  const r = await git
    .run({ cwd: ws.path, ceiling: dirname(ws.path), args: ['rev-parse', '--verify', 'HEAD^{commit}'] })
    .catch(() => null);
  const sha = r?.stdout.trim() ?? '';
  return SHA.test(sha) ? sha : null;
}

async function filesSinceBase(git: GitRunner, ws: Workspace, commit: string): Promise<number> {
  const r = await git
    .run({
      cwd: ws.path,
      ceiling: dirname(ws.path),
      args: ['diff', '--name-only', '-z', '--no-renames', ws.baseCommit, commit, '--'],
    })
    .catch(() => null);
  if (r === null) return 0;
  return r.stdout.split('\0').filter((x) => x !== '').length;
}

/** Keeps `commit` under the attempt's kept ref (and drops kept refs older than {@link KEPT_REF_MAX_AGE_DAYS}). */
async function keep(git: GitRunner, ws: Workspace, commit: string, log: Logger): Promise<string | null> {
  const ref = keptRef(ws.attemptId);
  const base = { cwd: ws.path, ceiling: dirname(ws.path) };
  try {
    await git.run({ ...base, args: ['update-ref', ref, commit] });
  } catch (err) {
    log.warn('could not keep the unfinished work under a hidden ref', {
      jobId: ws.jobId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  try {
    const r = await git.run({
      ...base,
      args: ['for-each-ref', '--format=%(refname) %(committerdate:unix)', '--', 'refs/remana/kept/'],
    });
    const cutoff = Date.now() / 1000 - KEPT_REF_MAX_AGE_DAYS * 86_400;
    for (const line of r.stdout.split('\n')) {
      const [name, at] = line.trim().split(' ');
      if (name === undefined || at === undefined || name === ref || !KEPT_REF.test(name)) continue;
      if (Number(at) < cutoff)
        await git.run({ ...base, args: ['update-ref', '-d', name] }).catch(() => undefined);
    }
  } catch {
    // pruning is best effort
  }
  return ref;
}

/**
 * Commits and pushes the unfinished work of a timed-out attempt (see the module comment). Returns what was kept, or
 * null when there is nothing (no change since the base, nothing to fall back on). Never throws.
 */
export async function deliverOnTimeout(
  deps: { readonly port: PublishPort; readonly git: GitRunner; readonly log: Logger },
  input: TimeoutDeliveryInput,
): Promise<TimeoutPartial | null> {
  const { ws } = input;
  const deadline = Date.now() + (input.graceMs ?? TIMEOUT_DELIVERY_GRACE_SEC * 1000);
  const caps = input.caps ?? TIMEOUT_COMMIT_CAPS;
  const fallback = async (reason: NonNullable<TimeoutPartial['reason']>): Promise<TimeoutPartial | null> => {
    if (input.checkpoint === null || !SHA.test(input.checkpoint)) return null;
    const ref = await keep(deps.git, ws, input.checkpoint, deps.log);
    if (ref === null) return null;
    return {
      branch: ws.branch,
      commit: input.checkpoint,
      files: await filesSinceBase(deps.git, ws, input.checkpoint),
      pushed: false,
      ref,
      reason,
    };
  };
  let commit: string;
  try {
    const changed = await within(worktreeChanges(deps.git, ws), deadline);
    const tip = await within(head(deps.git, ws), deadline);
    if (changed.files === 0 && (tip === null || tip === ws.baseCommit)) return null;
    if (changed.files > caps.maxFiles || changed.bytes > caps.maxBytes) {
      deps.log.warn('time limit: the unfinished work exceeds the size caps; keeping the last checkpoint', {
        jobId: ws.jobId,
        files: changed.files,
        bytes: changed.bytes,
      });
      return await fallback('too_large');
    }
    const subject = commitSubject(
      input.jobTitle === undefined ? undefined : `WIP: ${input.jobTitle}`,
      `WIP: ${(input.jobPrompt.split('\n', 1)[0] ?? '').trim()}`,
    );
    const message = `${subject}\n\nThe time limit of this job ran out (${input.why === 'run_clock' ? 'run clock' : 'master backstop'}) before it finished. This is its unfinished work, kept for a continuation; it is not merged.\n\nRemyral job ${ws.jobId}, attempt ${ws.attemptId}.`;
    commit = await within(
      deps.port.commit(ws, { message, author: { ...(input.author ?? DEFAULT_GIT_IDENTITY) } }),
      deadline,
    );
  } catch (err) {
    deps.log.warn('time limit: could not commit the unfinished work; keeping the last checkpoint', {
      jobId: ws.jobId,
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback(err instanceof GraceExceeded ? 'grace_exceeded' : 'commit_failed');
  }
  const files = await filesSinceBase(deps.git, ws, commit);
  try {
    const pushed = await within(
      deps.port.push(ws, {
        expectedRemoteSha: null,
        ...(input.gitAuth === undefined ? {} : { gitAuth: input.gitAuth }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
        ...(input.redactor === undefined ? {} : { redactor: input.redactor }),
      }),
      deadline,
    );
    deps.log.info('time limit: unfinished work pushed to the attempt branch', {
      jobId: ws.jobId,
      branch: pushed.branch,
      sha: pushed.sha,
      files,
    });
    return { branch: pushed.branch, commit: pushed.sha, files, pushed: true };
  } catch (err) {
    const reason: NonNullable<TimeoutPartial['reason']> =
      err instanceof SecretScanError
        ? 'secret_scan'
        : err instanceof GraceExceeded
          ? 'grace_exceeded'
          : 'push_failed';
    deps.log.warn('time limit: the unfinished work was committed but not pushed; kept on this machine', {
      jobId: ws.jobId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
    const ref = await keep(deps.git, ws, commit, deps.log);
    return ref === null ? null : { branch: ws.branch, commit, files, pushed: false, ref, reason };
  }
}
