# ADR-0055: General workflow engine — typed nodes with ports, master/worker placement, durable node runs, open HTTP egress from workers, a built-in e-mail node

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (decisions K1–K4, the internal note `workflow-motoru` (not published) "Kararlar (2026-10-20, sahibi)"), agent
- **Related:** p14-workflow-engine (phase 14.0: p14-wf-foundation); docs/design/p14-workflow-engine.md;
  ADR-0003, ADR-0004, ADR-0006 / ADR-0016, ADR-0010, ADR-0022, ADR-0024, ADR-0028, ADR-0033, ADR-0036, ADR-0041,
  ADR-0051; migration 0103

## Context

A workflow today is a DAG of AI jobs (planner / executor / verifier / reviewer / integrator): every node becomes a job
at run start, an edge is a `job_dependencies` row, the only data that flows is an agent's clipped summary and branch.
There is no condition, loop, timer, request, transformation or typed data, and a node has one implicit input and one
implicit output. The owner asked for a real workflow engine (requests, transformations, timers, if/else, several
inputs and outputs) without losing anything workflows do today (versions, archive, chat drafts, approvals with role
and step-up, failure policies, planner sub-DAGs, the integrator, deploy steps, parallel work on several machines).

The design (docs/design/p14-workflow-engine.md) left four questions to the owner; the owner decided them on
2026-10-20 (K1–K4). Two answers differ from the design's recommendation (K1, K4); this ADR records the result.

## Decision

1. **Typed nodes with named ports, one catalog.** A definition document version 2 (`schemaVersion: 2`) holds nodes of
   a catalog type (`packages/workflow-nodes`: triggers, `ai.step`, control flow, data, integrations, HTTP, e-mail,
   code), each with a strict config schema, **static** vs **expression-capable** fields (anything that grants
   capability — host, credential, recipient set, deploy target, repository, runtime, sandbox, approver role, code,
   limits — is static), named input / output ports with small data schemas, the side that runs it, whether it has
   side effects and the permission needed to add it. Edges carry `fromPort` / `toPort` (defaults `out` / `in`).
   Groups (`forEach`, `loop`) structure repetition; every scope stays acyclic.
2. **Version 1 stays and converts losslessly.** A v1 document is a v2 document after `normaliseV1` (node →
   `{type: "ai.step", …}`, `fail-fast → onError: fail`, `continue → onError: skip`, `retry-safe → retry.safe`,
   `maxRetries → retry.max`); `toV1` is its exact inverse on that image and `null` for anything using a v2 feature
   (property-tested, and checked over every stored definition by `workflow:normalise-check`). Stored documents are
   never rewritten.
3. **Placement (unchanged from the design).** Control flow, data, expressions, timers and approvals run on the
   master, pure and bounded. Notifications, chat, jobs, deploy / Pages / DNS, GitHub and uptime use the master's
   existing integrations to admin-configured provider hosts. **HTTP requests, e-mail and code run on a worker as a
   function job — never on the master** (the control plane's VPC, IMDS, Postgres / Redis stay out of reach). AI steps
   are the existing jobs.
4. **K1 — HTTP egress is open by default.** An `http.request` node may call **any public address** (research needs
   it). A project may turn its allowlist on (`workflow_egress.mode = 'allowlist'`); then only listed hosts are allowed.
   In open mode the list is a suggestion shown in the editor. The security floor does not move: loopback, private
   (RFC 1918, CGNAT, ULA), link-local, cloud-metadata (169.254.169.254, `fd00:ec2::254`, `metadata.google.internal`),
   multicast / reserved addresses and internal names (`localhost`, `*.local`, `*.internal`, `*.lan`, …) are refused
   in every mode — statically at save, and by the worker for every resolved address and every redirect (no
   re-resolve, ≤ 3 redirects); ports 80 / 443 / 8080 / 8443 by default, any other port only when the project's
   allowlist names `host:port`; credentials only by vault reference (`http-auth`, bound to `allowed_hosts`), never
   in headers or URLs of the definition; requests always leave from a worker.
5. **K2 — triggers on the canvas.** Trigger nodes are declarations; "Etkinleştir" reconciles each into one automation
   bound to the workflow (`workflow_trigger_bindings`, `automations.workflow_trigger_node`). Automations stay the
   only trigger runtime (signatures, dedup, catch-up, rate, run-as re-check, audit — ADR-0024).
6. **K3 — code nodes** (`code.js`, `code.python`) only on workers with a ready container engine (feature
   `function-code-v1`): no network, read-only root, bounded memory / CPU / time, pinned image digests, no secrets.
7. **K4 — a built-in e-mail node.** `email.send`: SMTP via a provider preset (Gmail, Outlook / Office 365, SendGrid,
   Mailgun, SES, Postmark, Brevo, Yandex) or a custom server (host, port 25 / 465 / 587 / 2525, TLS mode `tls` or
   `starttls` — never plaintext), username, and the password as a vault credential (`smtp`, bound to the server's
   host). **Recipients (to / cc / bcc / reply-to), subject and bodies may be expressions; the SMTP server, the
   credential and the sender are static.** At most `maxRecipients` (≤ 50, default 10) per send after evaluation.
   Sending runs on a worker as a function job (never from the master, which keeps its own notification SMTP for
   platform notifications only). Adding or changing it needs `workflows.define.network` (admin) + step-up, like HTTP.
8. **Durable node runs (engine 2).** One `workflow_node_runs` row per (run, node, scope, attempt) with optimistic
   transitions (`version`) under the existing per-run advisory lock; timers are rows (`due_at`); master integrations
   are recorded once in `workflow_side_effects` (unique per node run and kind, and per idempotency key); **jobs are
   created only when a node becomes ready** and linked in `workflow_node_run_jobs`; the dispatch admission admits such
   a job only while its node run is `running`. Readiness uses dead-path elimination with two skip kinds:
   `dead_path` (a branch not taken; joins drop it) and `upstream_failed` (an upstream failed with `onError: skip` or
   was cancelled; an `all` join is skipped by it) — exactly v1's "runs only when every upstream succeeded". A failure
   routed to a connected `error` port (or `onError: continue`) is handled and does not fail the run.
9. **Rollout behind flags; old runs never switch.** `WORKFLOW_ENGINE_V2` lets v2 documents be saved and run (engine
   2); `WORKFLOW_ENGINE_V2_FOR_V1` starts v1 documents on engine 2 as well. Both default off, so every existing
   workflow keeps running on engine 1 unchanged. Engine-2 runs use their own open states (`queued`, `active`,
   `paused`, enforced by `workflow_runs_engine_state_check`), so engine-1 code — including a rolled-back build — never
   picks them up. The run view, list and gate / cancel routes answer both engines in engine 1's vocabulary
   (`engine` tells them apart), so existing screens keep working.
10. **Parity before migration.** The worker-backed suite `workflows.test.ts` (A-ORCH-1 fan-out over three real
    workers, fail-fast, continue, retry-safe, gates with role + step-up, cancel, kill switch, planner expansion,
    integrator, invalid plans) runs on both engines; the other workflow suites (master-managed integration, deploy
    steps, result reuse, workspace files, planner hints, automations, composer, catalog) run on engine 2 with
    `REMYRAL_TEST_WORKFLOW_ENGINE=2`. Phase 14.5 flips `WORKFLOW_ENGINE_V2_FOR_V1` after those and a shadow period are
    green; engine-1 code stays for runs that started on it.

Phase 14.0 delivers 1, 2, 8, 9, 10, the catalog / schemas for every node type (including the K1 HTTP and K4 e-mail
semantics) and migration 0103 (all tables of the design). Engine 2 executes `ai.step` only in 14.0; every other type
is validated but refused with `node_type_unavailable` until its phase (14.1 control flow / data / timers, 14.2
integrations / triggers, 14.3 HTTP / e-mail / code on workers).

## Alternatives considered

- **Allowlist-only HTTP egress (the design's D1 recommendation).** Safer against exfiltration, but research
  workflows need arbitrary public sites; the owner chose open by default. The floor (no LAN / private / metadata,
  worker-only, credentials host-bound) carries the risk that matters most; the allowlist remains one switch away.
- **No built-in e-mail; external mail via the HTTP node (the design's D4 recommendation).** Rejected by the owner:
  marketing and reporting workflows need mail without hand-writing provider APIs. Keeping the server and credential
  static, recipients bounded and sending on workers avoids turning the master into a data-driven mail relay.
- **Rewriting stored v1 documents to v2.** Breaks append-only versions and hashes; normalising at read time is exact.
- **Creating every job up front (as engine 1).** Incompatible with branches that never run and loops of unknown
  length; lazy creation is the only model that scales to control flow.
- **Running engine 2 on engine-1 tables.** Their CHECKs forbid other node kinds and their shape has no scopes,
  attempts or ports; separate tables let a rollback leave engine-2 runs frozen and harmless.

## Consequences

- Positive: one foundation for every node type; v1 workflows lose nothing; the engine is testable as a pure core
  (`packages/workflow-nodes`) plus a thin persistence layer; new nodes plug in by catalog entry + executor.
- Negative: two engines coexist until 14.5; engine 2 differs from engine 1 on purpose in one visible way — a node
  that never becomes ready never gets a job (no BLOCKED / dependency-failed job rows for it).
- Open HTTP egress means a workflow author (admin, step-up) can reach any public host from a worker; mitigations:
  the static floor, the worker's resolved-address check, host-bound credentials, redaction, the project allowlist
  switch, audit of every privileged definition delta.
- Must now be true: no master code path opens a connection to a host chosen by a workflow author or by data; every
  new route goes through the route registry (RBAC matrix, rate policy, abuse tests); every new transition is
  audited.

## Verification

- `packages/workflow-nodes` unit tests: catalog (every type, static-field refusals, K1 forbidden hosts / headers /
  ports, K4 presets / TLS / static server / bounded recipients, K3 limits), lossless conversion (property test over
  random v1 documents, byte-identical round trip), v2 validation (ports, `many`, scopes, groups, cycles, references,
  limits, codes only), interpreter (deliveries, joins, skip kinds, attempts, run outcome).
- `apps/master/test/integration/workflows.test.ts` on engines 1 and 2; `workflow-engine-v2.test.ts` (flags, refusals,
  lazy jobs, admission, error ports, concurrent progress fence, cancel, rollback freeze, migration guards and widened
  constraints, stored-definition dry run); `migrate.test.ts`.
- Before enabling `WORKFLOW_ENGINE_V2_FOR_V1` in production: `pnpm --filter @remyral/master workflow:normalise-check`
  on the production database reports zero failures, and the parity suites are green with
  `REMYRAL_TEST_WORKFLOW_ENGINE=2`.

## Addendum — phase 14.1 (p14-wf-control, 2026-10-20)

- **Expression language: JSONata 2.2.2** (MIT, no dependencies, pinned exactly in the new package
  `@remyral/workflow-expr`; `yaml` 2.9.1 for `data.parse`). The isolation boundary is a `node:worker_threads` pool on
  the master (2 threads, 64 MiB heap each, empty environment) with a hard 250 ms deadline per request enforced by
  terminating the thread — JSONata's own guardrails are only a first line. `$eval`, `$random`, `$clone` and `$shuffle`
  are refused at save and bound to throwing stubs; `$now` / `$millis` are the node run's scheduled time.
- **Engine 2 runs every 14.1 node type on the master** (control flow, data, timers, approvals, sub-workflows, the
  manual trigger) with iteration scopes for groups, values on several ports, scoped fail-fast, retries with backoff as
  `retry_wait` rows and timers as rows. No master network path was added (§5.1 rule 1 unchanged).
- **New RBAC action `workflows.test`** (operator, project scope) for the expression preview and single-node tests; new
  routes are listed in the design §17. The v2 define routes take ≤ 512 KiB (`BODY_LIMIT_EXCEPTIONS`).
- **Sub-workflows are same-project only** until the run-as re-check of phase 14.4; a child run always runs on engine 2.
- Node type labels moved from the catalog package to the i18n catalog (`workflows.nodeTypes`, TR + EN, ADR-0053).
- Verification: `packages/workflow-expr` unit tests (scan, bindings, determinism, ReDoS / memory / size limits),
  `apps/master/test/integration/workflow-control.test.ts`, parity suites unchanged and green on both engines.

## Addendum — phase 14.2 (p14-wf-integrations, 2026-10-21)

- **Integration nodes use existing integrations only.** `notify.users`, `chat.message`, `jobs.create`,
  `deploy.coolify` / `deploy.pages` / `dns.change`, `github.comment` / `github.pullRequest` and `uptime.check` run on
  the master through one port wired to the notification service, the ops chat, the ops service under the project's
  deploy policy, the GitHub App's git-flow provider and the guarded uptime probe; rule 1 of §5.1 holds (no host from an
  author or from data). The run's creator is re-checked at every call.
- **Exactly-once by outbox + integration dedup.** One `workflow_side_effects` row per node-run attempt (unique key) is
  written in the transaction that moves the node run to `waiting`; the call is repeated after a crash with the same
  key, and each integration deduplicates by it (notification dedupe key, chat meta marker, ops idempotency key,
  hidden GitHub comment marker, pull request by head branch, job id written in the job's creation transaction).
- **Webhook waits** use 256-bit tokens derived by HMAC from the master box (so a wait's URL is known before it waits)
  and stored as SHA-256; signed by the workflow's bound webhook trigger by default, token-only as an admin opt-in;
  every refusal is a 404.
- **Trigger nodes are reconciled into automations** ("Etkinleştir"), which remain the only trigger runtime; chain
  triggers gain a workflow source (`trigger.workflow`). Bound automations are edited only on the canvas.
- **Privileged deltas** need `workflows.define.network | deploy | code` and a fresh step-up; `workflows.activate`
  (operator, plus `automations.external` + step-up for external triggers) enables triggers.
- Migration 0106 (run trigger node / data, received wait payloads, binding version / config hash). `control.respond`
  and webhook `responseMode: wait` move to 14.4. Details and the security review: design §18.


## Addendum — phase 14.3 (p14-wf-worker, 2026-10-21)

- **Function jobs on workers.** HTTP request, e-mail (K4) and code (K3) nodes run as JobSpec `kind: "function"` jobs
  (no repository, workspace, runtime, model or secrets by reference) only on workers advertising `function-v1`
  (HTTP / e-mail) or `function-code-v1` (code, container engine and pinned code images ready). They hold no AI slot
  (own function slots, 8 per worker), queue while no capable worker is online (`function_unsupported` and `offline`
  are transient) and fail `no_worker` into the node's error branch after the node's queue timeout (default 600 s).
  The master never opens these connections (§5.1 rule 1 unchanged); it builds the spec and checks it.
- **K1 enforced at three points.** The project policy (`open` by default, optional `allowlist`) and the LAN / private
  / loopback / link-local / CGNAT / metadata floor are checked at save, at run and on the worker, which resolves every
  target once, refuses any non-public answer, connects only to the checked address and re-checks each redirect hop.
  Changing the policy needs `workflows.egress.write` (admin) and an always-fresh step-up.
- **Host-bound credentials.** Vault kinds `http-auth` and `smtp` carry `allowed_hosts`; they are sealed only to
  `function-v1` workers, are never usable as runtime auth or MCP secrets, and the worker attaches the value only for a
  bound host (never after a redirect elsewhere), redacting its exact value from results.
- **At-least-once with idempotency.** One function job per node-run attempt via the 14.2 outbox; the
  `Idempotency-Key` (and the e-mail `Message-ID`) is the node run's key, identical across attempts and lease losses;
  non-idempotent methods and e-mail repeat only with `retry.safe`.
- Migration 0108 (job artifact kind `function`). **Worker release required.** Details, the security review and the
  UNVERIFIED items: design §19.

## Addendum — phase 14.4 (p14-wf-ops, 2026-10-21)

- **Operations are run states and rows, nothing in memory.** Pause is the run state `paused` (progress selects
  `active` runs; the admission holds a paused run's undispatched jobs); resume adds the paused time to
  `paused_ms` and shifts timeouts (not timers) in one transaction. Concurrency is a per-`(project, name, key)` group
  counted under a transaction-scoped advisory lock at start and at promotion (`queued` → `active`, FIFO);
  `onLimit: skip` records a cancelled run, `cancelOldest` cancels the oldest open run. Sub-workflow runs are exempt.
- **Re-run = a new run that takes finished node runs over** (`copied_from`, payloads copied, AI jobs as reused
  results) and runs only the chosen node, its descendants and nodes that did not end well; copied nodes never execute,
  so upstream side effects are never repeated; fresh nodes get new idempotency keys (listed in the plan).
- **Error workflows and failure alerts** are follow-ups written in the statement that fails the run
  (`workflow_run_followups`) and performed by the tick; one error run per failed run (unique `error_of`), never a chain;
  the new `trigger.error` node receives the failure as untrusted data; `workflow.failed` notifications once per streak.
- **Retention** replaces data of finished runs with `{"$pruned": true}` (guards accept only that), default 30 days,
  per-workflow `settings.retentionDays`, project default next.
- **Respond to webhook** answers a held `POST /v1/hooks/:id` (≤ 30 s, connection cap) from `control.respond` with
  allowlisted headers and inert content types only (JSON / text, `nosniff`, sandbox CSP) — no new network path.
- Migration 0112. No worker release. Details and the security review: design §20.

## Addendum — phase 14.5 (p14-wf-templates, 2026-10-21)

- **One engine for new runs.** With `WORKFLOW_ENGINE_V2_FOR_V1=true` (and `WORKFLOW_ENGINE_V2=true`) every **new** run
  of a version-1 (AI-only) workflow starts on engine 2 through `normaliseV1`; the engine is stored per run, so runs that
  started on engine 1 keep it and finish there (no drain, no conversion of open runs). Turning the switch off again
  sends new version-1 runs back to engine 1; open engine-2 runs finish on engine 2. The engine-1 code stays for runs
  that started on it. Gate: the parity suite (`workflows.test.ts` on both engines), the switch test
  (`workflow-migration.test.ts`) and the read-only dry run `workflow:normalise-check` (also a `remyral-master` image
  mode) printing `failures: 0`. The owner flips the flag in the master's environment; no migration.
- **Chat drafts of engine-2 workflows.** `draft_workflow` accepts v2 documents with every node kind; the assistant
  reads the catalog through a read tool, the master validates the draft exactly as `POST /workflows/validate`
  (catalog, expressions, egress, credentials) before the card is shown, and confirming saves through the same
  `define` path — privileged nodes (HTTP, e-mail, code, deploy, GitHub) still need the `workflows.define.*` action and
  a fresh step-up of the confirming user. Nothing runs on confirm. Tool and system prompt live on the assistant worker:
  **worker release required** for the assistant to offer it.
- **Templates.** Ready-made workflows are pure data in `@remyral/workflow-nodes` (no I/O); the gallery's wizard fills
  their placeholders (public origins, vault credential ids, addresses, schedules), the master validates and saves
  them as version 1 of a new workflow through `define` (same privileged-delta rule). Templates never carry secrets or
  hosts of their own; every external endpoint is a placeholder. Details and the security review: design §21.
