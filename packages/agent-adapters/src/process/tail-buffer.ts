/** Keeps only the last `maxBytes` bytes written (bounded stdout/stderr capture). */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes >= 1');
  }

  push(chunk: Buffer): void {
    let data = chunk;
    if (data.length > this.maxBytes) {
      this.dropped += data.length - this.maxBytes;
      data = data.subarray(data.length - this.maxBytes);
    }
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.maxBytes) {
      const head = this.chunks[0];
      if (!head) break;
      const excess = this.size - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
        this.dropped += head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
        this.dropped += excess;
      }
    }
  }

  /** Bytes discarded so far (so callers can mark the tail as truncated). */
  get droppedBytes(): number {
    return this.dropped;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
