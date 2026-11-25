-- p6-worker-boot-diagnostics (docs/design/p6-worker-boot-diagnostics.md): why an update attempt failed. The worker
-- attaches bounded, redacted evidence to a rolled_back / failed UPDATE_STATUS — the boot-log verdict and records
-- of the failed version, the service manager's stdout/stderr capture, the privileged updater's own log and its
-- service-restart errors (protocol `UpdateDiagnostics`, at most 32 KiB). NULL for older workers and for attempts
-- without evidence. Additive only.
ALTER TABLE worker_update_attempts
  ADD COLUMN diagnostics jsonb NULL
    CHECK (
      diagnostics IS NULL
      OR (jsonb_typeof(diagnostics) = 'object' AND octet_length(diagnostics::text) <= 65536)
    );
