-- p5-remote-ops (ADR-0017, docs/design/p5-remote-ops.md): operate workers from the panel — install / upgrade /
-- remove pinned runtimes, relay the runtimes' own subscription login, restart the worker or a runtime, read
-- redacted logs and run diagnostics. Rows are written only through src/remote-ops/*.
--
-- What is NOT stored here, by design: login URLs and device codes (relayed from memory, short-lived), codes the
-- owner pastes back (never stored or logged anywhere), log lines (redacted, held in memory for the panel for a
-- few minutes). A row records the request, its parameters without any secret, the worker's progress and a
-- bounded result (runtime install state, login status, redacted diagnostics).

CREATE TABLE worker_ops (
  -- = OPS_COMMAND.commandId
  id            uuid PRIMARY KEY,
  worker_id     text NOT NULL REFERENCES workers (id),
  kind          text NOT NULL CHECK (kind IN ('runtime.install', 'runtime.remove', 'runtime.restart', 'login.start',
                                              'login.input', 'login.status', 'login.logout', 'ops.cancel',
                                              'service.restart', 'logs.tail', 'diagnostics.run')),
  -- The operation without secrets (login.input keeps only its target).
  params        jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  state         text NOT NULL CHECK (state IN ('sent', 'accepted', 'running', 'waiting_for_user', 'succeeded',
                                               'failed', 'refused', 'cancelled', 'lost')),
  reason        text NULL CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  detail        text NULL CHECK (detail IS NULL OR length(detail) <= 500),
  progress      jsonb NULL CHECK (progress IS NULL OR jsonb_typeof(progress) = 'object'),
  result        jsonb NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  last_seq      integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  requested_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  finished_at   timestamptz NULL
);
CREATE INDEX worker_ops_worker ON worker_ops (worker_id, requested_at DESC);

-- The worker's last CAPABILITIES.remoteOps report (managed installs, pinned versions it can install, login
-- states from the runtimes' own status commands, restartability).
ALTER TABLE workers
  ADD COLUMN remote_ops jsonb NULL CHECK (remote_ops IS NULL OR jsonb_typeof(remote_ops) = 'object'),
  ADD COLUMN remote_ops_at timestamptz NULL;
