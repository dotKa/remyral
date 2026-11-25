import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { answerChatQuestion, answerJobQuestion, type QuestionSet } from '../../api/questions';
import { useT } from '../../i18n/I18nProvider';
import { invalidate } from '../../lib/invalidate';
import { QuestionCard } from './QuestionCard';

/**
 * p14-ask-user: the assistant's question card in the Sohbet thread. Answering sends the structured answer, which starts
 * the next turn of the conversation; while the asking turn still runs the card keeps the choices and waits.
 *
 * p17-chat-flow: a job agent's question posted into the conversation that started the job (`source: 'job'`) is the
 * same card, answered through the job's own route (`jobs.message`, as on the job page) — it does not start a turn and
 * never waits for one; the job page and this card read the same question.
 */
export function ChatQuestion(props: {
  readonly set: QuestionSet;
  readonly threadId: string;
  readonly turnOpen: boolean;
  readonly disabled?: boolean | undefined;
  readonly onAnswered: () => void;
}): ReactNode {
  const w = useT().chatFlow.question;
  const tp = useT().plan.decisions;
  const jobId = props.set.source === 'job' ? props.set.jobId : null;
  if (jobId !== null)
    return (
      <div className="flex min-w-0 flex-col gap-1" data-row="question" data-source="job">
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-dy-muted">
          {w.fromJob}
          <Link
            to={`/jobs/${encodeURIComponent(jobId)}`}
            className="font-bold text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
            data-testid="chat-job-question-open"
          >
            {w.openJob}
          </Link>
        </p>
        <QuestionCard
          set={props.set}
          from="job"
          canAnswer={props.disabled !== true}
          onAnswer={async (answers) => {
            await answerJobQuestion(jobId, props.set.id, answers);
            invalidate('questions');
            props.onAnswered();
          }}
        />
      </div>
    );
  // p18-plan-mode: a plan decision is recorded on its plan (no turn starts, none is waited for); the panel shows it too.
  const decision = typeof props.set.planId === 'string';
  return (
    <div className="flex min-w-0 flex-col" data-row="question" data-plan-decision={decision ? '' : undefined}>
      <QuestionCard
        set={props.set}
        from="assistant"
        canAnswer={props.disabled !== true && props.threadId !== ''}
        waiting={decision ? false : props.turnOpen}
        {...(decision ? { heading: tp.heading } : {})}
        onAnswer={async (answers) => {
          await answerChatQuestion(props.threadId, props.set.id, answers);
          props.onAnswered();
        }}
      />
    </div>
  );
}
