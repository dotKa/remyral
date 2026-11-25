/**
 * Credentialed end-to-end checks against a real model. Skipped unless
 * REMYRAL_LIVE_RUNTIMES=1 and the pinned codex is available. Modes:
 *  - secret-ref: needs CODEX_API_KEY in the test environment (injected per job);
 *  - local-login: needs REMYRAL_LIVE_CODEX_LOCAL_LOGIN=1 and the worker user
 *    logged in with `codex login` (the adapter never touches that login).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCodexAdapter,
  SecretValue,
  type AgentAdapter,
  type RuntimeAuthMode,
  type SessionRef,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped, readUntil } from '../../../src/testing/index.js';
import { declaredStatuses, runCapabilityVerification } from '../../../src/verification/index.js';
import { codexTestStateDir, pinnedCodexBinary } from '../../fixtures/codex/helpers.js';

const live = process.env.REMYRAL_LIVE_RUNTIMES === '1';
const bin = live ? pinnedCodexBinary() : undefined;
const modes: { mode: RuntimeAuthMode; enabled: boolean }[] = [
  { mode: 'secret-ref', enabled: bin !== undefined && (process.env.CODEX_API_KEY ?? '') !== '' },
  { mode: 'local-login', enabled: bin !== undefined && process.env.REMYRAL_LIVE_CODEX_LOCAL_LOGIN === '1' },
];

const root = codexTestStateDir();
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const ws = mkdtempSync(join(root, 'repo-'));
  writeFileSync(join(ws, 'README.md'), '# live test repo\n');
  execFileSync('git', ['init', '-q'], { cwd: ws });
  return ws;
}

function ctx(ws: string, mode: RuntimeAuthMode): SpawnContext {
  const key = process.env.CODEX_API_KEY;
  return {
    jobId: JobId.parse('job-codex-live'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: ws,
    job: { runtime: 'codex', prompt: 'live', limits: { maxDurationSec: 300 } },
    sandboxProfile: process.platform === 'darwin' ? 'host-restricted' : 'runtime-sandbox',
    approvalPolicy: 'ask-all',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: mode === 'secret-ref' && key ? { CODEX_API_KEY: new SecretValue(key) } : {},
    timeouts: {
      startupMs: 60_000,
      cancelGraceMs: 5_000,
      cancelMs: 20_000,
      approvalMs: 60_000,
      maxDurationMs: 300_000,
    },
    allowUnverified: true,
    signal: new AbortController().signal,
  };
}

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

for (const { mode, enabled } of modes) {
  describe.skipIf(!enabled)(`codex live (${mode})`, { timeout: 300_000 }, () => {
    it('one-prompt repo task: stream, usage, diff, result, resume', async () => {
      const adapter = createCodexAdapter({ authMode: mode, codexPath: bin ?? 'codex', stateDir: root });
      expect((await adapter.probe()).versionMatchesPin).toBe(true);
      const ws = repo();
      const ref = await adapter.spawn(ctx(ws, mode));
      const approving = autoApprove(adapter, ref);
      await adapter.sendPrompt(ref, {
        text: 'Create a file named hello.txt containing exactly the word hi. Then reply with DONE.',
      });
      const events = await collectUntilStopped(adapter, ref, 240_000);
      await approving;
      expect(existsSync(join(ws, 'hello.txt'))).toBe(true);
      const usage = events.map((e) => e.event).filter((e) => e.kind === 'usage');
      expect(usage.length).toBeGreaterThan(0);
      for (const u of usage) {
        expect(u.costUsd).toBeUndefined();
        expect(u.authMode).toBe(mode);
      }
      const result = await adapter.collectResult(ref);
      expect(result.outcome).toBe('succeeded');
      expect(result.diff ?? '').toContain('hello.txt');

      const resumed = await adapter.resume(ref, ctx(ws, mode));
      await adapter.sendPrompt(resumed, {
        text: 'What is the name of the file you created? Reply with the name only.',
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
        runtime: 'codex',
        adapter: () => createCodexAdapter({ authMode: mode, codexPath: bin ?? 'codex', stateDir: root }),
        context: (_s, i) => ({ ...ctx(ws, mode), signal: i.signal, approvalPolicy: i.approvalPolicy }),
        workspace: ws,
        budget: { maxDurationSec: 900, maxTokens: 300_000 },
      });
      const declared = declaredStatuses('codex');
      for (const r of run.results)
        expect({ cap: r.capability, status: r.status, reason: r.reason }).toMatchObject({
          status: declared[r.capability] === 'unsupported' ? 'skipped' : 'passed',
        });
    });

    it('cancel mid-command: turn/interrupt, stopped/cancelled, no orphan', async () => {
      const adapter = createCodexAdapter({ authMode: mode, codexPath: bin ?? 'codex', stateDir: root });
      await adapter.probe();
      const c = ctx(repo(), mode);
      const ref = await adapter.spawn(c);
      void autoApprove(adapter, ref);
      await adapter.sendPrompt(ref, { text: 'Run the shell command: sleep 178. Then reply DONE.' });
      await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 120_000);
      await new Promise((r) => setTimeout(r, 3_000));
      const t0 = Date.now();
      await adapter.cancel(ref, 'live cancel test');
      expect(Date.now() - t0).toBeLessThanOrEqual(c.timeouts.cancelMs + 1_000);
      expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
      await adapter.cleanup(ref);
      expect(execFileSync('ps', ['-A', '-o', 'command'], { encoding: 'utf8' })).not.toContain('sleep 178');
    });
  });
}
