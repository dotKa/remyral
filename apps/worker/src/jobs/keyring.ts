import {
  type LeaseExpectation,
  type LeaseKey,
  type LeaseTokenResult,
  type VaultScopeResult,
  verifyLeaseToken,
  verifyVaultScope,
} from '@remyral/protocol';

/**
 * Master lease-signing keys the worker trusts (p4-leases, docs/design/p4-orchestration.md §2).
 *
 * Decision: the keys arrive in every SESSION_ESTABLISHED over the already authenticated session (TLS 1.3
 * with WebPKI + the device's challenge-response), so the master can rotate its signing key without
 * touching the fleet. A fleet that wants an independent trust root pins `masterLeaseKeys` in the worker
 * config: then only pinned keys are accepted, whatever the session announces. Keys are held in memory
 * only; after a restart the next session delivers them again before any lease is needed.
 */
export class LeaseKeyring {
  #session: readonly LeaseKey[] = [];

  constructor(private readonly pinned: readonly LeaseKey[] | null = null) {}

  /** Whether the trust set is pinned in the worker config (`masterLeaseKeys`). */
  get isPinned(): boolean {
    return this.pinned !== null;
  }

  /** Keys announced by the current session (replaces the previous set). */
  setSessionKeys(keys: readonly LeaseKey[] | undefined): void {
    this.#session = [...(keys ?? [])];
  }

  /** Effective trust set: the pin if configured, otherwise the session's keys. */
  get keys(): readonly LeaseKey[] {
    if (this.pinned === null) return this.#session;
    return this.pinned;
  }

  /** Whether the session announced keys that are not pinned (logged as a warning by the caller). */
  unpinnedSessionKeys(): readonly LeaseKey[] {
    if (this.pinned === null) return [];
    return this.#session.filter(
      (k) => !this.pinned?.some((p) => p.kid === k.kid && p.publicKey === k.publicKey),
    );
  }

  verify(token: string, expect: LeaseExpectation): LeaseTokenResult {
    return verifyLeaseToken(token, this.keys, expect);
  }

  /** ASSIGN_JOB `lease.vaultScope`: same trust set, bound to the lease it came with. */
  verifyVaultScope(
    token: string,
    expect: Pick<LeaseExpectation, 'jobId' | 'attemptId' | 'workerId' | 'epoch'>,
  ): VaultScopeResult {
    return verifyVaultScope(token, this.keys, expect);
  }
}
