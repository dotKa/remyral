// p10-approval-pause: park a stopped Pi session and resume it from a new adapter instance on the same state dir.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createPiAdapter,
  InvalidSpawnContextError,
  SessionNotFoundError,
  SessionStateError,
} from '../src/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'fake-pi.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-pi-park-'));
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

const adapter = (stateDir: string, env: Record<string, string> = {}) =>
  createPiAdapter({
    command: process.execPath,
    commandArgs: [FAKE],
    stateDir,
    authMode: 'secret-ref',
    model: 'remyral-faux/scripted',
    platform: { os: 'darwin', arch: 'arm64' },
    env,
  });

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('pi adapter: park and resume (p10-approval-pause)', () => {
  it('parks a session stopped while waiting for an approval and resumes it with --session-id from a new instance', async () => {
    const stateDir = join(root, 'state', randomUUID());
    const ws = workspace();
    const first = adapter(stateDir);
    await first.probe();
    const ref = await first.spawn(spawnContext('pi', ws, { timeouts: FAST }));
    await first.sendPrompt(ref, { text: 'faux:approval' });
    await waitFor(first, ref, (e) => e.event.kind === 'approval_request', 10_000);
    await first.cancel(ref, 'paused');
    const parked = await first.parkSession(ref);
    expect(parked.runtime).toBe('pi');
    expect(parked.runtimeSessionId).toBe(ref.runtimeSessionId);
    const rel = parked.state?.transcripts ?? '';
    expect(rel).toBe(`transcripts/${parked.runtimeSessionId}`);
    expect(isAbsolute(rel)).toBe(false);
    await first.cleanup(ref);
    expect(existsSync(join(stateDir, rel))).toBe(true);

    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const second = adapter(stateDir, { FAKE_PI_ARGV_FILE: argvFile });
    await second.probe();
    const resumed = await second.resumeParked(spawnContext('pi', ws, { timeouts: FAST }), parked);
    expect(resumed.runtimeSessionId).toBe(parked.runtimeSessionId);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(parked.runtimeSessionId);
    expect(argv[argv.indexOf('--session-dir') + 1]).toBe(join(stateDir, rel));
    await second.sendPrompt(resumed, { text: 'faux:basic' });
    await drain(second, resumed, 10_000);
    expect((await second.collectResult(resumed)).outcome).toBe('succeeded');
    await second.cleanup(resumed);
  });

  it('refuses to park a running session', async () => {
    const a = adapter(join(root, 'state', randomUUID()));
    await a.probe();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:long' });
    await waitFor(a, ref, (e) => e.event.kind === 'status' && e.event.phase === 'running', 10_000);
    await expect(a.parkSession(ref)).rejects.toBeInstanceOf(SessionStateError);
    await a.cleanup(ref);
  });

  it('refuses tampered, foreign or missing parked state', async () => {
    const a = adapter(join(root, 'state', randomUUID()));
    await a.probe();
    const c = spawnContext('pi', workspace(), { timeouts: FAST });
    const id = randomUUID();
    for (const transcripts of ['/etc', '../outside', 'transcripts/../../x', `transcripts/${randomUUID()}`]) {
      await expect(
        a.resumeParked(c, { runtime: 'pi', runtimeSessionId: id, state: { transcripts } }),
      ).rejects.toBeInstanceOf(InvalidSpawnContextError);
    }
    await expect(a.resumeParked(c, { runtime: 'pi', runtimeSessionId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
    await expect(a.resumeParked(c, { runtime: 'codex', runtimeSessionId: id })).rejects.toBeInstanceOf(
      InvalidSpawnContextError,
    );
    await expect(a.resumeParked(c, { runtime: 'pi', runtimeSessionId: id })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('gates the resume on the resume capability', async () => {
    const a = adapter(join(root, 'state', randomUUID()));
    // Not probed: every capability is unverified; without allowUnverified the resume is refused.
    await expect(
      a.resumeParked(spawnContext('pi', workspace(), { timeouts: FAST }), {
        runtime: 'pi',
        runtimeSessionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });
});
