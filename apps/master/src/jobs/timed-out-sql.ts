/**
 * p20-job-clock (docs/design/p20-job-clock.md). SQL: the job (alias `j`) ended on its time limit — the worker's run
 * clock ran out (`max_duration_exceeded` in the current attempt's result) or the master's wall-time backstop stopped it
 * (`budget_exceeded: wall time …` on a transition of the current attempt). A fixed alias only (never user input).
 */
export function TIMED_OUT_SQL(j = 'j'): string {
  if (!/^[a-z]{1,8}$/.test(j)) throw new Error('invalid alias');
  return `((${j}.state = 'FAILED' AND (SELECT r.result -> 'error' ->> 'code' FROM job_runs r
                                       WHERE r.attempt_id = ${j}.current_attempt_id) = 'max_duration_exceeded')
       OR (${j}.state IN ('CANCELLED', 'FAILED') AND EXISTS (
             SELECT 1 FROM job_transitions x
              WHERE x.job_id = ${j}.id AND x.attempt_id IS NOT DISTINCT FROM ${j}.current_attempt_id
                AND x.reason LIKE 'budget_exceeded: wall time%')))`;
}
