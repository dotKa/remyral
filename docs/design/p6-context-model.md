# Design note: context model — global vs project context (P6)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p6-context-model (acceptance A-UX-3: project instructions and global context are versioned and
  permission-scoped; P6 gate: two different workers reproduce the same project rules, retrieval permissions
  tested). Deletion half of A-UX-5 (soft delete + retention marker + audited hard purge); retention policy
  configuration and reindex semantics: see [p6-context-policy.md](p6-context-policy.md).
- **Decisions applied:** ADR-0010 (authority order; repository content is data; provenance of every injected
  instruction source recorded), ADR-0006 (no secrets in context), ADR-0009 (step-up for deletion and access
  changes)
- **Threat model:** T-INJ-5 (instructions leak between projects through shared context), T-SEC-1 (secrets in
  stored/transmitted text), T-INJ-1/2 (repository instructions posing as authority)

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Model | `packages/memory/src/model.ts` | Namespaces, kinds, roles, provenance, document/version types, write validation and role floors. |
| Canonical hashing | `packages/memory/src/canonical.ts` | Canonical JSON (sorted keys, no whitespace), `sha256:` content hashes. |
| Secret hygiene | `packages/memory/src/secrets.ts` | `scanForSecrets()` over every text field using the `@remyral/observability` pattern rules; returns field/line/column/rule, never the value. |
| Resolver | `packages/memory/src/resolver.ts` | Pure `resolveBundle()`: ordered bundle + bundle hash; `attachRepositoryContent()` (untrusted tagging); `renderBundle()` (fenced prompt text). |
| Store | `apps/master/src/context/store.ts` | `ContextStore`: CRUD, versions, rollback, access, soft delete, purge, bundle resolution and pinned per-job issuance. |
| REST | `apps/master/src/context/routes.ts` | `/context/*`. |
| Migration | `apps/master/migrations/0007_context.sql` | `context_documents`, `context_doc_versions`, `context_doc_grants`, `context_bundle_deliveries` + invariant triggers. |

The console (Settings → Context) is **not** part of this change: the API is complete and documented in
OpenAPI; the UI is a follow-up (other agents are restructuring `apps/web` concurrently).

## 2. Model

### Namespaces and kinds

| Namespace | Meaning | Who reads it at retrieval |
| --- | --- | --- |
| `global` | Organisation-wide instructions/memories | Projects granted by the document's `projectScope`: `all`, or `listed` (explicit grants in `context_doc_grants`) |
| `project:<id>` | One project's instructions/memories | That project only |
| `skill:<id>` | Reserved for p6-skills | Parsed, rejected on write (`namespace_not_supported`) |

`kind` is `instructions` (rules the agent must follow), `memory` (facts learned or recorded; lower authority)
or `reference` (lookup material; injected only when a job explicitly selects it).

### Documents and versions

A document row holds identity and access: `namespace`, `kind`, `readRole`, `writeRole`, `projectScope`,
`currentVersion` (pointer), creation provenance, and the soft-delete marker (`deletedAt`, `purgeAfter`).
Each **version** is immutable (append-only table, guarded by triggers): `title`, `content`, `contentHash`
(`sha256:` of the UTF-8 content), `sortOrder`, `runtimes` (null = all runtimes), `changeNote` and the
author **provenance**:

| Provenance | Fields | Allowed for |
| --- | --- | --- |
| `user` | `userId` | any kind (role permitting) |
| `import` | `userId`, `source` (free text, e.g. "migrated from team wiki") | any kind (role permitting) |
| `agent` | `jobId`, `attemptId`, `workerId` | `memory` in the job's own `project:<id>` namespace only — an agent can never author instructions or global context (ADR-0010, T-INJ-5) |
| `platform` | — | the built-in platform policy item (code, not DB) |

Writing a new version moves the pointer to `max(version) + 1`; **rollback** moves the pointer back to an
existing version without writing content (history stays linear and immutable, the pointer move is audited).
Both use optimistic concurrency (`expectedVersion` = the pointer the editor saw).

### Permissions

Human roles (`viewer < operator < admin < owner`) apply to the console/API:

- `readRole` (default `viewer`): the weakest role that can see the document in `/context/docs`.
- `writeRole`: the weakest role that can add versions or roll back. Floors: `admin` for every `global`
  document, `operator` for project documents; `viewer` can never write; `readRole ≤ writeRole`.
- Access changes (`PUT /context/docs/:id/access`) and deletion need `admin`+ **and a fresh step-up**.
- `/context/bundle` needs `operator`+; items whose `readRole` is above the caller's role are returned with
  `content: null, withheld: true` (hash and provenance still shown, so the bundle hash stays verifiable).

**Retrieval permissions** (what an agent of project P sees) are enforced twice: the store only loads
`global` and `project:P` documents, and the pure resolver drops anything else (a foreign project document,
an ungranted global document, a deleted document, a `skill:` document) even if handed one.

## 3. Bundle resolution (P6 gate)

`resolveBundle({ project, runtime, documents, select?, memoryBudgetBytes? })` returns the exact, ordered
context to inject. Layers, in ADR-0010 authority order:

1. `platform` — `PLATFORM_POLICY_TEXT` (versioned constant: authority order, repository content is data,
   sensitive actions are gated outside the model, never reveal secrets).
2. `global` — global `instructions` readable by P and applicable to the runtime.
3. `project` — `project:P` `instructions` applicable to the runtime.
4. `memory` — global then project `memory` documents (all applicable ones by default; only `select`ed ones
   when the job selects), then explicitly selected `reference` documents; cut at `memoryBudgetBytes`
   (default 64 KiB) with the omitted ids reported.

Inside a layer: `sortOrder` ascending, then document id. Every item carries `layer`, `authority`
(`platform-policy` | `human-instructions` | `memory`), `namespace`, `kind`, `docId`, `version`, `title`,
`contentHash`, `provenance` and `content`.

**Bundle hash** = `sha256:` of the canonical JSON of `{ format: "remana.context.bundle/v1", items: [{layer,
namespace, kind, docId, version, title, contentHash}] }`. Canonical JSON sorts object keys, so the hash is
independent of key order, process, platform and database row order; a golden-value unit test pins it.
Project id and runtime are not hashed: two projects that receive the same rules get the same hash, and any
change to any included document (content, title, version pointer, grants, deletion) changes it.

**Per-job pinning.** `ContextStore.issueForJob(jobId, recipient)` resolves the bundle for the job's
project/runtime the first time and records a *pinned* delivery (`context_bundle_deliveries`: job, attempt,
recipient, bundle hash, the `(docId, version, contentHash)` list — no content). Every later issue for the
same job (a second worker, a retry after lease loss) rebuilds the bundle from exactly those versions and
verifies the hash, so different workers reproduce the same project rules even if a document was edited in
between. Each issuance is a delivery row plus an audit event (`context.bundle.issue`) — the provenance record
required by ADR-0010 §4. If a pinned version was purged the issue fails (`context_bundle_unavailable`) instead of
silently substituting newer rules.

### Repository content (ADR-0010)

Repository files (AGENTS.md, CLAUDE.md, …) are never documents and never enter the trusted layers or the
bundle hash. A worker that wants to show them to the agent calls `attachRepositoryContent(bundle, files)`:
each file becomes an `untrusted` entry tagged `trust: "untrusted-repository-content"`, `authority: "none"`,
with its own hash. `renderBundle()` fences every item with a delimiter that contains a nonce derived from the
hashes (content cannot forge the fence because the nonce depends on the content) and prefixes the untrusted
section with an explicit notice that it is data and cannot grant permissions.

## 4. Secret hygiene (ADR-0006, T-SEC-1)

Every write (create, new version, agent memory; rollback and delete reasons too) normalises text (CRLF → LF, NUL stripped) and runs
`scanForSecrets()` over `title`, `content`, `changeNote` and import `source` with the observability
`DEFAULT_RULES` (vendor tokens, PEM keys, JWTs, URL credentials, `password=`-style assignments, bearer
tokens). Any finding rejects the write with `400 context_secret_detected` and the locations
(`field`, `line`, `column`, `rule`) — never the value. Nothing is stored; the denial is audited with the same
locations. Content limits: title ≤ 200 chars, content ≤ 256 KiB, change note ≤ 1000 chars.

## 5. Deletion and purge (A-UX-5, deletion half)

`DELETE /context/docs/:id?reason=&retentionDays=` (admin+, step-up, CSRF) sets `deletedAt` and the retention
marker `purgeAfter = now + retentionDays` (default 30, 0–365). A deleted document disappears from listings
(unless `includeDeleted=true` for admin+) and from every bundle immediately. `ContextStore.purgeExpired()`
hard-deletes documents whose `purgeAfter` has passed — versions, grants and the document row — and writes one
`context.doc.purge` audit event per document (id, namespace, version count; no content). It runs on an
interval when `MasterDeps.contextPurgeIntervalMs` is set and on demand via `POST /context/purge` (admin+,
step-up). The append-only triggers allow these deletes only inside a purge transaction
(`SET LOCAL remana.context_purge = 'on'`) and only for soft-deleted documents.

## 6. API

| Route | Role | Notes |
| --- | --- | --- |
| `GET /context/docs?namespace=&kind=&includeDeleted=` | viewer+ (filtered by `readRole`) | metadata + current version metadata |
| `POST /context/docs` | `writeRole` floor for the namespace | creates document + version 1; optional `import.source` |
| `GET /context/docs/:id` | `readRole` | document + current version content |
| `GET /context/docs/:id/versions` | `readRole` | version metadata, newest first |
| `GET /context/docs/:id/versions/:version` | `readRole` | one version with content |
| `POST /context/docs/:id/versions` | `writeRole` | `expectedVersion`, new content |
| `POST /context/docs/:id/rollback` | `writeRole` | `expectedVersion`, `toVersion`, `reason` |
| `PUT /context/docs/:id/access` | admin+, step-up | `readRole`, `writeRole`, `projectScope`, `projects` |
| `DELETE /context/docs/:id` | admin+, step-up | soft delete with retention marker |
| `POST /context/purge` | admin+, step-up | runs the hard purge now |
| `GET /context/bundle?project=&runtime=&job=` | operator+ | bundle + hash; with `job`, the job's pinned bundle if issued |

All writes are audited (`context.doc.create|version|rollback|access|delete|purge`, `context.bundle.issue`,
denied attempts with the error code). Audit metadata carries ids, versions and hashes, never content.

## 7. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| T-INJ-5 cross-project leak | Namespace-scoped loading + resolver re-filter; global docs need `all` or an explicit grant | integration "project B's docs never reach project A", unit "foreign docs dropped" |
| Agent self-escalation via memory | Agent provenance limited to `memory` in its job's project; memory layer is below instructions | unit `validateWrite`, integration agent memory |
| Repository text posing as authority (ADR-0010) | Never stored as documents; `untrusted-repository-content` tag, excluded from hash, fenced with content-derived nonce | unit untrusted tagging + fence forging |
| Secrets in context (T-SEC-1, ADR-0006) | Pattern scan on every write; reject with locations only; denial audited without value | unit + integration canary rejection, DB contains no canary |
| Silent rule drift between workers | Bundle hash + per-job pinning + delivery records | integration two-worker test |
| Tampering with history | Append-only versions (triggers), pointer moves audited, purge only via flagged transaction | integration trigger tests |
| Viewer/operator privilege abuse | Role floors, step-up for delete/access/purge, CSRF on writes | integration permission tests |
| Repudiation | Hash-chained audit events for every write and issuance | integration audit assertions |
| DoS by large documents | 256 KiB content cap, 64 KiB body limit already enforced by Fastify for API writes, memory budget in bundles | unit limits |

Residual risks: since p5-rbac-api console access to project documents also requires project membership
(operator/viewer; [p5-rbac.md](p5-rbac.md)); *agent retrieval* is strictly project-scoped. Withheld bundle
items still show title, hash and provenance (needed to verify the hash). `ContextStore.recordAgentMemory` and
`issueForJob` have no HTTP route yet: the worker transport calls them (they check the job's current active
attempt and its worker). Memories are still model input and could carry misleading (not authoritative) text — they are
labelled `memory` with provenance so the agent and auditors can weigh them; the secret scan is pattern-based
and cannot catch unknown secret formats (p7-secrets-scan). Rollback: the migration is additive (new tables
only); disabling the routes leaves jobs unaffected.

## 8. Operations

Metrics hooks for p6-otel: purge count per run, bundle issuance count, secret rejections (audit
`context.doc.*` with outcome `denied`, code `context_secret_detected`). Runbook: to remove a document now,
delete with `retentionDays=0` and call `POST /context/purge`.
