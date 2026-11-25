/**
 * p11-session-continuity (ADR-0042 §5): opt-in live verification of Claude Code **native resume after a worker
 * restart** on the pinned SDK / CLI. Skipped unless REMYRAL_LIVE_RUNTIMES=1 (and the auth of the mode, as in
 * live.test.ts). Spends a few cents.
 *
 * A first adapter instance runs a turn and records the session the way a worker checkpoint does (`sessionCheckpoint`
 * while it runs), then is abandoned without `parkSession` (the process is stopped like a dying worker would leave it).
 * A second adapter instance on the same state dir continues it with `resumeParked` and must remember the first turn.
 *
 * When this passes for a version, add `{ runtime: 'claude-code', version: <CLI pin>, verifiedAt, evidence }` to
 * NATIVE_RESUME_VERIFIED (src/resume-verification.ts); until then production continues in a fresh session.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_CLI_PIN,
  createClaudeCodeAdapter,
  SecretValue,
  type AgentAdapter,
  type RuntimeAuthMode,
  type SessionRef,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped } from '../../../src/testing/index.js';

const live = process.env.REMYRAL_LIVE_RUNTIMES === '1';
const modes: { mode: RuntimeAuthMode; enabled: boolean }[] = [
  { mode: 'secret-ref', enabled: live && (process.env.ANTHROPIC_API_KEY ?? '') !== '' },
  { mode: 'local-login', enabled: live && process.env.REMYRAL_LIVE_CLAUDE_LOCAL_LOGIN === '1' },
];

const root = mkdtempSync(join(tmpdir(), 'remyral-claude-resume-live-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(ws: string, mode: RuntimeAuthMode): SpawnContext {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    jobId: JobId.parse('job-claude-resume-live'),
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
    // The capability is `unverified` until this very test passed: the live run must be allowed to use it.
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
  describe.skipIf(!enabled)(
    `claude-code native resume after a worker restart (${mode})`,
    { timeout: 300_000 },
    () => {
      it('a new adapter instance continues the checkpointed session (SDK options.resume)', async () => {
        const stateDir = join(root, `state-${mode}`);
        const ws = mkdtempSync(join(root, 'repo-'));
        writeFileSync(join(ws, 'README.md'), '# live\n');
        execFileSync('git', ['init', '-q'], { cwd: ws });

        const first = createClaudeCodeAdapter({ authMode: mode, stateDir });
        expect((await first.probe()).version).toBe(CLAUDE_CODE_CLI_PIN);
        const ref = await first.spawn(ctx(ws, mode));
        const approving = autoApprove(first, ref);
        await first.sendPrompt(ref, {
          text: 'Create a file named crash-proof.txt containing exactly the word kept. Then reply with DONE.',
        });
        await collectUntilStopped(first, ref, 240_000);
        await approving;
        expect(existsSync(join(ws, 'crash-proof.txt'))).toBe(true);
        // What a worker checkpoint records while the session runs.
        const checkpoint = await first.sessionCheckpoint(ref);
        expect(checkpoint?.runtimeSessionId).toMatch(/^[A-Za-z0-9_.:-]+$/);
        if (checkpoint === null) return;
        // The worker dies: no parkSession, no cleanup (the config dir stays on disk as after a crash).

        const second = createClaudeCodeAdapter({ authMode: mode, stateDir });
        await second.probe();
        const resumed = await second.resumeParked(ctx(ws, mode), checkpoint);
        const approving2 = autoApprove(second, resumed);
        await second.sendPrompt(resumed, {
          text: 'Which file did you create before? Reply with the file name only.',
        });
        const more = await collectUntilStopped(second, resumed, 120_000);
        await approving2;
        const text = more
          .map((e) => (e.event.kind === 'message' && e.event.role === 'assistant' ? e.event.text : ''))
          .join(' ');
        expect(text).toContain('crash-proof.txt');
        console.info(
          `VERIFIED: claude-code ${CLAUDE_CODE_CLI_PIN} native resume after a restart (${mode}) — add it to NATIVE_RESUME_VERIFIED`,
        );
        await second.cleanup(resumed);
        await first.cleanup(ref);
      });
    },
  );
}
