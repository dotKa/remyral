-- p20-decisions (docs/design/p20-decisions.md; owner complaints #5, #6, #12): one decision state for every device.
--
--  * decision_deferrals: a decision (or a "Senden bekleyen" row) a person put off ("Ertele", a day) or ignored
--    ("Yoksay", a week) — per person, on the server, so the sidebar badge, the home and /needs count the same on the
--    phone and the desktop (it lived in each browser's localStorage). Nothing is decided: the approval, merge or
--    question stays as it is. A row past `until` is no longer read (the decision is back) and is pruned on the
--    person's next write. One row per person and decision (`kind` + `subject`, e.g. `approval` + its id); a later
--    snooze / ignore replaces the earlier one.
--  * user_questions.close_note: what the conversation settled when a plan decision was closed with
--    plan_close_decision (`settled_in_chat`) — the folded card says "Sohbette karara bağlandı: <note>" (it was only in
--    the audit log).
--
-- Additive. Rollback: an older master never reads either; to remove:
--   DROP TABLE decision_deferrals; ALTER TABLE user_questions DROP COLUMN close_note;

CREATE TABLE decision_deferrals (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]{0,39}$'),
  subject     text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  mode        text NOT NULL CHECK (mode IN ('snooze', 'ignore')),
  until       timestamptz NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind, subject)
);

-- The reads ("my deferrals still in force") and the prune ("mine that ran out").
CREATE INDEX decision_deferrals_user_until ON decision_deferrals (user_id, until);

ALTER TABLE user_questions ADD COLUMN close_note text NULL
  CHECK (close_note IS NULL OR char_length(close_note) <= 500);
