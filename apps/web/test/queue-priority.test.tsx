import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseQueue, priorityClassOf, slotsLabel } from '../src/api/queue';
import { USER } from './helpers';

/** p9-queue-priority: Jobs → Queue (order, reasons, estimates, drag and drop, run now), classes in composer and chat. */

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

function entry(id: string, position: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: id,
    project: 'acme',
    title: `Job ${String(position)}\nmore text`,
    runtime: 'claude-code',
    sandboxProfile: 'host-restricted',
    state: 'QUEUED',
    priority: 0,
    storedPriority: 0,
    priorityClass: 'normal',
    adjusted: null,
    position,
    waitingSince: '2026-10-17T10:00:00.000Z',
    waitingSec: 125,
    category: 'profile_slot',
    reasons: [
      {
        code: 'no_free_profile_slot',
        category: 'profile_slot',
        message: 'waiting: desktop-pc busy for host-restricted (1/1 host-restricted slot in use)',
      },
    ],
    estimatedStart: '2026-10-17T10:30:00.000Z',
    createdBy: USER.id,
    canReorder: true,
    ...over,
  };
}

function queue(jobs: Record<string, unknown>[]): Record<string, unknown> {
  return {
    generatedAt: '2026-10-17T10:02:05.000Z',
    total: jobs.length,
    estimateNote: 'Estimated start: from the median duration; an estimate, not a promise.',
    pools: [
      {
        key: 'host-restricted',
        profile: 'host-restricted',
        machines: [{ id: W, name: 'desktop-pc', slots: 3, profileSlots: 1, running: 1, urgentReserve: 1 }],
        jobs,
      },
    ],
  };
}

describe('queue API helpers', () => {
  it('parses the queue and labels slots "3 slots (host: 1)"', () => {
    const q = parseQueue(queue([entry(A, 1), entry(B, 2, { priorityClass: 'urgent', priority: 50 })]));
    expect(q.pools[0]?.jobs.map((j) => j.priorityClass)).toEqual(['normal', 'urgent']);
    expect(slotsLabel(3, { 'host-restricted': 1, container: 3 })).toBe('3 slots (host: 1)');
    expect(slotsLabel(3, { 'host-restricted': 1, unconfined: 1 })).toBe('3 slots (host: 1, unconfined: 1)');
    expect(slotsLabel(1, null)).toBe('1 slot');
    expect([priorityClassOf(50), priorityClassOf(49), priorityClassOf(-50)]).toEqual([
      'urgent',
      'normal',
      'background',
    ]);
  });
});

/** p9-queue-local-login-accounting: subscription logins run one at a time (category, pool header, reserve). */
