# ADR-0020: Owner-controlled full permission ("Full access": unconfined + never ask)

- **Status:** Accepted — owner decision, 2026-10-14: "Full access, full permission da istediğimde
  yapabilmeliyim." The owner must be able to run a job with full machine access **and** without approval prompts
  whenever they choose. **Partially superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands was removed; the OpenHands `NeverConfirm` mapping no longer apply).
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-full-access`
- **Amends:** ADR-0012 (the Claude Code adapter may start in `bypassPermissions`, the Codex adapter with approval
  policy `never` and the OpenHands adapter with `NeverConfirm` — only for `approvalPolicy: "allow-all"`). p4-approvals
  §2 (a fourth job-layer value that changes nothing at that layer). ADR-0007/0008/0010/0011/0019 stay binding.
- **Related:** docs/design/p5-full-access.md (design + security review), ADR-0019 (unconfined profile).

## Context
ADR-0019 gave the owner the `unconfined` profile, but it needed three separate switches (worker "Allow unconfined",
project execution policy, the job's sandbox) and there was no approval policy that never asks: every runtime tool
call that is not read-only went to the Approvals inbox. In the first live run on the owner's Windows worker even
writing `out/summary.md` inside the job's own scratch directory waited for a human. The owner runs his own machines
with his own subscriptions and wants unattended full-access runs to be a deliberate, visible, one-click choice.

## Decision
1. **Approval policy `allow-all`** (`JobSpec.approvalPolicy`, additive per ADR-0011): no runtime tool call asks. Each
   adapter maps it to the runtime's own never-ask mode (Claude Code `permissionMode: "bypassPermissions"` with
   `allowDangerouslySkipPermissions`; Codex `approvalPolicy: "never"`; OpenCode every permission `allow` except
   `question`, `lsp`, `skill`; OpenHands confirmation policy `NeverConfirm`; Pi's permission gate passes every call);
   anything a runtime still routes to the adapter's callback is approved by the adapter. The worker needs no
   `approval` capability for such a job.
2. **The platform's own gates stay.** At the job layer of the approval engine `allow-all` changes nothing (a job
   can never loosen a platform or project rule): protected-branch push and merge, force push, deploy, deletes outside
   the workspace, secret reads and budget increases keep their master approvals (or denials), as do every
   credential-vault action and every always-fresh panel action. The UI says so wherever full access is offered.
3. **Owner opt-in per project.** `projects.auto_approve_execution` (migration 0037), set only through
   `PUT /projects/:id/execution {allowAutoApprove}` — admin + always-fresh step-up, audited
   `project.execution.update` with before/after, a `project.execution` notification to owners/admins (critical when
   switched on). An absent field keeps the value (older clients).
4. **Refusals.** Submission refuses `allow-all` without the opt-in (`spec.approvalPolicy:auto_approve_not_allowed`)
   and for any source that is not `trusted` (`spec.sourceTrust:auto_approve_requires_trusted_source`) — untrusted
   sources are never auto-approved, whatever the project says. Placement re-checks the opt-in at every placement
   (`auto_approve_not_allowed`) and only chooses workers advertising `full-access-v1`
   (`approval_policy_unsupported`); older workers cannot parse the value and are never sent it. The worker itself
   refuses an `allow-all` lease without `execution.autoApproveOptIn` or with an untrusted source.
5. **One switch.** Projects → Execution policy → "Full access (full machine + no approval prompts)" sets host
   execution + unconfined + auto-approve in one always-fresh save; the worker side stays the existing Fleet → worker
   → Sandbox → "Allow unconfined" (ADR-0019, unchanged, locally vetoable). The composer's "Full access" toggle selects
   `unconfined` + `allow-all` + `sourceTrust: trusted` only when the project and at least one eligible worker allow
   it, else it is disabled with the exact reasons and links. The chat assistant may propose full access only when
   the project allows it; the draft card shows a prominent "Full access" badge and confirming stays a human click.
6. **Less noise under `ask-sensitive`.** File writes and edits whose target resolves (symlinks included) inside the
   job's own workspace or scratch directory (`out/` included) and plainly read-only commands no longer ask (Claude
   Code classifier, OpenHands `file_editor`, OpenCode `edit` with `external_directory` still denied, Pi edit/write).
   Shell commands that can change anything, and anything outside the workspace, still ask.

## Threat model impact
With full access on, a job of an opted-in project runs as the worker's service account with no filesystem or network
confinement (ADR-0019) **and** no human in the loop for its own tool calls: a prompt-injected or mistaken agent can
read and change everything that account can — the worker's data directory, other attempts, its local runtime logins,
any host reachable from the machine — before anyone sees it. Approvals no longer act as a brake for in-run actions;
only timeouts, budgets, resource limits, cancel and the platform gates remain. What it **cannot** do: get
root/SYSTEM/admin (identity rule), run on a machine whose owner set the local veto, run an untrusted source, push to a
protected branch, merge, force push or deploy through the platform without an approval, read vault credentials, or
switch itself on (every switch is an always-fresh admin action, audited and notified). A panel compromise now needs
three always-fresh actions (worker switch, project switch, a trusted-looking job) — the same set as ADR-0019 plus
one more flag — to get unattended full access. Residual: the agent can still use credentials that the worker
account itself holds (its own git config, CLI logins) to act outside the platform; the owner should keep such
credentials off machines that run full access.

## Alternatives considered
- **Auto-approve inside the adapters' callbacks only** (keep every runtime in its asking mode, answer "yes"
  automatically). Rejected as the primary mapping: the runtimes' own never-ask modes are what they are tested with
  and avoid one round-trip per call; the callback answer remains the fallback for anything still routed.
- **A per-job toggle without a project opt-in.** Rejected: one compromised operator session could then start
  unattended full-access runs; the project flag keeps it an admin decision with step-up.
- **Folding auto-approve into the `unconfined` flag.** Rejected: a container job without prompts is useful and much
  safer; the preset sets both in one click anyway.

## Consequences
Migration 0037 (`projects.auto_approve_execution`, notification kind `project.execution`), feature `full-access-v1`,
`ASSIGN_JOB execution.autoApproveOptIn`, placement reasons `auto_approve_not_allowed` and
`approval_policy_unsupported`, submission issue codes above, Projects → Execution policy preset, composer toggle,
chat badge, assistant rule 8.

## Verification
Unit tests per adapter (allow-all mapping, workspace-write classification), protocol, scheduler, approvals
(allow-all keeps every platform gate), worker preflight refusals; master integration (opt-in with step-up, audit and
notification; submission refusals; placement on a `full-access-v1` worker to SUCCEEDED, never on an older build,
stopped after the opt-in is withdrawn; composer preview reasons; chat drafts); web (preset, toggle, runtime step uses
the chosen sandbox, badges). Real-target check of the Claude Code bypass options: see docs/design/p5-full-access.md.
