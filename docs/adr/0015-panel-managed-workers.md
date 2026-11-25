# ADR-0015: Panel-managed workers

- **Status:** Accepted — owner decision, 2026-10-14: "Makine tarafından ziyade panelden her şey
  yönetilebilmeli. Her makineye sürekli fiziki erişimim olmayacak." (Everything must be manageable from the
  panel rather than on the machine; I will not always have physical access to every machine.) **Partially superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands was removed; the `runtimes.openhands` settings no longer apply).
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-managed-workers`
- **Amends:** ADR-0010 rule 2 (where the worker-side allowlist comes from), ADR-0014 §1/§6 (where a runtime's
  auth mode is chosen), the "two locks" of docs/design/p3-workspace-and-secrets.md §1 (local allowlist first,
  master can only narrow). ADR-0005, ADR-0006, ADR-0007, ADR-0011 are unchanged and binding.
- **Related:** `p5-managed-workers`, `p5-project-git-ui`, follow-ups `p5-credentials-models`, `p5-remote-ops`;
  design note docs/design/p5-managed-workers.md

## Context
A worker's operational configuration — which projects/repositories it may check out (`workspace.projects`),
`allowedRuntimes`, `maxParallelJobs`, `runtimeAuth`, per-runtime settings, workspace hygiene — lived only in
the root/admin-owned local `config.json`. The master's `UPDATE_POLICY` deliberately did not narrow anything it
did not own (`allowedProjects: []`, `projectsUnrestricted: true`). A freshly paired worker therefore could run
nothing until someone edited a file on the machine, and every later change needed physical or shell access.
The owner will not have that access to all seven machines.

## Decision
1. **The master is the source of truth for operational configuration.** Per worker, the panel holds a
   versioned *worker config*: projects (by id), allowed runtimes, max parallel jobs, allowed sandbox profiles,
   per-runtime auth mode and settings, workspace options (retain failed, minimum free bytes, submodules) and
   labels. Every save creates a new **generation** (append-only history; rollback = a new generation with the
   content of an earlier one).
2. **The local file is minimal**: `masterUrl`, `workspaceRoot`/`dataDir`, keystore/device key, update trust
   keys (`updates.releaseKeys`, `skills.publicKeys`, optional `masterLeaseKeys`), telemetry, secret store, and
   local-only machine facts (runtime executable paths, Pi extension files, sandbox runner settings). A panel
   never chooses which executable or code file a worker runs.
3. **Optional local hard ceiling.** `localCeiling` in the local file (`projects` → repository URLs,
   `repoHosts`, `allowedRuntimes`, `maxParallelJobs`, `sandboxProfiles`) lets the owner pin a machine at
   install time. **The ceiling always wins**: the effective configuration is *panel ∩ ceiling*; anything the
   ceiling excludes is reported as `blocked_by_local_ceiling` and shown in the panel. Default for new and
   existing workers: managed by the panel, no ceiling.
4. **Backward compatibility (meaning migrated, nothing breaks).** Legacy operational keys still in a local file
   become ceiling/pins: a non-empty `workspace.projects` is the `projects` ceiling, a non-empty
   `allowedRuntimes` the runtime ceiling, an explicitly written `maxParallelJobs` the parallelism ceiling, and a
   `runtimeAuth.<kind>` or a model/provider/options value in `runtimes.<kind>` **pins** that runtime's auth or
   settings (the panel's values for it are not used and the pin is reported). Until the first panel generation
   is applied a worker runs on its local values exactly as before (`source: local`); an explicit
   `allowedRuntimes: []` is treated as "not set" (it never meant a ceiling).
5. **Repositories come only from registered git configuration.** An admin assigns *projects*, never URLs; the
   master resolves each project to the repository URL of its registered git configuration
   (`PUT /projects/:id/git`) when it builds the delivered document. A project without one cannot be assigned
   (`repo_not_registered`). A change of a project's registered repository produces a new generation for every
   worker that has the project.
6. **Delivery and acknowledgement.** `APPLY_WORKER_CONFIG` (control message, additive in protocol 1.0, ADR-0011)
   carries `{generation, documentHash, issuedAt, document, signature}`. It is sent only to workers that
   advertise the `worker-config-v1` feature, on change, and whenever a session's CAPABILITIES report another
   generation (so a lost message or a wiped data dir is repaired by the next session). The worker
   re-validates everything — schema, consistency rules, canonical hash, the Ed25519 signature by a master
   lease key (pinned `masterLeaseKeys` if configured, else the session's keys) bound to its own worker id and
   the generation, generation monotonicity — applies it **without restart**, persists it (0600, atomic) and
   answers `WORKER_CONFIG_STATUS` (`applied | unchanged | stale | rejected` + reason + issues). CAPABILITIES
   carries the same `workerConfig` report (applied generation and hash, effective configuration, ceiling,
   blocked items, last rejection). An invalid document is rejected as a whole; the previous one stays in effect.
7. **Every change is privileged and visible**: admin role, step-up and CSRF for every write (single worker,
   bulk, project-side assignment, rollback), optimistic concurrency on the generation, one audit event per
   generation in the same transaction, and a notification to admins (`worker.config_changed`).
8. **Placement uses the effective configuration** with explicit reasons: `project_not_assigned`,
   `repo_not_registered`, `config_not_applied` (transient until the worker reports the desired generation;
   permanent when it rejected it), `blocked_by_local_ceiling`, `runtime_not_enabled`.
9. **Secrets never travel in the configuration.** Runtime auth is `local-login` or `secret-ref` with a
   `credentialRef` (a worker-store secret *name* or, reserved, a vault credential *id*) and the target env var.
   ADR-0014 holds: the platform never handles a subscription login; `CLAUDE_CODE_OAUTH_TOKEN` is refused.

### Future work this decision is shaped for (not built now)
- **p5-credentials-models**: a panel credential vault and a model catalog. Credentials will be delivered in a
  *separate* message, sealed end-to-end to the worker's own device public key (X25519 derived/companion key),
  never inside `APPLY_WORKER_CONFIG`, never stored in plaintext on the master. The document already has the
  slots: `credentialRef.source = "vault"` (rejected by this release: `credential_source_unsupported`) and
  per-runtime `modelProfile` ids (today: runtime-policy profile names, later catalog ids). Per-runtime settings
  live under `runtimes.<kind>`, each with its own schema (OpenHands: LLM provider/model/base URL/options,
  confirmation policy fixed to `always-confirm`, agent-server options). The panel tab structure reserves
  "Runtimes & models" and "Credentials" sections.
- **p5-remote-ops**: runtime install/upgrade, Claude login hand-off, restart and log viewing from the panel —
  new feature-gated messages next to this one. A future config field that cannot be applied live will make the
  worker drain and exit for its service manager to restart it; none of the v1 fields needs that.

## Threat model impact
- **Panel/master compromise ⇒ any worker can be pointed at any *registered* repository**, any allowed runtime,
  and its parallelism raised; this widens the blast radius compared with the old local-only allowlist (T-WRK-4).
  It does *not* allow: arbitrary repository URLs (only registered git configs), choosing executables or code
  files, reading or injecting credential values, disabling the sandbox for untrusted sources (ADR-0007/0010
  selection still runs on the worker), or exceeding a local ceiling.
- **Mitigations:** admin + step-up + CSRF on every change; audit event per generation (hash, diff summary);
  admin notification on every change; registered-repo-only resolution; worker-side re-validation of every
  field and of the repository URLs (`parseRepoUrl`); signed, versioned documents (generation + canonical hash,
  signature bound to the worker id; pinning `masterLeaseKeys` makes a TLS-terminating proxy unable to forge
  one); acknowledged applied generation and drift display; the local ceiling for machines the owner wants
  pinned; full history with one-click rollback.
- **Residual risk accepted by the owner:** without a local ceiling, a compromised admin session with step-up
  can redirect a worker to another registered project. Owners who want a hard boundary set `localCeiling`.

## Alternatives considered
- **Keep local-only configuration** — rejected by the owner decision (no physical access).
- **Extend `UPDATE_POLICY`** — rejected: its `policyVersion` is the runtime-policy delivery generation of a
  worker *group*; mixing a per-worker document into it would couple two lifecycles, and the base fields have
  "do not narrow" semantics older workers rely on. A separate feature-gated control message keeps both clean.
- **Free-text repository URLs in the panel** — rejected: the registered git configuration is the one reviewed
  place where a repository enters the system (ADR-0010 authority order).
- **Push credential values with the config** — rejected (ADR-0006); a sealed-to-device-key channel is the
  follow-up.

## Consequences
- New tables (migration 0028), `workers.config.read/write`, `projects.workers.read/write` actions, Fleet →
  worker → Configuration tab, project-side repository and worker assignment UI.
- Operators of existing workers adopt them once ("Take over from local file" in the panel); until then the
  workers behave exactly as before.
- Docs: worker-pairing (minimal local file), runtime-setup, canvas guide, design note with rollback.

## Verification
Protocol tests (schema, hash, signature binding, consistency rules); worker tests (apply, hot reload of
scheduler-relevant capability, ceiling intersection, legacy migration, reject with reason, stale/replay,
persistence); master integration tests (PUT/GET/history/rollback/bulk/project-side assignment, optimistic
conflicts, step-up/CSRF/RBAC matrix, audit + notification, delivery on change and on drift, placement reasons);
web component tests (Configuration tab, project repository and workers sections).

## Amendment 2026-10-27: the worker's local settings in the managed configuration (p17-worker-managed Part 2)

The managed configuration gains `settings` (only to `worker-managed-v1` workers): `updates.enabled / channel /
minVersion / healthTimeoutSec`, the log level, an https OTLP endpoint (or off), the assistant (not `sandbox: off`),
remote operations (not the local `disabled` veto), the package caches switch, the probe / re-check intervals and — through
an owner-only, always-fresh route and only with machine administration enabled (ADR-0021 amendment) — runtime executable
paths. §4 applies unchanged: a key the local file writes pins it (reported blocked); `minVersion` is a floor;
telemetry from the panel only without a local `telemetry` section. Release / catalog keys, the install dir, identity,
trust roots and `localCeiling.*` stay local. The worker lays the stored document's settings over its file at start and
reports later changes as `pendingRestart` (the log level applies live). The root-owned updater takes the panel's
`updates.*` only in the narrowing direction. Design: docs/design/p17-worker-managed.md §2.
