import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { answerJobQuestion, listJobQuestions, type QuestionSet } from '../../api/questions';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { invalidate } from '../../lib/invalidate';
import type { JobCardProps } from '../job/types';
import { QuestionCard } from './QuestionCard';

/** How often an unfinished job's questions are re-read (a question arrives while the agent runs). */
export const JOB_QUESTIONS_POLL_MS = 5_000;

/**
 * p14-ask-user: the job page's "Senden bekleyen" card for the agent's questions — open ones first (answerable by
 * operators: the master checks `jobs.message`), the earlier ones folded underneath. Renders nothing when the agent
 * never asked.
 */
export function JobQuestionsCard(props: JobCardProps): ReactNode {
  const t = useT().questions.job;
  const sayError = useErrorText();
  const jobId = props.detail.job.id;
  const [sets, setSets] = useState<readonly QuestionSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      listJobQuestions(jobId, signal === undefined ? {} : { signal }).then(
        (s) => {
          setSets(s);
          setError(null);
        },
        (err: unknown) => {
          if (signal?.aborted !== true) setError(sayError(err));
        },
      ),
    [jobId, sayError],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    if (props.finished)
      return () => {
        ac.abort();
      };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(ac.signal);
    }, JOB_QUESTIONS_POLL_MS);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [load, props.finished]);

  if (error !== null && sets === null) {
    return (
      <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
        {`${t.loadError} ${error}`}
      </p>
    );
  }
  if (sets === null || sets.length === 0) return null;
  const open = sets.filter((s) => s.state === 'pending');
  const closed = sets.filter((s) => s.state !== 'pending');
  return (
    <section aria-label={t.title} data-testid="job-questions" className="grid min-w-0 gap-2">
      {open.length > 0 ? (
        <p className="m-0 text-[0.8125rem] font-bold text-dy-amber-ink" role="status">
          {t.pending({ n: open.length })}
        </p>
      ) : null}
      {open.map((s) => (
        <QuestionCard
          key={s.id}
          set={s}
          from="job"
          canAnswer={props.canAct}
          onAnswer={async (answers) => {
            const done = await answerJobQuestion(jobId, s.id, answers);
            setSets((prev) => (prev ?? []).map((x) => (x.id === done.id ? done : x)));
            invalidate('questions');
          }}
        />
      ))}
      {closed.length > 0 ? (
        <details className="rounded-[12px] border border-dy-line bg-dy-card px-3 py-2">
          <summary className="cursor-pointer text-[0.8125rem] font-medium text-dy-muted">
            {t.history({ n: closed.length })}
          </summary>
          <div className="mt-2 grid gap-2">
            {closed.map((s) => (
              <QuestionCard
                key={s.id}
                set={s}
                from="job"
                canAnswer={false}
                onAnswer={() => Promise.resolve()}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
