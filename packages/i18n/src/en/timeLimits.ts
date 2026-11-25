import type { Shape } from '../shape.js';
import type tr from '../tr/timeLimits.js';

export default {
  title: 'Time limit',
  current: (p) => `Time limit: ${p.time}`,
  original: (p) => `originally ${p.time}`,
  add: (p) => `+${p.time}`,
  custom: 'Minutes',
  apply: 'Apply',
  saving: 'Saving…',
  applied: (p) => `The time limit is now ${p.time}; the job continues without restarting.`,
  appliedLater: (p) => `The time limit is now ${p.time}; it applies when the job starts.`,
  waiting: 'Waiting for the machine to confirm.',
  refused: 'The machine refused the new limit; the job keeps the previous one.',
  liveUnsupported:
    'This machine cannot change the limit while the job runs; the new limit applies from the next attempt (update the machine).',
  max: (p) => `At most ${p.time} (security policy).`,
  outOfRange: (p) => `The limit must be between ${p.min} and ${p.max}.`,
  failed: (p) => `Could not change the limit: ${p.reason}`,
  draftLabel: 'Time limit (minutes)',
  draftHint:
    'The job is stopped after this much run time (approval waits do not count). It can be extended while it runs.',
  minutes: (p) => `${String(p.n)} min`,
  hours: (p) => `${String(p.n)} h`,
  hoursMinutes: (p) => `${String(p.h)} h ${String(p.m)} min`,
  days: (p) => `${String(p.n)} days`,
  clock: {
    used: (p) => `Run time: ${p.used} / ${p.budget}`,
    left: (p) => `${p.time} left`,
    questionWait: (p) => `${p.time} spent waiting for answers did not count.`,
    approvalWait: (p) => `${p.time} spent waiting for approvals did not count.`,
    waitingQuestion: 'It is waiting for an answer to a question now; the clock is stopped.',
    waitingApproval: 'It is waiting for an approval now; the clock is stopped.',
    oldMachine:
      'This machine does not stop the clock while a question waits; once it is updated (version 1.2.13) waits do not count.',
    warned: (p) => `The "running out of time" warning went out (${p.time}).`,
    timedOut:
      'The job stopped because its time limit ran out. It can continue from where it was, with a longer limit.',
    continue: 'Continue where it stopped',
    openJob: 'Open the job',
    continueWith: (p) => `Continue where it stopped (${p.time})`,
    continued: (p) => `Continuation job started: ${p.id}`,
    openContinued: 'Open the continuation job',
    continueFailed: (p) => `Could not continue: ${p.reason}`,
    extend: 'Extend the time',
    expired: 'Time ran out',
    keptPushed: (p) =>
      `The work was not lost: ${String(p.files)} changed file(s) were pushed to ${p.branch} (not merged). "Continue where it stopped" carries on from that work.`,
    keptLocal: (p) =>
      `The work was not lost but could not be pushed: ${String(p.files)} changed file(s) are kept on ${p.machine} only. "Continue where it stopped" carries on from that work on that machine.`,
    nothingKept: 'There was no change to keep before the time ran out.',
    autoChange: 'automatic extension',
  },
  approval: {
    extend: 'Extend the decision deadline',
    deadline: (p) => `Expires ${p.time} unless someone decides.`,
    extended: (p) => `New deadline: ${p.time}.`,
    failed: (p) => `Could not extend: ${p.reason}`,
  },
} satisfies Shape<typeof tr>;
