-- p15-model-picker (docs/design/p15-model-picker.md): choose models from a list instead of typing them. Additive only.
--
-- 1. workers.runtime_models: CAPABILITIES.runtimeModels (worker feature runtime-models-v1) — per runtime the models
--    the machine's runtime CLI lists (or the aliases the worker release knows), model ids only. NULL: older worker or
--    not reported yet (the console falls back to the built-in catalog).
-- 2. model_defaults.model: a default may now be a model id (from the catalog or a custom id) instead of a model
--    profile; exactly one of profile_id / model is set. A project default applies like before (the job's model); the
--    global one is a soft default the machine's own default model wins over (JobSpec.defaultModel).
-- 3. chat_settings.model / fallback_model: the assistant engine's model as a model id (instead of a profile); at most
--    one of model_profile / model (and of fallback_model_profile / fallback_model) is set.
--
-- Rollback: the old master reads profile_id only — first remove the rows it cannot read, then drop the columns:
--   DELETE FROM model_defaults WHERE profile_id IS NULL;
--   UPDATE chat_settings SET model = NULL, fallback_model = NULL;
--   ALTER TABLE model_defaults DROP COLUMN model, ALTER COLUMN profile_id SET NOT NULL;
-- Migration number 0137 (given in the brief; 0136 is reserved for the parallel chat-failover work).

ALTER TABLE workers
  ADD COLUMN runtime_models jsonb NULL,
  ADD COLUMN runtime_models_at timestamptz NULL;

ALTER TABLE model_defaults
  ALTER COLUMN profile_id DROP NOT NULL,
  ADD COLUMN model text NULL
    CHECK (model IS NULL OR (char_length(model) <= 128 AND model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$')),
  ADD CONSTRAINT model_defaults_one_choice CHECK ((profile_id IS NULL) <> (model IS NULL));

ALTER TABLE chat_settings
  ADD COLUMN model text NULL
    CHECK (model IS NULL OR (char_length(model) <= 128 AND model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$')),
  ADD COLUMN fallback_model text NULL
    CHECK (fallback_model IS NULL OR (char_length(fallback_model) <= 128
           AND fallback_model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$')),
  ADD CONSTRAINT chat_settings_one_model CHECK (model_profile IS NULL OR model IS NULL),
  ADD CONSTRAINT chat_settings_one_fallback_model CHECK (fallback_model_profile IS NULL OR fallback_model IS NULL);
