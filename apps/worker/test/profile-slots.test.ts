import { describe, expect, it } from 'vitest';
import { profileSlots } from '../src/sandbox/profile-slots.js';

describe('profileSlots (p9-queue-priority, profile-slots-v1)', () => {
  it('Windows host profiles without filesystem confinement: one attempt, alone on the worker', () => {
    expect(
      profileSlots({
        maxParallelJobs: 3,
        profiles: ['host-restricted', 'unconfined'],
        filesystemConfinement: 'none',
      }),
    ).toEqual({
      profileConcurrency: { 'host-restricted': 1, unconfined: 1 },
      exclusiveProfiles: ['host-restricted', 'unconfined'],
    });
  });

  it('macOS with Seatbelt: host profiles are bounded by maxParallelJobs; unconfined stays exclusive', () => {
    expect(
      profileSlots({
        maxParallelJobs: 3,
        profiles: ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'],
        filesystemConfinement: 'seatbelt',
      }),
    ).toEqual({
      profileConcurrency: { container: 3, 'runtime-sandbox': 3, 'host-restricted': 3, unconfined: 1 },
      exclusiveProfiles: ['unconfined'],
    });
  });

  it('Windows with per-job accounts (ADR-0034): host slots from the runner, not exclusive', () => {
    expect(
      profileSlots({
        maxParallelJobs: 3,
        profiles: ['host-restricted', 'unconfined'],
        filesystemConfinement: 'job_user',
        hostConcurrency: 2,
      }),
    ).toEqual({
      profileConcurrency: { 'host-restricted': 2, unconfined: 1 },
      exclusiveProfiles: ['unconfined'],
    });
    // Never above the worker's slots.
    expect(
      profileSlots({
        maxParallelJobs: 2,
        profiles: ['host-restricted'],
        filesystemConfinement: 'job_user',
        hostConcurrency: 5,
      }).profileConcurrency,
    ).toEqual({ 'host-restricted': 2 });
  });

  it('a worker with no slots reports 0 everywhere', () => {
    expect(
      profileSlots({
        maxParallelJobs: 0,
        profiles: ['container', 'unconfined'],
        filesystemConfinement: 'none',
      }).profileConcurrency,
    ).toEqual({ container: 0, unconfined: 0 });
  });

  // p9-queue-local-login-accounting: CAPABILITIES.localLogin mirrors selectProfile's local-login rule.
  it('per-job Windows accounts + subscription logins: localLogin lists the runtimes and the host profiles', () => {
    expect(
      profileSlots({
        maxParallelJobs: 3,
        profiles: ['host-restricted', 'unconfined'],
        filesystemConfinement: 'job_user',
        hostConcurrency: 3,
        localLoginRuntimes: ['codex', 'claude-code', 'codex'],
      }),
    ).toEqual({
      profileConcurrency: { 'host-restricted': 3, unconfined: 1 },
      exclusiveProfiles: ['unconfined'],
      // p9-subjob-local-login-deadlock: the login store of each runtime (one attempt per store at a time).
      localLogin: {
        runtimes: ['claude-code', 'codex'],
        exclusiveProfiles: ['host-restricted'],
        stores: { 'claude-code': 'claude', codex: 'codex' },
      },
    });
  });

  it('no localLogin without subscription-login runtimes, without per-job accounts, or without host profiles', () => {
    const base = { maxParallelJobs: 3, hostConcurrency: 3 } as const;
    expect(
      profileSlots({ ...base, profiles: ['host-restricted'], filesystemConfinement: 'job_user' }).localLogin,
    ).toBeUndefined();
    expect(
      profileSlots({
        ...base,
        profiles: ['host-restricted'],
        filesystemConfinement: 'seatbelt',
        localLoginRuntimes: ['claude-code'],
      }).localLogin,
    ).toBeUndefined();
    expect(
      profileSlots({
        ...base,
        profiles: ['host-restricted'],
        filesystemConfinement: 'none',
        localLoginRuntimes: ['claude-code'],
      }).localLogin,
    ).toBeUndefined();
    expect(
      profileSlots({
        ...base,
        profiles: ['container'],
        filesystemConfinement: 'job_user',
        localLoginRuntimes: ['claude-code'],
      }).localLogin,
    ).toBeUndefined();
  });
});
