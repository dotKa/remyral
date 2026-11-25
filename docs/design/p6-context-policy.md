# Design note: `p6-context-policy` — context leak policy, retention, deletion/reindex semantics

- **Task:** `p6-context-policy` (ROADMAP P6: _context policy prevents leaking unrelated project secrets;
  deletion/reindex semantics_). Acceptance **A-UX-5** (deletion half: _delete context per retention policy_),
  P6 gate (_retrieval permissions and context deletion tested_).
- **Date:** 2026-10-13
- **Builds on:** [p6-context-model.md](p6-context-model.md) (namespaces, immutable versions, soft delete +
  purge, per-job pinned bundles). **Decisions applied:** ADR-0010 (authority order, provenance), ADR-0006 (no
  secrets in context), ADR-0009 (step-up for destructive actions). **Threat model:** T-INJ-5 (cross-project
  leak), T-SEC-1, repudiation of deletions.

## 1. Scope

| Piece                    | Where                                                    | Responsibility                                                                                                                          |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Policy logic (pure)      | `packages/memory/src/policy.ts`                          | `NamespacePolicy`, validation, `checkMemoryWrite`, `isExpired`, `versionsToPrune`, `bundleLeaks`                                        |
| DB helpers               | `apps/master/src/context/policy-db.ts`                   | effective namespace policy, append-only deletion receipts                                                                               |
| Service                  | `apps/master/src/context/policy.ts`                      | `ContextPolicyService`: policies, retention sweep (expire → prune → purge), receipts + reindex feed, export                              |
| Store changes            | `apps/master/src/context/store.ts`                       | legal hold + namespace retention on delete, receipts on delete/purge, hold-aware purge, memory-write policy, leak check before any issue |
| REST                     | `apps/master/src/context/policy-routes.ts`, `routes.ts`  | `/context/policies`, `/context/deletion-receipts`, `/context/export`; `POST /context/purge` runs the full sweep                         |
| Migration                | `apps/master/migrations/0015_…sql` (second half)         | `context_namespace_policies`, `context_deletion_receipts`, hold/prune-aware triggers                                                    |
| Console                  | `apps/web/src/screens/ContextPage.tsx` (`/settings/context`) | docs per namespace, versions, diff, rollback, delete (step-up), retention settings, receipts, export, run retention                 |

## 2. Namespace policy

One optional row per namespace (`global` or `project:<id>`); without a row the defaults apply (keep forever,
no version limit, no hold, 30-day deletion marker, memory writes enabled: 16 KiB, 20 per job, 60 per hour).

| Field                 | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `maxAgeDays`          | live documents not updated for longer are **expired** (soft-deleted by the sweep); null = forever (1–3650) |
| `maxVersions`         | versions kept per document; older ones are **pruned** (1–1000; null = unlimited)                          |
| `legalHold`           | nothing in the namespace is deleted, expired, pruned or purged while set                                  |
| `deleteRetentionDays` | default retention marker for manual deletions and expiry (0–365)                                          |
| `memory.*`            | agent memory-write policy (§5)                                                                            |

`GET /context/policies?namespace=` (`context.read`, viewer+ in the project) returns the effective policy;
without `namespace` every explicit row the caller can see. `PUT /context/policies` (new action
`context.retention`: admin+ in the project, global admin for `global`; step-up; CSRF; optimistic
`expectedVersion`, 409 on conflict) replaces it and is audited (`context.policy.update`, before/after,
`legalHoldChanged`; refusals audited as `denied`).

## 3. Retention sweep (deletion semantics)

`ContextPolicyService.runRetention()` runs on the existing interval (`MasterDeps.contextPurgeIntervalMs`) and on
demand (`POST /context/purge`, admin + step-up; the response now also lists `expired`, `pruned` and the count of
`held` documents). Order, each document in its own transaction with its receipt and audit event:

1. **Expire** — live documents past `maxAgeDays` (measured from `updated_at`) are soft-deleted with
   `purge_after = now + deleteRetentionDays` (`context.doc.expire`, receipt `expire`). A document referenced
   by the pinned bundle of an **unfinished** job is skipped (its bundle must stay reproducible,
   p6-context-model §3) and expires on a later sweep.
2. **Prune** — versions beyond `maxVersions` are removed, never the current version (also after a rollback)
   and never a version pinned by an unfinished job (`context.doc.prune`, receipt `prune` with the removed
   version numbers and hashes). The database allows this delete only inside a prune transaction
   (`SET LOCAL remana.context_prune = 'on'`), only for a non-current version of a live document outside a hold.
3. **Purge** — the p6-context-model hard purge of soft-deleted documents past `purge_after`, now skipping held
   namespaces and writing a `purge` receipt.

**Legal hold** is enforced three times: in the store (`DELETE /context/docs/:id` → 409 `context_legal_hold`),
in the sweep (held namespaces are excluded from all three steps) and by triggers (`context_on_hold()`: no
`deleted_at` transition and no row delete for documents of a held namespace; version deletes refused under
hold). A document deleted _before_ a hold was set stays soft-deleted and is not purged until the hold is
released (reported as `held`).

**Manual deletion** uses the namespace's `deleteRetentionDays` unless the request gives `retentionDays`; a
deleted document disappears from listings and every new bundle immediately (unchanged).

## 4. Deletion receipts and reindex semantics

`context_deletion_receipts` (append-only by trigger, `REVOKE UPDATE/DELETE/TRUNCATE`) records **what was
deleted, when, by whom and why — never content**: action (`delete | expire | prune | purge`), document id,
namespace, kind, affected version numbers with their content hashes (proof of what was removed), actor
(user id or `system`), reason, retention marker. Receipts outlive the purged document (no foreign key).
`GET /context/deletion-receipts?namespace=&limit=&before=` (new action `context.receipts`, admin+ in the
project) lists them newest first; every receipt id is also in the matching audit event's metadata.

**Reindex semantics.** The optional semantic-search index ([p6-vector.md](p6-vector.md) §4) implements this contract. The contract for any
index built from context: it indexes **current versions of live documents only**, keeps a cursor over
`ContextPolicyService.receiptsSince(cursor)` (ascending receipt ids) and, for each receipt, drops every derived
entry of `docId` (all versions for `delete`/`expire`/`purge`, the listed versions for `prune`) before advancing
the cursor. A full reindex = rebuild from live documents, then set the cursor to the newest receipt id. Because
receipts are written in the same transaction as the deletion, an index can never miss one. Bundles do not
depend on any index (they are resolved from Postgres), so a lagging index can only cause a missed _search_
hit, never a leak into a bundle.

## 5. Agent memory-write policy

`ContextStore.recordAgentMemory` (the worker transport's entry point) checks, in one transaction serialised per
namespace (advisory lock): provenance and project-only scoping (unchanged: agent ⇒ `memory` in its job's own
project, only the holder of the current active attempt), the secret scan (unchanged), then the namespace's
`memory` policy via `checkMemoryWrite`: `enabled` (403 `agent_memory_disabled`), `maxBytes`
(403 `memory_too_large`), `maxPerJob` over all attempts (429 `memory_job_quota`) and `maxPerHour` across all
agents of the project (429 `memory_rate_limited`). Every refusal is audited (`context.memory.record`,
`denied`, with the code). A legal hold does not block memory _writes_ (it protects existing data).

## 6. Cross-project leak check

Retrieval was already scoped twice (SQL loads only `project:P` and readable `global` documents; the resolver
drops anything else). Added a third, independent check: `bundleLeaks(bundle, documents)` verifies every
non-platform item is a document the project may read (`projectCanRead`), in its own namespace, at exactly the
resolved version and hash. `resolveRows` runs it for every preview and every issue; a finding fails closed with
409 `context_leak_blocked` (audited as a denied `context.bundle.issue` for jobs). Verified by a **property
test** over 500 random worlds (random namespaces, kinds, `all`/`listed` scopes with random grants, deletions,
runtimes, selections; deterministic PRNG) in `packages/memory`, and an **integration property test** that
applies 8 rounds of random grants through `ContextStore.setAccess` and checks every bundle of three projects
against the grants read back from the database.

## 7. Export

`GET /context/export?project=` (new action `context.export`: operator+ in the project; step-up and rate limit
via the `AccessGate` export bucket; refusals audited) streams JSON Lines: one `document` record per live
`project:<id>` document the caller's role may read (documents above it are counted as `withheld_documents`),
followed by every stored `version` of it (content, hash, provenance); then the shared export manifest
(`kind: "context"`, record count, body bytes, **SHA-256 of the body**, limits, truncation) — the same format and
`createExportStream` as the audit/job exports, including the export-time redaction pass. Audited
`context.export.started` / `.completed` (with the manifest hash) / `.failed`. Global documents are not part of a
project export (they belong to the organisation).

## 8. API summary

| Route                                    | Action              | Notes                                                            |
| ---------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| `GET /context/policies?namespace=`       | `context.read`      | effective policy (or all explicit ones)                          |
| `PUT /context/policies`                  | `context.retention` | admin+, step-up, optimistic, audited                             |
| `GET /context/deletion-receipts`         | `context.receipts`  | admin+, newest first, `before` cursor                            |
| `GET /context/export?project=`           | `context.export`    | operator+, step-up, JSONL + manifest hash, audited               |
| `POST /context/purge` (changed)          | `context.purge`     | full retention sweep; response adds `expired`, `pruned`, `held`  |
| `DELETE /context/docs/:id` (changed)     | `context.delete`    | 409 `context_legal_hold`; default retention from the namespace   |

## 9. Security review

| Threat                                                   | Mitigation                                                                                                                         | Test                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| T-INJ-5 cross-project leak                               | SQL scoping + resolver filter + independent `bundleLeaks` check failing closed                                                     | unit property (500 worlds), integration property (random grants), forged-bundle unit test |
| Destruction of data under hold (legal/compliance)        | Hold checked in store, sweep and triggers; deletions before the hold are not purged                                                | integration legal hold (API 409, DB trigger, purge skipped then resumed)    |
| Repudiation of deletions                                 | Append-only receipts written in the deleting transaction + hash-chained audit events with the receipt id                           | integration receipts for delete/expire/prune/purge                         |
| Receipts or exports leaking content to the wrong people  | Receipts carry hashes only; receipts admin+ per project; export operator+ per project, step-up, read-role filtered, rate limited    | integration 403s, content absent from receipts                              |
| Agent memory abuse (flooding, oversized, cross-project)  | Per-namespace enable/size/per-job/hourly limits, serialized check; provenance + own-project only; secret scan                        | integration memory policy, unit `checkMemoryWrite`                          |
| Breaking running jobs by retention                       | Expiry and pruning skip anything pinned by unfinished jobs; current version never pruned                                           | integration pinned bundle still reproducible after the sweep               |
| Unauthorised retention changes                           | admin+ (project-scoped), step-up, CSRF, optimistic, audited (incl. denials)                                                        | integration, rbac matrix, route coverage                                   |
| Tampering                                                | Version deletes only in flagged prune/purge transactions; receipts append-only                                                      | integration direct deletes refused                                         |

Residual risks: content hashes in receipts reveal equality of deleted content with known text (accepted:
needed as deletion proof; content itself is secret-scanned on write). Retention is enforced at sweep
granularity (interval), not to the second. Exports contain content by design — operator+, step-up and audited,
exactly like the job export. Rollback of this change: the migration is additive (two tables, one replaced
trigger function, one new trigger); without policy rows behaviour equals p6-context-model except that
receipts are written.

## 10. Tests

- `packages/memory/test/policy.test.ts` — validation, memory-write order, expiry, pruning (current/pinned kept),
  leak property test and forged-bundle detection.
- `apps/master/test/integration/context-policy.test.ts` — policies (defaults, step-up, validation, conflict,
  audit), deletion with namespace retention + receipt without content, legal hold end to end, expiry + pruning
  with a pinned job, reindex feed order, memory-write policy, leak property over random grants, export with
  manifest hash and audit.
- `apps/master/test/integration/{rbac-matrix,route-coverage}.test.ts` — new actions and routes.
- `apps/web/test/context.test.tsx`, `apps/web/test/diff.test.ts` — Settings → Context screen and the line diff.
