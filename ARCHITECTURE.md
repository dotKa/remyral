# System Architecture and Interfaces

## Plane separation

```
Browser / Mobile
      | TLS + SSO/MFA
      v
Control-plane host, e.g. AWS EC2 + Coolify (always-on)
  [React Dashboard] [Fastify Master API]
                       |            \
                [Postgres]       [Redis/BullMQ]
                       |            /
                  [Scheduler & Policy]
                         |
                    WSS (outbound from workers; mTLS/token pairing)
                         |
       +-----------------+-----------------+
       |                 |                 |
   Linux             Windows            macOS          Raspberry Pi
 Worker Daemons      Worker Daemons      Worker Daemons  Worker Daemons
       |                 |                 |                |
   Isolated jobs     Scoped native      Scoped native     Lightweight jobs
       +--------------- Git remote + artifacts +-------------+
```

## Worker protocol (versioned)
- Worker -> master: HELLO, CAPABILITIES, HEARTBEAT, LEASE_ACK, EVENT, LOG_CHUNK, JOB_RESULT, ARTIFACT_REF.
- Master -> worker: ENROLL_APPROVED, ASSIGN_JOB, RENEW_LEASE, CANCEL_JOB, DRAIN, ROTATE_CREDENTIAL, UPDATE_POLICY.
- Panel-managed configuration (ADR-0015, additive): master -> worker APPLY_WORKER_CONFIG (signed, generation + hash), worker -> master WORKER_CONFIG_STATUS; the worker's effective configuration (panel ∩ local ceiling) is reported in CAPABILITIES.
- Research workspaces (p5-research-workspace, additive, feature `workspace-v1`): worker -> master ARTIFACT_CHUNK (sequenced) committed by ARTIFACT_REF, JOB_INPUT_REQUEST (control); master -> worker JOB_INPUT_DATA (control); JobSpec carries `workspace` instead of `repository`.
- Skill layout v2 (p14-skill-catalogs, additive, feature `skills-layout-v2`): ASSIGN_JOB `skills.deferred` carries signed skill manifests whose files the worker pulls with SKILL_FILE_REQUEST (control, by manifest SHA-256 + path) → SKILL_FILE_DATA (control); the worker verifies every file against the signed manifest.
- Each event contains protocolVersion, workerId, jobId where relevant, monotonic sequence, timestamp and correlationId.
- Job assignment requires signed lease token + fencing epoch; retries safe only after lease reconciliation.
- Support reconnection resume cursor, bounded buffers, backpressure, chunking and redaction.

## Scheduler
Eligibility filters: online/healthy; agent installed/authenticated; OS/arch; project policy; required tools; disk/RAM budget; maximum parallel tasks. Scoring includes free capacity, affinity, locality/data transfer, historical reliability and cost. Reject infeasible jobs with actionable reason.

## Job state machine
DRAFT -> QUEUED -> RESERVED -> STARTING -> RUNNING -> VERIFYING -> AWAITING_APPROVAL -> SUCCEEDED. Possible detours: RETRY_WAIT, FAILED, CANCELLING -> CANCELLED, BLOCKED, LOST. Persist state transitions in Postgres. Worker outage puts jobs into reconciliation, not immediate blind rerun.

## Agent adapter contract
- `probe()` and `capabilities()`
- `spawn(context) -> sessionRef`
- `sendPrompt(sessionRef, prompt)`
- `events(sessionRef, cursor)`
- `requestApproval(sessionRef, decision)` where supported
- `cancel(sessionRef)`; `resume(sessionRef)` where supported
- `collectResult(sessionRef)` and `cleanup(sessionRef)`
- `getCost(sessionRef)` best-effort with provenance and unknown values permitted.

Adapters are process-local to the worker; local HTTP ports bind to loopback. (OpenHands, and with it the Agent Server backend, was removed by ADR-0023.) Use ACP for tested supported agents; use native SDK/RPC/API when more reliable. Capability negotiation is required.

## Data model (minimum)
Users, Organizations, Roles, Workers, WorkerCredentials, RuntimeInstallations, Projects, Repositories, Workspaces, Jobs, JobAttempts, JobDependencies, Leases, Sessions, AgentEvents, Approvals, Artifacts, SecretsReferences, Policies, Memories, Skills, ModelProviders, UsageRecords, AuditEvents, Notifications, Schedules, Webhooks.

## Authentication and security
- Human: identity provider + MFA, short sessions, role-based/attribute-based authorization.
- Worker: one-time pairing plus device credentials; rotate and revoke; bind roles to allowed project directories.
- Automation (ADR-0058): personal API tokens and service accounts — opaque `ryl_pat_` / `ryl_sa_` bearer tokens stored as keyed hashes, required expiry, scopes intersected with the principal's role, never a way around the security policy's step-up events.
- Outgoing webhooks (ADR-0059): the master posts catalog events (strict schemas, no secrets / prompts / logs) to admin-chosen https targets under the egress floor (internal origins only on the owner's audited list), signed with HMAC-SHA256 (`X-Remyral-Signature`, rotation overlap) and deduplicable by `X-Remyral-Delivery`; produced from the audit log in the same transaction as the cursor, sent at least once with fenced multi-master claims, retries and auto-disable.
- Support report (ADR-0062): diagnostics leave the installation only as a redacted, previewed zip e-mailed on an owner / admin's explicit request to the owner-set support address (step-up event `support.report`), audited with the bundle hash; the daily diagnostics run only notifies inside the installation.
- Secrets: manager references or encrypted secrets with external KMS; no credentials in client JS, LLM transcripts, logs or Git.
- Execution: deny arbitrary filesystem access by default; require project allowlist; agent command/network permissions and approval policy.
- Observability: scrub secret patterns and PII; bounded retention.

## Deployment
Coolify-managed services with persistent volumes only for DB/Redis where appropriate; automatic backups stored outside the control-plane host. Do not place Docker socket access inside the public-facing API. Deploy worker as OS-native service with separately authenticated updates.
