import { join } from 'node:path';
import { atomicWriteFile, removeStaleTemps } from '../fs/atomic.js';
import { FileTooLargeError, type FileOps } from '../fs/ops.js';
import { ensurePrivateDir } from '../fs/permissions.js';
import { DEFAULT_OUTBOX_LIMITS, Outbox, type OutboxLimits, type OutboxLoadReport } from './outbox.js';
import {
  emptyState,
  LeaseRecord,
  StoreState,
  WorkerIdentityRecord,
  type LeaseInput,
  type WorkerIdentityInput,
} from './schema.js';

export const STATE_FILE = 'state.json';
export const OUTBOX_FILE = 'outbox.jsonl';
const MAX_STATE_BYTES = 1024 * 1024;

/** A lease update that would move a job's fencing epoch backwards (ADR-0004). */
export class StaleEpochError extends Error {
  constructor(
    readonly jobId: string,
    readonly heldEpoch: number,
    readonly offeredEpoch: number,
  ) {
    super(`stale epoch for job ${jobId}: holding ${String(heldEpoch)}, offered ${String(offeredEpoch)}`);
    this.name = 'StaleEpochError';
  }
}

export interface StoreOpenReport {
  /** Leftover temp files of interrupted writes that were removed. */
  removedTemps: number;
  /**
   * `state.json` existed but was unreadable/invalid. It was moved aside to
   * `state.json.corrupt-<ts>` and an empty state was used: leases must be
   * reconciled with the master (ADR-0004), never assumed.
   */
  quarantinedCorruptState: string | null;
  outbox: OutboxLoadReport;
}

export interface OpenStoreOptions {
  outboxLimits?: OutboxLimits;
  now?: () => Date;
}

/**
 * Durable local worker state: identity (workerId after enrollment), current
 * leases, replay cursors, and the outbound event buffer. Each mutation is
 * persisted with a crash-safe replace before the returned promise resolves;
 * mutations are serialized so concurrent callers cannot lose updates.
 */
export class WorkerStore {
  #state: StoreState;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly ops: FileOps,
    readonly dir: string,
    state: StoreState,
    readonly outbox: Outbox,
  ) {
    this.#state = state;
  }

  static async open(
    ops: FileOps,
    dir: string,
    options: OpenStoreOptions = {},
  ): Promise<{ store: WorkerStore; report: StoreOpenReport }> {
    await ensurePrivateDir(ops, dir);
    const removedTemps =
      (await removeStaleTemps(ops, dir, STATE_FILE)) + (await removeStaleTemps(ops, dir, OUTBOX_FILE));
    const statePath = join(dir, STATE_FILE);
    let state = emptyState();
    let quarantined: string | null = null;
    let raw: Buffer | null = null;
    let readError = false;
    try {
      raw = await ops.readFile(statePath, MAX_STATE_BYTES);
    } catch (error) {
      if (!(error instanceof FileTooLargeError)) throw error;
      readError = true;
    }
    if (raw !== null || readError) {
      const parsed = readError ? null : parseState(raw);
      if (parsed === null) {
        const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
        quarantined = `${statePath}.corrupt-${stamp}`;
        await ops.rename(statePath, quarantined);
        await ops.fsyncDir(dir);
      } else {
        state = parsed;
      }
    }
    const { outbox, report: outboxReport } = await Outbox.open(
      ops,
      join(dir, OUTBOX_FILE),
      state.cursors.ackedOutboundSeq,
      options.outboxLimits ?? DEFAULT_OUTBOX_LIMITS,
    );
    const store = new WorkerStore(ops, dir, state, outbox);
    if (quarantined !== null) await store.#persist(state);
    return { store, report: { removedTemps, quarantinedCorruptState: quarantined, outbox: outboxReport } };
  }

  /** Deep copy of the current state. */
  get state(): StoreState {
    return structuredClone(this.#state);
  }

  get identity(): WorkerIdentityRecord | null {
    return this.#state.identity === null ? null : { ...this.#state.identity };
  }

  get leases(): LeaseRecord[] {
    return this.#state.leases.map((l) => ({ ...l }));
  }

  async setIdentity(identity: WorkerIdentityInput): Promise<void> {
    const valid = WorkerIdentityRecord.parse(identity);
    await this.#update((s) => ({ ...s, identity: valid }));
  }

  /** Forget the enrollment (re-pairing after revocation / key loss). Leases are dropped too. */
  clearIdentity(): Promise<void> {
    return this.#update((s) => ({ ...s, identity: null, leases: [] }));
  }

  /**
   * Record or renew a lease. A lower epoch than the one held for the same job is
   * rejected (fencing); the same epoch renews (new expiresAt / attempt check).
   */
  async putLease(lease: LeaseInput): Promise<void> {
    const valid = LeaseRecord.parse(lease);
    await this.#update((s) => {
      const held = s.leases.find((l) => l.jobId === valid.jobId);
      if (held !== undefined) {
        if (valid.epoch < held.epoch) throw new StaleEpochError(valid.jobId, held.epoch, valid.epoch);
        if (valid.epoch === held.epoch && valid.attemptId !== held.attemptId) {
          throw new StaleEpochError(valid.jobId, held.epoch, valid.epoch);
        }
      }
      return { ...s, leases: [...s.leases.filter((l) => l.jobId !== valid.jobId), valid] };
    });
  }

  /** Drop the lease of a finished/cancelled/lost job. Returns whether one was held. */
  async removeLease(jobId: string): Promise<boolean> {
    let removed = false;
    await this.#update((s) => {
      removed = s.leases.some((l) => l.jobId === jobId);
      return removed ? { ...s, leases: s.leases.filter((l) => l.jobId !== jobId) } : s;
    });
    return removed;
  }

  /** Advance the master replay cursor. Lower or equal values are ignored (duplicates). */
  async recordMasterSeq(seq: number): Promise<boolean> {
    let advanced = false;
    await this.#update((s) => {
      advanced = seq > s.cursors.lastMasterSeq;
      return advanced ? { ...s, cursors: { ...s.cursors, lastMasterSeq: seq } } : s;
    });
    return advanced;
  }

  /** Explicit reset, e.g. after re-enrollment with a new master. */
  resetMasterCursor(): Promise<void> {
    return this.#update((s) => ({ ...s, cursors: { ...s.cursors, lastMasterSeq: 0 } }));
  }

  /** Master acknowledged everything ≤ `seq`: persist the cursor, then drop those outbox entries. */
  async ackOutbound(seq: number): Promise<void> {
    if (seq >= this.outbox.nextSeq) throw new RangeError(`ack for seq ${String(seq)} that was never sent`);
    await this.#update((s) =>
      seq > s.cursors.ackedOutboundSeq ? { ...s, cursors: { ...s.cursors, ackedOutboundSeq: seq } } : s,
    );
    await this.outbox.dropThrough(seq);
  }

  /**
   * Apply the master's resume cursor (`SESSION_ESTABLISHED.resumeFromSeq`): an
   * implicit ack. A cursor beyond our own numbering means local state was lost;
   * then numbering continues after it. Returns true in that case.
   */
  async resumeOutbound(seq: number): Promise<boolean> {
    if (seq < this.outbox.nextSeq) {
      if (seq + 1 < this.outbox.firstPendingSeq) {
        // p11-master-resilience (ADR-0039): the master is behind what it already acknowledged (its database was
        // restored from a backup). The messages it lost cannot be sent again; the pending ones follow its cursor.
        // Cursor first: a crash between the two steps leaves the old (higher) seqs on disk, never dropped ones.
        await this.#update((s) => ({ ...s, cursors: { ...s.cursors, ackedOutboundSeq: seq } }));
        await this.outbox.renumberAfter(seq);
        this.#rolledBack = true;
        return false;
      }
      await this.ackOutbound(seq);
      return false;
    }
    await this.#update((s) => ({ ...s, cursors: { ...s.cursors, ackedOutboundSeq: seq } }));
    await this.outbox.fastForward(seq);
    return true;
  }

  #rolledBack = false;

  /** p11-master-resilience: true once (then reset) after `resumeOutbound` renumbered for a rolled-back master. */
  takeRollback(): boolean {
    const r = this.#rolledBack;
    this.#rolledBack = false;
    return r;
  }

  /** Wait for all queued writes. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  #update(fn: (s: StoreState) => StoreState): Promise<void> {
    const run = this.#queue.then(async () => {
      const next = fn(this.#state);
      if (next === this.#state) return;
      const valid = StoreState.parse(next);
      await this.#persist(valid);
      this.#state = valid;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #persist(state: StoreState): Promise<void> {
    await atomicWriteFile(this.ops, join(this.dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function parseState(raw: Buffer | null): StoreState | null {
  if (raw === null) return null;
  try {
    const result = StoreState.safeParse(JSON.parse(raw.toString('utf8')));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
