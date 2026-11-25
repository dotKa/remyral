import type { Shape } from '../shape.js';
import type tr from '../tr/jobMessages.js';

/** p15-message-delivery: delivery state of messages to a job's agent. */
export default {
  status: {
    waiting: 'Waiting: sent once the agent runs',
    sent: 'Sent',
    received: 'Reached the machine',
    held: 'Reached the machine: sent once the agent starts',
    delivered: 'Delivered to the agent',
    read: 'Read by the agent',
    failed: 'Not delivered',
  },
  steps: {
    sent: 'Sent',
    received: 'Reached the machine',
    delivered: 'Delivered to the agent',
    read: 'Read by the agent',
  },
  failure: {
    job_not_running: 'The machine no longer runs this job (it ended or the machine restarted).',
    attempt_superseded: 'A new attempt of the job started; the message went to the previous one.',
    run_ended: 'The agent’s run ended before it took the message.',
    runtime_refused: 'The runtime did not accept the message.',
    unsupported: 'This runtime takes no messages while it runs.',
    worker_update_required: 'The machine running the job must be updated.',
    job_ended: 'The job ended before the message was sent.',
    unknown: 'The message did not reach the agent.',
  },
  hint: {
    delivered: 'The runtime took the message; the agent reads it at its next step.',
    noReceipts:
      'This machine’s version does not report what happens after delivery; the message shows in the job log.',
    resend: 'Write again',
    resendHint: 'Puts the text back in the message box; you can edit it before sending.',
  },
  composer: {
    queuedPlaceholder: 'Write to the agent: sent once the job starts…',
    queuedHint: 'The agent is not running yet: your message waits and is sent once it starts.',
    sentHint: 'Sent; the delivery state shows next to the message in the log.',
    unavailable: (p: { reason: string }) => `Cannot message the agent: ${p.reason}`,
  },
  box: {
    title: 'Message the agent',
    intro:
      'Goes to the running agent as a follow-up; if the job has not started, it is sent once the agent starts.',
    send: 'Send to agent',
    recent: 'Sent messages',
    by: (p: { who: string; when: string }) => `${p.who} · ${p.when}`,
  },
} satisfies Shape<typeof tr>;
