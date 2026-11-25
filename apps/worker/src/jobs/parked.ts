import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RuntimeKind } from '@remyral/protocol';
import { z } from 'zod';
import type { TrustedGitSnapshot } from '../sandbox/attempt-git.js';
import { assertSafeSegment } from '../workspace/ids.js';
import { assertRealDir, assertRealInside, ensureDirInside, isInside } from '../workspace/paths.js';

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md §6): the record a paused attempt leaves on the worker — what
 * a resume (ASSIGN_JOB `execution.resume`) needs to continue the same attempt from the workspace it kept.
 *
 * One JSON file per job under `<workspace root>/.remyral/parked/<jobId>.json` (0600, written atomically). Every path is
 * stored *relative to the workspace root* and re-validated on use (a real directory inside the root, no symlinks), so
 * a tampered record can never point a resumed run at another directory.
 */

const SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/;
export const RelPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !isAbsolute(p) && !p.includes('\0') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
    {
      message: 'relative path inside the workspace root',
    },
  );

export const ParkedSessionSchema = z.object({
  runtime: RuntimeKind,
  runtimeSessionId: z.string().min(1).max(256),
  state: z.record(z.string().max(64), z.string().max(512)).optional(),
});

/** p11-session-continuity: the restart facts kept with a recovered attempt (all text redacted and bounded). */
export const RestartFacts = z.object({
  /** Last checkpoint (0: none). */
  checkpoint: z.number().int().min(0).max(999_999),
  checkpointAt: z.iso.datetime({ offset: true }).nullable(),
  /** Restarts this attempt already resumed from (this one not counted). */
  restarts: z.number().int().min(0).max(100),
  /** The policy's limit (a record at or past it is not resumed again). */
  maxRestarts: z.number().int().min(0).max(100),
  /** `git diff --stat`-like summary of what changed after the last checkpoint (or "no changes"). */
  sinceCheckpoint: z.string().max(4000),
  /** Summary of the attempt's changes against its base. */
  sinceBase: z.string().max(4000),
  /** The most recent tool calls (oldest first), with their safety class and state at the crash. */
  tools: z
    .array(
      z.object({
        callId: z.string().max(128).optional(),
        toolName: z.string().min(1).max(128),
        summary: z.string().max(400),
        class: z.enum(['idempotent', 'workspace_write', 'external', 'unknown']),
        state: z.enum(['running', 'done', 'failed']),
      }),
    )
    .max(30),
  /** Latest TODO list the agent wrote (TodoWrite / todowrite), bounded. */
  todos: z.string().max(2000).optional(),
  /** The runtime session could be continued natively (verified for this runtime version). */
  nativeResume: z.boolean(),
  runtimeSessionId: z.string().max(128).optional(),
});
export type RestartFacts = z.infer<typeof RestartFacts>;

export const ParkedRecord = z.object({
  v: z.literal(1),
  jobId: z.string().regex(SEGMENT),
  attemptId: z.string().regex(SEGMENT),
  pausedEpoch: z.number().int().min(1),
  projectId: z.string().regex(SEGMENT),
  runtime: RuntimeKind,
  kind: z.enum(['repo', 'scratch']),
  paths: z.object({
    /** `jobs/<jobId>/<attemptId>` — the worktree or scratch directory. */
    workspace: RelPath,
    /** `sandboxes/<jobId>/<attemptId>` — git view / runtime state / tmp of the attempt. */
    sandbox: RelPath,
    /** The adapter's state dir (transcripts, config dir), inside `sandbox`. */
    state: RelPath,
    /** The attempt ran with a per-attempt git view (sandboxed run). */
    gitView: z.boolean(),
  }),
  repo: z
    .object({
      repositoryUrl: z.string().min(1).max(2048),
      baseRef: z.string().min(1).max(255),
      baseCommit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
      branch: z.string().min(1).max(300),
      pullRequest: z.object({ number: z.number().int().min(1), headSha: z.string() }).optional(),
    })
    .nullable(),
  /** The trusted-git snapshot of the attempt start (repo jobs), paths relative to the root. */
  trusted: z.object({ worktree: RelPath, entries: z.record(RelPath, z.string().max(128)) }).nullable(),
  session: ParkedSessionSchema.nullable(),
  mode: z.enum(['session', 'continuation']),
  /** Bounded, redacted transcript summary (continuation mode). */
  summary: z.string().max(16 * 1024),
  activeMs: z.number().int().min(0),
  /** The approval the pause waits for; null when the run was parked by a usage limit (p11-usage-limit-fallback). */
  approvalId: z.string().min(1).max(128).nullable(),
  /** Why it was parked (absent in records of older workers = `approval`). */
  cause: z.enum(['approval', 'usage_limit', 'worker_restart', 'account_switch']).optional(),
  /** p13-runtime-accounts: the runtime account the parked run used (absent = `default`). */
  account: z
    .string()
    .regex(/^[a-z0-9]{1,12}$/)
    .optional(),
  /**
   * p11-session-continuity: what the continuation after a worker restart is told (checkpoint, tool calls in flight,
   * changes since the checkpoint / the base). Present only with `cause: "worker_restart"`.
   */
  restart: RestartFacts.optional(),
  reason: z.string().max(2000),
  retainUntil: z.iso.datetime({ offset: true }),
  parkedAt: z.iso.datetime({ offset: true }),
});
export type ParkedRecord = z.infer<typeof ParkedRecord>;

/** Path of `abs` relative to `root` (forward slashes); throws when it is not strictly inside. */
export function relativeToRoot(root: string, abs: string): string {
  const rel = relative(resolve(root), resolve(abs));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path is not inside the workspace root: ${abs}`);
  }
  return rel.split(sep).join('/');
}

/** Absolute path of a stored relative path (lexically inside `root`; the caller checks the real path). */
export function fromRoot(root: string, rel: string): string {
  if (!RelPath.safeParse(rel).success) throw new Error('invalid stored path');
  const abs = resolve(root, ...rel.split('/'));
  if (!abs.startsWith(resolve(root) + sep)) throw new Error('stored path escapes the workspace root');
  return abs;
}

export function snapshotToRecord(root: string, s: TrustedGitSnapshot): NonNullable<ParkedRecord['trusted']> {
  const entries: Record<string, string> = {};
  for (const [path, digest] of Object.entries(s.entries)) entries[relativeToRoot(root, path)] = digest;
  return { worktree: relativeToRoot(root, s.worktree), entries };
}

export function snapshotFromRecord(
  root: string,
  t: NonNullable<ParkedRecord['trusted']>,
): TrustedGitSnapshot {
  const entries: Record<string, string> = {};
  for (const [rel, digest] of Object.entries(t.entries)) entries[fromRoot(root, rel)] = digest;
  return { worktree: fromRoot(root, t.worktree), entries };
}

/** Store of parked records (one per job). */
export class ParkedStore {
  readonly dir: string;

  constructor(private readonly root: string) {
    this.dir = join(root, '.remyral', 'parked');
  }

  async save(rec: ParkedRecord): Promise<void> {
    const valid = ParkedRecord.parse(rec);
    assertSafeSegment('jobId', valid.jobId);
    await ensureDirInside(this.root, ['.remyral', 'parked']);
    const file = this.#file(valid.jobId);
    const tmp = join(this.dir, `.${valid.jobId}.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(valid)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** The job's record, or null (missing or unreadable — an unreadable record is treated as missing). */
  async load(jobId: string): Promise<ParkedRecord | null> {
    if (!SEGMENT.test(jobId)) return null;
    try {
      const st = await lstat(this.#file(jobId));
      if (!st.isFile()) return null;
      const parsed = ParkedRecord.safeParse(JSON.parse(await readFile(this.#file(jobId), 'utf8')));
      return parsed.success && parsed.data.jobId === jobId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    if (!SEGMENT.test(jobId)) return;
    await rm(this.#file(jobId), { force: true });
  }

  /** Every readable record, plus the job ids of unreadable files (callers remove them). */
  async list(): Promise<{ records: ParkedRecord[]; broken: string[] }> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const records: ParkedRecord[] = [];
    const broken: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const jobId = name.slice(0, -'.json'.length);
      const rec = await this.load(jobId);
      if (rec === null) broken.push(jobId);
      else records.push(rec);
    }
    return { records, broken };
  }

  /**
   * Why the record cannot be resumed here now, or null: every stored directory must still be a real directory inside
   * the root (no symlink planted while it waited), and the record must not be past its retention.
   */
  async problem(rec: ParkedRecord, now: Date): Promise<string | null> {
    if (Date.parse(rec.retainUntil) <= now.getTime()) return 'the kept workspace passed its retention';
    for (const rel of [rec.paths.workspace, rec.paths.sandbox, rec.paths.state]) {
      try {
        const abs = fromRoot(this.root, rel);
        await assertRealDir(abs);
        const real = await assertRealInside(this.root, abs);
        if (real !== abs) return `${rel} resolves elsewhere`;
      } catch {
        return `${rel} is missing`;
      }
    }
    if (!isInside(join(this.root, 'sandboxes'), fromRoot(this.root, rec.paths.state))) {
      return 'the runtime state is not inside the sandbox directory';
    }
    return null;
  }

  #file(jobId: string): string {
    return join(this.dir, `${jobId}.json`);
  }
}
