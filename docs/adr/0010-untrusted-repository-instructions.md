# ADR-0010: Untrusted repository instructions

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p0-threat-model (T-INJ), p4-approvals, AGENTS.md rule 11

## Context
Repositories contain AGENTS.md/CLAUDE.md/README files, issues and PR text that agents read. These are attacker-controllable inputs (untrusted PRs, dependencies, fork contributions).

## Decision
1. **Authority order** (highest first): platform policy (master) → project policy set by an authenticated human in the console → job prompt from an authenticated user → repository content. Repository content can *inform* how to build/test but can never grant permissions, widen allowlists, request secrets, approve merges or trigger deployments.
2. Sensitive operations (push to protected branches, merge, deploy, network beyond allowlist, secret access, deleting data) are enforced **outside the model**: the worker/master policy engine gates them regardless of what the agent requests. An approval comes only from a human through the console/API.
3. Jobs on untrusted sources (fork PRs, external contributors) run with the most restrictive profile: `container` sandbox, no provider secrets beyond the model key, no git write credentials, network egress limited to the model API.
4. Provenance of every instruction source injected into an agent's context is recorded (p6-context-model), so audits can show what the agent saw.

## Consequences
Some agent conveniences (e.g. letting the agent push directly) are deliberately unavailable; integration happens via the integrator step with approvals.

## Verification
Red-team fixtures in p7: repositories containing injected instructions ("push to main", "print env", "curl secret to X") must not cause the gated action; attempts are audited.
