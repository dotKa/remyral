import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '../src/api/memoryRecords';
import { buildNeedsYou } from '../src/screens/home/needsYou';
import { USER } from './helpers';

/** p11-memory-layers: typed memory records in the console (Memory tab, Profile, job page, chat card, Home). */

const R_RULE = '10000000-0000-4000-8000-000000000001';
const R_DEC = '10000000-0000-4000-8000-000000000002';
const R_FACT = '10000000-0000-4000-8000-000000000003';
const R_OLD = '10000000-0000-4000-8000-000000000004';
function rec(over: Partial<MemoryRecord> & { id: string }): Record<string, unknown> {
  return {
    namespace: 'project:alpha',
    type: 'rule',
    scope: 'project:alpha',
    project: 'alpha',
    runtime: null,
    status: 'active',
    title: 'Use pnpm',
    statement: 'Use pnpm, never npm.',
    rationale: null,
    consequences: null,
    decidedOn: null,
    decidedBy: null,
    content: 'Use pnpm, never npm.',
    version: 3,
    evidence: [],
    author: 'human',
    authorRef: null,
    acceptedBy: null,
    suggestionId: null,
    confidence: null,
    tags: [],
    reviewBy: null,
    reviewDue: false,
    expiresAt: null,
    supersedes: null,
    supersededBy: null,
    statusReason: null,
    statusChangedAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    canWrite: true,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Home → Needs you: memory reviews', () => {
  it('asks to review records whose review date has come, linking to where they live', () => {
    const parse = (v: Record<string, unknown>) => v as unknown as MemoryRecord;
    const items = buildNeedsYou(
      {
        approvals: [],
        failed: [],
        blocked: [],
        workers: [],
        overview: [],
        memoryReviews: [
          parse(rec({ id: R_RULE, reviewDue: true })),
          parse(rec({ id: R_FACT, type: 'fact', title: 'Global fact', scope: 'global', project: null })),
          parse(rec({ id: R_DEC, title: 'Mine', scope: `user:${USER.id}`, project: null })),
          parse(rec({ id: R_OLD, status: 'expired' })),
        ],
      },
      Date.parse('2026-10-19T10:00:00.000Z'),
    );
    const reviews = items.filter((i) => i.kind === 'memory-review');
    expect(reviews.map((i) => ('sentence' in i ? i.sentence : ''))).toEqual([
      'Review this rule: “Use pnpm” (project alpha).',
      'Review this fact: “Global fact” (global).',
      'Review this rule: “Mine” (personal rule).',
    ]);
    expect(reviews.map((i) => ('action' in i ? i.action.href : ''))).toEqual([
      `/projects/alpha?tab=memory&record=${R_RULE}`,
      `/settings/context?record=${R_FACT}`,
      '/settings/profile#personal-rules',
    ]);
  });
});
