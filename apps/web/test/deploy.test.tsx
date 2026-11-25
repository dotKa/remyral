import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNeedsYou } from '../src/screens/home/needsYou';

/**
 * p6-deploy-integrations (ADR-0028): Settings → Integrations (Coolify / Cloudflare, tokens write-only, connection
 * tests), Project → Deploy (targets, policy, quick deploys), the Deploys page (diff, approve with step-up, rollback),
 * Home "Needs you" and the chat draft card for ops actions.
 */

configure({ asyncUtilTimeout: 5_000 });

const ACTION = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-16T08:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** p13-multi-coolify: the default Coolify connection as the master lists it (no token field). */
function action(over: Record<string, unknown> = {}) {
  return {
    id: ACTION,
    project: 'shop',
    kind: 'dns.upsert',
    env: null,
    params: {},
    target: { provider: 'cloudflare-dns', zone: 'example.org', name: 'shop.example.org', type: 'A' },
    diff: {
      action: 'update',
      zone: 'example.org',
      name: 'shop.example.org',
      type: 'A',
      before: { id: 'r1', content: '192.0.2.1', ttl: 1, proxied: true },
      after: { content: '192.0.2.2', ttl: 1, proxied: true },
    },
    policy: {
      decision: 'approval_step_up',
      reason: 'DNS changes need approval with step-up (project policy).',
    },
    state: 'awaiting_approval',
    requestedBy: { type: 'user', id: 'u2', username: 'oper1' },
    via: 'chat',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: '2026-10-17T08:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

describe('Home and chat', () => {
  it('Needs you lists ops actions waiting for approval', () => {
    const items = buildNeedsYou(
      {
        approvals: [],
        failed: [],
        blocked: [],
        workers: [],
        overview: [],
        opsActions: [action(), action({ id: 'done', state: 'succeeded' })],
      },
      Date.now(),
    );
    expect(items.map((i) => i.key)).toEqual([`deploy:${ACTION}`]);
    const first = items[0];
    expect(first?.kind === 'deploy' ? first.action.href : '').toBe(`/deploys/${ACTION}`);
    expect(first?.kind === 'deploy' ? first.sentence : '').toContain('DNS change in shop waits');
  });
});
