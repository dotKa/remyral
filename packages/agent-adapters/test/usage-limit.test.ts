import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ClaudeEventMapper,
  CodexEventMapper,
  claudeRateLimitSignal,
  isUsageLimitText,
  parseResetTime,
  PROVIDER_USAGE_LIMIT,
  usageLimitFromError,
  usageLimitMessage,
  UsageLimitTracker,
} from '../src/index.js';
import type { SpawnContext } from '../src/contract.js';
import { SessionCore } from '../src/runtimes/common/session-core.js';
import { OcEventMapper } from '../src/runtimes/opencode/events.js';
import { assistantText, resultSuccess } from './fixtures/claude-code/sdk-messages.js';

/**
 * p6-quota-scheduling: provider usage limits are recognised in what each runtime surfaces. The texts are the ones
 * the pinned binaries print (strings in claude 2.1.296 and codex-cli 0.162.1) and provider error bodies OpenCode /
 * Pi forward.
 */

// 2026-10-16T10:00:00Z = 13:00 in Europe/Istanbul (UTC+3, no DST).
const NOW = new Date('2026-10-16T10:00:00.000Z');
const IST = 'Europe/Istanbul';

describe('isUsageLimitText', () => {
  it('recognises subscription / quota limit wording of every runtime', () => {
    for (const text of [
      'Claude AI usage limit reached|1792177200',
      "You've hit your limit · resets 3pm (Europe/Istanbul)",
      'You’ve hit your monthly spend limit · resets Nov 1, 12am',
      'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:15 PM.',
      'You’ve hit your usage limit for gpt-5.5-codex. Switch to another model now, or try again at Oct 17th, 2026 3:15 PM.',
      'spend limit reached (daily; resets 2026-10-17 00:00 UTC) — request an increase',
      '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":5400}}',
      'You exceeded your current quota, please check your plan and billing details.',
      '429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric generate_content_requests',
      'Goal paused · usage limit reached · send a message after it resets to continue',
    ]) {
      expect(isUsageLimitText(text), text).toBe(true);
    }
  });

  it('does not flag transient rate limits or ordinary failures', () => {
    for (const text of [
      undefined,
      '',
      'API Error: 529 overloaded',
      "This request would exceed your account's rate limit. Please try again later.",
      'rate_limit',
      'Request was aborted.',
      'npm ERR! 404 Not Found',
      'the turn took too long',
    ]) {
      expect(isUsageLimitText(text), String(text)).toBe(false);
    }
  });
});

describe('parseResetTime', () => {
  it('reads the Claude wall time in the zone it names', () => {
    expect(parseResetTime("You've hit your limit · resets 3pm (Europe/Istanbul)", NOW)?.toISOString()).toBe(
      '2026-10-16T12:00:00.000Z',
    );
    // A time already past today is tomorrow's.
    expect(parseResetTime('resets 11am (Europe/Istanbul)', NOW)?.toISOString()).toBe(
      '2026-10-17T08:00:00.000Z',
    );
    expect(parseResetTime('resets Oct 18, 9:30am (UTC)', NOW)?.toISOString()).toBe(
      '2026-10-18T09:30:00.000Z',
    );
  });

  it('reads Codex "try again at" in the worker zone, with and without a date', () => {
    const msg =
      'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:15 PM.';
    expect(parseResetTime(msg, NOW, IST)?.toISOString()).toBe('2026-10-16T12:15:00.000Z');
    expect(parseResetTime(msg, NOW, 'UTC')?.toISOString()).toBe('2026-10-16T15:15:00.000Z');
    const dated = 'You’ve hit your usage limit. or try again at Oct 17th, 2026 3:15 PM.';
    expect(parseResetTime(dated, NOW, IST)?.toISOString()).toBe('2026-10-17T12:15:00.000Z');
  });

  it('reads epochs, JSON fields, ISO stamps and durations', () => {
    expect(parseResetTime('Claude AI usage limit reached|1792177200', NOW)?.toISOString()).toBe(
      new Date(1792177200 * 1000).toISOString(),
    );
    expect(parseResetTime('{"resets_in_seconds":5400}', NOW)?.toISOString()).toBe('2026-10-16T11:30:00.000Z');
    expect(parseResetTime('{"resets_at":1792159200}', NOW)?.toISOString()).toBe(
      new Date(1792159200 * 1000).toISOString(),
    );
    expect(parseResetTime('limit reached; resets at 2026-10-16T18:00:00.000Z', NOW)?.toISOString()).toBe(
      '2026-10-16T18:00:00.000Z',
    );
    expect(parseResetTime('try again in 2 hours 5 minutes', NOW)?.toISOString()).toBe(
      '2026-10-16T12:05:00.000Z',
    );
    expect(
      parseResetTime('spend limit reached (daily; resets 2026-10-17 00:00 UTC) — x', NOW)?.toISOString(),
    ).toBe('2026-10-17T00:00:00.000Z');
  });

  it('ignores missing, past, implausibly far or unknown-zone resets', () => {
    expect(parseResetTime('You exceeded your current quota', NOW)).toBeUndefined();
    expect(parseResetTime('limit reached; resets at 2026-10-01T00:00:00Z', NOW)).toBeUndefined();
    expect(parseResetTime('{"resets_in_seconds":99999999}', NOW)).toBeUndefined();
    expect(parseResetTime('resets 3pm (Mars/Olympus_Mons)', NOW)).toBeUndefined();
  });
});

describe('claudeRateLimitSignal (SDK rate_limit_event)', () => {
  it('a rejected subscription window is a limit with its reset (epoch seconds)', () => {
    expect(
      claudeRateLimitSignal({ status: 'rejected', resetsAt: 1792166400, rateLimitType: 'five_hour' }, NOW),
    ).toEqual({ resetAt: new Date(1792166400 * 1000), kind: 'session' });
  });

  it('allowed, warnings and usable overage are not limits', () => {
    expect(claudeRateLimitSignal({ status: 'allowed' }, NOW)).toBeNull();
    expect(claudeRateLimitSignal({ status: 'allowed_warning', resetsAt: 1792166400 }, NOW)).toBeNull();
    expect(claudeRateLimitSignal({ status: 'rejected', overageStatus: 'allowed' }, NOW)).toBeNull();
    expect(claudeRateLimitSignal(null, NOW)).toBeNull();
  });
});

describe('ClaudeEventMapper: usage limits', () => {
  const SID = randomUUID();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

  it('maps a rejected rate_limit_event to provider_usage_limit with the reset', () => {
    const m = new ClaudeEventMapper('local-login', {}, () => NOW);
    const events = m.map({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1792166400, rateLimitType: 'five_hour' },
      uuid: randomUUID(),
      session_id: SID,
    });
    expect(events).toEqual([
      {
        kind: 'error',
        code: PROVIDER_USAGE_LIMIT,
        message: `provider usage limit reached [limit=session]; resets at ${new Date(1792166400 * 1000).toISOString()}`,
      },
    ]);
  });

  it('an assistant rate_limit error with the CLI text and a failed result text are usage limits', () => {
    const m = new ClaudeEventMapper('local-login', {}, () => NOW);
    const a = {
      ...assistantText(SID, "You've hit your limit · resets 3pm (Europe/Istanbul)"),
      error: 'rate_limit' as const,
    };
    expect(m.map(a)).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        code: PROVIDER_USAGE_LIMIT,
        message: expect.stringContaining('resets at 2026-10-16T12:00:00.000Z') as unknown,
      }),
    );
    const r = resultSuccess(SID, 'Claude AI usage limit reached|1792177200', zero, {
      numTurns: 1,
      durationMs: 1,
    });
    expect(m.map({ ...r, is_error: true })).toContainEqual(
      expect.objectContaining({ kind: 'error', code: PROVIDER_USAGE_LIMIT }),
    );
  });

  it('an ordinary error keeps its code', () => {
    const m = new ClaudeEventMapper('local-login', {}, () => NOW);
    const r = resultSuccess(SID, 'API Error: 529 overloaded', zero, { numTurns: 1, durationMs: 1 });
    expect(m.map({ ...r, is_error: true })).not.toContainEqual(
      expect.objectContaining({ code: PROVIDER_USAGE_LIMIT }),
    );
  });
});

describe('Codex: usageLimitExceeded', () => {
  it('the error notification keeps the codex code; detection reads the reset from its message', () => {
    const m = new CodexEventMapper('local-login', {});
    const message =
      'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:15 PM.';
    const events = m.map('error', {
      error: { message, codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
      willRetry: false,
      threadId: 't',
      turnId: 'u',
    });
    expect(events).toEqual([{ kind: 'error', code: 'codex_usageLimitExceeded', message }]);
    const signal = usageLimitFromError('codex_usageLimitExceeded', message, NOW, IST);
    expect(signal?.resetAt?.toISOString()).toBe('2026-10-16T12:15:00.000Z');
    // The code alone is enough (reset unknown → the master's default backoff).
    expect(usageLimitFromError('codex_usageLimitExceeded', 'quota', NOW)).toEqual({
      kind: 'quota',
      detail: 'quota',
    });
    expect(usageLimitFromError('codex_serverOverloaded', 'overloaded', NOW)).toBeNull();
  });
});

describe('OpenCode: session.error from the provider', () => {
  const mapper = (): OcEventMapper => {
    const m = new OcEventMapper({ secrets: {}, authMode: 'local-login', now: () => NOW.getTime() });
    m.bind('ses_1');
    return m;
  };

  it('a usage_limit_reached body is provider_usage_limit with the reset', () => {
    const actions = mapper().map({
      type: 'session.error',
      properties: {
        sessionID: 'ses_1',
        error: {
          name: 'APIError',
          data: {
            message: 'Too Many Requests',
            statusCode: 429,
            isRetryable: false,
            responseBody:
              '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":5400}}',
          },
        },
      },
    });
    expect(actions).toEqual([
      {
        kind: 'session-error',
        name: 'APIError',
        code: PROVIDER_USAGE_LIMIT,
        message: 'provider usage limit reached; resets at 2026-10-16T11:30:00.000Z: Too Many Requests',
      },
    ]);
  });

  it('a transient rate-limit body keeps the ordinary code', () => {
    const actions = mapper().map({
      type: 'session.error',
      properties: {
        sessionID: 'ses_1',
        error: {
          name: 'APIError',
          data: {
            message: "This request would exceed your account's rate limit. Please try again later.",
            statusCode: 429,
            responseBody: '{"type":"error","error":{"type":"rate_limit_error"}}',
          },
        },
      },
    });
    expect(actions).toEqual([expect.objectContaining({ code: 'apierror' })]);
  });
});

describe('UsageLimitTracker', () => {
  it('keeps the latest reset and reports resetAt only for provider_usage_limit', () => {
    const t = new UsageLimitTracker();
    expect(t.resultFields(PROVIDER_USAGE_LIMIT)).toEqual({});
    t.observe({});
    t.observe({ resetAt: new Date('2026-10-16T12:00:00Z') });
    t.observe({ resetAt: new Date('2026-10-16T11:00:00Z') });
    t.observe({});
    t.observe(null);
    expect(t.resultFields(PROVIDER_USAGE_LIMIT)).toEqual({
      resetAt: '2026-10-16T12:00:00.000Z',
      usageLimit: {},
    });
    expect(t.resultFields('runtime_crashed')).toEqual({});
  });

  it('the canonical message round-trips', () => {
    const msg = usageLimitMessage({ resetAt: new Date('2026-10-16T12:00:00Z') }, 'detail');
    expect(usageLimitFromError(PROVIDER_USAGE_LIMIT, msg, NOW)?.resetAt?.toISOString()).toBe(
      '2026-10-16T12:00:00.000Z',
    );
  });
});

describe('Pi / OpenCode session core', () => {
  const core = (): SessionCore =>
    new SessionCore({ sessionId: 's1', runtime: 'pi' }, { secretEnv: {} } as unknown as SpawnContext);

  it('a failed run whose error said usage limit ends provider_usage_limit with the reset', () => {
    const c = core();
    c.emit({
      kind: 'error',
      code: 'model_error',
      message:
        '429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":60}}',
    });
    c.finish('failed', 'model_error');
    expect(c.errorCode).toBe(PROVIDER_USAGE_LIMIT);
    expect(c.resetAt().resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('other failures and successful runs keep their outcome code', () => {
    const c = core();
    c.emit({ kind: 'error', code: 'model_error', message: 'API Error: 529 overloaded' });
    c.finish('failed', 'model_error');
    expect(c.errorCode).toBe('model_error');
    const ok = core();
    ok.emit({ kind: 'error', code: 'model_error', message: 'You exceeded your current quota' });
    ok.finish('succeeded');
    expect(ok.errorCode).toBeUndefined();
    expect(ok.resetAt()).toEqual({});
  });
});

describe('parseResetTime in linear time', () => {
  it('a long run of spaces after "resets" (backtracked between two `\\s*` before)', () => {
    const started = performance.now();
    expect(parseResetTime(`resets${' '.repeat(60_000)}`, NOW)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(parseResetTime('try again at : 2026-10-17T12:00:00Z', NOW)?.toISOString()).toBe(
      '2026-10-17T12:00:00.000Z',
    );
  });
});
