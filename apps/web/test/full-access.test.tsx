import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePreview } from '../src/api/composer';

/** p5-full-access (ADR-0020): Projects → Full access preset, composer toggle and defaults, chat draft badge. */

configure({ asyncUtilTimeout: 5_000 });

const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'];

interface PreviewBody {
  runtime?: string;
  sandboxProfile?: string;
  sourceTrust?: string;
  approvalPolicy?: string;
}

/**
 * A Windows-like fleet: one worker with host-restricted and unconfined ready, no container engine. Availability
 * depends on the requested sandbox exactly as the master computes it.
 */
function preview(b: PreviewBody, over: Record<string, unknown> = {}) {
  const profile = b.sandboxProfile ?? 'container';
  const ready = profile === 'host-restricted' || profile === 'unconfined';
  return {
    project: 'genel',
    hostExecution: true,
    unconfinedExecution: true,
    autoApproveExecution: true,
    fullAccess: { available: true, reasons: [], workers: [W1] },
    sandboxProfile: profile,
    issues: [],
    placement:
      b.runtime === undefined
        ? null
        : {
            runtime: b.runtime,
            verdict: ready ? 'placed' : 'infeasible',
            holds: [],
            candidates: ready ? [{ workerId: W1, score: 1 }] : [],
            rejected: [],
            summary: [],
          },
    runtimes: RUNTIMES.map((runtime) =>
      ready && runtime === 'claude-code'
        ? { runtime, verdict: 'placed', eligible: [W1], feasible: [W1], summary: [] }
        : {
            runtime,
            verdict: 'infeasible',
            eligible: [],
            feasible: [],
            summary: [
              {
                code: ready ? 'runtime_not_installed' : 'sandbox_profile_unavailable',
                permanent: true,
                message: ready
                  ? `${runtime} is not installed`
                  : `sandbox profile ${profile} is not ready (ready: host-restricted, unconfined)`,
                workers: [W1],
              },
            ],
          },
    ),
    modelProfiles: [],
    sandbox: [
      { profile: 'container', workers: [] },
      { profile: 'runtime-sandbox', workers: [] },
      { profile: 'host-restricted', workers: [W1] },
      { profile: 'unconfined', workers: [W1] },
    ],
    limits: {},
    workers: [
      {
        id: W1,
        name: 'windows-worker-1',
        state: 'online',
        connected: true,
        os: 'win32',
        arch: 'x64',
        tools: [],
      },
    ],
    ...over,
  };
}

/** Waits for the project's defaults (a runtime is chosen) and opens the composer's Where section. */
describe('helpers', () => {
  it('an older master without full-access fields means "not available"', () => {
    const p = parsePreview({ ...preview({}), autoApproveExecution: undefined, fullAccess: undefined });
    expect(p.autoApproveExecution).toBe(false);
    expect(p.fullAccess.available).toBe(false);
    expect(p.fullAccess.reasons[0]?.code).toBe('approval_policy_unsupported');
  });
});
