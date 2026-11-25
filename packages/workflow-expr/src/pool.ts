import { Worker } from 'node:worker_threads';
import { EXPR_LIMITS, type SandboxRequest, type SandboxResult } from './sandbox-worker.js';

/**
 * The sandbox pool (p14-workflow-engine §4.4): a small set of `node:worker_threads` threads with V8 resource limits.
 * Every request gets a hard deadline measured from the moment a thread takes it; when it passes, the main thread
 * terminates that thread (a catastrophic regex or a runaway loop cannot be interrupted any other way), answers
 * `expr_timeout` and starts a replacement. A thread that dies (out of memory) answers `expr_resource_limit`. The
 * caller's event loop is never blocked by user expressions: it only serialises the request and waits.
 */

export interface SandboxPoolOptions {
  /** Threads (default 2). */
  readonly threads?: number;
  /** Hard deadline per request (default 1000 ms; 250 ms failed simple expressions on a loaded 2-vCPU host). */
  readonly deadlineMs?: number;
  /** Pause before the one retry of a timed-out request (default 500 ms). */
  readonly retryDelayMs?: number;
  /** Requests waiting for a thread before `expr_busy` (default 1000). */
  readonly maxQueue?: number;
  readonly resourceLimits?: {
    readonly maxOldGenerationSizeMb: number;
    readonly maxYoungGenerationSizeMb: number;
    readonly stackSizeMb: number;
  };
  /** Enables the `spin` / `allocate` requests (tests only). */
  readonly testHooks?: boolean;
  /** Called when a thread is terminated or dies (metrics / logs). */
  readonly onTermination?: (reason: 'deadline' | 'crash') => void;
}

export const DEFAULT_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
} as const;

interface Task {
  readonly id: number;
  readonly req: SandboxRequest;
  readonly resolve: (r: SandboxResult) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  task: Task | null;
  timer: NodeJS.Timeout | null;
}

/** The worker entry next to this module: the compiled `.js` in production, the `.ts` source under the test runner. */
function entryUrl(): URL {
  const self = import.meta.url;
  return new URL(self.endsWith('.ts') ? './sandbox-worker.ts' : './sandbox-worker.js', self);
}

const fail = (code: string): SandboxResult => ({ ok: false, code, position: null });

export class SandboxPool {
  readonly #opts: Required<Omit<SandboxPoolOptions, 'onTermination'>> & {
    readonly onTermination: SandboxPoolOptions['onTermination'] | undefined;
  };
  readonly #slots: Slot[] = [];
  readonly #queue: Task[] = [];
  #nextId = 1;
  #closed = false;
  #terminations = 0;

  constructor(opts: SandboxPoolOptions = {}) {
    this.#opts = {
      threads: Math.max(1, Math.min(opts.threads ?? 2, 8)),
      deadlineMs: opts.deadlineMs ?? 1000,
      maxQueue: opts.maxQueue ?? 1000,
      retryDelayMs: opts.retryDelayMs ?? 500,
      resourceLimits: opts.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
      testHooks: opts.testHooks ?? false,
      onTermination: opts.onTermination,
    };
  }

  /** Threads terminated so far (deadline or crash). */
  get terminations(): number {
    return this.#terminations;
  }

  /**
   * Runs one request in the sandbox. Never rejects: failures are results with a code. A timeout is tried once more:
   * expressions are deterministic, so a second timeout is the expression's own, while a first one is often only a
   * busy host (CPU contention, a fresh thread's warm-up).
   */
  async run(req: SandboxRequest): Promise<SandboxResult> {
    const first = await this.#runOnce(req);
    if (first.ok || first.code !== 'expr_timeout' || this.#closed) return first;
    // The retry waits a moment: the load that slowed the first attempt (scheduled runs at the top of the hour, a
    // backup) is usually gone, and the replacement thread has warmed up.
    await new Promise((r) => setTimeout(r, this.#opts.retryDelayMs));
    return this.#runOnce(req);
  }

  #runOnce(req: SandboxRequest): Promise<SandboxResult> {
    if (this.#closed) return Promise.resolve(fail('expr_unavailable'));
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(req), 'utf8');
    } catch {
      return Promise.resolve(fail('expr_input_too_large'));
    }
    if (size > EXPR_LIMITS.maxInputBytes + 64 * 1024) return Promise.resolve(fail('expr_input_too_large'));
    if (this.#queue.length >= this.#opts.maxQueue) return Promise.resolve(fail('expr_busy'));
    this.#ensureSlots();
    return new Promise((resolve) => {
      this.#queue.push({ id: this.#nextId++, req, resolve });
      this.#pump();
    });
  }

  /** Stops every thread; pending requests answer `expr_unavailable`. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#queue.splice(0)) t.resolve(fail('expr_unavailable'));
    await Promise.all(
      this.#slots.splice(0).map(async (s) => {
        if (s.timer !== null) clearTimeout(s.timer);
        s.task?.resolve(fail('expr_unavailable'));
        await s.worker.terminate();
      }),
    );
  }

  #ensureSlots(): void {
    while (this.#slots.length < this.#opts.threads) this.#slots.push(this.#spawn());
  }

  #spawn(): Slot {
    const worker = new Worker(entryUrl(), {
      workerData: { remyralExprSandbox: true, testHooks: this.#opts.testHooks },
      resourceLimits: { ...this.#opts.resourceLimits },
      // No inherited environment: an expression thread never sees secrets from the master's environment.
      env: {},
      stdout: false,
      stderr: false,
    });
    worker.unref();
    const slot: Slot = { worker, ready: false, task: null, timer: null };
    worker.on('message', (msg: { ready?: boolean; id?: number; res?: SandboxResult }) => {
      if (msg.ready === true) {
        slot.ready = true;
        this.#pump();
        return;
      }
      const task = slot.task;
      if (task === null || msg.id !== task.id || msg.res === undefined) return;
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.timer = null;
      slot.task = null;
      task.resolve(msg.res);
      this.#pump();
    });
    const onDeath = (): void => {
      if (!this.#slots.includes(slot)) return;
      this.#replace(slot, 'crash');
    };
    worker.on('error', onDeath);
    worker.on('exit', onDeath);
    return slot;
  }

  #replace(slot: Slot, reason: 'deadline' | 'crash'): void {
    const i = this.#slots.indexOf(slot);
    if (i < 0) return;
    this.#slots.splice(i, 1);
    if (slot.timer !== null) clearTimeout(slot.timer);
    const task = slot.task;
    slot.task = null;
    this.#terminations++;
    this.#opts.onTermination?.(reason);
    task?.resolve(fail(reason === 'deadline' ? 'expr_timeout' : 'expr_resource_limit'));
    void slot.worker.terminate().catch(() => undefined);
    if (!this.#closed) {
      this.#ensureSlots();
      this.#pump();
    }
  }

  #pump(): void {
    for (const slot of this.#slots) {
      if (!slot.ready || slot.task !== null) continue;
      const task = this.#queue.shift();
      if (task === undefined) return;
      slot.task = task;
      slot.timer = setTimeout(() => {
        this.#replace(slot, 'deadline');
      }, this.#opts.deadlineMs);
      slot.timer.unref();
      slot.worker.postMessage({ id: task.id, req: task.req });
    }
  }
}
