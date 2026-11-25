import { createHash } from 'node:crypto';
import { copyFile, constants as fsConstants, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { ParkedSession } from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  type AgentEvent,
  type CheckpointReportPayload,
  classifyToolCall,
  ContinuityPolicy,
  RuntimeKind,
  type ToolCallNote,
} from '@remyral/protocol';
import { z } from 'zod';
import { atomicWriteFile } from '../fs/atomic.js';
import { createNodeFileOps, type FileOps } from '../fs/ops.js';
import type { GitRunner } from '../workspace/git.js';
import { assertSafeSegment } from '../workspace/ids.js';
import { ensureDirInside } from '../workspace/paths.js';
import { ParkedSessionSchema, RelPath } from './parked.js';

/**
 * p11-session-continuity (docs/design/p11-session-continuity.md, ADR-0042): checkpoints of a running attempt and the
 * durable record a restarted worker resumes from.
 *
 * - **Record** `<root>/.remyral/continuity/<jobId>.json` (0600, atomic + fsynced): which attempt / epoch runs, where its
 *   workspace, sandbox dir and runtime state are (relative to the root, re-validated on use), the trusted-git snapshot,
 *   the runtime session pointer, the recent tool calls with their safety class, the runtime processes it started, the
 *   checkpoints taken and how many restarts it already resumed from. Written before the runtime starts and updated
 *   with every spawn and checkpoint; removed when the attempt ends (or is parked).
 * - **Git checkpoint** (repository jobs): the worktree is staged into a worker-owned index
 *   (`<root>/.remyral/continuity/<job>.<attempt>.index`, never the worktree's index), written as a tree and committed
 *   with the previous checkpoint (or the base) as parent onto the hidden ref
 *   `refs/remana/checkpoints/<attemptId>/<n>` — never the work branch, never pushed (the publish step pushes exactly
 *   the attempt branch). Skipped when the tree did not change or the changed files exceed the size caps.
 * - **Snapshot** (workspace jobs): a manifest (path, size, mtime, sha256) and a reflink/copy of the scratch directory
 *   within the caps under `<root>/.remyral/continuity/snap/<job>/<attempt>/<n>/` (only the newest copy is kept).
 */

const SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_TOOLS = 30;
const MAX_SUMMARY = 16 * 1024;

const ToolRec = z.object({
  callId: z.string().max(128).optional(),
  toolName: z.string().min(1).max(128),
  summary: z.string().max(400),
  class: z.enum(['idempotent', 'workspace_write', 'external', 'unknown']),
  state: z.enum(['running', 'done', 'failed']),
});
export type ToolRec = z.infer<typeof ToolRec>;

const CheckpointRec = z.object({
  n: z.number().int().min(1).max(999_999),
  at: z.iso.datetime({ offset: true }),
  kind: z.enum(['git', 'snapshot']),
  ref: z.string().max(200).optional(),
  commit: z.string().regex(SHA).optional(),
  tree: z.string().regex(SHA).optional(),
  digest: z.string().max(80).optional(),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
});
export type CheckpointRec = z.infer<typeof CheckpointRec>;

export const ContinuityRecord = z.object({
  v: z.literal(1),
  jobId: z.string().regex(SEGMENT),
  attemptId: z.string().regex(SEGMENT),
  epoch: z.number().int().min(1),
  projectId: z.string().regex(SEGMENT),
  runtime: RuntimeKind,
  profile: z.string().min(1).max(32),
  kind: z.enum(['repo', 'scratch']),
  paths: z.object({ workspace: RelPath, sandbox: RelPath, state: RelPath, gitView: z.boolean() }),
  repo: z
    .object({
      repositoryUrl: z.string().min(1).max(2048),
      baseRef: z.string().min(1).max(255),
      baseCommit: z.string().regex(SHA),
      branch: z.string().min(1).max(300),
      pullRequest: z.object({ number: z.number().int().min(1), headSha: z.string() }).optional(),
    })
    .nullable(),
  trusted: z.object({ worktree: RelPath, entries: z.record(RelPath, z.string().max(128)) }).nullable(),
  session: ParkedSessionSchema.nullable(),
  /** Native resume of this runtime version was verified live (resume-verification.ts). */
  nativeResume: z.boolean(),
  summary: z.string().max(MAX_SUMMARY),
  tools: z.array(ToolRec).max(MAX_TOOLS),
  todos: z.string().max(2000).optional(),
  activeMs: z.number().int().min(0),
  policy: ContinuityPolicy,
  checkpoints: z.array(CheckpointRec).max(60),
  processes: z.array(z.object({ pid: z.number().int().min(1), at: z.number().int().min(0) })).max(64),
  bootAt: z.number().int().min(0),
  /** Restarts this attempt already resumed from. */
  restarts: z.number().int().min(0).max(100),
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ContinuityRecord = z.infer<typeof ContinuityRecord>;

/** Store of continuity records (one per job). Every write is atomic and fsynced (a crash leaves old or new). */
export class ContinuityStore {
  readonly dir: string;
  readonly #ops: FileOps;

  constructor(
    private readonly root: string,
    ops: FileOps = createNodeFileOps(),
  ) {
    this.dir = join(root, '.remyral', 'continuity');
    this.#ops = ops;
  }

  async save(rec: ContinuityRecord): Promise<void> {
    const valid = ContinuityRecord.parse(rec);
    assertSafeSegment('jobId', valid.jobId);
    await ensureDirInside(this.root, ['.remyral', 'continuity']);
    await atomicWriteFile(this.#ops, this.#file(valid.jobId), `${JSON.stringify(valid)}\n`, { mode: 0o600 });
  }

  async load(jobId: string): Promise<ContinuityRecord | null> {
    if (!SEGMENT.test(jobId)) return null;
    try {
      const st = await lstat(this.#file(jobId));
      if (!st.isFile()) return null;
      const parsed = ContinuityRecord.safeParse(JSON.parse(await readFile(this.#file(jobId), 'utf8')));
      return parsed.success && parsed.data.jobId === jobId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async remove(jobId: string): Promise<void> {
    if (!SEGMENT.test(jobId)) return;
    await rm(this.#file(jobId), { force: true });
    await this.#ops.fsyncDir(this.dir).catch(() => undefined);
  }

  /** Readable records plus the job ids of unreadable ones. */
  async list(): Promise<{ records: ContinuityRecord[]; broken: string[] }> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const records: ContinuityRecord[] = [];
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

  /** The worker-owned index file of an attempt's git checkpoints. */
  async indexFile(jobId: string, attemptId: string): Promise<string> {
    assertSafeSegment('jobId', jobId);
    assertSafeSegment('attemptId', attemptId);
    const dir = await ensureDirInside(this.root, ['.remyral', 'continuity']);
    return join(dir, `${jobId}.${attemptId}.index`);
  }

  /** Snapshot dir of a workspace job's checkpoint `n` (created). */
  async snapshotDir(jobId: string, attemptId: string, n: number): Promise<string> {
    return ensureDirInside(this.root, ['.remyral', 'continuity', 'snap', jobId, attemptId, String(n)]);
  }

  /** Removes the attempt's index file and snapshots. */
  async dropAttemptFiles(jobId: string, attemptId: string): Promise<void> {
    if (!SEGMENT.test(jobId) || !SEGMENT.test(attemptId)) return;
    await rm(join(this.dir, `${jobId}.${attemptId}.index`), { force: true }).catch(() => undefined);
    await rm(join(this.dir, 'snap', jobId, attemptId), { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(join(this.dir, 'snap', jobId), { recursive: false }).catch(() => undefined);
  }

  #file(jobId: string): string {
    return join(this.dir, `${jobId}.json`);
  }
}

// ------------------------------------------------------------------------------------------------- tool calls

/** Recent tool calls of a run with their safety class (protocol `classifyToolCall`) and state. */
export class ToolTracker {
  readonly #tools: ToolRec[];
  #todos: string | undefined;

  constructor(initial: readonly ToolRec[] = [], todos?: string) {
    this.#tools = [...initial];
    this.#todos = todos;
  }

  /** Returns true when something changed. Events are already redacted by the job's output redaction. */
  push(event: AgentEvent): boolean {
    if (event.kind === 'tool_call') {
      this.#tools.push({
        callId: event.callId.slice(0, 128),
        toolName: event.toolName.slice(0, 128),
        summary: event.inputSummary.replace(/\s+/g, ' ').slice(0, 400),
        class: classifyToolCall(event.toolName, event.inputSummary),
        state: 'running',
      });
      if (/^todo_?write$/i.test(event.toolName)) this.#todos = event.inputSummary.slice(0, 2000);
      while (this.#tools.length > MAX_TOOLS) this.#tools.shift();
      return true;
    }
    if (event.kind === 'tool_result') {
      const t = [...this.#tools].reverse().find((x) => x.callId === event.callId && x.state === 'running');
      if (t === undefined) return false;
      t.state = event.ok ? 'done' : 'failed';
      return true;
    }
    return false;
  }

  get tools(): ToolRec[] {
    return this.#tools.map((t) => ({ ...t }));
  }

  get todos(): string | undefined {
    return this.#todos;
  }

  inFlight(): ToolRec[] {
    return this.#tools.filter((t) => t.state === 'running');
  }

  lastCompleted(): ToolRec | undefined {
    return [...this.#tools].reverse().find((t) => t.state !== 'running');
  }
}

export function toolNote(t: ToolRec): ToolCallNote {
  return {
    ...(t.callId !== undefined && SEGMENT.test(t.callId) ? { callId: t.callId } : {}),
    toolName: t.toolName,
    class: t.class,
    state: t.state,
  };
}

// ------------------------------------------------------------------------------------------------- git

export function checkpointRef(attemptId: string, n: number): string {
  assertSafeSegment('attemptId', attemptId);
  return `refs/remana/checkpoints/${attemptId}/${String(n)}`;
}

interface GitCtx {
  readonly git: GitRunner;
  /** The attempt's worktree (its `.git` file points into the trusted mirror). */
  readonly cwd: string;
}

function base(ctx: GitCtx, indexFile?: string) {
  return { cwd: ctx.cwd, ceiling: dirname(ctx.cwd), ...(indexFile === undefined ? {} : { indexFile }) };
}

/** Checkpoint numbers that exist as hidden refs of the attempt. */
export async function listCheckpointRefs(ctx: GitCtx, attemptId: string): Promise<number[]> {
  const prefix = `refs/remana/checkpoints/${attemptId}/`;
  assertSafeSegment('attemptId', attemptId);
  const r = await ctx.git.run({ ...base(ctx), args: ['for-each-ref', '--format=%(refname)', '--', prefix] });
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix))
    .map((l) => Number(l.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

export async function dropCheckpointRefs(ctx: GitCtx, attemptId: string, keepAbove = 0): Promise<void> {
  for (const n of await listCheckpointRefs(ctx, attemptId)) {
    if (n > keepAbove) continue;
    await ctx.git
      .run({ ...base(ctx), args: ['update-ref', '-d', checkpointRef(attemptId, n)] })
      .catch(() => undefined);
  }
}

/** Changed (modified + untracked, not ignored) files of the worktree against the checkpoint index, with sizes. */
async function changedFiles(ctx: GitCtx, indexFile: string): Promise<{ files: number; bytes: number }> {
  const r = await ctx.git.run({
    ...base(ctx, indexFile),
    args: ['ls-files', '-z', '--modified', '--others', '--exclude-standard'],
  });
  let files = 0;
  let bytes = 0;
  for (const rel of r.stdout.split('\0')) {
    if (rel === '') continue;
    files++;
    const st = await lstat(join(ctx.cwd, rel)).catch(() => null);
    if (st?.isFile() === true) bytes += st.size;
  }
  return { files, bytes };
}

export type GitCheckpointOutcome =
  | {
      readonly kind: 'taken';
      readonly ref: string;
      readonly commit: string;
      readonly tree: string;
      readonly files: number;
      readonly bytes: number;
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'too_large'; readonly files: number; readonly bytes: number };

/**
 * One git checkpoint (see the module comment). `parent`: the previous checkpoint commit, else the base commit.
 * Hooks never run (hardened GitRunner); the worktree's own index, HEAD and branch are not touched.
 */
export async function takeGitCheckpoint(
  ctx: GitCtx,
  opts: {
    readonly attemptId: string;
    readonly n: number;
    readonly baseCommit: string;
    readonly parent: string | null;
    readonly lastTree: string | null;
    readonly indexFile: string;
    readonly policy: Pick<ContinuityPolicy, 'maxBytes' | 'maxFiles'>;
  },
): Promise<GitCheckpointOutcome> {
  if (!SHA.test(opts.baseCommit)) throw new Error('invalid base commit');
  const idx = opts.indexFile;
  if ((await lstat(idx).catch(() => null)) === null) {
    await ctx.git.run({ ...base(ctx, idx), args: ['read-tree', opts.baseCommit] });
  }
  const changed = await changedFiles(ctx, idx);
  if (changed.files > opts.policy.maxFiles || changed.bytes > opts.policy.maxBytes) {
    return { kind: 'too_large', ...changed };
  }
  await ctx.git.run({ ...base(ctx, idx), args: ['add', '-A', '--', '.'] });
  const tree = (await ctx.git.run({ ...base(ctx, idx), args: ['write-tree'] })).stdout.trim();
  if (!SHA.test(tree)) throw new Error('git write-tree returned no tree');
  if (tree === opts.lastTree) return { kind: 'unchanged' };
  const parent = opts.parent ?? opts.baseCommit;
  const commit = (
    await ctx.git.run({
      ...base(ctx, idx),
      args: ['commit-tree', tree, '-p', parent, '-F', '-'],
      input: `remyral checkpoint ${String(opts.n)} of attempt ${opts.attemptId}\n\nWork in progress (not published).\n`,
      config: [
        ['user.name', 'Remyral checkpoint'],
        ['user.email', 'checkpoint@remyral.invalid'],
      ],
    })
  ).stdout.trim();
  if (!SHA.test(commit)) throw new Error('git commit-tree returned no commit');
  const ref = checkpointRef(opts.attemptId, opts.n);
  await ctx.git.run({ ...base(ctx), args: ['update-ref', ref, commit] });
  // Files and bytes changed against the base (what a continuation is told).
  const stat = await ctx.git.run({
    ...base(ctx, idx),
    args: ['diff', '--cached', '--numstat', '-z', opts.baseCommit],
  });
  let files = 0;
  for (const rec of stat.stdout.split('\0')) if (/^\S+\t\S+\t/.test(rec)) files++;
  return { kind: 'taken', ref, commit, tree, files, bytes: changed.bytes };
}

/** Bounded `--stat` summary (staged worktree vs `against`) — what changed after a checkpoint / since the base. */
export async function diffSummary(
  ctx: GitCtx,
  indexFile: string,
  against: string,
  max = 3_000,
): Promise<string> {
  await ctx.git.run({ ...base(ctx, indexFile), args: ['add', '-A', '--', '.'] });
  const r = await ctx.git.run({
    ...base(ctx, indexFile),
    args: ['diff', '--cached', '--stat=160,120', '--stat-count=40', against],
  });
  const text = r.stdout.trim();
  if (text === '') return 'no changes';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The ref still names the recorded commit (the checkpoint survived). */
export async function checkpointIntact(ctx: GitCtx, ref: string, commit: string): Promise<boolean> {
  const r = await ctx.git.run({
    ...base(ctx),
    args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    okCodes: [1, 128],
  });
  return r.code === 0 && r.stdout.trim() === commit;
}

// ------------------------------------------------------------------------------------------------- snapshots

interface ManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function walk(dir: string, out: ManifestEntry[], rootDir: string, limit: number): Promise<void> {
  if (out.length > limit) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(abs, out, rootDir, limit);
    else if (e.isFile()) {
      const st = await lstat(abs).catch(() => null);
      if (st === null) continue;
      out.push({
        path: relative(rootDir, abs).split(sep).join('/'),
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      });
      if (out.length > limit) return;
    }
  }
}

export async function scanDir(dir: string, limit: number): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  await walk(dir, out, dir, limit);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function manifestDigest(entries: readonly ManifestEntry[]): string {
  const h = createHash('sha256');
  for (const e of entries) h.update(`${e.path}\0${String(e.size)}\0${String(e.mtimeMs)}\n`);
  return h.digest('hex');
}

export type SnapshotOutcome =
  | { readonly kind: 'taken'; readonly digest: string; readonly files: number; readonly bytes: number }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'too_large'; readonly files: number; readonly bytes: number };

/** A workspace job's snapshot: manifest + reflink/copy into `dest` (see the module comment). */
export async function takeSnapshot(
  dir: string,
  dest: () => Promise<string>,
  opts: {
    readonly lastDigest: string | null;
    readonly policy: Pick<ContinuityPolicy, 'maxBytes' | 'maxFiles'>;
  },
): Promise<SnapshotOutcome> {
  const entries = await scanDir(dir, opts.policy.maxFiles + 1);
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  if (entries.length > opts.policy.maxFiles || bytes > opts.policy.maxBytes) {
    return { kind: 'too_large', files: entries.length, bytes };
  }
  const digest = manifestDigest(entries);
  if (digest === opts.lastDigest) return { kind: 'unchanged' };
  const target = await dest();
  for (const e of entries) {
    const to = join(target, 'files', ...e.path.split('/'));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(join(dir, ...e.path.split('/')), to, fsConstants.COPYFILE_FICLONE).catch(() => undefined);
  }
  await atomicWriteFile(
    createNodeFileOps(),
    join(target, 'manifest.json'),
    `${JSON.stringify({ digest, entries })}\n`,
    {
      mode: 0o600,
    },
  );
  return { kind: 'taken', digest, files: entries.length, bytes };
}

/** What changed in `dir` against the manifest of snapshot `snapDir` (bounded text). */
export async function snapshotDiff(dir: string, snapDir: string, limit = 50_000): Promise<string | null> {
  let manifest: { entries: ManifestEntry[] };
  try {
    manifest = JSON.parse(await readFile(join(snapDir, 'manifest.json'), 'utf8')) as {
      entries: ManifestEntry[];
    };
  } catch {
    return null;
  }
  const before = new Map(manifest.entries.map((e) => [e.path, e]));
  const now = await scanDir(dir, limit);
  const changed: string[] = [];
  const added: string[] = [];
  for (const e of now) {
    const b = before.get(e.path);
    if (b === undefined) added.push(e.path);
    else if (b.size !== e.size || b.mtimeMs !== e.mtimeMs) changed.push(e.path);
    before.delete(e.path);
  }
  const removed = [...before.keys()];
  if (changed.length + added.length + removed.length === 0) return 'no changes';
  const list = (label: string, xs: string[]) =>
    xs.length === 0
      ? []
      : [`${label} (${String(xs.length)}): ${xs.slice(0, 15).join(', ')}${xs.length > 15 ? ', …' : ''}`];
  return [...list('changed', changed), ...list('added', added), ...list('removed', removed)]
    .join('\n')
    .slice(0, 3000);
}

// ------------------------------------------------------------------------------------------------- one attempt

export interface AttemptContinuityHooks {
  /** The runtime session as it stands (adapter `sessionCheckpoint`); null when not known. */
  session(): Promise<ParkedSession | null>;
  activeMs(): number;
  transcript(): string;
  /** CHECKPOINT_REPORT to the master (best effort; rejects without a session). */
  report(p: CheckpointReportPayload): Promise<void>;
  /** Current lease epoch. */
  epoch(): number;
}

/**
 * Checkpointing of one running attempt. Created when its workspace is ready, persisted before the runtime starts
 * (`begin`), updated on every runtime spawn (pids) and checkpoint, ended when the attempt ends or is parked.
 */
export class AttemptContinuity {
  #rec: ContinuityRecord;
  readonly tracker: ToolTracker;
  #timer: NodeJS.Timeout | null = null;
  #busy: Promise<unknown> | null = null;
  #saving: Promise<void> = Promise.resolve();
  #ended = false;
  #nextN = 1;

  constructor(
    private readonly deps: {
      readonly store: ContinuityStore;
      readonly git: GitRunner | null;
      readonly log: Logger;
      readonly redact: (s: string) => string;
      /** Repository jobs: the worktree; workspace jobs: the scratch dir. */
      readonly workspacePath: string;
      readonly hooks: AttemptContinuityHooks;
    },
    init: ContinuityRecord,
  ) {
    this.#rec = ContinuityRecord.parse(init);
    this.tracker = new ToolTracker(init.tools, init.todos);
  }

  get record(): ContinuityRecord {
    return {
      ...this.#rec,
      tools: this.tracker.tools,
      ...(this.tracker.todos === undefined ? {} : { todos: this.tracker.todos }),
    };
  }

  get lastCheckpoint(): CheckpointRec | undefined {
    return this.#rec.checkpoints.at(-1);
  }

  /** Persists the first record (before the runtime starts) and finds the next checkpoint number. */
  async begin(): Promise<void> {
    if (this.#rec.kind === 'repo' && this.deps.git !== null) {
      const existing = await listCheckpointRefs(
        { git: this.deps.git, cwd: this.deps.workspacePath },
        this.#rec.attemptId,
      ).catch(() => [] as number[]);
      this.#nextN = Math.max(1, (existing.at(-1) ?? 0) + 1, (this.#rec.checkpoints.at(-1)?.n ?? 0) + 1);
    } else {
      this.#nextN = (this.#rec.checkpoints.at(-1)?.n ?? 0) + 1;
    }
    await this.#save();
  }

  /** A runtime process was spawned (pid recorded at once: a crash right after must still find it). */
  onProcess(pid: number): void {
    if (this.#ended || !Number.isInteger(pid) || pid <= 1) return;
    this.#rec = { ...this.#rec, processes: [...this.#rec.processes, { pid, at: Date.now() }].slice(-64) };
    void this.#save().catch(() => undefined);
  }

  onEvent(event: AgentEvent): void {
    if (this.#ended) return;
    this.tracker.push(event);
  }

  /** Periodic checkpoints (unref'd timer). */
  start(): void {
    if (this.#timer !== null || this.#ended) return;
    this.#timer = setInterval(() => {
      void this.checkpoint().catch((err: unknown) => {
        this.deps.log.warn('checkpoint failed', {
          jobId: this.#rec.jobId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.#rec.policy.intervalSec * 1000);
    this.#timer.unref();
  }

  /** Takes one checkpoint now (serialised; a call while one runs returns that one's outcome). */
  checkpoint(): Promise<CheckpointRec | 'unchanged' | 'too_large' | 'ended'> {
    if (this.#ended) return Promise.resolve('ended');
    if (this.#busy !== null) return this.#busy as Promise<CheckpointRec | 'unchanged' | 'too_large'>;
    const run = this.#take().finally(() => {
      this.#busy = null;
    });
    this.#busy = run;
    return run;
  }

  async #take(): Promise<CheckpointRec | 'unchanged' | 'too_large'> {
    const rec = this.#rec;
    const last = rec.checkpoints.at(-1);
    const n = this.#nextN;
    const policy = rec.policy;
    let entry: CheckpointRec;
    if (rec.kind === 'repo') {
      if (this.deps.git === null || rec.repo === null) return 'unchanged';
      const ctx = { git: this.deps.git, cwd: this.deps.workspacePath };
      const out = await takeGitCheckpoint(ctx, {
        attemptId: rec.attemptId,
        n,
        baseCommit: rec.repo.baseCommit,
        parent: last?.commit ?? null,
        lastTree: last?.tree ?? null,
        indexFile: await this.deps.store.indexFile(rec.jobId, rec.attemptId),
        policy,
      });
      if (out.kind === 'unchanged') return 'unchanged';
      if (out.kind === 'too_large') {
        this.deps.log.warn('checkpoint skipped: the changes exceed the size caps', {
          jobId: rec.jobId,
          files: out.files,
          bytes: out.bytes,
        });
        return 'too_large';
      }
      entry = {
        n,
        at: new Date().toISOString(),
        kind: 'git',
        ref: out.ref,
        commit: out.commit,
        tree: out.tree,
        files: out.files,
        bytes: out.bytes,
      };
      // Older hidden refs beyond `keep` are dropped.
      await dropCheckpointRefs(ctx, rec.attemptId, n - policy.keep).catch(() => undefined);
    } else {
      const out = await takeSnapshot(
        this.deps.workspacePath,
        () => this.deps.store.snapshotDir(rec.jobId, rec.attemptId, n),
        {
          lastDigest: last?.digest ?? null,
          policy,
        },
      );
      if (out.kind === 'unchanged') return 'unchanged';
      if (out.kind === 'too_large') {
        this.deps.log.warn('snapshot skipped: the workspace exceeds the size caps', {
          jobId: rec.jobId,
          files: out.files,
          bytes: out.bytes,
        });
        return 'too_large';
      }
      entry = {
        n,
        at: new Date().toISOString(),
        kind: 'snapshot',
        digest: out.digest,
        files: out.files,
        bytes: out.bytes,
      };
      // Only the newest copy is kept (the older manifests' metadata stays in the record).
      for (const old of rec.checkpoints) {
        await rm(join(this.deps.store.dir, 'snap', rec.jobId, rec.attemptId, String(old.n)), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
    }
    this.#nextN = n + 1;
    const session = await this.deps.hooks.session().catch(() => null);
    this.#rec = {
      ...this.#rec,
      epoch: Math.max(this.#rec.epoch, this.deps.hooks.epoch()),
      session: session ?? this.#rec.session,
      summary: this.deps.redact(this.deps.hooks.transcript()).slice(-MAX_SUMMARY),
      activeMs: Math.round(this.deps.hooks.activeMs()),
      checkpoints: [...this.#rec.checkpoints, entry].slice(-policy.keep),
    };
    await this.#save();
    const lastTool = this.tracker.lastCompleted();
    const sid = this.#rec.session?.runtimeSessionId;
    await this.deps.hooks
      .report({
        attemptId: rec.attemptId as CheckpointReportPayload['attemptId'],
        epoch: this.deps.hooks.epoch(),
        n: entry.n,
        at: new Date(entry.at).toISOString(),
        kind: entry.kind,
        ...(entry.ref === undefined ? {} : { ref: entry.ref }),
        ...(entry.commit === undefined ? {} : { commit: entry.commit }),
        files: entry.files,
        bytes: entry.bytes,
        ...(sid !== undefined && SEGMENT.test(sid) ? { runtimeSessionId: sid } : {}),
        ...(lastTool === undefined ? {} : { lastTool: toolNote(lastTool) }),
        inFlight: Math.min(1000, this.tracker.inFlight().length),
        activeMs: this.#rec.activeMs,
      })
      .catch(() => undefined);
    this.deps.log.info('checkpoint taken', {
      jobId: rec.jobId,
      n: entry.n,
      kind: entry.kind,
      files: entry.files,
    });
    return entry;
  }

  /**
   * The attempt ended (`keep: false`: finished — record, refs and snapshots removed) or was parked (`keep: true`: the
   * parked record takes over; refs / snapshots stay for the resume).
   */
  async end(opts: { readonly keep: boolean }): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#busy?.catch(() => undefined);
    await this.#saving.catch(() => undefined);
    await this.deps.store.remove(this.#rec.jobId).catch(() => undefined);
    if (opts.keep) return;
    if (this.#rec.kind === 'repo' && this.deps.git !== null) {
      await dropCheckpointRefs(
        { git: this.deps.git, cwd: this.deps.workspacePath },
        this.#rec.attemptId,
        Number.MAX_SAFE_INTEGER,
      ).catch(() => undefined);
    }
    await this.deps.store.dropAttemptFiles(this.#rec.jobId, this.#rec.attemptId);
  }

  #save(): Promise<void> {
    const run = this.#saving.then(async () => {
      if (this.#ended) return;
      this.#rec = { ...this.record, updatedAt: new Date().toISOString() };
      await this.deps.store.save(this.#rec);
    });
    this.#saving = run.catch(() => undefined);
    return run;
  }
}
