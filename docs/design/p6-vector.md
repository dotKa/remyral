# Design note: `p6-vector` — optional embedding search with consent-bound capture

- **Status:** Implemented (optional; off by default)
- **Date:** 2026-10-14
- **Backlog:** `p6-vector` (ROADMAP P6: _embedding/vector search optional, with deletion/reindex semantics and
  consent-bound source capture_)
- **Builds on:** [p6-context-model.md](p6-context-model.md) (namespaces, read roles, grants),
  [p6-context-policy.md](p6-context-policy.md) §4 (deletion receipts and the reindex contract),
  [p5-rbac.md](p5-rbac.md) (project-scoped actions). **Decisions applied:** ADR-0006 (no secrets leave the
  system), ADR-0009 (step-up for consent changes), ADR-0010 (search results are data, never instructions).
- **Threat model:** T-INJ-5 (cross-project leak), T-SEC-1 (secrets sent to a third party), repudiation of consent.
- **Migration:** `0024_vector_search.sql`

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Providers | `apps/master/src/search/embedder.ts` | `Embedder` interface; `LocalHashEmbedder` (deterministic, in-process); `HttpEmbedder` (OpenAI-compatible) |
| Service | `apps/master/src/search/service.ts` | consent, indexer (receipts → deletions, then capture), reindex, RBAC-scoped search |
| REST | `apps/master/src/search/routes.ts` | `/context/search`, `/context/search/settings`, `/context/search/reindex` |
| Config | `apps/master/src/config.ts`, `main.ts` | `SEARCH_PROVIDER`, `SEARCH_HTTP_*`, `SEARCH_INDEX_INTERVAL_MS` |
| Console | `apps/web/src/screens/ContextSearchPanel.tsx` | Settings → Context → "Semantic search": consent toggle, rebuild, search box |

## 2. What is captured (and what never is)

Only two source types, both already visible to the people who can search them:

- **Context documents:** the *current version* of *live* documents — `title + "\n\n" + content`, clipped to
  8000 characters. Every document write is already secret-scanned (p6-context-model §4).
- **Job summaries:** the latest `job_runs.result.summary` of each job of the project (master-side redacted
  result, p7-secrets-scan).

Never: job prompts/specs, live events, log chunks, transcripts, approvals, audit rows, agent memory of other
projects, secrets. As defence in depth every text is passed through `scanForSecrets` before it is sent; a
finding skips the source (`skippedSecrets`). **Search queries** leave the system too (the provider embeds them),
so a query with a secret-looking value is refused (`400 search_query_rejected`) before anything is sent.

The index stores **vectors only** (plus the sha256 of the embedded text as proof of what was sent): titles and
snippets of results are read from the live rows at query time.

## 3. Consent (per namespace, audited)

`search_consent(namespace, enabled, version)` — one row per `global` or `project:<id>`; no row = off. Nothing of
a namespace is ever sent to the provider unless its row is `enabled`:

- `PUT /context/search/settings {namespace, enabled, expectedVersion}` — action `context.search.admin` (admin+ in
  the project; global admin for `global`), **fresh step-up**, CSRF, optimistic (`409 search_consent_conflict`),
  audited `context.search.consent` with before/after, the provider's model id and the number of removed vectors;
  refusals audited as `denied`.
- Enabling is refused while no provider is configured (`409 search_unavailable`).
- **Disabling deletes every vector of the namespace in the same transaction.** The indexer additionally drops
  any vector whose namespace is not consented (belt and braces), and the capture re-checks consent under a share lock on
  the row, so a provider answer that arrives after revocation is discarded.
- Project consent covers the project's documents **and** its job summaries; `global` consent covers global
  documents (they appear in a project's results only when the document is granted to that project — `all` or a
  `listed` grant — and readable with the caller's account role).

## 4. Deletion and reindex semantics (p6-context-policy §4 contract)

The indexer keeps a cursor (`search_index_state`) over `ContextPolicyService.receiptsSince()`:

| Receipt | Effect on the index |
| --- | --- |
| `delete`, `expire`, `purge` | the document's vector is deleted |
| `prune` | deleted if it was built from one of the pruned versions (normally never: only current versions are indexed) |

Deletions and the cursor advance commit in one transaction, so no receipt is missed or applied twice. On top:

- **Hard purge / job deletion:** `ON DELETE CASCADE` from `context_documents` / `jobs` removes the vector in the
  purging transaction itself.
- **Query time:** every candidate is joined with the live row (`deleted_at IS NULL`, `source_version =
  current_version`), so a soft-deleted or edited document never appears from a stale vector, even before the
  indexer ran (tested).
- **New versions** are re-embedded on the next pass (vector `source_version` ≠ `current_version`).
- **Model change:** vectors of another model (`Embedder.model`) are dropped and rebuilt.
- **Reindex** (`POST /context/search/reindex {namespace}`, admin+, step-up, audited `context.search.reindex`):
  pending receipts are applied first (the cursor is global), then the namespace's vectors are dropped and rebuilt
  from the live sources.

The indexer runs every `SEARCH_INDEX_INTERVAL_MS` (default 60 s; 0 = off) and only when a provider is
configured; passes do not overlap.

## 5. Storage: brute-force cosine instead of pgvector (decision)

The pinned database image `postgres:18.6-alpine@sha256:77f5…` ships **no `vector` extension** (checked: 60
contrib extensions, no `vector.control`). Adding pgvector would mean a custom Postgres image (build, pin, sign,
backup/restore re-test) for an optional feature. So vectors are `real[]` (`cardinality = dims` checked) and the
master scores them: the candidate set is already narrowed in SQL to the caller's project, its granted global
documents and its jobs (≤ 20 000 rows per query), cosine = dot product of unit vectors. At the expected scale
(hundreds to a few thousand documents per project, 512–1536 dims) this is a few milliseconds of CPU.

**Upgrade path to pgvector** (when an index exceeds ~50k vectors per project or latency matters): build a
digest-pinned `postgres:18.6` image with the `pgvector` extension (dependency-policy §3), `CREATE EXTENSION
vector`, add `embedding_v vector(<dims>)` filled from `embedding` (one model per column), an HNSW index
(`vector_cosine_ops`), and replace the scoring step with `ORDER BY embedding_v <=> $query LIMIT k` inside the same
permission-filtered query. The consent, receipts and query-time liveness checks do not change.

## 6. API

| Route | Action | Notes |
| --- | --- | --- |
| `GET /context/search?project=&q=&limit=` | `context.search` (viewer+ in the project) | 409 `search_unavailable` / `search_not_enabled`; 400 `search_query_rejected`; 429 `search_rate_limited` (30/min per user, provider cost); 502 `search_provider_error` |
| `GET /context/search/settings?namespace=` | `context.read` | `available`, `model`, `enabled`, `version`, `indexed` |
| `PUT /context/search/settings` | `context.search.admin` | admin+, step-up, CSRF, optimistic, audited; off deletes vectors |
| `POST /context/search/reindex` | `context.search.admin` | admin+, step-up, CSRF, audited |

Result scoping: project documents need the document's `readRole` ≤ the caller's project role; global documents the
grant to the project and `readRole` ≤ the caller's account role; job summaries `jobs.read` (viewer in the project,
same as `context.search`). Results carry `type`, `id`, `namespace`, `title`, a 240-character snippet, `version`
and the score. They are **data**: nothing in the platform feeds search results into an agent's prompt.

## 7. Providers

`SEARCH_PROVIDER=none` (default) — routes answer `409 search_unavailable`; consent cannot be enabled.

`SEARCH_PROVIDER=local-hash` — `LocalHashEmbedder`: hashed unigrams + bigrams (FNV-1a, signed buckets, log-scaled,
L2-normalised), 512 dims. Deterministic across processes, no network: lexical rather than semantic. Used by the
tests and suitable for operators who want search without a third party.

`SEARCH_PROVIDER=http` — `HttpEmbedder`: `POST SEARCH_HTTP_URL` with `{ model, input: string[], dimensions? }`,
`Authorization: Bearer <key>`; response `{ data: [{ index, embedding }] }` (validated with zod; order restored by
`index`; dimensions must agree). Verified against the OpenAI embeddings reference and the Voyage AI embeddings
API (ctx7); Ollama/LiteLLM serve the same shape. **Anthropic has no embeddings endpoint** — Voyage AI is the
provider Anthropic recommends, and it is covered by this same client. The key is read from `SEARCH_HTTP_KEY_FILE`
by `main.ts`, sent only as the bearer header, never logged; errors carry the HTTP status only (tested: neither the
key, the text nor the provider's error body appear). `https://` required (`http://` only for loopback), no
credentials/query in the URL, redirects refused, 30 s timeout, 32 texts per request.

`SEARCH_PROVIDER=bedrock` (p10-semantic-memory, the documented default since 2026-10-18) — Amazon Bedrock, Cohere
Embed Multilingual v3 by default, `search_document` / `search_query` input types, credentials from the AWS SDK default
chain; a provider/model change is audited and rebuilds the index. Searches can fall back to keywords
(`fallback=keyword`). See [p10-semantic-memory.md](p10-semantic-memory.md).

## 8. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Context sent to a third party without consent | per-namespace consent (admin, step-up, audited); off by default and without a provider; capture re-checks consent at insert | integration: nothing sent before consent; other projects / ungranted global text never sent (recording embedder) |
| Secrets or prompts sent to the provider | only documents + job summaries; secret scan before send; secret-looking queries refused | integration: prompt never sent, secret query refused before the provider |
| Cross-project leak via search (T-INJ-5) | SQL candidate filter (project namespace, grants, job project) + read-role filter + live-row join | integration: non-member 404, other project's docs absent, listed global doc only for its project, admin-only doc hidden from viewers |
| Deleted content resurfacing | query-time liveness check, receipts → deletions, cascade on purge, revocation deletes | integration: deleted doc hidden before and after the indexer, cursor = newest receipt, revocation removes all vectors |
| Vectors as derived data (embedding inversion) | vectors are treated with the sensitivity of their source: deleted with it, never returned by the API, never exported | review |
| Provider key leakage | file secret, bearer header only, generic errors | unit |
| Cost / abuse of the provider | 30 searches/min per user, 500-char queries, batch/timeout limits; route class `read` limits still apply | unit (limits), review |
| Repudiation | consent changes and reindex audited (success and denied) | integration |

Residual risks: the provider sees the consented text and the queries (inherent; that is what the consent is
for). The local-hash embedder is lexical. Brute-force scoring is bounded at 20 000 candidates per query (beyond
that, results come from a subset — the pgvector path in §5 removes the bound). Rollback: set `SEARCH_PROVIDER=none`
(routes answer 409; vectors stay until consent is turned off or the tables are dropped); the migration is additive.

## 9. Tests

- `apps/master/test/unit/search.test.ts` — local embedder determinism/ranking/edge cases, HTTP embedder request
  shape, order, failure modes without leaks, service guards without a provider, config validation.
- `apps/master/test/integration/search.test.ts` — the full lifecycle (10 tests) against Postgres.
- `apps/master/test/integration/{rbac-matrix,route-coverage}.test.ts` — new actions and routes.
- `apps/web/test/context-search.test.tsx` — panel lazy-loads, operator view, admin consent through step-up,
  search results, provider unavailable.

## 10. Operations

Enable: set `SEARCH_PROVIDER` (and for `http` the URL/model/key file), restart, then an admin turns capture on per
namespace in Settings → Context → Semantic search. Metrics hooks: indexer pass stats (`receipts`, `removed`,
`indexedDocs`, `indexedJobs`, `skippedSecrets`) are returned by `sync()`/reindex; failures are logged as
`search indexer pass failed` (error name only).
