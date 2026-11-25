import type { Join, OnError } from './v2.js';

/**
 * The pure interpreter core (p14-workflow-engine §2.3): what an edge delivers once its source node run is terminal,
 * and whether a node run is ready, must wait, or is skipped (dead-path elimination). No I/O — the master's engine 2
 * persists node runs and calls these functions on every progress pass.
 *
 * Two kinds of skip travel along edges:
 * - `dead_path` — a branch that was not taken (an `if`'s other port, a switch case). Joins drop it: a node runs when
 *   at least one value arrived, and is itself skipped (dead path) only when every input was a skip.
 * - `upstream_failed` — an upstream failed and its error policy skips its descendants (`onError: skip`, v1
 *   `continue`), or it was cancelled. An `all` join that receives one is skipped too. This is exactly the v1 rule "a
 *   node runs only when all its upstreams succeeded", so normalised v1 documents behave as before.
 */

export type SkipReason = 'dead_path' | 'upstream_failed';

export type Delivery =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value' }
  | { readonly kind: 'skip'; readonly reason: SkipReason };

/** The terminal outcome of a source node run, as far as its outgoing edges are concerned. */
export type SourceOutcome =
  | { readonly state: 'open' }
  /**
   * succeeded with a value on `port` (or on each of several ports — a filter's `kept` and `dropped`, a group's
   * `results` and `done`); every other output port gets a dead-path skip.
   */
  | { readonly state: 'succeeded'; readonly port: string | readonly string[] }
  | { readonly state: 'skipped'; readonly reason: SkipReason }
  | { readonly state: 'cancelled' }
  /** failed: `errorPortConnected` ⇒ a value on `error`; else by `onError` (default fail). */
  | { readonly state: 'failed'; readonly onError: OnError; readonly errorPortConnected: boolean };

/** What one outgoing edge (from `fromPort`) of a source node run delivers. */
export function deliveryOf(source: SourceOutcome, fromPort: string): Delivery {
  switch (source.state) {
    case 'open':
      return { kind: 'pending' };
    case 'succeeded': {
      const ports: readonly string[] = typeof source.port === 'string' ? [source.port] : source.port;
      return ports.includes(fromPort) ? { kind: 'value' } : { kind: 'skip', reason: 'dead_path' };
    }
    case 'skipped':
      return { kind: 'skip', reason: source.reason };
    case 'cancelled':
      return { kind: 'skip', reason: 'upstream_failed' };
    case 'failed':
      if (source.errorPortConnected)
        return fromPort === 'error' ? { kind: 'value' } : { kind: 'skip', reason: 'dead_path' };
      if (source.onError === 'continue')
        return fromPort === 'out' ? { kind: 'value' } : { kind: 'skip', reason: 'dead_path' };
      return { kind: 'skip', reason: 'upstream_failed' };
  }
}

export type Readiness =
  | { readonly verdict: 'wait' }
  /** run with the edges (indexes into the input list) that delivered values. */
  | { readonly verdict: 'run'; readonly values: readonly number[] }
  | { readonly verdict: 'skip'; readonly reason: SkipReason };

/**
 * Readiness of a node run from the deliveries of its incoming edges (one required input port, as every 14.0 node;
 * per-port evaluation composes this function). No incoming edge ⇒ run (a root).
 */
export function readiness(deliveries: readonly Delivery[], join: Join = 'all'): Readiness {
  if (deliveries.length === 0) return { verdict: 'run', values: [] };
  const values = deliveries.flatMap((d, i) => (d.kind === 'value' ? [i] : []));
  const pending = deliveries.filter((d) => d.kind === 'pending').length;
  const failedSkip = deliveries.some((d) => d.kind === 'skip' && d.reason === 'upstream_failed');
  const allSkipReason: SkipReason = failedSkip ? 'upstream_failed' : 'dead_path';
  if (join === 'all') {
    if (pending > 0) return { verdict: 'wait' };
    if (failedSkip) return { verdict: 'skip', reason: 'upstream_failed' };
    return values.length > 0 ? { verdict: 'run', values } : { verdict: 'skip', reason: 'dead_path' };
  }
  if (join === 'any' || join === 'first') {
    if (values.length > 0) return { verdict: 'run', values: values.slice(0, 1) };
    return pending > 0 ? { verdict: 'wait' } : { verdict: 'skip', reason: allSkipReason };
  }
  const need = join.atLeast;
  if (values.length >= need) return { verdict: 'run', values: values.slice(0, need) };
  if (values.length + pending < need) return { verdict: 'skip', reason: allSkipReason };
  return { verdict: 'wait' };
}

/** The effective error policy of a node (v2 default `fail`; v1 `retry-safe` exhausted behaves as fail-fast). */
export function effectiveOnError(onError: OnError | undefined): OnError {
  return onError ?? 'fail';
}

/** How many attempts a node run may take: retries when `retry.safe` (AI steps: default 2 retries, as v1). */
export function maxAttempts(
  retry: { max?: number | undefined; safe?: boolean | undefined } | undefined,
): number {
  if (retry?.safe !== true) return 1;
  return 1 + (retry.max ?? 2);
}

/**
 * Attempts of a master-pure node (deterministic, no side effect ⇒ always safe to repeat): `1 + retry.max` (default no
 * retry). A retry only helps when its inputs can differ, e.g. a timer-dependent expression; the author opts in.
 */
export function maxPureAttempts(retry: { max?: number | undefined } | undefined): number {
  return 1 + (retry?.max ?? 0);
}

/** Whether a failure code is retried (`retry.on`: only these codes; absent ⇒ every code except refusals). */
export function retriesOn(retry: { on?: readonly string[] | undefined } | undefined, code: string): boolean {
  if (code === 'cancelled' || code === 'limit_exceeded' || code === 'expr_function_not_allowed') return false;
  const on = retry?.on;
  return on === undefined || on.length === 0 || on.includes(code) || on.some((c) => code.startsWith(`${c}:`));
}

/**
 * Backoff before attempt `next` (2 = the first retry), in seconds: fixed or exponential from `initialSec` (default 5),
 * capped by `maxSec` (default 3600); `jitter` spreads it by up to ±20 % deterministically from `seed` (the node run's
 * key), so a replay computes the same due time.
 */
export function backoffSec(
  retry:
    | {
        backoff?: 'fixed' | 'exponential' | undefined;
        initialSec?: number | undefined;
        maxSec?: number | undefined;
        jitter?: boolean | undefined;
      }
    | undefined,
  next: number,
  seed = '',
): number {
  const initial = retry?.initialSec ?? 5;
  const cap = retry?.maxSec ?? 3600;
  const n = Math.max(0, next - 2);
  const base = retry?.backoff === 'exponential' ? initial * 2 ** Math.min(n, 20) : initial;
  let s = Math.min(base, cap);
  if (retry?.jitter === true && s > 0) {
    let h = 0;
    for (const c of `${seed}:${String(next)}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    s = Math.min(cap, Math.max(0, Math.round(s * (0.8 + ((h % 1000) / 1000) * 0.4))));
  }
  return s;
}

/**
 * The outcome of a whole run once no node run is open: failed when any node run failed (unless its failure was
 * handled — routed to a connected `error` port, or `onError: continue`), was cancelled, or was skipped because an
 * upstream failed (v1: "nodes did not succeed"); dead-path skips are normal.
 */
export function runOutcome(
  nodeRuns: readonly {
    readonly state: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
    readonly skipReason?: SkipReason | null | undefined;
    readonly handled?: boolean | undefined;
  }[],
): 'succeeded' | 'failed' {
  return nodeRuns.some(
    (n) =>
      (n.state === 'failed' && n.handled !== true) ||
      n.state === 'cancelled' ||
      (n.state === 'skipped' && n.skipReason !== 'dead_path'),
  )
    ? 'failed'
    : 'succeeded';
}
