import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { UsageIdentity } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  type ClaudeQueryLike,
  type ClaudeSdkPort,
  usageIdentity,
} from '../src/index.js';
import { FAKE_CLI } from './fixtures/claude-code/fake-sdk.js';
import { codexTestStateDir, FAKE_APP_SERVER } from './fixtures/codex/helpers.js';

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §2): which provider account a subscription login is — from
 * Claude's `AccountInfo` (sdk.d.ts 0.3.296, `SDKControlInitializeResponse.account`) and Codex's `account/read`
 * (codex-cli 0.162.1 `GetAccountResponse`), hashed; the e-mail never leaves the adapter.
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describe('usageIdentity', () => {
  it('the same account gives the same key on every machine; e-mail case and spaces do not matter', () => {
    const a = usageIdentity('anthropic', 'Alex@Example.com ', 'ExampleOrg');
    const b = usageIdentity('anthropic', 'alex@example.com', 'ExampleOrg');
    expect(a).not.toBeNull();
    expect(a?.key).toBe(b?.key);
    expect(UsageIdentity.safeParse(a).success).toBe(true);
    expect(a?.hint).toBe('a…@example.com');
    expect(JSON.stringify(a)).not.toContain('alex');
  });

  it('organization and provider separate accounts', () => {
    const personal = usageIdentity('anthropic', 'y@x.io', 'Personal');
    const team = usageIdentity('anthropic', 'y@x.io', 'Team');
    const codex = usageIdentity('openai', 'y@x.io');
    expect(personal?.key).not.toBe(team?.key);
    expect(personal?.key).not.toBe(codex?.key);
  });

  it('no plausible e-mail: no identity', () => {
    expect(usageIdentity('openai', undefined)).toBeNull();
    expect(usageIdentity('openai', 'not-an-email')).toBeNull();
    expect(usageIdentity('openai', 'a b@c.d')).toBeNull();
  });
});

describePosix('Claude Code readUsage names the account', () => {
  const root = mkdtempSync(join(tmpdir(), 'remyral-identity-claude-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });
  const usage = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 9, resets_at: '2026-10-22T16:20:00Z' } },
  };

  function sdk(account: unknown): ClaudeSdkPort {
    return {
      query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQueryLike {
        void (async () => {
          for await (const _m of params.prompt) {
            // never sent
          }
        })();
        return {
          interrupt: () => Promise.resolve(),
          close: () => undefined,
          initializationResult: () => Promise.resolve({ claude_code_version: '2.1.310', account } as never),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(usage),
          async *[Symbol.asyncIterator]() {
            // no messages
          },
        };
      },
    };
  }

  it('claude.ai login: the hashed account with the reading', async () => {
    const a = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo,
      authMode: 'local-login',
      sdk: sdk({ email: 'alex@example.com', organization: 'example-org', subscriptionType: 'max' }),
    });
    const r = await a.readUsage({ timeoutMs: 5_000 });
    expect(r?.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 9 });
    expect(r?.identity).toEqual(usageIdentity('anthropic', 'alex@example.com', 'example-org'));
  });

  it('a 3rd-party provider or no account info: the reading without an identity', async () => {
    for (const account of [{ apiProvider: 'bedrock', email: 'y@x.io' }, undefined]) {
      const a = createClaudeCodeAdapter({
        binaryPath: FAKE_CLI,
        sdkInfo,
        authMode: 'local-login',
        sdk: sdk(account),
      });
      const r = await a.readUsage({ timeoutMs: 5_000 });
      expect(r?.windows).toHaveLength(1);
      expect(r?.identity).toBeUndefined();
    }
  });
});

describePosix('Codex readUsage names the account', () => {
  const stateDir = codexTestStateDir();
  const home = mkdtempSync(join(tmpdir(), 'remyral-identity-codex-'));
  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('a ChatGPT login: the hashed account (account/read) with the windows', async () => {
    writeFileSync(
      join(home, 'fake-account.json'),
      JSON.stringify({
        account: { type: 'chatgpt', email: 'alex@example.com', planType: 'plus' },
        requiresOpenaiAuth: false,
      }),
    );
    const a = createCodexAdapter({
      codexPath: FAKE_APP_SERVER,
      stateDir,
      authMode: 'local-login',
      loginDir: home,
    });
    await a.probe();
    const r = await a.readUsage({ timeoutMs: 10_000 });
    expect(r?.windows.find((w) => w.id === 'primary')?.usedPercent).toBe(62);
    expect(r?.identity).toEqual(usageIdentity('openai', 'alex@example.com'));
  });

  it('no ChatGPT account (API key / signed out): the windows without an identity', async () => {
    writeFileSync(
      join(home, 'fake-account.json'),
      JSON.stringify({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
    );
    const a = createCodexAdapter({
      codexPath: FAKE_APP_SERVER,
      stateDir,
      authMode: 'local-login',
      loginDir: home,
    });
    await a.probe();
    const r = await a.readUsage({ timeoutMs: 10_000 });
    expect(r?.windows.length).toBeGreaterThan(0);
    expect(r?.identity).toBeUndefined();
  });
});
