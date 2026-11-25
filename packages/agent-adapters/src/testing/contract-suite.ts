import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, CapabilityStatus, CostProvenance, JobId } from '@remyral/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_CAPABILITIES, isOffered, type AdapterCapability } from '../capabilities.js';
import type { AdapterTimeouts, AgentAdapter, SessionRef, SpawnContext } from '../contract.js';
import { CapabilityUnsupportedError, SessionStateError } from '../errors.js';
import { isTerminalEvent } from '../event-log.js';
import { SecretValue, type SecretEnv } from '../secrets.js';
import {
  collectUntilStopped,
  eventSequenceProblem,
  findSecretLeaks,
  readUntil,
} from '../verification/assertions.js';

// p17-runtime-verify: the shared assertions live in the verification module (used by the worker too).
export { collectUntilStopped, findSecretLeaks, readUntil };

export type ContractScenario = 'basic' | 'long-running' | 'approval';

/**
 * Adapter under test. Called once per test with the scenario it needs:
 * - `basic`: a prompt that finishes on its own quickly.
 * - `long-running`: a prompt that keeps the session running until cancelled.
 * - `approval`: a prompt that triggers exactly one approval request.
 */
export type AdapterFactory = (scenario: ContractScenario) => AgentAdapter | Promise<AgentAdapter>;

export interface ContractSuiteOptions {
  readonly prompts?: Partial<Record<ContractScenario, string>>;
  readonly timeouts?: Partial<AdapterTimeouts>;
  /** Adjust the base context (e.g. allowUnverified, sandbox profile) per adapter. */
  readonly makeContext?: (base: SpawnContext) => SpawnContext;
  /** Upper bound for a `basic` session to stop on its own. Default 10 s. */
  readonly sessionTimeoutMs?: number;
  /** Scheduling slack on top of `timeouts.cancelMs` when asserting cancel latency. Default 250 ms. */
  readonly cancelSlackMs?: number;
  readonly testTimeoutMs?: number;
}

export const CANARY_ENV = 'REMYRAL_CONTRACT_CANARY';

const DEFAULT_TIMEOUTS: AdapterTimeouts = {
  startupMs: 5_000,
  cancelGraceMs: 500,
  cancelMs: 2_000,
  approvalMs: 5_000,
  maxDurationMs: 60_000,
};

const DEFAULT_PROMPTS: Record<ContractScenario, string> = {
  basic: 'Contract test: reply with the word done.',
  'long-running': 'Contract test: run a long command until cancelled.',
  approval: 'Contract test: request approval for one sensitive action.',
};

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err;
  }
}

/**
 * Registers the contract tests every adapter must pass (ADR-0008: this kit is
 * the only source of a `supported` capability status). Call inside a Vitest
 * test file.
 */
export function defineAdapterContractSuite(
  name: string,
  factory: AdapterFactory,
  options: ContractSuiteOptions = {},
): void {
  const timeouts: AdapterTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const prompts = { ...DEFAULT_PROMPTS, ...options.prompts };
  const sessionTimeoutMs = options.sessionTimeoutMs ?? 10_000;
  const cancelSlackMs = options.cancelSlackMs ?? 250;
  const testTimeout = options.testTimeoutMs ?? sessionTimeoutMs + timeouts.cancelMs + 5_000;

  describe(`adapter contract: ${name}`, { timeout: testTimeout }, () => {
    let workspaceRoot = '';
    const canary = new SecretValue(`canary-${randomBytes(16).toString('hex')}`);
    const secretEnv: SecretEnv = { [CANARY_ENV]: canary };
    const opened: { adapter: AgentAdapter; ref: SessionRef }[] = [];
    const controllers: AbortController[] = [];

    beforeAll(async () => {
      workspaceRoot = await mkdtemp(join(tmpdir(), 'remyral-contract-'));
    });

    afterEach(async () => {
      for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
      for (const c of controllers.splice(0)) c.abort();
    });

    afterAll(async () => {
      await rm(workspaceRoot, { recursive: true, force: true });
    });

    function context(adapter: AgentAdapter, scenario: ContractScenario, signal?: AbortSignal): SpawnContext {
      const controller = new AbortController();
      controllers.push(controller);
      const base: SpawnContext = {
        jobId: JobId.parse('job-contract'),
        attemptId: AttemptId.parse('attempt-1'),
        workspaceRoot,
        job: {
          runtime: adapter.runtime,
          prompt: prompts[scenario],
          limits: { maxDurationSec: Math.ceil(timeouts.maxDurationMs / 1000) },
        },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        repositoryTrust: 'untrusted',
        repoConfig: 'ignore-repository-config',
        secretEnv,
        timeouts,
        signal: signal ?? controller.signal,
      };
      return options.makeContext ? options.makeContext(base) : base;
    }

    async function start(
      scenario: ContractScenario,
      signal?: AbortSignal,
    ): Promise<{ adapter: AgentAdapter; ref: SessionRef; ctx: SpawnContext }> {
      const adapter = await factory(scenario);
      await adapter.probe();
      const ctx = context(adapter, scenario, signal);
      const ref = await adapter.spawn(ctx);
      opened.push({ adapter, ref });
      await adapter.sendPrompt(ref, { text: prompts[scenario] });
      return { adapter, ref, ctx };
    }

    const offered = (adapter: AgentAdapter, cap: AdapterCapability, ctx?: SpawnContext): boolean =>
      isOffered(adapter.capabilities().capabilities[cap], { allowUnverified: ctx?.allowUnverified === true });

    it('probe() reports runtime, version, os/arch and a complete, reasoned capability set', async () => {
      const adapter = await factory('basic');
      const probe = await adapter.probe();
      expect(probe.runtime).toBe(adapter.runtime);
      expect(['darwin', 'linux', 'win32']).toContain(probe.os);
      expect(['x64', 'arm64']).toContain(probe.arch);
      expect(probe.pinnedVersion.length).toBeGreaterThan(0);
      expect(probe.versionMatchesPin).toBe(probe.version === probe.pinnedVersion);
      expect(['yes', 'no', 'unknown']).toContain(probe.authenticated);
      const key = probe.capabilities.key;
      expect(key).toEqual({ runtime: probe.runtime, version: probe.version, os: probe.os, arch: probe.arch });
      for (const cap of ADAPTER_CAPABILITIES) {
        const entry = probe.capabilities.capabilities[cap];
        expect(CapabilityStatus.options).toContain(entry.status);
        if (entry.status !== 'supported') expect(entry.reason.trim().length).toBeGreaterThan(0);
      }
      if (!probe.versionMatchesPin) {
        for (const cap of ADAPTER_CAPABILITIES) {
          expect(['unverified', 'unsupported']).toContain(probe.capabilities.capabilities[cap].status);
        }
      }
      expect(adapter.capabilities()).toEqual(probe.capabilities);
    });

    it('interactive_prompt: a follow-up prompt is accepted only if offered', async () => {
      const { adapter, ref, ctx } = await start('long-running');
      await readUntil(
        adapter,
        ref,
        (e) => e.event.kind === 'status' && e.event.phase === 'running',
        sessionTimeoutMs,
      );
      const err = await rejection(adapter.sendPrompt(ref, { text: 'follow-up' }));
      if (offered(adapter, 'interactive_prompt', ctx))
        expect(err).not.toBeInstanceOf(CapabilityUnsupportedError);
      else expect(err).toBeInstanceOf(CapabilityUnsupportedError);
      await adapter.cancel(ref);
    });

    it('approval: requestApproval rejects with CapabilityUnsupportedError unless offered', async () => {
      const { adapter, ref, ctx } = await start('basic');
      const err = await rejection(
        adapter.requestApproval(ref, {
          approvalId: 'no-such-approval',
          decision: 'deny',
          decidedBy: 'contract-test',
        }),
      );
      if (offered(adapter, 'approval', ctx)) {
        expect(err).not.toBeInstanceOf(CapabilityUnsupportedError);
        // An unknown approval id must not be silently accepted either.
        expect(err).toBeInstanceOf(Error);
      } else {
        expect(err).toBeInstanceOf(CapabilityUnsupportedError);
      }
      await collectUntilStopped(adapter, ref, sessionTimeoutMs);
    });

    it('approval: a granted request lets the session finish (when offered)', async (t) => {
      const { adapter, ref, ctx } = await start('approval');
      if (!offered(adapter, 'approval', ctx)) {
        t.skip();
        return;
      }
      const seen = await readUntil(
        adapter,
        ref,
        (e) => e.event.kind === 'approval_request',
        sessionTimeoutMs,
      );
      const req = seen.at(-1)?.event;
      if (req?.kind !== 'approval_request') throw new Error('unreachable');
      await adapter.requestApproval(ref, {
        approvalId: req.approvalId,
        decision: 'approve',
        decidedBy: 'contract-test',
      });
      const all = await collectUntilStopped(adapter, ref, sessionTimeoutMs);
      expect(all.at(-1)?.event).toEqual({ kind: 'status', phase: 'stopped' });
      expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
    });

    it('resume: rejects with CapabilityUnsupportedError unless offered', async () => {
      const { adapter, ref, ctx } = await start('basic');
      await collectUntilStopped(adapter, ref, sessionTimeoutMs);
      const resumed = adapter.resume(ref, context(adapter, 'basic'));
      if (offered(adapter, 'resume', ctx)) {
        const newRef = await resumed;
        opened.push({ adapter, ref: newRef });
        expect(newRef.runtime).toBe(adapter.runtime);
      } else {
        expect(await rejection(resumed)).toBeInstanceOf(CapabilityUnsupportedError);
      }
    });

    it('events are gapless, ordered, terminal, and resumable from a cursor without duplicates', async () => {
      const { adapter, ref } = await start('basic');
      const all = await collectUntilStopped(adapter, ref, sessionTimeoutMs);
      // p17-runtime-verify: the same rule the worker's capability verification applies (verification/assertions.ts).
      expect(eventSequenceProblem(all)).toBeNull();
      expect(all.filter((e) => isTerminalEvent(e.event))).toHaveLength(1);
      for (const k of [0, 1, Math.floor(all.length / 2), all.length - 1]) {
        const tail = await collectUntilStopped(adapter, ref, sessionTimeoutMs, { afterSeq: k });
        expect(tail).toEqual(all.slice(k));
      }
      // Two concurrent readers see the same sequence.
      const [a, b] = await Promise.all([
        collectUntilStopped(adapter, ref, sessionTimeoutMs),
        collectUntilStopped(adapter, ref, sessionTimeoutMs),
      ]);
      expect(a).toEqual(all);
      expect(b).toEqual(all);
      expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
    });

    it('collectResult rejects while the session is still running', async () => {
      const { adapter, ref } = await start('long-running');
      await readUntil(
        adapter,
        ref,
        (e) => e.event.kind === 'status' && e.event.phase === 'running',
        sessionTimeoutMs,
      );
      expect(await rejection(adapter.collectResult(ref))).toBeInstanceOf(SessionStateError);
      await adapter.cancel(ref);
    });

    it('cancel ends a running session within the declared timeout with a terminal status', async () => {
      const { adapter, ref } = await start('long-running');
      await readUntil(
        adapter,
        ref,
        (e) => e.event.kind === 'status' && e.event.phase === 'running',
        sessionTimeoutMs,
      );
      const t0 = performance.now();
      const outcome = await adapter.cancel(ref, 'contract test');
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThanOrEqual(timeouts.cancelMs + cancelSlackMs);
      expect(['graceful', 'forced']).toContain(outcome.mode);
      const all = await collectUntilStopped(adapter, ref, cancelSlackMs + 1000);
      expect(all.at(-1)?.event).toEqual({ kind: 'status', phase: 'stopped' });
      expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
      expect((await adapter.cancel(ref)).mode).toBe('already-stopped');
    });

    it('aborting the spawn signal cancels the session', async () => {
      const controller = new AbortController();
      const { adapter, ref } = await start('long-running', controller.signal);
      await readUntil(
        adapter,
        ref,
        (e) => e.event.kind === 'status' && e.event.phase === 'running',
        sessionTimeoutMs,
      );
      controller.abort();
      const all = await collectUntilStopped(adapter, ref, timeouts.cancelMs + cancelSlackMs);
      expect(all.at(-1)?.event).toEqual({ kind: 'status', phase: 'stopped' });
      expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
    });

    it('cleanup is idempotent (also for running and unknown sessions)', async () => {
      const { adapter, ref } = await start('long-running');
      await adapter.cleanup(ref);
      await adapter.cleanup(ref);
      await adapter.cleanup({ sessionId: 'never-existed', runtime: adapter.runtime });
    });

    it('getCost always carries provenance; unknown carries no values', async () => {
      const { adapter, ref } = await start('basic');
      await collectUntilStopped(adapter, ref, sessionTimeoutMs);
      const cost = await adapter.getCost(ref);
      expect(CostProvenance.options).toContain(cost.provenance);
      if (cost.provenance === 'unknown') expect(cost.costUsd).toBeUndefined();
      if (!offered(adapter, 'cost_reporting')) expect(cost.provenance).toBe('unknown');
      if (cost.costUsd !== undefined) expect(cost.costUsd).toBeGreaterThanOrEqual(0);
    });

    it('never emits the injected secret (canary) in events, results, cost or probe output', async () => {
      const { adapter, ref } = await start('basic');
      const events = await collectUntilStopped(adapter, ref, sessionTimeoutMs);
      const outputs: unknown[] = [
        events,
        await adapter.collectResult(ref),
        await adapter.getCost(ref),
        await adapter.probe(),
        ref,
      ];
      expect(findSecretLeaks(outputs, secretEnv)).toEqual([]);
      expect(String(canary)).toBe('[REDACTED]');
      expect(JSON.stringify(secretEnv)).not.toContain(canary.reveal());
    });
  });
}
