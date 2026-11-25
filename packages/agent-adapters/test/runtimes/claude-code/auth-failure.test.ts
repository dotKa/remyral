import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeEventMapper,
  claudeLoginFailureCause,
  createClaudeCodeAdapter,
  isAuthErrorCode,
  isClaudeAuthFailure,
  LOGIN_EXPIRED,
  type ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
  type SessionRef,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped } from '../../../src/testing/index.js';
import {
  basicTurn,
  FAKE_CLI,
  FakeClaudeSdk,
  type FakeSdkOptions,
} from '../../fixtures/claude-code/fake-sdk.js';
import { assistantText, resultSuccess } from '../../fixtures/claude-code/sdk-messages.js';

/** p5-claude-auth-health: an unusable subscription login is reported as `login_expired`. */

const LIVE_ERROR =
  'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh';

describe('isClaudeAuthFailure', () => {
  it('recognises the refresh-lock failure seen live and other expired-login messages', () => {
    for (const text of [
      LIVE_ERROR,
      'Error: Failed to refresh OAuth token',
      'OAuth token has expired. Please run /login',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
      'Invalid API key · Please run /login',
      'refresh token has been revoked',
      'invalid_grant',
      'Not logged in · Please run /login',
    ]) {
      expect(isClaudeAuthFailure(text), text).toBe(true);
    }
  });

  it('does not flag ordinary failures', () => {
    for (const text of [
      undefined,
      '',
      'Request was aborted.',
      'API Error: 529 overloaded',
      'Claude Code process exited with code 1',
      'npm ERR! 404 Not Found',
      'rate_limit',
    ]) {
      expect(isClaudeAuthFailure(text), String(text)).toBe(false);
    }
  });

  it('maps the SDK authentication error codes', () => {
    expect(isAuthErrorCode('authentication_failed')).toBe(true);
    expect(isAuthErrorCode('rate_limit')).toBe(false);
    expect(isAuthErrorCode(undefined)).toBe(false);
  });
});

describe('claudeLoginFailureCause (p9-windows-slots-local-login)', () => {
  it('tells refresh-lock contention from an expired login', () => {
    expect(claudeLoginFailureCause(LIVE_ERROR)).toBe('refresh_contention');
    expect(
      claudeLoginFailureCause(
        'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh)',
      ),
    ).toBe('refresh_contention');
    expect(
      claudeLoginFailureCause('Lock acquisition failed after 5 attempts: another process is refreshing'),
    ).toBe('refresh_contention');
    expect(claudeLoginFailureCause('OAuth token has expired. Please run /login')).toBe('expired');
    expect(claudeLoginFailureCause('invalid_grant')).toBe('expired');
    expect(claudeLoginFailureCause('API Error: 529 overloaded')).toBeNull();
    expect(claudeLoginFailureCause(undefined)).toBeNull();
  });
});

describe('ClaudeEventMapper: auth errors', () => {
  const SID = randomUUID();

  it('a failed turn whose text is an auth failure becomes a login_expired error event', () => {
    const m = new ClaudeEventMapper('local-login', {});
    const r = resultSuccess(
      SID,
      LIVE_ERROR,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      {
        numTurns: 1,
        durationMs: 10,
      },
    );
    const events = m.map({ ...r, is_error: true });
    expect(events).toContainEqual({ kind: 'error', code: LOGIN_EXPIRED, message: LIVE_ERROR });
  });

  it('an assistant authentication_failed error and an auth_status error are login_expired', () => {
    const m = new ClaudeEventMapper('local-login', {});
    const a = { ...assistantText(SID, ''), error: 'authentication_failed' as const };
    expect(m.map(a)).toContainEqual(expect.objectContaining({ kind: 'error', code: LOGIN_EXPIRED }));
    const status = {
      type: 'auth_status' as const,
      isAuthenticating: false,
      output: [],
      error: 'OAuth token has expired',
      uuid: randomUUID(),
      session_id: SID,
    };
    expect(m.map(status)).toEqual([
      { kind: 'error', code: LOGIN_EXPIRED, message: 'OAuth token has expired' },
    ]);
  });

  it('an ordinary failed turn keeps its own code', () => {
    const m = new ClaudeEventMapper('local-login', {});
    const r = resultSuccess(
      SID,
      'API Error: 529 overloaded',
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      {
        numTurns: 1,
        durationMs: 10,
      },
    );
    expect(m.map({ ...r, is_error: true })).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'completed' }),
    );
  });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const root = mkdtempSync(join(tmpdir(), 'remyral-claude-auth-'));
const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root });
const opened: { adapter: ClaudeCodeAdapter; ref: SessionRef }[] = [];
afterEach(async () => {
  for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): SpawnContext {
  return {
    jobId: JobId.parse('job-claude-auth'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: mkdtempSync(join(root, 'ws-')),
    job: { runtime: 'claude-code', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: {
      startupMs: 5_000,
      cancelGraceMs: 500,
      cancelMs: 2_000,
      approvalMs: 5_000,
      maxDurationMs: 60_000,
    },
    allowUnverified: true,
    signal: new AbortController().signal,
  };
}

async function run(fake: FakeSdkOptions, extra: ClaudeCodeAdapterOptions = {}) {
  const adapter = createClaudeCodeAdapter({
    binaryPath: FAKE_CLI,
    sdkInfo,
    sdk: new FakeClaudeSdk(fake),
    stateDir: join(root, 'state'),
    authMode: 'local-login',
    sourceEnv: { ...process.env },
    ...extra,
  });
  await adapter.probe();
  const ref = await adapter.spawn(ctx());
  opened.push({ adapter, ref });
  await adapter.sendPrompt(ref, { text: 'do it' });
  await collectUntilStopped(adapter, ref, 10_000);
  return adapter.collectResult(ref);
}

describePosix('claude-code adapter: login_expired', () => {
  it('a CLI that dies with the OAuth refresh failure ends failed with login_expired', async () => {
    const result = await run({ script: () => [{ kind: 'crash', message: LIVE_ERROR }] });
    // p9-windows-slots-local-login: the cause travels with the result
    expect(result).toMatchObject({
      outcome: 'failed',
      errorCode: LOGIN_EXPIRED,
      loginFailure: 'refresh_contention',
    });
  });

  it('an expired login (no lock contention) is reported as expired', async () => {
    const result = await run({
      script: () => [{ kind: 'crash', message: 'OAuth token has expired. Please run /login' }],
    });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: LOGIN_EXPIRED, loginFailure: 'expired' });
  });

  it('an ordinary crash stays runtime_crashed', async () => {
    const result = await run({ script: () => [{ kind: 'crash', message: 'exited with code 1' }] });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'runtime_crashed' });
  });

  it('runs the beforeStart housekeeping before every CLI start (failures ignored)', async () => {
    let calls = 0;
    const result = await run(
      { script: basicTurn },
      {
        beforeStart: () => {
          calls += 1;
          return Promise.reject(new Error('janitor failed'));
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.outcome).toBe('succeeded');
  });
});
