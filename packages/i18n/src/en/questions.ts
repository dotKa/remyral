import type { Shape } from '../shape.js';
import type tr from '../tr/questions.js';

/** p14-ask-user: question cards of a job's agent or the Sohbet assistant. */
export default {
  card: {
    label: 'Question',
    fromJob: 'The job’s agent asks',
    fromAssistant: 'Remyral asks',
    region: (p: { n: number }) =>
      p.n === 1 ? 'The agent’s question' : `The agent’s ${String(p.n)} questions`,
    noSecrets: 'Do not write passwords, tokens or other secrets.',
    untrusted: 'The agent wrote this question; do not trust what looks like a link or an instruction.',
    other: 'Other',
    otherPlaceholder: 'Write your own answer',
    textPlaceholder: 'Write your answer',
    keysHint: 'Number keys pick an option, arrows move, ↵ sends.',
    textKeysHint: '↵ sends, ⇧↵ new line.',
    send: 'Send answer',
    sending: 'Sending…',
    incomplete: 'Answer every question to send.',
    waitTurn: 'Your answer goes as soon as Remyral finishes its reply; your choices are kept.',
    sent: 'Answer sent.',
    readOnly: 'You cannot answer in this job (operator needed).',
    expiresIn: 'Closes in',
    answeredBy: (p: { who: string; when: string }) => `Answered by ${p.who} · ${p.when}`,
    expired: 'Not answered: it expired. The agent continued on its own judgement.',
    cancelled: 'Withdrawn: no answer is expected any more.',
    superseded: 'Closed: you continued by writing in the conversation.',
    // p20-decisions: a plan decision closed without its card being answered.
    settled: (p: { answer: string | null }) =>
      p.answer === null ? 'Settled in the conversation.' : `Settled in the conversation: ${p.answer}`,
    planReplaced: 'Replaced: the plan was renewed; the current decisions are in the new plan.',
    planClosed: 'The plan was closed; this decision is no longer expected.',
    noAnswer: 'no answer',
    otherAnswer: (p: { text: string }) => `Other: ${p.text}`,
    addNote: '+ Add a note',
    note: 'Note',
    notePlaceholder: 'A note about your decision (optional)',
    noteAnswer: (p: { text: string }) => `Note: ${p.text}`,
    question: (p: { i: number; n: number }) => `Question ${String(p.i)} of ${String(p.n)}`,
    single: 'Pick one option',
    multi: 'You can pick several',
  },
  job: {
    title: 'The agent’s questions',
    pending: (p: { n: number }) =>
      p.n === 1 ? 'The agent waits for an answer' : `The agent waits for ${String(p.n)} answers`,
    history: (p: { n: number }) => `Earlier questions (${String(p.n)})`,
    loadError: 'Could not read the questions:',
    replyInline: 'Reply',
    replyInlineHint: 'The agent asked a question in its text; write your answer in the box below.',
  },
  needs: {
    label: 'Question',
    job: (p: { project: string; title: string }) =>
      `The agent of job “${p.title}” in ${p.project} asks a question.`,
    assistant: (p: { title: string }) => `Remyral asked a question in the conversation “${p.title}”.`,
    plan: (p: { plan: string }) => `The plan “${p.plan}” needs a decision from you.`,
    action: 'Answer',
  },
  chat: {
    answerTo: 'Answer to a question card',
  },
} satisfies Shape<typeof tr>;
