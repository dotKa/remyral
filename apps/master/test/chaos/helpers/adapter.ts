import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentAdapter,
  basicScript,
  FakeRuntimeAdapter,
  type SessionRef,
  type SessionResult,
  type SpawnContext,
} from '@remyral/agent-adapters';

/** Every runtime spawn across all chaos workers: `<workerTag> <jobId>/<attemptId>`. */
export class SpawnLedger {
  readonly spawns: { worker: string; jobId: string; attemptId: string }[] = [];
  /** Spawns per attempt (a crash-free fleet spawns every attempt once). */
  countFor(attemptId: string): number {
    return this.spawns.filter((s) => s.attemptId === attemptId).length;
  }
  forJob(jobId: string): string[] {
    return this.spawns.filter((s) => s.jobId === jobId).map((s) => s.attemptId);
  }
}

class Gate {
  promise: Promise<void>;
  release!: () => void;
  constructor() {
    this.promise = new Promise<void>((r) => {
      this.release = r;
    });
  }
}

/**
 * The fake runtime for chaos runs: `edit <path> <text>` prompt lines are written into the attempt worktree
 * at spawn (so the worker has something to commit and push), every spawn is recorded in a shared ledger,
 * and a test can hold a job's result (`hold(jobId)`) to crash, partition or restart things mid-run.
 */
export class ChaosAdapter implements AgentAdapter {
  readonly runtime = 'codex' as const;
  readonly inner = new FakeRuntimeAdapter({ runtime: 'codex', script: basicScript });
  readonly #gates = new Map<string, Gate>();
  readonly #jobs = new Map<string, string>();
  readonly #signals = new Map<string, AbortSignal>();

  constructor(
    private readonly tag: string,
    private readonly ledger: SpawnLedger,
  ) {}

  /** The job's runs block in collectResult until `release(jobId)`. */
  hold(jobId: string): void {
    if (!this.#gates.has(jobId)) this.#gates.set(jobId, new Gate());
  }
  release(jobId: string): void {
    this.#gates.get(jobId)?.release();
  }
  /** Hold every job whose prompt contains `marker` (jobs not submitted yet). */
  holdPrompts = new Set<string>();

  probe() {
    return this.inner.probe();
  }
  capabilities() {
    return this.inner.capabilities();
  }
  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    this.ledger.spawns.push({ worker: this.tag, jobId: ctx.jobId, attemptId: ctx.attemptId });
    for (const marker of this.holdPrompts) if (ctx.job.prompt.includes(marker)) this.hold(ctx.jobId);
    for (const line of ctx.job.prompt.split('\n')) {
      const m = /^edit (\S+) (.*)$/.exec(line);
      if (m?.[1] !== undefined) await writeFile(join(ctx.workspaceRoot, m[1]), `${m[2] ?? ''}\n`);
    }
    const ref = await this.inner.spawn(ctx);
    this.#jobs.set(ref.sessionId, ctx.jobId);
    this.#signals.set(ref.sessionId, ctx.signal);
    return ref;
  }
  sendPrompt(ref: SessionRef, prompt: { text: string }) {
    return this.inner.sendPrompt(ref, prompt);
  }
  events(ref: SessionRef, cursor?: Parameters<FakeRuntimeAdapter['events']>[1]) {
    return this.inner.events(ref, cursor);
  }
  requestApproval(ref: SessionRef, d: Parameters<FakeRuntimeAdapter['requestApproval']>[1]) {
    return this.inner.requestApproval(ref, d);
  }
  cancel(ref: SessionRef) {
    const jobId = this.#jobs.get(ref.sessionId);
    if (jobId !== undefined) this.release(jobId);
    return this.inner.cancel(ref);
  }
  resume(ref: SessionRef, ctx: SpawnContext) {
    return this.inner.resume(ref, ctx);
  }
  async collectResult(ref: SessionRef): Promise<SessionResult> {
    const jobId = this.#jobs.get(ref.sessionId);
    const gate = jobId === undefined ? undefined : this.#gates.get(jobId);
    const signal = this.#signals.get(ref.sessionId);
    if (gate !== undefined) {
      // A killed/stopped worker aborts the attempt: the hold must not outlive it.
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          signal?.addEventListener('abort', () => {
            resolve();
          });
        }),
      ]);
    }
    return this.inner.collectResult(ref);
  }
  cleanup(ref: SessionRef) {
    return this.inner.cleanup(ref);
  }
  getCost(ref: SessionRef) {
    return this.inner.getCost(ref);
  }
}
