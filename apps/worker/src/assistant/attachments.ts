import { randomUUID } from 'node:crypto';
import {
  type AssistantAttachmentDataPayload,
  type AssistantAttachmentRef,
  type AssistantAttachmentRequestPayload,
  MAX_CHAT_BINARY_BYTES,
} from '@remyral/protocol';

/**
 * Pulls the bytes of a running turn's attachments from the master (p8-chat-attachments-mentions): one
 * ASSISTANT_ATTACHMENT_REQUEST per slice, answered by ASSISTANT_ATTACHMENT_DATA (control messages, like
 * JOB_INPUT_REQUEST / JOB_INPUT_DATA). Slices are requested sequentially by offset until `eof`; the result is bounded
 * by the ref's size and MAX_CHAT_BINARY_BYTES. The bytes stay in memory (never written to disk). The caller (the
 * assistant host) verifies size, SHA-256 and magic bytes against the signed ref.
 */
export class AttachmentFetchError extends Error {
  constructor(
    readonly code: 'unavailable' | 'refused' | 'not_found' | 'timeout' | 'too_large' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentFetchError';
  }
}

type Send = (payload: AssistantAttachmentRequestPayload) => Promise<void>;

export class AssistantAttachmentFetcher {
  readonly #pending = new Map<string, (p: AssistantAttachmentDataPayload | null) => void>();
  #send: Send | null = null;
  readonly #timeoutMs: number;

  constructor(opts: { readonly send?: Send; readonly timeoutMs?: number } = {}) {
    this.#send = opts.send ?? null;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Where ASSISTANT_ATTACHMENT_REQUEST goes (the daemon's control channel). */
  attach(send: Send): void {
    this.#send = send;
  }

  /** ASSISTANT_ATTACHMENT_DATA: only answers a request this worker is waiting for (anything else is ignored). */
  onData(p: AssistantAttachmentDataPayload): void {
    const resolve = this.#pending.get(p.requestId);
    if (resolve === undefined) return;
    resolve(p);
  }

  /** The master connection dropped: waiting requests fail at once. */
  onDisconnected(): void {
    for (const resolve of [...this.#pending.values()]) resolve(null);
  }

  async fetch(turnId: string, ref: AssistantAttachmentRef, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0;
    const limit = Math.min(ref.sizeBytes, MAX_CHAT_BINARY_BYTES);
    for (;;) {
      if (signal.aborted) throw new AttachmentFetchError('cancelled', 'the turn was cancelled');
      const answer = await this.#slice(turnId, ref.id, offset, signal);
      if (answer.status !== 'ok') {
        throw new AttachmentFetchError(answer.status, `the master answered ${answer.status}`);
      }
      if (answer.offset !== offset) throw new AttachmentFetchError('refused', 'slice out of order');
      const data = Buffer.from(answer.data, 'base64');
      offset += data.length;
      if (offset > limit) throw new AttachmentFetchError('too_large', 'larger than its signed size');
      chunks.push(data);
      if (answer.eof) break;
      if (data.length === 0) throw new AttachmentFetchError('refused', 'empty slice before the end');
    }
    return Buffer.concat(chunks, offset);
  }

  async #slice(
    turnId: string,
    attachmentId: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<AssistantAttachmentDataPayload> {
    const send = this.#send;
    if (send === null) throw new AttachmentFetchError('unavailable', 'no connection to the master');
    const requestId = randomUUID();
    const held: { timer?: NodeJS.Timeout; onAbort?: () => void } = {};
    const answer = new Promise<AssistantAttachmentDataPayload | null | 'cancelled'>((resolve) => {
      held.timer = setTimeout(() => {
        resolve(null);
      }, this.#timeoutMs);
      held.timer.unref();
      held.onAbort = () => {
        resolve('cancelled');
      };
      signal.addEventListener('abort', held.onAbort, { once: true });
      this.#pending.set(requestId, resolve);
    });
    try {
      try {
        await send({ turnId, requestId, attachmentId, offset });
      } catch {
        throw new AttachmentFetchError('unavailable', 'the request could not be sent');
      }
      const m = await answer;
      if (m === 'cancelled') throw new AttachmentFetchError('cancelled', 'the turn was cancelled');
      if (m === null) throw new AttachmentFetchError('timeout', 'the master did not answer in time');
      if (m.turnId !== turnId || m.attachmentId !== attachmentId) {
        throw new AttachmentFetchError('refused', 'answer for another attachment');
      }
      return m;
    } finally {
      clearTimeout(held.timer);
      if (held.onAbort !== undefined) signal.removeEventListener('abort', held.onAbort);
      this.#pending.delete(requestId);
    }
  }
}
