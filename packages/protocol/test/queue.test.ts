import { describe, expect, it } from 'vitest';
import {
  Capabilities,
  classifyDecline,
  clampToClass,
  DEFAULT_TRANSIENT_RETRY_MS,
  JobFamily,
  parseFrame,
  PRIORITY_CLASS_VALUE,
  priorityClassOf,
  PROFILE_SLOTS_FEATURE,
  SUBTASK_BLOCKED_BY_PARENT,
  SubtaskStatusPayload,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { envelope, jobId, lease, workerId, workerMessages } from './fixtures.js';

describe('p9-queue-priority protocol', () => {
  it('LEASE_ACK accepts a structured decline kind and retry hint, and stays valid without them', () => {
    const declined = envelope('LEASE_ACK', {
      workerId,
      jobId,
      payload: {
        ...lease,
        accepted: false,
        reason: 'busy',
        declineKind: 'transient',
        retryAfterMs: 5000,
      },
    });
    const res = parseFrame(WorkerToMaster, JSON.stringify(declined));
    expect(res.ok).toBe(true);
    expect(parseFrame(WorkerToMaster, JSON.stringify(workerMessages.LEASE_ACK)).ok).toBe(true);
    const bad = envelope('LEASE_ACK', {
      workerId,
      jobId,
      payload: { ...lease, accepted: false, declineKind: 'maybe' },
    });
    expect(parseFrame(WorkerToMaster, JSON.stringify(bad)).ok).toBe(false);
  });

  it('CAPABILITIES carries per-profile concurrency and exclusive profiles (optional, bounded)', () => {
    const base = workerMessages.CAPABILITIES;
    const withSlots = {
      ...base,
      payload: {
        ...(base.payload as object),
        features: [PROFILE_SLOTS_FEATURE],
        profileConcurrency: { container: 3, 'host-restricted': 1, unconfined: 1 },
        exclusiveProfiles: ['host-restricted', 'unconfined'],
      },
    };
    expect(Capabilities.safeParse(withSlots).success).toBe(true);
    const tooMany = {
      ...withSlots,
      payload: { ...withSlots.payload, profileConcurrency: { container: 65 } },
    };
    expect(Capabilities.safeParse(tooMany).success).toBe(false);
    const unknownProfile = {
      ...withSlots,
      payload: { ...withSlots.payload, profileConcurrency: { vm: 1 } },
    };
    expect(Capabilities.safeParse(unknownProfile).success).toBe(false);
    expect(WorkerFeature.options).toContain('profile-slots-v1');
    // p9-queue-local-login-accounting: CAPABILITIES.localLogin (additive).
    const withLogin = {
      ...withSlots,
      payload: {
        ...withSlots.payload,
        localLogin: { runtimes: ['claude-code', 'codex'], exclusiveProfiles: ['host-restricted'] },
      },
    };
    const parsed = Capabilities.safeParse(withLogin);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.payload.localLogin).toEqual({
      runtimes: ['claude-code', 'codex'],
      exclusiveProfiles: ['host-restricted'],
    });
    const badRuntime = {
      ...withSlots,
      payload: { ...withSlots.payload, localLogin: { runtimes: ['gpt'], exclusiveProfiles: [] } },
    };
    expect(Capabilities.safeParse(badRuntime).success).toBe(false);
    // p9-subjob-local-login-deadlock: the login store of each runtime (additive).
    const withStores = {
      ...withSlots,
      payload: {
        ...withSlots.payload,
        localLogin: {
          runtimes: ['claude-code', 'codex'],
          exclusiveProfiles: ['host-restricted'],
          stores: { 'claude-code': 'claude', codex: 'codex' },
        },
      },
    };
    expect(Capabilities.safeParse(withStores).data?.payload.localLogin?.stores).toEqual({
      'claude-code': 'claude',
      codex: 'codex',
    });
    for (const stores of [{ 'claude-code': '../.claude' }, { gpt: 'x' }, { codex: '' }]) {
      const bad = {
        ...withStores,
        payload: { ...withStores.payload, localLogin: { ...withStores.payload.localLogin, stores } },
      };
      expect(Capabilities.safeParse(bad).success, JSON.stringify(stores)).toBe(false);
    }
  });

  it('ASSIGN_JOB execution.family and SUBTASK_STATUS blocked_by_parent (p9-subjob-local-login-deadlock)', () => {
    expect(JobFamily.safeParse({ rootJobId: '00000000-0000-4000-8000-0000000000aa' }).success).toBe(true);
    expect(JobFamily.safeParse({ rootJobId: 'not-a-uuid' }).success).toBe(false);
    const status = SubtaskStatusPayload.safeParse({
      attemptId: '00000000-0000-4000-8000-000000000001',
      epoch: 1,
      requestId: '00000000-0000-4000-8000-000000000002',
      state: 'queued',
      subtaskId: '00000000-0000-4000-8000-000000000003',
      reason: SUBTASK_BLOCKED_BY_PARENT,
      detail: 'This sub-job cannot start while this job runs …',
    });
    expect(status.success).toBe(true);
  });

  it('classifies declines: structured kind wins, legacy busy texts are transient, the rest permanent', () => {
    expect(classifyDecline('anything', 'transient', 2000)).toEqual({ kind: 'transient', retryAfterMs: 2000 });
    expect(classifyDecline('without filesystem confinement …', 'permanent')).toEqual({
      kind: 'permanent',
      retryAfterMs: null,
    });
    // The exact production text of worker 1.0.27 (Windows host-restricted, T-SBX-4).
    const prod =
      'sandbox_unavailable (profile_unsupported_on_os): without filesystem confinement concurrent attempts cannot be isolated from each other (T-SBX-4); remedy: retry when the running attempt finishes, or set maxParallelJobs to 1 for this worker';
    expect(classifyDecline(prod)).toEqual({ kind: 'transient', retryAfterMs: DEFAULT_TRANSIENT_RETRY_MS });
    expect(
      classifyDecline(
        'sandbox_unavailable (profile_unsupported_on_os): unconfined attempts share the worker account and its files; they run one at a time (T-SBX-4); remedy: x',
      ).kind,
    ).toBe('transient');
    expect(classifyDecline('worker cannot take jobs now: capacity reached (3/3)').kind).toBe('transient');
    expect(classifyDecline('worker is shutting down').kind).toBe('transient');
    expect(
      classifyDecline(
        'sandbox_unavailable (host_restricted_not_opted_in): host-native execution needs an explicit project policy opt-in',
      ).kind,
    ).toBe('permanent');
    expect(classifyDecline(undefined).kind).toBe('permanent');
    // Clamped retry hints.
    expect(classifyDecline('x', 'transient', 0).retryAfterMs).toBe(1000);
    expect(classifyDecline('x', 'transient', 99_999_999).retryAfterMs).toBe(3_600_000);
  });

  it('maps numeric priorities to classes by band and clamps into a band', () => {
    expect(PRIORITY_CLASS_VALUE).toEqual({ urgent: 50, normal: 0, background: -50 });
    expect(priorityClassOf(50)).toBe('urgent');
    expect(priorityClassOf(100)).toBe('urgent');
    expect(priorityClassOf(49)).toBe('normal');
    expect(priorityClassOf(-49)).toBe('normal');
    expect(priorityClassOf(-50)).toBe('background');
    expect(priorityClassOf(0)).toBe('normal');
    expect(clampToClass(70, 'normal')).toBe(49);
    expect(clampToClass(-3, 'urgent')).toBe(50);
    expect(clampToClass(-200, 'background')).toBe(-100);
  });
});
