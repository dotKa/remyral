-- Open-source release (owner decision 2026-11-24): a FRESH install starts on the "Dengeli" security preset instead of
-- "Serbest". Serbest waives the authenticator code for everything outside the safe core (enabling machine
-- administration, removing the sandbox, approving machines, production deploys, credentials, integrations …) and,
-- with "remember this device", one code at sign-in covers the whole session; that is the owner's own trade-off for a
-- closed system, not a default for strangers. Applied migrations are never edited (0118 seeded Serbest, 0126 added
-- auto mode), so the stored policy is replaced here — on a FRESH install only:
--   * no user account exists yet (nobody could have chosen anything), and
--   * the policy was never saved by a person: every stored version was written by a migration and the row has no
--     `updated_by`, and
--   * it is still the Serbest preset the migrations seeded.
-- An existing installation (one with users, or whose owner ever saved the policy) keeps its document and version
-- exactly as they are, Serbest included. The new version is written `via = 'migration'` with `audited_at` NULL: the
-- master audits it on start-up like 0126 (security.policy.update, actor system).
-- To choose Serbest on a fresh install: Ayarlar → Güvenlik (or the setup wizard's security step) → Serbest.
DO $$
DECLARE
  v integer;
BEGIN
  SELECT version INTO v FROM security_policy
   WHERE id = 1
     AND updated_by IS NULL
     AND document ->> 'preset' = 'serbest'
     AND NOT EXISTS (SELECT 1 FROM users)
     AND NOT EXISTS (
       SELECT 1 FROM security_policy_versions WHERE via <> 'migration' OR created_by IS NOT NULL)
   FOR UPDATE;
  IF v IS NULL THEN
    RETURN;
  END IF;
  UPDATE security_policy SET document = '{"preset":"dengeli"}', version = v + 1, updated_by = NULL, updated_at = now()
   WHERE id = 1;
  INSERT INTO security_policy_versions (version, document, created_by, created_at, via, reason, audited_at)
    VALUES (v + 1, '{"preset":"dengeli"}', NULL, now(), 'migration',
            'oss-sec3: a fresh install starts on Dengeli (owner decision 2026-11-24); existing installs unchanged',
            NULL);
END;
$$;
