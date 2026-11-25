import type { FastifyBaseLogger } from 'fastify';
import { CloseCode, type WorkerConnection } from './connection.js';
import type { RefusalCode } from './types.js';

/**
 * p5-live-fixes-2: why a newer connection replaces an older one of the same worker. The same worker process
 * (HELLO.instanceId) reconnecting means its previous socket went stale (a network drop the master had not
 * noticed yet — the worker reconnects within seconds, the master's ping needs up to 45 s); a different process
 * means two processes use one device key.
 */
export function replacementReason(
  previousInstance: string | null,
  newInstance: string | null,
): { kind: 'reconnect' | 'other_process' | 'unknown'; reason: string } {
  if (previousInstance !== null && previousInstance === newInstance) {
    return { kind: 'reconnect', reason: 'worker reconnected; the previous connection had gone stale' };
  }
  if (previousInstance !== null && newInstance !== null) {
    return {
      kind: 'other_process',
      reason: `replaced by another process using this worker's key (instance ${newInstance.slice(0, 8)})`,
    };
  }
  return { kind: 'unknown', reason: 'replaced by a newer connection' };
}

/**
 * Registry of live worker connections on this master process (one per worker:
 * a newer authenticated connection replaces an older one with close 4409).
 * Single master replica for now; with several replicas revocation/approval must
 * be fanned out (Redis pub/sub) — documented in docs/design/p2-transport.md.
 */
export class WorkerHub {
  readonly #byWorker = new Map<string, WorkerConnection>();
  readonly #all = new Set<WorkerConnection>();

  constructor(private readonly log: FastifyBaseLogger) {}

  /** Track every socket (also unauthenticated ones) for shutdown. */
  track(connection: WorkerConnection): void {
    this.#all.add(connection);
  }

  untrack(connection: WorkerConnection): void {
    this.#all.delete(connection);
  }

  attach(workerId: string, connection: WorkerConnection): void {
    const previous = this.#byWorker.get(workerId);
    this.#byWorker.set(workerId, connection);
    if (previous !== undefined && previous !== connection) {
      const why = replacementReason(previous.instanceId, connection.instanceId);
      if (why.kind === 'other_process') {
        // p5-live-fixes-2: two processes share one device key (a copied data dir, a second `run`): they would
        // replace each other forever. Loud, so the owner finds the duplicate.
        this.log.warn(
          { workerId, previousInstance: previous.instanceId, newInstance: connection.instanceId },
          'another process with the same worker key replaced the connection',
        );
      } else {
        this.log.info(
          {
            workerId,
            kind: why.kind,
            // p17-chat-reconnect: why the worker dropped the previous connection (its own HELLO report).
            ...(connection.lastDisconnect === null ? {} : { lastDisconnect: connection.lastDisconnect }),
          },
          'newer connection replaces the existing one',
        );
      }
      void previous.shutdown(CloseCode.replaced, why.reason);
    }
  }

  detach(workerId: string, connection: WorkerConnection): void {
    if (this.#byWorker.get(workerId) === connection) this.#byWorker.delete(workerId);
  }

  get(workerId: string): WorkerConnection | undefined {
    return this.#byWorker.get(workerId);
  }

  isConnected(workerId: string): boolean {
    return this.#byWorker.get(workerId)?.phase === 'session';
  }

  get connectedWorkers(): string[] {
    return [...this.#byWorker.entries()].filter(([, c]) => c.phase === 'session').map(([id]) => id);
  }

  get size(): number {
    return this.#all.size;
  }

  /** Close a worker's live connection now (revocation: ADR-0005 §5, within 1 s). */
  async disconnect(
    workerId: string,
    code: number,
    reason: string,
    error?: { code: RefusalCode; message: string },
  ): Promise<boolean> {
    const connection = this.#byWorker.get(workerId);
    if (connection === undefined) return false;
    this.#byWorker.delete(workerId);
    await connection.shutdown(code, reason, error);
    return true;
  }

  /** Master shutdown: every socket gets 1001 and workers reconnect with backoff. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#all].map((c) => c.shutdown(CloseCode.goingAway, 'master shutting down')));
    this.#byWorker.clear();
    this.#all.clear();
  }
}
