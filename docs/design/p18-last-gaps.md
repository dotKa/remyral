# Design note: `p18-last-gaps` — engine-1 workflow gates in the chat, comments on compare views

- **Task:** `p18-last-gaps`. **Date:** 2026-10-28. **Branch:** `p18-last-gaps`. **Migration:** `0188_last_gaps.sql`
  (0186 belongs to the IDE W2 wave).
- **Owner (2026-10-28):** "geliştirmelere devam et hepsini tamamla".
- **Closes:** [p17-chat-flow §12](p17-chat-flow.md#12-not-done) / [p18-leftovers §7](p18-leftovers.md#7-engine-1-workflow-gates-in-the-chat--re-checked-still-not-done)
  (engine-1 gates are not announced) and [p18-leftovers §6](p18-leftovers.md#6-ide-w1-leftovers-p19-ide-not-in-w1) /
  [p19-ide "Not in W1"](p19-ide.md#implementation-w1) (comments on compare views).
- **No ADR:** no new trust boundary, transport or runtime surface. The decision paths are the existing routes; the new
  compare routes are reads and comment writes under `code.read` / `code.review`, and the PR job uses the job create rules.
- **No worker release, no feature flag:** the assistant's tool shapes and the system prompt are unchanged (see §1.5).

## 1. Engine-1 workflow gates in the chat

Before: a v1 document runs on engine 1 while `v2ForV1` is off (the default). Its step approval (`approval:
{approverRole}`) makes the step's `workflow_nodes` row wait in `awaiting_approval` with `gate_role`. Nothing in the chat
showed it: the approval card, "Senden bekleyen", the `flow` claims and the decide route were keyed by engine-2 node runs.

### 1.1 A stable step id

An engine-1 gate has no node-run id. Every surface that names an approval step by a node-run id names an engine-1 gate
by `gateId(run, node)`: SHA-256 of `remyral:gate1:<run>:<node>` laid out as an RFC 9562 **version-8** UUID
(`m/chat/flow-model.ts`). Engine-2 node runs are `gen_random_uuid()` (version 4), so the version nibble tells them apart
(`isGateId`); a gate id is always resolved inside its run (the run's gated nodes are hashed and compared). The id is a
name, not a secret: knowing it gives nothing without `workflows.read` on the run.

`WorkflowApprovalView` gains `engine: 1 | 2`. For an engine-1 gate: `nodeRunId` = its gate id, `nodeType` `ai.step`,
`title` = the step's `title`, `details` = its prompt as the author wrote it (bounded 200 / 2000, plain text — the run's
inputs are not substituted), `createdAt` = when the row last changed (it started waiting), no due time. State:
`waiting` (awaiting approval, no decision), `approved` / `denied` (the stored decision), else `closed` (the run was
cancelled, the step skipped …). `canDecide` is the engine-2 rule: `workflows.approve` in the project and the project role
at least the gate's role.

### 1.2 Announcement and claims

`ChatFlowService.tick` (every 5 s) also scans engine-1 gates waiting for a decision (new partial index
`workflow_nodes_gate_wait_idx`). Each is claimed once in `chat_flow_events` as `gate:<run id>:<node id>`; in the same
transaction, like an engine-2 step:

- a note in each linked conversation (`linksOfRun`: the conversation whose run card started it or its parent run, an
  active watch, the confirmed `draft_workflow` card that created the workflow; the owner must still have
  `workflows.read`) — `meta.notice = 'workflow-approval'`, **`engine: 1`**, `runId`, `nodeRunId` (the gate id), `node`,
  `workflow`, `project` (+ `planItem`);
- the notification `workflow.approval` to every user whose project role reaches the gate's role (`projectRecipients`),
  deduped by `workflow.approval:<gate id>`; never the step's texts;
- audit `chat.flow.approval` (`metadata.engine = 1`).

A gate decided or closed afterwards (any path: the run page, the chat card, "Senden bekleyen", the assistant, a
cancelled run) is claimed once as `gatedone:<run id>:<node id>` and the conversations showing its card get the `flow`
event `{kind: 'workflow-approval', engine: 1, runId, nodeRunId: <gate id>, node, state}` (ids and a state word only).
The engine-1 decide route sends it at once (`gateDecided`), the tick repeats it for every other path.

### 1.3 The decide path

The card decides through **engine 1's own gate route**, `POST /workflows/runs/:id/nodes/:node/{approve|deny}`
(`workflows.approve`, `requireStepUp`, the engine's role check against `gate_role`, the run lock, audit
`workflow.gate.*`). One decision wins: engine 1 refuses a second decision with 409 `not_awaiting_approval`. The live view
is the existing `GET /workflows/runs/:id/node-runs/:nodeRunId/approval`, which takes a gate id too (no new route).

### 1.4 "Senden bekleyen"

`ChatFlowService.pending` merges the engine-1 gates the caller may decide with the engine-2 steps (newest first, ≤ 50).
The ops-thread card stays `workflow:approval` with id `workflow:<gate id>`; its payload carries `engine: 1`.

### 1.5 The assistant

`describe_workflow_run` lists a waiting engine-1 gate under `approvals` with `nodeRunId` = its gate id (and whether the
user may decide it). `draft_workflow_approval_decision` takes that id unchanged: the plan reads the gate's view (not
found / already decided / not your role are answered as for engine 2) and the card (`workflow.decide_node`) carries
`engine: 1`; confirming it runs engine 1's `decideGate` (role, run lock, audit) for the confirming user and pushes the
`flow` event. The tool's input (`runId`, `nodeRunId`, `decision`, `reason`) and its description ("an AI step's gate or an
approval node") already cover it, so **no catalog or prompt change, no feature `assistant-wf1-gates-v1`, no worker
release**.

### 1.6 Web

`WorkflowApprovalCard` (chat note and "Senden bekleyen") reads `engine`; for 1 it decides through `decideGate(run,
node, …)` (the run page's engine-1 call, step-up by `useStepUp`) and says "Klasik motor (v1) adım onayı" under the step
line. Everything else (texts as text, state badge, reason, pushed refresh, "Run'ı aç") is unchanged.

## 2. Comments on compare views

Before: `/projects/:id/code/compare?base=&head=` was read-only; comments were anchored to a job
(`code_review_comments.job_id NOT NULL`) and "Değişiklik iste" was a job's.

### 2.1 Anchoring

`code_compare_comments` (migration 0188): project, `base_ref` / `head_ref` **as the view names them** (a branch or a
commit sha; checked like the compare route: a 40-hex sha, a target branch or an attempt branch), `base_sha` / `head_sha`
**as the view showed them** (the merge base and the head the client compared; 40 hex), path, side (`old` = the merge
base, `new` = the head), line range, one level of replies (a reply takes its thread's anchor), resolved / sent stamps.
A view lists the comments of the same (project, base ref, head ref). **Outdated** = the head ref resolves to another
commit now (computed on read; a head given as a sha never moves). ≤ 500 comments per view.

### 2.2 Routes

| Route | Action | Notes |
| --- | --- | --- |
| `GET /projects/:id/code/compare/comments?base=&head=` | `code.read` (viewer) | comments, the head's current sha, and `target` (§2.3) |
| `POST /projects/:id/code/compare/comments` | `code.review` (operator) | `{base, head, baseSha, headSha, path, side, startLine, endLine, body, parentId?}` |
| `PATCH /projects/:id/code/compare/comments/:cid` | `code.review` | edit one's own / resolve / reopen |
| `DELETE /projects/:id/code/compare/comments/:cid` | `code.review` | one's own; owners and admins any; a root takes its replies |
| `POST /projects/:id/code/compare/request-changes` | `code.review` | `{base, head, note?, hunks?}`; audited |

An invisible project is 404 like an unknown one (`projectParam`). Write bodies use the write class's default limit (no
`bodyLimit` exception); the RBAC matrix covers the routes from their declarations (`:cid` binds to the project fixture);
the route-coverage test lists them.

### 2.3 Where "Değişiklik iste" goes

`CodeService.compareTarget(project, head)`:

1. **A job's branch** — the newest verified `job_git` row of the project whose `branch` or `head_sha` is the head ref →
   that job's path, exactly as on the job's own reviewer: a message to its agent while it runs or will (`jobs.message`),
   else a follow-up job from its verified head with the original target branch (`jobs.create`); `job_busy` 409 as before.
2. **An open pull request** of the repository whose compare head or head branch is the head ref (the Kod tab's list, 60 s
   cache) and that lives in the same repository → **a new job on its branch**: `repository.baseRef` = the head commit the
   compare resolved, `targetBranch` = the PR's head branch (its result comes back as a pull request into that branch —
   nothing is pushed to the PR's branch directly), `workBranch` `agent/review-…`, the project's job defaults
   (`ProjectDefaults.apply`: routed runtime, sandbox, approval policy, limits; the registered repository is trusted
   source), the `JobSpec` check and `jobs.create` for the caller — the job create rules. Its prompt names the PR number
   and branches (never the provider's title text) and carries the review.
3. Otherwise **disabled with the reason**: `no_target`, `pull_fork` (a fork's branch is not ours to work on),
   `pull_branch` (not a valid target branch name), `provider_unavailable`. The request route answers 409
   `review_no_target` with `reason`.

The review text is the job reviewer's: open threads with replies, the note, and the rejected hunks' exact lines
**re-read from the provider** at the compare's merge base and head (never the browser's copy), redacted. Sent comments
are stamped. Audit `code.review.request_changes`, target `job:<id>` or `project:<id>`, metadata `source: compare`,
`reason` (`job_branch` / `pull_request`), refs, counts, the new job / message id — never a key named `code`.

### 2.4 Web

`DiffReview` takes a comment API per target (job / compare). On a compare view operators get **Yorum yaz**, **Reddet**,
threads (reply, resolve, edit / delete own) and the **Değişiklik iste** panel, which says where the review goes (the
job's branch with "İşi aç", "açık PR #n …", or an amber notice with the reason and a disabled button). Viewers read the
comments. The job reviewer is unchanged.

## 3. Feature parity (UI)

| Before | Now |
| --- | --- |
| `workflow-approval-card`, `-title`, `-details`, `-reason`, `-approve`, `-deny`, `-open` | unchanged; `workflow-approval-classic` added for engine 1 |
| Compare view: diff, file list, hunks, "Sohbete ekle" | unchanged; comment / reject / request actions added for operators |
| Job reviewer: comments, reject, Değişiklik iste (`code-request`, `code-request-summary`, `code-request-sent`) | unchanged (same components, comment API injected) |

No test id, aria-label, handler or link was removed.

## 4. Security review

- **No new authority.** Engine-1 decisions go through engine 1's existing route (role, step-up, run lock, audit); the
  assistant's card runs the same `decideGate` for the confirming user. The view and the claims add reads only.
- **Conversations stay private:** a note goes only into its owner's own conversation while the owner may read the run;
  the notification carries no run text; step texts are plain, bounded, rendered as text.
- **Gate ids** are derived names, not capabilities; resolving one needs read access to its run.
- **Compare comments** need `code.review` in the project to write and `code.read` to read; refs are validated like the
  compare route; texts are bounded and rendered as text. **Değişiklik iste** never writes to a branch: it is a job
  message or a new job under the job create rules (`jobs.message` / `jobs.create` checked in the service; the spec
  is filled from the project's defaults, checked against `JobSpec` and goes through the job store's own submission
  checks, e.g. allow-all only where the project allows it). A fork's branch is refused. The PR title (provider text) never
  reaches a prompt; hunks are re-read from the provider.
- Audit metadata uses `reason`, never `code`.

## 5. Tests

- Master unit `test/unit/p18-last-gaps.test.ts` (12): gate id (stable, version 8, not a version-4 id), claim keys
  against the migration's check, gate texts; the gate view (engine 1, texts, role, canDecide, hidden from other
  projects, unknown node), decided / closed states, "Senden bekleyen" merge; compare target (job branch, PR same repo,
  fork, none, provider down, bad ref), request changes (409 without a target, the PR job's spec / prompt / audit, a
  viewer refused).
- Master integration (needs a database; written, run with `REMYRAL_INTEGRATION=skip` here):
  `test/integration/p18-last-gaps.test.ts` — engine-1 card once, live view, notification, ops-thread card, decision
  through `/nodes/:node/approve` (step-up; 409 second), `gatedone:` claim, the assistant's describe / decide card;
  compare comments (rights, CRUD, outdated, refs), request changes (job message, PR job spec, fork 409, audit);
  `test/integration/route-coverage.test.ts` lists the new routes.
- Web `test/p18-last-gaps.test.tsx` (6): engine parsing, the engine-1 card deciding through `/nodes/build/approve`,
  compare comment anchored to refs + shas, the PR request, a job target link, a disabled request with its reason, the
  viewer.

## 6. Rollback and operations

- Web and master roll back independently. The migration is additive (key check widened, one partial index, one table);
  an older master ignores them. Old notes with `engine: 1` render as plain notes on an older console.
- Deploy: master (migration 0188) + web. **No worker release.**

## 7. Not done

- A compare whose head is given as a commit (the PR list opens a fork's PR by its head commit) keeps its comments with
  that commit: after a push the PR's new compare is a new view. Same-repository PRs can be opened by branch.
- Comments are not mirrored to the provider (as for job reviews).
