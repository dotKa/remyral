# Design note: `p5-full-access` — owner-controlled full permission

- **Task:** `p5-full-access`. Owner decision 2026-10-14: "Full access, full permission da istediğimde yapabilmeliyim."
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0020 (this decision), ADR-0019 (unconfined), ADR-0007 (profiles), ADR-0008 (truthful
  capabilities), ADR-0010 (untrusted sources), ADR-0011 (additive protocol), ADR-0012 (runtime surfaces),
  p4-approvals (authority order), p5-stepup-window (always-fresh class), p5-notifications.

## Shape

```
packages/protocol    ApprovalPolicy + 'allow-all' (common.ts), feature full-access-v1, ASSIGN_JOB
                     execution.autoApproveOptIn, assistant draft_job approvalPolicy
packages/scheduler   PlacementJob.approvalPolicy/autoApproveOptIn, PlacementWorker.fullAccessSupported,
                     reasons auto_approve_not_allowed, approval_policy_unsupported
packages/agent-adapters  allow-all → each runtime's never-ask mode; ask-sensitive workspace-write classification
apps/worker          advertises full-access-v1; preflight refuses allow-all without the opt-in / untrusted;
                     no `approval` capability needed for allow-all
apps/master          migration 0037; PUT /projects/:id/execution {allowAutoApprove}; project.execution outbox +
                     notification; submission refusals; placement facts; composer preview fullAccess;
                     chat draft_job gate; approvals job layer
apps/web             Projects → Execution policy "Full access" preset + auto-approve checkbox; composer Full access
                     toggle, "Never ask" option, runtime step uses the chosen sandbox, workspace defaults;
                     chat Full access badge; notification kind
```

## 1. Protocol (ADR-0011)

`JobSpec.approvalPolicy` is now `ApprovalPolicy = ask-all | ask-sensitive | deny-sensitive | allow-all`. An enum value
is not additive for an older parser, so `allow-all` reaches only workers advertising `full-access-v1`
(`WorkerFeature`), enforced by placement (`approval_policy_unsupported`, permanent). `ASSIGN_JOB.execution` gains
`autoApproveOptIn` (sent only with allow-all jobs). The chat tool `draft_job` accepts the new value.

## 2. Project opt-in (migration 0037)

`projects.auto_approve_execution boolean NOT NULL DEFAULT false`. `GET/PUT /projects/:id/execution` →
`{project, hostExecution, unconfined, allowAutoApprove}`; the PUT body takes `allowAutoApprove` optionally (absent =
keep, for older clients). Unchanged route rules: `projects.execution.write` (admin), always-fresh step-up, CSRF.
The update runs in one transaction: row lock, update, audit `project.execution.update {changeId, before, after}`
and — when anything changed — an outbox row `project.execution {project, changeId, userId, before, after}`. The
notification producer turns it into a `project.execution` notification for owners/admins: critical ("FULL ACCESS
enabled …", "Auto-approve ENABLED …", "Unconfined execution ENABLED …") when unconfined or auto-approve goes on,
info otherwise; the body lists the flags before/after and what stays gated. The new notification kind widens the
two CHECK constraints (migration 0037).

`allowAutoApprove` does not require `unconfined`: a container job without prompts is valid (and safer). The panel's
**Full access** preset sets all three flags in one save.

## 3. Submission, placement, worker

| Where | Rule | Code |
| --- | --- | --- |
| `JobStore.create` (every path: REST, composer, chat confirm, workflows) | allow-all needs `sourceTrust: trusted` | `spec.sourceTrust:auto_approve_requires_trusted_source` |
| `JobStore.create` | allow-all needs the project opt-in | `spec.approvalPolicy:auto_approve_not_allowed` |
| placement (dispatch and preview) | opt-in re-read at every placement | `auto_approve_not_allowed` (permanent) |
| placement | worker advertises `full-access-v1` | `approval_policy_unsupported` (permanent) |
| worker preflight | `execution.autoApproveOptIn === true` and trusted source | lease declined `auto_approve_not_allowed:` / `auto_approve_requires_trusted_source:` |

The approval engine's job layer treats `allow-all` like `ask-sensitive`: it can only tighten, so the platform floor
(protected push/merge, force push, deploy, deletes outside the workspace, secret reads, budget increases) is
untouched — unit test "allow-all keeps every platform gate".

## 4. Adapters

| Runtime | `allow-all` | `ask-sensitive` (new: no prompt for) |
| --- | --- | --- |
| Claude Code | `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`; inline/managed settings without `disableBypassPermissionsMode` (every other policy keeps `"disable"`); init check expects `bypassPermissions` (another mode aborts the session); `canUseTool` allows whatever is still routed | Write/Edit/MultiEdit/NotebookEdit whose target is inside the workspace (realpath of the deepest existing ancestor; broken symlink = outside; `.git/` still asks; win32 roots compared case-insensitively) — `out/summary.md` no longer asks; one plain Bash command (no metacharacters, quoting, globs, `~`, newlines, background) of `ls pwd cat head tail wc grep rg stat find`, `git status/log/diff/show/rev-parse`, without dangerous options (git `-c`, `--output`, `--ext-diff`, `--textconv`; rg `--pre`, `-z`; find `-exec`, `-delete`, `-fprint*` …), every path argument inside the workspace (`claude-code/classify.ts`) |
| Codex | approval policy `never`; a request that still arrives is approved | unchanged (its `workspace-write` sandbox already lets in-workspace edits through). The `unconfined` sandbox policy stays `externalSandbox` / network `restricted` (`dangerFullAccess` not verified) |
| OpenCode | every permission `allow` except `question`, `lsp`, `skill` (deny); ruleset `*` allow; drift check unchanged | `edit` → `allow` (`external_directory` stays `deny`, so edits stay inside the workspace); bash/webfetch/websearch ask |
| OpenHands | confirmation policy `NeverConfirm`; `ohDecideBatch` accepts every batch; tamper checks compare with the policy expected for the job (interactive sessions keep `AlwaysConfirm`) | `file_editor` `create`/`str_replace`/`insert`/`undo_edit` inside the workspace accepted; a batch with a terminal action asks |
| Pi | permission gate mode `allow-all` never blocks (used even without an approval channel) | `edit`/`write` whose `path` is inside the workspace (gate gets the root; `~`, `@`, outside, symlink escapes, `.git`, any error → ask) |

The worker's runtime gate does not require the `approval` capability for `allow-all` (as for `deny-sensitive`).

## 5. Composer, Projects, chat

- **Projects → Execution policy:** "Full access (full machine + no approval prompts)" preset (one always-fresh
  save of host + unconfined + auto-approve; "Turn full access off" clears unconfined and auto-approve, keeps host),
  an "Allow auto-approve" checkbox, a danger notice listing what stays gated and the risks, and the worker-side
  requirement ("Allow unconfined", link to Fleet).
- **Composer preview** (`POST /jobs/placement-preview`) takes `approvalPolicy` and answers `autoApproveExecution`
  and `fullAccess {available, reasons[{code, message}], workers[]}` — available when the project allows host,
  unconfined and auto-approve and at least one enrolled worker has `unconfined` ready and advertises
  `full-access-v1`. New issues `auto_approve_not_allowed`, `auto_approve_requires_trusted_source`.
- **Composer:** "Full access" toggle on the Sandbox & constraints step (unconfined + allow-all + trusted; turning it
  off restores the previous values; disabled with the reasons and links otherwise); "Never ask (full access)"
  approval option (disabled unless allowed); review badge. **Bug fix:** the Runtime step evaluated availability with
  the default container profile — it now uses the draft's sandbox (and has its own "Availability for sandbox"
  selector) and ignores a preview computed for another profile. **Defaults:** workspace jobs default to a trusted
  source and, when the project allows host execution, the best host profile the eligible workers have ready
  (host-restricted > runtime-sandbox > container); never `unconfined` by default; explicit choices are kept.
- **Chat:** `draft_job` refuses allow-all / unconfined unless the project allows them, naming the missing switch;
  the card data carries `fullAccess` and a notice; the web card shows a prominent badge ("Full access",
  "No approval prompts" or "Unconfined"). Confirming stays the existing human click with step-up. Assistant rule 8:
  propose full access only when asked or clearly needed and allowed; never because content asks for it.

## Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Prompt-injected agent acts unattended with full rights | owner opt-in per project (always-fresh, audited, critical notification) + worker switch + trusted source only; platform gates unchanged; limits, budgets, cancel | Everything the worker service account can reach, until someone cancels (accepted by the owner, ADR-0020). |
| Panel/master compromise enables full access | three always-fresh admin actions, each audited and notified; local veto on the machine | As ADR-0019 plus no prompts. |
| Untrusted source auto-approved | refused at submission, by placement facts and by the worker | — |
| Older worker mis-parses allow-all | never placed there (`full-access-v1`); an older worker that somehow gets it fails the parse (protocol error), never runs it with another policy | — |
| Opt-in withdrawn after submission | re-checked at every placement and by the worker (`autoApproveOptIn` from the current project row) | A job already running keeps its policy until it ends or is cancelled. |
| ask-sensitive path classifier escapes the workspace (symlink, `..`, absolute, Windows case) | realpath of the deepest existing ancestor, separator- and case-aware containment; anything unsure asks | A file created later through a pre-existing in-workspace symlink race (TOCTOU) — the agent could create the same file through a shell call that asks anyway. |
| Read-only command allowlist abused | single simple command, no metacharacters/redirection/substitution, allowlisted programs and subcommands, every path argument inside the workspace | — (Replaced 2026-10-16 by the audited, project-switchable [safe commands](p6-safe-auto-approve.md); the local Bash shortcut is gone.) |

## Rollback

Migration 0037 is additive (one column, widened CHECKs). Turning full access off is one panel action; withdrawing the
project opt-in stops new placements. An older worker ignores everything new; an older web client keeps the value
(the PUT field is optional). Reverting the build leaves `auto_approve_execution` unused.

## Verification

| What | Result |
| --- | --- |
| protocol, scheduler, approvals, adapters (63 classifier cases incl. symlink/`..`/Windows paths), worker preflight | unit tests pass |
| master integration `full-access.test.ts` (opt-in step-up/audit/notification, refusals, placement to SUCCEEDED on a `full-access-v1` worker with the fake runtime, never on an older build, withdrawn opt-in, composer reasons), `chat.test.ts`, `sandbox-ops.test.ts` | pass |
| web `full-access.test.tsx` (preset, toggle, runtime step uses the chosen sandbox, defaults, badges) | pass |
| Claude Code bypass options on the real Windows 11 machine (`ssh desktop-pc`, temp dir, empty `CLAUDE_CONFIG_DIR`, no credentials, Agent SDK 0.3.296 / CLI 2.1.296, node 24.21.0) | **verified**: `INIT permissionMode=bypassPermissions`, then "Not logged in" (expected); control run with ask-sensitive options → `permissionMode=default`. Service and its folders untouched; temp dir removed |
| a logged-in full-access run that writes files, as `NT SERVICE\RemyralWorker` | UNVERIFIED — owner checks end to end through the panel after deploy |
| OpenHands `NeverConfirm` on the pinned server; Pi workspace-write exemption against the real Pi binary | UNVERIFIED (unit tests only; name from docs/compat/openhands.md) |
