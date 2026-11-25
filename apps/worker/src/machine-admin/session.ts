import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  type AdminOp,
  adminOpSummary,
  type AdminSessionGrant,
  MAX_ADMIN_OUTPUT,
  type MachineAdminDecisionPayload,
  type MachineAdminRequestPayload,
  type MachineAdminResultPayload,
  normalizeAdminPurpose,
} from '@remyral/protocol';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import {
  ADMIN_HEARTBEAT_MS,
  AdminCommandResult,
  type AdminCommandRequest,
  type AdminSessionRequest,
  AdminSessionStatus,
  brokerResultPath,
  brokerStatusPath,
  commandRequestDir,
  endMarkerPath,
  heartbeatPath,
  sessionDir,
  sessionRequestPath,
} from './shared.js';

/**
 * Worker side of one machine-admin job attempt (p5-machine-admin, ADR-0021): asks the root/SYSTEM helper for an
 * elevated session (the master's signed session grant, written into the worker's own data dir), and runs each
 * elevated operation the agent asks for through the master:
 *
 *   agent tool call → MACHINE_ADMIN_REQUEST → master (log, audit, approval or auto-approve)
 *     → MACHINE_ADMIN_DECISION granted (signed) | pending (→ APPROVAL_DECISION → ask again) | denied
 *     → request file for the broker → broker result (helper-owned dir) → MACHINE_ADMIN_RESULT → agent.
 *
 * Nothing runs elevated without the master's signature over exactly this operation; the worker cannot sign.
 * Output is redacted with the worker's redactor before it reaches the agent or the master.
 */

export interface AdminChannel {
  request(jobId: string, payload: MachineAdminRequestPayload): Promise<void>;
  result(jobId: string, payload: MachineAdminResultPayload): Promise<void>;
}

export interface AdminSessionDeps {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly installDir: string;
  readonly workerId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: () => number;
  readonly grant: AdminSessionGrant;
  readonly channel: AdminChannel;
  readonly redact: (s: string) => string;
  readonly logger: Logger;
  /** How long a human may take to decide a pending command (the job's approval timeout). */
  readonly approvalTimeoutMs: number;
  /** How long the master may take to answer a request (default 30 s). */
  readonly decisionTimeoutMs?: number;
  /** How long the helper may take to start the session (Windows task runs every minute; default 150 s). */
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AdminToolOutcome {
  readonly ok: boolean;
  /** What the agent sees (redacted, bounded). */
  readonly text: string;
}

type Waiter<T> = { resolve: (v: T) => void };

export class MachineAdminSession {
  readonly #d: AdminSessionDeps;
  readonly #log: Logger;
  readonly #decisions = new Map<string, Waiter<MachineAdminDecisionPayload>>();
  readonly #approvals = new Map<string, Waiter<'approve' | 'deny'>>();
  #heartbeat: NodeJS.Timeout | null = null;
  #ready: Promise<AdminSessionStatus> | null = null;
  #ended = false;
  /** A method, so a loop re-reads it after awaits (no stale narrowing). */
  #isEnded(): boolean {
    return this.#ended;
  }
  readonly startedAt = new Date().toISOString();
  /** What ran elevated in this session (for the machine memory summary at the end of the job). */
  readonly #history: { summary: string; state: string; exitCode: number | null }[] = [];
  /** One elevated command at a time (the broker runs them in order anyway). */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(d: AdminSessionDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'machine-admin', jobId: d.jobId });
  }

  get sessionId(): string {
    return this.#d.grant.sessionId;
  }

  get #attempt(): MachineAdminRequestPayload['attemptId'] {
    return this.#d.attemptId as MachineAdminRequestPayload['attemptId'];
  }

  #sleep(ms: number): Promise<void> {
    return this.#d.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));
  }

  /** Writes the session request for the helper and starts the heartbeat. */
  async start(): Promise<void> {
    const dir = commandRequestDir(this.#d.dataDir, this.sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.#touch();
    const req: AdminSessionRequest = {
      v: 1,
      workerId: this.#d.workerId,
      jobId: this.#d.jobId,
      attemptId: this.#d.attemptId,
      epoch: this.#d.epoch(),
      session: this.#d.grant,
    };
    await atomicWriteFile(this.#d.ops, sessionRequestPath(this.#d.dataDir), JSON.stringify(req), {
      mode: 0o600,
    });
    this.#heartbeat = setInterval(() => {
      void this.#touch().catch(() => undefined);
    }, ADMIN_HEARTBEAT_MS);
    this.#heartbeat.unref();
    this.#log.info('machine-admin session requested', { sessionId: this.sessionId });
  }

  async #touch(): Promise<void> {
    await writeFile(heartbeatPath(this.#d.dataDir, this.sessionId), new Date().toISOString(), {
      mode: 0o600,
    });
  }

  /** Waits until the helper reports the session ready (or refused). */
  #waitReady(): Promise<AdminSessionStatus> {
    this.#ready ??= (async () => {
      const deadline = Date.now() + (this.#d.readyTimeoutMs ?? 150_000);
      const file = brokerStatusPath(this.#d.installDir, this.sessionId);
      while (Date.now() < deadline && !this.#ended) {
        const s = await readJson(file, AdminSessionStatus);
        if (s !== null) return s;
        await this.#sleep(this.#d.pollMs ?? 500);
      }
      return {
        v: 1,
        sessionId: this.sessionId,
        state: 'refused',
        reason: 'helper_not_started',
        detail:
          'the root/SYSTEM helper did not start the session; is the installer kit of this release installed (RemyralWorkerAdmin task / remyral-worker-admin.path / com.remyral.worker.admin)?',
        updatedAt: new Date().toISOString(),
      };
    })();
    return this.#ready;
  }

  /** Routes a MACHINE_ADMIN_DECISION; false when it is not for this session. */
  onDecision(p: MachineAdminDecisionPayload): boolean {
    const w = this.#decisions.get(p.requestId);
    if (w === undefined) return false;
    this.#decisions.delete(p.requestId);
    w.resolve(p);
    return true;
  }

  /** Routes an APPROVAL_DECISION for a pending elevated command; false when it is not one. */
  onApproval(approvalId: string, decision: 'approve' | 'deny'): boolean {
    const w = this.#approvals.get(approvalId);
    if (w === undefined) return false;
    this.#approvals.delete(approvalId);
    w.resolve(decision);
    return true;
  }

  #ask(requestId: string, op: AdminOp, purpose: string | null): Promise<MachineAdminDecisionPayload | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#decisions.delete(requestId);
        resolve(null);
      }, this.#d.decisionTimeoutMs ?? 30_000);
      this.#decisions.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      void this.#d.channel
        .request(this.#d.jobId, {
          attemptId: this.#attempt,
          epoch: this.#d.epoch(),
          requestId,
          op,
          // p17-worker-1-1-1: the agent's purpose (unverified metadata; not in the digest the master signs).
          ...(purpose === null ? {} : { purpose }),
        })
        .catch((err: unknown) => {
          this.#log.warn('machine-admin request not sent', { requestId, err });
        });
    });
  }

  #awaitApproval(
    approvalId: string,
    signal: AbortSignal | undefined,
  ): Promise<'approve' | 'deny' | 'timeout'> {
    return new Promise((resolve) => {
      const done = (v: 'approve' | 'deny' | 'timeout') => {
        clearTimeout(timer);
        this.#approvals.delete(approvalId);
        resolve(v);
      };
      const timer = setTimeout(() => {
        done('timeout');
      }, this.#d.approvalTimeoutMs);
      signal?.addEventListener(
        'abort',
        () => {
          done('deny');
        },
        { once: true },
      );
      this.#approvals.set(approvalId, { resolve: done });
    });
  }

  /**
   * Runs one elevated operation for the agent. Never throws: every outcome is text for the agent. `purpose` is the
   * agent's own reason (p17-worker-1-1-1), redacted and normalised here, sent with the request and never signed.
   */
  run(op: AdminOp, signal?: AbortSignal, purpose?: string): Promise<AdminToolOutcome> {
    const p = normalizeAdminPurpose(purpose === undefined ? undefined : this.#d.redact(purpose));
    const next = this.#queue.then(() => this.#run(op, signal, p));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #run(
    op: AdminOp,
    signal: AbortSignal | undefined,
    purpose: string | null,
  ): Promise<AdminToolOutcome> {
    if (this.#ended) return { ok: false, text: 'The machine administration session has ended.' };
    const requestId = randomUUID();
    let decision = await this.#ask(requestId, op, purpose);
    if (decision === null) {
      return { ok: false, text: 'The master did not answer the request; the command did not run.' };
    }
    if (decision.state === 'pending') {
      const approvalId = decision.approvalId ?? requestId;
      this.#log.info('elevated command waits for a human approval', { requestId, approvalId });
      const verdict = await this.#awaitApproval(approvalId, signal);
      if (verdict !== 'approve') {
        return {
          ok: false,
          text:
            verdict === 'timeout'
              ? 'No human approved this command in time; it did not run.'
              : 'A human denied this command; it did not run. Do not retry it unchanged.',
        };
      }
      decision = await this.#ask(requestId, op, purpose);
      if (decision === null) return { ok: false, text: 'The master did not answer after the approval.' };
    }
    if (decision.state !== 'granted' || decision.grant === undefined) {
      return {
        ok: false,
        text: `The command was not allowed (${decision.reason ?? 'denied'}${decision.detail === undefined ? '' : `: ${decision.detail}`}).`,
      };
    }
    const ready = await this.#waitReady();
    if (ready.state !== 'ready') {
      const text = `The elevated session is not available (${ready.reason ?? ready.state}${ready.detail === undefined ? '' : `: ${ready.detail}`}).`;
      await this.#report(requestId, {
        state: 'refused',
        reason: ready.reason ?? 'session_unavailable',
        durationMs: 0,
        output: text,
        truncated: false,
      });
      return { ok: false, text };
    }
    const started = Date.now();
    const request: AdminCommandRequest = { v: 1, requestId, op, grant: decision.grant };
    await atomicWriteFile(
      this.#d.ops,
      join(commandRequestDir(this.#d.dataDir, this.sessionId), `${requestId}.json`),
      JSON.stringify(request),
      { mode: 0o600 },
    );
    const timeoutMs = (op.kind === 'exec' ? op.timeoutSec * 1000 : 60_000) + 60_000;
    const resultFile = brokerResultPath(this.#d.installDir, this.sessionId, requestId);
    let result: AdminCommandResult | null = null;
    while (Date.now() - started < timeoutMs && !this.#isEnded()) {
      result = await readJson(resultFile, AdminCommandResult);
      if (result !== null) break;
      await this.#sleep(this.#d.pollMs ?? 250);
    }
    if (result === null) {
      const text = 'The elevated broker did not return a result in time; the command may still be running.';
      await this.#report(requestId, {
        state: 'failed',
        reason: 'broker_timeout',
        durationMs: Date.now() - started,
        output: text,
        truncated: false,
      });
      return { ok: false, text };
    }
    const outcome = this.#render(op, result);
    await this.#report(requestId, {
      state: result.state,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.exitCode === undefined || result.exitCode === null ? {} : { exitCode: result.exitCode }),
      durationMs: result.durationMs,
      output: outcome.reported,
      truncated: result.truncated || outcome.cut,
      ...(result.file === undefined
        ? {}
        : {
            file: {
              path: result.file.path,
              bytes: result.file.bytes,
              sha256Before: result.file.sha256Before,
              sha256After: result.file.sha256After,
            },
          }),
    });
    if (this.#history.length < 200) {
      this.#history.push({
        summary: this.#d.redact(MachineAdminSession.summary(op)),
        state: result.state,
        exitCode: result.exitCode ?? null,
      });
    }
    this.#log.info('elevated command finished', {
      requestId,
      kind: op.kind,
      state: result.state,
      exitCode: result.exitCode ?? null,
    });
    return { ok: result.state === 'succeeded', text: outcome.agent };
  }

  #render(op: AdminOp, r: AdminCommandResult): { agent: string; reported: string; cut: boolean } {
    const redact = this.#d.redact;
    if (op.kind === 'read_file' && r.file?.content !== undefined && r.state === 'succeeded') {
      const text = redact(Buffer.from(r.file.content, 'base64').toString('utf8'));
      const cut = text.length > MAX_ADMIN_OUTPUT;
      return {
        agent: `${text}${r.truncated ? '\n[file truncated at maxBytes]' : ''}`,
        reported: cut ? text.slice(0, MAX_ADMIN_OUTPUT) : text,
        cut,
      };
    }
    const parts = [
      `state: ${r.state}${r.reason === undefined ? '' : ` (${r.reason})`}`,
      ...(r.exitCode === undefined || r.exitCode === null ? [] : [`exit code: ${String(r.exitCode)}`]),
      ...(r.file === undefined
        ? []
        : [`file: ${r.file.path} (${String(r.file.bytes)} bytes, sha256 ${r.file.sha256After ?? 'n/a'})`]),
      ...(r.stdout === '' ? [] : [`stdout:\n${redact(r.stdout)}`]),
      ...(r.stderr === '' ? [] : [`stderr:\n${redact(r.stderr)}`]),
      ...(r.truncated ? ['[output truncated]'] : []),
    ];
    const text = parts.join('\n');
    const cut = text.length > MAX_ADMIN_OUTPUT;
    return { agent: text, reported: cut ? text.slice(-MAX_ADMIN_OUTPUT) : text, cut };
  }

  async #report(
    requestId: string,
    r: Omit<MachineAdminResultPayload, 'attemptId' | 'epoch' | 'requestId'>,
  ): Promise<void> {
    await this.#d.channel
      .result(this.#d.jobId, {
        attemptId: this.#attempt,
        epoch: this.#d.epoch(),
        requestId,
        ...r,
        output: r.output.slice(-MAX_ADMIN_OUTPUT),
      })
      .catch((err: unknown) => {
        this.#log.warn('machine-admin result not sent', { requestId, err });
      });
  }

  /** Ends the session: end marker for the broker, heartbeat stopped, request files removed. */
  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    for (const w of this.#approvals.values()) w.resolve('deny');
    this.#approvals.clear();
    await writeFile(endMarkerPath(this.#d.dataDir, this.sessionId), new Date().toISOString(), {
      mode: 0o600,
    }).catch(() => undefined);
    await rm(sessionRequestPath(this.#d.dataDir), { force: true }).catch(() => undefined);
    // Give the broker a moment to see the end marker, then remove the request dir.
    setTimeout(() => {
      void rm(sessionDir(this.#d.dataDir, this.sessionId), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }, 10_000).unref();
    this.#log.info('machine-admin session ended', { sessionId: this.sessionId });
  }

  /**
   * A short, redacted summary of the elevated commands of this session for the machine's memory (null when nothing
   * ran). Every command is also in the master's command log; this is what later jobs read first.
   */
  memorySummary(): string | null {
    if (this.#history.length === 0) return null;
    const lines = this.#history
      .slice(0, 40)
      .map(
        (h) =>
          `  - ${h.state}${h.exitCode === null ? '' : ` (exit ${String(h.exitCode)})`}: ${h.summary.slice(0, 200)}`,
      );
    const more = this.#history.length > 40 ? [`  - … and ${String(this.#history.length - 40)} more`] : [];
    return [`Elevated commands of this job (${String(this.#history.length)}):`, ...lines, ...more].join('\n');
  }

  /** One line for logs and job events. */
  static summary(op: AdminOp): string {
    return adminOpSummary(op, 300);
  }
}

async function readJson<T>(
  file: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
