import { PackageCacheReport } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { assignPayload } from '../../src/orchestration/messages.js';
import type { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { storedCacheReport } from '../../src/package-caches/service.js';

/** p6-warm-caches (ADR-0029): what the master sends and how it reads what workers report. */
describe('ASSIGN_JOB execution.packageCaches', () => {
  const signer = { sign: () => 'token' } as unknown as LeaseSigner;
  const lease = {
    id: '1',
    jobId: 'j',
    attemptId: 'a',
    workerId: 'w',
    epoch: 1,
    acquiredAt: new Date(0),
    expiresAt: new Date(60_000),
    releasedAt: null,
    releaseReason: null,
  };
  const spec = {
    runtime: 'codex',
    prompt: 'p',
    repository: { url: 'https://x.test/r.git', baseRef: 'main', workBranch: 'w' },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
  } as unknown as Parameters<typeof assignPayload>[1]['spec'];

  it('is sent only when the project allows the caches', () => {
    const on = assignPayload(signer, { lease, project: 'acme', spec, packageCaches: true }, new Date(0));
    expect(on.execution).toEqual({ hostExecutionOptIn: false, packageCaches: true });
    const off = assignPayload(signer, { lease, project: 'acme', spec, packageCaches: false }, new Date(0));
    expect(off.execution).not.toHaveProperty('packageCaches');
  });
});

describe('stored package cache reports', () => {
  const good = {
    enabled: true,
    maxBytes: 100,
    usedBytes: 10,
    projects: [
      {
        projectId: 'acme',
        bytes: 10,
        lastUsedAt: '2026-10-16T10:00:00.000Z',
        inUse: true,
        managers: [{ manager: 'pip', bytes: 10 }],
      },
    ],
    scannedAt: null,
  };

  it('re-validates what the worker sent; malformed reports count as none', () => {
    expect(storedCacheReport(good)).toEqual(PackageCacheReport.parse(good));
    expect(storedCacheReport(null)).toBeNull();
    expect(storedCacheReport({ ...good, usedBytes: -1 })).toBeNull();
    expect(
      storedCacheReport({
        ...good,
        projects: [{ ...good.projects[0], managers: [{ manager: 'maven', bytes: 1 }] }],
      }),
    ).toBeNull();
    // Paths never fit a project id.
    expect(
      storedCacheReport({ ...good, projects: [{ ...good.projects[0], projectId: '/var/lib/x' }] }),
    ).toBeNull();
  });
});
