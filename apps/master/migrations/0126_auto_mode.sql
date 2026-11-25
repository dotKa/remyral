-- p15-auto-mode (docs/design/p15-auto-mode.md, owner 2026-10-22: "Claude CLI'daki auto mode gibi davranabilmeli
-- sistem. Sürekli onay, sürekli başarısızlıkları çözmesi için yeniden deneme için onaylar manasız."):
--  * security policy: `autonomy.autoMode = true` on the stored policy and the three explicit `autoApprove = false`
--    overrides of deploy, tool.mcp and runtime.dangerous_tool removed (owner decision 2026-10-22). The change is a new
--    policy version (`via = 'migration'`); the master writes its audit entry (`security.policy.update`, actor system)
--    on start-up — the audit log is a hash chain the database cannot extend (`security_policy_versions.audited_at`).
--  * job_auto_events: what the platform did by itself for a job (auto-approved by "Otomatik mod", automatic retry,
--    base ref healed, verification rebased, auto-fix job) — the job page timeline and the failure digest.
--  * job_auto_retries: one row per automatic retry of a transient failure (cause, machine, when it may run again).
--  * job_base_ref_changes: a queued job's base ref healed by the master (the spec stays immutable; the latest seq
--    wins, like job_time_limit_changes).
--  * job_auto_fixes: at most one auto-fix job per failed job.
--  * job_git.auto_rebase: the platform rebased the attempt onto the base at job start (diverged verification).
--  * notification kind 'job.auto_fix'.
-- Rollback: the tables are additive. An older master parses the policy strictly and would fall back to "Sıkı" on the
-- unknown `autoMode` key — before rolling the master back run
--   UPDATE security_policy SET document = document #- '{autonomy,autoMode}' #- '{autonomy,autoRetryMax}',
--          version = version + 1, updated_at = now() WHERE id = 1;

ALTER TABLE security_policy_versions ADD COLUMN audited_at timestamptz NULL;
UPDATE security_policy_versions SET audited_at = created_at;

DO $$
DECLARE
  doc jsonb;
  before jsonb;
  v integer;
  auto jsonb;
  k text;
BEGIN
  SELECT document, version INTO doc, v FROM security_policy WHERE id = 1 FOR UPDATE;
  IF doc IS NULL THEN
    -- No stored policy: the default document (Serbest) has auto mode on.
    RETURN;
  END IF;
  before := doc;
  auto := doc #> '{autonomy,autoApprove}';
  IF auto IS NOT NULL AND jsonb_typeof(auto) = 'object' THEN
    FOREACH k IN ARRAY ARRAY['deploy', 'tool.mcp', 'runtime.dangerous_tool'] LOOP
      IF auto -> k = 'false'::jsonb THEN
        auto := auto - k;
      END IF;
    END LOOP;
    IF auto = '{}'::jsonb THEN
      doc := jsonb_set(doc, '{autonomy}', (doc -> 'autonomy') - 'autoApprove');
    ELSE
      doc := jsonb_set(doc, '{autonomy,autoApprove}', auto);
    END IF;
  END IF;
  doc := jsonb_set(doc, '{autonomy}', coalesce(doc -> 'autonomy', '{}'::jsonb) || '{"autoMode": true}'::jsonb);
  IF doc = before THEN
    RETURN;
  END IF;
  UPDATE security_policy SET document = doc, version = v + 1, updated_by = NULL, updated_at = now() WHERE id = 1;
  INSERT INTO security_policy_versions (version, document, created_by, created_at, via, reason, audited_at)
    VALUES (v + 1, doc, NULL, now(), 'migration',
            'p15-auto-mode: Otomatik mod on; explicit autoApprove=false of deploy, tool.mcp and runtime.dangerous_tool removed (owner decision 2026-10-22)',
            NULL);
END;
$$;

CREATE TABLE job_auto_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('auto_approved', 'auto_retry', 'base_ref', 'auto_rebase', 'auto_fix',
                                            'retry_exhausted')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at  timestamptz NOT NULL
);
CREATE INDEX job_auto_events_job ON job_auto_events (job_id, id);
CREATE INDEX job_auto_events_time ON job_auto_events (created_at);

CREATE TABLE job_auto_retries (
  job_id            uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  number            integer NOT NULL CHECK (number BETWEEN 1 AND 5),
  attempt_id        uuid NOT NULL,
  worker_id         text NULL CHECK (worker_id IS NULL OR length(worker_id) <= 128),
  cause             text NOT NULL CHECK (length(cause) <= 64),
  machine_specific  boolean NOT NULL,
  max_attempts      integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  retry_at          timestamptz NOT NULL,
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (job_id, number),
  UNIQUE (attempt_id)
);
CREATE INDEX job_auto_retries_due ON job_auto_retries (job_id, retry_at);

CREATE TABLE job_base_ref_changes (
  job_id      uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  seq         integer NOT NULL CHECK (seq >= 1),
  base_ref    text NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  previous    text NOT NULL CHECK (length(previous) <= 255),
  reason      text NOT NULL CHECK (reason IN ('previous_job_head', 'previous_job_target', 'project_base',
                                                'repository_default')),
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE job_auto_fixes (
  source_job_id  uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  fix_job_id     uuid NULL REFERENCES jobs (id) ON DELETE SET NULL,
  state          text NOT NULL CHECK (state IN ('created', 'skipped', 'succeeded', 'failed', 'cancelled')),
  reason         text NULL CHECK (reason IS NULL OR length(reason) <= 500),
  created_at     timestamptz NOT NULL,
  finished_at    timestamptz NULL,
  notified_at    timestamptz NULL
);
CREATE INDEX job_auto_fixes_fix ON job_auto_fixes (fix_job_id) WHERE fix_job_id IS NOT NULL;

ALTER TABLE job_git ADD COLUMN auto_rebase jsonb NULL CHECK (auto_rebase IS NULL OR jsonb_typeof(auto_rebase) = 'object');

-- Notification kind 'job.auto_fix': appended to whatever the constraints allow now (see 0095).
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
    IF def ~ '\{' THEN
      kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
    ELSE
      SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_.]+)''', 'g') AS m;
    END IF;
    IF coalesce(array_length(kinds, 1), 0) < 2 THEN
      RAISE EXCEPTION 'could not read the kinds of %', c;
    END IF;
    kinds := kinds || ARRAY['job.auto_fix'];
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))', t, c, kinds);
  END LOOP;
END;
$$;
