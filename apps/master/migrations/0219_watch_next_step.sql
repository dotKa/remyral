-- p22-watch-next-step (docs/design/p22-watch-next-step.md): what the assistant said it does once a watched thing ends.
-- A watch with a next step hands the conversation back to the assistant whenever it ends (met, failed, expired), so a
-- promise like "when the job is done I push the files and deploy" is kept by the platform, not by the model's memory.
ALTER TABLE chat_watches
  ADD COLUMN next_step text NULL CHECK (next_step IS NULL OR char_length(next_step) BETWEEN 1 AND 500),
  -- When the person's own message that asked for the work was written (a watch of a continuation turn inherits it):
  -- the follow-up's drafts run at once like that message's for GOAL_GRANT_TTL_MS; NULL = its drafts stay cards.
  ADD COLUMN next_step_consent_at timestamptz NULL;
