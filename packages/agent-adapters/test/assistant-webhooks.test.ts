import { ASSISTANT_TOOLS, assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §9): rule 43 sends the model to list_webhooks and draft_webhook,
 * keeps the signing secret out of the chat and forbids claiming a change without a result; the tool inputs are strict.
 */
describe('outgoing webhooks through the chat (p16-webhooks-out)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 43 names the tools, the catalog, the egress floor and the secret boundary', () => {
    const r = rule(43);
    expect(r).toContain('list_webhooks');
    expect(r).toContain('draft_webhook');
    expect(r).toMatch(/never passes this chat/);
    expect(r).toMatch(/loopback, private and metadata addresses are refused/);
    expect(r).toMatch(/Never claim a webhook was created/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('list_webhooks is a read, draft_webhook a draft with a strict op', () => {
    expect(ASSISTANT_TOOLS.list_webhooks.kind).toBe('read');
    expect(ASSISTANT_TOOLS.draft_webhook.kind).toBe('draft');
    const list = assistantToolInput('list_webhooks');
    expect(list.safeParse({}).success).toBe(true);
    expect(list.safeParse({ failures: true }).success).toBe(true);
    const draft = assistantToolInput('draft_webhook');
    expect(
      draft.safeParse({
        op: 'create',
        name: 'n8n',
        url: 'https://n8n.example.com/hook',
        eventTypes: ['job.failed'],
      }).success,
    ).toBe(true);
    expect(draft.safeParse({ op: 'pause', webhookId: 'n8n' }).success).toBe(true);
    expect(draft.safeParse({ op: 'delete', webhookId: 'n8n' }).success).toBe(false);
    expect(draft.safeParse({ op: 'create', secret: 'whsec_x' }).success).toBe(false);
  });
});
