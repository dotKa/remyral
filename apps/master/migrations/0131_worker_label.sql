-- p15-chat-cards-scroll item 4 (docs/design/p15-chat-cards-scroll.md §4): a person-chosen machine name.
--
--  * workers.label: the display name an admin gave the machine ("Makinelerin isimlerini düzenleyebilmeliyim"),
--    1–60 characters, NULL = none. `display_name` stays the one name every reader uses (lists, job cards, placement
--    reasons, chat tools, assistant prompts, notifications); it is now COALESCE(label, facts.hostname) — the label
--    wins, and the worker's HELLO no longer overwrites it (it refreshes the hostname fallback only while no label is
--    set). The hostname itself stays in `facts.hostname`.
--
-- Rollback: the old master ignores the column and rewrites display_name with the hostname on the next connect; drop it
-- by hand only after a rollback is final:  ALTER TABLE workers DROP COLUMN label;
-- Migration number 0131 (given in the brief); renumber at merge if needed.

ALTER TABLE workers
  ADD COLUMN label text NULL CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 60 AND label = btrim(label)));
