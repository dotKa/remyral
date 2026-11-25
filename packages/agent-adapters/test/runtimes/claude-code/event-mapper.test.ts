import { describe, expect, it } from 'vitest';
import { ClaudeEventMapper, claudeProviderId, claudeToolRisk, SecretValue } from '../../../src/index.js';
import {
  assistantText,
  assistantToolUse,
  initMessage,
  resultInterrupted,
  resultSuccess,
  userToolResult,
} from '../../fixtures/claude-code/sdk-messages.js';

const SID = '6f1c9a52-0000-4000-8000-000000000001';

describe('ClaudeEventMapper (SDKMessage → AgentEvent)', () => {
  it('maps text, tool calls and tool results; init yields no event but records the session', () => {
    const m = new ClaudeEventMapper('secret-ref', {});
    expect(m.map(initMessage(SID, 'default', '/ws'))).toEqual([]);
    expect(m.sessionId).toBe(SID);
    expect(m.permissionMode).toBe('default');
    expect(m.map(assistantText(SID, 'hello'))).toEqual([
      { kind: 'message', role: 'assistant', text: 'hello' },
    ]);
    expect(m.map(assistantToolUse(SID, 'toolu_1', 'Bash', { command: 'ls -la' }))).toEqual([
      { kind: 'tool_call', callId: 'toolu_1', toolName: 'Bash', inputSummary: '{"command":"ls -la"}' },
    ]);
    expect(m.map(userToolResult(SID, 'toolu_1', 'denied', true))).toEqual([
      { kind: 'tool_result', callId: 'toolu_1', ok: false, outputSummary: 'denied' },
    ]);
  });

  it('redacts injected secret values from every text field', () => {
    const secret = new SecretValue('sk-ant-supersecret-123');
    const m = new ClaudeEventMapper('secret-ref', { ANTHROPIC_API_KEY: secret });
    const events = [
      ...m.map(assistantText(SID, `key is ${secret.reveal()}`)),
      ...m.map(assistantToolUse(SID, 't', 'Bash', { command: `echo ${secret.reveal()}` })),
      ...m.map(userToolResult(SID, 't', secret.reveal())),
    ];
    expect(JSON.stringify(events)).not.toContain(secret.reveal());
    expect(JSON.stringify(events)).toContain('[REDACTED]');
  });

  it('turns cumulative modelUsage/total_cost_usd into per-turn increments', () => {
    const m = new ClaudeEventMapper('secret-ref', {});
    const first = m.map(
      resultSuccess(
        SID,
        'a',
        { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, costUsd: 0.01 },
        { numTurns: 3, durationMs: 900 },
      ),
    );
    const second = m.map(
      resultSuccess(
        SID,
        'b',
        { input: 150, output: 50, cacheRead: 10, cacheWrite: 5, costUsd: 0.025 },
        { numTurns: 1, durationMs: 400 },
      ),
    );
    expect(first).toEqual([
      expect.objectContaining({
        kind: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        turns: 3,
        durationMs: 900,
        costUsd: 0.01,
      }),
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      inputTokens: 50,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 1,
    });
    expect((second[0] as { costUsd: number }).costUsd).toBeCloseTo(0.015, 10);
    expect(m.totals).toMatchObject({
      inputTokens: 150,
      outputTokens: 50,
      turns: 4,
      durationMs: 1300,
      costUsd: 0.025,
    });
  });

  it('local-login never carries a dollar figure (ADR-0014)', () => {
    const m = new ClaudeEventMapper('local-login', {});
    const [u] = m.map(
      resultSuccess(
        SID,
        'a',
        { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 3 },
        { numTurns: 1, durationMs: 1 },
      ),
    );
    expect(u).toMatchObject({ kind: 'usage', authMode: 'local-login', provenance: 'estimated-from-tokens' });
    expect(u).not.toHaveProperty('costUsd');
    expect(m.totals.costUsd).toBeUndefined();
  });

  it('an interrupted turn reports its usage and an error event', () => {
    const m = new ClaudeEventMapper('secret-ref', {});
    const events = m.map(
      resultInterrupted(SID, { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.0001 }),
    );
    expect(events.map((e) => e.kind)).toEqual(['usage', 'error']);
    expect(events[1]).toMatchObject({ kind: 'error', code: 'error_during_execution' });
  });

  it('maps provider ids and tool risk', () => {
    expect(claudeProviderId('firstParty')).toBe('anthropic');
    expect(claudeProviderId('bedrock')).toBe('bedrock');
    expect(claudeProviderId(undefined)).toBeUndefined();
    expect(claudeToolRisk('Bash')).toBe('high');
    expect(claudeToolRisk('mcp__github__create_pr')).toBe('high');
    expect(claudeToolRisk('Edit')).toBe('medium');
    expect(claudeToolRisk('Read')).toBe('low');
  });
});
