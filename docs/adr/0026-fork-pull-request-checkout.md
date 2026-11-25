# ADR-0026: Opt-in checkout of fork pull request heads for automations

- **Status:** Proposed — implemented by `p6-automations-next` (2026-10-16) as an explicit per-automation opt-in;
  owner sign-off of the trust model pending.
- **Date:** 2026-10-16
- **Deciders:** owner — pending; implemented by an agent
- **Related:** ADR-0024 (automations; its design note said fork heads are never checked out), ADR-0007 (execution
  profiles), ADR-0010 (untrusted repository instructions), ADR-0006 (secrets), ADR-0011 (additive protocol),
  ADR-0022 (panel GitHub App), docs/design/p6-automations.md §18.2

## Context
An automation reviewing pull requests is most useful on the pull requests of outside contributors — exactly the ones
from forks. ADR-0024 runs such events only on opt-in, as `untrusted` in the `container` profile, but on the **base
branch**: the fork's code was never checked out (not in the worker mirror). Checking it out means an agent reads, and
may run, attacker-controlled code (build scripts, tests, hooks, symlinks). The worker's shared mirror is also used by
trusted host-profile jobs; fork objects there would be one ref away from a host checkout.

## Decision
1. **Double opt-in per automation:** `allowUntrusted: true` **and** `checkout: "event"` on a `pull_request` /
   `pull_request_review` trigger. Otherwise untrusted events keep the base branch (or are ignored).
2. **Pinned:** the run records the PR number and the event's `pull_request.head.sha`; the job's
   `repository.baseRef` is that SHA and `repository.pullRequest = {number, headSha}`. The fork's URL and branch name
   are never used. A head that is no longer reachable from `refs/pull/<n>/head` (force push) refuses the run
   (`pr_head_moved`); the next `synchronize` event runs on the new head.
3. **Confined:** protocol, master and worker all refuse such a spec unless `sourceTrust: untrusted`, the `container`
   profile and no `secretRefs`; `allow-all` is downgraded to `ask-sensitive`.
4. **Quarantined:** the worker fetches only `+refs/pull/<n>/head` into a **separate quarantine mirror** per repository
   (no branches, no tags) and creates the worktree at the SHA. The trusted mirror never receives fork objects.
5. **No credentials, no push:** the master issues at most a **read-only** installation token (`contents: read`,
   `metadata: read`) used by the worker's own fetch (credential helper environment only, never in the workspace, the
   runtime's environment or the container); `pushResult` is never set and the worker refuses to commit/push such a
   workspace regardless.
6. **Additive protocol:** worker feature `pr-head-v1`; the master places such jobs only on workers advertising it
   (placement reason `pr_head_unsupported`).

## Alternatives considered
- **Keep never checking out forks** — safest, but an automation can then only comment on PR metadata; the owner asked
  for fork PR automations.
- **Fetch fork heads into the shared mirror** — simpler, but puts attacker objects next to trusted refs used by host
  profiles; rejected.
- **Clone the fork repository URL** — the URL and branch are attacker-chosen (and can be deleted or moved); the base
  repository's `refs/pull/<n>/head` is GitHub's own record of the PR head and works with the base repository's
  token.
- **Check out `refs/pull/<n>/head` (not the SHA)** — races with later pushes; the event's SHA is what was reviewed.

## Consequences
- The agent may execute attacker code inside the container: bounded by the container's egress allowlist, resource
  limits, approvals and the absence of credentials and secrets. Its output is a report; nothing is pushed or merged.
- Model provider credentials still reach the runtime (it cannot run otherwise); a hostile repository can try to make
  the agent exfiltrate them through allowed egress — the same residual risk as any untrusted container job (ADR-0007).
- Older workers never receive these jobs; projects without an updated worker see `pr_head_unsupported`.
- Disk: one more bare mirror per repository that runs fork automations (pruned like the others).

## Verification
Protocol refinement tests; scheduler placement test; worker tests against a fake GitHub (local bare repository with
`refs/pull/<n>/head`): pinned checkout, quarantine mirror separate from the trusted one, moved head refused, no
token in workspace or mirror, push refused; runner preflight refusals and no push; master integration test of the
run, job spec and secret-reference refusal; credential unit test (read-only token). Unverified: a real GitHub fork
PR over HTTPS with an installation token on a `pr-head-v1` container worker.
