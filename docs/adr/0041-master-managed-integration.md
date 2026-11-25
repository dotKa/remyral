# ADR-0041: Master-managed integration — the work of several agents ends in one integration branch and ONE pull request

- **Status:** Accepted
- **Date:** 2026-10-18
- **Deciders:** owner (2026-10-18: "for combining code from several agents choose the model that makes most sense
  long-term" — delegated); decided by Claude; implemented by `p11-merge-pipeline`
- **Related:** docs/design/p11-merge-pipeline.md (design + security review), ADR-0031 (agent-requested sub-jobs),
  ADR-0004 (leases, fencing, idempotency), ADR-0008 (truthful capabilities), ADR-0010 (untrusted text never
  authorises; integration only via the integrator + human approval), ADR-0035 (verification gate), p4-git-flow,
  p4-dag §6, AGENTS.md rules 1, 6, 7, 9, 10, 11.

## Context
Agents can now split work: a coordinator job delegates to sub-jobs (ADR-0031), workflows fan out to several steps.
Every resulting branch was verified alone and — on GitHub — got its own pull request; nothing combined them. Sub-job
branches were never merged into the coordinator; a workflow's "integrator" was an agent asked to merge branches by
itself, with no deterministic record of what it merged and no defined handling of conflicts. A human ended up with N
pull requests that conflict with each other, no test of the combined result, and no single place to approve. The owner
asked for the model that makes the most sense long-term.

## Decision
1. **The master owns integration, deterministically.** For a coordinator whose repository sub-jobs have settled (and for
   a workflow integrator step) in a project with git flow and integration mode `master` (the default), the master creates
   `int/<root8>` from the target's current head and merges the members' **verified** branches in a defined order
   (dependencies, then non-overlapping before overlapping siblings, then creation or completion time — configurable).
   The merging is done by an **integration job** (`kind: "integration"`) on a worker with real, hardened git (no hooks,
   attributes from the empty tree) and **no agent**; only the master can create such jobs.
2. **Results are verified before they count.** Every job of the integration publishes its attempt branch like any job;
   git flow verifies it on the remote; the master checks that it builds on the integration head and contains every
   commit reported merged, then **fast-forwards** `int/<root8>` (never forced; a moved branch stops for a human).
3. **Conflicts go to a bounded resolution job.** The first conflict aborts the round; an agent job with the coordinator's
   policy gets both sides' diffs, the conflict markers and both task descriptions **as fenced data**, rewrites only the
   conflicting files, and the next round takes exactly those files from its verified result. At most N rounds (project
   setting, default 3), then a human.
4. **The combined result is tested.** The project's verification (p10 repository checklist / test command) runs on the
   integration branch; a failure opens a bounded fix job (default 1), then a human.
5. **ONE pull request, merged by a human.** Members (sub-jobs, the coordinator, workflow steps, the integration's own
   jobs) get no pull request of their own; the integration opens one PR `int/<root8>` → target with a generated
   description (tasks, runtimes, machines, merge / conflict log, test result). Merging stays as today: the protected
   merge of the integration's head job (`git.merge`, admin + step-up, sha guard) or the provider's protected PR merge.
   After the merge, members waiting for a decision are approved as the person who approved the merge.
6. **Ownership reduces conflicts up front.** Sub-job requests carry `paths`; overlaps between siblings are warned about
   (to the agent and in the console) and ordered last; the coordinator is told to split work by disjoint paths and never
   to merge sub-job branches itself.
7. **A workflow integrator step in such a project is integrated by the master**, not run as an agent; projects with
   integration mode `off` keep the previous behaviour.
8. **Sub-job tools follow truthful capabilities:** Codex (app-server dynamic tools) and Pi (extension relay) get them
   now; OpenCode does not until its job sandboxes can reach a job-scoped tool endpoint (reasons in the design note §10).

## Alternatives considered
- **Each sub-job opens its own PR (status quo).** Rejected: N PRs that conflict with each other, no test of the combined
  result, conflicts left to the reviewer, no single approval.
- **An agent integrates (the old workflow integrator).** Rejected as the default: non-deterministic, unverifiable which
  commits were merged, conflict handling improvised; agents remain in the loop only for what needs judgement (resolving
  a specific conflict, fixing a failing test), bounded and verified.
- **Merge on the control plane (master-side git).** Rejected: AGENTS.md rule 1 (no checkout of user repositories on the
  control plane); the plain-git provider is off in production; GitHub's merge API cannot report conflict markers.
- **Stacked / sequential sub-jobs (each starts from the previous one's branch).** Rejected: serialises parallel work and
  still needs integration for anything not strictly sequential.
- **Auto-merge after green tests.** Rejected: AGENTS.md rule 10 — merging stays a human approval.

## Consequences
- New job kind and worker feature `integration-v1` (additive; a worker release is needed); placement treats the runtime
  of an integration job as a label.
- Migration 0089 (project settings, `job_subtasks.paths`, `integrations`, `integration_branches`, `integration_jobs`,
  artifact kind `integration`).
- The sub-job cascade no longer cancels sub-jobs waiting in AWAITING_APPROVAL (their run ended; they are integrated or
  decided by a person) — this also fixes verified sub-job work being cancelled when a coordinator ended without changes.
- More jobs per delegation (integration steps, possibly resolution / fix / verifier jobs): bounded by round limits; all
  are ordinary jobs under quotas, budgets and audit.
- Reviewers see one PR whose description explains how it was built; the per-task branches stay for inspection.

## Verification
Worker tests with real git (clean, conflict + markers, resolution applied, attributes ignored, missing commits); master
unit tests (order, overlaps, prompt fencing, PR escaping, provider ref updates with fixtures and real git); an
integration suite with a real master, worker daemon, worktrees and pushes (coordinator with conflicting sub-jobs →
resolution → tests → one PR → protected merge; failing tests → bounded fix → human; workflow integrator); adapter tests
for the Codex / Pi tools against the pinned binaries; web tests. Live GitHub run: backlog note of `p11-merge-pipeline`.
