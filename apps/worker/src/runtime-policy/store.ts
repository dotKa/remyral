import { join } from 'node:path';
import {
  type AppliedRuntimePolicy,
  type MasterToWorker,
  RuntimePolicyDelivery,
  runtimePolicyHash,
  runtimePolicyIssues,
} from '@remyral/protocol';
import { z } from 'zod';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';

/** File in the worker data dir that holds the last applied runtime policy (0600, crash-safe replace). */
export const RUNTIME_POLICY_FILE = 'runtime-policy.json';
const MAX_FILE_BYTES = 256 * 1024;

type UpdatePolicyPayload = Extract<MasterToWorker, { type: 'UPDATE_POLICY' }>['payload'];

const PolicyFile = z.object({
  schema: z.literal(1),
  /** UPDATE_POLICY.policyVersion: the master's monotonic delivery generation for this worker. */
  generation: z.number().int().min(1),
  receivedAt: z.iso.datetime({ precision: 3 }),
  /** null: the master cleared the runtime policy (compiled-in pins apply again). */
  policy: RuntimePolicyDelivery.nullable(),
});
type PolicyFile = z.infer<typeof PolicyFile>;

export type ApplyOutcome =
  | { readonly status: 'applied'; readonly policy: RuntimePolicyDelivery | null; readonly changed: boolean }
  | { readonly status: 'stale'; readonly generation: number }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * The worker's copy of its master-managed runtime policy (docs/design/p3-runtime-policy.md §5). A delivery
 * is applied only when it is newer than the stored one, its document hash verifies and it passes the shared
 * consistency rules; the file is replaced atomically, so a crash leaves the old or the new policy, never a
 * mix. A corrupt file is ignored (the worker falls back to its compiled-in pins and reports no policy, and
 * the master re-delivers).
 */
export class RuntimePolicyStore {
  #current: PolicyFile | null = null;

  private constructor(
    private readonly ops: FileOps,
    private readonly path: string,
    private readonly clock: () => Date,
  ) {}

  static async open(
    ops: FileOps,
    dataDir: string,
    clock: () => Date = () => new Date(),
  ): Promise<{ store: RuntimePolicyStore; corrupt: boolean }> {
    const store = new RuntimePolicyStore(ops, join(dataDir, RUNTIME_POLICY_FILE), clock);
    let corrupt = false;
    const raw = await ops.readFile(store.path, MAX_FILE_BYTES).catch(() => null);
    if (raw !== null) {
      try {
        const parsed = PolicyFile.parse(JSON.parse(raw.toString('utf8')));
        if (parsed.policy !== null && !verifies(parsed.policy)) throw new Error('hash mismatch');
        store.#current = parsed;
      } catch {
        corrupt = true;
      }
    }
    return { store, corrupt };
  }

  /** The applied policy (null: none — compiled-in pins apply). */
  get policy(): RuntimePolicyDelivery | null {
    return this.#current?.policy ?? null;
  }

  get generation(): number {
    return this.#current?.generation ?? 0;
  }

  /** For CAPABILITIES (AppliedRuntimePolicy). */
  get applied(): AppliedRuntimePolicy | undefined {
    const p = this.policy;
    return p === null ? undefined : { name: p.name, version: p.version, documentHash: p.documentHash };
  }

  /** Validates and persists an UPDATE_POLICY payload. Never throws for a bad delivery: returns why. */
  async apply(payload: UpdatePolicyPayload): Promise<ApplyOutcome> {
    if (payload.policyVersion <= this.generation) return { status: 'stale', generation: this.generation };
    const delivery = payload.policy.runtimePolicy ?? null;
    if (delivery !== null) {
      if (!verifies(delivery)) return { status: 'rejected', reason: 'document hash does not match' };
      const issues = runtimePolicyIssues(delivery.document);
      if (issues.length > 0) {
        return {
          status: 'rejected',
          reason: `inconsistent policy: ${issues
            .map((i) => `${i.path}:${i.code}`)
            .join(', ')
            .slice(0, 300)}`,
        };
      }
    }
    const previous = this.policy;
    const next: PolicyFile = {
      schema: 1,
      generation: payload.policyVersion,
      receivedAt: this.clock().toISOString(),
      policy: delivery,
    };
    await atomicWriteFile(this.ops, this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.#current = next;
    return { status: 'applied', policy: delivery, changed: identity(previous) !== identity(delivery) };
  }
}

function identity(p: RuntimePolicyDelivery | null): string {
  return p === null ? '' : `${p.name}@${String(p.version)}#${p.documentHash}`;
}

function verifies(delivery: RuntimePolicyDelivery): boolean {
  return runtimePolicyHash(delivery.document) === delivery.documentHash;
}
