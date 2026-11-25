import type { Queryable } from '../db/pool.js';

/**
 * p22-ops-hygiene (docs/design/p22-ops-hygiene.md): retention of the `worker_inbox` journal (40 000 rows on the test
 * server, never pruned). What the journal is still needed for, and why 7 days is safe:
 *
 * - **Exactly-once / replay dedupe** does not read it: duplicates are refused by the per-worker cursor
 *   (`workers.last_worker_seq`, seq ≤ cursor) and the bounded `worker_processed_messages` window; a pruned row can
 *   never be "re-applied" because its seq stays below the cursor.
 * - **Effect retries** (`Orchestrator.retryEffects`) read rows whose effect is `pending` / `running` — never pruned.
 * - **The output report** (`GET /jobs/:id/output-report`, p17-output-limits) reads rejected `ARTIFACT_REF` rows of a
 *   job's last attempt — kept (few rows; they explain why an output is missing for as long as the job is shown).
 * - Everything else (live view, events, logs, results) lives in its own tables; the raw journal is only diagnostics.
 */
export const INBOX_RETENTION_DAYS = 7;
const DAY = 24 * 60 * 60_000;

export interface InboxRetentionOptions {
  readonly db: Queryable;
  readonly clock: () => Date;
  /** Default 7 days. */
  readonly retentionMs?: number;
  /** Rows per DELETE (default 5 000) and DELETEs per pass (default 20). */
  readonly batch?: number;
  readonly maxBatches?: number;
  /** A pass runs at most this often (default 1 h; the orchestrator tick calls {@link maybePrune} every 2 s). */
  readonly everyMs?: number;
}

export class WorkerInboxRetention {
  readonly #o: InboxRetentionOptions;
  #last = Number.NEGATIVE_INFINITY;

  constructor(opts: InboxRetentionOptions) {
    this.#o = opts;
  }

  /** The tick step: a pass when the last one is older than `everyMs`. Returns the rows deleted. */
  async maybePrune(): Promise<number> {
    const t = this.#o.clock().getTime();
    if (t - this.#last < (this.#o.everyMs ?? 60 * 60_000)) return 0;
    this.#last = t;
    return this.prune();
  }

  /** Deletes processed journal rows older than the retention, in bounded batches (oldest first). */
  async prune(): Promise<number> {
    const before = new Date(this.#o.clock().getTime() - (this.#o.retentionMs ?? INBOX_RETENTION_DAYS * DAY));
    const batch = this.#o.batch ?? 5_000;
    let total = 0;
    for (let i = 0; i < (this.#o.maxBatches ?? 20); i++) {
      const r = await this.#o.db.query(
        `DELETE FROM worker_inbox WHERE id IN (
           SELECT id FROM worker_inbox
            WHERE received_at < $1
              AND (effect_status IS NULL OR effect_status IN ('done', 'failed'))
              AND NOT (type = 'ARTIFACT_REF' AND outcome = 'rejected')
            ORDER BY id LIMIT $2)`,
        [before, batch],
      );
      const n = r.rowCount ?? 0;
      total += n;
      if (n < batch) break;
    }
    return total;
  }
}
