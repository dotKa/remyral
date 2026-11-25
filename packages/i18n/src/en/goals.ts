import type { Shape } from '../shape.js';
import type tr from '../tr/goals.js';

/**
 * p20-outcome: "a result or an explicit intervention" — the intervention card on Needs you: what was asked, what
 * happened, the next step, what you have to do; Resume / Give up / Open the conversation.
 */
export default {
  section: {
    title: 'Goals waiting for your intervention',
    hint: 'Work that cannot move on by itself. One card per goal; resume it or give it up.',
    count: (p: { n: number }) => `${String(p.n)} ${p.n === 1 ? 'goal' : 'goals'}`,
  },
  card: {
    asked: 'What was asked',
    happened: 'What happened',
    next: 'Next step',
    you: 'What you need to do',
    conversation: (p: { title: string }) => `Conversation: ${p.title}`,
    untitledConversation: 'Untitled conversation',
    again: (p: { n: number }) => `${String(p.n)}× now`,
    resume: 'Resume',
    cancel: 'Give up',
    toChat: 'Open the conversation',
    cancelConfirm: 'Give up this goal?',
    cancelPlanConfirm: 'Cancel the plan?',
    confirmYes: 'Yes, give up',
    confirmNo: 'No',
    resumed: 'Resumed. The assistant is back on it in the conversation.',
    cancelled: 'Given up.',
  },
  origin: {
    plan: 'Plan',
    job: 'Job',
    workflow_run: 'Workflow',
    watch: 'Watch',
  },
  reason: {
    follow_up_cap: 'The automatic follow-up limit was reached (3 tries in 6 hours).',
    follow_up_window: 'The watch ended unmet but no follow-up turn started in time.',
    assistant_unavailable: 'The assistant is unreachable right now; it could not carry on.',
    assistant_error: 'The assistant could not start the follow-up turn.',
    budget: 'The cost brake or the daily budget stopped it.',
    job_failed: 'The job failed and no automatic fix is left.',
    run_failed: 'The workflow run failed.',
    plan_stalled: 'The plan stalled.',
    plan_item_failed: 'A plan item used up its retries.',
    no_progress: 'Nothing moved in the expected time.',
    assistant_declared: 'The assistant cannot carry on without a step from you.',
    other: 'The goal cannot move on by itself.',
  },
  action: {
    follow_up_cap: 'Look at the reason; resume it if it can be fixed, give it up if not.',
    follow_up_window: 'Resume: the assistant finds out why and gets back to it.',
    assistant_unavailable: 'Check that the assistant machine is online, then resume.',
    assistant_error: 'Look at the conversation and resume.',
    budget: 'Check the budget or the cost brake, then resume.',
    job_failed: 'Look at the job’s error; resume to have it fixed, or give it up.',
    run_failed: 'Look at the run’s error; resume to retry, or give it up.',
    plan_stalled: 'Resume the plan or cancel it.',
    plan_item_failed: 'The item needs another way: resume or give it up.',
    no_progress: 'Resume: the assistant reads the state and takes the next step.',
    assistant_declared: 'Do what the assistant asks, then resume.',
    other: 'Resume or give it up.',
  },
  nextAction: {
    plan_continue: 'Plan continuation turn',
    follow_up: 'The assistant’s follow-up turn',
    assistant_turn: 'The assistant’s next turn',
    assistant_step: 'The step the assistant recorded',
    resume: 'Sending the resume turn',
    user_action: 'Your step',
    other: 'Your decision',
  },
  resumeLine: (p: { title: string }) => `The assistant checks the goal: ${p.title}`,
  resumeLinePlain: 'The assistant checks the goal',
} satisfies Shape<typeof tr>;
