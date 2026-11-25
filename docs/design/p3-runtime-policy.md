# Design note: `p3-runtime-policy` — per-worker runtime policy, model profiles, version pinning, upgrade/rollback

- **Task:** `p3-runtime-policy` (ROADMAP P3: *per-worker runtime policy, model profiles, version pinning,
  upgrade/rollback and secure credential handling*). Threat model **T-SUP-1** (malicious runtime update installed
  on all workers: *version pinning per runtime; staged rollout (one worker first); upgrade/rollback policy*).
- **Date:** 2026-10-13
- **Binding inputs:** ADR-0012 rule 1 (version gate: a reported version that differs from the pin ⇒ `unverified`,
  job refused unless policy allows), ADR-0008 (truthful capabilities; a version change invalidates them),
  ADR-0014 (auth modes `secret-ref` | `local-login`, per runtime, never a credential on the master), ADR-0011
  (additive protocol changes, unknown fields stripped), ADR-0009 (admin + step-up for privileged actions),
  `p5-rbac` (every route declares `config.authz`), `p2-replay` (durable, sequenced master → worker outbox).
- **Out of scope:** installing runtimes (never automatic — §7), the job runner calling the check (the
  orchestration work wires `checkRuntimeForJob` into the runner; this task exposes it), scheduler eligibility
  filtering by policy (p4-scheduler can read `GET /workers/:id/runtime-policy` / `RuntimePolicyService`).

## Problem

The pins lived only in `apps/worker/src/runtimes/pins.ts` (+ docs/compat): changing one meant a new worker
release, every worker moved at once, and there was no way to say "this worker may only run Codex, only with an
API key, only with these models". Upstreams ship breaking changes in patch releases (docs/compat §1), so an
upgrade must be staged on one machine first and be reversible without touching every node.

## Shape

```
packages/protocol/src/runtime-policy.ts   RuntimePolicyDocument/Rule/ModelProfile, RuntimePolicyDelivery,
                                          AppliedRuntimePolicy, runtimePolicyHash (canonical JSON),
                                          runtimePolicyIssues (consistency), resolveModelProfile — shared, pure
packages/protocol (messages)              WorkerPolicy.runtimePolicy + projectsUnrestricted (UPDATE_POLICY),
                                          CAPABILITIES.runtimePolicy — additive 1.0
apps/master/migrations/0015_…sql          runtime_policies, runtime_policy_versions (append-only),
                                          worker_runtime_policies (assignment + delivery/applied state)
apps/master/src/runtime-policy/           service.ts (versions, canary, promote, rollback, assign, delivery),
                                          routes.ts (REST)
apps/master/src/workers/sessions.ts       hooks: delivery on session start, applied policy from CAPABILITIES
apps/worker/src/runtime-policy/           store.ts (validate + persist), enforce.ts (checkRuntimeForJob,
                                          effectivePin), hooks.ts (daemon UPDATE_POLICY handler)
apps/worker/src/runtimes/detect.ts        buildRuntimeReport(…, policyPin) — probe compares against the policy pin
apps/web/src/shell/RuntimePolicyCard.tsx  Fleet → worker → "Runtime policy"
```

## Decisions

### 1. The document

A policy version is one immutable JSON document (`RuntimePolicyDocument`, validated identically on master and
worker):

```jsonc
{
  "runtimes": {                                  // absent runtime = not allowed under this policy
    "codex": {
      "version": "0.162.1",                      // exact (no ranges), what the runtime reports
      "authModes": ["secret-ref"],               // ADR-0014; ⊆ {secret-ref, local-login}, ≥ 1
      "allowUnpinned": false,                    // run a mismatching version anyway (still `unverified`)
      "modelProfiles": [                         // name → provider/model/params (never credentials)
        { "name": "fast", "provider": "openai", "model": "gpt-5-mini", "params": { "reasoningEffort": "low" } }
      ],
      "defaultProfile": "fast"                   // required iff profiles exist
    }
  },
  "projectProfiles": { "alpha": { "codex": ["fast"] } }   // projects may only restrict further
}
```

Consistency rules beyond the schema (`runtimePolicyIssues`): no duplicate auth modes/profile names, default
profile defined, project restrictions only name allowed runtimes and defined profiles and are non-empty, at
most 256 project entries, canonical size ≤ 32 KiB (an `UPDATE_POLICY` frame stays far below the 512 KiB cap).
The master additionally refuses profile `model`/string params that match a secret pattern
(`@remyral/memory` `scanForSecrets`, ADR-0006): a profile is configuration, not a place for an API key.

**Model profile resolution** (`resolveModelProfile`, shared): a requested profile must exist for the runtime
(`model_profile_unknown`) and be allowed for the project (`model_profile_not_allowed`); without a request the
runtime default is used, or — if the project excludes it — the project's first allowed profile. A runtime
without profiles uses its own default model and rejects any requested profile.

### 2. Named policies are worker groups; versions are immutable

`runtime_policies(name)` holds pointers: `active_version`, `canary_version` (staged rollout) and
`previous_version` (default rollback target). `runtime_policy_versions` is append-only and gap-free (trigger,
SQLSTATE RA000; policies are never deleted). Each worker belongs to exactly one policy: its assignment in
`worker_runtime_policies.policy`, or `default` when unassigned. A worker's **effective** policy is the group's
`canary_version` if the worker is flagged canary and a canary is staged, else `active_version`; no policy (or
no active version) ⇒ nothing is delivered and the worker keeps comparing against its compiled-in table.

### 3. Staged upgrade, promotion, rollback

| Action | Effect |
| --- | --- |
| `PUT /runtime-policies/:name` `stage: "all"` | new version becomes active for the group; staged canary dropped; old active → `previous_version` |
| `PUT … stage: "canary"` | new version delivered only to the group's canary workers |
| `POST …/promote {version}` | canary → active for everyone. **Refused (409 `canary_not_verified`)** unless at least one non-revoked canary worker reports this exact version applied *and* every installed runtime the policy pins matches its pin in that worker's latest CAPABILITIES; `force: true` overrides (audited as forced) |
| `POST …/rollback {}` with a canary staged | rollout abandoned: canary workers return to the active version |
| `POST …/rollback {}` without a canary | active ← `previous_version` (the previous pin); the version rolled back from becomes `previous_version` |
| `POST …/rollback {toVersion}` | active ← that version (any stored version) |
| `PUT /workers/:id/runtime-policy {policy, canary}` | assignment (`null` = default) and canary flag |

All writes are admin+ (`runtimes.write`), step-up, CSRF, optimistic for new versions
(`expectedVersion` = the latest version the editor saw, 409 `version_conflict` otherwise) and audited in the
same transaction: `runtime_policy.version` (policy, version, stage, document hash, pins per runtime, change
note), `runtime_policy.promote` (forced flag, evidence workers), `runtime_policy.rollback` (from/to, abandoned
canary, reason), `worker.runtime_policy.assign` (before/after). Change notes and reasons are secret-scanned.
Reads (`runtimes.read`) are open to every console role: a policy holds names and versions only.

### 4. Delivery: `UPDATE_POLICY` over the durable outbox

`UPDATE_POLICY` is sequenced (p2-replay), so a policy is delivered at least once, in order, also to a worker that
is offline when it changes. `RuntimePolicyService.deliver(workerId)` queues one when the effective
`(policy, version, stage, hash)` differs from the last one queued (`worker_runtime_policies.delivered_*`), with
`policyVersion` = a per-worker monotonic generation. It runs:

- **on change** — after every write, for every approved, non-revoked worker of the group (fan-out after commit;
  a failure is logged and repaired by the next two triggers, never fails the admin action);
- **on session start** (`FleetSessionHandler` hook);
- **on drift** — CAPABILITIES now carries `runtimePolicy {name, version, documentHash}` (what the worker
  applied). If it differs from the effective policy and no `UPDATE_POLICY` waits in the worker's outbox (e.g.
  the worker lost its data dir), the policy is queued again.

The base `WorkerPolicy` fields are required by protocol 1.0 but this message must not narrow anything it does
not own: the master sends `allowedProjects: []` with the new `projectsUnrestricted: true` (the worker's local
project allowlist stays authoritative), all sandbox profiles, `maxParallelJobs: 64` (protocol max) and
`allowedRuntimes` = the policy's runtimes. Clearing a policy (worker moved to a group without an active
version) sends the message without `runtimePolicy`. Workers that predate this task log and ignore
`UPDATE_POLICY` (it was unhandled before) — they keep the compiled-in pins.

### 5. Worker: validate, persist, report

`RuntimePolicyStore` (`<dataDir>/runtime-policy.json`, mode 0600, crash-safe atomic replace like the state
file) applies a delivery only if its generation is newer than the stored one (replays and reordering are
no-ops), its `documentHash` equals the canonical hash of the document (integrity of what is stored and
reported) and `runtimePolicyIssues` is empty. A refused delivery keeps the previous policy; the CAPABILITIES
report keeps naming it, so the master sees the drift. On open, an unreadable file or one whose hash no longer
verifies (hand-edited) is ignored: the worker falls back to the compiled-in pins and reports no policy, and the
master re-delivers.

After a change the daemon re-sends CAPABILITIES. The capabilities provider re-runs the probe with the policy
pins (`ProbeOptions.pins` → `buildRuntimeReport(…, policyPin)`; the probe cache is keyed by policy identity):
`pinnedVersion`/`pinStatus` and every capability note are computed against the **policy** pin, a mismatch
marks every capability `unverified` with `pinMismatch: <installed> != pin <policy pin>` (ADR-0008) and the
probe notes say the pin came from the master policy.

### 6. Worker-side enforcement (`checkRuntimeForJob`, pure)

The job runner calls it before starting a runtime; the result is either the pin, its source, whether it
matches and the resolved model profile, or a typed refusal, checked in this order:

| Code | When |
| --- | --- |
| `runtime_not_allowed` | a policy is applied and does not list the runtime |
| `runtime_not_installed` | the probe found no installed version |
| `runtime_pin_mismatch` | installed ≠ pin (policy pin, else compiled pin) and the rule does not set `allowUnpinned` |
| `auth_mode_not_allowed` | the worker config's `runtimeAuth[runtime].mode` is not in `authModes` |
| `model_profile_unknown` / `model_profile_not_allowed` | §1 resolution |

Without a policy the compiled pin applies and a mismatch is refused (ADR-0012 rule 1 unchanged); auth modes
and profiles are then unrestricted (the worker config alone decides). `allowUnpinned` never upgrades
capabilities: they stay `unverified`.

### 7. How a runtime upgrade is performed (never automatic)

1. Owner reads the upstream changes and updates docs/compat/<runtime>.md if the surface changed.
2. Owner installs the new version **by hand** on one worker (as the worker's OS user, exact version, e.g.
   `npm i -g @openai/codex@0.163.0`) and marks that worker canary (`PUT /workers/:id/runtime-policy`).
3. Admin stores the new pin with `stage: "canary"`. The canary re-probes: pin match ⇒ capabilities from the
   compat matrix (still `unverified` until contract tests ran); other workers are untouched.
4. The adapter contract tests (p3-adapter-contract kit) are re-run on the canary for that runtime.
5. Admin promotes (the master checks the canary evidence, §3). Other workers now report `pinMismatch` until
   their owner installs the version; their jobs for that runtime are refused unless the rule sets
   `allowUnpinned` (a deliberate, audited choice for the transition window).
6. Problems ⇒ `rollback`: the previous pin is active again everywhere within one delivery; machines that
   already upgraded report `pinMismatch` until the old version is reinstalled (or `allowUnpinned` is set).
7. Once the fleet is on the new version, ADR-0012's table and `pins.ts` are updated in a normal release so a
   worker without a policy (fresh install) compares against the same pin.

## API

| Route | Action | Notes |
| --- | --- | --- |
| `GET /runtime-policies` | `runtimes.read` | policies with active + canary documents, worker/canary counts |
| `GET /runtime-policies/:name` | `runtimes.read` | |
| `GET /runtime-policies/:name/versions` | `runtimes.read` | newest first, ≤ 200 |
| `PUT /runtime-policies/:name` | `runtimes.write` + step-up | `{document, stage, expectedVersion, changeNote?, description?}`; 400 `runtime_policy_invalid` with `issues[{path, code}]` |
| `POST /runtime-policies/:name/promote` | `runtimes.write` + step-up | `{version, force?}` |
| `POST /runtime-policies/:name/rollback` | `runtimes.write` + step-up | `{toVersion?, reason?}` |
| `GET /workers/:id/runtime-policy` | `runtimes.read` | effective, delivered, applied, in sync, per runtime pinned vs installed |
| `PUT /workers/:id/runtime-policy` | `runtimes.write` + step-up | `{policy: name \| null, canary}` |

## Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| T-SUP-1 malicious runtime update reaches every worker | Exact pins per runtime; staged canary; promotion needs canary evidence; rollback to the previous pin in one delivery; nothing is ever installed by the platform | integration staged upgrade / refused promotion / rollback; unit `checkRuntimeForJob` |
| Silent runtime drift (owner upgraded a CLI) | Probe compares against the policy pin, every capability `unverified` + `pinMismatch`; runner refuses unless `allowUnpinned` | unit probe-vs-policy-pin; integration canary mismatch |
| Rogue/compromised master pushes a policy | A policy can only *restrict* (runtimes, auth modes, profiles) or change pins; it cannot install software, inject credentials, widen the local project allowlist (`projectsUnrestricted` never widens) or loosen sandboxing. Worst case: jobs refused or an attacker-chosen *installed* version accepted via `allowUnpinned` (still `unverified`) | design §4/§6 |
| Tampered/corrupt policy file on the worker | Hash verified on open; invalid file ignored (compiled pins), master re-delivers on drift | unit tampered/corrupt file |
| Replay / reordering of deliveries | Sequenced outbox + per-worker monotonic generation; stale generations ignored | unit stale generations |
| Credentials smuggled into profiles (ADR-0006/0014) | Profiles hold names only; secret-pattern scan on model/params/change notes; `authModes` restrict but never carry credentials; `local-login` stays worker-local | integration secret in params ⇒ 400, nothing stored or echoed |
| Unauthorised policy change | admin+, step-up, CSRF, audited in-transaction; viewers read only | integration 403s; rbac matrix + route coverage |
| Tampering with history | Versions append-only (trigger), policies never deleted, pointer moves audited | integration delete rejected |
| Oversized policy DoS | ≤ 32 KiB canonical, ≤ 256 project entries, ≤ 16 profiles × 16 params | unit too_large |

Residual risks: `allowUnpinned` deliberately lets an unverified version run — it is per runtime, visible in the
UI and audited. The canary evidence is the worker's own report (a compromised canary could fake a match; the
contract-test step is the real gate and is manual). The authenticity of a policy rests on the authenticated
worker channel (ADR-0005), not on a signature of its own; a signed-policy scheme like p2-signed-updates is a
possible follow-up if the master is to be distrusted for pins too. Single master replica (fan-out is
in-process, like the rest of `src/workers/`).

**Rollback of this change:** migration 0015 is additive (new tables only); without policies nothing is
delivered and workers behave exactly as before (compiled pins). Disabling the routes leaves existing workers on
their last applied policy; deleting `runtime-policy.json` on a worker returns it to the compiled pins.

## Operations

Logs: `runtime policy queued for worker` (master, with generation), `runtime policy applied` / `… refused`
(worker). Watch `GET /workers/:id/runtime-policy` `inSync` and per-runtime `status`; metrics hooks for p6-otel:
deliveries per change, workers out of sync, pin mismatches per runtime.

## Tests

- `packages/protocol/test/runtime-policy.test.ts` — canonical hash, consistency issues, schema refusals, size
  limit, profile resolution, additive message parsing.
- `apps/worker/test/runtime-policy.test.ts` — store apply/persist/reopen (0600), stale generations, hash and
  consistency refusals, clearing, corrupt/tampered file; `checkRuntimeForJob` matrix; probe vs policy pin.
- `apps/master/test/integration/runtime-policy.test.ts` — real master + two real worker daemons: step-up/viewer
  refusals, invalid and secret-bearing documents, delivery on change and on session start, persistence across
  restart, canary-only staging, worker refuses a mismatching pin, promotion refused without evidence, rollback
  restores the previous pin, `allowUnpinned`, promotion after the owner installs, group rollback, audit trail,
  append-only versions.
- `apps/master/test/integration/{rbac-matrix,route-coverage}.test.ts` — new actions and routes.
- `apps/web/test/runtime-policy.test.tsx` — card loads on demand, drift/mismatch display, viewer has no
  controls, admin assignment + promotion through step-up with CSRF.

Job runner integration (2026-10-13, p4-orchestration.md §3): the runner calls `checkRuntimeForJob` before
acknowledging a lease and additionally gates on the adapter's capability set; the rule gained the additive,
optional `allowUnverified` (ADR-0008: run with capabilities `unverified` on this OS/arch/version; never
upgrades them). A job `model` names a profile when the runtime has profiles.

UNVERIFIED: real runtime upgrades on the target nodes (procedure §7 is documented, not exercised with real
CLIs).

## p5-runtime-policy-ui (2026-10-14)

Problem: the panel could only assign policies; a document had to be hand-written through the API, and the
`default` policy (every unassigned worker) could not be created there — so the first live Claude Code run
on a worker stayed blocked by `capability_unverified` ("no ready runtime").

- Pins moved from `apps/worker/src/runtimes/pins.ts` to `packages/protocol/src/runtime-pins.ts` (the worker
  file re-exports them), so master and worker read one table; `pnpm security:pins` checks the new path.
- `GET /runtime-policies/template` (`runtimes.read`): every runtime at its exact pin, `secret-ref` +
  `local-login` (OpenHands `secret-ref` only, ADR-0014), `allowUnpinned`/`allowUnverified` false, no
  profiles. Built and checked like a PUT (schema, consistency, model catalog); nothing is stored. The policy
  name `template` is reserved (PUT refuses it with `reserved`).
- Settings → Runtimes (admin/owner): list (`default` first, active/staged version, worker counts),
  "Create default policy from current pins", per-runtime editor (pins read-only), change note, save with
  `all`/`canary` through step-up and `expectedVersion` = newest stored version (409 → reload), history,
  promote, rollback to a version. Project restrictions are kept and pruned to allowed runtimes/profiles.
- Links: Fleet row "no ready runtime" (when a runtime is `unverified`), the worker's Runtime policy card
  (reason + link, "Edit policies"), composer placement hints, and the worker's `capability_unverified`
  refusal text all name Settings → Runtimes.
- Security: no new action or secret path; writes keep admin + step-up + CSRF + audit; the UI cannot raise
  a capability to `supported` (ADR-0008), it only sets the existing `allowUnverified` flag.
- Tests: `apps/master/test/integration/runtime-policy-template.test.ts`, `apps/web/test/runtimes-settings.test.tsx`,
  `apps/web/test/fleet-ui.test.tsx` (unverified links).
