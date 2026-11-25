import { describe, expect, it } from 'vitest';
import {
  backoffSec,
  type Delivery,
  deliveryOf,
  maxAttempts,
  maxPureAttempts,
  readiness,
  retriesOn,
  runOutcome,
} from '../src/index.js';

const V: Delivery = { kind: 'value' };
const P: Delivery = { kind: 'pending' };
const DEAD: Delivery = { kind: 'skip', reason: 'dead_path' };
const FAILED: Delivery = { kind: 'skip', reason: 'upstream_failed' };

describe('interpreter core', () => {
  it('deliveries: the taken port gets the value, the others a dead-path skip', () => {
    expect(deliveryOf({ state: 'succeeded', port: 'true' }, 'true')).toEqual(V);
    expect(deliveryOf({ state: 'succeeded', port: 'true' }, 'false')).toEqual(DEAD);
    expect(deliveryOf({ state: 'open' }, 'out')).toEqual(P);
    expect(deliveryOf({ state: 'cancelled' }, 'out')).toEqual(FAILED);
    expect(deliveryOf({ state: 'skipped', reason: 'dead_path' }, 'out')).toEqual(DEAD);
  });

  it('deliveries of a failure: error port, else the node’s onError', () => {
    expect(deliveryOf({ state: 'failed', onError: 'fail', errorPortConnected: true }, 'error')).toEqual(V);
    expect(deliveryOf({ state: 'failed', onError: 'fail', errorPortConnected: true }, 'out')).toEqual(DEAD);
    expect(deliveryOf({ state: 'failed', onError: 'skip', errorPortConnected: false }, 'out')).toEqual(
      FAILED,
    );
    expect(deliveryOf({ state: 'failed', onError: 'continue', errorPortConnected: false }, 'out')).toEqual(V);
    expect(deliveryOf({ state: 'failed', onError: 'fail', errorPortConnected: false }, 'out')).toEqual(
      FAILED,
    );
  });

  it('join all: waits for every edge; v1 parity — any failed upstream skips the node', () => {
    expect(readiness([])).toEqual({ verdict: 'run', values: [] });
    expect(readiness([V, P])).toEqual({ verdict: 'wait' });
    expect(readiness([V, V])).toEqual({ verdict: 'run', values: [0, 1] });
    expect(readiness([V, FAILED])).toEqual({ verdict: 'skip', reason: 'upstream_failed' });
    // Dead paths are dropped (if / else joins).
    expect(readiness([V, DEAD])).toEqual({ verdict: 'run', values: [0] });
    expect(readiness([DEAD, DEAD])).toEqual({ verdict: 'skip', reason: 'dead_path' });
  });

  it('join any / first / atLeast', () => {
    expect(readiness([P, V], 'any')).toEqual({ verdict: 'run', values: [1] });
    expect(readiness([P, DEAD], 'first')).toEqual({ verdict: 'wait' });
    expect(readiness([FAILED, DEAD], 'any')).toEqual({ verdict: 'skip', reason: 'upstream_failed' });
    expect(readiness([V, P, P], { atLeast: 2 })).toEqual({ verdict: 'wait' });
    expect(readiness([V, V, P], { atLeast: 2 })).toEqual({ verdict: 'run', values: [0, 1] });
    expect(readiness([V, DEAD, DEAD], { atLeast: 2 })).toEqual({ verdict: 'skip', reason: 'dead_path' });
  });

  it('attempts: retries only when declared safe (v1 retry-safe default 2 retries)', () => {
    expect(maxAttempts(undefined)).toBe(1);
    expect(maxAttempts({ max: 3 })).toBe(1);
    expect(maxAttempts({ safe: true })).toBe(3);
    expect(maxAttempts({ safe: true, max: 1 })).toBe(2);
    expect(maxAttempts({ safe: true, max: 0 })).toBe(1);
  });

  it('14.1: a node run may emit on several ports (filter kept + dropped, group results + done)', () => {
    const both = { state: 'succeeded', port: ['kept', 'dropped'] } as const;
    expect(deliveryOf(both, 'kept')).toEqual(V);
    expect(deliveryOf(both, 'dropped')).toEqual(V);
    expect(deliveryOf(both, 'error')).toEqual(DEAD);
    expect(deliveryOf({ state: 'succeeded', port: [] }, 'out')).toEqual(DEAD);
  });

  it('14.1: master-pure retries — attempts, retried codes, fixed / exponential backoff with a cap and stable jitter', () => {
    expect(maxPureAttempts(undefined)).toBe(1);
    expect(maxPureAttempts({ max: 3 })).toBe(4);
    expect(retriesOn(undefined, 'expr_timeout')).toBe(true);
    expect(retriesOn({ on: ['expr_timeout'] }, 'parse_error')).toBe(false);
    expect(retriesOn({ on: ['expr_error'] }, 'expr_error:T2001')).toBe(true);
    expect(retriesOn(undefined, 'cancelled')).toBe(false);
    expect(retriesOn(undefined, 'expr_function_not_allowed')).toBe(false);
    expect(backoffSec({ initialSec: 10 }, 2)).toBe(10);
    expect(backoffSec({ initialSec: 10 }, 4)).toBe(10);
    expect(backoffSec({ backoff: 'exponential', initialSec: 10 }, 2)).toBe(10);
    expect(backoffSec({ backoff: 'exponential', initialSec: 10 }, 4)).toBe(40);
    expect(backoffSec({ backoff: 'exponential', initialSec: 10, maxSec: 30 }, 6)).toBe(30);
    const j = backoffSec({ initialSec: 100, jitter: true }, 2, 'key');
    expect(j).toBeGreaterThanOrEqual(80);
    expect(j).toBeLessThanOrEqual(120);
    expect(backoffSec({ initialSec: 100, jitter: true }, 2, 'key')).toBe(j);
  });

  it('run outcome: dead paths are fine, failures / cancellations / failure skips fail the run', () => {
    expect(runOutcome([{ state: 'succeeded' }, { state: 'skipped', skipReason: 'dead_path' }])).toBe(
      'succeeded',
    );
    expect(runOutcome([{ state: 'succeeded' }, { state: 'skipped', skipReason: 'upstream_failed' }])).toBe(
      'failed',
    );
    expect(runOutcome([{ state: 'cancelled' }])).toBe('failed');
    // A failure routed to an error port (or onError: continue) is handled.
    expect(runOutcome([{ state: 'failed', handled: true }, { state: 'succeeded' }])).toBe('succeeded');
    expect(runOutcome([{ state: 'failed' }])).toBe('failed');
  });
});
