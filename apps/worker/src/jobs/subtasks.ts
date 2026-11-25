import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { SubtaskToolHost } from '@remyral/agent-adapters';
import type { Logger, Redactor } from '@remyral/observability';
import {
  type AssignedSubtasks,
  fenceData,
  InputName,
  type InputRef,
  workspaceFileType,
  SUBTASK_BLOCKED_BY_PARENT,
  SUBTASK_INPUTS_PENDING,
  SUBTASK_LIMITS,
  subtaskInputArtifactId,
  type SubtaskInlineInput,
  type SubtaskStagedInput,
  type SubtaskRequestOp,
  type SubtaskRequestPayload,
  type SubtaskStatusPayload,
} from '@remyral/protocol';
import { prePushScanner } from '../workspace/secret-scan.js';
import { fetchInputs, type InputFetch, readNoFollow } from './workspace-job.js';

/**
 * Worker side of a job's sub-job tools (p8-orchestration, ADR-0031, docs/design/p8-orchestration.md §3): every tool
 * call becomes one SUBTASK_REQUEST over the job's live lease and waits for the SUBTASK_STATUS with the same request
 * id. Waiting for a sub-job is a long poll: `status` every few seconds until it is terminal or the call's `waitSec`
 * ran out (then the agent is told to call `wait_subtask` again). Delivered files are downloaded with the existing
 * JOB_INPUT_REQUEST into `in/subtasks/<id8>/` (verified size and SHA-256, read-only files).
 *
 * Nothing the agent supplies widens what the master allows: the master derives the sub-job's spec from the parent's
 * and the project's policy; this side only reads the requested input files safely and formats the answers.
 */

export interface SubtaskChannel {
  request(jobId: string, payload: SubtaskRequestPayload): Promise<void>;
}

export interface JobSubtasksDeps {
  readonly channel: SubtaskChannel;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: () => number;
  /** What the master allows this job (ASSIGN_JOB execution.subtasks). */
  readonly assigned: AssignedSubtasks;
  /** The job's working directory (inputs are read relative to it). */
  readonly root: string;
  /** Workspace jobs: `in/` (delivered files land in `in/subtasks/<id8>/`); null for repository jobs. */
  readonly inDir: string | null;
  readonly fetchInput: InputFetch;
  /** The daemon's redactor: text inputs are redacted, binary ones scanned before they leave the worker. */
  readonly redactor: Redactor;
  readonly logger: Logger;
  /** How long one SUBTASK_STATUS may take (default 30 s). */
  readonly answerTimeoutMs?: number;
  /** Poll period while waiting (default 3 s). */
  readonly pollMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  /**
   * p22-previews-inputs: streams one staged input as an artifact of this attempt (ARTIFACT_CHUNK… + ARTIFACT_REF,
   * sequenced). Used only when the assignment says `stagedInputs` and the inputs exceed the inline limit.
   */
  readonly stage?: (artifact: {
    readonly id: string;
    readonly name: string;
    readonly mediaType: string;
    readonly content: Buffer;
  }) => Promise<void>;
  /** How long a create waits for staged inputs to be stored on the master (ms, default 120 s). */
  readonly stagedWaitMs?: number;
}

type Outcome = { readonly ok: boolean; readonly text: string };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'refused']);

/**
 * p9-subjob-local-login-deadlock: the master says the sub-job waits only for this job itself (it can run only on this
 * machine, and there only once this job ends) — waiting for it would deadlock, so the wait stops at once.
 */
const blockedByParent = (s: SubtaskStatusPayload): boolean =>
  s.state === 'queued' && s.reason === SUBTASK_BLOCKED_BY_PARENT;

export class SubtaskInputError extends Error {
  override name = 'SubtaskInputError';
}

/**
 * Reads the files the agent named (paths relative to `root`): regular files only, no symbolic link anywhere below
 * the root, inside the root after resolving, valid input names, at most {@link SUBTASK_LIMITS} in count and bytes.
 */
export async function readSubtaskInputs(
  root: string,
  paths: readonly string[],
  redactor: Redactor,
): Promise<SubtaskInlineInput[]> {
  const files = await readSubtaskFiles(root, paths, redactor, SUBTASK_LIMITS.maxInputBytes);
  return files.map((f) => ({ name: f.name, contentBase64: f.content.toString('base64') }));
}

/**
 * p22-previews-inputs: {@link readSubtaskInputs} with a total limit — the inline limit, or with staging
 * {@link SUBTASK_LIMITS}.maxStagedInputBytes (each file at most maxStagedFileBytes). Returns the (redacted) bytes.
 */
export async function readSubtaskFiles(
  root: string,
  paths: readonly string[],
  redactor: Redactor,
  maxTotal: number,
): Promise<{ readonly name: string; readonly mediaType: string; readonly content: Buffer }[]> {
  if (paths.length > SUBTASK_LIMITS.maxInputs) {
    throw new SubtaskInputError(`at most ${String(SUBTASK_LIMITS.maxInputs)} input files`);
  }
  const realRoot = await realpath(root);
  const out: { name: string; mediaType: string; content: Buffer }[] = [];
  const perFile = Math.min(maxTotal, SUBTASK_LIMITS.maxStagedFileBytes);
  const names = new Set<string>();
  let total = 0;
  for (const p of paths) {
    if (p.includes('\0') || isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
      throw new SubtaskInputError(`${p}: use a path inside your working directory`);
    }
    const target = resolve(realRoot, p);
    if (!target.startsWith(`${realRoot}${sep}`)) {
      throw new SubtaskInputError(`${p}: use a path inside your working directory`);
    }
    // No symbolic link on the way: every component below the root is checked with lstat.
    let cur = realRoot;
    for (const part of target.slice(realRoot.length + 1).split(sep)) {
      cur = join(cur, part);
      const st = await lstat(cur).catch(() => null);
      if (st === null) throw new SubtaskInputError(`${p}: not found`);
      if (st.isSymbolicLink()) throw new SubtaskInputError(`${p}: symbolic links are not followed`);
    }
    const st = await lstat(target);
    if (!st.isFile()) throw new SubtaskInputError(`${p}: not a regular file`);
    total += st.size;
    if (total > maxTotal) {
      throw new SubtaskInputError(
        `input files are limited to ${String(Math.floor(maxTotal / 1024))} KiB in total; pass a smaller file or describe it in the prompt`,
      );
    }
    if (st.size > perFile) {
      throw new SubtaskInputError(
        `${p}: an input file is limited to ${String(Math.floor(perFile / 1024))} KiB; pass a smaller file or describe it in the prompt`,
      );
    }
    let name = basename(target);
    if (!InputName.safeParse(name).success) {
      throw new SubtaskInputError(`${p}: file name or type not allowed for an input`);
    }
    for (let i = 2; names.has(name); i++) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)}-${String(i)}${name.slice(dot)}` : `${name}-${String(i)}`;
    }
    names.add(name);
    // O_NOFOLLOW + the same file as listed (a swap after the checks is refused, never followed).
    const raw = await readNoFollow(target, perFile).catch(() => null);
    const again = await lstat(target).catch(() => null);
    if (
      raw === null ||
      again === null ||
      again.ino !== st.ino ||
      again.dev !== st.dev ||
      raw.length !== st.size
    ) {
      throw new SubtaskInputError(`${p}: changed while it was read`);
    }
    const type = workspaceFileType(name);
    let content = raw;
    if (type?.text === true) {
      // Values this worker knows as secrets never leave it (the master scans the result again).
      content = Buffer.from(redactor.redact(raw.toString('utf8')), 'utf8');
    } else if (prePushScanner(redactor.secrets).spans(raw.toString('latin1')).length > 0) {
      throw new SubtaskInputError(`${p}: looks like it contains a secret`);
    }
    out.push({ name, mediaType: type?.mediaType ?? 'application/octet-stream', content });
  }
  return out;
}

const short = (id: string): string => id.replaceAll('-', '').slice(0, 8);

export class JobSubtasks implements SubtaskToolHost {
  readonly #d: JobSubtasksDeps;
  readonly #log: Logger;
  readonly #pending = new Map<string, (p: SubtaskStatusPayload | null) => void>();
  /** Sub-job id → files already downloaded (a later status call does not fetch them again). */
  readonly #delivered = new Map<string, Set<string>>();
  #ended = false;

  constructor(d: JobSubtasksDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'subtasks', jobId: d.jobId });
  }

  /** Routes a SUBTASK_STATUS; false when no request of this job waits for it. */
  onStatus(p: SubtaskStatusPayload): boolean {
    if (p.attemptId !== this.#d.attemptId) return false;
    const resolveFn = this.#pending.get(p.requestId);
    if (resolveFn === undefined) return false;
    resolveFn(p);
    return true;
  }

  /** The job ends: pending calls answer at once, new ones are refused. */
  end(): void {
    this.#ended = true;
    for (const r of this.#pending.values()) r(null);
    this.#pending.clear();
  }

  #isEnded(): boolean {
    return this.#ended;
  }

  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.#d.sleep !== undefined) return this.#d.sleep(ms, signal);
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      t.unref();
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          res();
        },
        { once: true },
      );
    });
  }

  async #ask(op: SubtaskRequestOp, requestId: string = randomUUID()): Promise<SubtaskStatusPayload | null> {
    if (this.#isEnded()) return null;
    const answer = new Promise<SubtaskStatusPayload | null>((res) => {
      const timer = setTimeout(() => {
        res(null);
      }, this.#d.answerTimeoutMs ?? 30_000);
      timer.unref();
      this.#pending.set(requestId, (p) => {
        clearTimeout(timer);
        res(p);
      });
    });
    try {
      await this.#d.channel.request(this.#d.jobId, {
        attemptId: this.#d.attemptId as SubtaskRequestPayload['attemptId'],
        epoch: this.#d.epoch(),
        requestId,
        op,
      });
      return await answer;
    } catch (err) {
      this.#log.warn('sub-job request not sent', { err: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      this.#pending.delete(requestId);
    }
  }

  async request(args: Parameters<SubtaskToolHost['request']>[0], signal?: AbortSignal): Promise<Outcome> {
    if (args.runtime !== undefined && !this.#d.assigned.runtimes.includes(args.runtime)) {
      return {
        ok: false,
        text: `Refused: runtime ${args.runtime} is not allowed for sub-jobs of this project (allowed: ${this.#d.assigned.runtimes.join(', ')}).`,
      };
    }
    let inputs: SubtaskInlineInput[] = [];
    let staged: SubtaskStagedInput[] = [];
    if ((args.inputs ?? []).length > 0) {
      if (this.#d.inDir === null) {
        return {
          ok: false,
          text: 'Refused: input files are only for workspace projects; the sub-job checks out the same repository.',
        };
      }
      // p22-previews-inputs: above the inline limit the files are staged as artifacts of this attempt (when the
      // master accepts staged inputs); small inputs stay inline.
      const canStage = this.#d.assigned.stagedInputs === true && this.#d.stage !== undefined;
      try {
        const files = await readSubtaskFiles(
          this.#d.root,
          args.inputs ?? [],
          this.#d.redactor,
          canStage ? SUBTASK_LIMITS.maxStagedInputBytes : SUBTASK_LIMITS.maxInputBytes,
        );
        const total = files.reduce((n, f) => n + f.content.length, 0);
        if (!canStage || total <= SUBTASK_LIMITS.maxInputBytes) {
          inputs = files.map((f) => ({ name: f.name, contentBase64: f.content.toString('base64') }));
        } else {
          staged = await this.#stage(files);
        }
      } catch (err) {
        if (err instanceof SubtaskInputError) return { ok: false, text: `Refused: ${err.message}.` };
        throw err;
      }
    }
    const op: SubtaskRequestOp = {
      kind: 'create',
      title: args.title,
      prompt: args.prompt,
      ...(args.runtime === undefined ? {} : { runtime: args.runtime }),
      ...(args.requires === undefined || args.requires.length === 0 ? {} : { requires: [...args.requires] }),
      ...(inputs.length === 0 ? {} : { inputs }),
      ...(staged.length === 0 ? {} : { stagedInputs: staged }),
      // p11-merge-pipeline: the sub-job's file ownership (validated by the tool's input schema; the master checks again).
      ...(args.paths === undefined || args.paths.length === 0 ? {} : { paths: [...args.paths] }),
      wait: args.wait,
    };
    const created = staged.length === 0 ? await this.#ask(op) : await this.#createStaged(op, signal);
    if (created === null) return this.#noAnswer();
    if (created.state === 'refused' || created.subtaskId === undefined) return this.#format(created, []);
    this.#log.info('sub-job created', { subtaskId: created.subtaskId, runtime: created.runtime ?? null });
    if (!args.wait) return this.#format(created, []);
    return this.#waitFor(created.subtaskId, args.waitSec, signal, created);
  }

  /** p22-previews-inputs: streams each file as a `ws-subin-…` artifact of this attempt (sequenced, outbox). */
  async #stage(
    files: readonly { readonly name: string; readonly mediaType: string; readonly content: Buffer }[],
  ): Promise<SubtaskStagedInput[]> {
    const stage = this.#d.stage;
    if (stage === undefined) throw new SubtaskInputError('staging input files is not available');
    const out: SubtaskStagedInput[] = [];
    for (const f of files) {
      const sha256 = createHash('sha256').update(f.content).digest('hex');
      const id = subtaskInputArtifactId(f.name, sha256);
      try {
        await stage({ id, name: f.name, mediaType: f.mediaType, content: f.content });
      } catch (err) {
        this.#log.warn('staging a sub-job input failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        throw new SubtaskInputError(`${f.name}: could not be handed to the platform (connection?)`);
      }
      out.push({ name: f.name, artifactId: id, sizeBytes: f.content.length, sha256 });
    }
    this.#log.info('sub-job inputs staged', {
      files: out.length,
      bytes: out.reduce((n, f) => n + f.sizeBytes, 0),
    });
    return out;
  }

  /**
   * A create with staged inputs: the master answers {@link SUBTASK_INPUTS_PENDING} until the sequenced ARTIFACT_REFs
   * are applied; the same request id is retried (creation stays idempotent) until stored or the wait ran out.
   */
  async #createStaged(op: SubtaskRequestOp, signal?: AbortSignal): Promise<SubtaskStatusPayload | null> {
    const now = this.#d.now ?? Date.now;
    const deadline = now() + (this.#d.stagedWaitMs ?? 120_000);
    const requestId = randomUUID();
    for (;;) {
      const s = await this.#ask(op, requestId);
      if (s?.state !== 'refused' || s.reason !== SUBTASK_INPUTS_PENDING) return s;
      if (now() >= deadline || signal?.aborted === true || this.#isEnded()) {
        return {
          ...s,
          detail:
            'The input files did not reach the platform in time (slow or interrupted connection); try again or pass smaller files.',
        };
      }
      await this.#sleep(1_000, signal);
    }
  }

  async wait(subtaskId: string, waitSec: number | undefined, signal?: AbortSignal): Promise<Outcome> {
    return this.#waitFor(subtaskId, waitSec, signal, null);
  }

  async cancel(subtaskId: string): Promise<Outcome> {
    const s = await this.#ask({ kind: 'cancel', subtaskId });
    return s === null ? this.#noAnswer() : this.#format(s, []);
  }

  async #waitFor(
    subtaskId: string,
    waitSec: number | undefined,
    signal: AbortSignal | undefined,
    first: SubtaskStatusPayload | null,
  ): Promise<Outcome> {
    const now = this.#d.now ?? Date.now;
    const budget = Math.min(waitSec ?? SUBTASK_LIMITS.defaultWaitSec, SUBTASK_LIMITS.maxWaitSec) * 1000;
    const deadline = now() + budget;
    let last = first;
    for (;;) {
      if (last === null || !TERMINAL.has(last.state)) {
        const s = await this.#ask({ kind: 'status', subtaskId });
        if (s === null) return this.#noAnswer(subtaskId);
        last = s;
      }
      if (TERMINAL.has(last.state)) break;
      if (blockedByParent(last)) {
        return {
          ok: false,
          text: `${this.#format(last, []).text}\nNot waiting: this sub-job cannot start before this job ends.`,
        };
      }
      if (now() >= deadline || signal?.aborted === true || this.#isEnded()) {
        return {
          ok: true,
          text:
            `${this.#format(last, []).text}\nStill running. Call wait_subtask with subtaskId "${subtaskId}" to keep ` +
            'waiting (or continue with other work first).',
        };
      }
      await this.#sleep(Math.min(this.#d.pollMs ?? 3_000, Math.max(0, deadline - now())), signal);
      last = null;
    }
    const paths = last.state === 'succeeded' ? await this.#download(subtaskId, last.files ?? []) : [];
    return this.#format(last, paths);
  }

  /** Downloads delivered files once into `in/subtasks/<id8>/`; returns their paths relative to the root. */
  async #download(subtaskId: string, files: readonly InputRef[]): Promise<string[]> {
    if (this.#d.inDir === null || files.length === 0) return [];
    const dirName = short(subtaskId);
    const dir = join(this.#d.inDir, 'subtasks', dirName);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const done = this.#delivered.get(subtaskId) ?? new Set<string>();
    this.#delivered.set(subtaskId, done);
    const prefix = `${dirName}-`;
    const local = files.map((f) => ({
      ...f,
      name: f.name.startsWith(prefix) && f.name.length > prefix.length ? f.name.slice(prefix.length) : f.name,
    }));
    const todo = local.filter((f) => !done.has(f.inputId));
    if (todo.length > 0) {
      await fetchInputs(this.#d.fetchInput, todo, dir);
      for (const f of todo) done.add(f.inputId);
      this.#log.info('sub-job files delivered', { subtaskId, files: todo.length });
    }
    const rel = `in/subtasks/${dirName}`;
    return local.map((f) => `${rel}/${f.name}`);
  }

  #noAnswer(subtaskId?: string): Outcome {
    if (this.#isEnded()) return { ok: false, text: 'The job is ending; no sub-job request was sent.' };
    return {
      ok: false,
      text:
        'The platform did not answer in time (connection to the master interrupted?).' +
        (subtaskId === undefined
          ? ' Try again.'
          : ` The sub-job ${subtaskId} keeps running; call wait_subtask again.`),
    };
  }

  #format(s: SubtaskStatusPayload, paths: readonly string[]): Outcome {
    if (s.state === 'refused') {
      return {
        ok: false,
        text: `Refused (${s.reason ?? 'refused'}): ${s.detail ?? 'the platform did not allow this sub-job.'}`,
      };
    }
    const head = [
      `Sub-job ${s.subtaskId ?? '?'}`,
      s.title === undefined ? '' : ` "${s.title}"`,
      s.runtime === undefined ? '' : ` (${s.runtime}${s.worker === undefined ? '' : ` on ${s.worker}`})`,
      `: ${s.state}.`,
    ].join('');
    const lines = [head];
    if (s.detail !== undefined) lines.push(s.detail);
    if (s.summary !== undefined && s.summary !== '') {
      lines.push(fenceData('result summary of the sub-job', s.summary));
    }
    if (paths.length > 0) {
      lines.push('Files from the sub-job (read-only):', ...paths.map((p) => `- ${p}`));
    }
    if ((s.dropped ?? []).length > 0) lines.push(`Not handed over: ${(s.dropped ?? []).join('; ')}`);
    return { ok: s.state !== 'failed' && s.state !== 'cancelled', text: lines.join('\n') };
  }
}

/** The preamble line for a job whose agent may delegate (only when the adapter offers the tools). */
export function subtaskPreamble(assigned: AssignedSubtasks, workspace: boolean): string {
  return [
    '[Remyral sub-jobs] You may hand self-contained parts of this task to other agent jobs with the request_subtask',
    `tool (runtimes allowed: ${assigned.runtimes.join(', ')}; e.g. image generation: runtime "codex", requires`,
    '["image-generation"]). A sub-job sees only the prompt and files you give it; wait for it with wait_subtask.',
    workspace
      ? 'Its files arrive read-only in ./in/subtasks/<id>/ — copy what you deliver into ./out/.'
      : 'It works on its own branch of the same repository; its result summary comes back to you.',
    ...(workspace
      ? []
      : [
          "When you split work across sub-jobs, split it by disjoint files/directories and state each one's `paths`",
          '(e.g. ["src/api/", "docs/api.md"]); do not edit the files your sub-jobs own. The platform integrates all',
          'sub-job branches into one integration branch itself — do not try to merge or check out sub-job branches.',
        ]),
    'Use sub-jobs only when another runtime or machine is clearly better suited; do the rest yourself.',
  ].join('\n');
}
