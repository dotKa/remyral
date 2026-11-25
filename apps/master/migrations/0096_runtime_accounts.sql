-- p13-runtime-accounts (docs/design/p13-runtime-accounts.md, ADR-0049): several Claude Code / Codex accounts per machine
-- (subscription logins in their own config dirs on the worker, or API keys from the vault), chosen by a per-project
-- strategy, switched automatically at a usage limit and by hand. The master keeps labels, kinds, opaque ids, vault
-- credential ids and login states only — never a token, an email or an account identity. Additive: older code ignores
-- the new tables and columns (rows of added accounts in the usage tables then show as extra rows of the runtime).
-- Number 0096: 0095 is taken by p12-deploy-feedback in the same release.

-- The accounts the panel added to a machine's runtime, plus the configured one (`default`) once a person changed it
-- (rename, pause, order); until then `default` is synthesised from the worker's applied runtime auth (no data move, no
-- re-login). `login_*` is the last state the worker reported (the runtime's own status command, ADR-0014 rule 4).
CREATE TABLE runtime_accounts (
  worker_id       text NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  runtime         text NOT NULL CHECK (runtime IN ('claude-code', 'codex')),
  account_id      text NOT NULL CHECK (account_id ~ '^[a-z0-9]{1,12}$'),
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 64 AND label !~ '[[:cntrl:]]'),
  kind            text NOT NULL CHECK (kind IN ('subscription', 'api_key')),
  -- api_key accounts: the vault credential (ADR-0016; never a value). NULL for subscriptions and for `default`.
  credential_id   text NULL CHECK (credential_id IS NULL OR credential_id ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  position        smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 99),
  is_default      boolean NOT NULL DEFAULT false,
  paused          boolean NOT NULL DEFAULT false,
  paused_reason   text NULL CHECK (paused_reason IS NULL OR (length(paused_reason) <= 200 AND paused_reason !~ '[[:cntrl:]]')),
  paused_by       uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  paused_at       timestamptz NULL,
  login_status    text NULL CHECK (login_status IS NULL OR login_status IN ('logged_in', 'logged_out', 'expired', 'unknown', 'unsupported')),
  login_reason    text NULL CHECK (login_reason IS NULL OR login_reason ~ '^[a-z0-9_]{1,64}$'),
  login_checked_at timestamptz NULL,
  created_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL,
  updated_by      uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (worker_id, runtime, account_id),
  CHECK (kind <> 'api_key' OR account_id = 'default' OR credential_id IS NOT NULL),
  CHECK (kind <> 'subscription' OR credential_id IS NULL)
);
-- One default account per machine runtime.
CREATE UNIQUE INDEX runtime_accounts_default_idx ON runtime_accounts (worker_id, runtime) WHERE is_default;

-- CAPABILITIES.runtimeAccounts as last reported (kinds, stores, login states, lendable): placement facts.
ALTER TABLE workers ADD COLUMN runtime_accounts jsonb NULL
  CHECK (runtime_accounts IS NULL OR jsonb_typeof(runtime_accounts) = 'array');

-- Account selection: workspace default (singleton) and per project (NULL = inherit). Validated by the master
-- (AccountPolicy) before it is written. The paid switch is the usage-limit policy's allowPaidFallback (ADR-0040).
CREATE TABLE runtime_account_defaults (
  id          smallint PRIMARY KEY CHECK (id = 1),
  policy      jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL
);
INSERT INTO runtime_account_defaults (id, policy, updated_at)
VALUES (1, '{"strategy":"balanced","order":[],"skipPercent":90}', now());

ALTER TABLE projects
  ADD COLUMN account_policy jsonb NULL CHECK (account_policy IS NULL OR jsonb_typeof(account_policy) = 'object'),
  ADD COLUMN account_policy_updated_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN account_policy_updated_at timestamptz NULL;

-- A person's pin of a job to one account ("Hesabı değiştir" on a waiting job, or the chat card): {workerId, runtime,
-- account, by, at}. The dispatcher uses only that account until the job ends.
ALTER TABLE jobs ADD COLUMN account_pin jsonb NULL CHECK (account_pin IS NULL OR jsonb_typeof(account_pin) = 'object');

-- Usage readings per account (runtime × auth × account). Existing rows are the configured account (`default`).
ALTER TABLE runtime_usage_history DROP CONSTRAINT runtime_usage_history_worker_id_runtime_auth_fkey;
ALTER TABLE runtime_usage_snapshots ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9]{1,12}$');
ALTER TABLE runtime_usage_history ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9]{1,12}$');
ALTER TABLE runtime_usage_snapshots DROP CONSTRAINT runtime_usage_snapshots_pkey;
ALTER TABLE runtime_usage_snapshots ADD PRIMARY KEY (worker_id, runtime, auth, account);
ALTER TABLE runtime_usage_history DROP CONSTRAINT runtime_usage_history_pkey;
ALTER TABLE runtime_usage_history ADD PRIMARY KEY (worker_id, runtime, auth, account, window_id, at);
ALTER TABLE runtime_usage_history ADD CONSTRAINT runtime_usage_history_snapshot_fkey
  FOREIGN KEY (worker_id, runtime, auth, account)
  REFERENCES runtime_usage_snapshots (worker_id, runtime, auth, account) ON DELETE CASCADE;

-- A usage limit of one account (scope key worker:<w>:<rt>@<account>[:<model>]): the account is limited until its reset,
-- the machine's other accounts are not (no runtime-wide provider pause for attempts that ran with an account).
ALTER TABLE usage_limit_episodes ADD COLUMN runtime_account text NULL
  CHECK (runtime_account IS NULL OR runtime_account ~ '^[a-z0-9]{1,12}$');
CREATE INDEX usage_limit_episodes_account_idx ON usage_limit_episodes (worker_id, runtime, runtime_account)
  WHERE ended_at IS NULL;

-- A manual account switch parks a running attempt (PAUSE_JOB cause account_switch) and resumes it with the chosen
-- account: the pause episode says which one.
ALTER TABLE job_pauses DROP CONSTRAINT job_pauses_cause_check;
ALTER TABLE job_pauses
  ADD CONSTRAINT job_pauses_cause_check CHECK (cause IN ('approval', 'usage_limit', 'worker_restart', 'account_switch')),
  ADD COLUMN account_switch jsonb NULL CHECK (account_switch IS NULL OR jsonb_typeof(account_switch) = 'object'),
  ADD CONSTRAINT job_pauses_account_switch_facts CHECK (cause <> 'account_switch' OR account_switch IS NOT NULL);

-- Chat: the account of the assistant engine and a fallback account (same runtime, same machine; NULL = default), and
-- engine limits per account.
ALTER TABLE chat_settings
  ADD COLUMN account text NULL CHECK (account IS NULL OR account ~ '^[a-z0-9]{1,12}$'),
  ADD COLUMN fallback_account text NULL CHECK (fallback_account IS NULL OR fallback_account ~ '^[a-z0-9]{1,12}$'),
  ADD CONSTRAINT chat_settings_fallback_account_distinct
    CHECK (fallback_account IS NULL OR fallback_account <> COALESCE(account, 'default'));
ALTER TABLE chat_engine_limits ADD COLUMN account text NOT NULL DEFAULT 'default'
  CHECK (account ~ '^[a-z0-9]{1,12}$');
ALTER TABLE chat_engine_limits DROP CONSTRAINT chat_engine_limits_pkey;
ALTER TABLE chat_engine_limits ADD PRIMARY KEY (runtime, worker_id, account);

-- worker_config_versions.cause: + accounts (the added runtime accounts changed).
DO $$
DECLARE
  def text;
  causes text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'worker_config_versions_cause_check' AND conrelid = 'worker_config_versions'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint worker_config_versions_cause_check not found';
  END IF;
  IF def ~ '\{' THEN
    causes := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO causes FROM regexp_matches(def, '''([a-z0-9_]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(causes, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the causes of worker_config_versions_cause_check';
  END IF;
  causes := causes || ARRAY['accounts'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO causes FROM unnest(causes) AS k;
  ALTER TABLE worker_config_versions DROP CONSTRAINT worker_config_versions_cause_check;
  EXECUTE format('ALTER TABLE worker_config_versions ADD CONSTRAINT worker_config_versions_cause_check CHECK (cause = ANY (%L::text[]))', causes);
END;
$$;

-- Chat draft kind `account_action` (pause / resume an account, switch a job's account; the person confirms the card).
DO $$
DECLARE
  def text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'chat_drafts_kind_check' AND conrelid = 'chat_drafts'::regclass;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint chat_drafts_kind_check not found';
  END IF;
  IF def ~ '\{' THEN
    kinds := string_to_array(substring(def from '\{([^}]*)\}'), ',');
  ELSE
    SELECT array_agg(DISTINCT m[1]) INTO kinds FROM regexp_matches(def, '''([a-z0-9_]+)''', 'g') AS m;
  END IF;
  IF coalesce(array_length(kinds, 1), 0) < 2 THEN
    RAISE EXCEPTION 'could not read the kinds of chat_drafts_kind_check';
  END IF;
  kinds := kinds || ARRAY['account_action'];
  SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM unnest(kinds) AS k;
  ALTER TABLE chat_drafts DROP CONSTRAINT chat_drafts_kind_check;
  EXECUTE format('ALTER TABLE chat_drafts ADD CONSTRAINT chat_drafts_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END;
$$;
