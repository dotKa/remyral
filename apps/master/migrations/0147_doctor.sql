-- p16-doctor (docs/design/p16-doctor.md, ADR-0062): diagnostics on the master and the machines, the redacted support
-- report and sending it to the vendor by e-mail.
--
--  * doctor_runs: one row per doctor run (manual from Ayarlar → Tanılama, the daily light run, the assistant): the
--    findings (redacted, closed codes and English text), the machines' doctor results, a summary.
--  * doctor_problems: the problems the daily run has seen (one row per finding identity), so it notifies only new or
--    returning ones; a problem not seen by a later daily run is marked resolved.
--  * support_settings: the support address (owner-editable; default the vendor's) and an optional owner-configured
--    SMTP server for the support mail (the password sealed with an HKDF sub-key of the master key, never in clear).
--    Without it the master's notification SMTP (NOTIFY_SMTP_*) sends the mail.
--  * support_reports: every built report bundle (sections, files with sizes and hashes, the zip itself for 24 hours)
--    and whether / to whom it was sent.
--  * workers.clock_skew_ms: master time minus the worker's heartbeat timestamp (network latency included).
--  * notification kind 'doctor.problem'; chat draft kind 'support_report'; worker op kind 'doctor.run'.
--
-- Rollback: an older master ignores all of it. To remove:
--   DELETE FROM notifications WHERE kind = 'doctor.problem';
--   DELETE FROM notification_preferences WHERE kind = 'doctor.problem';
--   DELETE FROM chat_drafts WHERE kind = 'support_report';
--   DELETE FROM worker_ops WHERE kind = 'doctor.run';
--   DROP TABLE support_reports, support_settings, doctor_problems, doctor_runs;
--   ALTER TABLE workers DROP COLUMN clock_skew_ms, DROP COLUMN clock_skew_at;
-- Migration number 0147 (0146_git_providers is on main; renumber at merge if a parallel change takes it).

CREATE TABLE doctor_runs (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('manual', 'daily', 'chat')),
  -- 'full' (every check) or 'light' (the daily subset: no outside calls).
  scope         text NOT NULL CHECK (scope IN ('full', 'light')),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NULL,
  requested_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  findings      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  -- [{ workerId, name, state: done | pending | failed | unsupported, report?, reason? }]
  workers       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(workers) = 'array'),
  -- Problems the daily run had not seen before (notified).
  new_problems  integer NOT NULL DEFAULT 0 CHECK (new_problems >= 0)
);
CREATE INDEX doctor_runs_recent ON doctor_runs (started_at DESC);
CREATE INDEX doctor_runs_kind ON doctor_runs (kind, started_at DESC);

CREATE TABLE doctor_problems (
  key            text PRIMARY KEY CHECK (char_length(key) BETWEEN 3 AND 300),
  check_id       text NOT NULL CHECK (char_length(check_id) BETWEEN 1 AND 160),
  code           text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  subject        text NULL CHECK (subject IS NULL OR char_length(subject) <= 120),
  severity       text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  notified_at    timestamptz NULL,
  resolved_at    timestamptz NULL
);
CREATE INDEX doctor_problems_open ON doctor_problems (check_id) WHERE resolved_at IS NULL;

CREATE TABLE support_settings (
  id                    integer PRIMARY KEY CHECK (id = 1),
  email                 text NOT NULL CHECK (length(email) <= 254 AND email ~ '^[^@\s<>",;]+@[^@\s<>",;]+$'),
  smtp_host             text NULL CHECK (smtp_host IS NULL OR char_length(smtp_host) BETWEEN 1 AND 255),
  smtp_port             integer NULL CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  smtp_security         text NULL CHECK (smtp_security IS NULL OR smtp_security IN ('starttls', 'tls')),
  smtp_from             text NULL CHECK (smtp_from IS NULL OR (length(smtp_from) <= 254
                                          AND smtp_from ~ '^[^@\s<>",;]+@[^@\s<>",;]+$')),
  smtp_username         text NULL CHECK (smtp_username IS NULL OR char_length(smtp_username) BETWEEN 1 AND 255),
  smtp_password_sealed  bytea NULL,
  updated_at            timestamptz NULL,
  updated_by            uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  CHECK ((smtp_host IS NULL) = (smtp_port IS NULL) AND (smtp_host IS NULL) = (smtp_security IS NULL)
         AND (smtp_host IS NULL) = (smtp_from IS NULL)),
  CHECK (smtp_password_sealed IS NULL OR smtp_username IS NOT NULL)
);
INSERT INTO support_settings (id, email) VALUES (1, 'yasin@remana.tech');

CREATE TABLE support_reports (
  id            uuid PRIMARY KEY,
  created_at    timestamptz NOT NULL,
  created_by    uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  source        text NOT NULL CHECK (source IN ('console', 'chat')),
  sections      text[] NOT NULL CHECK (cardinality(sections) BETWEEN 1 AND 8),
  log_hours     integer NOT NULL CHECK (log_hours BETWEEN 1 AND 72),
  description   text NULL CHECK (description IS NULL OR char_length(description) <= 4000),
  -- [{ path, section, bytes, sha256, items? }]
  files         jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The zip itself, kept for downloads and the send for `expires_at`; cleared afterwards (the facts stay).
  bundle        bytea NULL,
  expires_at    timestamptz NOT NULL,
  sent_at       timestamptz NULL,
  sent_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  sent_to       text NULL CHECK (sent_to IS NULL OR char_length(sent_to) <= 254),
  sent_cc       text NULL CHECK (sent_cc IS NULL OR char_length(sent_cc) <= 254),
  -- Whether the zip was attached (false: larger than the cap — the mail carried the summary only).
  attached      boolean NULL
);
ALTER TABLE support_reports ALTER COLUMN bundle SET STORAGE EXTERNAL;
CREATE INDEX support_reports_recent ON support_reports (created_at DESC);
CREATE INDEX support_reports_expiring ON support_reports (expires_at) WHERE bundle IS NOT NULL;

ALTER TABLE workers
  ADD COLUMN clock_skew_ms integer NULL,
  ADD COLUMN clock_skew_at timestamptz NULL;

-- Widening a closed CHECK list keeps every value an earlier migration allowed.
CREATE FUNCTION pg_temp.widen_check_0147(t text, c text, col text, extra text[]) RETURNS void
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

SELECT pg_temp.widen_check_0147('notifications', 'notifications_kind_check', 'kind', ARRAY['doctor.problem']);
SELECT pg_temp.widen_check_0147('notification_preferences', 'notification_preferences_kind_check', 'kind',
                                ARRAY['doctor.problem']);
SELECT pg_temp.widen_check_0147('chat_drafts', 'chat_drafts_kind_check', 'kind', ARRAY['support_report']);
SELECT pg_temp.widen_check_0147('worker_ops', 'worker_ops_kind_check', 'kind', ARRAY['doctor.run']);
