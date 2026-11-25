/**
 * p5-live-fixes-2: a minimal invalidation bus. A mutation that changes a count shown elsewhere (approval
 * decided, machine paired) announces it; listeners (the nav badges) refresh at once instead of waiting
 * for their next poll. In-page only — other tabs still catch up on their poll or when they become visible.
 */

/**
 * `chat`: a conversation was read or got a new message (p9-chat-unread: the Chat badge and the tab title).
 * `chat-organize`: a pin, group, tag or star changed (p10-chat-organize: the list sections and the chat sidebar).
 */
/** `questions`: a question card was answered (p14-ask-user: the "Senden bekleyenler" count). */
export type InvalidationTopic = 'approvals' | 'workers' | 'chat' | 'chat-organize' | 'questions';

const EVENT = 'remyral:invalidate';

export function invalidate(topic: InvalidationTopic): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<InvalidationTopic>(EVENT, { detail: topic }));
}

/** Calls `fn` on every invalidation of one of `topics`; returns the unsubscribe function. */
export function onInvalidate(topics: readonly InvalidationTopic[], fn: () => void): () => void {
  const listener = (e: Event): void => {
    const topic = (e as CustomEvent<unknown>).detail;
    if (typeof topic === 'string' && (topics as readonly string[]).includes(topic)) fn();
  };
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener(EVENT, listener);
  };
}

/** Passes a mutation's result through and announces `topic` once it succeeded. */
export function invalidating<T>(topic: InvalidationTopic, p: Promise<T>): Promise<T> {
  return p.then((v) => {
    invalidate(topic);
    return v;
  });
}
