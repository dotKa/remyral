-- p12-deploy-feedback (docs/design/p12-deploy-feedback.md, ADR-0048): what happened to a deploy reaches the people and
-- the agents who can fix it. Per-project opt-in "auto-fix" (default off) and the chain of fix jobs created for failed
-- deploys / publishes / post-deploy health checks (manual "start a fix job" drafts are recorded too). Additive only:
-- older code ignores the new tables and the new notification kind.

CREATE TABLE project_deploy_autofix (
  project       text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,
  -- Fix jobs created automatically per source job (the whole chain: a fix of a fix counts against the same root).
  max_attempts  smallint NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 3),
  -- Runtime of the fix job (null: the source job's runtime, else the project's default).
  runtime       text NULL CHECK (runtime IS NULL OR runtime ~ '^[a-z][a-z0-9-]{0,31}$'),
  updated_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL
);

CREATE TABLE deploy_fixes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project          text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  mode             text NOT NULL CHECK (mode IN ('auto', 'manual')),
  -- What failed: a deploy / publish ops action, or the health check after one.
  failure          text NOT NULL CHECK (failure IN ('deploy', 'publish', 'health')),
  ops_action_id    uuid NULL REFERENCES ops_actions (id) ON DELETE SET NULL,
  health_check_id  uuid NULL REFERENCES deploy_health_checks (id) ON DELETE SET NULL,
  -- The job whose result was deployed (null: a deploy not made from a job) and the first job of the chain.
  source_job_id    uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  root_job_id      uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  attempt          smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  state            text NOT NULL CHECK (state IN ('created', 'skipped')),
  reason           text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  fix_job_id       uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  created_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL
);
-- One automatic decision per failed action / failed check (at-least-once ticks stay idempotent).
CREATE UNIQUE INDEX deploy_fixes_auto_action ON deploy_fixes (ops_action_id) WHERE mode = 'auto' AND health_check_id IS NULL;
CREATE UNIQUE INDEX deploy_fixes_auto_health ON deploy_fixes (health_check_id) WHERE mode = 'auto';
CREATE INDEX deploy_fixes_root ON deploy_fixes (root_job_id);
CREATE INDEX deploy_fixes_fix_job ON deploy_fixes (fix_job_id);
CREATE INDEX deploy_fixes_source_job ON deploy_fixes (source_job_id);

-- Notification kind 'deploy.fix_started': appended to whatever the constraints allow now (see 0094).
DO $$
DECLARE
  t text;
  c text;
  def text;
  kinds text[];
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    c := t || '_kind_check';
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conname = c AND conrelid = t::regclass;
    IF def IS NULL THEN
      RAISE EXCEPTION 'constraint % not found', c;
    END IF;
    -- Either ARRAY['a'::text, …] (an IN list) or '{a,b,…}'::text[] (written by an earlier migration like this one,
    -- e.g. 0088 / 0092): both forms are read, and an empty result is refused instead of narrowing the constraint.
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['deploy.fix_started'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
