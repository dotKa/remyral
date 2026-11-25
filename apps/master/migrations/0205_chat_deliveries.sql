-- p20-outcome (docs/design/p20-outcome-contract.md): the leased, idempotent hand-off of a system-written continuation
-- turn (plan continuation, watch follow-up, goal resume). "sent" is written in the transaction that creates the turn;
-- a claim whose lease ran out without it is taken again; a fencing token keeps a slow sender from creating a second
-- turn.
--
--  * chat_deliveries: one row per continuation (key = idempotency key); one live claim per (kind, ref_id).
--
-- Additive. Rollback: an older master never reads the table (it claims with chat_watches.follow_up / chat_plans.cont_due
-- as before); to remove:
--   DROP TABLE chat_deliveries;

CREATE TABLE chat_deliveries (
  key          text PRIMARY KEY CHECK (key ~ '^(plan|watch|goal):[0-9a-f-]{36}(:[0-9a-z-]{1,40})?$'),
  kind         text NOT NULL CHECK (kind IN ('plan', 'watch', 'goal')),
  ref_id       uuid NOT NULL,
  thread_id    uuid NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  state        text NOT NULL CHECK (state IN ('claimed', 'sent', 'released', 'failed', 'expired')),
  token        uuid NOT NULL,
  lease_until  timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  message_id   uuid NULL,
  turn_id      uuid NULL,
  reason       text NULL CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  sent_at      timestamptz NULL,
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
);
CREATE UNIQUE INDEX chat_deliveries_live_idx ON chat_deliveries (kind, ref_id) WHERE state = 'claimed';
CREATE INDEX chat_deliveries_lease_idx ON chat_deliveries (lease_until) WHERE state = 'claimed';
CREATE INDEX chat_deliveries_ref_idx ON chat_deliveries (kind, ref_id, created_at DESC);
