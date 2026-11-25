/**
 * Fixture-driven stand-in for `@anthropic-ai/claude-agent-sdk@0.3.296`'s
 * `query()`. It reproduces the SDK behaviour the adapter depends on, as
 * documented in sdk.d.ts: streaming input, one `system/init` before the first
 * turn, assistant/user/result messages per turn, `canUseTool` before a tool
 * that needs permission, `interrupt()` ending the running turn with an
 * `error_during_execution` result, the CLI exiting once input ends, and
 * `close()` killing the CLI. The CLI process itself is real: the fake starts
 * `fake-claude-cli.mjs` through `options.spawnClaudeCodeProcess`, so process
 * ownership, confinement and tree reaping are exercised for real.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeQueryLike, ClaudeSdkPort } from '../../../src/index.js';
import {
  assistantText,
  assistantToolUse,
  initMessage,
  resultInterrupted,
  resultSuccess,
  userToolResult,
  type CumulativeUsage,
} from './sdk-messages.js';

export const FAKE_CLI = fileURLToPath(new URL('./fake-claude-cli.mjs', import.meta.url));

export type FakeTurnStep =
  | { readonly kind: 'message'; readonly build: (sessionId: string) => SDKMessage }
  /** A tool call that needs permission: `canUseTool` is awaited, then a tool result follows. */
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  /** A tool call that runs until interrupted/closed. */
  | { readonly kind: 'block'; readonly ms: number }
  /** The CLI dies: the message stream throws (what the SDK does when the process exits mid-turn). */
  | { readonly kind: 'crash'; readonly message: string };

export type FakeTurnScript = (prompt: string, turn: number) => readonly FakeTurnStep[];

export const basicTurn: FakeTurnScript = (prompt) => [
  { kind: 'message', build: (sid) => assistantText(sid, `ack: ${prompt.slice(0, 40)}`) },
  {
    kind: 'message',
    build: (sid) => assistantToolUse(sid, 'toolu_read_1', 'Read', { file_path: 'README.md' }),
  },
  { kind: 'message', build: (sid) => userToolResult(sid, 'toolu_read_1', '12 lines') },
  { kind: 'message', build: (sid) => assistantText(sid, 'done') },
];

export const longTurn: FakeTurnScript = () => [
  { kind: 'message', build: (sid) => assistantText(sid, 'working') },
  {
    kind: 'message',
    build: (sid) => assistantToolUse(sid, 'toolu_bash_1', 'Bash', { command: 'sleep 600' }),
  },
  { kind: 'block', ms: 60_000 },
];

export const approvalTurn: FakeTurnScript = () => [
  { kind: 'message', build: (sid) => assistantText(sid, 'need to push') },
  { kind: 'tool', id: 'toolu_push_1', name: 'Bash', input: { command: 'git push origin work' } },
  { kind: 'message', build: (sid) => assistantText(sid, 'finished') },
];

export interface FakeSdkOptions {
  readonly script: FakeTurnScript;
  /** Usage added per turn (cumulative totals are reported, as the SDK does). */
  readonly perTurn?: CumulativeUsage;
  /** Permission mode reported in system/init; default = the requested one. */
  readonly reportedPermissionMode?: PermissionMode;
  /** Make interrupt() hang (forces the adapter's forced path). */
  readonly ignoreInterrupt?: boolean;
  /**
   * p5-live-fixes-2: like the real CLI, prompts not yet started are dropped when the input ends (stdin EOF
   * while a turn runs). Default false (every received prompt runs).
   */
  readonly dropQueuedOnInputEnd?: boolean;
  /** p5-live-fixes-2: stamp `user_message_uuid(s)` on a turn's first assistant message, as newer CLIs do. */
  readonly echoUserMessageUuids?: boolean;
  /** p6-approval-mode-switch: make `setPermissionMode` reject (a CLI that refuses the switch). */
  readonly refuseSetPermissionMode?: boolean;
  /**
   * p22-runtime-diagnostics: the CLI dies during start-up — killed with `signal` (default SIGKILL) and
   * `initializationResult()` rejects with `message`, the way the real SDK reports a CLI that exited before init.
   */
  readonly failInit?: { readonly message: string; readonly signal?: NodeJS.Signals };
}

/** Records what the adapter passed to `query()` (assertions on options). */
export interface FakeSdkCall {
  readonly options: Options;
}

export class FakeClaudeSdk implements ClaudeSdkPort {
  readonly calls: FakeSdkCall[] = [];
  readonly queries: FakeQuery[] = [];

  constructor(private readonly opts: FakeSdkOptions) {}

  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQueryLike {
    this.calls.push({ options: params.options });
    const q = new FakeQuery(params.prompt, params.options, this.opts);
    this.queries.push(q);
    return q;
  }
}

class Channel<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  push(item: T): void {
    this.items.push(item);
    this.wake();
  }
  close(): void {
    this.done = true;
    this.wake();
  }
  /** Drops everything not yet taken. */
  clear(): void {
    this.items.length = 0;
  }
  async next(): Promise<T | undefined> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) return item;
      if (this.done) return undefined;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
}

export class FakeQuery implements ClaudeQueryLike {
  readonly sessionId: string;
  private readonly prompts = new Channel<string>();
  private readonly promptUuids: (string | undefined)[] = [];
  private turnUuid: string | undefined;
  private readonly out = new Channel<SDKMessage>();
  private readonly cli: SpawnedProcess;
  private readonly spawnAbort = new AbortController();
  private turnAbort: AbortController | undefined;
  private closed = false;
  private cumulative: CumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  interrupts = 0;
  private failure: Error | undefined;
  /** What the adapter's canUseTool answered last (assertions). */
  lastDecision: PermissionResult | null | undefined;
  /** p6-approval-mode-switch: every `setPermissionMode` call, in order. */
  readonly permissionModes: PermissionMode[] = [];

  constructor(
    input: AsyncIterable<SDKUserMessage>,
    private readonly options: Options,
    private readonly opts: FakeSdkOptions,
  ) {
    this.sessionId = options.resume ?? options.sessionId ?? randomUUID();
    const spawnFn = options.spawnClaudeCodeProcess;
    if (!spawnFn) throw new Error('fake SDK expects spawnClaudeCodeProcess');
    this.cli = spawnFn({
      command: options.pathToClaudeCodeExecutable ?? 'claude',
      args: ['--output-format', 'stream-json', '--input-format', 'stream-json'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env },
      signal: this.spawnAbort.signal,
    });
    this.cli.on('error', () => undefined);
    void this.readInput(input);
    void this.run();
  }

  async initializationResult(): Promise<{ claude_code_version?: string }> {
    await new Promise((r) => setTimeout(r, 5));
    const fail = this.opts.failInit;
    if (fail !== undefined) {
      // Wait for the real child to exist, kill it, then fail as the SDK does (it may fail before the exit event).
      await new Promise((r) => setTimeout(r, 150));
      this.cli.kill(fail.signal ?? 'SIGKILL');
      throw new Error(fail.message);
    }
    return { claude_code_version: '2.1.310' };
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await new Promise((r) => setTimeout(r, 1));
    if (this.opts.refuseSetPermissionMode === true) throw new Error('mode change refused by the CLI');
    this.permissionModes.push(mode);
  }

  async interrupt(): Promise<unknown> {
    this.interrupts += 1;
    if (this.opts.ignoreInterrupt === true) return new Promise(() => undefined);
    this.turnAbort?.abort();
    return Promise.resolve({ still_queued: [] });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turnAbort?.abort();
    this.cli.kill('SIGTERM');
    this.out.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const m = await this.out.next();
      if (m === undefined) {
        if (this.failure) throw this.failure;
        return;
      }
      yield m;
    }
  }

  private async readInput(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const m of input) {
      const content = m.message.content;
      this.promptUuids.push(m.uuid);
      this.prompts.push(typeof content === 'string' ? content : '[blocks]');
    }
    if (this.opts.dropQueuedOnInputEnd === true) {
      this.prompts.clear();
      this.promptUuids.length = 0;
    }
    this.prompts.close();
  }

  private async run(): Promise<void> {
    let turn = 0;
    for (;;) {
      const prompt = await this.prompts.next();
      if (prompt === undefined || this.closed) break;
      this.turnUuid = this.promptUuids.shift();
      turn += 1;
      if (turn === 1) {
        const mode = this.opts.reportedPermissionMode ?? this.options.permissionMode ?? 'default';
        this.emit(initMessage(this.sessionId, mode, this.options.cwd ?? ''));
      }
      await this.runTurn(prompt, turn);
    }
    // Input ended: the CLI exits (stdin EOF), the stream ends.
    this.cli.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.cli.exitCode !== null || this.closed) resolve();
      else
        this.cli.once('exit', () => {
          resolve();
        });
    });
    this.out.close();
  }

  private async runTurn(prompt: string, turn: number): Promise<void> {
    const abort = new AbortController();
    this.turnAbort = abort;
    const add = this.opts.perTurn ?? {
      input: 120,
      output: 30,
      cacheRead: 40,
      cacheWrite: 8,
      costUsd: 0.0012,
    };
    this.cumulative = {
      input: this.cumulative.input + add.input,
      output: this.cumulative.output + add.output,
      cacheRead: this.cumulative.cacheRead + add.cacheRead,
      cacheWrite: this.cumulative.cacheWrite + add.cacheWrite,
      costUsd: this.cumulative.costUsd + add.costUsd,
    };
    for (const step of this.opts.script(prompt, turn)) {
      if (abort.signal.aborted || this.closed) break;
      if (step.kind === 'message') this.emit(step.build(this.sessionId));
      else if (step.kind === 'block') await sleep(step.ms, abort.signal);
      else if (step.kind === 'crash') {
        this.failure = new Error(step.message);
        this.cli.kill('SIGKILL');
        this.closed = true;
        this.out.close();
        return;
      } else {
        this.emit(assistantToolUse(this.sessionId, step.id, step.name, step.input));
        const canUseTool = this.options.canUseTool;
        const decision = canUseTool
          ? await canUseTool(step.name, step.input, {
              signal: abort.signal,
              toolUseID: step.id,
              requestId: randomUUID(),
            })
          : null;
        if (this.isClosed()) break;
        const allowed = decision?.behavior === 'allow';
        this.lastDecision = decision;
        this.emit(userToolResult(this.sessionId, step.id, allowed ? 'ok' : 'denied', !allowed));
      }
    }
    if (this.closed) return;
    if (abort.signal.aborted) this.emit(resultInterrupted(this.sessionId, this.cumulative));
    else this.emit(resultSuccess(this.sessionId, 'done', this.cumulative, { numTurns: 2, durationMs: 120 }));
  }

  /** A method, so the compiler does not narrow `closed` across awaits. */
  private isClosed(): boolean {
    return this.closed;
  }

  private emit(m: SDKMessage): void {
    if (this.closed) return;
    if (m.type === 'assistant' && this.opts.echoUserMessageUuids === true && this.turnUuid !== undefined) {
      const uuid = this.turnUuid;
      this.turnUuid = undefined;
      this.out.push({ ...m, user_message_uuid: uuid, user_message_uuids: [uuid] });
      return;
    }
    this.out.push(m);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
