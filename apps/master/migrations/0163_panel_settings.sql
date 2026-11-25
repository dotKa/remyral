-- p17-panel-settings (docs/design/p17-panel-settings.md §3): settings that used to exist only as environment variables,
-- stored by the master and edited in the panel (owners). The environment variable stays the default; a row here wins
-- while it exists. Secret values are sealed (AES-256-GCM under the HKDF sub-key `panel-settings`, AAD
-- `panel-setting:<key>`) and never returned; `value` is NULL for them.
--
-- Versioned like the security policy: every save bumps `panel_settings_state.version` and appends one history row with
-- the changed keys (non-secret values before / after; for a secret only "set" / "generated" / "cleared").
--
-- Additive. Rollback: an older master ignores the tables (the environment applies again). To remove:
--   DROP TABLE panel_settings_history, panel_settings, panel_settings_state;
CREATE TABLE panel_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][A-Za-z0-9.]{2,63}$'),
  value       jsonb NULL,
  sealed      bytea NULL,
  CHECK ((value IS NULL) <> (sealed IS NULL)),
  updated_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE panel_settings_state (
  id       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version  integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO panel_settings_state (id, version) VALUES (1, 0);

CREATE TABLE panel_settings_history (
  version     integer PRIMARY KEY CHECK (version > 0),
  section     text NOT NULL CHECK (section ~ '^[a-z]{2,32}$'),
  -- { "<key>": { "from": <value|null>, "to": <value|null> } } — secrets: { "secret": "set|generated|cleared" }.
  changes     jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
  changed_at  timestamptz NOT NULL,
  changed_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL
);
