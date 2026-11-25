-- p15-autonomy (ADR-0056, docs/design/p15-autonomy.md): the owner-configurable security policy.
--  * security_policy: one row (id = 1) — a preset plus overrides (apps/master/src/security-policy/model.ts). The
--    master reads it for every step-up decision, the autonomy defaults of new projects / jobs, the master approvals
--    that pass by policy for "never ask" jobs and whether the assistant acts directly.
--  * security_policy_versions: every change (append-only history; the audit log holds the who / what as well).
--  * chat_drafts.kind: + settings_change (the assistant's change_settings card / direct action), + time_limit.
--  * job_time_limit_changes (owner request 2026-10-21 "süre sınırı karttan düzenlenebilmeli"): a job's time limit
--    changed after submission (the spec stays immutable; the latest seq wins, like job_approval_mode_changes); a
--    running attempt's worker is told with a signed SET_TIME_LIMIT.
--  * approval_requests.expiry_extended_at + the update guard: a pending request's expiry may be moved later by an
--    approver ("Karar süresini uzat"), only together with a newer expiry_extended_at; everything else stays as 0079.
--
-- Migration default (owner direction 2026-10-21): existing deployments end up on the "Serbest" preset with the safe
-- core on (security policy changes, 2FA reset, user / role changes, revealing secrets ask for a code). To return to
-- the behaviour before this migration, choose "Sıkı" in Ayarlar → Güvenlik (or ask the assistant: "güvenlik
-- politikasını sıkı yap"); from the shell:
--   UPDATE security_policy SET document = '{"preset":"siki"}', version = version + 1, updated_at = now() WHERE id = 1;

CREATE TABLE security_policy (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version     integer NOT NULL CHECK (version >= 0),
  document    jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND document ? 'preset'),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NULL
);

CREATE TABLE security_policy_versions (
  version     integer PRIMARY KEY CHECK (version >= 1),
  document    jsonb NOT NULL,
  created_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  via         text NOT NULL CHECK (via IN ('console', 'chat', 'migration')),
  reason      text NULL CHECK (reason IS NULL OR length(reason) <= 500)
);

INSERT INTO security_policy (id, version, document, updated_by, updated_at)
  VALUES (1, 1, '{"preset":"serbest"}', NULL, now());
INSERT INTO security_policy_versions (version, document, created_by, created_at, via, reason)
  VALUES (1, '{"preset":"serbest"}', NULL, now(), 'migration', 'p15-autonomy default (Serbest, safe core on)');

-- Chat draft kind `settings_change`, appended to whatever the constraint allows now.
CREATE FUNCTION pg_temp.widen_check_0118(t text, c text, col text, extra text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = c AND conrelid = t::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % not found', c;
  END IF;
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

SELECT pg_temp.widen_check_0118('chat_drafts', 'chat_drafts_kind_check', 'kind',
  ARRAY['settings_change', 'time_limit']);

CREATE TABLE job_time_limit_changes (
  id           uuid PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  seq          integer NOT NULL CHECK (seq >= 1),
  from_sec     integer NOT NULL CHECK (from_sec >= 1),
  to_sec       integer NOT NULL CHECK (to_sec BETWEEN 60 AND 604800),
  actor_id     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  job_state    text NOT NULL CHECK (length(job_state) <= 32),
  attempt_id   uuid NULL,
  epoch        integer NULL,
  worker_id    text NULL CHECK (worker_id IS NULL OR length(worker_id) <= 64),
  delivery     text NOT NULL CHECK (delivery IN ('not_running', 'sent', 'unsupported')),
  application  text NULL CHECK (application IS NULL OR application IN ('applied', 'refused')),
  remaining_sec integer NULL,
  application_detail text NULL CHECK (application_detail IS NULL OR length(application_detail) <= 2000),
  applied_at   timestamptz NULL,
  reason       text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  via          text NOT NULL DEFAULT 'console' CHECK (via IN ('console', 'chat')),
  created_at   timestamptz NOT NULL,
  UNIQUE (job_id, seq)
);

ALTER TABLE approval_requests ADD COLUMN expiry_extended_at timestamptz NULL;

CREATE OR REPLACE FUNCTION approval_requests_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  extending boolean := NEW.status = 'pending' AND NEW.expiry_extended_at IS NOT NULL
    AND NEW.expiry_extended_at IS DISTINCT FROM OLD.expiry_extended_at
    AND (OLD.expiry_extended_at IS NULL OR NEW.expiry_extended_at > OLD.expiry_extended_at)
    AND NEW.expires_at > OLD.expires_at;
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval request % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.attempt_id, NEW.epoch, NEW.approval_key, NEW.kind, NEW.action,
      NEW.requested_action, NEW.risk, NEW.summary, NEW.requested_by_type, NEW.requested_by_id, NEW.worker_id,
      NEW.policy_version, NEW.approver_role, NEW.required_approvals, NEW.step_up, NEW.created_at,
      NEW.pause_after_at, NEW.fingerprint)
     IS DISTINCT FROM
     (OLD.id, OLD.job_id, OLD.attempt_id, OLD.epoch, OLD.approval_key, OLD.kind, OLD.action,
      OLD.requested_action, OLD.risk, OLD.summary, OLD.requested_by_type, OLD.requested_by_id, OLD.worker_id,
      OLD.policy_version, OLD.approver_role, OLD.required_approvals, OLD.step_up, OLD.created_at,
      OLD.pause_after_at, OLD.fingerprint) THEN
    RAISE EXCEPTION 'approval request % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.expiry_extended_at IS DISTINCT FROM OLD.expiry_extended_at AND NOT extending THEN
    RAISE EXCEPTION 'approval request % expiry extension must move it later', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (OLD.stale_at IS NOT NULL AND NEW.stale_at IS DISTINCT FROM OLD.stale_at)
     OR (OLD.pause_requested_at IS NOT NULL AND NEW.pause_requested_at IS DISTINCT FROM OLD.pause_requested_at) THEN
    RAISE EXCEPTION 'approval request % pause markers are set once', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     AND NOT extending
     AND NOT (NEW.status = 'pending' AND OLD.pause_requested_at IS NULL AND NEW.pause_requested_at IS NOT NULL
              AND NEW.expires_at > OLD.expires_at) THEN
    RAISE EXCEPTION 'approval request % expiry is immutable (except when its job is paused or an approver extends it)',
      OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF NEW.status = 'pending' AND NOT extending
     AND (NEW.stale_at, NEW.pause_requested_at) IS NOT DISTINCT FROM (OLD.stale_at, OLD.pause_requested_at) THEN
    RAISE EXCEPTION 'approval request % update must decide it', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;
