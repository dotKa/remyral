import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, SendBudget } from '../src/transport/ws.js';

/** p22-byte-pace: the worker's send budget mirrors the master's token buckets, below them. */
describe('SendBudget (p22-byte-pace)', () => {
  it('lets a full burst go at once, then paces by the rate', () => {
    const b = new SendBudget(1000, 4000, 0);
    expect(b.waitMs(4000, 0)).toBe(0);
    b.take(4000, 0);
    expect(b.waitMs(500, 0)).toBe(500);
    expect(b.waitMs(500, 500)).toBe(0);
  });

  it('an item larger than the burst waits for a full bucket, never forever', () => {
    const b = new SendBudget(1000, 4000, 0);
    b.take(4000, 0);
    expect(b.waitMs(10_000, 0)).toBe(4000);
    expect(b.waitMs(10_000, 4000)).toBe(0);
  });

  it('a reset (new connection) starts full', () => {
    const b = new SendBudget(1000, 4000, 0);
    b.take(4000, 0);
    b.reset(10);
    expect(b.waitMs(4000, 10)).toBe(0);
  });

  it('stays below the master gateway buckets (200 / 400 messages, 2 / 8 MiB)', () => {
    expect(DEFAULT_LIMITS.messagesPerSec).toBeLessThan(200);
    expect(DEFAULT_LIMITS.messageBurst).toBeLessThan(400);
    expect(DEFAULT_LIMITS.bytesPerSec).toBeLessThan(2 * 1024 * 1024);
    expect(DEFAULT_LIMITS.byteBurst).toBeLessThan(8 * 1024 * 1024);
  });
});
