-- p4-approvals (ADR-0009 step-up, ADR-0010 authority order, threat model T-INJ-2/3, T-OPS-3):
-- versioned per-project approval policies, approval requests and append-only approval decisions.
-- Rows are written only through src/approvals (ApprovalService, ProjectPolicyStore). The triggers below
-- are defence in depth (SQLSTATE RA000) like the job tables in 0003.

---------------------------------------------------------------------------------------------------
-- Project policies: one immutable row per version. The current policy is the highest version.
---------------------------------------------------------------------------------------------------

CREATE TABLE project_policies (
  project    text NOT NULL CHECK (project ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  version    integer NOT NULL CHECK (version >= 1),
  rules      jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  reason     text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project, version)
);

-- A new version must be exactly previous + 1 (gap-free history; concurrent writers collide on the PK).
CREATE FUNCTION project_policies_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  SELECT max(version) INTO latest FROM project_policies WHERE project = NEW.project;
  IF NEW.version <> COALESCE(latest, 0) + 1 THEN
    RAISE EXCEPTION 'project % policy version must be %', NEW.project, COALESCE(latest, 0) + 1
      USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_policies_insert
  BEFORE INSERT ON project_policies
  FOR EACH ROW EXECUTE FUNCTION project_policies_guard_insert();

CREATE FUNCTION approvals_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER project_policies_no_update_delete
  BEFORE UPDATE OR DELETE ON project_policies
  FOR EACH ROW EXECUTE FUNCTION approvals_reject_change();
CREATE TRIGGER project_policies_no_truncate
  BEFORE TRUNCATE ON project_policies
  FOR EACH STATEMENT EXECUTE FUNCTION approvals_reject_change();
REVOKE UPDATE, DELETE, TRUNCATE ON project_policies FROM PUBLIC;

---------------------------------------------------------------------------------------------------
-- Approval requests
---------------------------------------------------------------------------------------------------

CREATE TABLE approval_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs (id),
  attempt_id         uuid NULL REFERENCES job_attempts (id),
  -- Fencing epoch of the job when the request was made (ADR-0004); a decision for another epoch is stale.
  epoch              integer NOT NULL CHECK (epoch >= 0),
  -- Idempotency key: the runtime's approvalId (protocol `approval_request` event) or `gate:<action>`.
  approval_key       text NOT NULL CHECK (approval_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- gate: the job waits in AWAITING_APPROVAL; in_run: a running attempt waits for APPROVAL_DECISION.
  kind               text NOT NULL CHECK (kind IN ('gate', 'in_run')),
  action             text NOT NULL CHECK (action IN (
                       'git.push_protected', 'git.merge', 'git.force_push', 'deploy',
                       'fs.delete_outside_workspace', 'network.egress_non_allowlisted', 'secret.read',
                       'runtime.dangerous_tool', 'job.budget_increase')),
  -- The action string as reported (may be a runtime tool name classified as runtime.dangerous_tool).
  requested_action   text NOT NULL CHECK (length(requested_action) BETWEEN 1 AND 128),
  risk               text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  -- Untrusted text from the runtime/worker: shown escaped, never interpreted.
  summary            text NOT NULL CHECK (length(summary) <= 2000),
  requested_by_type  text NOT NULL CHECK (requested_by_type IN ('runtime', 'worker', 'system')),
  requested_by_id    text NULL CHECK (requested_by_id IS NULL OR length(requested_by_id) <= 200),
  -- in_run: the worker that held the lease when the request was made (the decision is addressed to it).
  worker_id          text NULL CHECK (worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- Snapshot of the resolved rule at request time (later policy edits do not change open requests).
  policy_version     integer NOT NULL CHECK (policy_version >= 0),
  approver_role      text NOT NULL CHECK (approver_role IN ('operator', 'admin', 'owner')),
  required_approvals integer NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
  step_up            boolean NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  created_at         timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  decided_at         timestamptz NULL,
  decided_by         uuid NULL REFERENCES users (id),
  decision_reason    text NULL CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000),
  CHECK (expires_at > created_at),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- Only humans approve or deny; expiry and cancellation are system outcomes.
  CHECK ((status IN ('approved', 'denied')) = (decided_by IS NOT NULL)),
  CHECK (kind <> 'in_run' OR (attempt_id IS NOT NULL AND worker_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (job_id, attempt_id, approval_key)
);

CREATE INDEX approval_requests_status_idx ON approval_requests (status, created_at DESC);
CREATE INDEX approval_requests_pending_expiry_idx ON approval_requests (expires_at) WHERE status = 'pending';
CREATE INDEX approval_requests_job_idx ON approval_requests (job_id, created_at);

-- A request is decided once: pending → approved | denied | expired | cancelled; then immutable.
CREATE FUNCTION approval_requests_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval request % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'RA000';
  END IF;
  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION 'approval request % update must decide it', OLD.id USING ERRCODE = 'RA000';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.attempt_id, NEW.epoch, NEW.approval_key, NEW.kind, NEW.action,
      NEW.requested_action, NEW.risk, NEW.summary, NEW.requested_by_type, NEW.requested_by_id, NEW.worker_id,
      NEW.policy_version, NEW.approver_role, NEW.required_approvals, NEW.step_up, NEW.created_at,
      NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.job_id, OLD.attempt_id, OLD.epoch, OLD.approval_key, OLD.kind, OLD.action,
      OLD.requested_action, OLD.risk, OLD.summary, OLD.requested_by_type, OLD.requested_by_id, OLD.worker_id,
      OLD.policy_version, OLD.approver_role, OLD.required_approvals, OLD.step_up, OLD.created_at,
      OLD.expires_at) THEN
    RAISE EXCEPTION 'approval request % identity columns are immutable', OLD.id USING ERRCODE = 'RA000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_requests_update
  BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_guard_update();
CREATE TRIGGER approval_requests_no_delete
  BEFORE DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approvals_reject_change();
CREATE TRIGGER approval_requests_no_truncate
  BEFORE TRUNCATE ON approval_requests
  FOR EACH STATEMENT EXECUTE FUNCTION approvals_reject_change();
REVOKE DELETE, TRUNCATE ON approval_requests FROM PUBLIC;

---------------------------------------------------------------------------------------------------
-- Approval decisions: one row per human vote, append-only.
---------------------------------------------------------------------------------------------------

CREATE TABLE approval_decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES approval_requests (id),
  decision    text NOT NULL CHECK (decision IN ('approve', 'deny')),
  user_id     uuid NOT NULL REFERENCES users (id),
  user_role   text NOT NULL CHECK (user_role IN ('owner', 'admin', 'operator', 'viewer')),
  reason      text NULL CHECK (reason IS NULL OR length(reason) <= 1000),
  -- The TOTP verification that authorised this decision (ADR-0009 §10); NULL only if the rule had no step-up.
  step_up_at  timestamptz NULL,
  decided_at  timestamptz NOT NULL,
  UNIQUE (request_id, user_id)
);

CREATE INDEX approval_decisions_user_idx ON approval_decisions (user_id, decided_at);

CREATE TRIGGER approval_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION approvals_reject_change();
CREATE TRIGGER approval_decisions_no_truncate
  BEFORE TRUNCATE ON approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION approvals_reject_change();
REVOKE UPDATE, DELETE, TRUNCATE ON approval_decisions FROM PUBLIC;
