/**
 * A child process tree owned by the daemon. `OwnedProcess` from
 * @remyral/agent-adapters satisfies this structurally (process group / taskkill /T).
 */
export interface OwnedChild {
  readonly pid: number;
  terminate(options: { graceMs: number }): Promise<unknown>;
}

/**
 * Tracks every child the daemon starts so shutdown can never leave one behind
 * (ADR-0012 rule 4). Adapters register their `OwnedProcess`; shutdown terminates
 * all trees in parallel (graceful signal, then tree kill after `graceMs`).
 */
export class ChildRegistry {
  readonly #children = new Set<OwnedChild>();
  #closed = false;

  /** Register a child; returns an unregister function for normal exit. Refused after shutdown began. */
  add(child: OwnedChild): () => void {
    if (this.#closed) throw new Error('daemon is shutting down; refusing to track a new child');
    this.#children.add(child);
    return () => this.#children.delete(child);
  }

  get size(): number {
    return this.#children.size;
  }

  /** Terminate all registered trees. Errors are collected, never hide a survivor. */
  async terminateAll(graceMs: number): Promise<{ terminated: number; errors: unknown[] }> {
    this.#closed = true;
    const children = [...this.#children];
    const results = await Promise.allSettled(children.map((c) => c.terminate({ graceMs })));
    const errors: unknown[] = [];
    results.forEach((r, i) => {
      const child = children[i];
      if (r.status === 'rejected') errors.push(r.reason);
      else if (child !== undefined) this.#children.delete(child);
    });
    return { terminated: children.length - errors.length, errors };
  }
}
