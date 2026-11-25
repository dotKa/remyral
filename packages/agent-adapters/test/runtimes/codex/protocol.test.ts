import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexEventMapper, codexErrorCode, SecretValue } from '../../../src/index.js';
import {
  AccountResult,
  InboundMessage,
  InitializeResult,
  ThreadStartedResult,
} from '../../../src/runtimes/codex/protocol/schemas.js';

const capture = JSON.parse(
  readFileSync(new URL('../../fixtures/codex/handshake-0.162.1.json', import.meta.url), 'utf8'),
) as { lines: { dir: 'in' | 'out'; msg: Record<string, unknown> }[] };
const response = (id: number): unknown =>
  capture.lines.find((l) => l.dir === 'in' && l.msg.id === id)?.msg.result;

describe('codex protocol schemas vs the idle handshake captured from codex-cli 0.162.1', () => {
  it('every captured inbound line is a valid InboundMessage', () => {
    for (const l of capture.lines.filter((x) => x.dir === 'in')) {
      expect(InboundMessage.safeParse(l.msg).success).toBe(true);
    }
  });

  it('initialize / account/read / thread/start responses parse with the adapter schemas', () => {
    expect(InitializeResult.parse(response(1))).toMatchObject({ platformOs: 'macos' });
    expect(AccountResult.parse(response(2))).toEqual(
      expect.objectContaining({ account: null, requiresOpenaiAuth: true }),
    );
    const thread = ThreadStartedResult.parse(response(4));
    expect(thread.approvalsReviewer).toBe('user');
    expect(thread.sandbox).toMatchObject({ type: 'workspaceWrite', networkAccess: false });
  });

  it('framing has no "jsonrpc" member', () => {
    for (const l of capture.lines) expect(l.msg).not.toHaveProperty('jsonrpc');
  });
});

describe('CodexEventMapper', () => {
  const mk = () => new CodexEventMapper('secret-ref', { K: new SecretValue('sk-secret-xyz') });
  const breakdown = (input: number, cached: number, output: number) => ({
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  });
  const usage = (input: number, cached: number, output: number) => ({
    threadId: 't',
    turnId: 'u',
    tokenUsage: {
      total: breakdown(input, cached, output),
      last: breakdown(0, 0, 0),
      modelContextWindow: null,
    },
  });
  const completed = (status: string, error: unknown = null) => ({
    threadId: 't',
    turn: { id: 'u', status, error, durationMs: 7, items: [] },
  });

  it('diffs running token totals and reports them once per turn', () => {
    const m = mk();
    m.model = 'gpt-x';
    m.provider = 'OpenAI';
    m.map('turn/started', { threadId: 't', turn: { id: 'u', status: 'inProgress' } });
    m.map('thread/tokenUsage/updated', usage(100, 20, 10));
    m.map('thread/tokenUsage/updated', usage(150, 50, 30));
    const events = m.map('turn/completed', completed('completed'));
    expect(events).toEqual([
      {
        kind: 'usage',
        inputTokens: 100,
        outputTokens: 30,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        turns: 1,
        durationMs: 7,
        provider: 'openai',
        model: 'gpt-x',
        authMode: 'secret-ref',
        provenance: 'estimated-from-tokens',
      },
    ]);
    expect(m.activeTurnId).toBeUndefined();
  });

  it('retrying errors are silent, final errors and failed turns are reported; text is redacted', () => {
    const m = mk();
    const err = { message: 'bad sk-secret-xyz', codexErrorInfo: 'usageLimitExceeded' };
    expect(m.map('error', { error: err, willRetry: true, threadId: 't', turnId: 'u' })).toEqual([]);
    expect(m.map('error', { error: err, willRetry: false, threadId: 't', turnId: 'u' })).toEqual([
      { kind: 'error', code: 'codex_usageLimitExceeded', message: 'bad [REDACTED]' },
    ]);
    const ev = m.map('turn/completed', completed('failed', err));
    expect(ev.map((e) => e.kind)).toEqual(['usage', 'error']);
    expect(m.lastTurnEnd).toMatchObject({ status: 'failed', errorCode: 'codex_usageLimitExceeded' });
  });

  it('rejects a known notification whose shape drifted (caller fails closed)', () => {
    expect(() => mk().map('turn/completed', { threadId: 't', turn: { id: 1 } })).toThrow();
  });

  it('maps error info variants', () => {
    expect(codexErrorCode('unauthorized')).toBe('codex_unauthorized');
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe(
      'codex_httpConnectionFailed',
    );
    expect(codexErrorCode(null)).toBe('codex_error');
  });
});
