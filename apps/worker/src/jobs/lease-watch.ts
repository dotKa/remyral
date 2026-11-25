/**
 * When a running attempt must self-fence (ADR-0004 §2, p11-master-resilience / ADR-0039). Pure: the runner feeds it
 * monotonic times (never wall-clock: a clock step must not stretch a grace).
 *
 * Two rules:
 *  - classic (every lease): no confirmed renewal for `ttl + selfFenceGrace` → stop the attempt;
 *  - offline grace (leases with `offlineGraceMs > 0`, after one renewal that answered a known LEASE_ACK): while the
 *    master cannot be reached at all, the attempt runs until `ackConfirmedAt + ttl + offlineGrace`. `ackConfirmedAt` is
 *    the SEND time of the acknowledgement the master answered — the master renewed no earlier than that, so its hold
 *    (`expires_at + grace + margin`) always outlasts this deadline, however late the renewal itself arrived.
 *    While connected, the classic rule applies again from the later of the last confirmation and the session start:
 *    a reachable master that does not renew (or refuses: the runner fences at once) is not an outage.
 */
export interface LeaseWatch {
  readonly ttlMs: number;
  readonly selfFenceGraceMs: number;
  /** 0: no offline grace (older masters, workers without the grant). */
  readonly offlineGraceMs: number;
  /** When the lease was last confirmed (assignment or any renewal received). */
  readonly confirmedAt: number;
  /** Send time of the LEASE_ACK the newest ack-correlated renewal answered; null: none yet under this epoch. */
  readonly ackConfirmedAt: number | null;
  readonly connected: boolean;
  /** When the current session was established (null: unknown / connected since before the lease). */
  readonly connectedSince: number | null;
}

/** The monotonic instant at which the attempt must stop. */
export function fenceDeadline(w: LeaseWatch): number {
  const classic = w.confirmedAt + w.ttlMs + w.selfFenceGraceMs;
  if (w.offlineGraceMs <= 0 || w.ackConfirmedAt === null) return classic;
  const offline = Math.max(classic, w.ackConfirmedAt + w.ttlMs + w.offlineGraceMs);
  if (!w.connected) return offline;
  const since = Math.max(w.confirmedAt, w.connectedSince ?? w.confirmedAt);
  return Math.min(offline, since + w.ttlMs + w.selfFenceGraceMs);
}

/** How often the runner re-evaluates a lease (renewal sends and the fence check): a fraction of the renew interval. */
export function watchPeriodMs(renewEveryMs: number): number {
  return Math.min(1_000, Math.max(50, Math.floor(renewEveryMs / 4)));
}
