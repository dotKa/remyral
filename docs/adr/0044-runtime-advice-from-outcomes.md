# ADR-0044: Runtime advice from past outcomes; outcome-based runtime choice only on explicit "auto" in opted-in projects

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** owner (feedback P2, 2026-10-19: "don't pick agents only by idle machines; learn which runtime is more
  successful for which job type and use it as a scheduler signal"); implemented by `p11-runtime-advice`
- **Amends:** p6-smart-routing (job kinds gain a work area; outcome history may now choose a *runtime*, not only rank
  machines — only under the rules below).
- **Related:** docs/design/p11-runtime-advice.md (design + security review §8), ADR-0011, ADR-0035, ADR-0040, AGENTS.md
  rule 10.

## Context
Placement scored machines by capacity, reliability, affinity and (p6) the success of earlier attempts, but the runtime
of a job came only from the person, an admin's routing rule or the parent job. The platform could not say "in this
project Claude Code does frontend well, Codex does tests well", and "success" meant only that an attempt ended
`succeeded` — not that the result survived verification, review or the next day.

## Decision
1. **Classify every job** deterministically (no LLM): kind (unchanged heuristic) + work area (frontend, backend, tests,
   docs, infra) from weighted, listed signals — explicit `JobSpec.area`, the paths the result touched (per-project glob
   rules first, built-in rules after), sub-job path hints, file names and Turkish / English keywords in the prompt, the
   template / automation name. Below a clear lead: unclassified. Stored per job at submission and when it ends;
   history back-filled.
2. **Judge outcomes**, not attempts: good = succeeded and not failed by verification or CI, not refused at merge, not
   rerun (same prompt) within N days, not rated 👎 (a 👍 on a succeeded job wins). Signals are joined at read time.
3. **Aggregate** per project × area × runtime (× model) with recency decay, a Beta posterior centred on the fleet's
   rate for the same runtime × area, an approximate 95 % interval and a minimum sample count.
4. **Advice is the default** (composer, chat draft cards, coordinator sub-job requests, Usage → Outcomes): text with
   the evidence. It never changes a job.
5. **Auto mode is opt-in per project** (admin, step-up, audited) and applies **only** to jobs submitted with runtime
   `"auto"` (and sub-jobs that name no runtime and need no capability). It picks the best counted runtime within the
   allowed runtimes, the paid policy, open usage limits, quota holds and machine availability; a bounded exploration
   share (default 10 %, ≤ 30 %) tries under-sampled runtimes, never for production deploy jobs; with no counted history
   it follows the routing rule. The decision and its reasons are recorded on the job. An explicit runtime is never
   overridden. "auto" is resolved by the master before the job exists; workers never see it.

## Alternatives considered
- **Feed the record into machine scoring only** (extend p6): cannot express "this runtime is better for this work";
  the runtime is fixed before placement.
- **Override the user's runtime when the history is clear:** rejected — surprises people and violates "explicit always
  wins" (p6); advice + opt-in auto keeps people in control.
- **LLM classification of the prompt:** rejected for the scheduler path (non-deterministic, unexplainable, cost,
  prompt-injection surface); keywords + paths are good enough and listed on the job.
- **Plain success rate without smoothing:** small samples (2/2 = 100 %) would dominate; the fleet prior, interval and
  minimum samples keep advice honest.

## Consequences
- Five additive tables (migration 0093); master + console deploy, no worker release.
- People see why a runtime is recommended and why auto mode chose one; a project can turn the whole thing off.
- Outcome quality now depends on signals (verification, merges, reruns, ratings) that arrive later; the judgement of a
  job can change after it ended (by design).
- Exploration means an auto-mode project occasionally runs a less-proven runtime (bounded, visible on the job).

## Verification
Unit tests for the classifier (TR / EN prompts, paths, rules) and the math (judgement, decay, smoothing, minimum
samples, advice, bounded exploration); real-Postgres integration tests for the rows, APIs, authz, auto constraints and
"explicit runtime never overridden"; console tests (docs/design/p11-runtime-advice.md §10).
