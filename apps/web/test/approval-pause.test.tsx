import { configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePause } from '../src/api/approvalPause';
import { resetMachineDirectory } from '../src/lib/machineDirectory';

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md §9): the job page's pause panel (Resume now only after a
 * decision, Restart from scratch with a confirmation, Cancel), the Stale badge, Continue, the queue's paused section,
 * Project → Policy "Long approval waits" with step-up, and the approvals badges. Summaries are untrusted text.
 */

configure({ asyncUtilTimeout: 5_000 });

const REQ = '11111111-1111-4111-8111-111111111111';
const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOSTILE = '<img src=x onerror="window.__pwned=1">rm -rf build';

const t = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

function pause(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    status: 'paused',
    requestId: REQ,
    action: 'runtime.dangerous_tool',
    summary: HOSTILE,
    workerId: W1,
    workerName: 'WIN-WORKER-1',
    requestedAt: t(70),
    pausedAt: t(65),
    retainUntil: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    resumeMode: 'session',
    activeMs: 120_000,
    decision: null,
    decidedBy: null,
    decisionReason: null,
    resumeRequestedAt: null,
    blockedReason: null,
    endedAt: null,
    endReason: null,
    ...over,
  };
}

beforeEach(() => {
  resetMachineDirectory();
  delete (window as { __pwned?: unknown }).__pwned;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pause view parsing', () => {
  it('is lenient: odd or missing data reads as no pause', () => {
    expect(parsePause(null)).toBeNull();
    expect(parsePause({ id: 'p1', status: 'sleeping' })).toBeNull();
    const p = parsePause(pause({ resumeMode: 'teleport', activeMs: -5 }));
    expect(p).toMatchObject({ status: 'paused', resumeMode: null, activeMs: 0 });
  });
});
