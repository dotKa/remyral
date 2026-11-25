import { describe, expect, it } from 'vitest';
import { replacementReason } from '../../src/workers/hub.js';

describe('replacementReason (p5-live-fixes-2)', () => {
  const a = '7f3c2a10-5b7e-4d7a-9c1e-2f4b6a8d0e12';
  const b = '0b6a1c55-3d2e-4f10-8a7b-9c0d1e2f3a4b';

  it('a reconnect of the same process replaces its stale socket', () => {
    expect(replacementReason(a, a)).toEqual({
      kind: 'reconnect',
      reason: 'worker reconnected; the previous connection had gone stale',
    });
  });

  it('a different process with the same key is named', () => {
    const r = replacementReason(a, b);
    expect(r.kind).toBe('other_process');
    expect(r.reason).toContain('another process');
    expect(r.reason).toContain(b.slice(0, 8));
  });

  it('older workers without an instance id keep the generic reason', () => {
    expect(replacementReason(null, a).kind).toBe('unknown');
    expect(replacementReason(a, null).kind).toBe('unknown');
    expect(replacementReason(null, null).reason).toBe('replaced by a newer connection');
  });
});
