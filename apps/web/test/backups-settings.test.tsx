import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBytes } from '../src/screens/backupBytes';

/** p10-backup-restore: Settings → Backups (status only). */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Backups', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(null)).toBe('—');
  });
});
