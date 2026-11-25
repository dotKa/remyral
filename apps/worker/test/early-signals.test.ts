import { describe, expect, it, vi } from 'vitest';
import { ManualSignals } from '../src/daemon/signals.js';
import { latchShutdownSignals } from '../src/service/early-signals.js';

describe('latchShutdownSignals', () => {
  it('replays a stop request that arrived before the daemon subscribed', async () => {
    const inner = new ManualSignals();
    const latched = latchShutdownSignals(inner);
    expect(inner.listenerCount).toBe(1); // subscribed immediately
    inner.trigger('SIGTERM');
    expect(latched.requested).toBe('SIGTERM');
    const handler = vi.fn();
    latched.onShutdown(handler);
    expect(handler).not.toHaveBeenCalled(); // asynchronously, after the subscriber's setup
    await new Promise((r) => setImmediate(r));
    expect(handler).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('forwards later requests, honours unsubscribe and detaches on close', async () => {
    const inner = new ManualSignals();
    const latched = latchShutdownSignals(inner);
    const a = vi.fn();
    const b = vi.fn();
    latched.onShutdown(a);
    const offB = latched.onShutdown(b);
    offB();
    inner.trigger('SIGINT');
    expect(a).toHaveBeenCalledWith('SIGINT');
    expect(b).not.toHaveBeenCalled();
    // A handler unsubscribed before the replay fires is not called.
    const c = vi.fn();
    latched.onShutdown(c)();
    await new Promise((r) => setImmediate(r));
    expect(c).not.toHaveBeenCalled();
    latched.close();
    expect(inner.listenerCount).toBe(0);
  });
});
