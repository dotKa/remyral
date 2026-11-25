# Design note: P4 orchestration — leases, dispatch, scheduler, recovery

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** `p4-leases`, `p4-dispatch`, `p4-scheduler`, `p4-recovery`, plus the integration glue that connects
  p4-approvals, p6-cost and p6-context-model over the worker transport, and the p3-sandbox wiring into the
  worker's job path.
- **Decisions applied:** ADR-0003 (Postgres is the source of truth; transactional outbox → BullMQ hints;
  reconciliation loop), ADR-0004 (signed leases, fencing epochs, idempotency, renewal, LOST → reconciliation,
  retry only when verified safe), ADR-0006 (secrets by reference, short-lived git tokens), ADR-0007/0010 (sandbox
  profiles, untrusted sources), ADR-0008/0012 (truthful runtime capabilities, version pins), ADR-0011 (additive
  protocol changes within 1.0).
- **Builds on:** [p4-job-store.md](p4-job-store.md), [p4-job-state-machine.md](p4-job-state-machine.md),
  [p2-transport.md](p2-transport.md) (sequenced messages, ACK, replay), [p4-approvals.md](p4-approvals.md) §5,
  [p6-cost.md](p6-cost.md), [p6-context-model.md](p6-context-model.md),
  [p3-workspace-and-secrets.md](p3-workspace-and-secrets.md), [p3-sandbox.md](p3-sandbox.md).
- **Threat model:** T-OPS-1, T-WRK-2, T-WRK-4 (security review §10), also T-OPS-3, T-SEC-1, T-SBX-4.

## 1. Shape

```
packages/protocol
  lease.ts                 signed lease tokens (Ed25519), LeaseKey, verifyLeaseToken
  master-messages.ts       + SESSION_ESTABLISHED.leaseKeys, JobSpec.{projectId, secretRefs, sourceTrust,
                           requirements}, ASSIGN_JOB.{context, execution}, JOB_CREDENTIAL
  worker-messages.ts       + CREDENTIAL_REQUEST, CAPABILITIES.projects, AgentEvent{kind:'memory'}
packages/scheduler
  placement.ts             pure eligibility filters, scoring, waiting/infeasible verdicts with reasons
packages/agent-adapters
  contract.ts              + SpawnContext.confiner (p3-sandbox ProcessConfiner, set by the worker)

apps/master/src/orchestration
  lease-signer.ts          Ed25519 key from LEASE_SIGNING_KEY_FILE (ephemeral in dev/test)
  messages.ts              ASSIGN_JOB / RENEW_LEASE payloads (signed lease, project from the job record)
  inbox.ts                 InboxSink: fencing + routing of sequenced worker messages into the job store
  session.ts               fleet session handler + CREDENTIAL_REQUEST + running-jobs reports
  orchestrator.ts          dispatch (placement + lease + ASSIGN_JOB), cancel, reconciliation loop
  relay.ts                 outbox relay → BullMQ hints (bullmq 6.3.11) / APPROVAL_DECISION
  remote-branch.ts         `git ls-remote` inspector for lost attempts
  effects.ts               glue: usage, approvals, agent memory, context bundles
  routes.ts                POST /jobs, POST /jobs/:id/cancel
apps/master/migrations     0011_orchestration.sql, 0012_scheduling.sql

apps/worker/src/jobs
  keyring.ts               trusted lease keys (session-announced, optionally pinned)
  runner.ts                JobRunner: lease verify/ack/renew/self-fence, workspace, env, sandbox, adapter
  from-config.ts           production wiring (workspace manager, sandbox runners, secret store, adapters)
```

## 2. Leases (p4-leases)

**Token.** `rlt1.<base64url(claims)>.<base64url(sig)>`, claims `{v, kid, jobId, attemptId, workerId, epoch,
iat, exp}` (master clock), Ed25519 over `"remana-lease/v1\n" + claimsSegment` — the exact transmitted bytes,
and a domain prefix distinct from AUTH and rotation statements (tested: an AUTH-context signature over the
same bytes is refused). The master's `leases` row stays the source of truth; the token makes the lease
verifiable and tamper-evident on the worker (stored leases, ASSIGN/RENEW integrity) and for later
master-mediated operations (p4-git-flow) without a database round trip.

**Key.** `LEASE_SIGNING_KEY_FILE` (PKCS#8 PEM, refused if group/other-readable, never logged; required in
production — config fails fast). Development/tests without it use an ephemeral per-process key (warning on
stderr). `pnpm dev:keygen` now also writes `infra/dev/secrets/lease-signing.pem` and adds the variable to an
existing `.env`. `kid` = first 16 base64url chars of SHA-256 of the raw public key.

**Public key delivery — decision: announced in every `SESSION_ESTABLISHED` (`leaseKeys`), optional pin in
the worker config (`masterLeaseKeys`).** Rationale: the session is already authenticated in both directions
(TLS 1.3 with WebPKI for the master, Ed25519 challenge-response for the device), so a key announced there is
exactly as trustworthy as every other master message on that session — including CANCEL_JOB, which needs no
signature to be harmful. Announcing keys per session lets the master rotate its signing key (announce the
next key alongside, then switch) without touching seven machines. Fleets that want an independent trust
root pin the keys; then the session's keys are ignored (and unpinned announcements are logged as warnings).
Keys live in memory only; after a restart the next session delivers them before any lease is processed
(the daemon handles SESSION_ESTABLISHED before replayed ASSIGN_JOBs, in order).

**Flow.** `acquireLease` (job store, epoch + 1) → `ASSIGN_JOB {attemptId, lease{epoch, token, expiresAt},
spec(+projectId from the job record), context?, execution{hostExecutionOptIn}}` queued durably in
`worker_outbox` (p2-replay) → worker verifies signature + `(jobId, attemptId, workerId, epoch, expiresAt)`,
runs preflight (project, adapter, repository allowlist, env plan, sandbox profile, capacity), persists the
lease in its store and sends `LEASE_ACK{accepted:true}`; refusals are `LEASE_ACK{accepted:false, reason}` →
`lease_declined` (RESERVED → QUEUED; the scheduler will not ask that worker again).

**Renewal.** The worker re-sends `LEASE_ACK{accepted:true}` every third of the token lifetime (local timer
from `exp − iat`, so master/worker clock skew does not matter). Each one renews the lease (`renewLeaseWithin`)
and queues `RENEW_LEASE` with a fresh token in the same transaction. **Self-fencing:** without a confirmed
renewal for `lifetime + selfFenceGrace` (default one lifetime) the worker stops the attempt and reports
nothing — it no longer holds the lease. (p11-master-resilience / ADR-0039: with an offline grace granted in the lease,
a worker that cannot reach the master at all keeps running until `ack send time + lifetime + grace`, and the master
holds such a lease that long plus one lifetime; see [p11-master-resilience.md](p11-master-resilience.md).)

**Fencing of every worker → master job message** (`OrchestrationInbox`, inside the replay transaction that
advances the worker's cursor, so each message takes effect exactly once): the message's `(attemptId, epoch)`
is classified against the job's leases — `live` (current, unreleased, unexpired lease of this worker),
`closed` (same lease, closed by a transition: late log tail), `lost` (same lease, expired), or `stale`
(unknown lease, other holder, other attempt, superseded epoch). State changes require `live`; data-only
messages (EVENT, LOG_CHUNK, ARTIFACT_REF) are accepted for `live`/`closed`; a JOB_RESULT under a `lost` lease
is recorded in `job_runs` (`result_late`) as reconciliation input without changing state. Everything else is
**`stale`: journaled with `outcome = stale`, never applied, audited (`job.message` denied, `denial:
stale_epoch`) and answered with `ERROR stale_epoch` (`inReplyTo` = the message id).** Routing runs in a
savepoint, so a refused message still advances the cursor (no replay loop); version conflicts with a
concurrent writer are retried up to three times.

**Message → transition table.** `LEASE_ACK accepted` RESERVED → STARTING (`lease_acked`), later acks renew;
`LEASE_ACK declined` → `lease_declined`; `EVENT status running` STARTING → RUNNING (`runtime_started`);
`JOB_RESULT` succeeded RUNNING → VERIFYING (`run_finished`, worker) → SUCCEEDED
(`verification_passed_no_approval`, system `verifier`), failed → `attempt_failed`, any result while
CANCELLING → `cancel_confirmed`. Status phases are recorded in `job_runs.last_phase`.

**Git credentials (T-WRK-4) — decision: a separate control message, never a field of ASSIGN_JOB.**
ASSIGN_JOB is a sequenced message and therefore persisted in `worker_outbox` until acknowledged (and
replayed); a token there would be a credential at rest in the database. Instead the worker sends
`CREDENTIAL_REQUEST{attemptId, epoch, requestId, kind:'git'}` (control, seq 0) right before preparing the
workspace; the master answers `JOB_CREDENTIAL` (control, seq 0, also not persisted) only for the caller's
live lease, with a token from the `GitCredentialProvider` port (p4-git-flow plugs in GitHub App installation
tokens; default: none → `unavailable`). The token exists on the master only in memory while it is sent; the
audit log records the issuance (status, expiry), never the value. On the worker it is registered for
exact-value redaction and passed to git only through the scoped credential helper (p3-workspace). A test
proves the canary token appears in no table (worker/master outboxes, inbox, audit), no master log and no
worker log, while the worker did receive it.

## 3. Dispatch (p4-dispatch)

- **Outbox relay** (`OutboxRelay.relayOnce`, `FOR UPDATE SKIP LOCKED`): `job.transition` rows into QUEUED or
  CANCELLING become BullMQ hints `{jobId, version}` (job id `<jobId>.<version>` deduplicates relays); rows
  into other states are marked dispatched without a hint. `approval.decision` rows become a durable
  `APPROVAL_DECISION` in the addressed worker's outbox in the same transaction (exactly once). Other topics
  (`usage.budget.threshold`) are left for their consumers. A hint publish that does not finish in 2 s
  (Redis down) rolls the claim back; rows stay pending.
- **BullMQ** `bullmq@6.3.11` (pinned; 6.3.13 was inside the workspace's minimum-release-age window). Its
  consumer calls `Orchestrator.onHint`, which re-reads Postgres: QUEUED → `dispatch`, CANCELLING → re-send
  CANCEL_JOB. Hints are worthless once acted on (`removeOnComplete`). Separate ioredis connections with
  `maxRetriesPerRequest: null` (BullMQ requirement); the master's own Redis client is unchanged.
- **Reconciliation loop** (`tick()`, every 2 s; tests drive it): lease-expiry sweep → LOST decisions →
  CANCELLING without lease → RETRY_WAIT promotion → dispatch of every QUEUED job (priority, age) → retry of
  lost effects. Because the loop dispatches from Postgres, **Redis loss only delays work** (tested with
  FLUSHDB between submit, cancel and dispatch).
- **Dispatch** is serialised by a Postgres advisory lock (`remyral:dispatch`), so concurrent hints/ticks never
  both count the same free slot (found by the two-worker test); `acquireLease`'s version check stays the
  per-job backstop. After the lease: `job_runs` row (attempt, worker, context hash), ASSIGN_JOB enqueued.
  A crash between lease and enqueue leaves RESERVED without ASSIGN → no LEASE_ACK → lease expiry → LOST →
  reconciliation (never started ⇒ safe retry).
- **Duplicate deliveries:** duplicate hints / dispatch calls see a non-QUEUED job and do nothing; a duplicate
  ASSIGN_JOB (another seq) for an attempt the worker runs is re-acknowledged, not re-run; an ASSIGN for an
  attempt that already ran on this daemon is ignored; master duplicates by seq are already dropped by
  p2-replay.

**Worker execution** (`JobRunner`, wired by `jobs/from-config.ts`; runner integration 2026-10-13):

1. **ASSIGN_JOB admission** (before `LEASE_ACK`): lease token verified → preflight (project, repository
   allowlist, env plan) → **runtime admission** (`jobs/runtime-gate.ts`): the registry offers the runtime
   (`runtime_not_enabled` / `runtime_not_available_in_build` / `runtime_binary_missing`), then
   `checkRuntimeForJob` (applied runtime policy: runtime allowed, installed version = policy or compiled pin
   unless `allowUnpinned`, auth mode, model profile), then the adapter's capability set for (runtime,
   version, OS, arch): `streaming`, `cancel` and — unless `approvalPolicy: deny-sensitive` — `approval` must
   be `supported`/`degraded`; `unverified` only with the policy rule's new `allowUnverified` (or
   `allowUnpinned` on a mismatching version), `unsupported` never. The refusal names exactly what to change
   (`capability_unverified: … set "allowUnverified": true in its "pi" rule … PUT /runtime-policies/<name>`).
   → **`selectProfile`** (`sourceTrust` absent ⇒ `untrusted` ⇒ `container`; project `hostExecutionOptIn`).
   Every refusal is a typed `LEASE_ACK{accepted:false}` ⇒ `lease_declined`; the scheduler then prefers
   another worker or fails the job `infeasible` with the reasons. *Deviation from the brief (JOB_RESULT
   failed):* a refusal before the lease is accepted burns no attempt and lets another worker that can run
   the job take it; the job still ends FAILED with the actionable reason when no worker can.
2. **Run:** credential request → `WorkspaceManager.prepare` (worktree on `rac/<jobId>/<attemptId>`) →
   trusted-git snapshot → per-attempt git view → the adapter's **per-attempt state dir**
   `<root>/sandboxes/<job>/<attempt>/runtime` (transcripts, Pi gate extension, Codex/Claude/OpenCode config
   dirs — never shared between attempts, writable under every profile, removed with the sandbox dir) →
   `resolveJobEnv` (secret refs or `local-login` context; exact-value redaction lease) → selected runner's
   `confiner` (container: same-path bind mounts of the state dir rw and operator extension files ro, the
   image's runtime binary via `containerCommand`; host: loopback listening only for OpenCode/OpenHands) →
   a **fresh adapter per attempt** from the registry (`runtimes/registry.ts`: real factories of
   `@remyral/agent-adapters` for Claude Code, Codex, Pi, OpenCode with binary from config/probe, auth mode,
   `confiner = ctx.confiner`, the job's non-secret env; OpenHands registered as not available in this build
   with a one-line hook for `createOpenHandsAdapter`; the fake adapter only with `devFakeRuntime`, which
   the config accepts only with a loopback `ws://` master) → `spawn` (`allowUnverified` from the admission,
   model from the policy profile) → `sendPrompt` (context bundle + prompt) → EVENTs (`redactDeep`) and
   runtime LOG_CHUNKs (stream redactor) → `collectResult`.
3. **Publish (p4-git-flow, [p4-git-flow.md](p4-git-flow.md) §3):** `assertTrustedGitUnchanged` (tamper ⇒
   failed) → only when `ASSIGN_JOB.execution.pushResult` is set (projects enrolled in git flow) and the run
   succeeded: `publishAttempt` (worker commit with the `Remyral-Attempt: <attemptId>/<live epoch>` trailer,
   pre-push secret scan, push with force-with-lease) → additionally `ARTIFACT_REF` `attempt.diff`
   (sha256/size of `git diff base..pushed`, `jobs/finalize.ts`) → `JOB_RESULT.commits` = the claim the master
   verifies on the remote (VERIFYING). Without the flag nothing is pushed.
4. **Control:** CANCEL_JOB calls `adapter.cancel(ref, reason)` (native interrupt → grace → tree kill) and
   aborts the signal as backstop; APPROVAL_DECISION → `adapter.requestApproval` (epoch-fenced);
   `maxDurationSec` timer ⇒ failed `max_duration_exceeded`; cleanup, workspace release, secret lease
   release, lease removal as before.

**CAPABILITIES** (`probe/capabilities.ts`, sent by the daemon): runtimes from the CLI probe with each
adapter's own `probe()` overlaid (capability set from its contract-tested matrix, `authenticated` from the
runtime's own status command; runtimes this worker cannot run are reported with every capability
`unsupported` and the typed reason); `sandboxProfiles` = the profiles whose **runner self-check** passes,
plus additive `sandboxReadiness[{profile, ready, runtimes?, reason?}]` (container: engine/rootless/image per
runtime; host-restricted: verified worker user + Seatbelt; runtime-sandbox: a real
`bwrap --unshare-user --ro-bind / / true` on Linux — fixes the probe claiming `runtime-sandbox` where bwrap
cannot create namespaces, handson 2026-10-13 finding 2; the CLI probe applies the same check); and
`projects` from the local allowlist. Before this change production workers reported no ready profile and
no projects, so the scheduler could never place a job on them.

**Shared changes (additive, protocol 1.0):** `RuntimePolicyRule.allowUnverified?`,
`CAPABILITIES.sandboxReadiness?`; `SandboxContext.runtimeMounts?/containerCommand?` (container runner),
`HostRunnerOptions.listenRuntimes`, `createSandboxRunners({namespaces?})`; worker config `runtimes.<kind>`
(`binary`, `containerBinary`, `model`, `provider`, Pi `extensions`, OpenCode `config` without literal
credentials). Owner-facing setup: [docs/ops/runtime-setup.md](../ops/runtime-setup.md).

## 4. Scheduler (p4-scheduler)

`@remyral/scheduler` `place(job, workers)` — pure, deterministic, unit-tested per filter.

**Eligibility filters** (every exclusion has a code, an actionable message and `permanent`):
`not_enrolled`/`quarantined` (never candidates), `offline`, `updating`, `draining`, `capabilities_unknown`
(transient), `runtime_not_installed`, `runtime_version_mismatch` (JobSpec.runtimeVersion), `runtime_version_unverified`
(pin status ≠ match, ADR-0012), `runtime_not_authenticated` (`authenticated = no`), `os_mismatch` /
`arch_mismatch` (JobSpec.requirements), `project_not_allowed` (master worker policy `workers.allowed_projects`),
`project_not_in_worker_allowlist` (CAPABILITIES.projects, the worker's `workspace.projects`),
`sandbox_profile_unavailable`, `secret_bound_to_other_worker` (a `worker:<id>/secret:` reference pins the job
to that worker — secrets never cross workers), `declined_before`, `no_free_slot` (master's count of
unreleased leases vs `maxParallelJobs`; permanent only when capacity is 0).

**Scoring:** 0.5·free capacity + 0.3·reliability (Laplace-smoothed success ratio of the last 50 ended
attempts, lost leases count as failures) + 0.2·project affinity (recent attempts of the project: warm mirror)
− 0.3 if this worker already failed/lost this job. Ties by worker id.

**Verdicts:** `placed`; `waiting` (some worker could run it later, or the fleet is empty); `infeasible` only
when at least one candidate exists and every candidate has a permanent reason — then the job fails with the
`infeasible` trigger and a reason listing codes, workers and messages. The latest verdict is stored in
`job_schedule_status` (`placed | waiting | infeasible`, reasons, worker, time) and returned by
`GET /jobs/:id` as `orchestration.schedule`, together with `orchestration.runs` (per attempt: last phase,
context bundle hash, reported result, late flag, last recovery decision).

## 5. Recovery (p4-recovery)

- **Lease-expiry sweep:** `findExpiredLeases` → `lease_expired` (→ LOST, attempt `lost`, lease closed with
  reason `expired`); recorded in `job_runs.recovery`.
- **Decisions for LOST jobs** (ADR-0004 §2/§5), in order:
  1. a cancel was requested before the loss → `cancel_requested` → CANCELLING → confirmed by the reconciler
     once no worker runs the attempt (`reconcileCancelling`);
  2. a result arrived under the lost lease (`result_late`) → succeeded: `reconcile_finished` +
     verification; failed/cancelled: `reconcile_fail`;
  3. the worker is connected and its HEARTBEAT lists the attempt → `reconcile_resume` (same attempt, epoch + 1)
     and RENEW_LEASE with the new token; the worker adopts the higher epoch for the same attempt, old-epoch
     writes are refused from then on (tested);
  4. otherwise — after `reconnectGraceMs` (default 2 × lease TTL ≥ the worker's self-fence) or at once if the
     connected worker reports it does not run the attempt — a durable CANCEL_JOB for the old epoch is queued
     (stops a zombie that comes back) and: attempts exhausted → `reconcile_fail`; the runtime never started
     (no `runtime_started` for the attempt) → `reconcile_retry` (safe: nothing ran); else the attempt branch
     `rac/<job>/<attempt>` is inspected on the remote — `absent` → `reconcile_retry` (the only external side
     effect is that push), `present` or `unknown` → `reconcile_fail` "needs human review" (no blind rerun).
- **Retry:** RETRY_WAIT → `retry_due` after `retryBackoffMs`; the scheduler prefers another worker.
- **Remote inspection** (`GitLsRemoteInspector`): `git ls-remote --heads` only — no clone or checkout on the
  control plane (AGENTS.md rule 1); no system/global config, no prompts, https/ssh only, batch ssh with strict
  host keys, 15 s timeout, 64 KiB output. Without credentials a private repository answers `unknown` →
  fail closed (p4-git-flow adds a token).
- **Worker restart:** leases restored from disk have no process; the worker drops them at the next session and
  does not report them as running, so the master decides as in 4.
- **Cancellation end to end:** `POST /jobs/:id/cancel` → `cancel_requested` (immediate CANCELLED where no worker
  acts, else CANCELLING + durable CANCEL_JOB) → worker aborts the adapter (native cancel, then the adapter's
  tree kill) → JOB_RESULT cancelled → `cancel_confirmed` by the worker; a CANCEL_JOB for an attempt not running
  on the worker is answered with JOB_RESULT cancelled so the master can confirm.

## 6. Data model (migrations 0011, 0012)

| Object | Purpose |
| --- | --- |
| `worker_inbox` + `outcome`, `outcome_reason`, `effect`, `effect_status` (`pending/running/done/failed`), `effect_attempts`, `effect_claimed_at`, `effect_error` | Routing outcome per journaled message; post-commit effects with claim-based retry |
| `job_runs` (per attempt) | last phase, context bundle hash, reported result (+ late flag), last recovery decision |
| `job_schedule_status` (per job) | latest scheduler verdict and reasons |
| `workers.allowed_projects`, `workers.local_projects` | master project policy (NULL = unrestricted), reported local allowlist |
| `projects.host_execution` | project opt-in for host-native profiles (default false) |

Both migrations only add objects/columns; rollback = revert the code with a database restored from before them
(forward-only runner).

## 7. REST

| Route | Authorization (p5-rbac `config.authz`) | Notes |
| --- | --- | --- |
| `POST /jobs` `{project, spec, priority?}` | `jobs.create` on the body's project (operator+ member; owner/admin) | spec validated against the protocol JobSpec (paths/codes only in errors); `spec.projectId` must equal `project`; 201 `{job}`; dispatched at once (and by the hint) |
| `POST /jobs/:id/cancel` `{reason}` | `jobs.cancel` on the job's project | 200 `{job}` (CANCELLED or CANCELLING); 409 when not cancellable |

No step-up: the sensitive actions of a job are gated by approvals at run time. Both routes are in the
route-coverage list and the authorization matrix (denials audited as `job.create` / `job.cancel`).

## 8. Integration glue

- **Approvals** (`p4-approvals.md` §5): `EVENT{approval_request}` → `ApprovalService.evaluate` (in-run,
  fenced by attempt/epoch/lease holder, idempotent per approvalId) → `allow`/`deny` answered at once with
  APPROVAL_DECISION (`decidedBy: policy`), `pending` → the job stays RUNNING while the runtime reports
  `waiting_approval`; a human decides through `/approvals/:id/approve|deny` (role + step-up from the rule) →
  `approval.decision` outbox row → relay → APPROVAL_DECISION → adapter `requestApproval`. Refusals (stale
  epoch, job moved on) are answered `deny` by `system` so the runtime never hangs; the fake adapter also denies
  on its own timeout (fail closed). The worker drops decisions for other epochs.
- **Usage:** `EVENT{usage}` → `UsageStore.recordUsage(event, {jobId, attemptId, workerId, sourceEventId:
  messageId})` — idempotent; also accepted from a stale attempt (the tokens were spent; the store checks the
  worker ran the attempt).
- **Context:** `ContextStore.issueForJob(jobId, {worker})` at dispatch (pinned per job, delivery recorded and
  audited) → `renderBundle` → ASSIGN_JOB `context{bundleHash, rendered}` (≤ 192 KiB) → hash in
  `job_runs.context_bundle_hash`; the worker prepends the fenced bundle to the prompt. An unavailable pinned
  bundle makes the job infeasible.
- **Agent memory:** new additive `AgentEvent{kind:'memory', title, content}` → `ContextStore.recordAgentMemory`
  (live lease only; project memory with agent provenance; secret scan by the store). Not idempotent in the
  store, so the effect checks for an identical memory of the attempt first.
- Effects run after the inbox transaction commits; a crash in between leaves `effect_status = pending`, which
  the loop retries (claim pending → running prevents concurrent double application; claims older than 60 s are
  retaken). Rejections by the target service are final and audited there.

## 9. Tests

- `packages/protocol/test/lease.test.ts` (6): token round trip and field binding, unknown key / wrong key /
  tampered claims / malformed, AUTH-domain separation, expiry only with a master clock, JobSpec/new messages.
- `packages/scheduler/test/placement.test.ts` (19): every filter with its permanence, os/arch/version/declined/
  secret-bound, scoring order and retry penalty, determinism, waiting vs infeasible, empty fleet.
- `apps/master/test/unit/lease-signer.test.ts` (3), `config.test.ts` (+1).
- `apps/worker/test/job-runner.test.ts` (8, real worktrees from a local bare repo): verified run end to end
  (worker commit with trailer pushed to the bare repo, ARTIFACT_REF before JOB_RESULT);
  forged/foreign/mismatched tokens declined; pinned keyring ignores session keys; declines without project,
  adapter, allowlisted repository or sandbox; duplicate ASSIGN not re-run, RENEW_LEASE moves the epoch,
  old-epoch approval decisions dropped; cancel and cancel-not-running; self-fencing reports nothing; restored
  leases dropped.
- `apps/master/test/integration/orchestration.test.ts` (14; real master with Postgres + BullMQ on Redis, real
  worker daemons over the WebSocket transport, real workspace manager, fake runtime): submit → SUCCEEDED with
  full transition history and fenced worker transitions; two concurrent jobs on two workers; cancel mid-run;
  duplicate ASSIGN + duplicate hints/dispatches → one execution; stale epoch → `stale` + audit + ERROR; Redis
  FLUSHDB mid-flight; waiting reasons and infeasible failure with reasons in `GET /jobs/:id`; worker killed →
  lease expiry → LOST → grace → branch absent → retry on another worker; branch present → FAILED needs human;
  partition → reconnect → resume under epoch 2 and epoch 1 refused; usage + context bundle + agent memory;
  approval round trip with step-up (approve) and deny; git credential never persisted or logged.
- Route coverage and RBAC matrix include the two new routes.
- `apps/worker/test/runtime-runner.test.ts` (12): registry typed refusals (not enabled, OpenHands not in this
  build, binary missing), per-attempt instances, real factories wired to `ctx.confiner`, fake only with the
  flag; gate (pin, policy, auth, profile → model, `capability_unverified` message with the exact remedy,
  `allowUnverified`/`allowUnpinned`, `capability_unsupported`); sandbox readiness and capability overlay;
  bwrap namespace check in runner and probe. `sandbox-container.test.ts` (+1): same-path runtime mounts,
  image command, refusal of writable mounts outside the attempt. `config.test.ts` (+1).
- `apps/master/test/integration/runtime-e2e.test.ts` (6, opt-in `REMYRAL_PI_BIN` / `REMYRAL_OPENCODE_BIN`,
  real master + WebSocket + production job wiring, scripted providers): Pi 1.1.0 under **real Seatbelt**
  (macOS) — repository edit with an approval round trip (approve via REST + step-up) → commit with trailer
  pushed to a local bare repo → SUCCEEDED; plain run → trailer commit; cancel mid-run → CANCELLED, nothing
  pushed; Pi in the pinned `remyral/runtime-pi:0.1.0` **container** (Docker Desktop) with the approval round
  trip; OpenCode 1.19.0 (unconfined: its scripted provider is on loopback) edit + approval and cancel.

## 10. Security review

| Threat | Mitigation | Residual / follow-up |
| --- | --- | --- |
| **T-OPS-1** duplicate side effects after reconnect/crash | Fencing epoch checked on every worker → master job message inside the exactly-once replay transaction; stale writes refused, audited, answered; LEASE_ACK renewal only for the live lease; LOST never reruns directly — retry only when the runtime never started or the attempt branch is verified absent, otherwise FAILED for a human; durable CANCEL_JOB to the abandoned attempt; worker self-fences after missed renewals and reports nothing; duplicate ASSIGN/hints never re-run; dispatch serialised by an advisory lock; context, usage and approval effects idempotent; resume issues a new epoch so the old one is dead. | A zombie worker that stays partitioned longer than its self-fence keeps nothing but a local process that stops; external side effects other than the attempt branch (e.g. a runtime calling an API) are not inspectable — they belong behind approvals (`network.egress_non_allowlisted`, sandbox egress allowlist). Clock skew between master replicas affects expiry by the skew (single replica today). |
| **T-WRK-2** compromised worker reports fake results / success | All worker claims are bound to its authenticated session and live lease; capabilities only influence placement; capacity is the master's own lease count; JOB_RESULT is stored as an untrusted report (`job_runs.result`) and `commits` are not claimed by the worker yet; a worker cannot write another worker's job or attempt (fencing, usage attribution check). | Verification today accepts the worker's success claim (`verification_passed_no_approval` by `verifier`). Independent verification (commit on the remote with the attempt trailer, CI, second-worker review) is p4-git-flow / p4-dag. |
| **T-WRK-4** worker abuses tokens beyond its job | Git tokens only via non-durable JOB_CREDENTIAL for the caller's live lease (refused + audited otherwise), never persisted on the master, never in ASSIGN_JOB/outboxes/logs (canary test), exact-value redacted on the worker and given to git only through the per-origin credential helper; secret references naming a worker pin the job to that worker; projects outside the master policy or the worker's allowlist are never assigned; the worker re-checks the allowlist. | Token scope/lifetime is the provider's (GitHub App installation token per repository, p4-git-flow); the default provider issues none. |
| T-OPS-3 tampering / repudiation | Every routing outcome is journaled; transitions, refusals, credential issuance, decisions are in the hash-chained audit log in the same transaction. | — |
| T-SEC-1 secrets in stored/transmitted data | Lease key file permission-checked and never logged; tokens and job secrets never in messages that are persisted; worker output redacted before the outbox. | Master-side pattern redaction of LOG_CHUNK is p7. |
| T-SBX-4 cross-attempt tampering | Trusted-git snapshot before and tamper check after every run; per-attempt git view + confiner when sandbox runners exist. | Commit/push wiring that consumes the check is p4-git-flow. |
| Lease forgery / replay | Ed25519 with domain separation, binding of job/attempt/worker/epoch/expiry; tokens verified against session or pinned keys; a token for another worker, epoch or attempt is refused. | Session-announced keys are only as strong as the session (decision §2); pin for an independent trust root. |
| DoS | Inbox work is per message in one bounded transaction; relay batches of 200; dispatch lock held only for one placement. | Placement loads all enrolled workers per dispatch (fine for tens of workers; cache in p7-load). |

## 11. Rollback and operations

Rollback: revert the commits and restore the database from before 0011/0012 (forward-only runner), or keep
the schema (additive) and roll forward. Workers of this build talk to an older master unchanged for p2
messages (new fields are optional), but such a master never assigns jobs.

Operational signals (p6-otel): `worker_inbox` outcomes `stale`/`rejected` per worker (partitions, misbehaving
workers), outbox backlog (`dispatched_at IS NULL` for `job.transition`), `job_schedule_status` waiting/
infeasible counts and reason codes, LOST count and recovery decisions (`job_runs.recovery`), pending effects
(`effect_status = 'pending'` older than a minute), `job.credential.issue` denials. Log lines: `orchestrator step
failed`, `outbox relay failed; retrying`, worker `lease token rejected`, `declining job`, `self-fencing`.

## 12. Multi-replica note

The advisory dispatch lock and `SKIP LOCKED` relay are replica-safe; the running-jobs reports and the worker
hub are per process (p7-ha must fan them out, as for revocation in p2).

## 13. UNVERIFIED

Real runtimes against real model providers (credentials; p3-e2e), Claude Code and Codex jobs (their
capabilities are `unverified` until that run — the policy must set `allowUnverified`), OpenCode under
host-restricted Seatbelt with a real provider (the e2e runs it unconfined), the OpenHands adapter (not in
this build), container jobs on rootless Linux engines; PR side effects and their inspection with credentials
(p4-git-flow); BullMQ against a Redis cluster/sentinel; Linux/Windows/Pi workers running jobs (the job path is
platform-neutral TypeScript; sandbox runners have their own matrix in p3-sandbox.md); the `ls-remote`
inspector against real private repositories (tests use a fake inspector).
