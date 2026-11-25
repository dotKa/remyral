/**
 * Push-based async iterable used as the SDK's streaming input
 * (`query({ prompt: AsyncIterable<SDKUserMessage> })`). Ending it closes the
 * CLI's stdin, which ends the session gracefully after the current turn.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private iterating = false;

  get closed(): boolean {
    return this.ended;
  }

  push(item: T): void {
    if (this.ended) throw new Error('input queue is closed');
    this.items.push(item);
    this.wake();
  }

  /** No further input; the iterator finishes once drained. Idempotent. */
  end(): void {
    this.ended = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iterating) throw new Error('input queue supports a single consumer');
    this.iterating = true;
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
}
