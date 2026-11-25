/**
 * p10-approval-pause (docs/design/p10-approval-pause.md §8): the attempt's run-time budget (`limits.maxDurationSec`).
 *
 * Unlike a plain timeout it does not count the time the runtime waits for a human approval: the clock stops while at
 * least one approval is pending (from the runtime's `approval_request` until its decision arrives, or until the runtime
 * moves on with another tool call / result / message) and runs again afterwards. A resumed attempt starts with the run
 * time it already used before it was paused (`execution.resume.activeMs`). When the remaining budget reaches zero,
 * `onExpired` runs once.
 *
 * p20-job-clock (docs/design/p20-job-clock.md): a question to a person (`ask_user` / `wait_for_answer` blocked on the
 * answer) stops the clock the same way (`holdStarted` / `holdEnded`). A question hold is not cleared when the runtime
 * moves on (other tool events may arrive while the question tool blocks); it ends when that tool call returns. The
 * waits are accumulated apart (approvals, questions) and reported with the budget (`report()`).
 */
export interface RunClockOptions {
  /** The whole budget of the attempt (ms). */
  readonly budgetMs: number;
  /** Already used before this run (a resumed attempt). Default 0. */
  readonly usedMs?: number;
  readonly onExpired: () => void;
  /** Injectable for tests (default `Date.now`). */
  readonly now?: () => number;
}

export class RunClock {
  #budgetMs: number;
  readonly #onExpired: () => void;
  readonly #now: () => number;
  /** Active time accumulated in finished running stretches. */
  #accumMs: number;
  /** Start of the current running stretch (null: stopped or waiting). */
  #since: number | null = null;
  readonly #pending = new Set<string>();
  /** p20-job-clock: question waits (key per blocked question tool call). */
  readonly #holds = new Set<string>();
  #approvalWaitMs = 0;
  #approvalSince: number | null = null;
  #questionWaitMs = 0;
  #questionSince: number | null = null;
  /** p20-job-clock: when the runtime last did something (null: nothing yet). */
  #lastActivity: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #started = false;
  #stopped = false;
  #expired = false;

  constructor(opts: RunClockOptions) {
    this.#budgetMs = Math.max(0, opts.budgetMs);
    this.#accumMs = Math.max(0, opts.usedMs ?? 0);
    this.#onExpired = opts.onExpired;
    this.#now = opts.now ?? Date.now;
  }

  /** Starts counting (idempotent). */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#run();
  }

  /** The runtime asked for an approval: the clock stops until it is answered. */
  waitStarted(approvalId: string): void {
    if (this.#stopped) return;
    if (this.#pending.size === 0) this.#approvalSince = this.#now();
    this.#pending.add(approvalId);
    this.#pause();
  }

  /** The decision for `approvalId` was delivered. */
  waitEnded(approvalId: string): void {
    if (!this.#pending.delete(approvalId)) return;
    if (this.#pending.size === 0) {
      this.#endApprovalWait();
      this.#run();
    }
  }

  /** The runtime moved on (tool call, tool result, message): no approval is pending any more. */
  waitsCleared(): void {
    if (this.#pending.size === 0) return;
    this.#pending.clear();
    this.#endApprovalWait();
    this.#run();
  }

  /** p20-job-clock: a question tool call blocks on a person's answer: the clock stops until `holdEnded(key)`. */
  holdStarted(key: string): void {
    if (this.#stopped || this.#holds.has(key)) return;
    if (this.#holds.size === 0) this.#questionSince = this.#now();
    this.#holds.add(key);
    this.#pause();
  }

  /** p20-job-clock: the question tool call `key` returned (answered, expired, gave up waiting, job ending). */
  holdEnded(key: string): void {
    if (!this.#holds.delete(key)) return;
    if (this.#holds.size === 0) {
      this.#endQuestionWait();
      this.#run();
    }
  }

  /** p20-job-clock: the runtime did something (tool call, tool result, message) — the "progress" signal. */
  touch(): void {
    this.#lastActivity = this.#now();
  }

  /** True while the clock is stopped for an approval or a question. */
  get waiting(): boolean {
    return this.#pending.size > 0 || this.#holds.size > 0;
  }

  /** p20-job-clock: what the clock waits for now (an approval wins when both are open). */
  waitingFor(): 'approval' | 'question' | null {
    if (this.#pending.size > 0) return 'approval';
    return this.#holds.size > 0 ? 'question' : null;
  }

  /** p20-job-clock: approval and question waits so far (ms; an open wait counts up to now). */
  waitsMs(): { approvalMs: number; questionMs: number } {
    const now = this.#now();
    return {
      approvalMs:
        this.#approvalWaitMs + (this.#approvalSince === null ? 0 : Math.max(0, now - this.#approvalSince)),
      questionMs:
        this.#questionWaitMs + (this.#questionSince === null ? 0 : Math.max(0, now - this.#questionSince)),
    };
  }

  /** p20-job-clock: the report for HEARTBEAT `runningJobs[].clock` / JOB_RESULT `clock` (whole seconds, bounded). */
  report(): {
    budgetSec: number;
    activeSec: number;
    remainingSec: number;
    approvalWaitSec: number;
    questionWaitSec: number;
    waiting: 'approval' | 'question' | null;
    idleSec: number | null;
  } {
    const w = this.waitsMs();
    const sec = (ms: number, max: number): number => Math.min(max, Math.max(0, Math.round(ms / 1000)));
    const cap = 7 * 24 * 3600;
    return {
      budgetSec: sec(this.#budgetMs, cap),
      activeSec: sec(this.activeMs(), cap * 2),
      remainingSec: sec(this.remainingMs(), cap),
      approvalWaitSec: sec(w.approvalMs, cap * 4),
      questionWaitSec: sec(w.questionMs, cap * 4),
      waiting: this.waitingFor(),
      idleSec: this.#lastActivity === null ? null : sec(this.#now() - this.#lastActivity, cap * 4),
    };
  }

  /** Active run time so far (ms), not counting approval waits; includes the `usedMs` of earlier runs. */
  activeMs(): number {
    return this.#accumMs + (this.#since === null ? 0 : Math.max(0, this.#now() - this.#since));
  }

  /**
   * p15-autonomy: a new budget for the running attempt (SET_TIME_LIMIT). The time already used stays; a budget that is
   * already used up ends the run at once (`onExpired`), like reaching the old limit. Returns the budget left (ms).
   */
  setBudget(budgetMs: number): number {
    this.#budgetMs = Math.max(0, budgetMs);
    if (this.#started && !this.#stopped && !this.#expired && this.#since !== null) this.#arm();
    return this.remainingMs();
  }

  /** Budget left (ms, ≥ 0). */
  remainingMs(): number {
    return Math.max(0, this.#budgetMs - this.activeMs());
  }

  /** Stops the clock for good (run ended); `activeMs()` stays readable. */
  stop(): void {
    if (this.#stopped) return;
    this.#pause();
    this.#endApprovalWait();
    this.#endQuestionWait();
    this.#stopped = true;
  }

  #endApprovalWait(): void {
    if (this.#approvalSince === null) return;
    this.#approvalWaitMs += Math.max(0, this.#now() - this.#approvalSince);
    this.#approvalSince = null;
  }

  #endQuestionWait(): void {
    if (this.#questionSince === null) return;
    this.#questionWaitMs += Math.max(0, this.#now() - this.#questionSince);
    this.#questionSince = null;
  }

  #run(): void {
    if (!this.#started || this.#stopped || this.#expired || this.waiting) return;
    if (this.#since === null) this.#since = this.#now();
    this.#arm();
  }

  #pause(): void {
    if (this.#since !== null) {
      this.#accumMs += Math.max(0, this.#now() - this.#since);
      this.#since = null;
    }
    this.#clear();
  }

  #arm(): void {
    this.#clear();
    const left = this.remainingMs();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#stopped || this.#expired || this.waiting) return;
      // Timers may fire a little early or late; re-check against the clock.
      if (this.remainingMs() > 0) {
        this.#arm();
        return;
      }
      this.#expired = true;
      this.#pause();
      this.#onExpired();
    }, left);
    this.#timer.unref();
  }

  #clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
