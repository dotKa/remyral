import type { Shape } from '../shape.js';
import type tr from '../tr/chatQueue.js';

/**
 * p22-chat-queue: messages written while Remyral answers wait ("Queued"); when the answer ends they are all sent
 * together as the next turn. The bubble's buttons: edit, remove, send now (stops the answer).
 */
export default {
  label: 'Queued messages',
  badge: 'Queued',
  note: 'Sent when the answer ends',
  files: (p: { n: number }) => (p.n === 1 ? '1 file' : `${String(p.n)} files`),
  edit: 'Edit',
  editLabel: 'Edit the queued message',
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Remove',
  removeLabel: 'Remove the queued message',
  sendNow: 'Send now',
  sendNowHint: 'Stops the answer; the queued messages are sent right away.',
  failed: (p: { error: string }) => `That did not work: ${p.error}`,
  held: {
    assistant_unavailable: 'The assistant cannot answer right now; it is sent once it can.',
    rate_limited: 'The message limit was reached; it is tried again in a few minutes.',
    budget_exceeded: 'The chat budget is used up; it is sent once the budget allows.',
    other: 'Waiting to be sent; it is tried again.',
  },
} satisfies Shape<typeof tr>;
