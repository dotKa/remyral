// p10-approval-pause: park a stopped OpenCode session and resume it from a new adapter instance on the same state dir.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createOpenCodeAdapter,
  InvalidSpawnContextError,
  SessionNotFoundError,
  SessionStateError,
} from '../src/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'fake-opencode.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-oc-park-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FAST = {
  startupMs: 10_000,
  cancelGraceMs: 500,
  cancelMs: 3_000,
  approvalMs: 5_000,
  maxDurationMs: 60_000,
};

const adapter = (stateDir: string) =>
  createOpenCodeAdapter({
    command: process.execPath,
    commandArgs: [FAKE],
    stateDir,
    authMode: 'secret-ref',
    model: 'fake/scripted',
    platform: { os: 'darwin', arch: 'arm64' },
    env: {},
  });

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('opencode adapter: park and resume (p10-approval-pause)', () => {
  it('parks a session stopped while waiting for an approval and resumes it from a new instance', async () => {
    const stateDir = join(root, 'state', randomUUID());
    const ws = workspace();
    const first = adapter(stateDir);
    await first.probe();
    const ref = await first.spawn(spawnContext('opencode', ws, { timeouts: FAST }));
    await first.sendPrompt(ref, { text: 'faux:approval' });
    await waitFor(first, ref, (e) => e.event.kind === 'approval_request', 10_000);
    await first.cancel(ref, 'paused');
    const parked = await first.parkSession(ref);
    expect(parked.runtime).toBe('opencode');
    expect(parked.runtimeSessionId).toBe(ref.runtimeSessionId);
    const storage = parked.state?.storage ?? '';
    expect(storage).toMatch(/^storage\/[0-9a-f-]{36}$/);
    expect(isAbsolute(storage)).toBe(false);
    await first.cleanup(ref);
    expect(existsSync(join(stateDir, storage))).toBe(true);

    const second = adapter(stateDir);
    await second.probe();
    const resumed = await second.resumeParked(spawnContext('opencode', ws, { timeouts: FAST }), parked);
    expect(resumed.runtimeSessionId).toBe(parked.runtimeSessionId);
    await second.sendPrompt(resumed, { text: 'faux:history' });
    const events = (await drain(second, resumed, 10_000)).map((e) => e.event);
    // The resumed server answers from the kept history of the parked session (the earlier user prompt is in it).
    expect(events).toContainEqual({ kind: 'message', role: 'assistant', text: 'history:2' });
    await second.cleanup(resumed);
  });

  it('refuses to park a running session', async () => {
    const a = adapter(join(root, 'state', randomUUID()));
    await a.probe();
    const ref = await a.spawn(spawnContext('opencode', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:long' });
    await waitFor(a, ref, (e) => e.event.kind === 'status' && e.event.phase === 'running', 10_000);
    await expect(a.parkSession(ref)).rejects.toBeInstanceOf(SessionStateError);
    await a.cleanup(ref);
  });

  it('refuses tampered, foreign or missing parked state', async () => {
    const stateDir = join(root, 'state', randomUUID());
    const ws = workspace();
    const first = adapter(stateDir);
    await first.probe();
    const ref = await first.spawn(spawnContext('opencode', ws, { timeouts: FAST }));
    await first.sendPrompt(ref, { text: 'faux:basic' });
    await drain(first, ref, 10_000);
    const parked = await first.parkSession(ref);
    await first.cleanup(ref);
    const second = adapter(stateDir);
    await second.probe();
    const c = spawnContext('opencode', ws, { timeouts: FAST });
    for (const s of ['/etc', '../outside', 'storage/../../x', `storage/${randomUUID()}`]) {
      await expect(second.resumeParked(c, { ...parked, state: { storage: s } })).rejects.toBeInstanceOf(
        InvalidSpawnContextError,
      );
    }
    await expect(second.resumeParked(c, { ...parked, runtimeSessionId: 'nope' })).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
    await expect(second.resumeParked(c, { ...parked, runtime: 'pi' })).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
    await expect(
      second.resumeParked(c, { runtime: 'opencode', runtimeSessionId: 'ses_unknown1' }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('gates the resume on the resume capability', async () => {
    const a = adapter(join(root, 'state', randomUUID()));
    // Not probed: every capability is unverified; without allowUnverified the resume is refused.
    await expect(
      a.resumeParked(spawnContext('opencode', workspace(), { timeouts: FAST }), {
        runtime: 'opencode',
        runtimeSessionId: 'ses_abc123',
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });
});
