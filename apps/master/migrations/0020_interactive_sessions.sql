-- p5-canvas-links (ADR-0013; docs/design/p5-interactive-openhands.md): interactive OpenHands sessions are
-- ordinary jobs (spec.kind = 'interactive-openhands'); this adds what placement and the session list need.
-- Additive only.

-- Optional protocol features a worker reported in its latest CAPABILITIES (`streams-v1`,
-- `interactive-openhands`). Interactive sessions are placed only on workers that advertise both.
ALTER TABLE workers ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(features) = 'array');

-- The session list (GET /interactive/sessions) and the proxy's session lookup filter on the job kind.
CREATE INDEX jobs_interactive_idx ON jobs (created_at DESC)
  WHERE spec->>'kind' = 'interactive-openhands';
