# ADR-0031: Agent-requested sub-jobs and planner runtime selection, bounded by the project's delegation policy

- **Status:** Accepted
- **Date:** 2026-10-16
- **Deciders:** owner (2026-10-16: "YouTube videosu üret, görselleri Codex ile oluştur" — Claude manages,
  only image generation goes to Codex; real agent orchestration, work split across machines); implemented by
  `p8-orchestration`
- **Related:** docs/design/p8-orchestration.md (design + security review), ADR-0004 (leases, fencing, idempotency),
  ADR-0008 (truthful capabilities), ADR-0010 (untrusted text never authorises), ADR-0011 (additive protocol),
  ADR-0020 (approval policies), ADR-0021 (in-process job tools gated by the master), AGENTS.md rules 6, 7, 9, 11.

## Context
Until now the only multi-agent shape was a workflow drawn up front; a planner step could add tasks but not say which
runtime or machine they need, and a running agent could not hand off work at all. The owner wants an agent to run a
larger task and hand only one part (image generation) to another runtime, possibly on another machine. That makes an
agent — whose text is untrusted (ADR-0010) — the author of new jobs, which is a new trust boundary: it must not be a way
to escalate runtime, sandbox, approval policy, secrets, budget or machine choice beyond what humans allowed.
AGENTS.md rule 9 forbids a second scheduler next to the platform's own orchestration.

## Decision
1. **Sub-jobs are ordinary jobs created by the master on an agent's request.** The worker offers `request_subtask`,
   `wait_subtask` and `cancel_subtask` to a job's agent (Claude Code: in-process MCP server, like the machine-admin
   tools); every call becomes a control message `SUBTASK_REQUEST` fenced to the requesting job's **live lease**
   (attempt + epoch + worker), answered by `SUBTASK_STATUS`. Creation is idempotent per (parent, request id). The child
   goes through the normal job store, scheduler, quotas, budgets, approvals and audit — no second scheduler.
2. **Off by default, per project.** The project's execution policy gains `subtasks` (admin, always-fresh step-up,
   audited, owners notified) and `delegationRuntimes` — the runtimes agent-chosen work may use besides the requester's
   own. Workers only get the tools when the switch is on, the job's depth allows it and they advertise `subtasks-v1`.
3. **The child's spec comes from the parent's stored spec and the policy, never from the agent.** The agent supplies a
   title, a prompt, a runtime choice inside the allowlist, capability tags and small input files. Sandbox profile and
   source trust are the parent's; the approval policy is the stricter of the parent's submitted and effective policy;
   no secret references, fallbacks, deploy or site bundle; limits are carved from the parent's remaining budget and
   deadline; the creator is the parent's creator, re-authorised (`jobs.create`) at request time.
4. **Bounded:** depth ≤ 2, ≤ 8 sub-jobs per job, ≤ 4 open, ≤ 16 per family; machine-admin jobs never delegate; open
   sub-jobs of an ended parent are cancelled by a tick step.
5. **Results are data.** A finished child's summary is handed to the parent fenced as data; workspace files are copied
   into the parent's inputs once (validated, secret-scanned, quota-checked) and downloaded read-only into
   `in/subtasks/<id>/`.
6. **Planner hints follow the same allowlist.** A plan task may name `runtime`, `model` (enabled catalog profile),
   `requires` (protocol capability tags) and `machine` (hint). Runtimes outside {planner runtime, runtimes the
   definition names, the project's delegation runtimes} reject the plan; unknown machines are ignored with a note.

## Alternatives considered
- **Let the agent submit jobs through the public API with a token.** Rejected: a credential inside agent reach, no
  fencing to the lease, no derivation of the spec from the parent — the agent could choose any profile or policy.
- **Only static workflows.** Rejected: the owner's flow is decided while the work runs (how many images, which ones).
- **Turn-based waiting (the parent ends its turn and is resumed when the child finishes).** Rejected for now: not every
  runtime resumes reliably mid-job; a bounded long-poll tool call with an explicit "still running, call wait_subtask"
  answer works for every runtime that has a tool channel.
- **Trust planner runtimes directly.** Rejected (ADR-0010): plan text is agent output.

## Consequences
- New protocol messages and a worker feature (additive in 1.0); a worker release is needed for the tools.
- Migration 0065: `projects.subtasks_enabled`, `projects.delegation_runtimes`, `job_subtasks`, `job_inputs.source =
  subtask`, `workflow_nodes.placement`.
- Codex, Pi and OpenCode jobs get no sub-job tools in this release (backlog `p8-subtasks-codex`, `p8-subtasks-others`);
  the worker simply does not offer them.
- Cost: every child is a full job; the family limits and carved budgets bound it, budgets and quotas apply as usual.

## Verification
Unit tests (limits, runtime choice, plan hint resolution), adapter tests (MCP registration, pre-approval in every
permission mode), worker tests (input reading without symlinks, long-poll, delivery), a master integration suite with
two real worker daemons (switch off, cross-machine Codex child with file round trip, runtime and depth refusals, cancel
cascade, stale lease, planner hints and rejected plans, audit), web tests. Live multi-machine run: backlog
`p8-orchestration-live`.
