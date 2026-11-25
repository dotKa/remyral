// p19-unconfined-parallel (docs/design/p19-unconfined-parallel.md): the machine setting "Sandbox’sız işler paralel
// çalışabilir" — attempts without filesystem confinement run beside each other and beside other attempts (up to
// maxParallelJobs) instead of alone. Off (default): every rule stays as it was.
import { type WorkerConfigDocument, workerConfigHash, workerConfigIssues } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { deriveCeiling } from '../src/config/ceiling.js';
import { type WorkerConfig, workerConfigSchema } from '../src/config/schema.js';
import { configReport, effectiveConfig } from '../src/managed-config/index.js';
import {
  type JobSandboxRequirements,
  type RunningAttempt,
  selectProfile,
  type WorkerSandboxCapabilities,
} from '../src/sandbox/policy.js';
import { profileSlots } from '../src/sandbox/profile-slots.js';

const job = (over: Partial<JobSandboxRequirements> = {}): JobSandboxRequirements => ({
  profile: 'unconfined',
  runtime: 'claude-code',
  sourceTrust: 'trusted',
  needsEgress: true,
  hostExecutionOptIn: true,
  unconfinedOptIn: true,
  authMode: 'secret-ref',
  family: 'job-a',
  projectId: 'p1',
  ...over,
});

const running = (over: Partial<RunningAttempt> = {}): RunningAttempt => ({
  family: 'job-b',
  projectId: 'p1',
  profile: 'unconfined',
  runtime: 'claude-code',
  authMode: 'secret-ref',
  ...over,
});

const caps = (
  attempts: readonly RunningAttempt[],
  over: Partial<WorkerSandboxCapabilities> = {},
): WorkerSandboxCapabilities => ({
  platform: 'linux',
  container: { ready: true },
  hostRestricted: { ready: true, filesystemConfinement: 'none', egressEnforced: false },
  runtimeSandboxes: ['claude-code'],
  unconfined: { ready: true },
  runningAttempts: attempts.length,
  attempts,
  ...over,
});

const ALL = ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'] as const;
const off = { allowedProfiles: ALL };
const on = { allowedProfiles: ALL, unconfinedParallel: true };

describe('profileSlots with unconfinedParallel', () => {
  it('off (default): unconfined and unconfined host profiles stay 1 and exclusive', () => {
    const input = {
      maxParallelJobs: 4,
      profiles: ['container', 'host-restricted', 'unconfined'] as const,
      filesystemConfinement: 'none' as const,
    };
    const expected = {
      profileConcurrency: { container: 4, 'host-restricted': 1, unconfined: 1 },
      exclusiveProfiles: ['host-restricted', 'unconfined'],
    };
    expect(profileSlots({ ...input, profiles: [...input.profiles] })).toEqual(expected);
    expect(profileSlots({ ...input, profiles: [...input.profiles], unconfinedParallel: false })).toEqual(
      expected,
    );
  });

  it('on: every profile without confinement is bounded by maxParallelJobs only, nothing exclusive', () => {
    expect(
      profileSlots({
        maxParallelJobs: 4,
        profiles: ['container', 'host-restricted', 'unconfined'],
        filesystemConfinement: 'none',
        unconfinedParallel: true,
      }),
    ).toEqual({
      profileConcurrency: { container: 4, 'host-restricted': 4, unconfined: 4 },
      exclusiveProfiles: [],
    });
    // Linux bubblewrap: runtime-sandbox (no view of its own) and unconfined become parallel too.
    expect(
      profileSlots({
        maxParallelJobs: 3,
        profiles: ['runtime-sandbox', 'host-restricted', 'unconfined'],
        filesystemConfinement: 'bwrap',
        unconfinedParallel: true,
      }),
    ).toEqual({
      profileConcurrency: { 'runtime-sandbox': 3, 'host-restricted': 3, unconfined: 3 },
      exclusiveProfiles: [],
    });
  });

  it('on: confined host slots keep their own bound (per-job accounts)', () => {
    expect(
      profileSlots({
        maxParallelJobs: 4,
        profiles: ['host-restricted', 'unconfined'],
        filesystemConfinement: 'job_user',
        hostConcurrency: 2,
        unconfinedParallel: true,
      }),
    ).toEqual({
      profileConcurrency: { 'host-restricted': 2, unconfined: 4 },
      exclusiveProfiles: [],
    });
  });
});

describe('selectProfile with unconfinedParallel', () => {
  it('off: unconfined waits for any running attempt (busy decline)', () => {
    const r = selectProfile(job(), caps([running({ profile: 'container' })]), off);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.busy).toBe(true);
      expect(r.error.remedy).toMatch(/Sandbox'sız işler paralel çalışabilir/);
    }
    expect(selectProfile(job(), caps([]), off)).toMatchObject({ ok: true, profile: 'unconfined' });
  });

  it('on: unconfined starts beside other unconfined and confined attempts', () => {
    const r = selectProfile(job(), caps([running(), running({ profile: 'container', family: 'job-c' })]), on);
    expect(r).toMatchObject({ ok: true, profile: 'unconfined' });
    if (r.ok) expect(r.notes.join(' ')).toMatch(/beside other attempts/);
  });

  it('on: the opt-in and readiness rules still apply', () => {
    expect(selectProfile(job({ unconfinedOptIn: false }), caps([]), on).ok).toBe(false);
    expect(selectProfile(job(), caps([], { unconfined: { ready: false } }), on).ok).toBe(false);
  });

  it('host profile without confinement: alone when off, beside others when on', () => {
    const host = job({ profile: 'host-restricted' });
    const busy = caps([running()]);
    const r = selectProfile(host, busy, off);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.busy).toBe(true);
    expect(selectProfile(host, busy, on)).toMatchObject({ ok: true, profile: 'host-restricted' });
  });

  it('Linux bubblewrap: a running unconfined attempt blocks host attempts only when off', () => {
    const bwrap = caps([running()], {
      hostRestricted: { ready: true, filesystemConfinement: 'bwrap', egressEnforced: false },
    });
    const host = job({ profile: 'host-restricted' });
    expect(selectProfile(host, bwrap, off).ok).toBe(false);
    expect(selectProfile(host, bwrap, on)).toMatchObject({ ok: true, profile: 'host-restricted' });
    // runtime-sandbox has no view of its own there: parallel only with the setting.
    const rs = job({ profile: 'runtime-sandbox' });
    expect(selectProfile(rs, bwrap, off).ok).toBe(false);
    expect(selectProfile(rs, bwrap, on)).toMatchObject({ ok: true, profile: 'runtime-sandbox' });
  });

  it('Windows per-job accounts: host attempts no longer wait for a running unconfined one when on', () => {
    const win = caps([running()], {
      platform: 'win32',
      hostRestricted: {
        ready: true,
        filesystemConfinement: 'job_user',
        concurrency: 2,
        egressEnforced: false,
      },
      hostAttempts: 0,
    });
    const host = job({ profile: 'host-restricted' });
    expect(selectProfile(host, win, off).ok).toBe(false);
    expect(selectProfile(host, win, on)).toMatchObject({ ok: true, profile: 'host-restricted' });
  });

  it('Windows per-job accounts: an unconfined subscription login never shares its login store', () => {
    const win = (attempts: readonly RunningAttempt[]) =>
      caps(attempts, {
        platform: 'win32',
        hostRestricted: {
          ready: true,
          filesystemConfinement: 'job_user',
          concurrency: 2,
          egressEnforced: false,
        },
        hostAttempts: 0,
      });
    const login = job({ authMode: 'local-login' });
    const r = selectProfile(login, win([running({ authMode: 'local-login' })]), on);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.busy).toBe(true);
    // Another runtime's login, or an API-key attempt, is no reason to wait.
    expect(selectProfile(login, win([running({ runtime: 'codex', authMode: 'local-login' })]), on).ok).toBe(
      true,
    );
    expect(selectProfile(login, win([running()]), on).ok).toBe(true);
  });
});

function configFrom(raw: Record<string, unknown>): WorkerConfig {
  const parsed = workerConfigSchema('linux').parse({
    masterUrl: 'wss://m.example.com/v1/worker',
    workspaceRoot: '/srv/work',
    ...raw,
  });
  const { dataDir: _d, $schema: _s, ...rest } = parsed;
  const base = { ...rest, dataDir: '/var/lib/rw', source: '/etc/remyral-worker/config.json' };
  return { ...base, ...deriveCeiling(raw, base) };
}

const DOC: WorkerConfigDocument = {
  schemaVersion: 1,
  projects: {},
  allowedRuntimes: ['codex'],
  maxParallelJobs: 3,
  sandboxProfiles: ['container', 'host-restricted'],
  workspace: {},
  labels: {},
  runtimes: {},
  allowUnconfined: true,
};

const delivery = (doc: WorkerConfigDocument) => ({
  generation: 1,
  documentHash: workerConfigHash(doc),
  issuedAt: '2026-10-30T10:00:00.000Z',
  document: doc,
});

describe('effective unconfinedParallel (panel ∩ local pin)', () => {
  it('panel value applies and is reported; the default is off', () => {
    const { config: offCfg } = effectiveConfig(configFrom({}), delivery(DOC));
    expect(offCfg.unconfinedParallel).toBeUndefined();
    const doc = { ...DOC, unconfinedParallel: true };
    const result = effectiveConfig(configFrom({}), delivery(doc));
    expect(result.config.unconfinedParallel).toBe(true);
    expect(result.blocked).toEqual([]);
    const report = configReport(configFrom({}), result, null, null);
    expect(report.effective.unconfinedParallel).toBe(true);
  });

  it('a local sandbox.unconfinedParallel pins it (false wins over the panel, reported blocked)', () => {
    const doc = { ...DOC, unconfinedParallel: true };
    const { config, blocked } = effectiveConfig(
      configFrom({ sandbox: { unconfinedParallel: false } }),
      delivery(doc),
    );
    expect(config.unconfinedParallel).toBeUndefined();
    expect(blocked).toContainEqual(
      expect.objectContaining({ path: 'unconfinedParallel', code: 'blocked_by_local_ceiling' }),
    );
    expect(
      effectiveConfig(configFrom({ sandbox: { unconfinedParallel: true } }), null).config.unconfinedParallel,
    ).toBe(true);
  });

  it('the document refuses the setting without allowUnconfined', () => {
    const { allowUnconfined: _a, ...without } = DOC;
    expect(workerConfigIssues({ ...without, unconfinedParallel: true })).toContainEqual({
      path: 'unconfinedParallel',
      code: 'unconfined_parallel_needs_allow',
    });
    expect(workerConfigIssues({ ...DOC, unconfinedParallel: true })).toEqual([]);
  });
});
