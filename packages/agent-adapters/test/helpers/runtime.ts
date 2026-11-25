import { execFileSync } from 'node:child_process';
import { AttemptId, JobId, type RuntimeKind } from '@remyral/protocol';
import type {
  AdapterTimeouts,
  AgentAdapter,
  SequencedEvent,
  SessionRef,
  SpawnContext,
} from '../../src/index.js';
import { isTerminalEvent } from '../../src/index.js';

export const SLOW_TIMEOUTS: AdapterTimeouts = {
  startupMs: 60_000,
  cancelGraceMs: 2_000,
  cancelMs: 10_000,
  approvalMs: 15_000,
  maxDurationMs: 180_000,
};

export function spawnContext(
  runtime: RuntimeKind,
  workspaceRoot: string,
  overrides: Partial<SpawnContext> = {},
): SpawnContext {
  return {
    jobId: JobId.parse('job-test'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot,
    job: { runtime, prompt: 'test', limits: { maxDurationSec: 180 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: SLOW_TIMEOUTS,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Drain events until the terminal status (or throw after `timeoutMs`). */
export async function drain(
  adapter: AgentAdapter,
  ref: SessionRef,
  timeoutMs = 60_000,
): Promise<SequencedEvent[]> {
  const out: SequencedEvent[] = [];
  for await (const e of adapter.events(ref, undefined, AbortSignal.timeout(timeoutMs))) {
    out.push(e);
    if (isTerminalEvent(e.event)) return out;
  }
  throw new Error(
    `no terminal event within ${String(timeoutMs)} ms (got ${JSON.stringify(out.map((e) => e.event))})`,
  );
}

/** Read events until `pred` matches. */
export async function waitFor(
  adapter: AgentAdapter,
  ref: SessionRef,
  pred: (e: SequencedEvent) => boolean,
  timeoutMs = 60_000,
): Promise<SequencedEvent> {
  for await (const e of adapter.events(ref, undefined, AbortSignal.timeout(timeoutMs))) {
    if (pred(e)) return e;
    if (isTerminalEvent(e.event)) break;
  }
  throw new Error('expected event not seen');
}

/** PIDs of live processes whose command line contains `needle` (POSIX `ps`). */
export function processesMatching(needle: string): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.includes(needle) && !line.includes('ps -A'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}
