# Design note: General workflow engine — typed nodes, control flow, data, timers, integrations, functions (p14-workflow-engine)

- **Status:** Accepted — owner decisions K1–K4 (2026-10-20, the internal note `workflow-motoru` (not published) "Kararlar") recorded in
  ADR-0055; K1 (open HTTP egress) and K4 (built-in e-mail node) replace the recommendations of D1 / D4 below. Phase
  14.0 (foundation) implemented — see §16; phase 14.1 (control flow, data, timers, editor) — see §17; phase 14.2
  (master integrations, webhook waits, trigger nodes; migration 0106) — see §18; phase 14.3 (worker function jobs:
  HTTP, e-mail, code; migration 0108; worker release) — see §19; phase 14.4 (operations: re-run, pause / resume,
  concurrency, error workflows, retention, metrics, alerts, respond to webhook; migration 0112) — see §20; phase 14.5 (version-1 workflows on engine 2, chat drafts of
  v2 workflows, templates; no migration; worker release for the assistant) — see §21.
- **Date:** 2026-10-20
- **Backlog:** `p14-workflow-engine` (new)
- **Owner request (2026-10-20, paraphrased from Turkish):** "We must extend workflows: requests, transformations, timers,
  if/else and so on, multiple inputs and outputs. It must be a real workflow engine; right now it looks like only an
  AI-based workflow." Reference points: n8n / Node-RED (node palette, typed ports, data per node), Temporal (durable
  timers, deterministic replay, at-least-once activities with idempotency).
- **Decision record:** ADR-0055 "General workflow engine" (written with phase 14.0). Migration **0103** (reserved). ADR-0054 / migration 0102 belong to another design in flight
  and are not used here.
- **Binding decisions this design must respect:** AGENTS.md (AWS master is a control plane; outbound-only workers; no
  unauthenticated shell/agent endpoint; durable leased jobs, at-least-once + fencing/idempotency; every privileged
  action auditable; no automatic deploy / destructive action without a human approval policy; untrusted repository text
  never authorizes anything), ADR-0003 (Postgres is the truth, BullMQ only hints), ADR-0004 (leases, fencing,
  idempotency), ADR-0006 / ADR-0016 (secrets by reference; vault values sealed to workers — the master cannot read them),
  ADR-0009 (step-up), ADR-0010 (outputs are data, never authority), ADR-0024 (automations are the trigger system),
  ADR-0028 (master-held deploy tokens, typed ops actions, deploy policy), ADR-0033 (queue classes, per-profile slots),
  ADR-0036 (approval pause), ADR-0041 (deterministic non-AI `integration` job kind — the precedent for function jobs),
  ADR-0047 (Diyalog), ADR-0051 (React Flow + dagre + yaml, lazy).

## 0. Summary

Today a workflow is a DAG of **AI jobs** (planner / executor / verifier / reviewer / integrator). Every node becomes a
job at run start, edges become `job_dependencies`, and the only data that flows is an agent's clipped summary and git
branch. There is no condition, no loop, no timer, no request, no transformation, and a node has exactly one implicit
input and one implicit output.

This design turns the workflow into a **typed dataflow graph** with a node catalog (triggers, AI steps, control flow,
data, integrations, code), named input/output ports and a durable **per-node-run state machine** in Postgres. The key
architecture decision is **placement**:

| Placement | Nodes | Why |
| --- | --- | --- |
| **Master, pure** | control flow, data transforms, expressions, timers, waits, approvals, sub-workflow calls | Deterministic, no I/O, bounded CPU/time in a sandboxed expression thread pool; needed for latency (no job round trip). |
| **Master, existing integrations** | notifications, chat message, create job, deploy / publish / DNS (ops actions), GitHub comment / PR, uptime / health check | Fixed provider hosts, master-held tokens, existing SSRF guards and policies (ADR-0028, ADR-0022, p8-uptime). |
| **Worker, function job** | HTTP request to any public host (K1), e-mail over SMTP (K4), sandboxed JS / Python code | The master never fetches user URLs inside its VPC (IMDS, internal services); vault credentials can only be decrypted by workers (ADR-0016). A new non-AI JobSpec `kind: "function"` (feature `function-v1`) like ADR-0041's `integration` kind. |
| **Worker, AI job** | the existing five roles on the four runtimes | Unchanged. |

Existing definitions keep working unchanged: version-1 documents are a strict subset of the new schema, their runs keep
running on the current engine (`engine = 1`) until the new engine has proven parity, and nothing they do today is lost.

Delivery order (value early): **14.0** foundation → **14.1** control flow + data + timers on the master (no worker
release) → **14.2** master integrations + trigger nodes → **14.3** HTTP + code on workers (worker release) →
**14.4** operations (re-run from a node, pause, concurrency, retention, error workflows) → **14.5** legacy migration,
chat drafting of v2 workflows, templates.

## 1. Current state (verified in code)

### 1.1 Definition schema and validation

- Schema: `apps/master/src/workflows/definition.ts:109-147` (`WorkflowDefinitionBody`, strict zod): `name`,
  `description`, `inputs` (string inputs, `required`, ≤ 20, ≤ 8 KiB each), `defaults` (JobSpec fields:
  runtime, model, sandbox, approval policy, source trust, limits, requirements, repository, fallbacks, deferrable,
  reuse), `nodes` (≤ 50), `edges` `{from, to}` (≤ 200), presentation-only `layout.positions`.
- Node: `definition.ts:64-106` — `id`, `role` (`planner | executor | verifier | reviewer | integrator`,
  `packages/scheduler/src/dag.ts:10`), `prompt` (≤ 16 KiB), `failurePolicy` (`fail-fast | continue | retry-safe`,
  `dag.ts:13`) + `maxRetries` ≤ 3, `approval.approverRole`, `dynamic.maxNodes` (planner), per-step runtime/model/
  sandbox/limits/requirements/fallbacks/deferrable/reuse, `siteBundle`, `deploy` (`coolify.deploy | coolify.restart |
  pages.deploy`, only after a verifier / integrator, `definition.ts:174-188`).
- Structural checks: `validateWorkflowGraph` (`dag.ts:160`): ids, ≤ 50 nodes / 200 edges / fan-out 20, **acyclic**
  (Kahn, `topoOrder` `dag.ts:78`), template references only to declared inputs and **ancestors**
  (`{{inputs.x}}`, `{{upstream.<id>.summary|branch}}`, `{{run.id}}`, `{{node.id}}`), limits in `WORKFLOW_LIMITS`
  (`dag.ts:16-26`). Every node must also be a valid protocol JobSpec (`#checkSpecs`). Errors are paths + codes only.
- Planner plans: fenced `remyral-plan` JSON parsed strictly (`definition.ts:229-278`), expanded by `expandPlan`
  (`dag.ts:251`).
- Validation route `POST /workflows/validate` (`apps/master/src/workflows/routes.ts:149`).

### 1.2 Versions, archive, drafts

- `workflow_definitions` append-only (trigger, migration `0017_quotas_and_workflows.sql:129-152`), version `n + 1` per
  `(project, name)` under an advisory lock (`engine.ts:273-290`); `PUT /workflows/:id {definition, baseVersion}` with
  409 `version_conflict` (`routes.ts:223`); versions list (`routes.ts:262`); duplicate (`routes.ts:339`).
- Archive: migration `0098_workflow_archive.sql` (`workflow_archives(project, name, …)`; archived ⇒ new runs and new
  versions refused) + index `workflow_runs (project, name, created_at)`.
- Chat: `draft_workflow` (protocol `packages/protocol/src/assistant.ts:413-440`, role enum hard-coded in the tool
  schema; master validation `apps/master/src/chat/tools.ts:395`), draft kind `workflow` added by
  `0099_chat_draft_workflow.sql`. The worker builds the assistant's tool list from `@remyral/protocol`, so **any change
  of that tool schema needs a worker release** (p13-workflows-ui §5).

### 1.3 Run engine

- `WorkflowService` (`apps/master/src/workflows/engine.ts:200`). `startRun` (`engine.ts:633`) validates inputs, then in
  one transaction creates the run (`starting`), one `workflow_nodes` row per node with its resolved JobSpec, **one job
  per node up front** (DRAFT → submitted → BLOCKED), `job_dependencies` per edge.
- Dispatch gate: `admit` (`engine.ts:1065`) is the first `DispatchAdmission`: a workflow job is dispatched only while
  its node is `queued`.
- Progress: tick step `workflows` (`engine.ts:1122-1160`), run by the orchestrator tick every 2 s
  (`apps/master/src/compose.ts:2524`, `tickIntervalMs ?? 2_000`); serialised per run by
  `pg_advisory_lock('wf:<run>')`; ≤ 10 passes per tick in topological order; ≤ 100 open runs per tick.
- Node states (`engine.ts:81-89`): `pending → awaiting_approval → queued → succeeded | failed | skipped | cancelled |
  awaiting_merge`; run states (`engine.ts:90`) `starting | running | awaiting_merge | succeeded | failed | cancelled`;
  both mirrored by CHECK constraints (`0017:193-217`, `workflow_nodes.role` CHECK lists exactly the five roles).
- Failure policies: fail-fast cancels everything open; continue skips descendants; retry-safe creates a new job for the
  node (`workflow_node_jobs` append-only).
- Outputs passed downstream: `{summary ≤ 4 KiB, branch, commits}` (`engine.ts:1515-1550`), redacted twice, frozen into
  `upstream_snapshot` at release, delivered **only** as fenced untrusted data in `ASSIGN_JOB.context` by
  `WorkflowContextProvider` (`engine.ts:2140`); prompts contain pointers (`[UPSTREAM OUTPUT …]`), never the text.
- Parallel steps across machines: every node is an ordinary job, so independent nodes are placed on different workers
  by the scheduler (acceptance A-ORCH-1, three real workers in `apps/master/test/integration/workflows.test.ts`);
  p8-orchestration step placement (`apps/master/src/workflows/placement.ts`).
- Approvals inside workflows: per-node pre-start gate, `POST /workflows/runs/:id/nodes/:node/approve|deny`, gate role
  + fresh step-up + audit (`engine.ts:2064`). In-run approvals of the agent itself are ADR-0036 approval pause.
- Cancel: `cancelRun` (`engine.ts:2044`), project kill switch `cancelProjectRuns` (`engine.ts:2125`).
- Deploy steps: `WorkflowDeployPort` (`engine.ts:170-188`) requests an ops action after the node.

### 1.4 Triggers that already exist (automations, schedules)

- Automations (ADR-0024): trigger kinds `cron | at | github | webhook | chain` (`apps/master/src/automations/model.ts:25`),
  targets `job | workflow | deploy` (`model.ts:77-119`; a workflow target names `workflowId`, inputs, repository,
  priority). Policies: concurrency `skip | queue | parallel`, catch-up `skip | once | all`, `maxRunsPerHour`, approval
  timeout, webhook IP allowlist (`model.ts:121-150`). Chain triggers fire on another automation's outcome
  (`succeeded | failed | cancelled`, `policy.ts:9`).
- Webhooks: `POST /v1/hooks/:id`, HMAC-SHA256 over `timestamp.nonce.body`, ±5 min skew, single-use nonce
  (`apps/master/src/automations/webhook-signature.ts:1-60`), body ≤ 256 KiB, event data ≤ 64 KiB
  (`rate-policy.ts:168`). GitHub: `POST /v1/hooks/github` with `X-Hub-Signature-256`, event filters (repository, event,
  actions, branches, labels, command, `allowUntrusted`) (`github-events.ts:78-107`).
- **Event data never reaches parameters**: it reaches a job only as one fenced untrusted block appended to the context
  (`apps/master/src/automations/context.ts:1-40`); deploy targets take fixed parameters only (`model.ts:108-118`).
- Schedules (p5-composer) are cron / one-shot automations with a job or workflow target
  (`apps/master/src/schedules/service.ts:39`).

### 1.5 Editor (Diyalog)

- `apps/web/src/diyalog/screens/workflows/` (3 879 lines): `WorkflowEditor.tsx` (1 145), `Inspector.tsx` (794),
  `WorkflowCanvas.tsx` (360, React Flow), `model.ts` (476: pure `Doc → Doc` edits, `ROLES` at `model.ts:11`,
  `addNode` / `connect` / cycle refusal), `history.ts` (undo ≤ 100), `layout.ts` (dagre), `TextPanel.tsx` (YAML/JSON
  sync), `VersionsDialog.tsx`, `RunGraph.tsx` (read-only run canvas). Pinned `@xyflow/react` 12.12.0,
  `@dagrejs/dagre` 3.1.1, `yaml` 2.9.1 (`apps/web/package.json:16-21`), lazy chunks guarded by
  `apps/web/test/workflows-lazy-chunk.test.ts` (ADR-0051). Cards have one handle in / one out; no port concept.

### 1.6 Existing building blocks the engine reuses

| Block | Where | Reuse |
| --- | --- | --- |
| Non-AI job kind on workers | `JobSpec.kind: 'machine-admin' \| 'integration'` (`packages/protocol/src/master-messages.ts:232`), feature `integration-v1` (`worker-features.ts:151-156`), worker skips runtime admission/sandbox for it (`apps/worker/src/jobs/runner.ts:1123-1150`), master placement `integration: true` (`orchestrator.ts:1233`) | template for `kind: "function"` |
| Worker egress proxy | `apps/worker/src/sandbox/egress/proxy.ts:1-22` — CONNECT-only, exact `host:port` allowlist, no IP literals, every resolved address checked against private/link-local/metadata ranges, no re-resolve | HTTP node egress |
| Container sandbox | `apps/worker/src/sandbox/container/args.ts:59-95` (`--network none`, `--read-only`, `--pids-limit`, `--memory`) | code node |
| Workspace egress modes | `packages/protocol/src/workspace.ts:11-30` (`none | allowlist | web`, `EgressHost` without IP literals, ≤ 64 hosts) | project HTTP egress policy shape |
| Master SSRF guard | `apps/master/src/ops/http.ts:7-60` (`isNonPublicAddress`, provider hosts), `apps/master/src/uptime/probe.ts:10-25` (http/https, ports 80/443/8080/8443, no headers/credentials, DNS checked inside `lookup`, redirects re-checked, 64 KiB body cap) | uptime / health node only |
| Vault | `vault_credentials` (`0030_credentials_models.sql:25-39`), ciphertext per worker; master stores metadata only (ADR-0016) | HTTP auth by reference |
| Ops actions | ADR-0028 (`coolify.deploy/restart`, `pages.deploy`, `dns.upsert/delete`, policy: preview auto, production approval + always-fresh step-up) | deploy / publish nodes |
| GitHub App | ADR-0022 (contents RW, pull requests RW; tokens encrypted on the master), `apps/master/src/gitflow/github-provider.ts:57-430` (PR create / patch / merge) | GitHub nodes |
| Notifications | closed kind catalog `apps/master/src/notifications/model.ts:7-55` (CHECK in migration 0014), channels in-app / email (SMTP) / push / webhook, opt-in per kind | notify node |
| Step-up | `requireStepUp('standard' \| 'always-fresh')` (`apps/master/src/auth/hooks.ts:158`), `stepUpFields` for services | privileged saves, tests, approvals |
| Rate policy | `apps/master/src/http/rate-policy.ts` (classes `:57`, overrides `:124`, `BODY_LIMIT_EXCEPTIONS` `:143`), asserted over the whole route registry by `apps/master/test/integration/abuse.test.ts` and `test/unit/rate-policy.test.ts` | every new route |
| Authz | `apps/master/src/authz/model.ts:356-395` (`workflows.read/define/run/approve`, `automations.*`) + RBAC matrix | new actions |

### 1.7 Gaps against the request

No condition / switch / merge semantics (a node runs only if *all* upstreams succeeded); no loop or for-each; no timer,
wait-until or wait-for-webhook; no data transformation; no HTTP request; no code; outputs are free text only (no typed
data, no JSON); a node has one implicit input and output; node kinds are AI roles only (the CHECK constraint even
forbids anything else); jobs are created up front, which is incompatible with branches that never run and with loops of
unknown length; triggers live in a separate screen and pass event data only to AI context.

## 2. Model: nodes, ports, edges, data

### 2.1 Definition document v2

A definition gains an optional `schemaVersion` (absent = 1). Version 2 adds:

```jsonc
{
  "schemaVersion": 2,
  "name": "pr-triage",
  "description": "Label, summarise and notify on new pull requests",
  "inputs": { "task": { "required": false, "type": "string" } },          // v2: type (string|number|boolean|json)
  "defaults": { "runtime": "claude-code", "sandboxProfile": "container", "limits": { "maxDurationSec": 1800 } },
  "settings": {                                                          // v2, all optional
    "concurrency": { "max": 3, "onLimit": "queue" },                     // per (project, name)
    "timeoutSec": 86400,                                                 // whole run
    "onFailure": { "workflow": "notify-oncall" }                         // error workflow (14.4)
  },
  "nodes": [
    { "id": "pr", "type": "trigger.github", "config": { "repository": "acme/app", "event": "pull_request",
      "actions": ["opened"] } },
    { "id": "big", "type": "control.if",
      "config": { "condition": "{{ $trigger.pull_request.additions > 500 }}" } },
    { "id": "review", "type": "ai.step", "role": "reviewer",
      "prompt": "Review this pull request for risky changes.", "outputSchema": { "type": "object",
      "properties": { "risk": { "type": "string", "enum": ["low", "medium", "high"] }, "notes": { "type": "string" } },
      "required": ["risk"] } },
    { "id": "comment", "type": "github.comment",
      "config": { "body": "Risk: {{ $node.review.out.data.risk }}\n\n{{ $node.review.out.data.notes }}" } },
    { "id": "ping", "type": "notify.users", "config": { "recipients": { "role": "admin" },
      "title": "Large PR {{ $trigger.pull_request.number }}" } }
  ],
  "edges": [
    { "from": "pr", "to": "big" },
    { "from": "big", "fromPort": "true", "to": "review" },
    { "from": "big", "fromPort": "false", "to": "ping" },
    { "from": "review", "to": "comment" }
  ],
  "layout": { "positions": { "pr": { "x": 0, "y": 0 } } }
}
```

Rules:

- **Node `type`** from the catalog (§3). A v1 node (`role` + `prompt`, no `type`) is normalised to
  `{ type: "ai.step", role, prompt, … }` — a pure, lossless function `normaliseV1` in the shared catalog package; the
  stored document is never rewritten (append-only), and a v1 document saved again by the new editor stays v1 unless a
  v2 feature is used (the editor writes `schemaVersion: 2` only when needed).
- **Node `config`**: per-type strict zod schema (unknown keys refused). Fields are either **static** (literal only) or
  **expression-capable** (`{{ … }}` templates or a whole-value expression `{ "$expr": "…" }`). The catalog marks each
  field; anything that grants capability is static-only (§8.3).
- **Edges** gain optional `fromPort` (default `out`) and `toPort` (default `in`); `{from, to}` keeps its meaning. A
  port is `^[a-z][a-z0-9_]{0,31}$`. Multiple edges into one input port are allowed only where the port says
  `many: true` (merge); otherwise one.
- **Groups** (for-each / loop bodies): a node may carry `parent: "<groupNodeId>"`; edges never cross a group boundary
  except through the group's own ports (`body` out, `item` in on the inner side, `done` / `results` out on the outer
  side). The top-level graph and every group body stay **acyclic** — repetition is structured, never a back edge — so
  the existing Kahn / ancestor validation carries over per scope.
- Limits v2: ≤ 200 nodes (≤ 50 `ai.*` nodes, unchanged), ≤ 600 edges, ≤ 8 ports per node, nesting depth ≤ 3,
  definition ≤ 512 KiB JSON.

### 2.2 Ports and data contracts

Each catalog entry declares its ports:

```ts
interface PortSpec {
  name: string;                 // 'in', 'out', 'true', 'false', 'error', case names, …
  direction: 'in' | 'out';
  schema?: DataSchema;          // what flows; absent = any JSON
  required?: boolean;           // input: must receive a value (or a skip) before the node may run
  many?: boolean;               // input: accepts several edges (merge)
  dynamic?: 'cases' | 'inputs'; // ports generated from config (switch cases, merge inputs)
}
```

`DataSchema` is a deliberately small JSON-Schema subset (`type`, `properties`, `required`, `items`, `enum`, `maxLength`,
`maxItems`; depth ≤ 6) plus three platform types: `files` (workspace artifact references, the existing `out/ → in/`
transfer), `git-ref` (`{branch, commits}` of AI steps) and `text` (free text). It is used for

1. **design-time compatibility**: connecting `object` to `array` is refused in the editor and by `validate`
   (`edges.<i>:schema_mismatch`); `any` connects to anything;
2. **runtime contracts**: a node's output is checked against its declared output schema before it is published; a
   violation fails the node with `output_contract` (→ its error policy);
3. **autocomplete** in the expression editor (§7.3).

**A value on a port** is one JSON document per node run (Node-RED "message" / Temporal "activity result" style, not
n8n's implicit item lists — implicit fan-out is hard to reason about and to bound). Lists are processed explicitly
by `control.forEach` / `data.split`. Size: ≤ 256 KiB per value inline; larger values (≤ 4 MiB) are stored once in
`workflow_payloads` and referenced by hash; per run ≤ 64 MiB of payloads; files travel as artifact references, never
inline.

**AI step outputs** keep `summary` (text, clipped 4 KiB), `branch`, `commits`, `files` and gain optional **structured
data**: with `outputSchema`, the agent is asked to end its result with one fenced ```` ```remyral-output {…}``` ````
block, parsed strictly like `remyral-plan` (`definition.ts:251`), validated against the schema (≤ 64 KiB) → port
`out.data`. Missing / invalid → `output_contract` error (retry per policy). The structured data is **still untrusted**
(it was produced by a model that read untrusted input): it may drive conditions and transforms, never static fields.

### 2.3 Activation and readiness semantics

The engine evaluates per **scope** (top level, or one iteration of a group). A node run becomes **ready** when, for each
required input port, every incoming edge has delivered a **value** or a **skip**:

- **Dead-path elimination** (BPMN-style): an `if` emits a value on the taken port and a *skip* on the other; a node
  whose inputs are all skips becomes `skipped` and propagates skips on all its outputs. This replaces "create every job
  up front": **jobs are created only when a node run becomes ready** (engine 2).
- **Join modes** on multi-input nodes (`config.join`, default `all`):
  - `all` — wait for every edge; run if at least one value arrived (skips are dropped from the input list); all-skip ⇒
    skipped. This equals today's semantics for nodes whose upstreams all succeed.
  - `any` — run on the first value; later arrivals are ignored (recorded).
  - `first` — like `any`, and cancel still-running upstream node runs of the same scope that feed only this node.
  - `n_of_m` (`{ "join": { "atLeast": 2 } }`) — quorum.
- **Errors**: a failed node run with an `error` port connected emits `{code, message, node, attempt}` there (and skips
  on its normal outputs); without one, the node's `onError` applies: `fail` (default for v2 nodes: the run fails after
  cancelling open work — today's fail-fast), `continue` (emit `null` on `out`, descendants run), `skip` (skip
  downstream — today's `continue`). v1 `failurePolicy` maps exactly: `fail-fast → fail`, `continue → skip`,
  `retry-safe → retry.safe = true` with `maxRetries`.

### 2.4 Expressions and context

Expressions (language: §4) see one read-only context object:

| Name | Content |
| --- | --- |
| `$input` | the node run's input port values (`$input.in`, `$input.true`, …; `$input` = `$input.in` for single-input nodes) |
| `$node.<id>.<port>` | output of an **ancestor** node in the same or an enclosing scope (static check, like today's ancestor rule) |
| `$inputs` | workflow run inputs (typed) |
| `$trigger` | the trigger event data (untrusted unless the trigger is manual by a project member) |
| `$item`, `$index`, `$items` | inside a for-each body |
| `$run` | `{id, startedAt, workflow, version, project}` |
| `$now` | the node run's **scheduled time**, fixed per node run (deterministic on replay) |

Legacy templates `{{inputs.x}}`, `{{upstream.<id>.summary|branch}}`, `{{run.id}}`, `{{node.id}}` remain valid
everywhere they are valid today and keep their exact rendering in AI prompts (pointer + fenced data, ADR-0010). In AI
prompts **every** expression renders as a pointer `[WORKFLOW DATA <node>.<port>.<path>]` and its value travels in a
fenced block (`WorkflowContextProvider` extended) — model-facing text is never built from untrusted values.

## 3. Node catalog

The catalog lives in a new pure package **`packages/workflow-nodes`** (zod config schemas, port specs, placement, UI
metadata — Turkish/English labels via the i18n catalog keys, icon, category), imported by the master (validation,
execution dispatch), the web (palette, forms) and the protocol's assistant tool description. Placement column: **M** =
master pure, **MI** = master integration, **W** = worker function job, **WA** = worker AI job. Phase = first delivery.

### 3.1 Triggers (one or more per workflow; a run starts from exactly one)

| Type | Config (static unless *expr*) | Output | Backing | Ph |
| --- | --- | --- | --- | --- |
| `trigger.manual` | input form (from `inputs`) | `{inputs, startedBy}` | Çalıştır / composer / API, as today | 14.1 |
| `trigger.schedule` | cron or one-shot `at`, timezone, catch-up | `{scheduledFor, missed}` | automation `cron` / `at` | 14.2 |
| `trigger.webhook` | IP allowlist, secret (rotate), `responseMode: ack \| wait` (wait ≤ 30 s for a `respond` node), JSON schema of the body | `{headers (allowlisted), body, receivedAt}` | automation `webhook` (`/v1/hooks/:id`, HMAC) | 14.2 |
| `trigger.github` | repository, events, actions, branches, labels, command, allowUntrusted | the filtered event (`eventRepository`, PR, sender, trust) | automation `github` | 14.2 |
| `trigger.workflow` | source workflow (project + name), outcomes | `{runId, outcome, outputs}` of the source run | automation `chain` extended to workflow sources | 14.2 |
| `trigger.chat` | — | `{threadId, message}` (the user's confirmed draft) | `draft_workflow_run` card (human confirms) | 14.2 |

Triggers are **declarations**; saving does not start listening. "Etkinleştir" (activate) reconciles each trigger node
into one automation row bound to the workflow (`automations.workflow_trigger_node`), pinned to "latest version at
fire time" (default) or a fixed version. Automations remain the single trigger runtime (dedup, catch-up,
`maxRunsPerHour`, signature checks, run-as re-check, audit) — ADR-0024 holds; the Otomasyonlar screen shows such rows
as "workflow'a bağlı" and edits jump to the canvas. A workflow without trigger nodes behaves as today (manual + any
automation/schedule that targets it).

### 3.2 AI steps

| Type | Notes | Ph |
| --- | --- | --- |
| `ai.step` (role `planner \| executor \| verifier \| reviewer \| integrator`) | Exactly today's node (all fields), plus optional `outputSchema` (§2.2), input ports `in` (`many`, join `all`) and `context` (extra data fenced into the prompt). Output `out = {summary, branch, commits, files, data?}`, `error`. Planner `dynamic` sub-DAGs keep working (planner children are AI steps in the planner's scope). Runs on the four runtimes with fallbacks, accounts, routing. | 14.0 |

Integrator (master-managed merge pipeline, ADR-0041) and the after-node `deploy` field stay; in v2 the editor offers the
deploy as a separate `deploy.*` node connected after the step, which is normalised to the same ops request.

### 3.3 Control flow (all master pure)

| Type | Ports | Semantics | Ph |
| --- | --- | --- | --- |
| `control.if` | in → `true`, `false` | `condition` (*expr* → boolean; non-boolean = `type_error`) | 14.1 |
| `control.switch` | in → one port per case + `default` | `value` (*expr*), cases `{name, equals \| match (expr)}` ≤ 20, first match wins (or `all` mode: every match) | 14.1 |
| `control.merge` | `in` (many) → `out` | join `all \| any \| first \| atLeast n`; output `{values: [...], from: [...]}` or `combine: object` (keyed by source node) | 14.1 |
| `control.forEach` (group) | `in` → outer `results`, `done`, `error`; inner `item` → body | `items` (*expr* → array ≤ 1 000), `concurrency` 1–20 (default 4), `onItemError: fail \| continue \| collect`; body = child nodes; `results` = array of the body's `return` values in item order | 14.1 |
| `control.loop` (group) | as forEach | "repeat until": `while` (*expr*), `maxIterations` ≤ 100 (required), iteration state `$loop` | 14.1 |
| `control.delay` | in → out | `duration` (ISO 8601 or seconds, ≤ 30 d; *expr* allowed, bounded) — persisted timer | 14.1 |
| `control.waitUntil` | in → out, `timeout` | `at` (*expr* → instant ≤ 90 d ahead), `late: run \| skip` after an outage | 14.1 |
| `control.approval` | in → `approved`, `denied`, `timeout` | `approverRole`, `title`/`details` (*expr*, rendered as untrusted text), `timeoutSec`; human + gate role + step-up (today's gate, now a node with outcomes) | 14.1 |
| `control.waitWebhook` | in → `received`, `timeout` | creates a single-use resume URL (`/v1/hooks/wait/:token`, HMAC like automation webhooks), `timeoutSec` ≤ 30 d, body schema; the URL is available to downstream as `$node.<id>.url` *before* waiting (send it via HTTP / chat) | 14.2 |
| `control.subWorkflow` | in → out, `error` | `workflow` (static: project + name, `version: latest \| n`), `inputs` (*expr*), `wait: true \| false`; child run pinned at call time, depth ≤ 3, cancellation propagates both ways | 14.1 |
| `control.stop` | in | ends the run `succeeded` (other open work cancelled), `outputs` (*expr*) = run outputs | 14.1 |
| `control.fail` | in | ends the run `failed` with `reason` (*expr*, clipped) | 14.1 |
| `control.return` | in (inside a group or sub-workflow) | the value of this iteration / the sub-workflow's output | 14.1 |
| `control.respond` | in | answers a waiting `trigger.webhook` (`status` 200–299, JSON body ≤ 64 KiB) | 14.2 |

Try/catch: every node's `error` port (§2.3) plus the run-level `settings.onFailure` error workflow (14.4). A
`control.try` group is not needed: a group's `error` port catches its body.

### 3.4 Data (master pure, JSONata)

| Type | Semantics | Ph |
| --- | --- | --- |
| `data.set` | build an object from fields (`name → expr`), `keepInput: bool` | 14.1 |
| `data.transform` | one JSONata expression `$input → out` | 14.1 |
| `data.filter` | `items` (*expr* array), `keep` (*expr* per item) → `kept`, `dropped` | 14.1 |
| `data.aggregate` | group-by / sum / count / min / max / concat over an array (form that compiles to JSONata) | 14.1 |
| `data.split` | array → `items` port values for a forEach, or string split | 14.1 |
| `data.template` | text from a template (`{{ }}`), output `text` — for messages, comments, prompts' data | 14.1 |
| `data.parse` | JSON / CSV (≤ 1 MiB, ≤ 10 000 rows) / YAML (core schema, bounded aliases, the editor's `yaml` 2.9.1) / form-encoded → JSON | 14.1 |
| `data.validate` | check against a `DataSchema` → `valid`, `invalid` (with paths) | 14.1 |
| `data.dateTime` | parse / format / add / diff with time zones (via `@remyral/protocol` `zoned-time.ts`, no new dependency) | 14.1 |

### 3.5 Integrations

| Type | Placement | Semantics | Ph |
| --- | --- | --- | --- |
| `notify.users` | MI | platform notification (new kind `workflow.notify`) to recipients chosen **statically**: run creator, project role ≥ X, named users of the project; channels per the users' own preferences (in-app, email, push, webhook). Title / body *expr* (plain text, clipped) | 14.2 |
| `chat.message` | MI | post into the run creator's ops chat thread (or a named thread the creator owns) as a "workflow" message; text *expr*, rendered as text | 14.2 |
| `jobs.create` | MI | submit a job (JobSpec fields static; prompt template with data fenced) as the run's run-as user, `wait: true \| false`; quotas, routing, approvals as for any job. (`ai.step` is the in-graph variant; this one creates a detached job.) | 14.2 |
| `deploy.coolify` / `deploy.pages` / `dns.change` | MI | ops action (ADR-0028) — kind, target **static**, resolved from the project's deploy targets; policy decides (production waits for approval + always-fresh step-up); outputs `{actionId, state, url}`; the node waits for the action's terminal state | 14.2 |
| `github.comment` | MI | comment on a PR (body *expr*) of **the project's repository** via the GitHub App (pull requests: write — granted) | 14.2 |
| `github.pullRequest` | MI | open / update a PR from a branch produced by an upstream AI step (`git-ref`), title/body *expr*; never merges (merges stay p4-git-flow behind `git.merge` approval) | 14.2 |
| `github.label` / issue comment | MI | needs `issues: write` on the App manifest (ADR-0022 change, owner re-consents) — deferred | 14.4 |
| `uptime.check` | MI | one HTTP(S) / TCP check via the existing guarded `Probe` (`uptime/probe.ts`): public addresses only, no headers, no credentials, 64 KiB, redirects re-checked → `{up, status, latencyMs}` | 14.2 |
| `http.request` | **W** | method, `origin` (scheme + host + port **static**; K1: any public address, LAN / private / loopback / link-local / metadata always refused; ports 80 / 443 / 8080 / 8443, others only via the project allowlist), path / query *expr* (encoded), headers (credential and hop-by-hop names refused, *expr* values), body (JSON / form / text, *expr*), `auth` = vault credential reference (static, `http-auth`, host-bound), timeout ≤ 120 s, response ≤ 1 MiB (stored ≤ 256 KiB), `responseType json \| text \| binary→file`, `retry` (§5.4), `successStatus` (default 2xx) → `out {status, headers (allowlisted), body}`, `error` | 14.3 |
| `email.send` (K4) | **W** | SMTP via a provider preset (gmail, outlook, office365, sendgrid, mailgun, ses-*, postmark, brevo, yandex) or `custom` (host — public, port 25 / 465 / 587 / 2525, TLS `tls` \| `starttls`, never plaintext), username, password = vault credential `smtp` bound to the host — **all static**, as is the sender `from`; `to` / `cc` / `bcc` / `replyTo` / `subject` / `text` / `html` *expr*; `maxRecipients` (≤ 50, default 10) after evaluation → `out {messageId, accepted}`, `error`. Sent by a worker function job (feature `function-v1`); the master's own SMTP stays for platform notifications only. Needs `workflows.define.network` + step-up | 14.3 |

### 3.6 Code

| Type | Placement | Semantics | Ph |
| --- | --- | --- | --- |
| `code.js` | W (container) | function body `(input, ctx) => output`; Node.js image pinned by digest; stdin JSON in, stdout JSON out (≤ 256 KiB); no network, read-only root, tmpfs `/tmp` 16 MiB, 256 MiB RAM, 0.5 CPU, pids 64, timeout ≤ 60 s (default 10 s); no secrets | 14.3 |
| `code.python` | W (container) | same contract with a pinned Python image; standard library only (no pip at run time) | 14.3 |

Pure JSONata on the master covers most transformation needs; code nodes exist for what JSONata cannot express, and
always run off the control plane.

## 4. Expression language

### 4.1 Requirements

Safe on the master (no I/O, no prototype access, no `eval`), bounded (time, depth, memory, output size), deterministic
(same input ⇒ same output; needed for replay and test-run), expressive enough for transforms (map / filter / group /
string / number / date), small, permissive license, exact pin, maintained.

### 4.2 Options

| Option | License / size | Safety | Determinism | Transforms | Verdict |
| --- | --- | --- | --- | --- | --- |
| **JSONata** `jsonata@2.2.2` (published 2026-07-16) | MIT, **no dependencies**, 80 KB min / 299 KB source | No host access (own evaluator, no JS `eval`); built-in **guardrails** `jsonata(expr, {timeout, stack})` → `D1012` / `D1011` (verified in the 2.2.2 tarball, `jsonata.js:5579-5677`, and in the current docs via ctx7 `/jsonata-js/jsonata` "guardrails.md"); guardrails are checked between evaluation steps, so a single catastrophic regex inside `$match` / `$replace` is not interrupted → hard isolation needed (§4.4) | `$now()` / `$millis()` are fixed per evaluation (docs) and can be shadowed by bindings; `$random()` and `$eval()` must be shadowed / refused | full (paths, predicates, map/filter/reduce, group-by objects, string/number/date functions, custom functions via `registerFunction`) | **Recommended** |
| CEL (`@marcbachmann/cel-js@8.0.0` MIT, `@bufbuild/cel@0.6.1` Apache-2.0) | 227 KB / 901 KB | non-Turing-complete, very safe | yes | weak for reshaping JSON (macros `map`/`filter`/`exists`, no object construction ergonomics) | good for conditions only; no ctx7 documentation available for the JS implementations (checked), so APIs unverified |
| JMESPath (`jmespath@0.16.0` Apache-2.0, last release 2022; community fork MPL-2.0) | 81 KB | safe | yes | query only, no arithmetic/string building | stale / too limited |
| Own minimal templating (paths + filters) | 0 | safest | yes | we would re-invent JSONata | only as the fallback of D-none |
| JavaScript in a VM (`node:vm`, isolated-vm) | — | `node:vm` is not a security boundary; isolated-vm is native | — | full | rejected on the master; JS lives in `code.js` on workers |

### 4.3 Recommendation

**JSONata 2.2.2** as the one expression language (templates `{{ … }}` and whole-value `$expr`), exact pin in
`packages/workflow-expr` (new pure package; used by the master and — for preview only — lazily by the web editor), lock
integrity, `pnpm security:pins`, `minimumReleaseAge` satisfied (published three months ago), dependency-policy owner
review. ADR-0055 records the choice. Upgrades follow the dependency cadence with the determinism test corpus (§11).

### 4.4 Sandbox on the master

- **Compile once** per definition version (cache by `sha256(expr)`), with `{timeout: 50 ms, stack: 200}`.
- **Bindings** shadow non-determinism and escape hatches: `$now`/`$millis` → the node run's scheduled time;
  `$random`, `$eval`, `$clone` (unbounded copies) → refused at **validation** (static scan of the AST via
  `jsonata(expr).ast()`; refusal code `expr_function_not_allowed`), and bound to throwing stubs as a second line.
  Custom functions added: `$uuid5(ns, name)` (deterministic), `$hash(s)`, `$urlEncode`, `$base64`, `$jsonParse` (bounded).
- **Regular expressions**: JSONata regex literals compile to JS `RegExp` (ReDoS). Validation refuses regexes longer
  than 200 characters and with nested quantifiers (static heuristic), and the evaluation runs in isolation anyway:
- **Isolation**: evaluation happens in a small pool of `node:worker_threads` (2 threads, `resourceLimits:
  {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4}`), input ≤ 1 MiB, output ≤ 256 KiB
  (serialised size check), **hard deadline 250 ms** enforced from the main thread with `worker.terminate()` (a
  terminated thread is replaced). The orchestrator's event loop is never blocked by user expressions.
- Budget per tick: ≤ 500 master-pure node runs globally, ≤ 100 per run (a 1 000-item forEach spreads over ticks).
- Errors are codes + JSONata position only (`expr_error:D1012@14`), never input data.

## 5. Execution placement and engine semantics

### 5.1 Placement rules (the key decision)

1. **The master never opens a connection to a host chosen by a workflow author or by data**, with exactly two guarded
   exceptions that already exist: provider APIs of master-held integrations (Coolify instances configured by an admin,
   Cloudflare, GitHub, SMTP / push / notification webhooks — ADR-0028 / ADR-0022 / p5-notifications) and the uptime
   `Probe` (public addresses only, no headers / credentials / bodies, p8-uptime). No other node type gets a master
   network path. This keeps the VPC, IMDS (`169.254.169.254`), Postgres / Redis and Coolify's internal network out of
   reach (SSRF).
2. **Master-pure nodes** do no I/O at all: the executor for them receives only the node's config and input values and
   returns a value / port / timer request. They are deterministic and bounded (§4.4), so re-executing one on recovery
   is harmless (idempotent by construction).
3. **Anything with arbitrary network or code** runs on a worker as a **function job** (§5.2). Workers are outbound-only
   home / office machines; their HTTP requests and SMTP connections are subject to the same non-public-address rule
   (the LAN is as sensitive as the VPC: routers, NAS, other machines). K1: any public address is allowed by default;
   a project may turn its egress allowlist on (§8.4).
4. **AI steps** are unchanged jobs.

### 5.2 Function jobs on workers (`kind: "function"`)

Protocol (additive in 1.0, sent only to workers advertising the features):

```ts
// packages/protocol/src/master-messages.ts — JobSpec additions
kind: z.enum(['machine-admin', 'integration', 'function']).optional(),
function: FunctionSpec.optional(),   // exactly with kind 'function'

const FunctionSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), request: HttpRequestSpec, idempotencyKey: z.string().max(128),
             credential: z.object({ id: VaultCredentialId, version: z.number().int(), placement: z.enum(['header', 'query', 'basic']),
                                    name: z.string().max(64) }).optional() }),
  z.object({ type: z.literal('code'), language: z.enum(['js', 'python']), source: z.string().max(64 * 1024),
             input: z.unknown(), imageDigest: Sha256Ref }),
  // K4: e-mail — the server and credential come from the node's static config, the message from evaluated expressions.
  z.object({ type: z.literal('email'), idempotencyKey: z.string().max(128),
             smtp: z.object({ host: z.string(), port: z.number().int(), tls: z.enum(['tls', 'starttls']),
                              username: z.string().max(256) }),
             credential: z.object({ id: VaultCredentialId, version: z.number().int() }),
             message: z.object({ from: MailAddress, fromName: z.string().max(100).optional(), to: z.array(MailAddress),
                                 cc: z.array(MailAddress), bcc: z.array(MailAddress), replyTo: MailAddress.optional(),
                                 subject: z.string().max(998), text: z.string().optional(), html: z.string().optional(),
                                 messageId: z.string().max(200) }) }),
]);
```

- Features: `function-v1` (HTTP) and `function-code-v1` (code; only workers with a ready container engine,
  `sandboxStatus`). Placement refuses other workers (`function_unsupported`), exactly as `integration-v1`
  (`orchestrator.ts:1233`). The JobSpec `runtime` is a label (as for integration jobs); `prompt` carries a fixed
  description; no repository / workspace checkout (a scratch dir only), no runtime admission, no model, no
  continuity, no previews.
- **Slots**: function jobs do not consume AI runtime slots. Workers report a separate `profileConcurrency.function`
  (ADR-0033 per-profile slots; default 8) so quick HTTP calls are not stuck behind long agent jobs; urgent reserve does
  not apply. Queue class: the run's priority (urgent / normal / background) as for AI steps.
- **Result**: `JOB_RESULT` with the artifact `function-result.json` (`{status, headers, body | file, durationMs}` or
  `{output}` for code), redacted on the worker (known credential value + patterns) and again on the master, bounded.
- **Offline / no capable worker**: the job waits in the queue like any job. Each function node has `queueTimeoutSec`
  (default 600) — when it expires the job is cancelled and the node fails with `no_worker` (→ error port / policy). The
  editor shows "bu düğüm worker gerektirir; uygun çevrimiçi worker: N" from capabilities.
- **Lease loss / at-least-once**: the job may run twice (lease expired while the request was in flight). The HTTP
  request carries `Idempotency-Key: <idempotencyKey>` (= `sha256(run, node, scope, iteration)`, identical across
  attempts) so providers that honour it deduplicate; results are accepted only under the current lease epoch
  (fencing, ADR-0004) and the node run takes the first accepted result. Non-idempotent methods (POST / PATCH / DELETE)
  are retried automatically only with `retry.safe: true` (author's assertion, as `retry-safe` today); default: GET /
  HEAD / PUT retry, others not.

### 5.3 Durable per-node-run state machine (engine 2)

Table `workflow_node_runs` (§9) holds one row per **(run, node, scope, iteration)**. States:

```
pending ──ready──▶ ready ──claim──▶ running ──▶ succeeded
   │                 │                │  └──▶ waiting (timer | webhook | approval | job | child run | ops action)
   │                 │                │             └──resume──▶ running
   │                 │                └──▶ retry_wait (backoff timer) ──▶ ready
   └──all skips──▶ skipped        any ──cancel──▶ cancelled      running ──▶ failed
```

- **Driver**: the existing tick step `workflows` handles engine-1 runs as today and engine-2 runs with a new interpreter
  (`apps/master/src/workflows/v2/`). In addition, events nudge a run immediately through a BullMQ hint
  `wf-progress:<run>` (job finished, webhook arrived, approval decided, ops action finished, child run finished); the
  2 s tick stays the backstop (ADR-0003: hints are never the truth).
- **Claiming** (multi-master safe, ADR-0039 standby): per run the advisory lock `wf:<run>` (as today) + each node run
  has a `version` column; transitions are `UPDATE … WHERE id = $1 AND version = $2` (lost race ⇒ re-read). Timer scan:
  `SELECT … FROM workflow_node_runs WHERE state IN ('waiting','retry_wait') AND due_at <= now() ORDER BY due_at
  LIMIT 500 FOR UPDATE SKIP LOCKED`.
- **Master-pure node**: ready → running → (evaluate in the sandbox) → succeeded / failed / waiting(timer) in one
  transaction with the output write. A crash before commit re-runs it (pure ⇒ same result).
- **Master integration node** (side effect): an **outbox row with a unique key** is written in the same transaction
  that moves the node run to `waiting` — `workflow_side_effects(node_run_id UNIQUE, kind, idempotency_key, external_ref)`.
  The integration (ops action, notification, GitHub call, job submission) is created from the outbox exactly once; a
  retry after a crash finds the existing row / external ref (ops actions and jobs already have their own ids; GitHub
  comments are re-found by a hidden marker `<!-- remyral:<idempotency_key> -->` before posting again). The node resumes
  when the integration reaches a terminal state.
- **Worker node** (function / AI): the job is created when the node run becomes ready (not up front), linked in
  `workflow_node_run_jobs` (append-only, every attempt). The dispatch admission recognises engine-2 jobs by this link
  and admits them only while the node run is `running`; the engine-1 `workflow_node_jobs` path is unchanged.
- **Timers are rows, not memory**: `control.delay`, `waitUntil`, timeouts, `retry_wait` backoff and approval / webhook
  timeouts set `due_at`. They survive restarts and master outages; on recovery, overdue timers fire in order (for
  `waitUntil` with `late: skip` the node takes `timeout`). Resolution ≈ the tick (≤ 2 s); not suitable for sub-second
  scheduling (documented).
- **Retries / backoff** per node: `retry: {max ≤ 10, backoff: fixed | exponential, initialSec, maxSec ≤ 3600, jitter,
  on: [codes], safe}`; AI steps keep `maxRetries ≤ 3` (cost). Each attempt is a new attempt row (`attempt`), same
  idempotency key.
- **Timeouts** per node: `timeoutSec` (running → failed `timeout`, open job cancelled); per run `settings.timeoutSec`
  (default 7 d, max 90 d).
- **Cancellation propagation**: cancel run ⇒ every open node run `cancelled` in one transaction; their jobs get
  `CANCEL_JOB` (as `cancelRun` today); pending ops actions are cancelled if still awaiting approval (an action already
  executing is left to finish and recorded); child runs (`subWorkflow`) cancelled recursively; waits / timers dropped;
  webhook wait tokens revoked. `first` joins and `control.stop` cancel siblings the same way. Project kill switch
  cancels engine-2 runs too.
- **Pause / resume** (14.4): run `paused` ⇒ no node run is released or claimed; running jobs continue (option "pause
  and cancel running jobs"); timers that come due while paused fire on resume (or, per wait node, `late: skip`).
  Audited `workflow.run.pause|resume`.
- **Concurrency per workflow** (14.4): `settings.concurrency {max 1–50, onLimit: queue | skip | cancelOldest}`,
  optional `key` (*expr* over the trigger, e.g. PR number — one run per key). Implemented by a run state `queued`
  before `active` and a check under the per-name advisory lock at start; automations' own concurrency policies still
  apply before.
- **Limits per run**: ≤ 10 000 node runs, ≤ 64 MiB payloads, forEach ≤ 1 000 items, loop ≤ 100 iterations, nesting
  ≤ 3, sub-workflow depth ≤ 3, ≤ 20 concurrent worker jobs per run (configurable per project); exceeding ⇒ node
  `limit_exceeded`.

### 5.4 Run history, data retention, redaction

- Each node run stores **input** (the resolved input port values, after expression evaluation of the config — what the
  node actually used) and **output** (port + value), inline ≤ 16 KiB, else in `workflow_payloads` by hash (≤ 4 MiB).
  The UI shows sizes and truncation.
- **Redaction**: before storage every value passes the platform `Redactor` (secret patterns) and, for worker results,
  the worker-side redaction of the exact credential value; header names in the deny list (`authorization`, `cookie`,
  `set-cookie`, `proxy-authorization`, `x-api-key`, …) are never stored or passed downstream; config fields holding
  credential references show the reference only.
- **Retention**: payloads of finished runs are pruned after the project's `workflowDataRetentionDays` (default 30,
  1–365; `pruned_at` kept, metadata and audit forever). Waiting runs never lose data. Viewers see data only for
  projects they can read (`workflows.read`), like job results today.

### 5.5 Replay and re-run from a node (14.4)

- **Re-run from node X**: a new run (`rerun_of`, `rerun_from_node`) of the **same definition version**, whose node runs
  upstream of X (all ancestors of X in every scope) are copied as `succeeded` with their recorded outputs (no side
  effect is repeated); X and its descendants run fresh. Allowed only when the source run is finished and its payloads
  are not pruned. Side-effecting nodes downstream run again — the dialog lists them ("bu düğümler yeniden çalışacak:
  deploy.preview, github.comment").
- **Re-run with the latest version**: allowed when node ids and port names of the ancestors are unchanged (checked);
  else refused with the reason.
- **Deterministic replay** of master-pure nodes is guaranteed by §4.4; AI and HTTP results are recorded, not
  recomputed.

### 5.6 Versioning

Runs are pinned to `definition_id` (as today). A waiting run keeps its version for its whole life; a new version never
changes running instances. Sub-workflow calls record the callee version used. Trigger bindings fire "latest" (default)
or a pinned version. Archiving a workflow refuses new runs; waiting runs continue (unchanged rule).

### 5.7 Migration of existing (AI-only) definitions — parity

- Stored v1 documents are valid v2 documents after `normaliseV1` (property-tested on every stored definition by a
  dry-run script before release: normalise → validate v2 → serialise round trip).
- **Engine selection** at run start: `engine = 1` for documents without `schemaVersion: 2` while the feature flag
  `WORKFLOW_ENGINE_V2_FOR_V1` is off (default through 14.4); `engine = 2` for v2 documents. Running instances never
  switch engines.
- **Parity suite**: the whole `workflows.test.ts` (A-ORCH-1 fan-out/fan-in over three real workers, fail-fast,
  continue, retry-safe, gates, cancel, kill switch, planner expansion, integrator, deploy step, reuse, workspace
  `out/ → in/`) runs against both engines; 14.5 flips the flag after the suite and a shadow period are green, and the
  engine-1 code stays for runs that started on it.
- Feature inventory that must survive (parity rule): roles, planner `dynamic` sub-DAGs + p8-orchestration hints,
  integrator via master merge pipeline, approval gates with role + step-up, failure policies, runtime fallbacks /
  accounts / routing / deferrable / reuse, siteBundle + deploy steps, workspace files, priority classes, layout
  positions, archive / duplicate / versions / diff, chat `draft_workflow` and `draft_workflow_run`, automations /
  schedules with workflow targets, kill switch, run page with live states.

## 6. Triggers ↔ automations (details)

- Activation route (§10) reconciles: for each trigger node, create / update / pause one automation (`target.kind =
  workflow`, `workflow_trigger_node = <id>`); removed trigger nodes pause their automation (history kept). The run-as
  user is the activating user (re-checked at every fire, as today). Activating a `trigger.webhook` or
  `trigger.github` requires `automations.external` (admin) + step-up — unchanged policy.
- **Event data becomes typed data** (`$trigger`) — a change from "fenced context only". Rules: `$trigger` is
  **untrusted** for webhook / GitHub / workflow / chat sources; it may flow into conditions, transforms, notification
  text, AI context (fenced), HTTP path / query / body and code input, but never into static fields (§8.3). The
  existing fenced event block for AI steps stays.
- `trigger.workflow` extends chain triggers to "a workflow (project + name) finished with outcome X", payload = the
  source run's outputs (`control.stop.outputs` or the sinks' values).

## 7. Editor UX (Diyalog)

### 7.1 Palette and canvas

- **Palette** replaces "Adım ekle" (toolbar button + `/` shortcut + drag from a side drawer): categories
  Tetikleyiciler · Yapay zekâ · Akış kontrolü · Veri · Entegrasyonlar · Kod, search, per-node one-line description,
  disabled entries with the reason ("yetkiniz yok: workflows.define.network", "uygun worker yok"). Keyboard: ↑/↓, Enter
  adds after the selected node.
- **Cards** keep 232 px width; height grows with ports. Input handles left, output handles right (or top/bottom in TB
  layout), each with a small label (`true`, `false`, case names, `error` in the error colour, `done` / `results` for
  groups). Groups render as React Flow parent nodes (sub-flows) with a header and collapse; dagre lays out each group
  body, then the top level.
- **Edges** show the branch label of their source port (`true` / `false` / case) and, on runs, the item count / skip
  state (dashed grey = skipped path).
- Connecting: `isValidConnection` checks port direction, `many`, schema compatibility, scope boundary and cycles (pure
  `model.ts` extensions, each refusal in words).

### 7.2 Node configuration panel

The inspector becomes schema-driven: forms generated from the catalog's zod config + UI metadata (labels, help,
static / expression toggle per field). Static fields are plain inputs (selects for workflows, credentials, deploy
targets, repositories — choices fetched from the master, never typed). Expression-capable fields show an `fx` toggle.

### 7.3 Expression editor with autocomplete

- A lightweight in-house editor (textarea + overlay highlighting of `{{ }}` and JSONata tokens, no new dependency in
  14.1; CodeMirror 6 can be proposed later under its own review).
- **Autocomplete** from (a) declared output schemas of ancestor nodes, (b) the last run's recorded data (sampled, ≤ 32
  KiB), (c) `$inputs`, `$trigger` schema (per trigger type), `$item`, `$run`, and the allowed JSONata functions with
  signatures.
- **Live preview**: as you type, `POST /workflows/expressions/evaluate` runs the expression on the master sandbox against
  sample data (last run or user-entered JSON) and shows result / error position (debounced 400 ms, per-user rate
  bucket).

### 7.4 Test-run a single node

"Bu düğümü dene": sample input (from the last run, an upstream test result, or typed JSON) → result in the panel.
Master-pure nodes evaluate immediately (nothing stored except an audit line). Side-effecting nodes ask for explicit
confirmation ("Bu test gerçek bir istek gönderir / bildirim yollar") and, for network / code / deploy nodes, step-up;
HTTP and code tests run as real function jobs on a worker (`test: true`, own run kind, not in statistics); deploy nodes
cannot be test-run (only "dry run": the ops action's plan / diff without execution, existing ADR-0028 diff).

### 7.5 Run view

The run page (`/jobs/workflows/:runId`) uses the same canvas: node states with colours and the breathing dot, edge item
counts, skipped paths dashed. Selecting a node shows its node runs (attempts, iterations with a selector for forEach /
loop, timings, placement — master / worker name), **input and output JSON** (collapsible tree, sizes, "kırpıldı",
"budandı" after retention), the error, the job link for worker nodes, waiting reasons with the due time ("23:00'te
devam edecek") and actions (approve / deny, resume a manual wait, cancel, re-run from here). Polling 3 s as today plus
the live stream when available.

### 7.6 YAML view, validation

The YAML / JSON panel keeps working (v2 fields round-trip; `config` objects are plain data). Validation issues map by
path to nodes / ports / edges as today (`nodes.<i>.config.<field>`, `edges.<i>.fromPort`) with new words in `issueText`;
expression errors show the JSONata position under the field.

### 7.7 Phone (< 768 px)

Default **view + act**: workflows list, run view (vertical list of nodes in topological order instead of the canvas,
with the canvas available read-only), approve / deny gates with step-up, resume / cancel waits, re-run. Editing on the
phone is optional and off by default (an "Düzenlemeyi aç" switch opens the existing editor; the Bağla mode remains the
touch way to connect). Push notifications for `control.approval` and failed runs use the existing push channel.

## 8. Security review

### 8.1 Threats

| Threat | Mitigation | Residual |
| --- | --- | --- |
| **SSRF from the master** (IMDS, VPC, Postgres, Redis, Coolify internals) | §5.1: no master network path for author-chosen hosts; only master-held integrations to admin-configured provider hosts and the guarded uptime probe; tested with `169.254.169.254`, `127.0.0.1`, private, IPv6 ULA, DNS rebinding, redirect-to-private | Bugs in the probe guard (existing, tested) |
| **SSRF / LAN access from workers** | HTTP / SMTP: http/https (SMTP: 25/465/587/2525 with TLS) only, ports 80/443/8080/8443 + allowlisted `host:port`, private / loopback / link-local / metadata IP literals and internal names refused at save (`isForbiddenHost`, `packages/workflow-nodes`), DNS resolved by the worker with every address checked against the forbidden ranges (reuse `isForbiddenAddress`, `apps/worker/src/sandbox/network.ts`), connect to the checked address (no re-resolve), redirects ≤ 3 each re-checked, no proxy env inheritance, no cookies; optional project egress allowlist (§8.4) | K1: any public host is reachable by design (open by default); the project allowlist switch narrows it |
| **Mail relay abuse (K4)** | SMTP server, credential and sender static; recipients bounded (`maxRecipients` ≤ 50 after evaluation, ≤ 50 literal); worker-only; `define.network` + step-up on the privileged delta; per-project function-job caps; audit of every send (no bodies) | A workflow can mail data-chosen addresses within the bound — the owner's choice (K4) |
| **Secret disclosure** | Secrets only as vault references (§8.2); values decrypted only on the worker for the bound host; never in definitions (static scan of config strings with the secret patterns → `secret_in_definition`), node data, logs, audit or chat; deny-listed headers dropped | A remote API echoing the secret back is redacted by exact value on the worker |
| **Secret exfiltration via templated URLs** | credential bound to `allowedHosts` (§8.2); host is a static field; worker refuses to attach the credential to another host even after a redirect | — |
| **Prompt injection from HTTP responses / webhooks / AI outputs into AI steps** | All such values are untrusted data: AI prompts get pointers only and values in fenced blocks (ADR-0010, `WorkflowContextProvider`), fence markers neutralised; AI steps cannot change graph, static fields, approvals, deploy policy, credentials | Models may still be influenced; human gates remain the control for sensitive actions |
| **Data-driven privilege escalation** | Static-only fields (§8.3) — nothing that selects a host, credential, deploy target, environment, repository, runtime, sandbox profile, approver role, recipient set, sub-workflow or machine can come from an expression | — |
| **Runaway resource use** | expression sandbox (§4.4); per-run limits (§5.3); per-project caps on concurrent function jobs (default 10) and runs; function job timeouts; container limits for code; `maxRunsPerHour` on triggers; kill switch | Many workflows across projects bounded by quotas |
| **Duplicate side effects** | idempotency keys + outbox uniqueness (§5.3); fencing by lease epoch; non-idempotent methods not retried by default | Providers that ignore `Idempotency-Key` may see a duplicate after a lease loss mid-request (documented; `retry.safe` is the author's assertion) |
| **Webhook forgery / replay** | trigger webhooks: existing HMAC + timestamp ± 5 min + single-use nonce + optional IP allowlist; wait-for-webhook: 256-bit single-use token (stored as SHA-256) **and** HMAC with the workflow's webhook secret by default (token-only mode is a per-node opt-in, admin), expiry, body ≤ 64 KiB, payload treated as untrusted | Token-only mode relies on URL secrecy |
| **Repudiation** | every state transition of runs / node runs recorded (`workflow_node_runs` history + audit `workflow.*`), side effects with actor = run-as user + `via workflow run`, denials audited | — |
| **Unsafe deploys** | deploy / DNS nodes go through ADR-0028 ops actions and the project's deploy policy (production: approval + always-fresh step-up, never lowered); the workflow cannot pre-approve production unless ADR-0030 pre-approval was given by a human at save time with step-up | — |
| **Code node escape** | container profile only, `--network none`, read-only root, non-root user, seccomp default, pinned image digests, no host mounts except the scratch dir, no secrets, timeouts; workers without a ready container engine never receive code jobs | Container escape CVEs (images and engine updated per policy) |

### 8.2 Vault references for HTTP

- New vault credential kinds `http-auth` (header / bearer / basic / query parameter) and `smtp` (K4: the SMTP
  password) with metadata `allowed_hosts text[]` (exact `host[:port]`, ≤ 16, required for both kinds) set by an admin
  at creation (always-fresh step-up, ADR-0016 unchanged: the browser seals the value per worker).
- A node references `{ "credential": "<id>" }` (static). Placement restricts the job to workers that hold the current
  version of the credential (like `worker:<id>/secret:` pins). The worker attaches it only if the request host is in
  `allowed_hosts`, never logs it, redacts its exact value from the response, and reports `credential_host_refused`
  otherwise.

### 8.3 Static-only fields (cannot be expressions)

Host / origin of `http.request`, credential references, deploy kind / target / environment, DNS records, repository,
GitHub target (always the project's repository), notification recipients, chat thread, sub-workflow identity and
version, runtime / model / sandbox profile / approval policy / requirements / machine of AI steps and jobs, approver
roles, trigger configuration, code source, container image, limits. Validation code `static_field`.

### 8.4 Egress policy for HTTP nodes

Owner decision K1: per project `workflow_egress`: `mode open | allowlist` (**default `open`**: any public address),
hosts (`EgressHost` shape, ≤ 64) — in `open` mode a suggestion list shown in the editor, in `allowlist` mode the only
hosts HTTP and e-mail nodes may reach. There are no internal-host exceptions: LAN / private / link-local / loopback /
metadata addresses are refused in every mode. Changing the policy: `workflows.egress.write` (admin) + always-fresh
step-up, audited, notified to project admins. The master validates the node's static host against the policy at save
and at run; the worker re-checks (defence in depth: the master sends the effective policy in the FunctionSpec).

### 8.5 RBAC (new actions in `apps/master/src/authz/model.ts`, project scope)

| Action | Min role | Purpose |
| --- | --- | --- |
| `workflows.define` (existing) | operator | save versions with AI / control / data / notify / chat / jobs nodes |
| `workflows.define.network` | admin | save a version that adds or changes `http.request`, `uptime.check`, `github.*` or `control.waitWebhook` (token-only) nodes |
| `workflows.define.code` | admin | add or change `code.*` nodes |
| `workflows.define.deploy` | admin | add or change `deploy.*` / `dns.change` nodes (the ops policy still decides each action) |
| `workflows.activate` | operator (+ `automations.external` for webhook / GitHub triggers) | enable / disable trigger bindings |
| `workflows.test` | operator (+ the matching `define.*` for side-effecting nodes) | expression preview, single-node tests |
| `workflows.run` / `workflows.approve` / `workflows.read` (existing) | operator / operator + gate role / viewer | unchanged, extended to pause / resume / re-run / waits |
| `workflows.egress.write` | admin | project HTTP egress policy |

**Step-up**: saving a version whose diff against the previous version adds or changes any node gated by a
`define.network | code | deploy` action requires a fresh step-up (the "privileged delta" — same approach as automation
creation); activation of external triggers: step-up; egress policy: always-fresh. Each run re-checks that the run-as
user still holds the actions its nodes need (as automations do) — a demoted author's workflow stops at start with
`run_as_not_allowed`.

## 9. Data model — migration `0103_workflow_engine.sql` (additive)

| Change | Details |
| --- | --- |
| `workflow_runs` + columns | `engine smallint NOT NULL DEFAULT 1 CHECK (engine IN (1, 2))`; `parent_run_id uuid NULL REFERENCES workflow_runs`, `parent_node_run_id uuid NULL`; `rerun_of uuid NULL`, `rerun_from_node text NULL`; `trigger_kind text NULL`, `source_trust text NULL CHECK (IN ('trusted','untrusted'))`; `concurrency_key text NULL`; `outputs jsonb NULL`; `paused_at`, `paused_by`. State CHECK **widened** with `queued`, `active`, `paused` — engine-2 open states that engine-1 code does not select (`RUN_OPEN`), so a code rollback freezes engine-2 runs instead of misinterpreting them. The identity-immutability trigger (`0017:173-191`) is extended to the new identity columns. Index `(state) WHERE engine = 2 AND state IN ('queued','active','paused')`. |
| `workflow_node_runs` (new) | (14.0 adds `reason text` ≤ 1000 for state notes and `CHECK ((state = 'waiting') = (wait_kind IS NOT NULL))`.) `id uuid PK`, `run_id`, `node_id text` (v2 id regex), `node_type text`, `scope text` (`''` or `forEachId[3]/loopId[1]`, ≤ 200), `attempt int`, `state text CHECK (pending, ready, running, waiting, retry_wait, succeeded, failed, skipped, cancelled)`, `wait_kind text NULL CHECK (timer, webhook, approval, job, child_run, ops_action, side_effect)`, `due_at timestamptz NULL`, `placement text CHECK (master, integration, worker)`, `output_port text NULL`, `input jsonb NULL`, `output jsonb NULL` (inline ≤ 16 KiB or `{"$payload": sha}`), `error jsonb NULL` (`{code, message ≤ 1000}`), `idempotency_key text NOT NULL`, `version int NOT NULL DEFAULT 0`, gate columns (`gate_role`, `gate_decision`, `gate_decided_by`, `gate_decided_at`), `scheduled_at`, `started_at`, `ended_at`, `created_at`, `updated_at`. UNIQUE `(run_id, node_id, scope, attempt)`. Partial index `(due_at) WHERE state IN ('waiting','retry_wait') AND due_at IS NOT NULL`; index `(run_id, state)`. No DELETE (trigger); terminal rows immutable except `output`/`input` pruning to `{"$pruned": true}`. |
| `workflow_node_run_jobs` (new, append-only) | `(node_run_id, job_id UNIQUE, kind ai\|function, created_at)` — what the dispatch admission reads for engine-2 jobs. |
| `workflow_payloads` (new) | `(run_id, sha256, size_bytes ≤ 4 MiB, content bytea, redacted bool, created_at, pruned_at)`, PK `(run_id, sha256)`; pruning nulls `content`. |
| `workflow_side_effects` (new) | `(id, node_run_id, kind, idempotency_key UNIQUE, external_ref text NULL, state, detail jsonb, created_at, updated_at)`, **UNIQUE (node_run_id, kind)** (14.0: an integrator's merge request and its deploy step are two effects of one node run) — the outbox / fencing ledger of master integrations. |
| `workflow_job_links` (new view) | `(job_id, run_id, node_id, engine)` — job ↔ run membership across both engines, read by quotas, queue, automations, efficiency, templates and the integration service instead of `workflow_node_jobs`. |
| `workflow_waits` (new) | `(id, node_run_id UNIQUE, token_hash bytea UNIQUE, mode signed\|token, expires_at, consumed_at NULL, consumed_digest NULL)`. |
| `workflow_trigger_bindings` (new) | `(project, name, trigger_node_id, automation_id UNIQUE REFERENCES automations, pinned_version int NULL, enabled bool, updated_by, updated_at)`, PK `(project, name, trigger_node_id)`. `automations` + column `workflow_trigger_node text NULL`. Chain triggers + `source_workflow_project/name` columns (nullable); the chain CHECK becomes "chain ⇔ exactly one of `chain_source_id` / `source_workflow_name`". `workflow_runs` gets `workflow_runs_engine_state_check` (engine-1 states only for engine 1; `queued / active / paused` + terminal for engine 2). |
| `workflow_egress` (new) | `(project PK REFERENCES projects, mode open \| allowlist DEFAULT 'open', hosts text[] ≤ 64, updated_by, updated_at)` (K1; no internal-host exceptions). |
| `vault_credentials` | kind CHECK widened with `http-auth` and `smtp` (K4); + `allowed_hosts text[] NULL` (≤ 16, required for both). |
| `projects` settings | `workflow_data_retention_days int NULL CHECK (1..365)`, `workflow_max_function_jobs int NULL`. |
| Notification kinds | `workflow.notify`, `workflow.failed`, `workflow.waiting` appended to the CHECK constraints of migration 0014 (same `DO $$` pattern as `0099`). |

`workflow_definitions`, `workflow_nodes`, `workflow_node_jobs`, `workflow_edges`, `workflow_merge_requests` are
unchanged (engine 1 keeps using them; engine 2 does not write them).

## 10. Protocol, packages and routes

### 10.1 Protocol (`@remyral/protocol`, additive in 1.0)

- JobSpec `kind: 'function'` + `function: FunctionSpec` (§5.2) with refinements (no repository / workspace /
  secretRefs / siteBundle / integration; exactly one of http / code); features `function-v1`, `function-code-v1`;
  CAPABILITIES `profileConcurrency.function`; artifact name `function-result.json`.
- `MASTER_ONLY_SPEC_FIELDS` unchanged. OpenAPI regenerated; contract tests master ↔ worker for function jobs.
- Assistant tool `draft_workflow` (`assistant.ts:413`): nodes `looseObject` with optional `type` / `config` and the
  role enum only when `type` is absent / `ai.step`; description extended with the catalog summary and the static-field
  rule. **Worker release** required (14.5).

### 10.2 New packages

- `packages/workflow-nodes` — catalog (types, ports, config schemas, placement, UI metadata), `normaliseV1`, graph
  validation v2 (scopes, ports, schema compatibility, static fields, ancestor references), pure interpreter core
  (readiness, dead-path elimination, joins, forEach scheduling) — no I/O, fully unit-testable.
- `packages/workflow-expr` — JSONata wrapper: compile + AST scan + bindings + thread-pool sandbox (`jsonata@2.2.2`
  pinned exactly).

### 10.3 Routes (master)

All routes are registered through the normal route registry, so the RBAC matrix, route coverage and the abuse /
rate-policy tests (`abuse.test.ts`, `rate-policy.test.ts`) cover them automatically; every state-changing route needs
CSRF (session routes).

| Route | Authz | Rate class | Body limit | Notes |
| --- | --- | --- | --- | --- |
| `GET /workflows/catalog` | `workflows.read` (any project) | read | 1 KiB | node catalog, schemas, which types the user may add, capable-worker counts |
| `POST /workflows` · `PUT /workflows/:id` · `POST /workflows/validate` (existing) | `workflows.define` + `define.*` by diff + step-up on privileged delta | write | **512 KiB** — new `BODY_LIMIT_EXCEPTIONS` entries ("v2 definitions ≤ 200 nodes with config, WORKFLOW_DEFINITION_BODY_LIMIT, p14-workflow-engine") | v2 validation |
| `POST /workflows/expressions/evaluate` `{project, expression, sample}` | `workflows.test` | write + per-user bucket 60 / min | 64 KiB (global) | master sandbox only; result ≤ 32 KiB; audited only on denial |
| `POST /workflows/:id/nodes/:node/test` `{input, confirm}` | `workflows.test` (+ `define.*`, step-up for network / code) | write + per-user 20 / min | 64 KiB | pure: inline result; side-effecting: creates a test run, 202 `{testRunId}` |
| `PUT /workflows/:id/activation` `{enabled, pinnedVersion?}` | `workflows.activate` (+ `automations.external` + step-up for external triggers) | write | global | reconciles trigger bindings; audited |
| `POST /workflows/runs/:id/pause` · `/resume` | `workflows.run` | write | global | audited |
| `POST /workflows/runs/:id/rerun` `{fromNode?, latestVersion?}` | `workflows.run` (+ run-as re-check of node actions) | write | global | 201 `{runId}` |
| `GET /workflows/runs/:id/node-runs?node=&scope=&cursor=` | `workflows.read` | read | 1 KiB | paginated (`http/pagination.ts`), inline data ≤ 16 KiB each |
| `GET /workflows/runs/:id/payloads/:sha` | `workflows.read` | read | 1 KiB | ≤ 4 MiB JSON, `cache-control: no-store` |
| `POST /workflows/runs/:id/node-runs/:nodeRunId/approve` · `/deny` `{reason}` | `workflows.approve` + gate role + fresh step-up | write | global | engine-2 gate / `control.approval`; engine-1 route unchanged |
| `POST /workflows/runs/:id/node-runs/:nodeRunId/resume` `{data?}` | `workflows.run` | write | global | manual resume of a webhook wait (testing / fallback); data untrusted |
| `POST /workflows/runs/:id/node-runs/:nodeRunId/cancel` | `workflows.run` | write | global | cancels one node run (→ its error policy) |
| `GET /projects/:id/workflow-egress` · `PUT` | `workflows.read` · `workflows.egress.write` + always-fresh step-up | read · write | 1 KiB · global | audited + admin notification |
| `POST /v1/hooks/wait/:token` | public (capability token + HMAC by default) | public | **64 KiB** — `BODY_LIMIT_EXCEPTIONS` entry ("wait-for-webhook resume payloads (≤ 64 KiB, WAIT_HOOK_BODY_LIMIT, p14-workflow-engine), token + signature checked first") | 202; 404 for unknown / used / expired tokens (no oracle); per-IP public bucket; audited |

`POST /v1/hooks/:id` keeps its contract; a webhook trigger with `responseMode: wait` holds the request ≤ 30 s (bounded
by `SLOW_REQUEST_TIMEOUTS`, counted against a new connection cap `webhookWait {perKey: 4, total: 64}` in
`CONNECTION_CAPS`).

### 10.4 Audit actions (new)

`workflow.activate`, `workflow.deactivate`, `workflow.run.pause|resume|rerun`, `workflow.node.cancel`,
`workflow.node.resume`, `workflow.gate.request|approve|deny` (engine 2 too), `workflow.side_effect` (kind, external
ref, idempotency key — never payloads), `workflow.test` (node type, outcome), `workflow.egress.update`,
`workflow.hook.wait` (token id, accepted / refused), `workflow.define` metadata gains `privilegedDelta` (node types
added / changed).

### 10.5 Observability

Metrics: node runs by type / state / placement, master-pure evaluation latency and sandbox terminations, timer lag
(`now − due_at` at fire), waiting node runs by kind and age, function job queue wait, side-effect retries, payload
bytes per run. Logs: `workflow v2 progress failed`, `expression sandbox terminated`. Alerts: timer lag > 60 s, sandbox
terminations spike.

## 11. Phases (sizes: S ≤ 3 d, M ≤ 1 w, L ≤ 2 w, XL > 2 w of agent work)

| Phase | Content | Size | Worker release | Value |
| --- | --- | --- | --- | --- |
| **14.0 Foundation** | ADR-0055; `packages/workflow-nodes` (catalog with `ai.step`, ports, v2 schema, `normaliseV1`, validation v2); migration 0103; engine-2 skeleton (node runs, claiming, admission for engine-2 jobs, lazy job creation) running `ai.step` graphs; parity suite against both engines; dry-run normalisation of all stored definitions | L | no | safe base, no behaviour change |
| **14.1 Control flow, data, timers (master)** | `packages/workflow-expr` (JSONata 2.2.2 sandbox); `control.if/switch/merge/forEach/loop/delay/waitUntil/approval/subWorkflow/stop/fail/return`, `data.*`, `trigger.manual`; error ports, retries / backoff / timeouts, cancellation propagation; run outputs; editor: palette, ports + labels, groups, schema-driven panel, expression editor with autocomplete + preview, single-node test for pure nodes, run view with per-node data, phone view; RBAC `workflows.test`; routes catalog / evaluate / test / node-runs / payloads / engine-2 gates | XL | no | "real workflow engine" for AI orchestration: conditions, loops over lists, waits, transforms |
| **14.2 Master integrations + triggers** | `notify.users`, `chat.message`, `jobs.create`, `deploy.*` / `dns.change`, `github.comment` / `github.pullRequest`, `uptime.check`, `control.waitWebhook` + `/v1/hooks/wait/:token`, `control.respond`; trigger nodes + activation ↔ automations, `trigger.workflow` / `trigger.chat`; side-effect outbox; RBAC `define.deploy`, `define.network` (GitHub / wait), `activate`; notification kinds | L | no | end-to-end automations on the canvas |
| **14.3 Worker functions** | protocol `kind: "function"`, `function-v1` / `function-code-v1`; worker HTTP executor (guarded DNS, egress allowlist, credential host binding, idempotency key, redaction), code runner in the container profile with pinned images; function slots; vault `http-auth` + `allowed_hosts`; `workflow_egress` + settings UI; RBAC `define.network` / `define.code` / `egress.write`; test-run of HTTP / code nodes | L | **yes** (release + rollout per remyral deploy routine) | requests to any allowed API, custom code |
| **14.4 Operations** | re-run from a node, pause / resume, concurrency per workflow / key, run timeout, error workflow `onFailure`, retention pruning, metrics / alerts, `github.label` (manifest change, owner re-consent) | M | no | production-grade operations |
| **14.5 Migration and authoring** | flip `WORKFLOW_ENGINE_V2_FOR_V1` after parity + shadow; `draft_workflow` v2 in chat (worker release); templates (marketing, content, video — the roadmap's "örnek workflow'lar"); presentation and docs | M | **yes** (assistant tool) | one engine, chat-authored workflows |

Order rationale: 14.1 needs no worker release and delivers the most visible gap (logic, loops, timers, data); 14.2
reuses audited integrations; 14.3 is the riskiest (network, code, secrets) and ships after the engine is proven.

## 12. Test plan

- **Unit (pure packages)**: catalog schemas (every type: valid / invalid configs, static-field refusals, secret
  patterns in config); `normaliseV1` round trip on fixtures + property test; v2 validation (scopes, ports, `many`,
  schema mismatch, ancestor references through groups, cycles inside groups, limits); interpreter: readiness, skips /
  dead-path elimination, joins `all/any/first/atLeast`, error ports vs `onError`, forEach ordering + concurrency +
  `onItemError`, loop `maxIterations`, retries / backoff timing, timeouts; expression sandbox: determinism corpus
  (same input ⇒ same output across 1 000 runs and across a JSONata upgrade), refused functions (`$eval`, `$random`,
  `$clone`), `$now` binding, ReDoS regex terminated within 300 ms without blocking the main loop, memory blow-up
  terminated, output size cap, error codes carry no data.
- **Integration (real master + Postgres + Redis, real worker daemons)**: parity suite on engine 2 (A-ORCH-1 across three
  workers, all failure policies, gates, planner, integrator, deploy step, reuse, workspace files); if / switch / merge /
  forEach with AI steps on different workers; **timers survive a master restart** (stop the process with a due timer,
  restart, fire once); master outage with `late: skip`; two master instances racing on the same run (no double
  transition, version fence); webhook wait (valid, replayed, expired, unsigned); cancel propagation to function jobs,
  AI jobs, child runs and pending ops actions; pause / resume; re-run from a node without repeating upstream side
  effects; concurrency `queue` / `skip`; kill switch; rollback simulation (engine-2 runs frozen by engine-1 code).
- **Function jobs**: lease loss mid-request ⇒ same `Idempotency-Key`, first result wins; duplicate `JOB_RESULT`
  ignored; offline worker ⇒ `no_worker` after `queueTimeoutSec`; worker without `function-v1` never chosen; SSRF suite on
  the worker (169.254.169.254, 10/8, 192.168/16, ::1, fd00::/8, DNS rebinding, redirect to private, IP literal,
  disallowed port, proxy env); credential attached only to `allowed_hosts`, redacted from echoes; code node: no
  network, read-only, memory / time limits, output cap; OS matrix: Linux + Windows + macOS (code: Linux / Windows with
  Docker Desktop; marked UNVERIFIED where no CI runner exists, with a blocking ticket per AGENTS.md).
- **Security / policy**: RBAC matrix rows for every new action and route; route coverage; abuse / rate-policy test
  (classes, `BODY_LIMIT_EXCEPTIONS` entries match routes); CSRF review; step-up on privileged delta (adding an HTTP node
  without step-up ⇒ 403); run-as re-check after demotion; audit records for every new transition; static scan refuses
  secrets in definitions; untrusted `$trigger` cannot reach static fields (type-level + validation tests); AI prompt
  contains no untrusted value text (pointer + fence, injected closing marker neutralised).
- **Web**: `workflow-model.test.ts` extended (ports, groups, schema refusals, normalisation), Diyalog editor tests
  (palette, connect with ports, branch labels, panel forms, expression autocomplete and preview errors, single-node
  test, YAML round trip with v2), run view (per-node data, iteration selector, skipped paths), phone layout, lazy chunk
  guard extended to the new modules; visual harness shots at 1440 / 1024 / 768 / 400, light / dark.
- **Migration**: dry-run of 0103 on a production snapshot (timings, constraint swaps), normalisation of every stored
  definition, forward / rollback rehearsal.

## 13. Rollback

- **Code**: engine 2 is behind `WORKFLOW_ENGINE_V2` (new v2 saves and runs refused when off) and
  `WORKFLOW_ENGINE_V2_FOR_V1`. Turning the flags off stops new engine-2 runs; existing engine-2 runs stay `active` /
  `paused` and are ignored by engine-1 code (distinct open states) — they resume when the code returns, or an admin
  cancels them (`scripts/ops/workflow-v2-cancel.mjs`, audited). v1 workflows are unaffected in every case.
- **Migration 0103**: additive (new tables / nullable columns / widened CHECKs); the forward-only runner keeps it;
  older code ignores the new tables and columns.
- **Worker release**: workers without `function-v1` are never sent function jobs; if a release is rolled back, function
  nodes wait and fail with `no_worker` → their error ports / policies; AI work is unaffected.
- **Triggers**: deactivation pauses the bound automations (history kept); deleting the binding table rows leaves
  ordinary automations.
- **Dependency**: removing JSONata disables v2 validation of expression fields (v2 saves refused), v1 unaffected.

## 14. Open decisions for the owner (max 4) — decided 2026-10-20

Owner decisions (the internal note `workflow-motoru` (not published), ADR-0055): **K1** HTTP egress open to any public address by default,
the allowlist optional per project, the LAN / private / metadata floor and worker-only egress unchanged (replaces D1's
recommendation); **K2** = D2 (a); **K3** = D3 (a); **K4** a built-in SMTP e-mail node (presets or own server, password in
the vault, sent from a worker; recipients and content may be expressions, server and credential static — replaces D4's
recommendation). The table below is the original question set.

| # | Question | Options | Recommended default |
| --- | --- | --- | --- |
| **D1** | HTTP request scope from workers: which hosts may workflows call? | (a) per-project allowlist only; (b) allowlist + an admin switch "any public HTTPS"; (c) also LAN / internal addresses (NAS, local services) per explicit host | **(b)**: allowlist by default (empty), "any public HTTPS" per project with admin + always-fresh step-up; LAN / private addresses refused — explicit internal hosts only as a later, separate decision |
| **D2** | Where do triggers live? | (a) trigger nodes on the canvas, reconciled into automations on "Etkinleştir"; (b) triggers stay only in Otomasyonlar, the canvas shows them read-only | **(a)**: the canvas is the place to build; automations stay the single trigger runtime (signing, catch-up, dedup, audit) and the Otomasyonlar screen lists the bound ones |
| **D3** | Code nodes | (a) JS + Python in the container profile only (workers with Docker / Podman); (b) also an in-process JS sandbox (QuickJS-wasm) for workers without containers; (c) no code nodes, JSONata only | **(a)** in 14.3; JSONata covers most transforms on the master; (b) only if a real need appears |
| **D4** | E-mail to addresses outside the platform | (a) not built in — notify platform users (their channels), external mail via HTTP node + the owner's mail provider credential; (b) SMTP node to any recipient with a per-project domain allowlist | **(a)**: avoids the master becoming a mail relay for data-driven recipients; revisit with (b) if marketing workflows need it |

## 15. UNVERIFIED / to confirm during implementation

- JSONata 2.2.2 guardrail options are present in the published code (checked in the tarball) — their exact behaviour
  with async custom functions and binding shadowing of built-ins (`$now`, `$eval`) must be pinned by tests before
  relying on them; the thread-pool isolation is the actual safety boundary.
- CEL JavaScript implementations had no Context7 documentation; they were evaluated on metadata only (not adopted).
- Container engines on Windows / macOS workers for code nodes (Docker Desktop availability per machine).
- `Idempotency-Key` support differs by provider; documented per node, not guaranteed.
- React Flow sub-flows (parent nodes) with dagre per-scope layout at 200 nodes — to measure in 14.1 (bundle and
  interaction budget: canvas chunk stays lazy, ≤ +40 kB gzip).

## 16. Phase 14.0 — implementation notes

What exists after 14.0 (p14-wf-foundation) and where it refines the text above:

- `packages/workflow-nodes` (`@remyral/workflow-nodes`, pure): `catalog.ts` (every type of §3 incl. K1 `http.request`
  and K4 `email.send` with presets, placement `trigger` for trigger declarations, static / expression field modes,
  ports, side effects, required action, worker feature, phase), `v1.ts` (the v1 schema moved from the master,
  unchanged key order so `definition_hash` inputs are identical), `v2.ts`, `convert.ts` (`normaliseV1`, `toV1`,
  `aiProjection` — the lossy AI-step view for v1-shaped readers), `validate.ts`, `interpreter.ts`, `fields.ts`
  (`isForbiddenHost`, origin / header / credential rules). Labels are inline TR / EN until the 14.1 palette moves them
  to the i18n catalog (ADR-0053).
- Refinements: a template string (`… {{ }} …`) is accepted for any expression-capable field (its literal constraints
  apply to the evaluated value at run time); `join` is a node-level field for nodes with a `many` input (ai.step,
  merge) — `control.merge` also keeps `config.join`; at most 24 ports per node (a switch's 20 cases + default + error +
  in); skips carry a kind (`dead_path` / `upstream_failed`, §2.3 made exact for v1 parity); a failure routed to a
  connected `error` port or `onError: continue` does not fail the run.
- Master: `src/workflows/v2/engine.ts` (engine 2 for `ai.step` graphs: node runs, lazy jobs, admission, gates, failure
  policies, retries, planner expansion stored on the planner's node run, integrator + master-managed integration,
  deploy steps and merge requests in `workflow_side_effects`, result reuse, workspace files, cancel, kill switch,
  views in engine-1 vocabulary), `src/workflows/steps.ts` (JobSpec building and output reading shared by both
  engines), `src/workflows/v2/normalise-check.ts` + `pnpm --filter @remyral/master workflow:normalise-check`.
  `WorkflowService.progress()` drives both engines; `startRun` picks the engine; `POST /workflows` / `PUT` /
  `validate` accept v2 documents only with `WORKFLOW_ENGINE_V2` and only node types engine 2 executes (14.0:
  `ai.step`; others `node_type_unavailable`). The run view adds `run.engine` and, for engine 2, `nodeRunId` /
  `nodeRunState`.
- Not yet (by phase): routes of §10.3 other than the existing ones (14.1+), the 512 KiB `BODY_LIMIT_EXCEPTIONS` entry
  for v2 definitions (14.1, with the editor — the global body limit applies until then), RBAC actions of §8.5 (with the
  node types that need them), protocol `kind: "function"` (14.3), the assistant's `draft_workflow` v2 (14.5).
- Tests: `packages/workflow-nodes/test/*` (catalog, conversion property test, validation, interpreter);
  `apps/master/test/integration/workflows.test.ts` on engines 1 and 2; `workflow-engine-v2.test.ts`; the other
  workflow suites are engine-agnostic and run on engine 2 with `REMYRAL_TEST_WORKFLOW_ENGINE=2`.

## 17. Phase 14.1 — implementation notes (p14-wf-control)

What 14.1 adds (master + web, no worker release, no migration — 0103 already had every table and column) and where
it refines the text above:

- **`packages/workflow-expr`** (`@remyral/workflow-expr`, `jsonata` 2.2.2 and `yaml` 2.9.1 pinned exactly). API verified
  against the 2.2.2 tarball and ctx7 `/jsonata-js/jsonata` (guardrails `{timeout, stack, sequence}`, `RegexEngine`,
  `evaluate(input, bindings)`, `ast()`, error `{code, position}`). `sandbox-worker.ts` is self-contained (only
  `jsonata`, `yaml`, `node:` imports, erasable TypeScript) because the pool starts it directly as a worker entry — the
  compiled `.js` in production (the master image asserts `packages/workflow-expr/dist/sandbox-worker.js`), the `.ts`
  source under Vitest (Node's type stripping). `pool.ts`: 2 threads, `resourceLimits {64, 16, 4 MiB}`, `env: {}` (a
  thread never sees the master's environment), hard deadline 250 ms per request measured from dispatch →
  `worker.terminate()` + replacement (`expr_timeout`), a dead thread (out of memory) → `expr_resource_limit`, input
  ≤ 1 MiB (`expr_input_too_large`), output ≤ 256 KiB (`expr_output_too_large`), queue ≤ 1 000 (`expr_busy`).
  Static scan at save and before every evaluation: `$eval`, `$random`, `$clone` **and `$shuffle`** (also
  non-deterministic) refused even when passed as values (`$f := $eval`), regex literals ≤ 200 characters without
  nested quantifiers or back-references (`expr_regex_not_allowed`); JSONata's AST names a regex node `regex`. Bindings
  shadow the built-ins (tested): `$now()` / `$millis()` = the node run's `scheduled_at` (`$now(picture, tz)` renders
  that instant), refused functions throw `expr_function_not_allowed` as a second line. Overlapping-alternation regexes
  (`(a|a)*b`) pass the heuristic and are stopped by the deadline (tested, the main event loop keeps ticking).
- **Templates**: a string that is exactly one `{{ expr }}` yields the raw value (a condition stays a boolean); mixed
  text interpolates (strings as is, other values as JSON). Root `$` = the node's input (per-item expressions: the item).
- **Engine 2** (`apps/master/src/workflows/v2/engine.ts`, `pure.ts`, `values.ts`) executes every 14.1 type
  (`typesDeliveredBy('14.1')`: `trigger.manual`, `ai.step`, `control.if/switch/merge/forEach/loop/delay/waitUntil/
  approval/subWorkflow/stop/fail/return`, every `data.*`). Node runs are keyed by (node, **scope**): `''` at top level,
  `each[3]` for iteration 3 of group `each`, nested `each[3]/inner[1]`. A group's node run stays `running` while it
  starts iterations (forEach: up to `concurrency` open at once; loop: one at a time, `while` evaluated before each with
  `$loop = {index, last, results}`, the previous iteration's result is the next `$item`), inserting the body's node
  runs per iteration; it finishes with values on **both** `results` (item order; an iteration's value is its
  `control.return`, else its sinks) and `done` (`{count, succeeded, failed}`) — the interpreter's `deliveryOf` accepts
  several ports for that (and for `data.filter`'s `kept` + `dropped`). AI steps inside a body get their JobSpec
  prepared at run start (stored on the group's node run) and one job per iteration, the item fenced as data.
- **Timers are rows**: `control.delay` / `waitUntil` set `due_at` (waiting `timer`), `control.approval` its timeout,
  retries `retry_wait` rows; `progress()` orders runs with a due timer first, then the least recently progressed, so a
  restarted master fires what came due while it was down (tested with a fresh service instance) and many waiting
  runs never starve each other. `waitUntil` fired > 60 s late with `late: skip` takes `timeout`.
- **Approvals**: `control.approval` waits with `gate_role`; approve / deny are outcomes on ports (`approved` /
  `denied`, value `{input, decidedBy, reason}`), timeout on `timeout`. AI-step gates and approval nodes in any scope are
  decided by node run (`POST /workflows/runs/:id/node-runs/:nodeRunId/approve|deny`, `workflows.approve` + gate role +
  step-up); the 14.0 route by node id stays.
- **Sub-workflows**: same project only in 14.1 (`cross_project_not_allowed`; cross-project needs the run-as re-check of
  14.4), callee latest or a pinned version, depth ≤ 3 (`limit_exceeded`), the child always on engine 2
  (`trigger_kind = subworkflow`, `parent_run_id`, `parent_node_run_id`, run as the parent's creator), inputs evaluated
  and passed as strings (typed by the callee's declaration), `wait: false` emits `{runId}` at once. The parent's node
  run waits `child_run` and takes the child's `outputs`; cancelling the parent (or its node) cancels the child.
- **Errors and policies**: master-pure nodes retry only with `retry.max` (`retry.on` codes, fixed / exponential
  backoff from `initialSec` capped by `maxSec`, stable jitter), never for `cancelled` / refusals; then the error port
  or `onError`; fail fast is **scoped** — inside an iteration it cancels that iteration's open node runs and the group's
  `onItemError` decides (`fail` cancels the other iterations; `continue` → `null`; `collect` → `{error}`). Node
  `timeoutSec` puts a deadline on a running / waiting node run (`timeout`). `control.stop` / `control.fail` end the
  whole run (others cancelled); `settings.timeoutSec` fails the run. Run outputs: `control.stop.outputs`, else the
  top-level sinks' values (`workflow_runs.outputs`, shown in the run view).
- **History**: every input (port value) and resolved config a node used and every output port value is stored through
  the Redactor (string by string, credential header keys dropped), inline ≤ 16 KiB else `workflow_payloads` by SHA-256
  (≤ 4 MiB, ≤ 64 MiB per run; `value_too_large` / `limit_exceeded`). What flows downstream is the stored value.
- **AI `outputSchema`**: the step's prompt gets an instruction to end with one fenced ```` ```remyral-output``` ````
  block; on success it is parsed strictly (exactly one block, JSON, ≤ 64 KiB) and checked against the schema →
  `out.data`, else the node fails `output_contract` (its retry policy applies).
- **Catalog fix**: `control.switch`'s `cases` field is expression-capable (14.0 marked it static, which refused every
  `match`); names and `equals` stay literals by schema.
- **Routes** (all in the registry; RBAC matrix, route coverage and abuse tests cover them): `GET /workflows/catalog`
  (types with JSON Schemas of their configs via `z.toJSONSchema`, field modes, ports, `testable`, allowed / refused
  functions, limits, `engineV2`, `executable`), `POST /workflows/expressions/evaluate` (`workflows.test`, per-user
  60 / min, result ≤ 32 KiB), `POST /workflows/:id/nodes/:node/test` (`workflows.test`, per-user 20 / min, the stored
  node or the editor's unsaved copy, master-pure types only; timers / approvals / sub-workflows report what they would
  do; audit `workflow.test`, nothing else stored), `GET /workflows/runs/:id/node-runs` (paginated), `GET
  /workflows/runs/:id/payloads/:sha` (`no-store`), node-run approve / deny / cancel. The run view gains `type`,
  `scope`, `waitKind`, `dueAt`, `outputPort`, `error`, `iterations` per node, edge ports and delivery state, and
  `run.outputs`. `POST /workflows`, `PUT /workflows/:id`, `POST /workflows/validate` take ≤ 512 KiB + envelope
  (`WORKFLOW_DEFINITION_BODY_LIMIT`, `BODY_LIMIT_EXCEPTIONS`). New RBAC action `workflows.test` (operator, project);
  the `define.network | code | deploy` actions arrive with their node types (14.2 / 14.3). `GET /auth/session` gains
  `features.workflowEngineV2`.
- **Not in 14.1** (by design phase): pause / resume, re-run from a node, run concurrency (14.4); webhook waits,
  integrations, triggers other than manual (14.2); HTTP / e-mail / code (14.3); BullMQ progress hints (the 2 s tick is
  the driver); `$now`-dependent JSONata date pictures that default missing parts from the wall clock are not fixed
  (JSONata reads its own timestamp for those) — documented, only affects partial pictures.
- **Security review (14.1)**: no master network path was added (pure nodes do no I/O; sub-workflows only start runs).
  User expressions never run on the master's event loop: they run in a separate V8 isolate with its own heap cap, no
  environment, no `require` / `process` reachable from JSONata (no host access in the language), and are killed at
  the deadline; ReDoS, busy loops and memory blow-ups are tested. Static-only fields stay literal (`static_field` at
  save and in the single-node test), so data cannot pick an approver role, a sub-workflow, a limit or a port name.
  Expression errors and validation issues carry codes and positions only. Values are redacted before storage and
  before they flow on; payloads are read only through the run's project (`workflows.read`), by SHA-256 within the run,
  `no-store`. The preview and the node test need `workflows.test` in the project, CSRF, and per-user budgets (60 / 20
  per minute), store nothing but the `workflow.test` audit line, and refuse every non-master type. Approvals by node
  run keep the gate's role check and step-up; node-run cancel needs `workflows.run`. Resource bounds: forEach ≤ 1 000
  items, concurrency ≤ 20, loop ≤ 100, ≤ 10 000 node runs per run (`limit_exceeded`), ≤ 100 pure evaluations per run
  and ≤ 500 per tick, values ≤ 4 MiB and ≤ 64 MiB of payloads per run, timers ≤ 30 / 90 days, sub-workflow depth ≤ 3.
  Residual: a sub-workflow runs as the parent run's creator without a fresh permission check until 14.4 (same project
  only, so the creator already held `workflows.run` there when starting the parent).
- Tests: `packages/workflow-expr/test/sandbox.test.ts` (scan, bindings, determinism × 1 000, templates, errors without
  data, every pure computation, pool deadline / ReDoS / memory / input + output caps); `packages/workflow-nodes` tests
  extended (multi-port deliveries, backoff, expression validation paths, i18n labels);
  `apps/master/test/integration/workflow-control.test.ts` (every 14.1 node type, dead paths, joins all / any / first /
  atLeast, forEach concurrency + item order + onItemError, loop, AI step per item, timers across a restart, waitUntil
  late, approvals with step-up and timeout, node timeout, node-run cancel, sub-workflow + cancel propagation, error
  ports, retries with backoff, stop / fail, outputs, redaction + payloads, validation paths, catalog / preview / test /
  RBAC, 512 KiB body); `test/unit/workflow-v2-pure.test.ts`; parity suites unchanged and green on both engines.

## 18. Phase 14.2 — implementation notes (p14-wf-integrations)

What 14.2 adds (master + web, no worker release; migration **0106**) and where it refines the text above:

- **Integration nodes** (`notify.users`, `chat.message`, `jobs.create`, `deploy.coolify`, `deploy.pages`,
  `dns.change`, `github.comment`, `github.pullRequest`, `uptime.check`; placement `integration`) run through the
  port `WorkflowIntegrations` (`apps/master/src/workflows/v2/integrations.ts`), wired in compose.ts to the **existing**
  services only (`apps/master/src/workflows/integrations.ts`): the notification service (new kind `workflow.notify`,
  dedupe key per effect; recipients are the run's creator, members of the project with a role ≥ X, or named users
  who can read the project — never outsiders), the ops chat (`ChatService.postWorkflowMessage`: the creator's thread
  `Workflow · <name>` or a thread the creator owns, meta marker per effect), the ops service as
  `workflow:<run>` with the effect key as idempotency key (Coolify connections, Pages, DNS — the project's deploy
  policy decides; production waits for its approval with an always-fresh step-up; a DNS change without a zone takes
  the project's only allowed zone containing the record name), the project's repository through the git-flow
  provider of the GitHub App (`issueComment` with a hidden marker `<!-- remyral:<key> -->`, `ensurePullRequest` with
  `draft`), and the uptime `Probe` (the same instance as the monitors; `urlProblem` + the probe's address guard).
  Every call re-checks the run's creator (active, `workflows.run` in the project, plus `deploy.request` / `jobs.create`).
  `deploy.coolify` names no resource any more: the target comes from the project's deploy targets for `env`.
- **Outbox / idempotency** (§5.3 made exact): a ready integration node resolves its expression fields in the sandbox
  (`PureExecutor.resolve`), builds its request (stored, redacted — what is sent is the stored value), and in **one
  transaction** inserts `workflow_side_effects` (key `wf2:<node-run key>:<attempt>`, unique) and moves the node run
  to `waiting` / `side_effect`; then it performs the call. A result is applied to the row and the node run (done →
  `out`; requested → `waiting` `job` / `ops_action`, polled each pass; refused → the node fails without retry; failed →
  its retry policy). A call that throws (network, provider 5xx) keeps the row `pending` with a backoff (15 s × try,
  ≤ 5 tries, then `integration_error`); the next pass — or a restarted master — calls again with the same key, which
  the integration deduplicates. `jobs.create` is created by the engine itself and writes its job id into the outbox row
  **inside the job's creation transaction** (a second attempt finds it; a job left in DRAFT by a crash is submitted on
  the next poll). Every applied effect is audited `workflow.side_effect` (kind, state, external ref, key — no payloads)
  as the run's creator `via workflow run`. Cancelling a run (or a node timeout / fail fast) cancels a waiting job and
  withdraws an ops action still awaiting approval (denied on the creator's behalf, so it can never execute later).
- **`jobs.create` prompt**: the template's literal text is the instruction; each `{{ … }}` becomes a pointer
  `[WORKFLOW DATA n]` and the values travel in one nonce-fenced untrusted block after it (ADR-0010). The job runs as the
  run's creator; `sourceTrust` is `untrusted` when the run's source is.
- **Webhook waits** (`control.waitWebhook`): the resume token is `base64url(HMAC-SHA256(hook key, run ∥ node ∥ scope ∥
  attempt))` — 256 bits, derived from the master box's HKDF sub-key `workflow-wait` — so `$node.<wait>.url` can be
  computed for any node of the same or an enclosing scope **before** the wait begins (validation allows exactly
  `.url` of such a node); only its SHA-256 is stored (`workflow_waits`, a row per node-run attempt created with the
  node run). `POST /v1/hooks/wait/:token` (public, rate class `public`, body ≤ 64 KiB in `BODY_LIMIT_EXCEPTIONS`):
  unknown / used / expired / revoked tokens, a closed node run or run, and a missing or bad signature all answer **404**
  (no oracle; audited `workflow.hook.wait`); a signed wait (default) needs the Remyral signature with a current or
  previous secret of the workflow's **bound, active** `trigger.webhook` automation (validation:
  `wait_needs_webhook_trigger`); token-only mode is an admin opt-in (`workflows.define.network`). The JSON body must
  match the node's `bodySchema` (400 `invalid_body`), is stored redacted as untrusted data (`received`, migration
  0106) and the run progresses at once. A call that arrives before the node waits is kept and taken when it starts;
  the timeout (`timeoutSec`, from when the wait starts) emits on `timeout` and expires the URL; cancel revokes it.
  `POST /workflows/runs/:id/node-runs/:nodeRunId/resume` (`workflows.run`) is the manual fallback (data untrusted,
  audited `workflow.node.resume`).
- **Trigger nodes ↔ automations (K2)** — `WorkflowTriggerService` (`apps/master/src/workflows/triggers.ts`):
  `GET /workflows/:id/activation` (viewer+) lists every top-level trigger node with its bound automation (status,
  webhook address, last run, `upToDate` against the node's config hash); `PUT /workflows/:id/activation
  {enabled, pinnedVersion?}` (`workflows.activate`, operator) creates / updates / resumes one automation per
  `trigger.schedule` (cron in UTC — `timezone_not_supported` otherwise — or one-shot, catch-up), `trigger.webhook`
  (IP allowlist; the new secret is in the answer once, `no-store`), `trigger.github` (events → event +
  additionalEvents), `trigger.workflow` (a **chain on a workflow's runs**: `ChainTrigger.workflow {project?, name}`,
  columns `source_workflow_project/name` of 0103; fired by `AutomationService.fireWorkflowChains` from the tick —
  every finished run of the source with a chosen outcome, dedup key `workflow:<run>`, chain depth carried, the source
  run's outputs as untrusted event data), with the activating user as run-as; webhook / GitHub triggers need
  `automations.external` + a fresh step-up (as automations). Manual and chat triggers need no automation. Disabling,
  and nodes removed from the canvas, pause their automations (bindings kept). Bound automations
  (`automations.workflow_trigger_node`) show `workflowBinding` and refuse PATCH / DELETE with 409 `automation_bound`;
  at fire time they run the workflow's **latest** version (or the pinned one).
- **Runs from triggers** carry `trigger_kind`, `trigger_node`, `source_trust` and `trigger_data` (stored value, set once;
  migration 0106 keeps `trigger_node` in the identity guard and refuses changing `trigger_data` once set). `$trigger`
  is that data (automation event data: `{event, receivedAt, body}` for webhooks, the filtered GitHub event, `{event:
  'schedule', scheduledFor}`, `{event: 'workflow', runId, workflow, outcome, outputs}`; chat: `{threadId, draftId,
  inputs}`); webhook / GitHub / workflow / chat sources are always `untrusted` in the run. A run fires exactly one kind
  of trigger: the bound node, the chat triggers for a chat card, else the manual triggers; every other trigger node is
  skipped as a dead path. A manual start of a workflow whose triggers are all non-manual is refused
  (`manual_trigger_missing`); an automation whose node disappeared fails its run (`trigger_node_missing`).
- **RBAC / step-up** (§8.5): `workflows.define.network | deploy | code` (admin) and `workflows.activate` (operator).
  `privilegedDelta` (`packages/workflow-nodes/src/privilege.ts`) lists the privileged nodes a version adds or
  changes against the latest one (key-order and label independent; removals and moves are not privileged; a webhook
  wait only in token mode); saving such a version needs those actions **and** a fresh step-up (403 `forbidden` /
  `step_up_required`, audited `workflow.define` denied with the actions; success metadata `privilegedDelta`).
  Duplicating counts as adding.
- **Editor (Diyalog)**: "Tetikleyiciler" (toolbar, only when a node binds to an automation) — statuses, the webhook
  secret once with copy, out-of-date nodes, the version that runs, Etkinleştir / Devre dışı bırak through step-up;
  saving a privileged version asks for the code (`stepUp.run`); the palette adds 14.2 types with defaults. Run view:
  "Tetikleyen: …", "Güvenilmeyen kaynak", per-node side effects (kind, state, link to the job / deploy record / chat /
  external page — http(s) only, no referrer), waiting words for webhook / job / ops waits and "Elle devam ettir".
  Otomasyonlar marks bound automations ("Workflow'a bağlı") and links them to the canvas (no edit / delete there).
- **Deferred** (owner-visible, not in the brief): `control.respond` and webhook `responseMode: wait` → 14.4 (catalog
  phase 14.4; validation `not_available_yet`); single-node tests of integration nodes stay refused (14.3 brings
  side-effecting tests with confirmation); cross-project `trigger.workflow` sources follow the cross-project chain
  rules (admin in both projects).
- **Security review (14.2)**: no new master network path — every integration goes to an admin-configured provider
  (ops / GitHub / SMTP of notifications) or through the existing guarded probe; nothing selects a host, credential,
  deploy target, environment, repository, recipient set or thread from data (static fields, `static_field`). Event
  and wait payloads are untrusted data: they reach expressions and AI context only as data (fenced), never static
  fields. Wait tokens are unguessable (HMAC under a master-only key), stored hashed, single use, expiring and revoked
  on cancel; signed waits reuse the automation webhook verification (timestamp ± 5 min, constant-time HMAC).
  Residual: the resume URL is part of the run's data (project viewers can read node data), so token-only waits rely on
  that audience — which is why they need an admin. Outbox keys make every side effect exactly-once at the
  integration except providers outside our control (GitHub comments are re-found by marker within the first 300
  comments of the PR).
- **Tests**: `packages/workflow-nodes/test/integrations.test.ts` (privileged delta, 14.2 validation),
  `apps/master/test/unit/workflow-integrations.test.ts` (wiring over fakes: run-as re-checks, GitHub marker / PR base,
  DNS zone, ops outcomes, probe URL rules), `apps/master/test/integration/workflow-integrations.test.ts` (real
  notifications / chat / probe, fakes of the ops service and GitHub provider: replay safety, jobs with fenced data,
  deploy + DNS with cancel withdrawing the approval, a GitHub comment across a crash and a fresh service, webhook waits
  token / signed / replay / bad token / 64 KiB / timeout / manual resume, activation round trip incl. step-up, bound
  automations, a webhook-fired run, the schedule, deactivate / reactivate / orphan, workflow-finished trigger, RBAC +
  step-up on deltas), route coverage / abuse / RBAC matrix, `apps/web/test/diyalog-workflow-integrations.test.tsx`
  (TR + EN).

## 19. Phase 14.3 — implementation notes (p14-wf-worker)

What 14.3 adds (protocol, worker, master, web; migration **0108**; **worker release needed**) and where it refines
the text above:

- **Protocol** (`packages/protocol/src/function-job.ts`, additive in 1.0): JobSpec `kind: "function"` with
  `function: FunctionSpec` (`http` | `email` | `code`); a function job has neither `repository` nor `workspace` and no
  `secretRefs`, site bundle, integration plan, model profile or admin target (refinements). Features **`function-v1`**
  (HTTP + e-mail) and **`function-code-v1`** (code; advertised only while the worker's container engine and both code
  images are ready). The brief's example name `function-jobs-v1` was not used: §5.2 and the catalog already name
  `function-v1` / `function-code-v1`. Result artifact `function-result.json` (id `ws-function-result`,
  `FunctionResult`), failures as JOB_RESULT `error.code` from the closed set `FunctionErrorCode` (`egress_refused`,
  `egress_not_allowed`, `dns_failed`, `credential_host_refused`, `credential_missing`, `redirect_refused`,
  `http_timeout`, `http_error`, `smtp_*`, `code_*`, `function_refused`). Vault kinds `http-auth` and `smtp`
  (`HOST_BOUND_CREDENTIAL_KINDS`). Older masters reject unknown features in CAPABILITIES, so the **master deploys
  first** (as always), then the worker release.
- **No AI slot.** `slotLease` (and the quota / queue counters) exclude `kind = 'function'`; placement
  (`packages/scheduler`) gives function jobs their own slots (`FUNCTION_SLOTS = 8`, the worker enforces the same with a
  busy decline), skips runtime, login, sandbox-profile, account and urgent-reserve checks, scores on function slots,
  keeps the project assignment, and pins a node with a vault credential to the workers holding its current version.
  `function_unsupported` is **transient** (a worker update fixes it; the node's queue timeout bounds the wait), so a
  function job **queues** while no capable worker is online — offline workers are a transient reason too. The
  dispatcher sends no context, skills, MCP, sub-job tools, previews, approval waits, usage-limit parking or
  continuity; jobs store creates no model / catalog profile and no workspace for it; quotas hold it only for the
  project kill switch; only the workflow engine may create one (`spec.kind: not_allowed` otherwise).
- **Engine 2** (`apps/master/src/workflows/v2/functions.ts` + the integration-node path of `engine.ts`): a ready
  `http.request` / `email.send` / `code.*` node resolves its expression fields in the sandbox, builds the
  `FunctionSpec` (static origin / SMTP server / credential, encoded path + query, header values without line breaks,
  JSON / form / text bodies ≤ 1 MiB, recipients validated and counted against `maxRecipients`, a subject without line
  breaks, a deterministic `Message-ID`), checks the project's egress policy and the credential's bound hosts (kind,
  active, `allowed_hosts` contains `host` or `host:port`), and — through the 14.2 outbox — creates the job as the run's
  creator (re-checked) inside one transaction that writes the job id into the outbox row and links it in
  `workflow_node_run_jobs` (kind `function`; dispatch admission admits it while the node run waits). One job per
  node-run attempt; **`Idempotency-Key: wf-<node-run key>`** is identical across attempts, lease losses and
  re-dispatches. The node waits `job`: succeeded → the redacted artifact becomes `out` (`{status, headers, body,
  truncated?, sizeBytes, durationMs}`, `{messageId, accepted, rejected}`, or the code's output; HTTP statuses outside
  `successStatus`, default 2xx, fail `http_status`); failed → the worker's code; **queue timeout** (`queueTimeoutSec`,
  default 600 s, counted from the outbox row while no worker ever acknowledged the lease) → the job is cancelled and
  the node fails `no_worker` → its `error` port / `onError`; node `timeoutSec` → `timeout` as for every node.
  Refusals (egress, credential host, TLS, code output) are not retried; POST / PATCH / DELETE and e-mail repeat only
  with `retry.safe: true` (GET / HEAD / PUT and code repeat per `retry`).
- **K1 egress policy** (`apps/master/src/workflows/egress.ts`, table `workflow_egress` of 0103): `GET
  /projects/:id/workflow-egress` (viewer+), `PUT` `{mode, hosts}` (`workflows.egress.write`, admin, **always-fresh
  step-up**, 24 KiB body, audited `workflow.egress.update` with before / after). Default `open`: any public host on
  80 / 443 / 8080 / 8443 (SMTP 25 / 465 / 587 / 2525); `host:port` entries unlock other ports; `allowlist`: only listed
  hosts (`host` = default ports). Entries are lower-case public DNS names (no IP literals, no internal names —
  `invalid_egress`). Checked at save (issues `nodes.<i>.config.origin|smtp.host: egress_not_allowed | egress_refused`,
  `…credential: credential_unknown | credential_kind | credential_host_not_bound`) and again at run (the policy may
  have changed: the node fails without a job), and sent with the job for the worker's own check.
- **Worker** (`apps/worker/src/functions/`): `egress.ts` normalises the host as a connection would (WHATWG host
  parsing: `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1` → `127.0.0.1`; IPv6 compressed), refuses internal names
  and single-label names, applies K1, resolves **once** and refuses if **any** answer is non-public
  (`isForbiddenAddress`, extended to `::/96`), then connects only to the checked address (`pinnedLookup`; the host
  name is used for SNI, certificate checks and Host only). `http.ts`: fresh agent per hop (no proxy, cookies or
  keep-alive), `Idempotency-Key` always, denied headers dropped, the credential only for its bound hosts (first hop
  outside them → `credential_host_refused`; never carried to another host; query credentials stripped from
  `finalUrl`), every redirect hop re-checked (≤ `followRedirects`), size / time limits, response headers filtered,
  the credential's exact value redacted. `smtp.ts`: implicit TLS or **required** STARTTLS (`smtp_tls_required`
  before any AUTH), certificate verified, AUTH PLAIN / LOGIN, per-recipient accept / reject, RFC 5322 message without
  a Bcc header, encoded subject, header injection refused. `code.ts` (K3): `remyral/code-js` / `remyral/code-python`
  built from `infra/worker/images/code-js|code-python` (`FROM` the digests of `FUNCTION_CODE_BASE_IMAGES`, checked by
  `pnpm security:pins` and a protocol test; since p14-code-images the worker builds them itself with the remote op
  `code.images.prepare` from contexts embedded in its release — [p14-followups §2](p14-followups.md)), `docker run --network none --read-only --cap-drop ALL
  --security-opt no-new-privileges --user 10001:10001 --pids-limit 64 --memory <memoryMb> --memory-swap <same>
  --cpus 0.5 --tmpfs /tmp 16 MiB --pull never --rm`, no mounts, no env, JSON on stdin / one JSON line on stdout
  (≤ 256 KiB), killed at `timeoutSec` (+ 3 s start allowance). The runner (`jobs/runner.ts`) takes a function job
  without runtime admission, sandbox selection, skills or MCP, never touches the AI-slot state machine, runs at most 8
  at once, renews the lease like any job, redacts the whole result (incl. code stderr) and sends the artifact before
  JOB_RESULT.
- **Vault**: `POST /vault/credentials` takes `allowedHosts` (1–16 `host` / `host:port`, required for `http-auth` /
  `smtp`, refused for other kinds); views carry `allowedHosts`; such credentials are sealed only to `function-v1`
  workers; worker configuration (runtime auth) and MCP secret bindings refuse them.
- **Editor / web**: Projeler → Politika → **HTTP izin listesi** (K1 default shown as "Açık (öneri: listeyle
  sınırla)", admin + fresh TOTP); the 14.3 nodes are in the palette when `executable` lists them (engine flag on),
  with default configs, a queue-timeout field, a vault credential select per kind and "Bu düğüm bir makinede çalışır;
  uygun çevrimiçi makine: N" (`GET /workflows/catalog` → `functionWorkers {http, code}: {online, total}`), warning
  when N = 0; Settings → Credentials (Diyalog and classic) with the new kinds and "İzinli adresler"; run view links a
  function node's job.
- **Deferred** (not in the brief): single-node test runs of HTTP / code nodes (`POST /workflows/:id/nodes/:node/test`
  still refuses non-master types), per-project caps on concurrent function jobs (`projects.workflow_max_function_jobs`
  exists, not enforced), changing a credential's `allowedHosts` after creation (re-create it), a worker-reported
  function slot count (fixed at 8).
- **Security review (14.3)**: the master still opens no connection to an author- or data-chosen host (§5.1 rule 1) —
  it only builds specs. The LAN / private / loopback / link-local / CGNAT / metadata floor holds in every mode and at
  three points (save, run, worker), including numeric-host spellings, IPv4-mapped / NAT64 / 6to4 IPv6 forms, DNS
  answers (any non-public answer refuses the name — rebinding and split horizon), the pinned connection and every
  redirect hop. Credentials stay vault references; the value is read on the worker only for a bound host, never
  logged, never sent on to another host, redacted by exact value from results; the master never sees it. Static fields
  (origin, SMTP server, credential, sender, code source, limits) cannot come from data. Code runs without network,
  mounts, environment or privileges, with CPU / memory / pid / time / output bounds; workers without a ready container
  engine never get code jobs. Residuals: K1 lets workflows reach any public host by design (the allowlist narrows
  it); providers that ignore `Idempotency-Key` may see a duplicate after a lease loss mid-request; a container escape
  in the engine (images and engine updated per policy).
- **Tests**: `packages/scheduler/test/function-placement.test.ts`; `packages/protocol/test/function-code-images.test.ts`;
  `apps/worker/test/functions-http.test.ts` (SSRF matrix: every private / loopback / link-local / CGNAT / metadata /
  ULA literal and its decimal / hex / octal / short / IPv6-mapped spellings, names resolving to private addresses,
  mixed answers, DNS rebinding with a resolver that changes its answer, redirects to private / other hosts / other
  schemes, hop limit, ports in open and allowlist mode, credential binding and redaction, Idempotency-Key, size and
  time limits, abort), `functions-smtp.test.ts` (STARTTLS required, implicit TLS, AUTH, recipients, Message-ID,
  header injection, host binding; TLS cases need the `openssl` CLI), `functions-runner.test.ts` (no AI slot, artifact
  + JOB_RESULT, typed failure, 9th job declined busy, code declined without a ready executor),
  `functions-code.test.ts` (argv hardening with a fake engine; real Docker gated by `REMYRAL_TEST_DOCKER=1`: JS / Python,
  no network, read-only root, memory → `code_failed`, loop → `code_timeout`, huge output → `code_output_invalid`);
  `apps/master/test/integration/workflow-functions.test.ts` (egress route RBAC / always-fresh step-up / refused
  entries / audit; catalog; queueing with no worker → queue timeout → `no_worker` on the error port, job cancelled;
  the e-mail spec; save- and run-time policy and credential refusals; a real `function-v1` worker daemon running a
  POST with a bound credential against a local server — encoded path / query, Idempotency-Key, redacted echo, output
  downstream, placed on that worker; a retried PUT with the same Idempotency-Key; a redirect to 169.254.169.254
  refused into the error branch); `apps/web/test/diyalog-workflow-functions.test.tsx` (TR + EN).
- **UNVERIFIED** (needs real hardware / services): Windows and Linux worker hosts (only macOS ran), Windows Docker
  Desktop / rootless Podman / Linux arm64 (Raspberry Pi) for code nodes (only Docker Desktop on macOS arm64 ran),
  real SMTP providers (Gmail, Office 365, …) and real public HTTPS endpoints (only local fake servers with a test CA),
  Node's `NODE_USE_ENV_PROXY` behaviour with the explicit agents.

## 20. Phase 14.4 — implementation notes (p14-wf-ops)

What 14.4 adds (master + web; migration **0112**; no worker release) and where it refines §5.3–§5.5, §10.3 and §10.5.

### 20.1 Pause / resume

- `POST /workflows/runs/:id/pause` `{reason?}` and `POST /workflows/runs/:id/resume` `{}` (`workflows.run`, CSRF,
  audited `workflow.run.pause|resume`). Only an `active` run pauses (409 `run_not_active`); only a `paused` run resumes
  (409 `run_not_paused`). The run state is the only switch: `progress()` selects `active` runs, so while paused **no
  node run is released, claimed or evaluated** and no timer fires. Work already in flight finishes: a dispatched AI or
  function job keeps running and its result is taken on resume; a job not yet dispatched is held by the admission
  (`skip`, no transition) until resume. Webhook-wait calls and approval decisions are accepted while paused (stored);
  the run moves on with them after resume.
- **Timers vs timeouts.** Timers (`control.delay`, `waitUntil`, retry backoff) keep their instant: what came due while
  paused fires on resume (`waitUntil` with `late: skip` > 60 s late takes `timeout`, §5.3). Timeouts are shifted by
  the paused duration in the resume transaction (node `deadlineAt`, approval and webhook-wait timeouts and the wait URL
  expiry), so a pause never makes a waiting node time out; the run timeout excludes paused time
  (`workflow_runs.paused_ms`). Residual: a function job's queue timeout counts from its outbox row (a long pause can
  end it as `no_worker` on resume).
- Pausing a run pauses its open sub-workflow runs (`paused_by = run:<parent>`); resuming resumes those. State is in
  Postgres only, so a master crash or restart during a pause changes nothing (tested with a fresh service instance).

### 20.2 Re-run (from a node)

- `POST /workflows/runs/:id/rerun` `{fromNode?, latestVersion?, dryRun?}` (`workflows.run`, CSRF, audited
  `workflow.run.rerun`): only for finished engine-2 top-level runs (409 `run_not_finished`; 409 `rerun_not_supported`
  for engine-1 or sub-workflow runs). The answer carries the **plan** `{fromNode, version, copied[], fresh[],
  sideEffects[], aiSteps[]}`; `dryRun: true` returns it without starting (200) — the dialog shows "bu düğümler yeniden
  çalışacak" from `sideEffects` / `aiSteps`; otherwise 201 `{runId, plan}`.
- The new run (`rerun_of`, `rerun_from_node`, `trigger_kind = rerun`, run-as = the user who re-runs it) gets the same
  inputs, repository, priority, workspace files and trigger data. **Fresh** = the chosen node, its descendants, and
  every other top-level node of the source run that did not end well (failed without a handler, cancelled) with its
  descendants; **copied** = everything else, inserted as finished node runs (`copied_from` = the source node run, the
  same recorded input / output / state, payloads copied, iteration rows of copied groups included, AI steps keep their
  job as `reusedJobId`). No copied node is executed, so **no upstream side effect repeats** (fresh node runs have new
  idempotency keys — they are new effects, and the plan lists them). Without `fromNode` every node is fresh (a full
  re-run with the same data).
- Refusals: `rerun_node_unknown` (400), `rerun_node_in_group` (400; choose the group), `rerun_upstream_incomplete`
  (409; an ancestor did not end well — re-run from it), `rerun_data_pruned` (409; retention removed the data),
  `rerun_version_mismatch` (409; with `latestVersion`, a copied node changed type / group or its incoming links).
- The new run passes the concurrency admission (§20.3) like any run; with `onLimit: skip` it may end `cancelled` at
  once (reason `concurrency_skipped`).

### 20.3 Concurrency, run timeout, error workflow

- `settings.concurrency {max 1–50, onLimit: queue | skip | cancelOldest, key?}`: at start, under a transaction-scoped
  advisory lock per `(project, name, key)`, the open runs of the group (`active` + `paused`) are counted. Below `max`
  (and nobody queued ahead) the run starts `active`; else `queue` → `queued` (FIFO; the tick promotes the oldest queued
  runs under the same lock when a slot frees), `skip` → the run is recorded `cancelled` with reason
  `concurrency_skipped` and no node runs, `cancelOldest` → the oldest open run of the group is cancelled
  (`concurrency_replaced`) and the new one starts. `key` is an expression over `$inputs` / `$trigger` (e.g. the
  customer id; ≤ 200 characters as text, stored in `workflow_runs.concurrency_key`); a key that fails to evaluate
  refuses the start (400 `concurrency_key_invalid`). Sub-workflow runs are exempt (a parent waiting for its own queued
  child would deadlock). Races: two masters starting at once serialise on the lock (tested).
- **Run timeout** `settings.timeoutSec` (60 s – 90 d, no default as before) counts from activation
  (`activated_at`, not the time in the queue) and excludes paused time; exceeding fails the run.
- **Error workflow** `settings.onFailure {workflow}`: when a top-level run ends `failed` (not cancelled; never for a
  run that is itself an error run), a follow-up row is written in the same statement that ends the run
  (`workflow_run_followups`); the tick starts the named workflow of the same project (latest version) once —
  `workflow_runs.error_of` is unique — as the failed run's creator (re-checked: active, `workflows.run`), with
  `trigger_kind = error`, untrusted source and `$trigger = {event: 'workflow.failed', run: {id, workflow, version,
  project, startedAt, endedAt, reason, triggerKind}, failedNodes: [{node, type, code, message}]}` (≤ 20 nodes,
  messages clipped). The callee starts from its `trigger.error` nodes (new trigger type, no automation), else its
  manual triggers. Validation: `settings.onFailure.workflow: on_failure_self` (no self reference). A missing or
  archived callee, or a run-as refusal, is recorded on the follow-up (`note`) and audited, nothing else.

### 20.4 Retention, metrics, alerts

- **Retention**: node-run input / output, payload contents, received webhook bodies and the run's trigger data /
  outputs of **finished** top-level runs are pruned after `settings.retentionDays` (1–365) of the run's version, else
  the project's `workflow_data_retention_days`, else **30 days** (from `ended_at`). A run whose parent is still open is
  never pruned; open runs never lose data. Pruned values become `{"$pruned": true}` (AI node runs keep their role,
  placement, job id and expansion — the run view stays drawable); `workflow_runs.data_pruned_at` is set; metadata,
  states, errors and audit stay. Background step in the tick, at most every 10 minutes, ≤ 200 runs per pass, one master
  at a time (`pg_try_advisory_lock`). Migration 0112 lets the guards accept exactly these changes on finished rows.
- **Metrics** (OTel, the existing `MasterMetrics` reader / Prometheus endpoint): gauges `remyral_workflow_runs{state}`
  (open engine-2 runs), `remyral_workflow_node_runs_waiting{kind}`, `remyral_workflow_timer_lag_seconds` (oldest overdue
  timer of an active run); from a tailer over finished node runs: histogram `remyral_workflow_node_duration_seconds
  {type, state}`, counters `remyral_workflow_node_failures{type, code}` (codes of the closed engine set, else `other`)
  and `remyral_workflow_runs_finished{state}`. Copied node runs (re-runs) are not counted. For the editor:
  `GET /workflows/:id/metrics?days=1–90` (viewer+, default 30) → `{days, runs: {queued, active, paused, succeeded,
  failed, cancelled}, failureStreak, alertAfter, nodes: [{node, type, runs, failed, p50Ms, p95Ms, maxMs}],
  recentFailures: [{runId, endedAt, reason}]}` over every version of the workflow.
- **Alerts**: `settings.alerts {failuresInARow 0–100}` (default 3, 0 = off). When the N-th top-level run in a row
  fails (cancelled runs neither count nor break the streak), the project's owners / admins and the workflow's latest
  author get one `workflow.failed` notification (warning; deduplicated per streak), from the same follow-up step.

### 20.5 Respond to webhook (deferred from 14.2)

- `trigger.webhook {responseMode: ack | wait, responseTimeoutSec 1–30 (default 25)}`. With `wait`, `POST /v1/hooks/:id`
  keeps the request open after the signature checks and the automation enqueue, up to the timeout (bounded by
  `CONNECTION_CAPS.webhookWait {perKey: 4, total: 64}`; over the cap it answers the normal 202 at once), and answers
  with the first top-level `control.respond` node run that succeeds: its `status` (200–599, static), `body` (expression,
  JSON or text ≤ 64 KiB) and `headers` (expression values, names from the allowlist `content-type`, `cache-control`,
  `etag`, `last-modified`, `retry-after`, `content-language`, `x-request-id`, `x-correlation-id`; `content-type` only
  `application/json` or `text/plain`; always `x-content-type-options: nosniff`, `content-security-policy: sandbox;
  default-src 'none'`, `cache-control: no-store` unless set). The run failing / being cancelled before it answers →
  500 `workflow_failed`; it finishing without an answer, the timeout, a skipped automation run or a client that went
  away → the normal 202 `{accepted, runs}` (the run continues).
- `control.respond` (ports `in`, `out` — the input passes through — and `error`) records `{status, headers, body}` on
  its node run (stored, redacted) and does nothing else, so a manual run or a re-run is harmless. Validation:
  `respond_in_group` (top level only), `respond_needs_wait_trigger` (the workflow needs a `trigger.webhook` with
  `responseMode: wait`); `not_available_yet` is gone.

### 20.6 Run view and editor (Diyalog)

- `GET /workflows/runs/:id` adds for engine 2: `run.engineState` (`queued | active | paused | succeeded | failed |
  cancelled`), `pausedAt`, `pausedBy`, `rerunOf`, `rerunFromNode`, `errorOf`, `concurrencyKey`, `activatedAt`,
  `dataPrunedAt`, `queuePosition` (1-based among the group's queued runs, else null); per node `copiedFrom` (source
  node run id or null). `GET /workflows/runs/:id/node-runs` adds `copiedFrom`.
- Run view: Duraklat / Devam ettir (confirm), "Buradan yeniden çalıştır" per node and "Yeniden çalıştır" for the run
  (dialog with the dry-run plan: copied, fresh, side effects and AI steps that run again; "en son sürümle"), queued
  ("Sırada · N."), paused and pruned banners, lineage links (re-run of / error run of), copied node runs marked
  "önceki çalıştırmadan". Editor: Ayarlar dialog for the workflow settings (concurrency + key expression, run
  timeout, error workflow, retention days, alert after N failures in a row), metrics tab, `control.respond` and
  `trigger.error` in the palette, webhook trigger response mode. TR + EN through `@remyral/i18n`.

### 20.7 Security review (14.4)

- No new master network path: `control.respond` only answers the caller already connected to the master; its headers
  are allowlisted, its content types cannot be active content (no HTML / XML / SVG on the console origin; `nosniff` and
  a sandbox CSP), status and header names are static, bodies are bounded and redacted before storage. Held requests are
  bounded in time and count (connection cap) and released on client disconnect.
- Re-runs carry no authority of the source run: the new run runs as the user who asked (`workflows.run` in the
  project); side effects downstream of the chosen node are new, listed effects; upstream ones are never repeated (no
  copied node executes; tested with notifications and HTTP jobs).
- Error workflows run as the failed run's creator after a permission re-check, with the failure context as untrusted
  data (error messages may contain remote text); at most one error run per failed run (unique `error_of`), never a
  chain (error runs do not trigger error workflows).
- Pause cannot be used to escape approvals or timeouts: decisions still need the gate role and step-up; timeouts are
  shifted, not dropped; cancel and the kill switch act on paused and queued runs.
- Retention only ever replaces data with `{"$pruned": true}` on finished rows (database guards), never states or audit.
- Metrics carry enumerations and node types only (no names, keys, data).

## 21. Phase 14.5 — implementation notes (p14-wf-templates)

What 14.5 adds (master + web + protocol / assistant prompt; **no migration**; worker release for the assistant) and
where it refines the text above. 14.4 (re-run, pause, concurrency, retention, respond-to-webhook) is built in parallel
and is not a prerequisite: templates use only `typesDeliveredBy('14.3')`.

- **Version-1 workflows on engine 2** (§5.7). The engine choice already lived in `startRun` (`v2ForV1 && version === 1
  → engine 2`) and the engine is stored per run, so the switch needed no engine change: with
  `WORKFLOW_ENGINE_V2_FOR_V1=true` new runs of v1 documents start on engine 2 (`normaliseV1`), runs that started on
  engine 1 keep it and `progress()` (both engines every pass) finishes them; turning it off sends new v1 runs back to
  engine 1 and lets open engine-2 runs finish. Gate: the parity suite `workflows.test.ts` (engines 1 and 2, three
  real workers — green, 14/14), the new `workflow-migration.test.ts` (a run started before the switch finishes on
  engine 1 with its legacy rows, the next run starts on engine 2, rollback both ways) and the dry run.
  `workflow:normalise-check` now also validates normalised v1 documents with only the executable types, and reports
  the version-1 workflows (latest, not archived) whose new runs move and the open runs per engine; it is a
  `remyral-master` image mode (`remyral-master workflow:normalise-check`). The owner flips the flag
  (docs/ops/deploy-coolify.md); no shadow mode was built — the parity suite plus the dry run are the gate, and the
  per-run engine makes the switch reversible.
- **Chat drafts of v2 workflows.** `draft_workflow` (protocol) accepts v1 and v2 documents (≤ 200 nodes, ≤ 600 edges,
  ports, `parent`, `type` + `config`); a new read tool `workflow_node_catalog` returns the catalog compactly (ports,
  field modes, required keys, executable now, permission) and JSON Schemas of up to 20 requested types (≤ 48 KiB),
  built from `WorkflowService.catalog()`. The master validates the draft as `POST /workflows/validate` (catalog,
  expression scan, egress policy, credential bindings) before the card exists; the card payload carries a summary
  without prompts or configs (`type`, `label`, `parent`, `fromPort`), `schemaVersion`, `privileged` (the
  `privilegedDelta` against the latest version) and `needsStepUp`. Confirming passes the user's subject and step-up
  freshness to `define` / `update`, so privileged nodes need the `workflows.define.*` action and a fresh code exactly as
  in the editor (403 audited otherwise; before 14.5 every privileged chat draft was refused). The Diyalog card draws the
  typed mini graph and offers **Editörde aç**: the editor opens the drafted document as an unsaved working copy (router
  state; for an update on top of the saved version). System prompt rule 25 tells the model when to use v2 and to read
  the catalog first. Tool and prompt are loaded by the assistant on its worker → **worker release**.
- **Templates.** `packages/workflow-nodes/src/templates/` (pure): `WORKFLOW_TEMPLATES` (`marketing-content-calendar`,
  `marketing-lead-intake`, `content-production`, `video-production`), placeholder specs (kinds `origin`, `path`,
  `credential` (+ `credentialKind`, `hostFrom`), `email`, `text`, `cron`, `smtpProvider`, `runtime`, `number`,
  `choice`) and `fillTemplate(id, values, text)` which checks every value by kind (origins with the catalog's
  `HttpOrigin`, so private / metadata hosts are refused at fill time too; no `{{` in text values; unknown keys
  refused) and builds a v2 document; optional API credentials drop the node's `auth`. Node labels, the workflow
  description and the texts written into notifications come from `@remyral/i18n` `workflowTemplates` (TR / EN, by the
  request's `locale`); AI prompts are English instructions that name the output language. Master
  `template-routes.ts`: `GET /workflows/templates` (`workflows.read`) and `POST /workflows/templates/:id/instantiate`
  (`workflows.define` on the body's project, CSRF; `dryRun` → validation only; else `define(…, {via: 'duplicate',
  access})` → version 1, `workflow_exists` for a taken name, audit `workflow.define` + `workflow.template.instantiate`
  without values). Web: Workflow'lar → **Şablonlar** (gallery by category with a static graph preview, machine / admin
  badges) and a three-step wizard (project + name; placeholders with vault credential selects filtered by kind and a
  warning when not bound to the entered host; master dry run with issues mapped to placeholder labels, step-up retry).
  User guide: docs/ops/workflow-templates.md.
- **Security review (14.5).** No new master network path: templates and chat drafts only produce definitions that go
  through the existing save path (catalog validation, static-field rule, secret scan, egress policy at save and run,
  credential host binding, privileged delta + step-up, audit). Templates hold no hosts or secrets (tested); every
  endpoint is a user placeholder validated by kind, credentials are vault ids only. The catalog read tool exposes only
  public catalog metadata. Card summaries carry no prompts or configs. The chat confirm now honours step-up instead of
  refusing privileged drafts — the same rule as the editor, re-checked for the confirming user. Residual: the video
  template hands a provider's pre-signed upload URL to an AI step as fenced data (a short-lived capability by design of
  such APIs, scoped to one upload); provider answers are untrusted data and only flow into expressions and fenced
  context. The `WORKFLOW_ENGINE_V2_FOR_V1` switch changes no permission: v1 documents carry only AI steps.
- **Tests:** `packages/workflow-nodes/test/templates.test.ts`; `apps/master/test/integration/workflow-templates.test.ts`
  (list, dry runs, value / host / credential refusals, operator 403, stale step-up 403, all four saved and re-validated,
  name conflict, a content-template run creating its first function job, engine off),
  `chat-workflow-draft-v2.test.ts`, `workflow-migration.test.ts`; protocol / agent-adapters assistant tests;
  `apps/web/test/diyalog-workflow-templates.test.tsx`, `diyalog-workflow-chat-draft.test.tsx` (TR + EN).
- **UNVERIFIED:** the templates against real provider APIs (social, enrichment, CRM, search, CMS, TTS, image / video
  generation, video platform) and real SMTP — only placeholders and local fakes; the video render on a container worker
  with ffmpeg; a real model drafting v2 workflows through the new tool (tested with the fake assistant engine); the
  gallery / wizard screenshots at 400 / 1440 px.
