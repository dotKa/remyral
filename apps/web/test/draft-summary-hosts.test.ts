import { describe, expect, it } from 'vitest';
import { isSlackHost } from '../src/diyalog/drafts/summary';

describe('draft summary: Slack output label', () => {
  it('is slack.com or one of its subdomains, never a look-alike host', () => {
    expect(isSlackHost('slack.com')).toBe(true);
    expect(isSlackHost('hooks.slack.com')).toBe(true);
    expect(isSlackHost('notslack.com')).toBe(false);
    expect(isSlackHost('slack.com.example.net')).toBe(false);
    expect(isSlackHost(null)).toBe(false);
  });
});
