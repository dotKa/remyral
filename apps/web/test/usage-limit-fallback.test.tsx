import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStatus } from '../src/api/chat';
import {
  describeUsageLimitPolicy,
  parseProjectPolicy,
  usageLimitPolicyProblem,
} from '../src/api/usageLimits';
import { describeReason, KNOWN_REASON_CODES } from '../src/lib/reasons';

/**
 * p11-usage-limit-fallback (docs/design/p11-usage-limit-fallback.md): Projects → Policy → Usage limits (inherit / own,
 * fallbacks in order, paid fallbacks opt-in with the cost estimate, step-up), the job page's usage-limit pause panel,
 * the fallback notice, the machine card's "usage limit reached — resets at", the reason texts and the chat status.
 */

configure({ asyncUtilTimeout: 5_000 });

const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEFAULTS = { mode: 'auto', maxWaitHours: 6, fallbacks: [], allowPaidFallback: false };

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'acme',
    own: null,
    effective: DEFAULTS,
    source: 'default',
    defaults: DEFAULTS,
    fallbacks: [],
    updatedAt: null,
    ...over,
  };
}

describe('Projects → Policy → Usage limits', { timeout: 20_000 }, () => {
  it('policy helpers', () => {
    expect(
      describeUsageLimitPolicy({ mode: 'auto', maxWaitHours: 6, fallbacks: [], allowPaidFallback: false }),
    ).toContain('within 6 h');
    expect(
      usageLimitPolicyProblem({
        mode: 'auto',
        maxWaitHours: 6,
        fallbacks: [{ runtime: 'codex' }, { runtime: 'codex' }],
        allowPaidFallback: false,
      }),
    ).toContain('once');
    expect(parseProjectPolicy(view()).source).toBe('default');
  });
});

describe('machine cards, reasons, chat status', () => {
  it('the new reason codes have texts', () => {
    expect(KNOWN_REASON_CODES).toEqual(
      expect.arrayContaining(['usage_limited', 'paid_fallback_not_allowed']),
    );
    expect(describeReason('paid_fallback_not_allowed', { workerName: 'WIN-WORKER-1' }).sentence).toContain(
      'API key on WIN-WORKER-1',
    );
  });

  it('the chat status carries the fallback and the limit (older masters: none)', () => {
    const base = {
      enabled: true,
      available: true,
      code: null,
      message: null,
      worker: { id: W1, name: 'WIN-WORKER-1', online: true },
      runtime: 'codex',
      model: null,
      limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
    };
    const s = parseStatus({
      ...base,
      fallback: true,
      limit: { runtime: 'claude-code', until: '2026-10-18T15:00:00.000Z', resetAt: null },
    });
    expect(s.fallback).toBe(true);
    expect(s.limit?.runtime).toBe('claude-code');
    expect(parseStatus(base).limit).toBeNull();
  });
});
