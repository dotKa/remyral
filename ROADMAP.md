# Remyral Agent Cluster — Full Production Roadmap

**Status:** Architecture approved / implementation pending  
**Scope:** Complete production platform, not an MVP  
**Topology:** a self-hosted control plane (one Linux host, e.g. AWS EC2 with Coolify, or the bundled installer) and a fleet of outbound-connected execution machines on Linux, macOS, Windows and Raspberry Pi (x64 / arm64).  
**Agent runtimes:** Claude Code, Codex, Pi, OpenCode. (OpenHands was removed by owner decision, ADR-0023, 2026-10-15.)

## Product requirements

1. Start, pause where supported, resume, cancel and inspect remote coding jobs from mobile or desktop.
2. Spawn one or many agents across different geographic sites without inbound router ports.
3. Unified job queue, priority, dependencies, approval steps, schedules, budgets and concurrency limits.
4. Multi-agent work decomposition with planner, executor, verifier and integrator; explicit dependency DAG.
5. Five pluggable runtimes with accurate feature negotiation instead of pretending feature parity.
6. Repository isolation with separate worktrees/branches, CI verification, review and protected merges.
7. Worker auto-enrollment approval, health probes, graceful draining, offline recovery and upgrades.
8. Shared project instructions, durable global memory, searchable task history and skill distribution.
9. Secrets protection, RBAC, MFA/SSO, audit logging, remote execution permissions and policy controls.
10. Streaming events/logs/artifacts, observability, model cost tracking and budget enforcement.
11. Backups, restoration drills, retention, disaster recovery and operational alerts.

## Fixed architecture

- **AWS control plane only:** Coolify runs API/orchestrator, dashboard, Postgres, Redis, event/artefact metadata, notification service and auth gateway (OpenHands Canvas removed, ADR-0023). Never schedule development code on EC2 by default.
- **Workers run execution:** Separate Node.js/TypeScript daemon on every execution machine. Linux workers optionally run isolated Docker sandboxes; Windows/macOS use a supported sandbox mechanism or a restricted host-native runner for platform-specific builds.
- **Connections:** Worker initiates outbound WSS to the master, with signed enrollment and per-device credentials. Tailscale provides private administrator access; no public worker agent server endpoints.
- **Runtime adapters:** Claude Code and Codex via version-pinned supported ACP adapters where feasible; Pi through versioned RPC or validated ACP bridge; OpenCode through local password-protected HTTP API. Validate exact commands and version compatibility during integration.
- **Workflow:** Postgres is source of truth for jobs/state; Redis/BullMQ is delivery mechanism. Worker claims use leases with fencing tokens and idempotency to avoid accidental duplicate execution.
- **Storage:** Code stays in workspaces on workers; Git remote is the synchronization boundary. Artifacts/log indexes are stored centrally with encryption and retention policies; exclude secrets/source unless explicitly permitted.
- **Dashboard:** a unified React dashboard is the one surface for orchestration. (The OpenHands Canvas screen and deep links were removed by ADR-0023.)

## Phase plan (all mandatory for production release)

### P0 — Discovery, compatibility, threat model
- Inventory CPU/RAM/storage/OS/arch of the target machines (one per supported OS / architecture), available CLI versions, Git provider and provider credentials.
- Test ACP agents, OpenCode server, Pi RPC/bridge on target OS/architectures; record compatibility matrix and unsupported capabilities.
- Define threat model: malicious repo instructions, untrusted PRs, prompt injection, key leakage, sandbox escape and rogue workers.
- Define service level objectives: control-plane availability, acceptable reconnection latency, job start latency and data recovery objectives.
**Gate:** signed-off architecture decision records, compatibility results and threat model.

### P1 — AWS and operations foundation
- Provision EC2 with Ubuntu LTS, gp3 storage, IAM least privilege, encrypted EBS, SSM access, backup strategy and budget alarms.
- Install Coolify, HTTPS ingress, Tailscale, firewall and identity proxy/SSO with MFA. Restrict administrative ports.
- Deploy Postgres, Redis, master API and web dashboard with resource limits, health checks and restart policies.
- Set up CI/CD, release channels, monitoring, audit/event schema and off-host backups.
**Gate:** auth-tested remote access; restart and restore rehearsal; no unauthenticated public control endpoints.

### P2 — Worker fleet and secure transport
- Cross-platform signed/configured installer and service manager integrations: systemd, launchd and Windows Service.
- Outbound secure websocket, pairing code/approval, per-worker identity rotation, heartbeat, capability discovery and telemetry.
- Worker states: pending, online, busy, draining, offline, quarantined, updating.
- Durable reconnect with cursor/replay, deduplication, lease renewal, remote disable/revoke and auto-update rollback.
- ARM64 compatibility validation for Raspberry Pi; keep workload policy capacity-aware.
**Gate:** workers on every supported OS family connect from distinct networks; reboot, NAT and intermittent internet tests pass.

### P3 — Five runtime adapter implementations
- Common interface: detect/install-check, authenticate status, spawn, stream, prompt, interactive approval, suspend/resume when available, cancel, collect artifacts, observe exit and cost.
- Implement Claude Code, Codex, Pi, OpenCode adapters individually (the OpenHands adapter was removed by ADR-0023).
- Feature matrix for each adapter. Hide/disable unsupported commands rather than pretending they work.
- Per-worker runtime policy, model profiles, version pinning, upgrade/rollback and secure credential handling.
**Gate:** each agent type runs an end-to-end real repository task with streamed output, cancellation and an auditable result.

### P4 — Scheduler, execution and multi-agent orchestration
- Queue with priorities, max parallelism, worker affinity, OS/arch/tool requirements, memory/CPU quotas and fairness.
- State transitions persisted transactionally; job leases + fencing; retries only for verified-safe/idempotent steps.
- DAG workflow engine: planner, code agents, test agents, reviewer, integrator; dependency constraints and human approvals.
- Workspace repository cloning, worktree isolation, branch naming, shared cache safety and cleanup/retention.
- CI integration and protected merge workflow; approval gate for destructive/network-sensitive actions.
- Model/provider quota-awareness, run budgets and runaway-agent stops.
**Gate:** multi-worker concurrency; simulated crashes don't create silent duplicate commits; protected merge requires approval.

### P5 — Unified web operations console
- Worker fleet map/list, capacity, status, agent compatibility and history.
- Job composer: project, repo, branch, agent, model, constraints, dependency DAG, budget and schedule.
- Live logs/events/terminal where runtime permits, files/diff/artifacts, PR links and interactive approval prompts.
- Search, filtering, notifications, mobile UI, audit explorer and cost/usage dashboards.
- ~~Deep links to OpenHands Canvas for native conversations~~ (removed, ADR-0023); the central app is authoritative for cluster jobs.
**Gate:** every critical control action works through web UI and REST API with authorization checks.

### P6 — Durable context, skills and observability
- Global context vs repository/project-specific context separated with provenance, namespaces and versioning.
- Signed/versioned skills and agent instructions; context policy prevents leaking unrelated project secrets.
- Embedding/vector search optional, with deletion/reindex semantics and consent-bound source capture.
- Capture session events into OpenTelemetry-compatible traces, metrics/logs; AgentMagnify integration as an optional plugin.
- Cost attribution by project/worker/runtime/provider with incomplete-data flags.
**Gate:** two different workers reproduce the same project rules; retrieval permissions and context deletion tested.

### P7 — Hardening and production acceptance
- Authentication/RBAC/SSO/MFA; worker attestation/pairing; rate limiting; secrets scanning, redaction and audit records.
- Linux container security and host-native least privilege; filesystem/network allowlists and sandbox escape tests.
- Supply-chain security: pinned deps, signed releases, SBOM, vulnerability scanning and dependency update policy.
- Failure tests: master reboot, Redis outage, DB failover/restore, worker power loss, disconnected networks, revoked worker, compromised token and Git conflict.
- Load tests, retention enforcement, backup restore drill, user docs and on-call runbooks.
**Gate:** every acceptance test in ACCEPTANCE.md passes. No production release before gate completion.

## Release philosophy

All phases contribute to a **single full-featured v1.0**. Interim deployments are engineering checkpoints only, not an MVP feature freeze. Separate staging and production, promote through review, and never deploy unfinished security-sensitive paths as public endpoints.

## Prioritization / dependencies

P0 -> P1 -> P2 -> P3 -> P4 -> P5 -> P6 -> P7. UI/protocol tests can proceed in parallel with later phases, but the production gate needs all phases complete.
