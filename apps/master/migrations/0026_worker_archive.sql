-- p5-fleet-archive (docs/design/p2-transport.md "p5-fleet-archive decisions"): "remove from list" for workers
-- that can never work again (denied enrollment, failed pairing, revoked, or no usable device key). Archiving is
-- not deletion: the row, its credentials (denied/revoked keys stay refused) and the audit trail are kept; an
-- archived worker is only hidden from the fleet lists, placement and alerts. Unarchive clears both columns.
ALTER TABLE workers
  ADD COLUMN archived_at timestamptz NULL,
  ADD COLUMN archived_by uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT workers_archived_by_check CHECK (archived_by IS NULL OR archived_at IS NOT NULL);
