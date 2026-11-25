import { join } from 'node:path';
import { ConfigRejection, WorkerConfigDelivery, workerConfigHash } from '@remyral/protocol';
import { z } from 'zod';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';

/** File in the worker data dir that holds the last applied panel configuration (0600, crash-safe replace). */
export const WORKER_CONFIG_FILE = 'worker-config.json';
const MAX_FILE_BYTES = 512 * 1024;

const ConfigFile = z.object({
  schema: z.literal(1),
  /** The applied delivery (null: none yet — the local file's values are in effect). */
  applied: z
    .object({ appliedAt: z.iso.datetime({ precision: 3 }), delivery: WorkerConfigDelivery })
    .nullable(),
  /** The last delivery that was refused (kept for the report until a newer one is applied). */
  lastRejection: ConfigRejection.nullable(),
});
type ConfigFile = z.infer<typeof ConfigFile>;

/**
 * The worker's copy of its panel-managed configuration (ADR-0015 §6). Written atomically, so a crash leaves
 * the old or the new state, never a mix. On open, an unreadable file or one whose document hash no longer
 * verifies (hand-edited) is ignored: the worker falls back to its local file and reports `source: local`, and
 * the master re-delivers on the next session.
 */
export class WorkerConfigStore {
  #state: ConfigFile = { schema: 1, applied: null, lastRejection: null };

  private constructor(
    private readonly ops: FileOps,
    private readonly path: string,
  ) {}

  static async open(ops: FileOps, dataDir: string): Promise<{ store: WorkerConfigStore; corrupt: boolean }> {
    const store = new WorkerConfigStore(ops, join(dataDir, WORKER_CONFIG_FILE));
    let corrupt = false;
    const raw = await ops.readFile(store.path, MAX_FILE_BYTES).catch(() => null);
    if (raw !== null) {
      try {
        const parsed = ConfigFile.parse(JSON.parse(raw.toString('utf8')));
        const d = parsed.applied?.delivery;
        if (d !== undefined && workerConfigHash(d.document) !== d.documentHash)
          throw new Error('hash mismatch');
        store.#state = parsed;
      } catch {
        corrupt = true;
      }
    }
    return { store, corrupt };
  }

  get delivery(): WorkerConfigDelivery | null {
    return this.#state.applied?.delivery ?? null;
  }

  get appliedAt(): string | null {
    return this.#state.applied?.appliedAt ?? null;
  }

  get generation(): number {
    return this.delivery?.generation ?? 0;
  }

  get lastRejection(): ConfigRejection | null {
    return this.#state.lastRejection;
  }

  async saveApplied(delivery: WorkerConfigDelivery, appliedAt: string): Promise<void> {
    const keep =
      this.#state.lastRejection !== null && this.#state.lastRejection.generation > delivery.generation
        ? this.#state.lastRejection
        : null;
    await this.#write({ schema: 1, applied: { appliedAt, delivery }, lastRejection: keep });
  }

  async saveRejection(rejection: ConfigRejection): Promise<void> {
    await this.#write({ ...this.#state, lastRejection: rejection });
  }

  async #write(next: ConfigFile): Promise<void> {
    await atomicWriteFile(this.ops, this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.#state = next;
  }
}
