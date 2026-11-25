# ADR-0043: Memory is typed and layered — rules, facts, decisions, lessons with scope, lifecycle and one rendering for every runtime

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** owner (P2 feedback 2026-10-19: "semantic search alone isn't a full agent memory system …");
  implemented by `p11-memory-layers`
- **Amends:** ADR-0010 (adds the `user` layer between global and project instructions; agent-written memory no longer
  enters the context directly — it is a suggestion a person accepts), p6-context-model §3 (bundle order inside the
  memory layer and budget priority; the record type joins an item's hashed identity when set),
  p10-semantic-memory (accepting a suggestion creates a typed record).
- **Related:** docs/design/p11-memory-layers.md (design + security review §8), ADR-0006, ADR-0009, ADR-0018,
  AGENTS.md rules 8, 11.

## Context
Context documents were namespaced, versioned and pinned per job, and semantic search plus a suggestions inbox existed,
but memory was one undifferentiated pile: no separation of rules from facts, no decision history, nothing personal,
nothing that said "this replaced that", expiry only by retention age, and an agent-memory write path that would have put
untrusted agent text straight into project memory. The owner's feedback asked for separate layers — personal and
global working rules, project knowledge, decision history, agents' learned experience — and for invalidated knowledge
to stop steering agents, with the same rules across Claude Code, Codex, Pi and OpenCode.

## Decision
1. **A record is a context document plus typed metadata.** Types: rule (instructions), fact, decision (ADR-like:
   decision, context, consequences, date, who), lesson (memory). Scopes: global, runtime, personal (`user:<id>`),
   project, project + runtime. Provenance (author human / agent / runtime, evidence links, accepted by), status
   (active / superseded / expired / rejected), supersedes / superseded by, review-by, expiry, confidence, tags.
   Versions, write roles, secret scan, audit and pinning are the p6 ones — no second store.
2. **Only active, unexpired records reach a job or a search result.** Superseding, expiring and rejecting are explicit
   human actions (expiry dates are applied by a sweep); history stays browsable; a job keeps the versions (and types)
   pinned for it.
3. **Conflicts are suggestions.** Semantic similarity (consented projects), lexical similarity and cheap contradiction
   heuristics turn into "this may replace X" for a person — on records and on incoming suggestions. Nothing is replaced
   automatically.
4. **Personal rules** live in `user:<uuid>` namespaces visible only to their owner and are injected only into jobs that
   person created (and their own chat turns, as a fenced data block).
5. **Bundle precedence**: platform policy → global rules → the creator's personal rules → project rules → decisions →
   facts → lessons (runtime-specific ones only for that runtime) → selected references. The memory budget is filled by
   type priority, then relevance to the job prompt (Bedrock, consented projects only), then recency; the output order is
   independent of relevance so pinned bundles reproduce.
6. **One rendering, one channel.** The master renders the bundle (typed headers) plus a fixed note on proposing lessons,
   and every runtime receives it identically in the first prompt. Native system-prompt channels are not used until a
   per-runtime capability and parity test justify it.
7. **Agents' experience is proposed, never stored.** `LESSON:` / `MEMORY:` lines of a runtime's own answer (all four
   adapters, parsed on the master) and memory events become typed suggestions under the agent memory-write policy; an
   operator accepts, types, scopes or dismisses them.
8. **Chat** can draft memory changes as confirmable cards (`draft_memory_change`) and retrieves typed, active records.

## Consequences
- Agents everywhere see the same, current rules; outdated knowledge stops being injected the moment someone retires or
  replaces it, and a review date keeps long-lived knowledge honest.
- Operators get a decision history and can see exactly what a job was given.
- The p6 direct agent-memory path is retired in production wiring (kept for callers without the suggestions service).
- Bundles without typed records hash exactly as before; migration 0092 is additive.
- The chat tool needs a worker release (assistant tool list); job memory does not.
- Heuristic contradictions miss paraphrases; reviewers remain the authority.

## Amendment 2026-10-24: tiered auto-learning (p17-auto-learning)

Owner decision 2026-10-24: "bu öneriler otomatik onaylanmalı mı? sistem bizi tanıyıp öğrenecek" — 150 suggestions had
waited unreviewed for a week, so the system never learned. Design: [p17-auto-learning](../design/p17-auto-learning.md);
migration 0152. Decision 7 ("never stored … an operator accepts") is amended as follows; decisions 1–6 and 8 stand.

1. **Per-project setting "Otomatik öğrenme"**: `off` / `safe` (default, also for existing projects) / `all`; project
   admin + step-up, audited; platform kill switch `MEMORY_AUTO_LEARN=off`.
2. **What may be accepted without a person**: facts and lessons only, that pass the secret scan and a conservative
   instruction heuristic (TR + EN), that do not contradict or closely resemble an active record of the same type, and
   that fit the length bounds (`all` also accepts those resembling a record of another type). **Never automatic, in
   any mode:** rules and decisions (they are authority, or the project's recorded choices), anything that may replace
   or supersede a record (decision 3 stands: nothing is replaced automatically), anything flagged, global scope.
3. **The system accepts as `system:auto-learn`** through the same record / context path (write role, secret scan,
   versions, audit, pinning), with provenance on the record (`auto_learned`: policy version, reasons, confidence,
   sources), a review-by date in 30 days, a 14-day expiry for machine-specific or time-bound notes, a visible
   "Otomatik öğrenildi" badge, one-click "Geri al" (the record becomes `rejected`; history kept), and a daily digest
   to owners — never one notification per item.
4. **Near-duplicates merge first**: by embedding cosine ≥ 0.85 (TR/EN twins by meaning), lexical fallback without
   consent; the best-written text in the project's language stays, the others become its evidence; independent
   sources raise confidence.
5. **The heuristic is defence in depth, not a guarantee**: accepted lessons and facts stay memory, below platform
   policy, rules and decisions (ADR-0010), so planted text can at most add low-authority knowledge that expires,
   asks to be reviewed, shows up in the digest and can be undone.

Consequences: the backlog clears (a one-off, idempotent backfill with a dry run: `remyral-master memory:autolearn`),
projects learn continuously, owners see what was learned once a day; a plausible but wrong fact can steer jobs until it
is noticed and undone (residual risk accepted by the owner). Security review: p11-memory-layers §8 + p17-auto-learning
§10.
