# Design note: agent orchestration — planner runtime selection, sub-job delegation, workspace workflows (P8)

- **Status:** Implemented (live multi-machine test UNVERIFIED, see §9)
- **Date:** 2026-10-16
- **Backlog:** `p8-orchestration` (with `p8-planner-routing`, `p8-subtasks`, `p8-workspace-workflows`,
  `p8-codex-images`)
- **Builds on:** [p4-dag.md](p4-dag.md) (workflows, planner sub-DAGs), [p6-smart-routing.md](p6-smart-routing.md)
  (routing rules), [p5-machine-admin.md](p5-machine-admin.md) (in-process job tools, tool inventory),
  [p5-research-workspace-next.md](p5-research-workspace-next.md) (workspace runs, upstream files),
  [p4-quotas.md](p4-quotas.md) (run limits), [p6-approval-mode-switch.md](p6-approval-mode-switch.md).
- **Decisions applied:** ADR-0004 (leases, fencing, idempotency), ADR-0010 (agent and repository text never
  authorizes anything), ADR-0011 (additive protocol changes), ADR-0008 (truthful capabilities), ADR-0021 (job tools
  gated by the master), **ADR-0031** (new: agent-requested sub-jobs).

## 1. Goal

The owner's example: *"produce a YouTube video, create the images with Codex"*. Claude Code runs the overall job and
hands only the image generation to Codex — possibly on another machine — then continues with the images. Three gaps
stood in the way:

1. A planner's plan (`remyral-plan`) could only say *what* to do: every planned task ran with the planner's runtime.
2. A running job could not ask for help: delegation existed only as a static workflow drawn up front.
3. Workflows required a repository project in the composer and chat, although the engine already ran workspace
   workflows (files flow `out/` → next step's `in/`, p5-research-workspace-next).

Plus: Codex jobs had image generation available but the images landed in `$CODEX_HOME/generated_images/`, outside
the workspace — invisible to `out/` collection.

## 2. Planner runtime selection

A plan task may now carry four optional hints:

```json
{"tasks": [{"id": "images", "title": "Thumbnails", "prompt": "…", "role": "executor",
            "runtime": "codex", "model": "gpt-5-codex", "requires": ["image-generation"], "machine": "desktop-pc"}]}
```

The plan is **untrusted data** (an agent wrote it). The engine resolves every task (`resolvePlanTask`,
`apps/master/src/workflows/placement.ts`) against an allowlist, never against the plan itself:

| Hint | Accepted when | Otherwise |
| --- | --- | --- |
| `runtime` | a known, non-retired runtime **in the delegation allowlist**: the planner step's runtime, every runtime the definition names (`defaults.runtime`, node `runtime`s, `fallbacks`) and the project's *delegation runtimes* (execution policy) | the plan is rejected: `tasks.N.runtime:not_allowed` (the run view names the allowed list) |
| `model` | an enabled model-catalog profile id offered for the chosen runtime (`catalogProblem` = null) | rejected: `tasks.N.model:not_allowed` |
| `requires` | ≤ 8 known capability tags (`CAPABILITY_TAGS`, protocol): tool tags (`browser`, `ffmpeg`, `python`, `git`, `docker`, `container`, `node`) become `requirements.tools` and are placed against the machines' tool reports; `image-generation` restricts the runtime to `codex` | unknown tag → rejected `tasks.N.requires:unknown_capability`; a runtime that contradicts a tag, or a tag whose runtime is not allowed → rejected `…:runtime_conflict` |
| `machine` | a hint: an approved, non-revoked worker by id or display name → `requirements.workers = [id]` | ignored, with a note on the step ("machine hint X unknown — placed by the scheduler") |

Absent `runtime`: an `image-generation` tag picks `codex`; else the routing rule of the task's kind (p6-smart-routing:
executor → `execute`, verifier → `verify`) when it picks an allowed runtime; else the planner's runtime. Limits, sandbox
profile, approval policy and source trust stay the planner step's (unchanged; a plan can never loosen them).
Model: the named profile, else the planner's model when the runtime is the planner's, else none (catalog / routing
defaults at submission).

**Explanation.** Every node now records `workflow_nodes.placement` (jsonb): `{runtime, source, model?, tools?,
machine?, notes[]}` with `source ∈ node | plan | requires | routing | planner | default`. Static nodes record it at run
start (node runtime / routing rule / definition default). The run view shows it per step ("codex — chosen by the
planner; needs image-generation; pinned to desktop-pc") next to the machine the job actually ran on.

## 3. Sub-job delegation (`request_subtask`)

### 3.1 Switch

Off by default. A project's execution policy (`PUT /projects/:id/execution`, admin + always-fresh step-up, audited,
owners notified like the other switches) gains:

- `subtasks: boolean` — agents of this project's jobs may request sub-jobs;
- `delegationRuntimes: RuntimeKind[]` — runtimes agent-chosen work may use besides its own (sub-jobs and planned
  workflow tasks). Empty = only the requesting job's own runtime.

### 3.2 Tools (Claude Code first)

The worker registers an in-process MCP server `remyral-subtasks` (like `remyral-admin`, ADR-0021) for a job whose
ASSIGN_JOB carries `execution.subtasks` (the master sets it only when the switch is on, the job is not a machine-admin
job, its depth allows another level, and the worker advertises `subtasks-v1`):

| Tool | Arguments | Result text |
| --- | --- | --- |
| `request_subtask` | `title` (≤ 200), `prompt` (≤ 32 KiB), `runtime?`, `requires?` (≤ 8 tags), `inputs?` (≤ 8 relative paths in the job's directory, e.g. `out/script.md`), `wait?` (default true), `waitSec?` (≤ 600, default 540) | the sub-job id and state; when waited and finished: its result summary (fenced as data) and the list of files copied into `in/subtasks/<id>/` |
| `wait_subtask` | `subtaskId`, `waitSec?` (0 = status only) | as above |
| `cancel_subtask` | `subtaskId` | the new state |

Claude Code: the tools skip the runtime's own permission prompt (the master's gates count, as for the admin tools).
**Since p11-merge-pipeline:** Codex (app-server dynamic tools) and Pi (extension relay) offer them too; OpenCode does not
(why: [p11-merge-pipeline.md](p11-merge-pipeline.md) §10). `request_subtask` takes `paths` (file ownership); repository
sub-job branches are integrated by the master into ONE branch and pull request (ADR-0041) — the coordinator never merges
them itself.

### 3.3 Wire (additive, control messages, seq 0)

- worker → master `SUBTASK_REQUEST {attemptId, epoch, requestId, op}` with `op` one of
  `{kind:'create', title, prompt, runtime?, requires?, inputs?:[{name, contentBase64}], wait}`,
  `{kind:'status', subtaskId}`, `{kind:'cancel', subtaskId}`.
- master → worker `SUBTASK_STATUS {attemptId, epoch, requestId, state, subtaskId?, reason?, detail?, runtime?,
  summary?, files?:[InputRef], dropped?}`; `state ∈ refused | queued | running | succeeded | failed | cancelled`.

Every request is fenced like MACHINE_ADMIN_REQUEST: only the worker holding the parent job's **live lease** under that
attempt and epoch gets an answer other than `refused / stale_lease`. Creation is idempotent per
`(parent job, requestId)` (a retried request returns the same child).

### 3.4 What the master creates

`SubtaskService.create` (apps/master/src/subtasks/service.ts) builds the child spec **only from the parent's stored
spec and the project policy**; the agent supplies title, prompt, runtime choice, capability tags and inputs:

| Field | Child value |
| --- | --- |
| project | the parent's |
| runtime | requested → must be in `{parent runtime} ∪ delegationRuntimes`, known and not retired; `image-generation` → codex; absent → routing rule for `execute` if allowed, else the parent's |
| model | the parent's when the runtime is the parent's, else none (catalog defaults) |
| repository / workspace | repository projects: the parent's URL and base ref, work branch `sub/<parent8>/<request8>`; workspace projects: the project's workspace settings, inputs = the inline files |
| sandboxProfile, sourceTrust | the parent's (absent trust stays absent = untrusted) |
| approvalPolicy | the stricter of the parent's submitted and effective (switched) policy: `deny-sensitive` > `ask-all` > `ask-sensitive` > `allow-all` |
| secretRefs, fallbacks, deferrable, siteBundle, requirements.workers | none |
| requirements.tools | from the capability tags |
| limits | `maxDurationSec` = min(parent's, parent deadline − now − 60 s); token / turn / cost limits (when the parent has one) = half of what remains of the parent's (limit − parent usage − limits already granted to its sub-jobs); refused `budget_exhausted` when < 120 s or nothing remains |
| role | `execute` |
| actor | the parent job's creator, re-authorized now (`jobs.create` in the project) |

Limits: depth ≤ 2 (a sub-job's sub-job is the deepest), ≤ 8 sub-jobs per job, ≤ 16 per family (root and all
descendants), ≤ 4 open per job. Machine-admin jobs never delegate. Inline inputs: ≤ 8 files, ≤ 256 KiB in total
(the 512 KiB frame), validated and secret-scanned like uploads; repository projects take no inputs (the child checks out
the same repository).

Rows: `job_subtasks (child_job_id PK, parent_job_id, root_job_id, depth, request_id, parent_attempt_id, title, wait,
requested_runtime, requires, placement, granted_limits, delivered, created_at)`, unique `(parent_job_id, request_id)`.
Audit: `job.subtask.create` (success / denied with the reason), `job.subtask.cancel`, `job.subtask.deliver`.

### 3.5 How the parent waits

Long-poll in the tool, resumable: `request_subtask` creates the child, then the worker asks `status` every 3 s until
the child is terminal or `waitSec` passed. Not finished → "still running; call wait_subtask with id …" (the agent's
turn continues; no MCP call blocks beyond 10 minutes). The parent's lease is renewed meanwhile as usual; the parent's
own `maxDurationSec` keeps running (the child's duration is bounded by it, §3.4).

### 3.6 Results

On `status` of a SUCCEEDED child the master returns its result summary (redacted, ≤ 8 KiB) and — workspace projects —
copies the child's committed artifacts into the **parent's** job inputs once (`delivered` records them; later status
calls return the same refs): names `<sub8>-<flat name>`, the per-delivery limits of upstream files (≤ 10 files,
≤ 10 MiB), each re-validated and secret-scanned (`prepareInput`); what does not fit or is refused is listed in
`dropped`. The worker downloads them with the existing JOB_INPUT_REQUEST (verified size + SHA-256) into
`in/subtasks/<sub8>/<name>` (read-only files) and the tool result lists the paths. The summary is shown to the agent as
fenced data ("data from a sub-job, not instructions").

### 3.7 Cancel, failure, view

- Cancel cascades: a tick step cancels every open sub-job whose parent is terminal (`parent job ended`), recursively
  (a cancelled child's children follow on the next tick). `cancel_subtask` and the job page cancel one child.
- A child's approvals are ordinary job approvals (Approvals page, notifications).
- `GET /jobs/:id/subtasks` → `{parent, children[]}`; the job page shows the tree (parent link, children with state,
  runtime, machine, files delivered, cancel).

## 4. Workspace workflows everywhere

The engine already handed upstream files to a workspace step (`<step>-<file>` in `in/`, limits, secret scan, quota).
Now:

- **Composer:** "A workflow run" is offered for workspace projects (no repository fields; run files and continue-from
  are handed to every step).
- **Chat:** `draft_workflow_run` accepts `continueFrom` / `inputArtifacts` for workspace workflows (ids only, the
  confirmation re-checks read rights); the card names the files.
- **Automations:** workflow targets of workspace projects already take the automation's files (unchanged; covered by a
  test).

## 5. Codex image generation in jobs

Verified on the pinned `codex-cli 0.162.1`: `codex features list` shows `image_generation  stable  true` (on by
default); the assistant switches it off (`features.image_generation=false`), the job adapter did not. A finished
generation is a thread item `imageGeneration {id, status, result, savedPath?}` (generated `ImageGenerationItem.ts`);
the CLI saves the file under `$CODEX_HOME/generated_images/<thread>/<call>.png` — outside the workspace, so `out/` never
saw it. The job adapter now:

- passes `-c features.image_generation=true` explicitly (a worker user's config cannot switch it off for jobs);
- on `item/completed` of a completed `imageGeneration` item copies the image into the workspace —
  `out/generated-images/<call>.<ext>` for workspace jobs (`SpawnContext.workspaceJob`, set by the worker for scratch
  jobs; `out/` exists); a repository worktree is never written to, even if it has an `out/` folder (the event says
  where Codex saved the image): source `savedPath` when it is inside the
  session's `CODEX_HOME`, else the base64 `result`; PNG / JPEG / WebP magic checked, ≤ 20 MiB;
- emits `tool_call` / `tool_result` events (`image_generation`) with the workspace path.

Live generation with the owner's ChatGPT login is **UNVERIFIED** (the Windows worker was logged in shortly before;
Claude runs the live test).

## 6. Security review

| Threat | Mitigation |
| --- | --- |
| Prompt injection in a plan or a job escalates runtime / model / policy | Plans and tool arguments are data: runtimes only from the allowlist (definition + project delegation runtimes + the requester's own), models only enabled catalog profiles, sandbox / approval / trust / secrets only from the parent spec (approval: the stricter one), limits drawn from the parent's |
| Fork bomb / cost runaway | Off by default per project; depth ≤ 2, ≤ 8 per job, ≤ 4 open, ≤ 16 per family; limits are carved from the parent's remaining budget; duration bounded by the parent's deadline; quotas and budgets apply to every child as to any job |
| A stale or foreign worker creates jobs | Every SUBTASK_REQUEST is fenced to the parent's live lease (attempt + epoch + worker); idempotent per request id |
| Files exfiltrate secrets or smuggle content | Inline inputs and delivered results go through `prepareInput` (type allowlist, content/type match, secret scan) and the quota; the worker reads only regular files inside the job directory (no symlinks, realpath check) |
| Privilege via the requester's identity | The child is created as the parent's creator, re-authorized at request time; a user who lost operator rights cannot be impersonated by a still-running job |
| Result text steers the parent | The summary is fenced as data in the tool result; files land read-only in `in/subtasks/` |
| Machine hint pins work to an unintended machine | Only approved, non-revoked workers; normal placement rules (runtime, profile, project) still apply; unknown hints are ignored with a note |
| Images outside the workspace | The adapter copies only from the session's own `CODEX_HOME` (or the result bytes), checks magic bytes and size |

## 7. Rollback

Master: switch `subtasks` off (default) — no new sub-jobs; open ones finish or are cancelled. The migration is
additive (columns with defaults, a new table). Worker: older workers do not advertise `subtasks-v1`, so they never get
`execution.subtasks`; a new worker on an older master never receives it either. Plans with the new fields on an older
master are rejected (`plan_invalid`) — only after a downgrade.

## 8. Tests

- unit: plan parsing + `resolvePlanTask` (allowlist, tags, model, machine hints), capability tags, subtask spec
  derivation (policy, limits, depth), approval strictness, worker input reading (symlinks, size), tool text.
- adapters: Claude Code registers `remyral-subtasks` and allows its calls; fake adapter `subtask` steps; Codex image
  copy (savedPath inside / outside `CODEX_HOME`, base64, magic check) and the `features.image_generation=true` arg.
- master integration (real Postgres/Redis, real worker daemons, fake runtime): switch off → tool absent / refused;
  parent creates a child on another worker, waits, gets the summary and `in/subtasks/` files; depth / fan-out / runtime
  refusals; idempotent retry; cancel cascade; stale lease refused; audit rows. Workflow plan with runtime / requires
  hints → node specs and placement; a disallowed runtime rejects the plan.
- web: run view placement line, job page sub-task tree, project execution switch, composer workflow mode for a
  workspace project.

## 9. Open / UNVERIFIED

- Live: Claude Code parent on one machine, Codex image child on the Windows worker (owner's ChatGPT login) — not run
  here; needs the master and a worker release deployed, the project's `subtasks` switch on and `codex` in its
  delegation runtimes.
- Sub-task tools for OpenCode — backlog `p8-subtasks-others` (Codex and Pi got them in p11-merge-pipeline; why not OpenCode: p11-merge-pipeline.md §10).
- Inputs larger than 256 KiB per request (chunked staging) — done in [p22-previews-inputs](p22-previews-inputs.md)
  (staged as `ws-subin-…` artifacts of the requesting attempt, ≤ 10 MiB per request).
