import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AttemptId, JobId, RuntimeUsageWindow } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ClaudeEventMapper,
  claudeUsageFromGetUsage,
  claudeUsageFromRateLimitInfo,
  codexUsageFromRateLimits,
  codexWindowKind,
  createClaudeCodeAdapter,
  createCodexAdapter,
  FakeRuntimeAdapter,
  reportUsage,
  resetIso,
  type ClaudeQueryLike,
  type ClaudeSdkPort,
  type RuntimeUsageReading,
  type SessionRef,
  type SpawnContext,
} from '../src/index.js';
import { collectUntilStopped } from '../src/testing/index.js';
import { FAKE_CLI } from './fixtures/claude-code/fake-sdk.js';
import { codexTestStateDir, FAKE_APP_SERVER } from './fixtures/codex/helpers.js';

/**
 * p11-limit-visibility: the runtimes' usage-limit windows, parsed from the shapes the pinned runtimes expose
 * (fixtures follow sdk.d.ts 0.3.296 `SDKRateLimitInfo` / `SDKControlGetUsageResponse` and the codex-cli 0.162.1
 * generated `GetAccountRateLimitsResponse` / `AccountRateLimitsUpdatedNotification`).
 */

const NOW = new Date('2026-10-19T12:00:00.000Z');
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const valid = (r: RuntimeUsageReading | null): void => {
  for (const w of r?.windows ?? []) expect(RuntimeUsageWindow.safeParse(w).success).toBe(true);
};

describe('Claude Code rate_limit_event', () => {
  it('maps the 5-hour window: fraction → percent, epoch seconds → ISO, status', () => {
    const r = claudeUsageFromRateLimitInfo(
      {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.62,
        resetsAt: sec('2026-10-19T15:00:00Z'),
        surpassedThreshold: 0.5,
      },
      NOW,
    );
    expect(r).toEqual({
      available: true,
      partial: true,
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          usedPercent: 62,
          windowMinutes: 300,
          resetsAt: '2026-10-19T15:00:00.000Z',
          status: 'warning',
        },
      ],
    });
    valid(r);
  });

  it('maps weekly and per-model windows; rejected without utilization is 100 %', () => {
    const weekly = claudeUsageFromRateLimitInfo(
      { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.34 },
      NOW,
    );
    expect(weekly?.windows[0]).toMatchObject({ id: 'seven_day', kind: 'weekly', usedPercent: 34 });
    const opus = claudeUsageFromRateLimitInfo(
      { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: sec('2026-10-21T00:00:00Z') },
      NOW,
    );
    expect(opus?.windows[0]).toMatchObject({
      id: 'seven_day_opus',
      kind: 'model_weekly',
      label: 'Opus',
      usedPercent: 100,
      status: 'rejected',
    });
  });

  it('reads a utilization above 1 as a percentage; ignores unknown types and implausible resets', () => {
    expect(
      claudeUsageFromRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour', utilization: 45 }, NOW)
        ?.windows[0]?.usedPercent,
    ).toBe(45);
    expect(claudeUsageFromRateLimitInfo({ status: 'allowed', rateLimitType: 'hourly' }, NOW)).toBeNull();
    expect(claudeUsageFromRateLimitInfo(null, NOW)).toBeNull();
    expect(resetIso(sec('2027-06-01T00:00:00Z'), NOW)).toBeUndefined();
    expect(resetIso(sec('2026-10-10T00:00:00Z'), NOW)).toBeUndefined();
    expect(resetIso('2026-10-19T15:00:00Z', NOW)).toBe('2026-10-19T15:00:00.000Z');
  });

  it('the job event mapper reports the window and still emits the limit error when rejected', () => {
    const seen: RuntimeUsageReading[] = [];
    const m = new ClaudeEventMapper('local-login', {}, () => NOW);
    m.onUsage = (r) => seen.push(r);
    const events = m.map({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: sec('2026-10-19T15:00:00Z'),
      },
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 's',
    });
    expect(seen[0]?.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 100, status: 'rejected' });
    expect(events[0]).toMatchObject({ kind: 'error', code: 'provider_usage_limit' });
  });

  it('an observer that throws never breaks the run', () => {
    expect(() => {
      reportUsage(
        () => {
          throw new Error('boom');
        },
        { available: true, partial: true, windows: [] },
      );
    }).not.toThrow();
  });
});

describe('Claude Code /usage data (SDKControlGetUsageResponse)', () => {
  const response = {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 62, resets_at: '2026-10-19T15:00:00Z' },
      seven_day: { utilization: 34.25, resets_at: '2026-10-23T08:00:00Z' },
      seven_day_opus: { utilization: 80, resets_at: '2026-10-23T08:00:00Z' },
      seven_day_sonnet: null,
      model_scoped: [{ display_name: 'Fable\u0007', utilization: 12, resets_at: '2026-10-23T08:00:00Z' }],
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 5, utilization: 10, currency: 'USD' },
    },
    behaviors: null,
  };

  it('maps every window with plan and labels', () => {
    const r = claudeUsageFromGetUsage(response, NOW);
    expect(r?.plan).toBe('max');
    expect(r?.partial).toBe(false);
    expect(r?.windows.map((w) => [w.id, w.kind, w.usedPercent])).toEqual([
      ['five_hour', 'session', 62],
      ['seven_day', 'weekly', 34.3],
      ['seven_day_opus', 'model_weekly', 80],
      ['model:fable', 'model_weekly', 12],
      ['extra_usage', 'spend', 10],
    ]);
    expect(r?.windows.find((w) => w.id === 'model:fable')?.label).toBe('Fable');
    valid(r);
  });

  it('API-key sessions: not available; unknown shapes: null', () => {
    expect(
      claudeUsageFromGetUsage(
        { ...response, subscription_type: null, rate_limits_available: false, rate_limits: null },
        NOW,
      ),
    ).toEqual({ available: false, windows: [], partial: false });
    expect(claudeUsageFromGetUsage({ rate_limits: {} }, NOW)).toBeNull();
    expect(claudeUsageFromGetUsage('x', NOW)).toBeNull();
  });
});

describe('Codex rate limits (app-server 0.162.1)', () => {
  const body = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: sec('2026-10-19T15:00:00Z') },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: sec('2026-10-23T08:00:00Z') },
      credits: { hasCredits: false, unlimited: false, balance: null },
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: null,
      codex_other: {
        limitId: 'codex_other',
        limitName: 'GPT-5.5 Pro',
        normalModelSlug: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: sec('2026-10-19T14:00:00Z') },
        secondary: null,
        credits: null,
        individualLimit: {
          limit: '100',
          used: '90',
          remainingPercent: 10,
          resetsAt: sec('2026-10-30T00:00:00Z'),
        },
        spendControlReached: false,
        planType: 'plus',
        rateLimitReachedType: 'rate_limit_reached',
      },
    },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  };

  it('maps primary / secondary windows by length, plan, extra buckets and the spend limit', () => {
    const r = codexUsageFromRateLimits(body, NOW, { partial: false });
    expect(r?.plan).toBe('plus');
    expect(r?.windows).toEqual([
      {
        id: 'primary',
        kind: 'session',
        usedPercent: 62,
        windowMinutes: 300,
        resetsAt: '2026-10-19T15:00:00.000Z',
      },
      {
        id: 'secondary',
        kind: 'weekly',
        usedPercent: 34,
        windowMinutes: 10080,
        resetsAt: '2026-10-23T08:00:00.000Z',
      },
      {
        id: 'codex_other:primary',
        kind: 'session',
        label: 'GPT-5.5 Pro',
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: '2026-10-19T14:00:00.000Z',
        status: 'rejected',
      },
      {
        id: 'codex_other:spend',
        kind: 'spend',
        label: 'Spend limit',
        usedPercent: 90,
        resetsAt: '2026-10-30T00:00:00.000Z',
      },
    ]);
    valid(r);
  });

  it('the sparse update is partial; window kinds follow the length', () => {
    const r = codexUsageFromRateLimits({ rateLimits: body.rateLimits }, NOW, { partial: true });
    expect(r?.partial).toBe(true);
    expect(codexWindowKind(undefined, 'primary')).toBe('session');
    expect(codexWindowKind(1440, 'primary')).toBe('other');
    expect(codexWindowKind(10080, 'secondary')).toBe('weekly');
    expect(codexUsageFromRateLimits({}, NOW, { partial: true })).toBeNull();
  });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('Codex adapter: readUsage and account/rateLimits/updated', () => {
  const stateDir = codexTestStateDir();
  const wsRoot = mkdtempSync(join(tmpdir(), 'remyral-usage-codex-'));
  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it('local-login: reads the windows from a short-lived app-server (no thread)', async () => {
    const a = createCodexAdapter({ codexPath: FAKE_APP_SERVER, stateDir, authMode: 'local-login' });
    await a.probe();
    const r = await a.readUsage({ timeoutMs: 10_000 });
    expect(r?.plan).toBe('plus');
    expect(r?.windows.find((w) => w.id === 'primary')?.usedPercent).toBe(62);
    expect(r?.windows.find((w) => w.id === 'secondary')?.kind).toBe('weekly');
  });

  it('secret-ref (API key): null, nothing started', async () => {
    const a = createCodexAdapter({ codexPath: FAKE_APP_SERVER, stateDir });
    expect(await a.readUsage({ timeoutMs: 1_000 })).toBeNull();
  });

  it('a job session reports the sparse update it sees during the turn', async () => {
    const seen: RuntimeUsageReading[] = [];
    const a = createCodexAdapter({ codexPath: FAKE_APP_SERVER, stateDir, authMode: 'local-login' });
    await a.probe();
    const ctx: SpawnContext = {
      jobId: JobId.parse('job-usage'),
      attemptId: AttemptId.parse('attempt-1'),
      workspaceRoot: mkdtempSync(join(wsRoot, 'ws-')),
      job: { runtime: 'codex', prompt: 'p', limits: { maxDurationSec: 60 } },
      sandboxProfile: 'runtime-sandbox',
      approvalPolicy: 'ask-sensitive',
      repositoryTrust: 'untrusted',
      repoConfig: 'ignore-repository-config',
      secretEnv: {},
      timeouts: {
        startupMs: 10_000,
        cancelGraceMs: 500,
        cancelMs: 2_000,
        approvalMs: 5_000,
        maxDurationMs: 60_000,
      },
      allowUnverified: true,
      signal: new AbortController().signal,
      onUsage: (r) => seen.push(r),
    };
    const ref: SessionRef = await a.spawn(ctx);
    try {
      await a.sendPrompt(ref, { text: 'hello' });
      await collectUntilStopped(a, ref, 15_000);
    } finally {
      await a.cleanup(ref);
    }
    expect(seen.at(-1)?.partial).toBe(true);
    expect(seen.at(-1)?.windows.find((w) => w.id === 'primary')?.usedPercent).toBe(47);
  });
});

describePosix('Claude Code adapter: readUsage', () => {
  const root = mkdtempSync(join(tmpdir(), 'remyral-usage-claude-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });

  function usageSdk(
    answer: unknown,
    calls: { options: Options[]; prompts: number; closed: number },
  ): ClaudeSdkPort {
    return {
      query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQueryLike {
        calls.options.push(params.options);
        void (async () => {
          for await (const _m of params.prompt) calls.prompts += 1;
        })();
        const q = {
          interrupt: () => Promise.resolve(),
          close: () => {
            calls.closed += 1;
          },
          initializationResult: () => Promise.resolve({ claude_code_version: '2.1.310' }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (o?: { skipBehaviors?: boolean }) =>
            Promise.resolve(o?.skipBehaviors === true ? answer : null),
          async *[Symbol.asyncIterator]() {
            // no messages
          },
        };
        return q;
      },
    };
  }

  it('local-login: the /usage windows, no prompt sent, no tools, session not persisted, closed', async () => {
    const calls = { options: [] as Options[], prompts: 0, closed: 0 };
    const a = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo,
      authMode: 'local-login',
      sdk: usageSdk(
        {
          subscription_type: 'pro',
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 15, resets_at: '2026-10-19T15:00:00Z' } },
        },
        calls,
      ),
    });
    const r = await a.readUsage({ timeoutMs: 5_000 });
    expect(r?.plan).toBe('pro');
    expect(r?.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 15 });
    expect(calls.prompts).toBe(0);
    expect(calls.closed).toBe(1);
    expect(calls.options[0]?.persistSession).toBe(false);
    expect(calls.options[0]?.settingSources).toEqual([]);
    expect(calls.options[0]?.mcpServers).toEqual({});
  });

  it('secret-ref: null without starting the CLI', async () => {
    const calls = { options: [] as Options[], prompts: 0, closed: 0 };
    const a = createClaudeCodeAdapter({ binaryPath: FAKE_CLI, sdkInfo, sdk: usageSdk({}, calls) });
    expect(await a.readUsage({ timeoutMs: 1_000 })).toBeNull();
    expect(calls.options).toHaveLength(0);
  });

  it('an SDK without the call, or an unknown answer: null', async () => {
    const calls = { options: [] as Options[], prompts: 0, closed: 0 };
    const a = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo,
      authMode: 'local-login',
      sdk: usageSdk({ foo: 1 }, calls),
    });
    expect(await a.readUsage({ timeoutMs: 5_000 })).toBeNull();
  });
});

describe('fake runtime', () => {
  it('readUsage answers the configured reading', async () => {
    const reading: RuntimeUsageReading = {
      available: true,
      partial: false,
      windows: [{ id: 'five_hour', kind: 'session', usedPercent: 10 }],
    };
    const a = new FakeRuntimeAdapter({ usage: () => reading });
    expect(await a.readUsage()).toEqual(reading);
    expect(await new FakeRuntimeAdapter({}).readUsage()).toBeNull();
  });
});
