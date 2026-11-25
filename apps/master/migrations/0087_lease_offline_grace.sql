-- p11-master-resilience (ADR-0039, docs/design/p11-master-resilience.md): a lease may survive a master outage. The
-- master grants an `offline-grace-v1` worker an offline grace (sent as ASSIGN_JOB / RENEW_LEASE `lease.offlineGraceMs`):
-- while the worker cannot reach the master it keeps running the attempt for up to ttl + grace after its last confirmed
-- acknowledgement. The master holds such a lease for `offline_hold_ms` past `expires_at` (grace + a safety margin):
-- no LOST, no reassignment, and the worker's late messages are still live. 0 / 0 = the classic lease (every existing
-- row and every worker without the feature). Migration number 0087 (0088 / 0089 = parallel p11 work).
ALTER TABLE leases
  ADD COLUMN offline_grace_ms integer NOT NULL DEFAULT 0
    CHECK (offline_grace_ms >= 0 AND offline_grace_ms <= 3600000),
  ADD COLUMN offline_hold_ms integer NOT NULL DEFAULT 0
    CHECK (offline_hold_ms >= 0 AND offline_hold_ms <= 7200000),
  ADD CONSTRAINT leases_offline_hold_covers_grace CHECK (offline_hold_ms >= offline_grace_ms);

-- The grant is part of the lease's identity: once issued it never changes (the worker was told the grace).
CREATE OR REPLACE FUNCTION leases_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'leases rows cannot be removed (% rejected)', TG_OP USING ERRCODE = 'RA000';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'lease % (epoch %) is released and immutable', OLD.id, OLD.epoch USING ERRCODE = 'RA000';
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.attempt_id <> OLD.attempt_id OR NEW.worker_id <> OLD.worker_id
     OR NEW.epoch <> OLD.epoch OR NEW.acquired_at <> OLD.acquired_at
     OR NEW.offline_grace_ms <> OLD.offline_grace_ms OR NEW.offline_hold_ms <> OLD.offline_hold_ms THEN
    RAISE EXCEPTION 'lease % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;
