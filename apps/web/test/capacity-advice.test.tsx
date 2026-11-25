import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CapacityAdvice, type Parallelism, parseOverview } from '../src/api/fleet';
import { adviceSentence, formatGb } from '../src/screens/fleet/capacityAdvice';

const ID = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const GiB = 2 ** 30;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ADVICE: CapacityAdvice = {
  recommended: 3,
  limitedBy: 'cpu',
  cpuCount: 4,
  memoryBytes: 8 * GiB,
  reserveBytes: 2 * GiB,
  perJobBytes: 1.5 * GiB,
  byCpu: 3,
  byMemory: 4,
  basis: {
    runtime: 'claude-code',
    peakBytes: 1.2 * GiB,
    perJobBytes: 1.5 * GiB,
    source: 'measured',
    attempts: 7,
  },
  runtimes: [
    { runtime: 'claude-code', peakBytes: 1.2 * GiB, perJobBytes: 1.5 * GiB, source: 'measured', attempts: 7 },
  ],
};

function overview(
  parallelism: Parallelism | null,
  advice: CapacityAdvice | null = ADVICE,
): Record<string, unknown> {
  return {
    id: ID,
    capacity: { running: 0, max: parallelism?.effective ?? null },
    capabilitiesAt: '2026-10-15T10:00:00.000Z',
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: { key: '10.0.0.0/24', label: '10.0.0.0/24 (private)' },
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: [{ runtime: 'claude-code', status: 'ready', version: '2.1.0', reason: 'ready' }],
    parallelism,
    advice,
  };
}

describe('capacity advice texts (p6-capacity-advice)', () => {
  it('says the recommendation in one sentence', () => {
    expect(adviceSentence(ADVICE)).toBe(
      'Recommended: 3 parallel jobs — 4 CPUs, 8 GB RAM, Claude Code peaks ~1.2 GB',
    );
    expect(
      adviceSentence({
        ...ADVICE,
        recommended: 1,
        basis: { ...ADVICE.basis, source: 'default', peakBytes: 1.5 * GiB },
      }),
    ).toBe('Recommended: 1 parallel job — 4 CPUs, 8 GB RAM, Claude Code needs ~1.5 GB');
    expect(formatGb(16 * GiB)).toBe('16 GB');
  });

  it('parses overviews from older masters without the fields', () => {
    const body = { workers: [{ ...overview(null), parallelism: undefined, advice: undefined }] };
    const [o] = parseOverview(JSON.parse(JSON.stringify(body)));
    expect(o?.parallelism).toBeNull();
    expect(o?.advice).toBeNull();
  });
});
