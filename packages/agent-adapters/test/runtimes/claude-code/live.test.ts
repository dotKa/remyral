/**
 * Credentialed end-to-end checks against a real model. Skipped unless
 * REMYRAL_LIVE_RUNTIMES=1. Modes:
 *  - secret-ref: needs ANTHROPIC_API_KEY in the test environment (injected per
 *    job via SpawnContext.secretEnv, never inherited);
 *  - local-login: needs REMYRAL_LIVE_CLAUDE_LOCAL_LOGIN=1 and the worker user
 *    logged in with `claude` (the adapter never touches that login).
 * Each run spends a few cents of tokens.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createClaudeCodeAdapter,
  SecretValue,
  type AgentAdapter,
  type RuntimeAuthMode,
  type SequencedEvent,
  type SessionRef,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped, readUntil } from '../../../src/testing/index.js';
import { declaredStatuses, runCapabilityVerification } from '../../../src/verification/index.js';

const live = process.env.REMYRAL_LIVE_RUNTIMES === '1';
const modes: { mode: RuntimeAuthMode; enabled: boolean }[] = [
  { mode: 'secret-ref', enabled: live && (process.env.ANTHROPIC_API_KEY ?? '') !== '' },
  { mode: 'local-login', enabled: live && process.env.REMYRAL_LIVE_CLAUDE_LOCAL_LOGIN === '1' },
];

const root = mkdtempSync(join(tmpdir(), 'remyral-claude-live-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const ws = mkdtempSync(join(root, 'repo-'));
  writeFileSync(join(ws, 'README.md'), '# live test repo\n');
  execFileSync('git', ['init', '-q'], { cwd: ws });
  return ws;
}

function ctx(ws: string, mode: RuntimeAuthMode, signal = new AbortController().signal): SpawnContext {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    jobId: JobId.parse('job-claude-live'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: ws,
    job: { runtime: 'claude-code', prompt: 'live', limits: { maxDurationSec: 300 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: mode === 'secret-ref' && key ? { ANTHROPIC_API_KEY: new SecretValue(key) } : {},
    timeouts: {
      startupMs: 60_000,
      cancelGraceMs: 5_000,
      cancelMs: 20_000,
      approvalMs: 60_000,
      maxDurationMs: 300_000,
    },
    allowUnverified: true,
    signal,
  };
}

/** Approves every approval request (the test plays the human reviewer). */
async function autoApprove(adapter: AgentAdapter, ref: SessionRef): Promise<void> {
  for await (const e of adapter.events(ref)) {
    if (e.event.kind === 'approval_request') {
      await adapter.requestApproval(ref, {
        approvalId: e.event.approvalId,
        decision: 'approve',
        decidedBy: 'live-test',
      });
    }
  }
}

const usageOf = (events: SequencedEvent[]) => events.map((e) => e.event).filter((e) => e.kind === 'usage');

for (const { mode, enabled } of modes) {
  describe.skipIf(!enabled)(`claude-code live (${mode})`, { timeout: 300_000 }, () => {
    it('one-prompt repo task: stream, approval, usage, result, resume', async () => {
      const adapter = createClaudeCodeAdapter({ authMode: mode, stateDir: join(root, 'state') });
      const probe = await adapter.probe();
      expect(probe.versionMatchesPin).toBe(true);
      const ws = repo();
      const ref = await adapter.spawn(ctx(ws, mode));
      const approving = autoApprove(adapter, ref);
      await adapter.sendPrompt(ref, {
        text: 'Create a file named hello.txt in the current directory containing exactly the word hi. Then reply with DONE.',
      });
      const events = await collectUntilStopped(adapter, ref, 240_000);
      await approving;
      const kinds = events.map((e) => e.event.kind);
      expect(kinds).toContain('tool_call');
      expect(kinds).toContain('approval_request');
      expect(existsSync(join(ws, 'hello.txt'))).toBe(true);
      const usage = usageOf(events);
      expect(usage.length).toBeGreaterThan(0);
      for (const u of usage) {
        expect(u.authMode).toBe(mode);
        if (mode === 'local-login') expect(u.costUsd).toBeUndefined();
      }
      expect((usage[0]?.inputTokens ?? 0) + (usage[0]?.outputTokens ?? 0)).toBeGreaterThan(0);
      expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');

      const resumed = await adapter.resume(ref, ctx(ws, mode));
      await adapter.sendPrompt(resumed, {
        text: 'What is the name of the file you created? Reply with the file name only.',
      });
      const more = await collectUntilStopped(adapter, resumed, 120_000);
      const text = more
        .map((e) => (e.event.kind === 'message' && e.event.role === 'assistant' ? e.event.text : ''))
        .join(' ');
      expect(text).toContain('hello.txt');
      await adapter.cleanup(resumed);
      await adapter.cleanup(ref);
    });

    // p17-runtime-verify: the scenario set the panel's "Doğrula" runs on a worker, against the real model.
    it('capability verification scenario set: every declared capability passes', async () => {
      const ws = repo();
      const run = await runCapabilityVerification({
        runtime: 'claude-code',
        adapter: () => createClaudeCodeAdapter({ authMode: mode, stateDir: join(root, 'state') }),
        context: (_s, i) => ({ ...ctx(ws, mode, i.signal), approvalPolicy: i.approvalPolicy }),
        workspace: ws,
        budget: { maxDurationSec: 900, maxTokens: 300_000 },
      });
      const declared = declaredStatuses('claude-code');
      for (const r of run.results)
        expect({ cap: r.capability, status: r.status, reason: r.reason }).toMatchObject({
          status: declared[r.capability] === 'unsupported' ? 'skipped' : 'passed',
        });
    });

    it('cancel mid-tool: stopped/cancelled within cancelMs, no orphan process', async () => {
      const adapter = createClaudeCodeAdapter({ authMode: mode, stateDir: join(root, 'state') });
      await adapter.probe();
      const ws = repo();
      const c = ctx(ws, mode);
      const ref = await adapter.spawn(c);
      void autoApprove(adapter, ref);
      await adapter.sendPrompt(ref, {
        text: 'Use the Bash tool to run exactly: sleep 177. Then reply DONE.',
      });
      await readUntil(
        adapter,
        ref,
        (e) => e.event.kind === 'tool_call' && e.event.toolName === 'Bash',
        120_000,
      );
      await new Promise((r) => setTimeout(r, 3_000));
      const t0 = Date.now();
      await adapter.cancel(ref, 'live cancel test');
      expect(Date.now() - t0).toBeLessThanOrEqual(c.timeouts.cancelMs + 1_000);
      expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
      await adapter.cleanup(ref);
      const ps = execFileSync('ps', ['-A', '-o', 'command'], { encoding: 'utf8' });
      expect(ps).not.toContain('sleep 177');
    });
  });
}
