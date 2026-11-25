import { describe, expect, it } from 'vitest';
import {
  assistantUsageLimit,
  claudeRateLimitSignal,
  classifyProviderFailure,
  limitKindOf,
  parseResetTime,
  PROVIDER_USAGE_LIMIT,
  usageLimitFromError,
  usageLimitMessage,
  UsageLimitTracker,
} from '../src/index.js';
import { SessionCore } from '../src/runtimes/common/session-core.js';
import { SecretValue } from '../src/secrets.js';
import type { SpawnContext } from '../src/contract.js';

/**
 * p11-usage-limit-fallback: the typed `usage_limited` outcome — kind (5-hour / weekly / one model / spend / quota),
 * model scope, the runtime's words (redacted) and the reset — for the texts each runtime surfaces, and the line between
 * a usage limit, a login problem and a transient fault. Texts as the pinned binaries / provider APIs word them (Claude
 * Agent SDK 0.3.296 `SDKRateLimitInfo`, codex-rs `UsageLimitReachedError` Display, OpenAI / Anthropic / Gemini error
 * bodies OpenCode and Pi forward).
 */

// 2026-10-16T10:00:00Z = 13:00 in Europe/Istanbul.
const NOW = new Date('2026-10-16T10:00:00.000Z');
const IST = 'Europe/Istanbul';

describe('Claude Code: the SDK rate_limit_event names the window', () => {
  it.each([
    ['five_hour', 'session', false],
    ['seven_day', 'weekly', false],
    ['seven_day_opus', 'model_weekly', true],
    ['seven_day_sonnet', 'model_weekly', true],
    ['overage', 'spend', false],
  ] as const)('%s → %s (model-scoped: %s)', (type, kind, scoped) => {
    const s = claudeRateLimitSignal({ status: 'rejected', resetsAt: 1792177200, rateLimitType: type }, NOW);
    expect(s?.kind).toBe(kind);
    expect(s?.modelScoped === true).toBe(scoped);
    expect(s?.resetAt?.toISOString()).toBe(new Date(1792177200 * 1000).toISOString());
  });

  it('the canonical message keeps kind and model scope across the error event', () => {
    const msg = usageLimitMessage({
      resetAt: new Date('2026-10-16T12:00:00Z'),
      kind: 'model_weekly',
      modelScoped: true,
    });
    expect(msg).toBe(
      'provider usage limit reached [limit=model_weekly] [model]; resets at 2026-10-16T12:00:00.000Z',
    );
    const back = usageLimitFromError(PROVIDER_USAGE_LIMIT, msg, NOW);
    expect(back).toMatchObject({ kind: 'model_weekly', modelScoped: true });
    expect(back?.resetAt?.toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(back?.detail).toBeUndefined();
  });

  it('CLI texts: the 5-hour window, the weekly limit, the Opus weekly limit', () => {
    const fiveHour = usageLimitFromError(
      undefined,
      "You've hit your limit · resets 3pm (Europe/Istanbul)",
      NOW,
    );
    expect(fiveHour?.resetAt?.toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(fiveHour?.detail).toBe("You've hit your limit · resets 3pm (Europe/Istanbul)");
    const weekly = usageLimitFromError(undefined, 'Weekly limit reached ∙ resets Oct 20, 9am (UTC)', NOW);
    expect(weekly).toMatchObject({ kind: 'weekly' });
    expect(weekly?.resetAt?.toISOString()).toBe('2026-10-20T09:00:00.000Z');
    const opus = usageLimitFromError(undefined, 'Opus weekly limit reached ∙ resets Oct 20, 9am (UTC)', NOW);
    expect(opus).toMatchObject({ kind: 'model_weekly', modelScoped: true });
  });
});

describe('Codex: plan limits, model limits, spend caps', () => {
  it('"try again at" in the worker zone, "try again in" as a duration', () => {
    const at = usageLimitFromError(
      'codex_usageLimitExceeded',
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:30 PM.",
      NOW,
      IST,
    );
    expect(at?.resetAt?.toISOString()).toBe('2026-10-16T13:30:00.000Z');
    const inDuration = usageLimitFromError(
      'codex_usageLimitExceeded',
      "You've hit your usage limit. Try again in 2h 14m.",
      NOW,
    );
    expect(inDuration?.resetAt?.toISOString()).toBe('2026-10-16T12:14:00.000Z');
  });

  it('a limit of one model is model-scoped (another model still works)', () => {
    const s = usageLimitFromError(
      'codex_usageLimitExceeded',
      "You've hit your usage limit for gpt-5.5-codex. Switch to another model now, or try again at Oct 17th, 2026 3:15 PM.",
      NOW,
      IST,
    );
    expect(s).toMatchObject({ kind: 'model_weekly', modelScoped: true });
    expect(s?.resetAt?.toISOString()).toBe('2026-10-17T12:15:00.000Z');
  });

  it('workspace credits and spend caps are spend limits (no reset said)', () => {
    for (const text of [
      'Your workspace is out of credits. Add credits to continue.',
      'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
    ]) {
      const c = classifyProviderFailure(undefined, text, NOW);
      expect(c?.class, text).toBe('usage_limited');
      expect(c?.class === 'usage_limited' ? c.signal.kind : null, text).toBe('spend');
      expect(c?.class === 'usage_limited' ? c.signal.resetAt : 'x', text).toBeUndefined();
    }
  });
});

describe('OpenCode / Pi: provider bodies', () => {
  it('a usage_limit_reached body with resets_in_seconds', () => {
    const s = usageLimitFromError(
      'provider_api_error',
      '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":5400}}',
      NOW,
    );
    expect(s?.resetAt?.toISOString()).toBe('2026-10-16T11:30:00.000Z');
  });

  it('a 429 quota body with Retry-After seconds or an HTTP date', () => {
    const seconds = usageLimitFromError(
      'model_error',
      '429 You exceeded your current quota, please check your plan and billing details. retry-after: 120',
      NOW,
    );
    expect(seconds?.resetAt?.toISOString()).toBe('2026-10-16T10:02:00.000Z');
    expect(seconds?.kind).toBe('quota');
    const date = usageLimitFromError(
      'model_error',
      '429 RESOURCE_EXHAUSTED: Quota exceeded. Retry-After: Fri, 16 Oct 2026 11:00:00 GMT',
      NOW,
    );
    expect(date?.resetAt?.toISOString()).toBe('2026-10-16T11:00:00.000Z');
  });

  it('the shared session core reports the typed detail with the failure (redacted)', () => {
    const ctx = {
      secretEnv: { OPENAI_API_KEY: new SecretValue('sk-live-secret-123456') },
    } as unknown as SpawnContext;
    const c = new SessionCore({ sessionId: 's1', runtime: 'pi' }, ctx);
    c.emit({
      kind: 'error',
      code: 'model_error',
      message: 'You exceeded your current quota (key sk-live-secret-123456). Try again in 30 minutes.',
    });
    c.finish('failed', 'model_error');
    const fields = c.resetAt();
    expect(c.errorCode).toBe(PROVIDER_USAGE_LIMIT);
    expect(fields.resetAt).toBeDefined();
    expect(fields.usageLimit?.kind).toBe('quota');
    expect(fields.usageLimit?.message).not.toContain('sk-live-secret-123456');
  });
});

describe('classifyProviderFailure: limit vs login vs transient', () => {
  it('login problems are never waited out', () => {
    for (const [code, text] of [
      [undefined, '401 Unauthorized: invalid x-api-key'],
      ['authentication_failed', 'OAuth token has expired. Please run /login'],
      [undefined, 'Incorrect API key provided: sk-…'],
      ['login_expired', "You've hit your limit"],
    ] as const) {
      expect(classifyProviderFailure(code, text, NOW)?.class, text).toBe('auth');
    }
  });

  it('transient faults are not limits', () => {
    for (const [code, text] of [
      [undefined, 'API Error: 529 overloaded'],
      [undefined, '503 Service Unavailable'],
      ['overloaded', 'Overloaded'],
      [undefined, "This request would exceed your account's rate limit. Please try again later."],
      [undefined, 'socket hang up'],
    ] as const) {
      expect(classifyProviderFailure(code, text, NOW)?.class, text).toBe('transient');
    }
  });

  it('ordinary failures are neither', () => {
    expect(classifyProviderFailure('runtime_crashed', 'npm ERR! 404 Not Found', NOW)).toBeNull();
  });

  it('a limit with a 429 status is a limit, not a transient fault', () => {
    expect(
      classifyProviderFailure(undefined, '429 usage_limit_reached: resets_in_seconds: 60', NOW)?.class,
    ).toBe('usage_limited');
  });
});

describe('UsageLimitTracker: kind, scope and words accumulate; the latest reset wins', () => {
  it('SDK event + CLI text → one detail', () => {
    const t = new UsageLimitTracker();
    t.observe(
      claudeRateLimitSignal({ status: 'rejected', resetsAt: 1792177200, rateLimitType: 'seven_day' }, NOW),
    );
    t.observe(usageLimitFromError(undefined, 'Weekly limit reached · resets Oct 20, 9am (UTC)', NOW));
    const f = t.resultFields(PROVIDER_USAGE_LIMIT, (s) => s.replaceAll('9am', '[x]'));
    expect(f.usageLimit).toEqual({
      kind: 'weekly',
      message: 'Weekly limit reached · resets Oct 20, [x] (UTC)',
    });
    expect(f.resetAt).toBe('2026-10-20T09:00:00.000Z');
    expect(t.resultFields('runtime_crashed')).toEqual({});
  });
});

describe('assistant engines (worker host)', () => {
  it('a failed turn on a usage limit → provider_usage_limit with the reset; others stay', () => {
    const claude = assistantUsageLimit(
      PROVIDER_USAGE_LIMIT,
      usageLimitMessage(
        { resetAt: new Date('2026-10-16T12:00:00Z'), kind: 'session' },
        "You've hit your limit",
      ),
      NOW,
    );
    expect(claude).toEqual({ resetAt: '2026-10-16T12:00:00.000Z', detail: "You've hit your limit" });
    const pi = assistantUsageLimit('model_error', 'You exceeded your current quota', NOW);
    expect(pi?.detail).toBe('You exceeded your current quota');
    expect(assistantUsageLimit('turn_failed', 'API Error: 529 overloaded', NOW)).toBeNull();
    expect(assistantUsageLimit('result_error', 'OAuth token has expired', NOW)).toBeNull();
  });
});

describe('limitKindOf / parseResetTime edge cases', () => {
  it('kinds from wording', () => {
    expect(limitKindOf('5-hour limit reached')).toBe('session');
    expect(limitKindOf('Sonnet 4.5 weekly limit reached')).toBe('model_weekly');
    expect(limitKindOf('spend limit reached')).toBe('spend');
    expect(limitKindOf('something else')).toBeUndefined();
  });

  it('an HTTP-date Retry-After in the past is ignored', () => {
    expect(parseResetTime('Retry-After: Thu, 01 Jan 2026 00:00:00 GMT', NOW)).toBeUndefined();
  });
});
