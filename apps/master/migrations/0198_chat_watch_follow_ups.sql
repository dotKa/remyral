-- p19-watch-follow-up (owner 2026-10-30: "işler bu şekilde boşta kalmamalı. devam etmeli ya da benim müdahalem
-- gerekiyorsa müdahale etmeliyim"): a check watch of a conversation that ended without its condition (timed out, can
-- never be met, the watched record is gone, the check limit) hands the conversation back to the assistant — one
-- system-written turn that finds out why and carries on, or says what the person has to do.
--
--  * chat_watches.follow_up: what became of that hand-off — `sent`, or `skipped:<why>` (claimed once, also with
--    several replicas). NULL: not handed off (yet), or a watch that needs none.
--
-- Additive. Rollback: an older master never reads the column; to remove:
--   ALTER TABLE chat_watches DROP COLUMN follow_up;

ALTER TABLE chat_watches ADD COLUMN follow_up text NULL
  CHECK (follow_up IS NULL OR follow_up ~ '^(sent|skipped:[a-z_]{1,40})$');
