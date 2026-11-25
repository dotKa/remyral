import { configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOverview, runtimeSummary } from '../src/api/runtimeUsage';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md): the runtime limits in the composer, the chat's job card,
 * the machine page and list, Home and Usage → Enforcement — values, colours by level, resets, sources, the hint and
 * the near-limit setting.
 */

configure({ asyncUtilTimeout: 5_000 });

const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = 'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.now();
const at = (ms: number): string => new Date(NOW + ms).toISOString();

function win(id: string, kind: string, used: number | null, level: string, reset?: string, extra = {}) {
  return {
    id,
    kind,
    usedPercent: used,
    level,
    ...(reset === undefined ? {} : { resetsAt: reset }),
    windowMinutes: kind === 'session' ? 300 : 10080,
    ...extra,
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    workerId: W1,
    workerName: 'desktop-pc',
    workerState: 'online',
    runtime: 'claude-code',
    auth: 'subscription',
    store: 'claude',
    source: 'probe',
    plan: 'max',
    available: true,
    observedAt: at(-2 * 60_000),
    stale: false,
    reports: true,
    level: 'ok',
    windows: [
      win('five_hour', 'session', 62, 'ok', at(2 * 3600_000), {
        history: [
          { at: at(-3 * 3600_000), usedPercent: 20 },
          { at: at(-60_000), usedPercent: 62 },
        ],
      }),
      win('seven_day', 'weekly', 34, 'ok', at(3 * 86400_000)),
    ],
    limit: null,
    ...over,
  };
}

function overview(entries: unknown[], other: unknown[] = []) {
  return {
    generatedAt: at(0),
    settings: { nearThreshold: 80, notifyNear: true, updatedAt: null },
    entries,
    otherLimits: other,
  };
}

beforeEach(() => {
  resetRuntimeUsageCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('texts and parsing', () => {
  it('runtime summary: the least-used store is shown; limited only when every store is', () => {
    const o = parseOverview(
      overview([
        entry({
          level: 'limited',
          limit: { kind: 'session', resetAt: at(3600_000), resumeAt: at(3600_000) },
        }),
        entry({ workerId: W2, workerName: 'mac-mini', windows: [win('five_hour', 'session', 10, 'ok')] }),
      ]),
    );
    const s = runtimeSummary(o.entries, 'claude-code');
    expect(s.best?.workerName).toBe('mac-mini');
    expect(s.stores).toBe(2);
    expect(s.level).toBe('ok');
    expect(runtimeSummary(o.entries, 'pi').best).toBeNull();
  });
});
