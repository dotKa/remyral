# Design note: `p5-managed-workers` + `p5-project-git-ui` — every worker managed from the panel

- **Tasks:** `p5-managed-workers` (panel-managed operational configuration), `p5-project-git-ui` (Projects
  screen: repository + workers). Owner decision 2026-10-14 (ADR-0015): "everything must be manageable from the
  panel; I will not always have physical access to every machine".
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0015 (this decision), ADR-0005 (device identity), ADR-0006 (secrets by reference),
  ADR-0007/0010 (sandbox selection and authority order stay on the worker), ADR-0011 (additive protocol,
  unknown fields stripped), ADR-0014 (auth modes; the platform never touches a subscription login), `p5-rbac`
  (every route declares `config.authz`), p3-runtime-policy (model profiles, pins — unchanged).
- **Out of scope (follow-ups, protocol kept extensible):** `p5-credentials-models` (credential vault delivered
  sealed to the worker key, model catalog), `p5-remote-ops` (runtime install/upgrade, Claude login hand-off,
  remote restart, log viewing).

## Shape

```
packages/protocol/src/worker-config.ts      WorkerConfigSpec (admin edits: project ids), WorkerConfigDocument
                                            (delivered: project → registered repository URLs), per-runtime
                                            settings schemas, CredentialRef (worker-store | vault-reserved),
                                            canonical hash, consistency rules, Ed25519 statement sign/verify,
                                            WorkerConfigReport (effective, ceiling, blocked, rejected)
packages/protocol (messages)                APPLY_WORKER_CONFIG (master → worker, control), WORKER_CONFIG_STATUS
                                            (worker → master, control), CAPABILITIES.workerConfig,
                                            feature `worker-config-v1` — all additive in 1.0
apps/master/migrations/0028_managed_workers worker_config_versions (append-only, gap-free), worker_configs
                                            (desired + delivery), workers.config_report, notification kind
                                            `worker.config`
apps/master/src/worker-config/              service (generations, rollback, bulk, project-side assignment,
                                            repository re-resolution, delivery, reports), routes, outbox topic
apps/master/src/gitflow/config-store.ts     onRepositoryChanged → re-resolve affected workers
packages/scheduler/src/placement.ts         ManagedPlacementConfig + 5 reason codes
apps/worker/src/config/ceiling.ts           localCeiling + legacy keys → ceiling and pins
apps/worker/src/managed-config/             store (persist), effective (panel ∩ ceiling, report), manager
                                            (validate, apply, notify subscribers)
apps/web                                    Fleet → worker → Configuration, bulk change, Projects →
                                            Repository / Workers, composer reason labels
```

## Decisions

### 1. Spec vs document; repositories only from the registered git configuration

An admin edits a **spec** (`projects: string[]` + operational fields). The master resolves each project id to
the repository URL of its registered git configuration (`project_git_configs.repository_url`, written only by
`PUT /projects/:id/git`, admin + step-up) and stores the resulting **document** with its canonical SHA-256 next
to the spec in the same generation. Unknown projects (`unknown_project`), projects without a registered
repository (`repo_not_registered`) and URLs outside the wire grammar (`repository_url_unsupported`) are refused.
When a project's registered repository changes, every worker whose desired spec contains the project gets a new
generation (cause `repository`, system actor) — never silently stale. Rollback re-resolves too: it restores the
*spec* of an earlier generation against today's registrations.

### 2. Generations, optimistic concurrency, audit, notification

`worker_config_versions` is append-only and gap-free per worker (trigger, SQLSTATE RA000). Every write runs in
one transaction with a per-worker advisory lock (sorted for bulk writes), checks `expectedGeneration`
(`409 version_conflict`), writes the generation, moves `worker_configs.generation`, records
`worker.config.update` (generation, cause, document hash, before/after summary: project ids, runtimes,
parallelism, profiles, label count, auth *modes* only) and queues an outbox event `worker.config` → an in-app
notification (and opt-in e-mail/webhook) for owners/admins. An unchanged spec creates no generation. Causes:
`edit`, `adopt` (first generation taken over from the local file), `bulk`, `project`, `rollback`, `repository`.
Bulk changes are all-or-nothing: every worker's patched spec is validated and resolved before anything commits;
issues carry the worker id (`<workerId>:<path>`).

### 3. Delivery: a feature-gated control message, re-sent on drift

`APPLY_WORKER_CONFIG` is a **control** message (seq 0), not a durable outbox entry: the desired generation lives
in Postgres and is re-evaluated whenever the worker reports. The master sends it (a) right after a commit when
the worker is connected, and (b) on every CAPABILITIES / WORKER_CONFIG_STATUS whose report does not show the
desired generation applied — unless the worker *refused* exactly that generation (no re-send loop; a new edit or
rollback creates a new generation). It is sent only to workers whose latest CAPABILITIES advertised
`worker-config-v1`, so older builds (which would drop an unknown type as an invalid frame) never see it; such a
worker shows status **unsupported**.

The payload carries `{generation, documentHash, issuedAt, document, signature}`. The signature is an Ed25519
signature by the master's lease-signing key over `remana-worker-config/v1\n<workerId>\n<generation>\n<hash>\n
<issuedAt>` — bound to the worker and the generation, so it cannot be replayed to another worker or as another
generation. The document never contains a secret value: auth is `local-login` or `secret-ref` with a
`credentialRef` (worker-store secret *name*, or the reserved `vault` id that this release refuses with
`credential_source_unsupported`), and the master secret-scans every string leaf (labels, model ids, options).

### 4. Worker: validate, intersect, apply live, persist, report

`ManagedConfig.apply` (apps/worker/src/managed-config/manager.ts) judges every delivery independently of the
master:

| Outcome | When |
| --- | --- |
| `stale` | generation lower than the applied one (replay/reorder) |
| `unchanged` | same generation and hash as applied |
| `rejected: generation_conflict` | same generation, different hash |
| `rejected: hash_mismatch` | canonical hash of the document ≠ `documentHash` |
| `rejected: invalid_document` / `credential_source_unsupported` | `workerConfigIssues` (consistency, vault refs, sizes) |
| `rejected: unsigned` / `bad_signature` | the worker has trusted master keys (pinned `masterLeaseKeys`, else the session's lease keys) and the signature does not verify against them |
| `applied` | otherwise: persisted to `<dataDir>/worker-config.json` (0600, atomic), effective config recomputed, subscribers notified |

With no trusted keys at all (a master without lease keys) an unsigned document is accepted with a warning;
pinning `masterLeaseKeys` makes signatures mandatory, which also protects against a TLS-terminating proxy.

**Effective configuration = panel ∩ local ceiling** (`effective.ts`, pure): projects outside the ceiling, or
whose every repository is outside `localCeiling.projects[p]` / `repoHosts`, are blocked; runtimes, sandbox
profiles are intersected; parallelism is the minimum; locally pinned auth/settings win; `minFreeBytes` has the
local floor. Values the worker cannot use (a project id with `:` cannot be a workspace path segment, a URL
`parseRepoUrl` refuses) are blocked `invalid_value`. Every removal is a `ConfigBlock {path, code, detail}`.
Before the first panel generation the effective configuration is exactly the legacy local values
(`source: local`) — nothing existing changes on upgrade.

**Hot reload, no restart:** state-machine limit (`setLimits`), workspace allowlist and options
(`WorkspaceManager.reconfigure`), runtime registry (`RuntimeRegistry.reconfigure`: enabled runtimes, auth,
merged settings — OpenHands LLM base URL/settings and `maxIterations` now reach the adapter), runtime gate (auth
read live; the per-runtime default model profile is used only when the runtime policy allows it for the job's
project), job runner (auth and allowed sandbox profiles read per job), CAPABILITIES (effective
`maxParallelJobs`, `projects`, ready ∩ allowed `sandboxProfiles`, `worker-config-v1`, the report). The daemon
answers WORKER_CONFIG_STATUS and re-sends CAPABILITIES when the effective configuration changed. None of the v1
fields needs a restart; a future one that does will drain and exit for the service manager.

### 5. Local ceiling and legacy migration

`localCeiling` (optional): `projects`, `repoHosts`, `allowedRuntimes`, `maxParallelJobs`, `sandboxProfiles`.
Legacy keys detected in the **raw** JSON (not the defaulted parse): non-empty `workspace.projects` → projects
ceiling (intersected with `localCeiling.projects`), non-empty `allowedRuntimes` → runtime ceiling (explicit `[]`
is "not set"), written `maxParallelJobs` → parallelism ceiling, `runtimeAuth.<kind>` → auth pinned,
`runtimes.<kind>.model|provider|config` → settings pinned, `workspace.minFreeBytes` → floor,
`workspace.retainFailed|submodules` → pinned. The ceiling and pins are reported (`LocalCeilingReport`), so the
panel shows why a desired value is not in effect.

### 6. Placement

`Orchestrator.candidates` joins the desired spec and the stored report; a worker with a panel configuration gets
`PlacementWorker.managed` and the legacy `allowedProjects` / `localProjects` checks are skipped for it. Reasons:

| Code | Permanent | When |
| --- | --- | --- |
| `project_not_assigned` | yes | the desired spec does not include the job's project |
| `repo_not_registered` | yes | the job's repository is not the project's registered repository (`sameRepository`) |
| `runtime_not_enabled` | yes | the runtime is not in the desired spec |
| `config_not_applied` | no / yes | waiting for the worker to apply the desired generation / it refused it, or its build cannot apply panel configuration |
| `blocked_by_local_ceiling` | yes | applied, but the report shows the project/runtime blocked (message carries the worker's detail) |

Dispatch and the composer preview use the same facts; the worker still re-checks everything (allowlist,
runtime gate, sandbox selection) and declines with its own typed reason.

### 7. API and authorization

| Route | Action | Notes |
| --- | --- | --- |
| `GET /workers/:id/config` | `workers.config.read` (admin) | desired, delivered, report, status, drift, takeover prefill, project options |
| `GET /workers/:id/config/history` | `workers.config.read` | newest first, 200 |
| `PUT /workers/:id/config` | `workers.config.write` (admin, step-up, CSRF) | `{spec, expectedGeneration, changeNote?, adopt?}`; 400 `worker_config_invalid` with issues; 409 `version_conflict` / `worker_not_enrolled` |
| `POST /workers/:id/config/rollback` | `workers.config.write` | `{toGeneration, expectedGeneration, reason?}` |
| `POST /workers/config/bulk` | `workers.config.write` | `{workerIds ≤ 100, patch, changeNote?}`, all or nothing |
| `GET /projects/:id/workers` | `projects.workers.read` (project viewer+) | assigned / effective / blocked per worker |
| `PUT /projects/:id/workers` | `projects.workers.write` (project admin, step-up) | complete set; 409 `repo_not_registered` when adding without a registered repository |

Reads are admin-only for worker configurations because a configuration lists project ids a viewer may not be a
member of; the project-side read is scoped to that project.

## Security review

- **Widened blast radius of a panel compromise (accepted, ADR-0015):** an attacker with an admin session *and*
  step-up can assign any registered project to any worker, enable runtimes and raise parallelism. Mitigations:
  registered repositories only; admin + step-up + CSRF; audit per generation; admin notification per change and
  per rejection; signed generations bound to worker + generation; worker re-validation; drift display; local
  ceiling for pinned machines; rollback.
- **No executable choice from the panel:** binaries, container executables and Pi extension files stay local;
  OpenCode options and OpenHands LLM options are validated non-credential data (`{env:NAME}` for credential-like
  keys). The sandbox profile selection, untrusted-source rules (ADR-0010) and host-execution opt-in still run on
  the worker for every job; the panel can only *narrow* the profiles.
- **No secret values anywhere in the configuration path** (ADR-0006): refs only; `CLAUDE_CODE_OAUTH_TOKEN` is
  refused as an injection target (ADR-0014); every string leaf and change note is secret-scanned on the master;
  audit metadata carries auth *modes*, not secret names' values.
- **Replay / downgrade:** generations are monotonic on the worker (`stale`), same-generation hash changes are
  refused, signatures bind worker id and generation; the master never re-sends a refused generation.
- **Old workers:** feature-gated; an old build is never sent the message (shown *unsupported*), so its outbox
  and sequence are untouched.
- **Data at rest on the worker:** `worker-config.json` 0600 in the private data dir; a corrupt or hash-mismatched
  file is ignored (local values apply) and the master re-delivers.

## Rollback

- **A bad configuration:** Fleet → worker → Configuration → History → *Roll back* (or
  `POST /workers/:id/config/rollback`); bulk mistakes are undone per worker the same way.
- **Turn panel management off for a machine:** set a `localCeiling` (or legacy keys) in its local file and
  restart — the ceiling wins over any panel value. Deleting `<dataDir>/worker-config.json` makes the worker fall
  back to its local values until the master re-delivers (it will, on the next session, while a desired
  generation exists).
- **Release rollback:** migration 0028 is additive (new tables, two nullable columns, two widened CHECK
  constraints). An older master ignores the tables; older workers never received anything. Rolling the worker
  back to a build without `worker-config-v1` returns it to local-file behaviour (status *unsupported*).

## Operational metrics

Per worker the panel shows desired vs applied generation, delivered time, status and drift; the audit log has
`worker.config.update` / `worker.config.rejected`; master logs `worker configuration sent` / `worker configuration
status`; placement reasons (`config_not_applied`, `blocked_by_local_ceiling`, …) appear in job scheduling status
and the composer preview.

## Tests

- `packages/protocol/test/worker-config.test.ts` — schema (no free-form repo credentials, refs only, no OAuth
  env), canonical hash, consistency rules, signature binding, message parsing and stripping.
- `packages/scheduler/test/placement.test.ts` — managed reasons and verdicts.
- `apps/master/test/integration/worker-config.test.ts` (raw protocol worker) — RBAC/step-up, validation issues,
  adopt + signed delivery + audit + notification, optimistic conflicts, applied status, placement, project-side
  assignment, repository re-resolution, rejection without re-send loop, rollback, ceiling drift, bulk
  all-or-nothing, re-send on reconnect.
- `apps/master/test/integration/worker-config-e2e.test.ts` — the real worker manager against the master:
  signature verified with session keys and applied live; local ceiling blocks reported and explained by
  placement; pinned foreign keys ⇒ rejected and shown.
- `apps/worker/test/config-ceiling.test.ts`, `managed-config.test.ts`, `managed-config-live.test.ts` — ceiling
  derivation and legacy meaning, effective intersection, every rejection reason, persistence, hot reload of job
  admission without restart.
- RBAC matrix and route coverage include the new routes and actions; web component tests cover the
  Configuration tab, bulk change, project Repository/Workers sections and reason labels.
