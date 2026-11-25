/**
 * Credentialed OpenCode tests — a real model call. Skipped unless REMYRAL_LIVE_RUNTIMES=1.
 *
 *   REMYRAL_LIVE_RUNTIMES=1
 *   REMYRAL_OPENCODE_BIN=/path/to/pinned/opencode     (1.19.0 platform binary)
 *   REMYRAL_OPENCODE_MODEL=anthropic/claude-haiku-4-5  (provider/model)
 *   REMYRAL_OPENCODE_AUTH=local-login | secret-ref      (default local-login: the owner's `opencode auth login`)
 *   REMYRAL_OPENCODE_KEY_ENV=ANTHROPIC_API_KEY           (secret-ref only: env var holding the key)
 *
 * The key (secret-ref) is read from this process's environment and injected
 * into the server via `secretEnv` only.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@remyral/protocol';
import { createOpenCodeAdapter, SecretValue, type SecretEnv } from '../src/index.js';
import { drain, spawnContext, SLOW_TIMEOUTS, waitFor } from './helpers/runtime.js';
import { declaredStatuses, runCapabilityVerification } from '../src/verification/index.js';

const live = process.env.REMYRAL_LIVE_RUNTIMES === '1' && (process.env.REMYRAL_OPENCODE_BIN ?? '') !== '';
const authMode = process.env.REMYRAL_OPENCODE_AUTH === 'secret-ref' ? 'secret-ref' : 'local-login';
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-live-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function secrets(): SecretEnv {
  if (authMode !== 'secret-ref') return {};
  const name = process.env.REMYRAL_OPENCODE_KEY_ENV ?? 'ANTHROPIC_API_KEY';
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return { [name]: new SecretValue(value) };
}

function repo(): string {
  const dir = join(root, randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'greet.txt'), 'hello\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function adapter() {
  return createOpenCodeAdapter({
    command: process.env.REMYRAL_OPENCODE_BIN ?? 'opencode',
    stateDir: join(root, 'state', randomUUID()),
    authMode,
    ...(process.env.REMYRAL_OPENCODE_MODEL ? { model: process.env.REMYRAL_OPENCODE_MODEL } : {}),
  });
}

describe.skipIf(!live)('opencode 1.19.0 live (credentialed)', { timeout: 300_000 }, () => {
  it('one-prompt repository task: streams, edits with approval, reports usage and result', async () => {
    const a = adapter();
    const ws = repo();
    const ref = await a.spawn(
      spawnContext('opencode', ws, { secretEnv: secrets(), repositoryTrust: 'trusted' }),
    );
    await a.sendPrompt(ref, {
      text: 'Append a line "world" to greet.txt using your edit tool. Do nothing else.',
    });
    const events: AgentEvent[] = [];
    for await (const e of a.events(ref, undefined, AbortSignal.timeout(240_000))) {
      events.push(e.event);
      if (e.event.kind === 'approval_request') {
        await a.requestApproval(ref, {
          approvalId: e.event.approvalId,
          decision: 'approve',
          decidedBy: 'live-test',
        });
      }
      if (e.event.kind === 'status' && e.event.phase === 'stopped') break;
    }
    expect(events.some((e) => e.kind === 'message' && e.role === 'assistant')).toBe(true);
    expect(events.some((e) => e.kind === 'tool_call')).toBe(true);
    const usage = events.filter((e) => e.kind === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]).toMatchObject({ authMode, turns: 1 });
    expect((await a.collectResult(ref)).outcome).toBe('succeeded');
    expect(readFileSync(join(ws, 'greet.txt'), 'utf8')).toContain('world');
    expect((await a.getCost(ref)).inputTokens).toBeGreaterThan(0);
    await a.cleanup(ref);
  });

  // p17-runtime-verify: the scenario set the panel's "Doğrula" runs on a worker, against the real model.
  it('capability verification scenario set: every declared capability passes', async () => {
    const ws = repo();
    const run = await runCapabilityVerification({
      runtime: 'opencode',
      adapter: () => adapter(),
      context: (_s, i) =>
        spawnContext('opencode', ws, {
          secretEnv: secrets(),
          approvalPolicy: i.approvalPolicy,
          allowUnverified: true,
          signal: i.signal,
        }),
      workspace: ws,
      budget: { maxDurationSec: 900, maxTokens: 300_000 },
    });
    const declared = declaredStatuses('opencode');
    for (const r of run.results)
      expect({ cap: r.capability, status: r.status, reason: r.reason }).toMatchObject({
        status: declared[r.capability] === 'unsupported' ? 'skipped' : 'passed',
      });
  });

  it('cancel during a live run stops it within cancelMs', async () => {
    const a = adapter();
    const ref = await a.spawn(
      spawnContext('opencode', repo(), { secretEnv: secrets(), approvalPolicy: 'deny-sensitive' }),
    );
    await a.sendPrompt(ref, { text: 'Write a 2000-word essay about process groups. Take your time.' });
    await waitFor(a, ref, (e) => e.event.kind === 'status' && e.event.phase === 'running');
    const t0 = Date.now();
    const outcome = await a.cancel(ref);
    expect(['graceful', 'forced']).toContain(outcome.mode);
    expect(Date.now() - t0).toBeLessThanOrEqual(SLOW_TIMEOUTS.cancelMs + 1_000);
    const events = await drain(a, ref, 5_000);
    expect(events.at(-1)?.event).toEqual({ kind: 'status', phase: 'stopped' });
    expect((await a.collectResult(ref)).outcome).toBe('cancelled');
    await a.cleanup(ref);
  });
});
