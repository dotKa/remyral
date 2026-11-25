import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PackageCaches, parseOverview } from '../src/api/fleet';

/** p6-warm-caches (ADR-0029): the machine's Package caches card and the project setting. */

const GiB = 2 ** 30;

const CACHES: PackageCaches = {
  enabled: true,
  disabledReason: null,
  maxBytes: 10 * GiB,
  usedBytes: 3 * GiB,
  projects: [
    {
      projectId: 'alpha',
      bytes: 2 * GiB,
      lastUsedAt: '2026-10-16T10:00:00.000Z',
      inUse: true,
      managers: [
        { manager: 'npm', bytes: 1.5 * GiB },
        { manager: 'yarn-berry', bytes: 0.5 * GiB },
      ],
    },
    {
      projectId: 'beta',
      bytes: GiB,
      lastUsedAt: '2026-10-15T10:00:00.000Z',
      inUse: false,
      managers: [{ manager: 'pip', bytes: GiB }],
    },
  ],
  truncated: false,
  scannedAt: '2026-10-16T10:05:00.000Z',
  lastEviction: { at: '2026-10-16T09:00:00.000Z', projects: 2, bytes: 4 * GiB },
  reportedAt: '2026-10-16T10:05:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('package cache texts', () => {
  it('parses overviews with and without the report', () => {
    const base = {
      id: 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      capacity: { running: 0, max: 1 },
      capabilitiesAt: null,
      sandboxProfiles: [],
      sandboxReadiness: [],
      tools: [],
      load: null,
      network: { key: 'k', label: 'l' },
      runtimePolicy: { assigned: null, effective: null, version: null, stage: null, inSync: false },
      release: { channel: 'stable', targetVersion: null, lastAttempt: null },
      compatibility: [],
      parallelism: null,
      advice: null,
    };
    const { disabledReason: _d, truncated: _t, ...wire } = CACHES;
    const [withIt] = parseOverview({ workers: [{ ...base, packageCaches: wire }] });
    expect(withIt?.packageCaches).toEqual(CACHES);
    const [without] = parseOverview({ workers: [base] });
    expect(without?.packageCaches).toBeNull();
  });
});
