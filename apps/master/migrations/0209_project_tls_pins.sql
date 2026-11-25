-- p22-runtime-diagnostics (docs/design/p22-runtime-diagnostics.md): certificates a project trusts although they fail
-- verification (self-signed internal services), each bound to one host:port. Function jobs of the project
-- (workflow HTTP nodes, watch checks, …) get them as ASSIGN_JOB `execution.tlsPins` on `function-tls-pins-v1` workers;
-- every other request stays strict. Opt-in per project: a row is written only through src/tls-pins/* ("Trust this
-- certificate" on a failed job that reported `tls_untrusted` with the fingerprint the worker saw; project admin, the
-- step-up of `projects.egress.write`), audited `project.tls_pin.add` / `project.tls_pin.remove`.
-- Additive only (rollback: leave the table; older code never reads it). Migration number 0209 (given in the brief).

CREATE TABLE project_tls_pins (
  id          uuid PRIMARY KEY,
  project     text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Lower-case DNS name or IP literal as the worker reported it for the refused hop.
  host        text NOT NULL CHECK (host ~ '^[a-z0-9.:-]{1,253}$'),
  port        integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  -- SHA-256 of the DER certificate (the self-signed root of the presented chain, else the leaf): 64 hex digits.
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The failed job whose report the pin was taken from (kept for the audit trail; the job may be deleted later).
  source_job  text NULL,
  created_by  uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  UNIQUE (project, host, port, sha256)
);

CREATE INDEX project_tls_pins_project ON project_tls_pins (project);
