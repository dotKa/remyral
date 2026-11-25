import type { ApprovalDecision } from '../../contract.js';

/** How a pending approval was settled. Only `human` can ever approve. */
export type ApprovalCause = 'human' | 'timeout' | 'aborted' | 'session-ended' | 'policy';

export interface ApprovalOutcome {
  readonly decision: 'approve' | 'deny';
  readonly cause: ApprovalCause;
  readonly reason?: string;
  readonly decidedBy?: string;
}

interface Pending {
  readonly settle: (outcome: ApprovalOutcome) => void;
}

/**
 * Bridges a runtime's approval callback (Claude `canUseTool`, Codex server
 * requests) to `AgentAdapter.requestApproval`. Fail-closed: anything other
 * than an explicit human `approve` — timeout, abort, session end — is a deny.
 * Shared by the Claude Code and Codex adapters (adapters-b).
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('approval timeout must be > 0');
  }

  get size(): number {
    return this.pending.size;
  }

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /** Wait for a human decision; denies on timeout or when `signal` aborts. */
  wait(approvalId: string, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (this.pending.has(approvalId)) {
      return Promise.reject(new Error(`approval ${approvalId} is already pending`));
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const finish = (outcome: ApprovalOutcome): void => {
        if (!this.pending.has(approvalId)) return;
        this.pending.delete(approvalId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => {
        finish({ decision: 'deny', cause: 'aborted' });
      };
      const timer = setTimeout(() => {
        finish({ decision: 'deny', cause: 'timeout' });
      }, this.timeoutMs);
      this.pending.set(approvalId, { settle: finish });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Deliver a human decision. Returns false for an unknown/already settled approval. */
  decide(decision: ApprovalDecision): boolean {
    const p = this.pending.get(decision.approvalId);
    if (!p) return false;
    p.settle({
      decision: decision.decision,
      cause: 'human',
      decidedBy: decision.decidedBy,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    });
    return true;
  }

  /** Deny everything still pending (cancel, cleanup, crash). */
  denyAll(cause: Exclude<ApprovalCause, 'human'>): void {
    for (const p of [...this.pending.values()]) p.settle({ decision: 'deny', cause });
  }
}
