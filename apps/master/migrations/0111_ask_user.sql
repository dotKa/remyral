-- p14-ask-user (docs/design/p14-ask-user.md): structured questions to a person — from the Sohbet assistant (`ask_user`
-- assistant tool) and from a running job's agent (`ask_user` / `wait_for_answer` in-job tools). Additive only: older
-- code ignores the table and the new notification kind (rollback: leave them unused).
-- Migration number 0111 (given in the brief); renumber at merge if a parallel change took it.
--
--  * user_questions                one question set (1–4 questions, schema v1) with its state and the answer
--  * notifications / preferences   + job.question (the job's creator: an agent asks a question)

CREATE TABLE user_questions (
  id            uuid PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('job', 'assistant')),
  -- source = job: the job, the attempt that asked and the worker's request id (asking is idempotent per job + request).
  job_id        uuid NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_id    uuid NULL,
  request_id    uuid NULL,
  -- source = assistant: the conversation, the turn that asked and the conversation's owner (the only one who answers).
  thread_id     uuid NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  turn_id       uuid NULL,
  user_id       uuid NULL REFERENCES users (id) ON DELETE CASCADE,
  project       text NULL,
  title         text NULL CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  -- {v: 1, questions: [...]} validated by @remana/protocol UserQuestions; bounded here as a backstop.
  questions     jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'object' AND octet_length(questions::text) <= 32768),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'answered', 'expired', 'cancelled')),
  created_at    timestamptz NOT NULL,
  deadline_at   timestamptz NULL,
  closed_at     timestamptz NULL,
  close_reason  text NULL CHECK (close_reason IS NULL OR close_reason ~ '^[a-z_]{1,64}$'),
  answers       jsonb NULL CHECK (answers IS NULL OR (jsonb_typeof(answers) = 'array'
                                                     AND octet_length(answers::text) <= 16384)),
  answered_by   uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  answered_at   timestamptz NULL,
  CHECK ((source = 'job') = (job_id IS NOT NULL AND attempt_id IS NOT NULL AND request_id IS NOT NULL)),
  CHECK ((source = 'assistant') = (thread_id IS NOT NULL AND user_id IS NOT NULL)),
  CHECK ((state = 'answered') = (answers IS NOT NULL AND answered_at IS NOT NULL)),
  CHECK ((state = 'pending') = (closed_at IS NULL))
);

CREATE UNIQUE INDEX user_questions_job_request_idx ON user_questions (job_id, request_id) WHERE job_id IS NOT NULL;
CREATE INDEX user_questions_job_idx ON user_questions (job_id, created_at) WHERE job_id IS NOT NULL;
CREATE INDEX user_questions_thread_idx ON user_questions (thread_id, created_at) WHERE thread_id IS NOT NULL;
CREATE INDEX user_questions_pending_idx ON user_questions (created_at) WHERE state = 'pending';

CREATE OR REPLACE FUNCTION pg_temp.widen_check(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
  -- Either `col = ANY ('{a,b}'::text[])` (written by an earlier widening) or `col IN ('a', 'b')`.
  IF def ~ '\{' THEN
    vals := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO vals FROM regexp_matches(def, '''([A-Za-z0-9_.:-]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(vals, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the values of %', c;
  END IF;
  vals := vals || extra;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM unnest(vals) AS v;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))', t, c, col, vals);
END
$$;

SELECT pg_temp.widen_check('notifications', 'notifications_kind_check', 'kind', ARRAY['job.question']);
SELECT pg_temp.widen_check('notification_preferences', 'notification_preferences_kind_check', 'kind',
                           ARRAY['job.question']);
