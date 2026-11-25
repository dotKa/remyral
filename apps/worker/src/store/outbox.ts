import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { OutboxEntry } from './schema.js';

export interface OutboxLimits {
  /** Max entries waiting for acknowledgement. Default 10 000. */
  maxEntries: number;
  /** Max bytes of serialized entries waiting for acknowledgement. Default 8 MiB. */
  maxBytes: number;
}

export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = { maxEntries: 10_000, maxBytes: 8 * 1024 * 1024 };

/** The bounded buffer is full: the producer must apply backpressure (never drop silently). */
export class OutboxFullError extends Error {
  constructor(readonly limits: OutboxLimits) {
    super(`outbound buffer full (${String(limits.maxEntries)} entries / ${String(limits.maxBytes)} bytes)`);
    this.name = 'OutboxFullError';
  }
}

export interface OutboxLoadReport {
  /** Entries restored for replay. */
  restored: number;
  /** A torn last line (crash during append) was dropped. */
  droppedTornTail: boolean;
  /** Unparseable lines that were not the last line (disk corruption). */
  droppedCorrupt: number;
}

interface Item {
  seq: number;
  line: string;
  message: unknown;
}

/**
 * Durable outbound event buffer (ADR-0011 replay; p2-replay builds on it).
 *
 * Format: JSON lines `{"seq":n,"message":{…}}` appended with fsync. A crash during
 * an append can only tear the last line, which is detected (no trailing newline /
 * invalid JSON) and dropped on load — that message was never acknowledged as
 * queued to its producer, so it is not lost silently. Acknowledged entries are
 * removed by an atomic rewrite (compaction).
 */
export class Outbox {
  #items: Item[] = [];
  #bytes = 0;
  #nextSeq: number;
  #fileBytes = 0;
  /** Set when an append failed midway; the next write rewrites the file first. */
  #needsCompact = false;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly ops: FileOps,
    private readonly path: string,
    private readonly limits: OutboxLimits,
    ackedSeq: number,
  ) {
    this.#nextSeq = ackedSeq + 1;
  }

  static async open(
    ops: FileOps,
    path: string,
    ackedSeq: number,
    limits: OutboxLimits = DEFAULT_OUTBOX_LIMITS,
  ): Promise<{ outbox: Outbox; report: OutboxLoadReport }> {
    const outbox = new Outbox(ops, path, limits, ackedSeq);
    const raw = await ops.readFile(path, limits.maxBytes * 2 + 1024 * 1024);
    const report: OutboxLoadReport = { restored: 0, droppedTornTail: false, droppedCorrupt: 0 };
    if (raw === null) return { outbox, report };
    const text = raw.toString('utf8');
    const lines = text.split('\n');
    const tail = lines.pop() ?? '';
    if (tail !== '') report.droppedTornTail = true;
    let maxSeq = ackedSeq;
    for (const line of lines) {
      if (line === '') continue;
      let entry: OutboxEntry;
      try {
        entry = OutboxEntry.parse(JSON.parse(line));
      } catch {
        report.droppedCorrupt++;
        continue;
      }
      maxSeq = Math.max(maxSeq, entry.seq);
      if (entry.seq <= ackedSeq) continue;
      outbox.#items.push({ seq: entry.seq, line: `${line}\n`, message: entry.message });
      outbox.#bytes += Buffer.byteLength(line) + 1;
    }
    outbox.#items.sort((a, b) => a.seq - b.seq);
    outbox.#nextSeq = maxSeq + 1;
    outbox.#fileBytes = raw.length;
    report.restored = outbox.#items.length;
    // Rewrite if anything had to be dropped, so the file ends with a newline again.
    if (
      report.droppedTornTail ||
      report.droppedCorrupt > 0 ||
      outbox.#items.length !== lines.filter(Boolean).length
    ) {
      await outbox.#compact();
    }
    return { outbox, report };
  }

  /** Number of unacknowledged entries. */
  get size(): number {
    return this.#items.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** The seq the next append will get. */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  /**
   * Durably queue a message. `build` receives the assigned seq and returns the
   * (already redacted) JSON-serialisable message. Resolves once fsynced.
   */
  append(build: (seq: number) => unknown): Promise<number> {
    return this.#serial(() => this.#append(build));
  }

  async #append(build: (seq: number) => unknown): Promise<number> {
    if (this.#needsCompact) await this.#compact();
    const seq = this.#nextSeq;
    const message = build(seq);
    const line = `${JSON.stringify({ seq, message })}\n`;
    const size = Buffer.byteLength(line);
    if (this.#items.length + 1 > this.limits.maxEntries || this.#bytes + size > this.limits.maxBytes) {
      throw new OutboxFullError(this.limits);
    }
    try {
      await this.ops.append(this.path, line, 0o600);
    } catch (error) {
      // A partial line may now be on disk; never append behind it.
      this.#needsCompact = true;
      throw error;
    }
    this.#nextSeq = seq + 1;
    this.#items.push({ seq, line, message });
    this.#bytes += size;
    this.#fileBytes += size;
    return seq;
  }

  /** Entries with seq > `afterSeq`, in order (replay after reconnect). */
  pending(afterSeq = 0): { seq: number; message: unknown }[] {
    return this.#items.filter((i) => i.seq > afterSeq).map(({ seq, message }) => ({ seq, message }));
  }

  /**
   * Drop entries ≤ `seq` from memory. The caller persists the acked cursor first
   * (WorkerStore.ackOutbound), so entries left in the file are ignored on load.
   * Compacts the file when it is mostly acknowledged data.
   */
  dropThrough(seq: number): Promise<number> {
    return this.#serial(() => this.#dropThrough(seq));
  }

  async #dropThrough(seq: number): Promise<number> {
    const before = this.#items.length;
    this.#items = this.#items.filter((i) => i.seq > seq);
    this.#bytes = this.#items.reduce((n, i) => n + Buffer.byteLength(i.line), 0);
    const removed = before - this.#items.length;
    if (removed > 0 && (this.#items.length === 0 || this.#bytes * 2 < this.#fileBytes)) await this.#compact();
    return removed;
  }

  /**
   * The peer already processed seqs up to `seq`, beyond anything this outbox
   * assigned (local state was lost/reset): continue numbering after it so new
   * messages are not mistaken for duplicates. Drops everything pending.
   */
  fastForward(seq: number): Promise<void> {
    return this.#serial(async () => {
      if (seq < this.#nextSeq) return;
      this.#items = [];
      this.#bytes = 0;
      this.#nextSeq = seq + 1;
      await this.#compact();
    });
  }

  /** Seq of the oldest pending entry (or `nextSeq` when nothing is pending). */
  get firstPendingSeq(): number {
    return this.#items[0]?.seq ?? this.#nextSeq;
  }

  /**
   * p11-master-resilience (ADR-0039): the master's cursor is behind entries this outbox already dropped as
   * acknowledged — its database was restored from a backup and lost them. Renumbers every pending entry (and the
   * `seq` inside its message) to follow `seq` contiguously, so the restored master sees no gap; numbering continues
   * after them. No-op when nothing is missing.
   */
  renumberAfter(seq: number): Promise<number> {
    return this.#serial(async () => {
      const first = this.#items[0]?.seq ?? this.#nextSeq;
      if (seq + 1 >= first) return 0;
      let next = seq + 1;
      this.#items = this.#items.map((i) => {
        const n = next++;
        const message =
          typeof i.message === 'object' && i.message !== null ? { ...i.message, seq: n } : i.message;
        return { seq: n, message, line: `${JSON.stringify({ seq: n, message })}\n` };
      });
      this.#bytes = this.#items.reduce((acc, i) => acc + Buffer.byteLength(i.line), 0);
      this.#nextSeq = next;
      await this.#compact();
      return this.#items.length;
    });
  }

  async #compact(): Promise<void> {
    const data = this.#items.map((i) => i.line).join('');
    await atomicWriteFile(this.ops, this.path, data, { mode: 0o600 });
    this.#fileBytes = Buffer.byteLength(data);
    this.#needsCompact = false;
  }

  /** Run operations one at a time, in call order (seq assignment must not interleave). */
  #serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(op, op);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
