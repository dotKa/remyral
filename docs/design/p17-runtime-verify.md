# Design note: `p17-runtime-verify` — runtime capability verification from the panel

- **Task:** `p17-runtime-verify`. **Date:** 2026-10-27. **Owner decision (2026-10-27, approved):** prove runtime
  capabilities on the customer's own machines from the panel ("Doğrula") instead of a developer running the live test
  suites and editing static tables before a release.
- **Migration:** `0173_runtime_capability_evidence.sql` (main is at 0172); review fixes: `0174_runtime_evidence_version.sql`.
- **ADR:** [ADR-0012](../adr/0012-runtime-integration-surfaces.md) amendment 2026-10-27 (master-side evidence on top of
  the static capability tables); ADR-0008 unchanged in spirit (nothing becomes `supported` without a run that proves it
  on the exact tuple).
- **Worker feature:** `runtime-capability-verify-v1` (master first; an older worker gets no button).

## 1. Problem

On prod every runtime capability is `unverified`: Claude Code 2.1.310 and Codex 0.164.0 because the credentialed live
run never happened (`LIVE_PENDING`), Pi 1.4.0 and OpenCode 1.19.4 on win32-x64 because the scripted contract kit only
ran on darwin-arm64 (`PI_CONTRACT_TESTED`, `OPENCODE_CONTRACT_TESTED`). Jobs run only because runtime policies set
`allowUnverified` (ADR-0012 rule 1). The only way to change that was a developer with keys running
`packages/agent-adapters/test/**/live*.test.ts`, editing the tables and cutting a release — impossible for a customer and
stale with every new runtime version.

## 2. The scenario set (`packages/agent-adapters/src/verification`)

One module, used by the worker **and** by the tests (fake runtimes in `test/verification.test.ts`; the credentialed live
tests run the same set as one more case). The shared assertions of the contract kit moved there
(`collectUntilStopped`, `readUntil`, `findSecretLeaks`, `eventSequenceProblem`, `cursorReplayProblem`, …); the contract
suite re-exports them. One scenario per capability, carried by three short sessions to keep the cost low:

| Capability | Session | Passes when (the existing check it reuses) |
| --- | --- | --- |
| `streaming` | task | events gapless 1..n, valid timestamps, exactly one terminal `stopped` last, an assistant message, replay from a cursor exact, task succeeded (contract "events are gapless…", live "one-prompt repo task") |
| `approval` | task | an `approval_request` was raised for the file write under the runtime's ask policy, the approve round-trip was accepted, the task succeeded and the file exists (live "stream, approval") |
| `cost_reporting` | task | `usage` events with tokens and a known provenance (live "usage") |
| `artifacts` | task | the runtime's own diff names the file (live codex "diff"); Claude Code / Pi / OpenCode declare it unsupported → skipped |
| `resume` | task → resume | the same adapter resumes the stopped session on this worker, the resumed turn succeeds and names the file (live "resume") |
| `interactive_prompt` | long | a follow-up is accepted while the run is active (contract "interactive_prompt") |
| `cancel` | long | cancel ends the run within `cancelMs` (+1 s), `graceful`/`forced`, terminal `stopped`, outcome `cancelled`, a second cancel is `already-stopped` (contract + live "cancel mid-tool") |
| `safe_cancel` | long | the long shell command's process (`sleep N` / `Start-Sleep -Seconds N`, N per run) is gone within the grace period (live "no orphan process"); POSIX `ps`, Windows CIM |

Prompts: the live tests' ("Create a file named hello.txt … DONE", "What is the name of the file you created?", "Use your
shell tool to run exactly …"). Approval policy per runtime as the live tests use it (Codex `ask-all`, others
`ask-sensitive`); the verification plays the human reviewer and approves its own sessions' requests.

Outcomes: `passed` / `failed` / `skipped` with a plain reason (≤ 300 characters, redacted on the worker and again on the
master). A capability the adapter **declares** unsupported is `skipped` without running. **Budget:** time
(`maxDurationSec`, default 600, ≤ 1800) and tokens (`maxTokens`, default 150 000, the sum of `usage` increments); once
either is reached — or the run is cancelled (`ops.cancel`) — the running session is stopped and every capability not yet
decided is `skipped` (never `failed`, never `passed`). A failure recorded **before** the stop is a real result and stays
`failed` (it must revoke an older pass); only a failure recorded at or after the stop becomes `skipped`. Expected cost shown before a run: `VERIFICATION_ESTIMATE` (≈ 25k–45k
tokens, 2.5–3 minutes per runtime).

Declared tables (the ceiling): Pi / OpenCode `*_TESTED_CAPABILITIES` (what the contract kit established on darwin-arm64);
new `CLAUDE_CODE_DECLARED_CAPABILITIES` / `CODEX_DECLARED_CAPABILITIES` (what the live run establishes: streaming,
interactive prompt, approval, cancel `supported`; resume, cost reporting, safe cancel `degraded`; Claude Code artifacts
`unsupported`, Codex artifacts `degraded`). **Adapter revision** per runtime (`claude-code-adapter/1+sdk0.3.310`,
`codex-adapter/1+protocol0.164.0`, `pi-adapter/1+pin1.4.0`, `opencode-adapter/1+pin1.19.4`): bumped when an adapter's
mapping changes, which expires older evidence.

## 3. Worker (`runtime.capabilities.verify`)

Signed OPS_COMMAND `{ kind: 'runtime.capabilities.verify', runtime, version, budget }` (remote ops, ADR-0017: master lease
key, worker id, command id, 2-minute window, replay protection). `CapabilityVerifier`
(`apps/worker/src/remote-ops/verify-capabilities.ts`):

- refuses before anything runs: `not_enrolled`, `verification_running` (one at a time per machine), `fake_runtime`,
  `runtime_unavailable`, `runtime_not_installed`, `version_changed` (another version is active than the master asked
  for), `sandbox_unavailable` / `sandbox_not_ready`, `auth_invalid`, `credential_missing`;
- **auth:** the machine's configured `runtimeAuth` for the runtime through the job env planner (`planJobEnv` →
  `resolveJobEnv`): the subscription login (`local-login`, context variables only) or the bound secret reference
  (`secret-ref`, read from this worker's store, registered with a secret lease for exact-value redaction). No other
  secret path exists;
- **workspace:** a throw-away git repository `<workspaceRoot>/sandboxes/verify-<op8>/attempt-1/repo`, per-session state
  dirs next to it, everything removed afterwards;
- **confinement:** the job sandbox runner of the first ready host profile (`host-restricted`, else `runtime-sandbox`;
  containers need the image wiring jobs have), model egress only (the job egress allowlist), the job resource limits;
  the adapter is created through the registry exactly like an attempt's (`createForAttempt`), with
  `allowUnverified: true` in its spawn context (verifying unverified capabilities is the point);
- **progress:** OPS_UPDATE `running` with `capabilityVerify: { final: false, results }` after each decided capability;
- **evidence:** OPS_UPDATE `succeeded` (or `cancelled`) with `capabilityVerify: { final: true, signed }` — the evidence
  (runtime, runtime version, adapter revision, OS, arch, worker id, worker version, the master's op id, start, end,
  duration, auth mode, sandbox profile, budget, `stoppedBy`, tokens, cost, the declared table, the results) signed by the
  **device key** over `remyral-capability-evidence/v1\n<workerId>\n<opId>\n<sha256(canonical evidence)>`;
- **local opt-out:** new group `remoteOps.disabled: [verify]` (refused `disabled_locally`).

CAPABILITIES carry per runtime `verification: { adapterVersion, declared }`. The reported capability statuses stay the
static, truthful table: evidence never changes what a worker reports.

## 4. Master: evidence, precedence, effect

`CapabilityEvidenceService` (`apps/master/src/capability-evidence/`). On the final update the master stores the
evidence only when `verifyCapabilityEvidence` passes with the device key of the **session that sent it**, the evidence
names that worker and the op id the master created for that worker, and the tuple is the one the op asked for
(runtime + version). Otherwise nothing is stored and `runtime.capabilities.evidence` is audited as `failure`
(`bad_signature`, `wrong_worker`, `wrong_op`, `tuple_mismatch`, `unknown_op`); the op result says
`evidenceStored: false`. A worker therefore cannot forge evidence for another machine or another run.

**Precedence** (`overlayCapabilityStatus` in the protocol; `effectiveCapabilities` on the master):

1. A worker-reported status other than `unverified` stands — evidence never changes `supported`, `degraded` or
   `unsupported` (a failed check on a reported-`supported` capability is shown, not applied).
2. `unverified` + a **passed** check on exactly the machine's tuple (runtime, runtime version, OS, arch, adapter
   revision) → the adapter's **declared** status for that capability, only if it is `supported` or `degraded`.
3. Everything else stays `unverified`: no run, a failed check (the panel shows its reason), a skipped check, evidence of
   another runtime version (the version gate still applies), another adapter revision or another platform; an older
   worker that reports no adapter revision.
4. Per tuple and capability the **newest run that decided it** counts: a later failure revokes an earlier pass; a later
   skip changes nothing.

**The tuple's runtime version** is the one the adapter's own probe reads: CAPABILITIES carries it as `evidenceVersion`
(stored in `worker_runtimes.evidence_version`, migration 0174; absent on older workers → `version`). It differs from the
record's `version` for Claude Code driven by an agent SDK other than the pinned one (`<cli>+sdk.<sdk>`, the SDK is part
of the runtime identity) — the verify op asks for it, the evidence names it, placement / the matrix / ASSIGN_JOB look it
up. **One rule** decides whether evidence applies: protocol `evidenceApplies` (the five fields equal, a known OS family
and architecture); the attempt adapter (`verifiedOverlayApplies`) and the worker gate (`verifiedOverlayFor`) both call it.

**Index:** per (tuple, capability) Postgres picks the newest deciding run (`DISTINCT ON`; no global row cap). It is
cached per pool behind a cheap stamp (row count, newest receipt), so the matrix poll, placement and the machine view
do not rebuild it, and a run stored by any master instance shows at once; ASSIGN_JOB reuses the index placement loaded.

Evidence is **fleet-wide** for its tuple: one Windows x64 machine proving Pi 1.4.0 proves it for every Windows x64
machine on the same adapter revision. "Expiry" is the tuple match: a new runtime version or adapter revision simply has
no evidence yet.

**Effect:**

- placement (`Orchestrator.candidates`) reads the overlaid statuses — `capability_unverified` no longer blocks a job whose
  required capabilities (streaming, cancel, approval) are proven;
- the compatibility matrix (`/fleet/overview`) reads them too (the "kanıtlanmamış" cell / degraded note);
- ASSIGN_JOB `execution.verifiedCapabilities` (only to workers with the feature) carries the proven capabilities of the
  chosen worker's exact tuple. The worker's runtime gate (`verifiedOverlayFor`) applies them only when runtime, version,
  OS, arch and adapter revision equal its own probe, and creates the attempt's adapter with the same overlay
  (`VerifiedOverlay`), so the adapter's own capability checks agree with the gate. The job then runs without
  `allowUnverified`.

## 5. Panel

- **Makine → Runtime’lar:** per runtime a proof block — "Kanıtlandı (makine, tarih)" / "Kısmen kanıtlandı (…): X geçmedi"
  / "Kanıtlanmadı: …"; **Doğrula** (owner / admin, operable machine, worker with the feature, connected); a confirmation
  with the expected tokens and minutes, the limits and what the run spends (subscription quota or the API key); step-up
  (`POST /workers/:id/runtimes/:runtime/verify`, authz `workers.ops.write` → security-policy event `machines.ops`; a
  verify op the worker stopped answering — e.g. it restarted mid-run — is `lost` after the remote-ops window (40 min
  without news) and no longer blocks; the open-run check and the op insert hold a per (machine, runtime) advisory lock,
  so two quick clicks give one op and one 409); live
  progress with the results so far; the result per capability with its reason; the history (older runs marked "artık
  geçerli değil"). An older worker: no button, "önce makineyi güncelle".
- **Araçlar ve sürümler** and **Ayarlar → Runtime politikası:** per platform which runtime versions are proven
  (`GET /runtime-verification/platforms`; an old adapter revision says "yeniden doğrula").
- **Ayarlar → Runtime politikası:** how many installed runtimes still use job capabilities only because a policy allows
  unverified ones, which ones, and the way out (Doğrula each, then untick "Doğrulanmamışa izin ver")
  (`GET /runtime-verification/policy`). `allowUnverified` stays for the transition.
- The unverified reasons ("henüz kanıtlanmadı", "kanıtlanmamış özelliklerle çalışıyor") name the fix: Makine →
  Runtime’lar → Doğrula.
- **Version catalog** (Ayarlar → Sürümler → Güncelleme kanalı): an unverified catalog runtime version shows its latest
  run; after a passed run (no failed check, streaming and cancel passed) an admin can **"Doğrulandı olarak işaretle"**
  (`POST /runtime-verification/catalog/:runtime/:version/mark`, step-up of `releases.publish`, audited
  `runtime.catalog.verified.mark`).

**What the customer sees vs the vendor routine.** The mark is the owner's record on *this installation*; the capability
effect comes from the evidence alone (fleet-wide, per platform). The signed version catalog does not change: making a
version verified for every installation — and moving pins — is the vendor's weekly catalog routine
([docs/ops/update-channel.md §4](../ops/update-channel.md): `catalog.mjs test` → canary → `catalog.mjs promote` →
`catalog.mjs sign` with the catalog key, which never leaves the vendor). A customer's passed run is the canary evidence
the vendor's `promote --canary` note can cite.

## 6. Data (migrations 0173, 0174)

`runtime_capability_evidence` (one row per stored run: tuple, machine, worker version, auth mode, profile, times,
tokens, cost, `stopped_by`, passed / failed counts, results, declared table, the signed document and signature,
requesting user), `runtime_catalog_verifications` (runtime, version → evidence, who, when),
`worker_runtimes.adapter_version` / `declared_capabilities`, `worker_ops.kind` + `runtime.capabilities.verify`; 0174:
`worker_runtimes.evidence_version` (the probe's version, see §4). Additive; rollback: the old master ignores them.

## 7. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| A worker forges evidence for another machine / run | device-key signature over worker id + master op id + evidence digest, checked with the sending session's key; stored only for an op this master created for that worker and the tuple it asked for | protocol signature tests; master integration "cannot forge" |
| Evidence raises a capability above what the adapter can do | only `unverified` is lifted, at most to the declared `supported` / `degraded`; `unsupported` never | protocol + master unit precedence tests |
| Stale evidence after an upgrade | exact tuple incl. runtime version and adapter revision; another version / revision = no evidence | master integration "version gate", worker gate tests |
| A verification run as an unconfined backdoor | the job sandbox runner, model egress only, job limits, throw-away repo, `allowUnverified` only inside the run | worker verifier test (confiner, scratch removed) |
| Secret leakage | configured auth only (no new secret path), secret lease redaction, reasons redacted twice, the signed document never contains env values | worker test (key not in evidence) |
| Token / cost abuse | owner / admin + step-up per the security policy, 4 runs per machine and runtime per hour, one open run per pair, heavy-op limit per worker, time + token budget enforced on the worker, local opt-out `verify` | master integration (authz, step-up, 409, 429), worker budget tests |
| Silent "verified" without a run | the panel shows the run, its machine and date; audit `runtime.capabilities.verify.start`, `worker.ops.runtime.capabilities.verify`, `runtime.capabilities.evidence`, `worker.ops.result` | master integration (audit rows) |

## 8. Deploy order and flag

1. Master (migration 0173): routes, evidence storage, overlay. Workers without `runtime-capability-verify-v1` see no
   button (the panel says to update), get no `verifiedCapabilities` and keep today's behaviour.
2. Worker release with `runtime-capability-verify-v1` (agent-adapters scenario module, verifier, gate).
3. Owner presses Doğrula per platform (one Windows x64, one Linux x64, the Mac, the Pi…) and per runtime; when the
   policy page shows 0 dependent runtimes, `allowUnverified` can be turned off.

## 9. Tests

agent-adapters `test/verification.test.ts` (the set against the fake runtimes of all four runtimes on an untested
platform, a failing capability, a disk check failing honestly, declared-unsupported skipped, token / time budget, cancel,
default prompts, declared tables, the verified overlay, a pre-stop failure staying failed, sleep listeners and the race
timer); protocol `test/runtime-verification.test.ts` (incl. no aliasing tuple ids, unknown platform); worker
`test/runtime-capability-verify.test.ts` (verifier, budget, signing, refusals, single flight, the op incl. progress /
cancel / local opt-out / feature absent, the gate, gate and adapter agreeing, Claude Code on a non-pinned SDK); master
`test/unit/capability-evidence.test.ts`, `test/integration/capability-evidence-index.test.ts` (no row cap, cache, query
counts of the machine view and the matrix poll) and
`test/integration/runtime-verification.test.ts` (authz, step-up, feature gate, audit, storage, forged evidence,
precedence fleet-wide, version / revision expiry, placement facts, matrix, ASSIGN_JOB facts, platforms, policy count,
catalog mark, rate limit, a stale op of a restarted worker, two concurrent starts, Claude Code `evidenceVersion`); web
`test/runtime-verify.test.tsx`.

## 10. Not verified here

No real model run happened in this change — every test uses fakes. A real run on the production machines (Windows x64
with the subscription login, Linux, macOS, the Pi) is the owner's first "Doğrula"; until then the capabilities stay as
they are. Not exercised: the CIM process listing on Windows, the `runtime-sandbox` profile path of the verifier, a real
OpenCode / Pi run on win32-x64, real token counts against the estimate.
