-- p18-plan-autonomy (docs/design/p18-plan-mode.md, "Implementation (autonomy)"): an approved plan runs on its own.
-- Owner 2026-10-28: "plan moduda full otonom ilerleyebilmeli" (replaces owner decision 1: item drafts no longer wait as
-- cards after approval when the plan is autonomous).
--
--  * chat_plans.autonomous — approving with "Otonom yürüt" on (the default) is the owner's consent to run the plan's
--    drafts: a draft of a continuation turn runs at once (trigger `plan`), except what the security policy keeps on a
--    card. Plans approved before this migration were approved under the card rule: they stay cards (false).
--  * chat_plan_items.failures — consecutive failed attempts (job / run failed) of an item; at 3 the item stays blocked
--    and the owner is told (no further automatic retry until they continue the plan).
--
-- Additive. Rollback: an older master ignores both columns; to remove:
--   ALTER TABLE chat_plans DROP COLUMN autonomous;
--   ALTER TABLE chat_plan_items DROP COLUMN failures;

ALTER TABLE chat_plans ADD COLUMN autonomous boolean NOT NULL DEFAULT true;
UPDATE chat_plans SET autonomous = false WHERE approved_version IS NOT NULL;

ALTER TABLE chat_plan_items ADD COLUMN failures smallint NOT NULL DEFAULT 0
  CHECK (failures >= 0 AND failures <= 100);
