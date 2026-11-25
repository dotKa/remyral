-- p5-ops-chat-next (ADR-0018 follow-up): the ops chat assistant can run on any of the four runtimes. Settings → Chat
-- picks Claude Code, Codex, OpenCode or Pi; the worker reports which engines it has (workers.assistant). Same tool
-- protocol and draft-and-confirm rules for every engine; only the CHECK on the chosen runtime widens.
--
-- Rollback: UPDATE chat_settings SET runtime = 'claude-code', enabled = false WHERE runtime <> 'claude-code';
-- then restore the original CHECK (runtime IN ('claude-code')).
ALTER TABLE chat_settings DROP CONSTRAINT chat_settings_runtime_check;
ALTER TABLE chat_settings ADD CONSTRAINT chat_settings_runtime_check
  CHECK (runtime IN ('claude-code', 'codex', 'opencode', 'pi'));
