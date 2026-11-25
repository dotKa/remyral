# p11-memory-layers — typed memory layers: rules, facts, decisions, lessons

- **Task:** `p11-memory-layers`. **Date:** 2026-10-19.
- **Feedback addressed (P2):** "Semantic search alone isn't a full agent memory system. Separate layers: global user &
  working rules; project-specific durable knowledge; technical decision history; agents' learned working experience;
  updating knowledge that has become invalid. Using the same rules across Claude, Codex, Pi and OpenCode is a serious
  advantage."
- **Decision:** [ADR-0043](../adr/0043-typed-memory-layers.md).
- **Builds on:** [p6-context-model](p6-context-model.md) (documents, immutable versions, per-job pinning, bundle hash,
  ADR-0010 authority order), [p6-context-policy](p6-context-policy.md) (retention, agent memory-write policy),
  [p10-semantic-memory](p10-semantic-memory.md) (suggestions inbox, Bedrock embeddings, dedupe),
  [p5-ops-chat](p5-ops-chat.md) (draft cards), [p5-notifications](p5-notifications.md).
- **Migration:** 0092 (parallel: 0090 p11-fixes-a, 0091 p11-session-continuity, 0093 p11-runtime-advice — renumber at
  merge if taken). **Protocol:** additive (`parseMemoryProposals`, the `draft_memory_change` assistant tool).
  **Worker release:** only for the chat assistant's new tool / prompt line; job memory needs none (see §5).

## 1. What existed (verified before this change)

| Piece | State |
| --- | --- |
| Context documents | namespaces `global`, `project:<id>` (+ `skill:`, `machine:`), kinds instructions / memory / reference, immutable versions, pinned per job, bundle order platform → global → project → memory (64 KiB memory budget) |
| Memory suggestions | deterministic extraction from job summaries and project-linked chat; an operator accepts → an untyped `memory` document |
| Search | Bedrock embeddings + keyword fallback, chat auto-retrieval |
| Invalidation | only `maxAgeDays` / `maxVersions` retention; no notion of "this replaced that" |
| Per user | nothing reached a job from the person who created it |
| Agent experience | `recordAgentMemory` wrote **directly** into project memory, but no real adapter emitted memory events |
| Injection | the rendered bundle went into the FIRST PROMPT of all four runtimes (worker `runner.ts`), repo CLAUDE.md / AGENTS.md loading off |

## 2. Model

A **memory record** is a context document plus a `memory_records` row (1:1, written in the document's own
transaction through a new `afterWrite` hook of `ContextStore.create` / `addVersion`). Everything p6 guarantees —
immutable versions, write roles, the secret scan, audit, per-job pinning and the bundle hash — therefore holds for
records unchanged; old documents keep working and can be typed later.

| Field | Meaning |
| --- | --- |
| `type` | `rule` (an instruction agents follow → kind `instructions`), `fact` (durable project knowledge), `decision` (ADR-like: decision, context = rationale, consequences, `decidedOn`, `decidedBy`), `lesson` (what worked or failed for a runtime) — the last three are kind `memory` |
| `scope` | `global` · `runtime:<name>` (global, one runtime) · `user:<id>` (a person's rules) · `project:<id>` · `project:<id>+runtime:<name>`. Maps to the document namespace + the version's `runtimes` filter |
| `statement`, `rationale`, `consequences` | the editable text; the injected text (`composeRecordContent`) is stored as the version content, so the hash covers it |
| `evidence` | `[{kind: job \| chat \| adr \| doc \| url, ref, label?}]` (validated: UUIDs, repo-relative `.md` paths without `..`, https URLs) |
| `author`, `authorRef`, `acceptedBy`, `suggestionId` | `human` / `agent` / `runtime` (a `LESSON:` line) and who accepted it |
| `status` | `active`, `superseded` (with `supersededBy`), `expired`, `rejected` |
| `supersedes` / `supersededBy` | the replacement chain (both directions, browsable) |
| `reviewBy`, `expiresAt`, `confidence`, `tags` | reminder date, hard expiry, 0–1, up to 10 tags |

Type × scope rules: personal scope holds **rules only**; decisions are never runtime-specific; a rule only replaces a
rule (instructions vs memory never mix); supersession stays within one project / the global namespace / one person.

`memory_record_events` is the append-only lifecycle history (created, edited (+version), superseded / supersedes,
expired, rejected, reactivated, review_due, reviewed, typed). `memory_record_conflicts` holds "this may replace X"
pairs waiting for a person.

### Personal rules — the `user:<uuid>` namespace

`parseNamespace` accepts `user:<uuid>`; the namespace **is** the permission: `roleIn()` gives its owner full rights and
everybody else (admins included) nothing — the documents look absent. They are `instructions` only (`project_scope
own`, no grants; DB CHECK `context_documents_user_shape`), never in a namespace policy, never indexed for search
(no consent row can exist for them). Routes `/memory-records/personal*` use the new action `memory.personal`
(viewer+, global) so any signed-in user can keep rules for their own chats; the service still refuses another user's
scope.

## 3. Lifecycle and invalidation

- **Supersede**: a new record with `supersedes` (or `POST /memory-records/:id/supersede {by}`) marks the old one
  `superseded` + links both ways, in one transaction; pending conflicts between them are closed.
- **Expire / reject**: `POST /memory-records/:id/status` (operator+ / owner of a personal rule) with a reason;
  `expiresAt` in the past excludes a record immediately and the sweep marks it `expired` (system event). Only expired /
  rejected records can be reactivated; a superseded one stays history (replace its replacement instead).
- **Never injected**: `ContextStore.resolveCurrent` joins `memory_records` and keeps only `active` records whose
  `expires_at` has not passed. Search (`scoreProject`, keyword search) applies the same filter, so chat retrieval
  never surfaces history; typed hits are titled `[decision] …`.
- **Pinned bundles stay reproducible**: the delivery row stores each item's `recordType`; a rebuild uses the pinned
  versions and pinned types, ignoring today's status — a retry gets exactly what the first worker got (tested).
- **Conflict detection** (`MemoryRecordService.detectConflicts`, after every create): candidates = active records of the
  same type in the same namespace. Semantic: `SearchService.similarDocs` (Bedrock, only when the project's capture is
  consented) at the related threshold 0.78; lexical: word-set Jaccard ≥ 0.5; contradiction heuristics
  (`contradiction()`): negation flip on the same subject, a different member of a family of exclusive tools (pnpm /
  npm / yarn / bun, uv / poetry / pip, …), a different value (hex colour, version, number) in otherwise similar
  sentences. At most 3 pending pairs per record; a person decides **Supersede** or **Keep both**. Nothing is replaced
  automatically.
- **Suggestions get the same signal**: when a suggestion's most similar document is an active record and the texts
  contradict (or are close and of the same type), the suggestion carries `replaces {documentId, reason}`; the reviewer
  can accept with `supersedes`.
- **Review-by reminders**: the sweep (same cadence as the suggestions pass, `MEMORY_SUGGEST_INTERVAL_MS`) writes one
  `memory_review` outbox event per record and date → notification `memory.review_due` (project operators; admins for
  global; the owner for a personal rule) and Home "Needs you" (`GET /memory-records/review-due`). "Mark reviewed"
  sets the next date.

## 4. Injection — identical for all four runtimes

`resolveBundle` (pure, `@remyral/memory`) now builds, in ADR-0010 authority order:

1. `platform` — the platform policy (unchanged, version 1);
2. `global` — global rules (incl. `runtime:<name>` ones for the job's runtime);
3. **`user` — the active personal rules of the job's creator** (`jobs.created_by_type = 'user'`; worker- or
   system-created jobs get none; another person's rules never — `projectCanRead(doc, project, user)` + the leak check);
4. `project` — project rules (incl. project+runtime);
5. `memory` — decisions, then facts (and untyped p6 memories), then lessons, then explicitly selected references.

**Budget** (64 KiB of memory content, rules are never cut): chosen greedily by priority — type (decision > fact >
lesson), then **relevance to the job prompt** (cosine of the prompt's Bedrock query vector with each document's stored
vector, `SearchService.promptRelevance`, only when the project's capture is consented and the prompt carries no
secret-looking value, at most 4 s, otherwise skipped), then recency. The *output order* never depends on relevance
(type, global before project, `sortOrder`, id), so a pinned rebuild without relevance reproduces the hash. Without
typed records and within budget the order is exactly the p6 order, and the bundle hash is unchanged (the record type is
part of an item's hashed identity **only when set**; the golden-hash test still passes).

**Rendering**: master-side, `renderJobContext(bundle)` = the fenced bundle (each typed item's header gains
`type=<type>`) + `MEMORY_PROPOSAL_NOTE` (how to propose a lesson). The text does not depend on the runtime: four jobs
that resolve the same records get byte-identical context (tested for Claude Code, Codex, Pi and OpenCode; only
runtime-scoped records differ). **Channel choice:** it stays in the **first prompt** for every runtime. Some runtimes
have a native system / instructions channel, but they differ in size limits, persistence across resume and in how they
mix with the runtime's own and repository instructions, and using them would need adapter changes verified against
each pinned release (AGENTS.md rule 12); one channel for all four keeps "same rules everywhere" literally true and
needs no worker release. Revisit per runtime only with a capability flag and a parity test.

The job page shows **exactly what a job received**: `GET /memory-records/jobs/:jobId` lists the pinned items (layer,
type as pinned, document, version, content hash) and each record's status now ("since superseded — the job keeps what
it got"). Someone else's personal rule appears only as "a personal rule of the job's creator".

## 5. Agents' learned experience

- **Where it is read**: every adapter reports the agent's answer as an assistant `message` EVENT (Claude Code text
  blocks, Codex `agentMessage` items, Pi assistant messages, OpenCode text parts) and the worker forwards them all to
  the master. The master's inbox routes an assistant message to the `memory` effect only when
  `hasMemoryProposals(text)`; the effect runs `parseMemoryProposals` (`@remyral/protocol`, one rule for all runtimes):
  upper-case `LESSON:` / `MEMORY:` (and Turkish `DERS:` / `HAFIZA:`) at the start of a line, outside code fences, at
  most 5 per message, "title — body" split, the template line itself ignored. `memory` events (the p6 path) are
  handled the same way (as facts). No worker change is needed; adapter tests push the same answer through each
  adapter's real event mapper (recorded Pi / OpenCode transcripts, Claude SDK and Codex app-server shapes) and check
  identical proposals with the injected secret redacted.
- **What happens**: `MemorySuggestionService.proposeFromAgent` — only the worker holding the job's current active
  attempt; the namespace's agent memory-write policy (enabled, size, per-job quota, hourly rate, p6-context-policy)
  counts these proposals; secret scan (`[REDACTED]` or a pattern hit → dropped), fingerprint + lexical / semantic
  dedupe; stored as `source = agent`, typed `lesson` (scoped project + the job's runtime) or `fact` (project). They
  are **never accepted automatically**: untrusted agent text, shown as plain text, the reviewer chooses type, scope,
  review date and whether it replaces an existing record. A tool channel was not added: the line convention already
  works for all four runtimes without a worker release; a `propose_lesson` tool can follow where an adapter has a tool
  channel.
- **Prompt-injection safety**: a proposal is data until a person accepts it; once accepted it is a typed record whose
  authority is set by its type (lessons / facts are `memory`, below human instructions — ADR-0010); an agent can never
  author a rule.

## 6. Console and chat

- **Projects → Memory**: records grouped by type with filters (type, status, runtime, text), edit / supersede /
  expire / reject / reactivate / mark reviewed (operator+), history (events + replacement chain), "Possible
  conflicts", **Decision history** (ADR-like timeline incl. superseded decisions), untyped documents with "Give it a
  type", and the suggestions inbox with type / runtime / "may replace".
- **Settings → Context**: global and runtime-specific rules and memory (admin to write) and global conflicts.
- **Settings → Profile & security → Personal rules**: one's own rules, applied to the jobs and chats one creates.
- **Job page**: "Memory given to this job".
- **Home → Needs you**: records whose review date has come.
- **Chat**: `draft_memory_change` (add / replace / retire; `user:me` for personal rules) creates a card the user
  confirms (step-up, the same service, the confirming user's permissions); `search_context` shows typed records
  (`[rule]` …) and never superseded / expired ones; every turn of a user's own conversation carries their personal
  rules as a fenced data block (`fenceData`, never authority).

## 7. API

| Route | Authz | Notes |
| --- | --- | --- |
| `GET /memory-records?scope=project\|global\|mine&project=&type=&status=&runtime=&tag=&q=` | `context.read` | read role per document; personal only own |
| `GET /memory-records/decisions?project=` | `context.read` | every status, newest decision first |
| `GET /memory-records/conflicts?project=` / `POST …/conflicts/:id/resolve {decision}` | read / `context.write` | supersede or keep |
| `GET /memory-records/review-due` | `context.read` | what the caller may update |
| `GET /memory-records/untyped?project=` / `POST /memory-records/type/:docId` | read / `context.write` | type an existing document |
| `GET /memory-records/jobs/:jobId` | `jobs.read` | the pinned bundle of a job |
| `GET/POST /memory-records/personal`, `PUT …/personal/:id`, `POST …/personal/:id/status` | `memory.personal` | own rules |
| `POST /memory-records` | `context.write` (+ document write role: global needs an admin) | optional `supersedes` |
| `GET/PUT /memory-records/:id`, `POST …/:id/status`, `…/:id/supersede`, `…/:id/reviewed` | read / `context.write` | edits write a new version |
| `POST /memory-suggestions/:id/accept` | `memory.suggestions.decide` | now `{type, scope, reviewBy, supersedes}`; returns the record |

Audit: `memory.record.create|edit|status|supersede|review|type|conflict|sweep` plus the underlying `context.doc.*`;
agent proposals `memory.suggestion.propose` (actor worker); denials with codes only.

## 8. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Agent self-escalation through memory (T-INJ-1/2, ADR-0010) | agent text only becomes a suggestion; types / scopes are chosen by an operator; agents never author rules; proposals rendered as plain text | integration "agents …", adapter tests |
| A worker proposing for a job it does not run | current active attempt + worker check | integration (spoofed worker) |
| Proposal flooding | per-message cap 5, the namespace memory-write policy (per job, per hour), fingerprint dedupe | integration retry → no duplicates |
| Secrets in memory (T-SEC-1) | secret scan on statement, rationale, consequences, evidence, tags, reasons; redacted proposals dropped | integration canary 400 |
| Personal rules leaking (privacy, T-INJ-5) | namespace = permission (owner only, admins included); only the creator's jobs; job page hides others' items; leak check knows the job user | integration personal + bundle tests, unit resolver |
| Outdated knowledge steering agents | superseded / expired / rejected excluded from bundles and search; expiry immediate; review reminders | integration |
| Silent drift for a running job | pinned versions and pinned types; rebuild verifies the hash | integration "pinned bundles stay reproducible" |
| Prompt text leaving the system for relevance | only with the project's consent, secret-looking prompts never sent, failure → recency | code review; existing provider tests |
| Wrong automatic replacement | conflicts and "may replace" are suggestions; a person supersedes | integration conflicts |
| Repudiation | every write audited; append-only event history | integration history |

**Amendment 2026-10-24 (p17-auto-learning):** agent proposals are no longer *always* accepted by a person. Under a
project's "Otomatik öğrenme" (`safe` by default) clean facts and lessons are accepted by the system; rules, decisions,
anything that may replace a record, anything the instruction heuristic flags and global scope still always wait for a
person. What an attacker can now achieve by planting text, why rules and decisions stay human, and why the heuristic is
defence in depth (bounded by the type restriction, the authority order, expiry, review-by, undo and the daily digest)
is reviewed in [p17-auto-learning §10](p17-auto-learning.md#10-security-review-additions-to-p11-8).

Residual: contradiction heuristics are cheap and miss paraphrased contradictions (semantic similarity catches many
of those as "similar"); a reviewer can still accept a misleading lesson — it stays memory, below instructions, with
provenance, and can be expired. Rollback: the migration is additive; disabling the routes leaves records as ordinary
documents (still versioned and pinned); bundles without records hash as before.

## 9. Operations

- Sweep cadence = `MEMORY_SUGGEST_INTERVAL_MS` (default 60 s); `memory.record.sweep` audit with counts.
- Notification kind `memory.review_due` (in-app by default, opt-in channels as usual).
- Live verification: see the backlog notes (UNVERIFIED-LIVE: a real Codex / Claude job writing `LESSON:` lines on the
  fleet, Bedrock relevance on a consented project).
