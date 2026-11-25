-- p20-job-clock (docs/design/p20-job-clock.md; owner 2026-10-31: "öngördüğü süreye göre işi ayarlayabilmeli, süre
-- yetmeyecek gibi ilerliyorsa süreyi uzatmalı"): the run clock a worker reports for a running attempt (HEARTBEAT
-- `runningJobs[].clock`), the time warning sent once per time limit, and the new notification kind.
-- Additive only: older code ignores the columns and the kind.
--
--  * job_attempts.run_clock          the last clock report (budget, run time, approval / question waits, idle)
--  * job_attempts.run_clock_at       when it arrived
--  * job_attempts.time_warned_at     when the "time is running out" warning went out for this attempt
--  * job_attempts.time_warned_limit  the time limit (s) it was sent for (an extension re-arms the warning)
--  * notifications / preferences     + job.time_warning (the job's creator: its time limit is nearly used up)
--
-- Rollback: ALTER TABLE job_attempts DROP COLUMN run_clock, DROP COLUMN run_clock_at, DROP COLUMN time_warned_at,
-- DROP COLUMN time_warned_limit; (the kind may stay in the CHECK constraints unused).

ALTER TABLE job_attempts
  ADD COLUMN run_clock jsonb NULL CHECK (run_clock IS NULL OR (jsonb_typeof(run_clock) = 'object'
                                                              AND octet_length(run_clock::text) <= 1024)),
  ADD COLUMN run_clock_at timestamptz NULL,
  ADD COLUMN time_warned_at timestamptz NULL,
  ADD COLUMN time_warned_limit integer NULL CHECK (time_warned_limit IS NULL OR time_warned_limit >= 0);

CREATE FUNCTION pg_temp.widen_check_0203(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0203('notifications', 'notifications_kind_check', 'kind', ARRAY['job.time_warning']);
SELECT pg_temp.widen_check_0203('notification_preferences', 'notification_preferences_kind_check', 'kind',
                                ARRAY['job.time_warning']);
