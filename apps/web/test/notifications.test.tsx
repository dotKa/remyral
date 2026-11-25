import { describe, expect, it } from 'vitest';
import { safeLink } from '../src/api/notifications';

/** p5-notifications: header bell (unread count, list, read state, polling) and Settings → Notifications. */

describe('notification bell', () => {
  it('keeps only console-relative links', () => {
    expect(safeLink('/jobs/abc')).toBe('/jobs/abc');
    expect(safeLink('//evil.example/x')).toBeNull();
    expect(safeLink('https://evil.example/x')).toBeNull();
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});
