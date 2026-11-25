-- p6-vector (optional, off by default): consent-bound semantic search over context documents and job
-- summaries. Design: docs/design/p6-vector.md.
--
-- The pinned image (postgres:18.6-alpine) ships no pgvector extension, so vectors are plain `real[]` and
-- similarity is computed by the master (brute-force cosine over the caller's readable candidates; fine at
-- this scale). Upgrade path to pgvector: docs/design/p6-vector.md §5.
--
-- Only derived vectors are stored, never text: titles/snippets are read from the live source rows at query
-- time, so a deleted document can never be shown from the index.

---------------------------------------------------------------------------------------------------
-- Per-namespace consent: nothing of a namespace is ever sent to the embedding provider unless enabled.
---------------------------------------------------------------------------------------------------

CREATE TABLE search_consent (
  namespace   text PRIMARY KEY
                CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'),
  enabled     boolean NOT NULL,
  -- Optimistic concurrency for the console (expectedVersion).
  version     integer NOT NULL CHECK (version >= 1),
  updated_at  timestamptz NOT NULL,
  updated_by  uuid NULL REFERENCES users (id)
);

---------------------------------------------------------------------------------------------------
-- Vectors. One per source (the current version of a live document, or the latest result summary of a
-- job). Purging a document or deleting a job removes its vector in the same transaction (ON DELETE
-- CASCADE); soft deletes, expiry and pruning reach the index through the deletion receipts.
---------------------------------------------------------------------------------------------------

CREATE TABLE search_embeddings (
  id              bigserial PRIMARY KEY,
  source_type     text NOT NULL CHECK (source_type IN ('context_doc', 'job_summary')),
  doc_id          uuid NULL REFERENCES context_documents (id) ON DELETE CASCADE,
  job_id          uuid NULL REFERENCES jobs (id) ON DELETE CASCADE,
  namespace       text NOT NULL
                    CHECK (namespace = 'global' OR namespace ~ '^project:[A-Za-z0-9_.:-]{1,128}$'),
  -- Document version number, or the job attempt id the summary came from.
  source_version  text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 64),
  -- sha256 of the exact text that was embedded (proof of what was sent; never the text itself).
  content_hash    text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  model           text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  dims            integer NOT NULL CHECK (dims BETWEEN 1 AND 8192),
  embedding       real[] NOT NULL CHECK (cardinality(embedding) = dims AND array_ndims(embedding) = 1),
  indexed_at      timestamptz NOT NULL,
  CHECK ((source_type = 'context_doc') = (doc_id IS NOT NULL)),
  CHECK ((source_type = 'job_summary') = (job_id IS NOT NULL)),
  CHECK (doc_id IS NULL OR job_id IS NULL),
  CHECK (source_type <> 'job_summary' OR namespace LIKE 'project:%')
);

CREATE UNIQUE INDEX search_embeddings_doc_idx ON search_embeddings (doc_id) WHERE doc_id IS NOT NULL;
CREATE UNIQUE INDEX search_embeddings_job_idx ON search_embeddings (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX search_embeddings_ns_idx ON search_embeddings (namespace, model);

---------------------------------------------------------------------------------------------------
-- Indexer cursor over context_deletion_receipts (ContextPolicyService.receiptsSince, p6-context-policy §4).
---------------------------------------------------------------------------------------------------

CREATE TABLE search_index_state (
  name            text PRIMARY KEY CHECK (name IN ('context')),
  receipt_cursor  bigint NOT NULL CHECK (receipt_cursor >= 0),
  updated_at      timestamptz NOT NULL
);
