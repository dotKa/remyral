import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Capability,
  type CapabilityCheckResult,
  type CapabilityStatus,
  type RuntimeKind,
  type VerificationBudget,
} from '@remyral/protocol';
import type { AdapterCapability } from '../capabilities.js';
import type {
  AgentAdapter,
  ApprovalPolicy,
  ProbeResult,
  SequencedEvent,
  SessionRef,
  SessionResult,
  SpawnContext,
} from '../contract.js';
import { isTerminalEvent } from '../event-log.js';
import {
  assistantText,
  collectUntilStopped,
  cursorReplayProblem,
  eventSequenceProblem,
  usageTotals,
} from './assertions.js';
import { declaredStatuses } from './declared.js';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md §2): the capability scenario set the worker runs through the
 * **real** adapter when the owner presses "Doğrula", and the repository's tests run against the fake runtimes. One
 * scenario per capability; three short sessions carry them (the same checks as the contract kit and the credentialed
 * live tests, ADR-0008):
 *
 *  - session `task` (one-file task, every approval request approved by the verification):
 *      `streaming`       events gapless / ordered / one terminal `stopped`, an assistant message, cursor replay exact,
 *                        the task succeeded (contract "events are gapless…", live "one-prompt repo task")
 *      `approval`        an approval request was raised for the file write and the approve round-trip let the task
 *                        finish; the approved write happened (live "stream, approval")
 *      `cost_reporting`  usage events with tokens and a known provenance (live "usage")
 *      `artifacts`       the runtime's own diff names the file (live codex "diff")
 *  - `resume`            the same adapter resumes the stopped session on this worker; the resumed turn succeeds and
 *                        names the file (live "resume")
 *  - session `long` (a long shell command):
 *      `interactive_prompt` a follow-up is accepted while the run is active (contract "interactive_prompt")
 *      `cancel`          cancel ends it within `cancelMs` with a terminal `stopped`, outcome cancelled, a second cancel
 *                        is `already-stopped` (contract "cancel ends a running session…", live "cancel mid-tool")
 *      `safe_cancel`     the long command's process is gone within the grace period (live "no orphan process")
 *
 * A capability the adapter declares `unsupported` is `skipped` with that reason. Time and token budget: once either is
 * reached (or the run is cancelled) the running session is stopped and every capability not yet decided is `skipped`
 * — never `failed` and never `passed`.
 */

export type VerificationSession = 'task' | 'long';

export interface VerificationPrompts {
  /** A one-file task that needs an approval (file write). */
  readonly task: string;
  /** Sent to the resumed session. */
  readonly resume: string;
  /** A long shell command that runs until cancelled. */
  readonly long: string;
  /** Follow-up sent while the long run is active. */
  readonly followUp: string;
  /** File the task creates in the workspace (checked on disk and in the diff); null: not checked (scripted fakes). */
  readonly expectFile: string | null;
  /** Text the resumed turn must contain; null: only that it succeeds. */
  readonly expectResumeText: string | null;
  /** Command line of the long command's process (safe_cancel looks for it); null: not checked. */
  readonly longMarker: string | null;
}

/** The prompts for a real model (as the live tests send them); `seconds` makes the long command unique per run. */
export function defaultVerificationPrompts(
  platform: NodeJS.Platform = process.platform,
  seconds: number = 170 + Math.floor(Math.random() * 30),
): VerificationPrompts {
  const s = String(seconds);
  const windows = platform === 'win32';
  const command = windows ? `powershell -NoProfile -Command "Start-Sleep -Seconds ${s}"` : `sleep ${s}`;
  return {
    task: 'Create a file named hello.txt in the current directory containing exactly the word hi. Then reply with DONE.',
    resume: 'What is the name of the file you created? Reply with the file name only.',
    long: `Use your shell tool to run exactly this command and wait for it to finish: ${command}. Then reply DONE.`,
    followUp: 'When the command has finished, also reply with the word OK.',
    expectFile: 'hello.txt',
    expectResumeText: 'hello.txt',
    longMarker: windows ? `Start-Sleep -Seconds ${s}` : `sleep ${s}`,
  };
}

/** Approval policy per runtime (the live tests': Codex asks for everything, the others for sensitive actions). */
export const VERIFICATION_APPROVAL_POLICY: Readonly<Record<RuntimeKind, ApprovalPolicy>> = {
  'claude-code': 'ask-sensitive',
  codex: 'ask-all',
  pi: 'ask-sensitive',
  opencode: 'ask-sensitive',
};

export type StoppedBy = 'time_budget' | 'token_budget' | 'cancelled' | 'error';

export interface VerificationOptions {
  readonly runtime: RuntimeKind;
  /** A fresh adapter per session (`task` also serves the resume). The worker: `registry.createForAttempt`. */
  readonly adapter: (session: VerificationSession) => AgentAdapter | Promise<AgentAdapter>;
  /**
   * The spawn context of a session — the worker builds it like a job's (confiner, configured auth, timeouts) and must
   * set `allowUnverified: true` (verifying unverified capabilities is the point) and `signal`.
   */
  readonly context: (
    session: VerificationSession,
    input: { readonly signal: AbortSignal; readonly approvalPolicy: ApprovalPolicy },
  ) => SpawnContext | Promise<SpawnContext>;
  /** Absolute path of the throw-away repository (the task's file is looked for here). */
  readonly workspace: string;
  readonly budget: VerificationBudget;
  readonly prompts?: Partial<VerificationPrompts>;
  /** The adapter's declared table (default: `declaredStatuses(runtime)`). */
  readonly declared?: Readonly<Partial<Record<AdapterCapability, CapabilityStatus>>>;
  readonly approvalPolicy?: ApprovalPolicy;
  /** External stop (`ops.cancel` of the operation). */
  readonly signal?: AbortSignal;
  /** Each decided capability (live progress in the panel). */
  readonly onProgress?: (step: string, results: readonly CapabilityCheckResult[]) => void;
  /** Command lines of the machine's processes (safe_cancel); null when they cannot be read. Default: ps / CIM. */
  readonly processes?: () => Promise<readonly string[] | null>;
  /** Upper bound per session wait (default 240 s; never longer than the remaining time budget). */
  readonly sessionTimeoutMs?: number;
  /** Scheduling slack on top of `cancelMs` (default 1 s). */
  readonly cancelSlackMs?: number;
  /** Wait after the long command started before cancelling (default 3 s, live tests). */
  readonly settleMs?: number;
  readonly now?: () => number;
}

export interface VerificationRun {
  /** One result per capability, in protocol order. */
  readonly results: CapabilityCheckResult[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number };
  readonly stoppedBy?: StoppedBy;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** The task adapter's probe (version, OS/arch as the adapter saw them). */
  readonly probe: ProbeResult | null;
}

const REASON_MAX = 300;

function text(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
}

/** Default process listing: POSIX `ps`, Windows CIM. Null when it cannot be read. */
export function listProcesses(
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[] | null> {
  const [cmd, args] =
    platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
          ],
        ]
      : ['ps', ['-A', '-o', 'command=']];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      resolve(stdout.split(/\r?\n/));
    });
  });
}

/**
 * Resolves after `ms` or when `signal` aborts, whichever comes first. The abort listener is removed when the timer
 * fires (the long session's `waitFor` sleeps every 100 ms on the run's one stop signal; a listener per sleep would
 * pile up for the whole run).
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Races `work` against a timeout; the timer is cleared as soon as either side settles (a losing 60 s timer would keep
 * the process busy and fire into a finished run).
 */
export async function raceTimeout<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  const timeout = new AbortController();
  const waiter = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
  try {
    return await Promise.race([
      work,
      abortableSleep(ms, waiter).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

const sleep = abortableSleep;

/** Runs the scenario set. Never throws: every problem is a capability result. */
export async function runCapabilityVerification(o: VerificationOptions): Promise<VerificationRun> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const prompts: VerificationPrompts = { ...defaultVerificationPrompts(), ...o.prompts };
  const declared = { ...declaredStatuses(o.runtime), ...o.declared };
  const approvalPolicy = o.approvalPolicy ?? VERIFICATION_APPROVAL_POLICY[o.runtime];
  const slack = o.cancelSlackMs ?? 1_000;
  const settle = o.settleMs ?? 3_000;
  const deadline = t0 + o.budget.maxDurationSec * 1000;
  const results = new Map<Capability, CapabilityCheckResult>();
  /** Capabilities decided at or after the stop: only their failures may be the stop's doing. */
  const afterStop = new Set<Capability>();
  const tokens = { inputTokens: 0, outputTokens: 0, costUsd: undefined as number | undefined };
  let probe: ProbeResult | null = null;

  // One stop for the whole run: the time budget, the token budget, an external cancel.
  const stop = new AbortController();
  let stoppedBy: StoppedBy | undefined;
  /** Read through a function: the stop happens asynchronously (timer, usage events, the external signal). */
  const stopped = () => stop.signal.aborted;
  const halt = (why: StoppedBy) => {
    if (stop.signal.aborted) return;
    stoppedBy = why;
    stop.abort();
  };
  const timer = setTimeout(
    () => {
      halt('time_budget');
    },
    Math.max(0, deadline - now()),
  );
  const external = () => {
    halt('cancelled');
  };
  if (o.signal?.aborted === true) halt('cancelled');
  o.signal?.addEventListener('abort', external, { once: true });

  const remaining = () => Math.max(1_000, Math.min(o.sessionTimeoutMs ?? 240_000, deadline - now()));
  const count = (e: SequencedEvent) => {
    checkDeadline();
    if (e.event.kind !== 'usage') return;
    tokens.inputTokens += e.event.inputTokens ?? 0;
    tokens.outputTokens += e.event.outputTokens ?? 0;
    if (e.event.costUsd !== undefined) tokens.costUsd = (tokens.costUsd ?? 0) + e.event.costUsd;
    if (tokens.inputTokens + tokens.outputTokens >= o.budget.maxTokens) halt('token_budget');
  };
  /** The deadline is also checked against `now()` at every step (the timer alone misses an injected clock). */
  const checkDeadline = () => {
    if (now() >= deadline) halt('time_budget');
  };
  const progress = (step: string) => {
    o.onProgress?.(
      step,
      Capability.options.flatMap((c) => results.get(c) ?? []),
    );
    checkDeadline();
  };
  const record = (
    capability: Capability,
    status: CapabilityCheckResult['status'],
    reason: string,
    since: number,
  ) => {
    if (results.has(capability)) return;
    checkDeadline();
    if (stop.signal.aborted) afterStop.add(capability);
    results.set(capability, {
      capability,
      status,
      reason: reason.slice(0, REASON_MAX),
      durationMs: Math.max(0, Math.round(now() - since)),
    });
    progress(capability);
  };
  /** Declared unsupported: skipped with the adapter's own word, nothing runs. */
  const declaredOut = (capability: Capability): boolean => {
    const d = declared[capability];
    if (d === 'supported' || d === 'degraded') return false;
    record(capability, 'skipped', `the adapter declares ${capability} ${d}; nothing to verify`, now());
    return true;
  };
  /**
   * After a session: a failure caused by the stop (recorded at or after it) becomes `skipped` — it was not proven either
   * way. A failure recorded before the stop is a real result and stays `failed` (it must revoke an older pass).
   */
  const settleStopped = (caps: readonly Capability[], since: number) => {
    for (const c of caps) {
      const r = results.get(c);
      if (r === undefined && stoppedBy === undefined) continue;
      if (r === undefined || (r.status === 'failed' && stoppedBy !== undefined && afterStop.has(c))) {
        results.delete(c);
        record(c, 'skipped', stopReason(stoppedBy), since);
      }
    }
  };
  const fail = (caps: readonly Capability[], err: unknown, since: number) => {
    for (const c of caps) if (!results.has(c)) record(c, 'failed', `session error: ${text(err)}`, since);
  };
  const exists = (file: string) => existsSync(join(o.workspace, file));

  // ---------------------------------------------------------------- session `task` (+ resume on the same adapter)
  const taskCaps: Capability[] = ['streaming', 'approval', 'cost_reporting', 'artifacts', 'resume'];
  let since = now();
  let task: { adapter: AgentAdapter; refs: SessionRef[] } | null = null;
  try {
    if (stop.signal.aborted) throw new Error('stopped before the task session');
    progress('task');
    const a = await o.adapter('task');
    probe = await a.probe();
    const ctx = await o.context('task', { signal: stop.signal, approvalPolicy });
    const ref = await a.spawn(ctx);
    task = { adapter: a, refs: [ref] };
    await a.sendPrompt(ref, { text: prompts.task });
    const approved = { count: 0, error: null as string | null };
    /** The verification plays the human reviewer: every request of its own sessions is approved. */
    const approver = (on: SessionRef) => async (e: SequencedEvent) => {
      count(e);
      if (e.event.kind !== 'approval_request') return;
      try {
        await a.requestApproval(on, {
          approvalId: e.event.approvalId,
          decision: 'approve',
          decidedBy: 'runtime-verification',
        });
        if (on === ref) approved.count += 1;
      } catch (err) {
        if (on === ref) approved.error = text(err);
      }
    };
    const events = await collectUntilStopped(a, ref, remaining(), undefined, approver(ref));
    const result: SessionResult = await a.collectResult(ref);
    const succeeded =
      result.outcome === 'succeeded'
        ? null
        : `the task ended ${result.outcome}${result.errorCode === undefined ? '' : ` (${result.errorCode})`}`;

    // streaming
    const seq = eventSequenceProblem(events);
    const message = events.some((e) => e.event.kind === 'message' && e.event.role === 'assistant')
      ? null
      : 'no assistant message was streamed';
    const replay = seq === null ? await cursorReplayProblem(a, ref, events, remaining()) : null;
    const streamProblem = seq ?? message ?? replay ?? succeeded;
    record(
      'streaming',
      streamProblem === null ? 'passed' : 'failed',
      streamProblem ?? `${String(events.length)} events in order, replay from a cursor exact`,
      since,
    );

    // approval
    if (!declaredOut('approval')) {
      const problem =
        approved.error !== null
          ? `the approval could not be delivered: ${approved.error}`
          : approved.count === 0
            ? `no approval request was raised for the file write (${approvalPolicy})`
            : (succeeded ??
              (prompts.expectFile !== null && !exists(prompts.expectFile)
                ? `the approved write did not happen (${prompts.expectFile} missing)`
                : null));
      record(
        'approval',
        problem === null ? 'passed' : 'failed',
        problem ?? `${String(approved.count)} approval request(s) round-tripped; the approved action ran`,
        since,
      );
    }

    // cost_reporting
    if (!declaredOut('cost_reporting')) {
      const u = usageTotals(events);
      const known = events.some((e) => e.event.kind === 'usage' && e.event.provenance !== 'unknown');
      const problem =
        u.events === 0
          ? 'no usage event was reported'
          : u.inputTokens + u.outputTokens === 0
            ? 'usage events carried no tokens'
            : !known
              ? 'usage was reported with unknown provenance'
              : null;
      record(
        'cost_reporting',
        problem === null ? 'passed' : 'failed',
        problem ??
          `${String(u.inputTokens)} input / ${String(u.outputTokens)} output tokens reported${
            u.costUsd === undefined ? '' : `, cost ${u.costUsd.toFixed(4)} USD`
          }`,
        since,
      );
    }

    // artifacts
    if (!declaredOut('artifacts')) {
      const diff = result.diff ?? '';
      const problem =
        diff === ''
          ? 'the runtime reported no diff'
          : prompts.expectFile !== null && !diff.includes(prompts.expectFile)
            ? `the runtime's diff does not name ${prompts.expectFile}`
            : null;
      record(
        'artifacts',
        problem === null ? 'passed' : 'failed',
        problem ?? 'the runtime reported the diff',
        since,
      );
    }

    // resume (same worker, same adapter)
    since = now();
    if (!declaredOut('resume')) {
      if (stopped()) throw new Error('stopped before resume');
      progress('resume');
      const resumed = await a.resume(ref, await o.context('task', { signal: stop.signal, approvalPolicy }));
      task.refs.push(resumed);
      await a.sendPrompt(resumed, { text: prompts.resume });
      const more = await collectUntilStopped(a, resumed, remaining(), undefined, approver(resumed));
      const r2 = await a.collectResult(resumed);
      const problem =
        r2.outcome !== 'succeeded'
          ? `the resumed turn ended ${r2.outcome}`
          : prompts.expectResumeText !== null && !assistantText(more).includes(prompts.expectResumeText)
            ? `the resumed turn did not remember the first one (no "${prompts.expectResumeText}")`
            : null;
      record(
        'resume',
        problem === null ? 'passed' : 'failed',
        problem ?? 'the session resumed on this worker and remembered the first turn',
        since,
      );
    }
  } catch (err) {
    if (stoppedBy === undefined) fail(taskCaps, err, since);
  } finally {
    if (task !== null) {
      for (const ref of task.refs.reverse()) await task.adapter.cleanup(ref).catch(() => undefined);
    }
    settleStopped(taskCaps, since);
  }

  // ---------------------------------------------------------------- session `long`
  const longCaps: Capability[] = ['interactive_prompt', 'cancel', 'safe_cancel'];
  since = now();
  let long: { adapter: AgentAdapter; ref: SessionRef } | null = null;
  try {
    if (stop.signal.aborted) throw new Error('stopped before the long session');
    progress('long');
    const b = await o.adapter('long');
    const p = await b.probe();
    probe ??= p;
    const ctx = await o.context('long', { signal: stop.signal, approvalPolicy });
    const ref = await b.spawn(ctx);
    long = { adapter: b, ref };
    await b.sendPrompt(ref, { text: prompts.long });
    let running = false;
    let tool = false;
    const seen: SequencedEvent[] = [];
    const pump = (async () => {
      for await (const e of b.events(
        ref,
        undefined,
        AbortSignal.timeout(remaining() + ctx.timeouts.cancelMs),
      )) {
        seen.push(e);
        count(e);
        if (e.event.kind === 'status' && e.event.phase === 'running') running = true;
        if (e.event.kind === 'tool_call') tool = true;
        if (e.event.kind === 'approval_request') {
          await b
            .requestApproval(ref, {
              approvalId: e.event.approvalId,
              decision: 'approve',
              decidedBy: 'runtime-verification',
            })
            .catch(() => undefined);
        }
        if (isTerminalEvent(e.event)) return;
      }
    })().catch(() => undefined);
    const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
      const until = now() + ms;
      while (!pred() && now() < until && !stop.signal.aborted) await sleep(100, stop.signal);
      return pred();
    };
    if (!(await waitFor(() => running, remaining()))) throw new Error('the long run never reported running');

    // interactive_prompt
    if (!declaredOut('interactive_prompt')) {
      const t = now();
      try {
        await raceTimeout(
          b.sendPrompt(ref, { text: prompts.followUp }),
          Math.min(60_000, remaining()),
          stop.signal,
          'the follow-up was not accepted within 60 s',
        );
        record('interactive_prompt', 'passed', 'a follow-up was accepted while the run was active', t);
      } catch (err) {
        record('interactive_prompt', 'failed', `the follow-up was refused: ${text(err)}`, t);
      }
    }

    // The long command must be running before cancel (safe_cancel has something to reap).
    const started = await waitFor(() => tool, Math.min(120_000, remaining()));
    if (started) await sleep(settle, stop.signal);
    if (stopped()) throw new Error('stopped before cancel');

    // cancel
    const tc = now();
    const outcome = await b.cancel(ref, 'runtime verification');
    const elapsed = now() - tc;
    await pump;
    const result = await b.collectResult(ref).catch(() => null);
    const again = await b.cancel(ref).catch(() => null);
    const last = seen.at(-1)?.event;
    const cancelProblem =
      elapsed > ctx.timeouts.cancelMs + slack
        ? `cancel took ${String(Math.round(elapsed))} ms (limit ${String(ctx.timeouts.cancelMs)} ms)`
        : outcome.mode !== 'graceful' && outcome.mode !== 'forced'
          ? `cancel reported ${outcome.mode}`
          : last?.kind !== 'status' || last.phase !== 'stopped'
            ? 'no terminal stopped status after cancel'
            : result?.outcome !== 'cancelled'
              ? `the run ended ${result?.outcome ?? 'unknown'} instead of cancelled`
              : again?.mode !== 'already-stopped'
                ? 'a second cancel was not idempotent'
                : null;
    record(
      'cancel',
      cancelProblem === null ? 'passed' : 'failed',
      cancelProblem ?? `${outcome.mode} cancel in ${String(Math.round(elapsed))} ms`,
      tc,
    );

    // safe_cancel
    if (!declaredOut('safe_cancel')) {
      const marker = prompts.longMarker;
      if (!started) {
        record('safe_cancel', 'failed', 'the agent did not start the long command; nothing to reap', tc);
      } else if (marker === null) {
        record('safe_cancel', 'skipped', 'no process marker for this platform', tc);
      } else {
        const list = o.processes ?? (() => listProcesses());
        const until = now() + ctx.timeouts.cancelGraceMs;
        let alive: boolean | null = null;
        for (;;) {
          const ps = await list();
          alive = ps === null ? null : ps.some((line) => line.includes(marker));
          if (alive !== true || now() >= until) break;
          await sleep(200);
        }
        if (alive === null) record('safe_cancel', 'skipped', 'the process list could not be read here', tc);
        else
          record(
            'safe_cancel',
            alive ? 'failed' : 'passed',
            alive
              ? `"${marker}" still runs ${String(ctx.timeouts.cancelGraceMs)} ms after cancel`
              : 'no process of the long command is left after cancel',
            tc,
          );
      }
    }
  } catch (err) {
    if (stoppedBy === undefined) fail(longCaps, err, since);
  } finally {
    if (long !== null) {
      await long.adapter.cancel(long.ref).catch(() => undefined);
      await long.adapter.cleanup(long.ref).catch(() => undefined);
    }
    settleStopped(longCaps, since);
  }

  clearTimeout(timer);
  o.signal?.removeEventListener('abort', external);
  for (const c of Capability.options) {
    if (!results.has(c)) record(c, 'skipped', stopReason(stoppedBy), now());
  }
  const t1 = now();
  return {
    results: Capability.options.flatMap((c) => results.get(c) ?? []),
    usage: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      ...(tokens.costUsd === undefined ? {} : { costUsd: tokens.costUsd }),
    },
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    startedAt,
    finishedAt: new Date(t1).toISOString(),
    durationMs: Math.max(0, Math.round(t1 - t0)),
    probe,
  };
}

function stopReason(by: StoppedBy | undefined): string {
  switch (by) {
    case 'time_budget':
      return 'not proven: the time budget ran out before this check finished';
    case 'token_budget':
      return 'not proven: the token budget was reached before this check finished';
    case 'cancelled':
      return 'not proven: the verification was cancelled';
    default:
      return 'not run';
  }
}
