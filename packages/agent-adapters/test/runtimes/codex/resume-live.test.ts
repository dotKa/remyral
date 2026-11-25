/**
 * p11-session-continuity (ADR-0042 §5): opt-in live verification of Codex **native resume after a worker restart**
 * (`thread/resume`) on the pinned codex-cli. Skipped unless REMYRAL_LIVE_RUNTIMES=1 and the pinned binary is available
 * (and the auth of the mode, as in live.test.ts). Spends a few cents.
 *
 * A first adapter instance runs a turn and records the thread the way a worker checkpoint does (`sessionCheckpoint`),
 * then is abandoned without `parkSession`; a second instance on the same state dir continues it with `resumeParked`.
 * When this passes, add `{ runtime: 'codex', version: CODEX_PIN, verifiedAt, evidence }` to NATIVE_RESUME_VERIFIED.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CODEX_PIN,
  createCodexAdapter,
  SecretValue,
  type AgentAdapter,
  type RuntimeAuthMode,
  type SessionRef,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped } from '../../../src/testing/index.js';
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

function ctx(ws: string, mode: RuntimeAuthMode): SpawnContext {
  const key = process.env.CODEX_API_KEY;
  return {
    jobId: JobId.parse('job-codex-resume-live'),
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
  describe.skipIf(!enabled)(
    `codex native resume after a worker restart (${mode})`,
    { timeout: 300_000 },
    () => {
      it('a new adapter instance continues the checkpointed thread (thread/resume)', async () => {
        const stateDir = join(root, `resume-${mode}`);
        const ws = mkdtempSync(join(root, 'repo-'));
        writeFileSync(join(ws, 'README.md'), '# live\n');
        execFileSync('git', ['init', '-q'], { cwd: ws });

        const first = createCodexAdapter({ authMode: mode, codexPath: bin ?? 'codex', stateDir });
        expect((await first.probe()).version).toBe(CODEX_PIN);
        const ref = await first.spawn(ctx(ws, mode));
        const approving = autoApprove(first, ref);
        await first.sendPrompt(ref, {
          text: 'Create a file named crash-proof.txt containing exactly the word kept. Then reply with DONE.',
        });
        await collectUntilStopped(first, ref, 240_000);
        await approving;
        expect(existsSync(join(ws, 'crash-proof.txt'))).toBe(true);
        const checkpoint = await first.sessionCheckpoint(ref);
        expect(checkpoint?.runtimeSessionId).toMatch(/^[A-Za-z0-9_.:-]+$/);
        if (checkpoint === null) return;

        const second = createCodexAdapter({ authMode: mode, codexPath: bin ?? 'codex', stateDir });
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
          `VERIFIED: codex ${CODEX_PIN} native resume after a restart (${mode}) — add it to NATIVE_RESUME_VERIFIED`,
        );
        await second.cleanup(resumed);
        await first.cleanup(ref);
      });
    },
  );
}
