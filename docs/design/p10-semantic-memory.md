# Design note: `p10-semantic-memory` — project memory suggestions and Bedrock embeddings

- **Status:** Implemented (since `p10-semantic-defaults-chat`, §12: on by default per project, opt-out at creation; chat in the embeddings; provider configured by env or — since
  `p10-bedrock-integration-panel`, §11 — from Settings → Integrations → AWS Bedrock; since `p10-chat-memory-suggestions`,
  §13, project-linked chat also feeds the Memory suggestions inbox)
- **Date:** 2026-10-18
- **Backlog:** `p10-semantic-memory` (owner request: "project memory suggestions — but not local-hash; find something
  else"), follow-up `p10-semantic-memory-live`
- **Builds on:** [p6-vector.md](p6-vector.md) (provider abstraction, consent per namespace, secret scan, RBAC-scoped
  search, receipts/reindex), [p6-context-model.md](p6-context-model.md) (namespaces, kinds, provenance, bundle),
  [p6-context-policy.md](p6-context-policy.md) (memory policy, receipts), [p5-ops-chat.md](p5-ops-chat.md) (tools).
  **Decisions applied:** ADR-0006 (no secrets leave the system), ADR-0009 (step-up for consent/opt-in), ADR-0010
  (agent output is data; memory has the lowest authority; provenance of every injected source).
- **Owner decisions (2026-10-18, in order):** (1) build it, but not on local-hash; (2) **do not run an embedding model
  on our own server** — the self-hosted TEI/Ollama service that was being evaluated is dropped; (3) **Amazon Bedrock
  Cohere Embed Multilingual** is THE provider (`cohere.embed-multilingual-v3`, v4 selectable), `input_type`
  `search_document` / `search_query`; (4) credentials through the existing env management (stack.env → compose
  environment of the master) using the **AWS SDK default credential chain**; an instance profile is the even safer
  option.
- **Migration:** `0076_memory_suggestions.sql` (renumber at merge if taken)

## 1. Scope

| Piece | Where | Responsibility |
| --- | --- | --- |
| Bedrock embedder | `apps/master/src/search/bedrock.ts`, `bedrock-models.ts` | `InvokeModel` via `@aws-sdk/client-bedrock-runtime` (SigV4, default credential chain); Cohere v3 / v4 / Titan V2 bodies; response validation; errors without secrets |
| Embedder contract | `apps/master/src/search/embedder.ts` | `embed(texts, purpose)` (`document` / `query`), `maxChars`, `provider`, `dims` |
| Search service | `apps/master/src/search/service.ts` | per-provider clipping, purpose, provider/model-change detection (audited) → automatic reindex, `find()` with keyword fallback, `keyword()`, `similarDocs()` for dedupe |
| Memory suggestions | `apps/master/src/memory-suggestions/{extract,dedupe,service,routes}.ts` | deterministic extraction (jobs; since §13 also shared project-linked chat), dedupe, inbox, accept/edit/dismiss, opt-in, backfill, assisted prompts |
| Chat tools | `packages/protocol/src/assistant.ts`, `apps/master/src/chat/tools.ts`, prompt rule 21 | `search_context` (read), `suggest_memory` (proposal into the inbox) |
| Config | `apps/master/src/config.ts`, `main.ts`, `infra/coolify/compose.yaml` | `SEARCH_PROVIDER=bedrock`, `SEARCH_BEDROCK_*`, `AWS_*` (master only), `MEMORY_*` |
| Console | `apps/web/src/screens/MemorySuggestionsPanel.tsx`, `ContextSearchPanel.tsx`, `outputs/RelatedJobs.tsx` | Projects → <project> → Memory; provider line + keyword fallback in Settings → Context; Outputs "jobs whose summary matches" |

## 2. Provider choice (and what was evaluated first)

**Evaluated and dropped (owner decision 2), for the record:** a self-hosted embedding service in the
`remana-prod` compose project. Facts gathered before the decision: Hugging Face text-embeddings-inference
`cpu-1.9.4` (index digest `sha256:2538ea1c…`, Apache-2.0, amd64 compressed ≈ 239 MB; arm64 only as a separate
`cpu-arm64-1.9` tag) versus Ollama 0.40.6 (≈ 3.8 GB amd64, no multilingual-e5). Models (Hugging Face API, all
TEI-tagged): `intfloat/multilingual-e5-small` (MIT, 471 MB weights, 384 dims), `multilingual-e5-base` (MIT, 1.11 GB,
768 dims), `BAAI/bge-m3` (MIT, 2.27 GB fp32, 1024 dims), `nomic-embed-text-v1.5` (Apache-2.0, English-centric). The
control plane is a **t3.medium (2 vCPU burstable, 4 GiB + 2 GiB swap)** that already gives 1 GiB to Postgres,
320 MiB to Redis, 768 MiB to the master and hosts Coolify itself: bge-m3 does not fit at all and e5-base would have
competed with the master for memory and CPU credits. No local benchmark was run (the work stopped at the decision).

**Chosen: Amazon Bedrock, Cohere Embed Multilingual v3** (`cohere.embed-multilingual-v3`):

- 100+ languages including Turkish (model card "multilingual … cross-lingual search"), 1024 dims, 512-token context
  (≤ 2048 characters per text, ≤ 96 texts per call) — enough for titles + short memories and the first part of a
  document (texts are clipped to 2048 characters for this model; v4 and Titan take 8000).
- Asymmetric search: `input_type: search_document` for what is indexed, `search_query` for queries.
- Runs in the control plane's own AWS account/region (us-east-1): no new third party, IAM-scoped, no model on our host.
- **Cohere Embed v4** (`cohere.embed-v4:0`, optional `us.`/`eu.`/`apac.`/`global.` inference-profile prefix;
  256/512/1024/1536 dims, 128k context) is selectable. The Bedrock pages confirm the request shape but **do not list
  its languages** (Cohere markets it as multilingual): UNVERIFIED for Turkish quality until a live check.
- **Titan Text Embeddings V2** (`amazon.titan-embed-text-v2:0`, 256/512/1024) is supported as a fallback.
- The OpenAI-compatible `http` provider (OpenAI, Voyage) and `local-hash` stay as they were (no extra cost to keep);
  no internal-http allowance was added (it was only needed for the dropped self-hosted service).

## 3. Bedrock embedder

`POST https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/invoke` through the official SDK
(`@aws-sdk/client-bedrock-runtime@3.1152.0`, exact pin, published 2026-10-14, 27 new lockfile packages, all
`@aws-sdk/*`, `@smithy/*`, `@aws-crypto/*`). Bodies (verified with ctx7 against the Bedrock user guide,
`model-parameters-embed-v3`, `-embed-v4`, `-titan-embed-text`, and the `InvokeModel` API reference):

| Model | Request | Response |
| --- | --- | --- |
| Cohere v3 | `{ texts, input_type, truncate: "END" }` | `{ embeddings: number[1024][] , id, response_type, texts }` |
| Cohere v4 | `{ texts, input_type, embedding_types: ["float"], output_dimension, truncate: "RIGHT" }` | `{ embeddings: number[][] }` (single type) or `{ embeddings: { float: number[][] } }` — both accepted |
| Titan V2 | `{ inputText, dimensions, normalize: true }` (one text per call) | `{ embedding: number[], inputTextTokenCount }` |

Vectors are validated (count, dims) and L2-normalised; the stored vector space is `bedrock:<model>[:<dims>]`.
Errors become `EmbeddingError("Bedrock embedding call failed (<ErrorName>, HTTP <status>)")` — never the SDK message
(it can carry account ids/ARNs), the text or credentials. Timeout 30 s per call (abort signal), SDK retries 3×
(throttling/5xx). The SDK's Bedrock client speaks HTTP/2; the unit test runs the real SDK against a cleartext h2 fake
endpoint and checks the SigV4 `Authorization` header (`…/<region>/bedrock/aws4_request`) and the path.

**Credentials:** the SDK default chain. In production either `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
(+ `AWS_SESSION_TOKEN`) set in `stack.env` and passed **only** to the master container
(`infra/coolify/compose.yaml`, `x-master-env`, `${VAR:-}`), or — preferred — none, with an instance profile on the EC2
host that has the same permission (containers need IMDSv2 hop limit 2). The config loader never reads the keys (they
are not in `MasterConfig`, so no config dump or diagnostic can print them); the master's git subprocesses get an
allow-listed environment without `AWS_*` (tested); the compose test asserts the keys appear only in the master
environment. Region: `SEARCH_BEDROCK_REGION`, falling back to `AWS_REGION`.

**Least-privilege IAM policy** (the Turkish canvas note has the full click-path):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RemyralEmbeddingsOnly",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-multilingual-v3"
    }
  ]
}
```

Add `arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0` only when switching to v4 (for a `us.` inference
profile also the profile ARN and the model ARNs of the regions it routes to). Model access: Bedrock enables
serverless Marketplace models on first invocation when the caller may `aws-marketplace:Subscribe` (product id of
Embed Multilingual: `38e55671-c3fe-4a44-9783-3584906e7cad`, of Embed v4: `prod-ft3cj5gst3spo`); the runtime user
does not get that permission — the owner enables the model once from the console as an administrator (or with a
one-time invoke as admin), after which `bedrock:InvokeModel` alone suffices.

**Changing the provider/model triggers a reindex:** every indexer pass compares the configured vector space with
`search_provider_state`; on a change it audits `context.search.provider_changed` (system actor, before/after,
removed vectors) once, drops the old vectors and rebuilds every consented namespace in the same pass. Settings →
Context shows provider, model and dimensions.

## 4. Extraction (deterministic pass)

`extractLearnings(summary)` reads the master-side **redacted** result summary of a job that reached `SUCCEEDED`
(never prompts, logs, transcripts) and proposes ≤ 5 learnings (title ≤ 80, content ≤ 500 chars):

| Rule | Finds |
| --- | --- |
| `marker` | `MEMORY:` / `LEARNING:` / `HAFIZA:` / `ÖĞRENİM:` lines |
| `section` | bullets under `## Learnings`, `## Notes for next time`, `## Öğrenimler`, `## Notlar` |
| `package-manager` | exactly one of pnpm / Yarn / npm / Bun (or uv / Poetry / Pipenv) in commands or lockfile names |
| `command` | ≤ 3 backticked verification commands (test / lint / typecheck / build / check) |
| `color` | a sentence with a hex colour and brand / primary / accent / marka / renk |
| `deploy-note` | a sentence about deploying with a requirement word (requires / needs / must / gerek… / şart) |

**Optional LLM summarisation — an ordinary job, never silent.** In `assisted` mode the inbox offers "Summarise a
finished job with an agent": the master builds a prompt (first line `[remyral:memory-summary job=<id>]`, rules, the
summary fenced as DATA with a fence that cannot occur in it) and the console opens it **in the job composer**; the
person reviews and submits it like any job (RBAC, quotas, approvals, runtime policy). When that job succeeds, the
pass reads only its `MEMORY:` lines (source `agent_summary`).

**From chat on request:** `suggest_memory` (operator+, project opted in) — the assistant writes the items itself
when the user asks; they land in the inbox like any other proposal.

## 5. De-duplication

1. **Secret scan** (`scanForSecrets` on title + content): a hit drops the candidate (`skipped_secrets`).
2. **Fingerprint**: sha256 of the normalised text, unique per project across all states — a dismissed learning is
   never proposed again; two jobs finding the same thing yield one row.
3. **Lexical** (always): Jaccard of word sets against the project's live `memory` documents and pending suggestions;
   ≥ 0.8 duplicate, ≥ 0.5 "similar to".
4. **Semantic** (only when a provider is configured **and** the project's search capture is consented, so nothing is
   sent without consent): the candidates are embedded (`search_document`, secret-scanned again) and compared with the
   stored vectors of the project's live documents (all kinds); cosine ≥ `MEMORY_DUPLICATE_THRESHOLD` (default 0.9)
   duplicate, ≥ threshold − 0.12 "similar to <document>". Provider failure → lexical only (logged by error name).

The default 0.9 is a starting point for Cohere v3 (paraphrases typically score in the high 0.8s–0.9s); it is
configurable and must be tuned on live data (`p10-semantic-memory-live`).

## 6. Inbox, decisions and the context bundle

| Route | Action (min role) | Notes |
| --- | --- | --- |
| `GET /memory-suggestions?project=&state=` | `memory.suggestions.read` (viewer) | pending by default |
| `GET /memory-suggestions/settings?project=` | `memory.suggestions.read` | mode, pending, semanticDedupe |
| `PUT /memory-suggestions/settings` | `memory.suggestions.admin` (admin) | step-up, CSRF, optimistic, audited `memory.suggestions.settings` |
| `POST /memory-suggestions/:id/accept` | `memory.suggestions.decide` (operator) | optional edited `title`/`content`; one decision (409 `memory_suggestion_decided`) |
| `POST /memory-suggestions/:id/dismiss` | `memory.suggestions.decide` | audited |
| `POST /memory-suggestions/backfill` | `memory.suggestions.admin` | ≤ 90 days, each job read once |
| `GET /memory-suggestions/agent-prompt?job=` | `memory.suggestions.decide` | assisted mode only |

Opt-in modes: `off` (default, no row), `rules`, `assisted`. Jobs that finished before the opt-in are only read by a
backfill. Accept calls `ContextStore.create(user, { namespace: project:<id>, kind: memory, importSource: "memory
suggestion <id> (job <jobId>)" })`: the document write role, secret scan and `context.doc.create` audit apply, and
the version's provenance is `import` naming the suggestion and its job. Future jobs receive it through the existing
bundle as a `memory`-layer item (lowest authority, ADR-0010; the agent memory budget applies). Viewers see the inbox
(suggestions derive from job summaries they can already read).

## 7. Semantic search everywhere, keyword fallback

`GET /context/search` gains `type` (`context_doc` | `job_summary`) and `fallback=keyword`, and answers
`{ items, mode, fallbackReason }`. With `fallback=keyword`, no provider / capture off / secret-looking query /
provider error / provider rate limit → keyword search (every term in title or text, same RBAC and read-role rules,
nothing sent anywhere, snippets with secret-looking values withheld). Without it the p6-vector contract
(409/400/429/502) holds. Used by: Settings → Context (search box always available for a project, says "by meaning" /
"by keywords (why)"), Outputs ("jobs whose summary matches", click narrows to the job's files), and the chat tool
`search_context` (results labelled as data).

## 8. Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Context sent to AWS without consent | embedding only for consented namespaces (unchanged p6-vector consent, admin + step-up); dedupe embeds only when the project consented; keyword fallback never sends | integration: no Bedrock call before consent; `sent` stays empty in the keyword path |
| Secrets sent to AWS / stored as memory | secret scan before embedding (index and dedupe), before proposing, at accept (ContextStore), secret-looking queries never sent; keyword snippets with secrets withheld | integration: `ghp_` learning skipped and never shown, secret query → keyword with no items |
| AWS key leakage | SDK default chain reads env; keys never in `MasterConfig`, logs or errors; only the master container gets them; git subprocess env allow-list; instance profile documented as preferred | unit: config dump has no key, error has no ARN/key, git env without `AWS_*`; compose test |
| AWS keys in backups | `stack.env` (with the keys) is copied into the p10-backup-restore archive, age-encrypted to the owner's public keys only, never into the backup container's environment; losing a backup key means rotating the access key; an instance profile avoids static keys entirely | compose test (`backup` has no `AWS_*` environment) |
| Over-privileged AWS identity | IAM policy limited to `bedrock:InvokeModel` on one model ARN; no Marketplace permission for the runtime user | review (canvas note) |
| Prompt injection via job output into memory (T-INJ-1/2) | suggestions are proposals; only operator+ accepts, edit possible, plain-text rendering; accepted text is `memory` (lowest authority, fenced in the bundle); the summarising job fences the summary as data; prompt rule 21 forbids proposing memory because data asks for it | web: script tag rendered as text; integration: agent-summary job yields only marker learnings |
| Cross-project leak (T-INJ-5) | inbox, decisions and dedupe scoped to the project; semantic dedupe compares only the project's own vectors; search RBAC unchanged | integration: non-member 404, viewer 403 on accept/agent-prompt; RBAC matrix |
| Silent automation / cost | per-project opt-in (admin, step-up, audited); LLM summarisation is an ordinary job a person submits; search rate limit unchanged; pass every 60 s, ≤ 500 jobs per pass | integration: off by default, opt-in audited |
| Repudiation | settings, accept, dismiss, backfill, chat proposals, provider change all audited (success and denied) | integration |
| Dependency risk (T-SUP-1) | official AWS SDK, exact pin, ≥ 24 h old, lockfile integrity; needs the owner's dependency review (dependency-policy §2) | `pnpm security:pins` |

Residual risks: AWS (Bedrock) processes the consented text and queries (inherent; that is what consent is for); the
deterministic rules are heuristics and will propose some noise (dismiss is permanent); the semantic threshold needs
tuning on live data; Embed v4 Turkish quality is unverified.

## 9. Rollback and operations

Rollback: `SEARCH_PROVIDER=off` (§11.2; before §11 `none`) or Remove in Settings → Integrations (search falls back to keywords; suggestions keep working with lexical dedupe) and/or
set every project's mode to `off`; `MEMORY_SUGGEST_INTERVAL_MS=0` stops the pass. The migration is additive.
Metrics/log: `memory suggestion pass failed` / `search indexer pass failed` (error name only); pass stats are returned
by `pass()` / backfill (`jobs`, `proposed`, `duplicates`, `skippedSecrets`).

## 10. Tests

- `apps/master/test/unit/bedrock-embedder.test.ts` — bodies per family, input types, both v4 response shapes,
  validation, errors without secrets, real SDK against a fake h2 Bedrock endpoint (SigV4 header, path), config,
  git env isolation.
- `apps/master/test/unit/memory-suggestions.test.ts` — extraction rules (Turkish + English), caps, fingerprints,
  threshold classification, Jaccard, best match.
- `apps/master/test/integration/memory-suggestions.test.ts` — opt-in, backfill, secret skip, consent-gated semantic
  dedupe through the real SDK + fake Bedrock, accept with provenance into the bundle, dismiss permanence, chat
  proposals, assisted prompt, keyword fallback, chat tools, provider-change audit.
- `apps/master/test/integration/{rbac-matrix,route-coverage}.test.ts`, `search.test.ts` (unchanged contract).
- `scripts/test/compose-env.test.mjs` — AWS/Bedrock variables only in the master environment; no model service.
- `apps/web/test/memory-suggestions.test.tsx`, `context-search.test.tsx` — inbox, edit/accept/dismiss, viewer
  read-only, step-up opt-in, backfill, composer prefill, Outputs related jobs, provider line, keyword fallback hint.

## 11. Addendum: Settings → Integrations → AWS Bedrock (`p10-bedrock-integration-panel`)

- **Date:** 2026-10-18. **Owner expectation:** the Bedrock embedding credentials are managed from the console like
  the Coolify / Cloudflare tokens (master-held, encrypted at rest, never shown again, test connection), not only from
  `stack.env`.
- **Migration:** `0078_bedrock_integration.sql` (renumber at merge if taken): `ops_integrations.provider` admits
  `bedrock`; `search_provider_state.region` (nullable).

### 11.1 Pieces

| Piece | Where |
| --- | --- |
| Storage, precedence, connection test | `apps/master/src/search/bedrock-integration.ts` (`BedrockIntegration`, pure `resolveProvider`) |
| REST | `apps/master/src/search/bedrock-routes.ts`: `GET /integrations/bedrock` (`integrations.bedrock.read`, admin — owner included), `PUT` / `DELETE /integrations/bedrock` (`integrations.bedrock.write`, admin, **always-fresh step-up**, CSRF), `POST /integrations/bedrock/test` (same action, CSRF) |
| Swappable provider | `SearchService.setProvider()` / `noteProvider()`; the region is part of the provider identity (§11.3) |
| Console | `apps/web/src/screens/BedrockIntegrationCard.tsx` (Settings → Integrations), provider line in `ContextSearchPanel.tsx` |

**Storage** is the Coolify / Cloudflare one (ADR-0028): one `ops_integrations` row `provider = 'bedrock'`; the access
key id + secret access key are one AES-256-GCM blob under the HKDF sub-key `ops-integrations`, AAD
`ops-integration:bedrock`; `config` = `{region, model, keyIdHint}` (last four characters of the key id, to find it in
IAM); `key_fingerprint` = first 16 hex of SHA-256 over both values. Only long-term IAM user keys are accepted
(`AKIA` + 16, 40-character secret); temporary `ASIA` keys would need a session token and are not offered. Saving
without keys keeps the stored ones (both or neither); a key or settings change clears the last test. Audit:
`ops.integration.bedrock.save` (fingerprints, settings before/after), `.remove`, `.test` (ok, AWS error type, HTTP
status, dims).

**Test connection** builds a client from the stored keys / region / model (15 s timeout) and embeds two fixed texts
(Turkish + English, no customer data, `search_document`). It answers `{ok, region, model, dims, vectors, latencyMs}`
or `{ok: false, error: <AWS error type>, httpStatus, hint}` — the SDK message is never used (it carries account ids /
ARNs). Hints by type: `UnrecognizedClientException` / signature errors → wrong key; `AccessDeniedException` → IAM
policy or model access; `ResourceNotFoundException` / `ValidationException` → model not in this region;
throttling; timeout; 5xx.

The card also shows the minimal IAM policy for the **selected** region and model (§3, `Resource` =
`arn:aws:bedrock:<region>::foundation-model/<model>`) with a copy button and the model-access step (enable once in the
Bedrock console as an administrator; the runtime user gets no Marketplace permission). The region list is the in-Region
availability of Cohere Embed Multilingual v3 (Bedrock user guide, Knowledge Bases supported models, 2026-10-18):
us-east-1, us-west-2, ca-central-1, sa-east-1, eu-central-1, eu-west-1/2/3, ap-northeast-1, ap-south-1,
ap-southeast-1/2. Inference-profile model ids (`us.cohere.embed-v4:0`) stay env-only.

### 11.2 Precedence

| `SEARCH_PROVIDER` (env) | panel row | active provider | source shown |
| --- | --- | --- | --- |
| `off` (new) | any | none — kill switch | — |
| `http` / `local-hash` | any | the env provider; the card says the panel is saved but not in use | environment |
| unset / `none` / `bedrock` | usable | Bedrock with the panel's region, model and keys | panel |
| `bedrock` | none, or keys not decryptable | Bedrock from env (SDK default chain) | `environment` when `AWS_ACCESS_KEY_ID` is set (presence only), else `instance role` |
| unset / `none` | none, or not decryptable | none (keyword search) | — |

So saving the card turns Bedrock on even when `SEARCH_PROVIDER` is empty, and "Remove" falls back to the
environment. `SEARCH_INDEX_INTERVAL_MS` now applies without an env provider (the panel can add one); every indexer
pass first re-reads the panel row (one indexed `SELECT`), so a second master replica would follow within one interval.

### 11.3 Model / region change → audit + reindex

The region is now part of the provider identity (`search_provider_state.region`). A model change behaves as before;
a region change with the same model drops every vector. A panel save / remove that changes either records it at once
with the **person** as the audit actor (`context.search.provider_changed`, metadata `before`, `after`,
`beforeRegion`, `afterRegion`, `source`, `removedVectors`) and the next indexer pass rebuilds every consented
namespace; the indexer does not audit the same change again. A state row written before 0078 (region NULL) with the
same model adopts the region without a rebuild, so deploying this change does not reindex. New keys alone change
nothing in the index.

### 11.4 Credentials flow

The master decrypts the keys only to build a `BedrockRuntimeClient` with **static credentials** (`credentials:
{accessKeyId, secretAccessKey}` — the SDK then never consults its default chain) or to run the test. They are never
written to `process.env` (the env fallback keeps reading the SDK default chain itself), never in `MasterConfig`, a log
line, an error, an audit row or an API response, never sent to a worker, a job environment or the chat assistant.

### 11.5 Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Key disclosure via API / UI | write-only fields; responses carry fingerprint + last four of the key id only | integration: response, status, DB row (`secret`, `config`) without the canaries; web: keys not on the page after save |
| Key disclosure via logs / audit / errors | no key in metadata; AWS message never used (type + status only) | integration: canaries absent from every audit row and the log capture; failed test without the account id |
| Key reaching other processes | static credentials provider; no `process.env` write; master-only | integration: SigV4 `Credential=<panel key id>/…/<region>/bedrock/…`, `process.env.AWS_*` untouched |
| Unauthorised change (redirecting consented context to another AWS account) | admin only, always-fresh step-up, CSRF, audited; owner-visible source line in Settings → Context | integration: operator 403, stale step-up 403; rbac-matrix, route-coverage (always-fresh list) |
| Silent provider switch | provider change audited with the person; reindex automatic | integration: region change, model change, remove → three audits, keys-only change → none |
| Master key rotation | undecryptable row → "keys unusable", env fallback, test explains | unit: precedence table |
| Ops kill switch | `SEARCH_PROVIDER=off` ignores the panel | unit |

Residual: an admin with a fresh code can point embeddings at their own AWS account (same trust as the other
integration tokens; audited and visible); IAM keys in the database are as safe as the master key file.

### 11.6 Rollback and deploy

Rollback: "Remove" (env / instance role takes over) or `SEARCH_PROVIDER=off`. Migration 0078 is additive (a rollback of
the code leaves a `bedrock` row the old code ignores). Deploy: master + web; no worker release (nothing reaches
workers). Live verification stays with `p10-semantic-memory-live` (the owner now enters the keys in the panel).

## 12. Addendum: knowledge on by default, chat in the embeddings (`p10-semantic-defaults-chat`)

- **Date:** 2026-10-18. **Migration:** `0081_semantic_defaults_chat.sql` (0080 = p10-chat-organize).
- **Owner decisions (2026-10-18):**
  1. Semantic search capture and memory suggestions are **on by default** for projects; the create-project form (and
     `POST /projects`) can switch them off ("exclude"), and a project switched off is not included. Existing projects
     that never chose are switched on (provenance "platform default" in the audit log, one entry per project); an
     explicit "off" stays off. `global` (org-wide documents) is on by default too. Changing a project later keeps the
     admin + step-up gate. No provider → keyword fallback as before.
  2. **Ops chat in the embeddings:** user messages and assistant answers (never tool payloads, never binary attachments;
     small, already secret-scanned text attachments only), per thread, secret-scanned and redacted, chunked. Chat is
     private to its owner — user-scope chat vectors are searchable only by the owner (never project members, admins or
     owners) and never enter job context bundles. "Search my conversations" by meaning (keyword fallback),
     `search_context` `scope: chat` limited to the caller's own threads. On by default per user, per-user opt-out in
     Settings → Chat (deletes the user's chat vectors). Deleting a thread deletes its vectors; archiving keeps them.
     Existing threads are backfilled.
  3. (Update) **Project-related chat is also project knowledge:** a message linked deterministically to a project (the
     thread's project — settable in the chat header, auto-suggested —, an `@project` mention, a draft the assistant made
     for the project in that turn; no model classification) is indexed into that project too, with provenance (thread,
     message, author), findable by the project's readers, never in a job bundle automatically. Controls: a visible
     marker in the thread, a per-thread switch, a per-user setting (default on) and the project's capture switch.
     Deleting a thread or opting out removes both scopes. Sharing changes are audited.
  4. (Update) **Wording:** "Shared with project X knowledge", the per-thread switch "Share with project knowledge", the
     setting "Share project-related chat with project knowledge" (Turkish docs: "X projesinin bilgi birikimine
     ekleniyor") — no "search" wording for sharing.
  5. (Update) **The chat uses the embeddings automatically:** on every user turn the master looks up related knowledge
     the user can read (own earlier conversations; the thread's and @mentioned projects' documents, accepted memory,
     job summaries, shared project chat), bounded, deduplicated against the current thread, redacted and fenced as
     data with provenance; keyword fallback without a provider; the answer shows "used N related items"; per-user
     switch; query embeddings cached per turn; never another user's private chat.

### 12.1 Defaults (`apps/master/src/search/defaults.ts`)

| Piece | Behaviour |
| --- | --- |
| `semantic_defaults` (one row) | `project_capture` (default true), `memory_mode` (default `rules`), `version`, `backfilled_at`; `GET/PUT /context/defaults` (`context.defaults`, admin; PUT with step-up, optimistic, audited `context.defaults.update`). Settings → Context → "Defaults for new projects". |
| Provenance | `search_consent.source` / `memory_suggestion_settings.source` ∈ `explicit` (admin change through the existing routes — admin + step-up unchanged), `create` (create-project form), `platform_default` (backfill). Existing rows became `explicit`. API field `origin`. |
| New project | `Directory.createProject` writes both rows in the project's insert transaction (`applyOnCreate`), **on or off** — an unchecked box is an explicit, sticky "off". `POST /projects` takes optional `searchCapture` / `memorySuggestions` (omitted = platform default); the `project.create` audit carries the choice. Project creation itself is admin + step-up. |
| Backfill | `SemanticDefaultsService.backfill()` runs once at master start (`backfillOnStart`, main.ts), under a row lock, and marks `backfilled_at`. Projects without a capture row → capture on; without a memory row → `rules` (`enabled_at` = now, so earlier jobs are only read by an explicit backfill); `global` → on. One `context.defaults.applied` audit entry per touched project (system actor `semantic-defaults`, metadata `provenance: "platform default"`, what was applied and what was kept). It runs in the master, not in SQL, because the audit log is hash-chained (`AuditRecorder`). |
| No provider | Capture "on" stores the consent only; nothing is sent; search uses keywords (`fallbackReason: unavailable`). A provider configured later starts indexing these projects (the owner's decision). |

### 12.2 Chat: what is indexed and how it is linked

Indexed parts: `chat_messages` with role `user` / `assistant` (the answer text as stored — already redacted by the
master), and `chat_attachments` of kind `text` bound to a user message, ≤ 16 KiB (they were redacted and secret-scanned
at upload). Never: tool rows (`role = tool`, one-line summaries of tool calls), error rows, draft payloads, images, PDFs.

**Project links** (`computeLinks`, deterministic, recomputed per thread by `relink`): the thread's project
(`chat_threads.project`, set in the header via `PUT /chat/threads/:id/knowledge` — only a project the user can read,
404 otherwise); an `@project` mention chip of a user message (links that message and the answers of its turn); a draft
card for a project in a turn (`chat_drafts.project` + `turn_id`: links the turn's user message and answers). A user
message's turn is the turn of the first following row with a `turn_id`, before the next user message. Stored in
`chat_message_links (message_id, thread_id, project, reason)`. `suggestedProject` = the most linked project of an
unlinked thread.

### 12.3 Chunking, redaction, vectors

`redactChatText` (the `@remyral/observability` default rules) → `chatChunks` (paragraphs packed to ≤ 1500 characters,
long ones cut at a sentence / word boundary, ≤ 16 chunks per part) → each chunk re-scanned (`scanForSecrets`; a hit is
skipped and counted) → embedded once (`search_document`) → one `chat_embeddings` row per scope: `user` always,
`project` per eligible linked project. Only vectors and a sha256 of the embedded text are stored; snippets are re-cut
from the live message at query time (deterministic chunking), so a deleted message is never shown. A provider / model /
region change drops chat vectors with the others (`noteModel`) and the chat pass rebuilds them.

**Pass** (`ChatKnowledge.pass`, on the search indexer's interval): threads whose `links_synced_at` / `search_synced_at`
is older than `updated_at` (≤ 50 per pass) are relinked (always) and indexed (with a provider): stale rows (unlinked,
changed, other model) are deleted, missing ones inserted. Inserts take the user's advisory lock and re-check the
switches (the same lock `setPrefs` / `setThreadKnowledge` hold while they delete) and the project's consent row
`FOR SHARE` (held `FOR UPDATE` by `setConsent` while it revokes) — a vector never lands after its switch went off.
Existing threads are backfilled by the same pass (`search_synced_at` is NULL after the migration).

### 12.4 Who can find what

| Scope | Query | Who |
| --- | --- | --- |
| user | `GET /chat/search` (the chat list's search box, "Messages by meaning"), `search_context {scope: "chat"}`, related knowledge | **only the thread's owner** — `e.user_id = caller AND t.user_id = caller`, whatever the role (owners and admins included) |
| project | `GET /context/search` (type `chat_message`, also with `fallback=keyword`), `search_context` (project scope), related knowledge | readers of the project (`context.search`, viewer+) while **all** hold at query time (`projectChatEligible`): linked to the project, thread switch on, owner's indexing and sharing on, project capture on, owner still owner/admin or a member of the project |

A project hit carries provenance `chat: {ownerName, author, seq, at, threadId}`; `threadId` only for the owner (nobody
else can open the conversation — the thread routes stay owner-only). The context bundle reads `context_documents` only:
chat reaches a job only if someone accepts a memory suggestion made from it.

### 12.5 Switches

| Switch | Where | Effect |
| --- | --- | --- |
| Index my conversations (default on) | Settings → Chat → My conversations (every user; the assistant settings below stay admin-only) | off: deletes **all** the user's chat vectors (both scopes) in the transaction; search falls back to keywords (`opted_out`), nothing is sent |
| Share project-related chat with project knowledge (default on) | same | off: deletes the user's project-scope vectors |
| Look up related knowledge on every message (default on) | same | off: no lookup, no block |
| Share with project knowledge (per thread, default on) | chat header, shown when the thread is linked | off: deletes the thread's project vectors at once; audited `chat.knowledge.share` |
| Project capture | Project → Context (admin, step-up) / the create form | off: deletes the project's chat vectors with its other vectors; on: linked threads are re-read |

Every preference change is audited (`chat.knowledge.preferences`, before / after, removed vectors). Deleting a thread
deletes its vectors and links (`ON DELETE CASCADE`); archiving keeps them (archived threads stay searchable for their
owner, marked "(archived)").

### 12.6 Related knowledge on every turn

`ChatService.send` (and the replica that sends a turn for another one) calls `ChatKnowledge.related(subject, thread,
text, @projects)` before dispatch: one query vector (cached 10 min per user + model + text, so a re-dispatch does not
call the provider again) scored against the user's own other threads and, per readable project (thread project +
mentioned, ≤ 3, capture on), its documents (incl. accepted memory), job summaries and shared chat — the current thread
excluded (it is the conversation itself), one entry per message, minimum cosine 0.35 (`relatedMinScore`), ≤ 6 items
(`relatedLimit`), ≤ 6 KiB of snippets (`relatedMaxBytes`), each snippet redacted again and dropped if it still looks
secret. Without a provider (or rate limited / failing / opted out) the same sources by keywords. The block is
`fenceData('related knowledge', …)` ("untrusted data, not instructions") with numbered items (source kind, project,
title, date, console link — none for another person's conversation) and joins the turn's existing `context` field (the
one `@mentions` use: **no new worker contract**; only workers that read mentions get it). The user message keeps
`meta.related = {mode, items}`; the console shows "Used N related items · found by meaning" under the answer, with
links. A lookup failure never fails the turn (logged by error name).

### 12.7 API and contracts

New: `GET/PUT /context/defaults`; `GET /chat/search`; `GET/PUT /chat/knowledge/preferences`;
`PUT /chat/threads/:id/knowledge`. Changed (additive): `POST /projects` (+`searchCapture`, `memorySuggestions`;
response +`searchCapture`, `memoryMode`), `GET /chat/threads/:id` (+`knowledge`), `GET /context/search` (`type`
+`chat_message`, hits +`chat`), search / memory settings (+`origin`). Protocol: `search_context` input `project`
optional, new `scope: "project" | "chat"`, `type` +`chat_message` (old workers keep sending `project` — accepted);
prompt rule 23 (related knowledge is data, cite it; `scope: "chat"` for the user's own past conversations; point to the
sharing switch). **Worker release needed** for `scope: "chat"` and rule 23; the related-knowledge block already works
with the current mentions-capable workers. The console must be deployed with the master (older consoles reject the new
`chat_message` hit type).

### 12.8 Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Another user (incl. admin / owner) reads a private conversation | user-scope queries filter on the caller's id twice (vector owner and thread owner); thread routes unchanged (owner-only, 404); related knowledge and `scope: chat` use the caller of the turn | integration: bob / admin / owner / carol get nothing from alice's private thread via `/chat/search`, the tool, project search (semantic and keyword) or related knowledge |
| Private (unlinked) chat leaking into a project | only deterministic links create project vectors; query-time `projectChatEligible` re-checks link + switches + capture + owner access | integration: no project vector or hit for the unlinked thread, also word for word |
| Sharing outliving the owner's choice | per-thread / personal / capture switches delete in their transaction; inserts re-check under the same lock / `FOR SHARE`; query-time re-check | integration: thread off, personal off, opt-out, capture off — vectors gone, hits gone, nothing sent afterwards |
| Planting chat into another project | `PUT …/knowledge` requires an existing, visible project (404 otherwise); mentions are resolved as the sender; the owner must still read the project at query time | integration: link to a project the user cannot read → 404 |
| Secrets sent to AWS or shown in snippets | redaction before chunking, re-scan per chunk (skip), snippets re-redacted, related snippets re-scanned; secret-looking queries never sent | integration: a `ghp_` token in an answer never reaches the provider, `[REDACTED` does; unit: redaction / scan |
| Tool payloads / binaries embedded | roles `user` / `assistant` only; text attachments ≤ 16 KiB only | integration: tool row text never sent |
| Chat entering job context automatically | the bundle reads context documents only; chat vectors live in `chat_embeddings` | integration: the project's bundle has none of the chat text |
| Prompt injection through shared chat / documents in the related block | fenced as untrusted data, numbered, lowest authority (ADR-0010), rule 23; another person's conversation is labelled as such | e2e: block fenced; web: titles / snippets as text, non-console links dropped |
| Defaults silently overriding a choice | backfill only fills missing rows, once, audited per project; explicit off sticky; later changes need admin + step-up | integration: explicit off kept, second backfill no-op, operator 403 / stale step-up |
| Silent cost / provider calls | one query embedding per turn (cached), the search rate limit applies (keyword fallback when exceeded); per-user switches | integration: opt-out → no new provider calls |
| Repudiation | `context.defaults.applied` / `.update`, `chat.knowledge.share`, `chat.knowledge.preferences`, consent / memory changes audited | integration |

Residual risks: project members read snippets of conversations their colleagues linked to the project (by design, with
a visible marker and switches); AWS Bedrock processes the indexed chat text (the platform default the owner chose;
opt-out per user); the related-knowledge threshold (0.35) and chunk size need tuning on live Cohere scores; the
memory-suggestion pass did not yet propose learnings from project-linked chat (built since in `p10-chat-memory-suggestions`,
§13).

### 12.9 Rollback and operations

Rollback: set the platform default off (`PUT /context/defaults`) — new projects only; switch capture off per project;
users opt out; `SEARCH_PROVIDER=off` stops all embedding (chat falls back to keywords). Migration 0081 is additive (a
code rollback ignores the new columns and tables). The backfill is one-way by design (its audit entries name each
project, so an admin can switch projects off explicitly). Logs: `chat knowledge pass failed`, `related knowledge lookup
failed` (error name only). Deploy: master + web together; worker release for `scope: chat` and rule 23.

### 12.10 Tests

- `apps/master/test/integration/semantic-defaults-chat.test.ts` — defaults (new projects on / off, backfill once with
  provenance and one audit per project, explicit off sticky, later changes gated, platform default editable) and chat
  (redaction, links by thread / draft, header knowledge, owner-only search vs bob / admin / owner / carol, project hits
  with provenance, non-member 404, private chat never in project search, per-thread off, capture off, bundle, tool
  `scope: chat`, related knowledge scoping / exclusion / bounds / threshold / switch, personal share off, opt-out,
  delete vs archive, model change).
- `apps/master/test/integration/chat-related.test.ts` — end to end with the real worker and assistant host: the related
  block reaches the engine fenced, `meta.related` lists the sources, own earlier conversations are found, a non-member
  gets nothing even with a mention, the per-user switch turns it off.
- `apps/master/test/unit/chat-knowledge.test.ts` — links (thread / mention / draft / turns), redaction, chunking,
  snippets.
- `apps/web/test/semantic-knowledge.test.tsx` — create-project toggles from the defaults, header marker + switch +
  suggestion, "Used N related items" disclosure, "Messages by meaning" with the keyword-fallback reason, Settings → Chat
  opt-out for an operator.
- Updated: `rbac-matrix` (`context.defaults`), `route-coverage`, `workspace.test.tsx`, `p6-shell.test.tsx`.

## 13. Addendum: memory suggestions from project-linked chat (`p10-chat-memory-suggestions`)

- **Date:** 2026-10-18. **Migration:** `0082_chat_memory_suggestions.sql` (0081 = p10-semantic-defaults-chat; renumber at
  merge if taken). **Owner decision (2026-10-18):** build it — project-linked chat also feeds the project's Memory
  suggestions inbox with the same rules, switches, dedupe and human review; assisted summarising only as a job the
  owner submits, never an automatic model call.

### 13.1 What is read

The memory-suggestion pass (same poller, `MEMORY_SUGGEST_INTERVAL_MS`) reads, after the job pass, chat messages that
are **shared with a project's knowledge right now** — exactly the §12.4 project scope: a deterministic link
(`chat_message_links`: thread project / `@project` mention / draft in the turn) **and** `projectChatEligible` (thread
switch on, owner's indexing and sharing on, project capture on, owner still owner/admin or a member) — of projects whose
memory mode is not `off`, written at or after the project's `enabled_at` (an admin backfill also reads the last N days),
in threads whose links are up to date (`links_synced_at >= updated_at`, so a just-changed link is never read stale).
Each (message, project) is read once (`memory_suggestion_chat_reads`). Roles `user` / `assistant` only; attachments and
tool rows never. Requiring the project's capture keeps one rule for users: a conversation feeds a project's memory
suggestions exactly when its header says "Shared with project X knowledge".

| Author | Rules (`extractChatLearnings`) |
| --- | --- |
| person (`user`) | every job rule (§4) **plus** `decision`: `DECISION:` / `KARAR:` / `CONVENTION:` / `KURAL:` lines; a sentence with a strong opener ("bundan sonra", "bundan böyle", "from now on", "going forward", "henceforth"), or a weak one ("artık", "her zaman", "asla", "always", "never") together with a convention verb ("kullan…", "olsun", "olmalı", "yapma", "use", "prefer", "must", "avoid", "pin" …). Questions (`?`, "mı / mi / mu / mü") never count. |
| assistant answer | only explicit `MEMORY:` / `HAFIZA:` … marker lines — an answer narrates, quotes repositories and guesses; its other sentences are not the team's decisions |

The `decision` rule is chat-only (in a job summary "always / never" is narration). The text is redacted with the chat
redactor (`redactChatText`) **before** extraction; a candidate that still carries a `[REDACTED` marker or trips the
secret scan is dropped (`skippedSecrets`). Dedupe is §5 unchanged: fingerprint (exact, across all states), lexical
(memory documents + pending suggestions), semantic only with the project's capture consented. **Rate limit:** at most
`MEMORY_CHAT_PER_THREAD_DAY` (default 5; `0` = chat not read) inserted suggestions per thread per rolling 24 h,
counted across projects; candidates over the cap are recorded as `rate_limited` and not proposed later (bounded and
predictable; a busy thread does not grow a backlog). One master process serialises the pass; with two replicas the cap
could be exceeded by the candidates in flight (single master in production).

### 13.2 Provenance and what reviewers see

`memory_suggestions` gains `chat_message_id` (ON DELETE SET NULL), `chat_seq` (NOT NULL exactly for chat-pass rows),
`chat_author`, `chat_owner`, `chat_at`; `source` stays `chat` (the existing value of `suggest_memory`, so older consoles
keep parsing). The API adds `chat: {origin: 'pass' | 'assistant', ownerName, author, seq, at, snippet}` (null for job
suggestions); the inbox shows a **Chat** badge and "from a conversation of <user>, <date>". `snippet` is the one line of
the message the learning came from, **re-cut at read time** from the live, redacted message and only while the message
is still shared with that project (null otherwise, and null when it still looks secret) — no chat text is stored with a
suggestion besides the suggestion itself. `threadId` is returned **only to the conversation's owner** (null for every
other reviewer, also for `suggest_memory` rows); the thread routes stay owner-only. Accepting writes the memory document
with `importSource = "memory suggestion <id> (chat message #<seq>)"`. The pass audits each message that proposed
something as `memory.suggestion.propose` (system actor `memory-suggestions`; metadata project, threadId, seq, author,
counts — no text).

`suggest_memory` (the assistant on the user's request) stays as it was and gets the same provenance shape
(`origin: 'assistant'`, owner = the asking user, no snippet) and the same dedupe; it is not rate limited (explicit
request, ≤ 5 items per call, operator+, project opted in).

### 13.3 Withdrawal

A pending chat-pass suggestion is visible (list, pending count, accept / dismiss — 404 otherwise) only while its message
is still shared with the project (`CHAT_VISIBLE`, the same `projectChatEligible` check). Each chat pass then **deletes**
such pending rows and their read marks, so re-sharing reads the message again. Covered: thread switch off, personal
sharing / indexing off, unlink, project capture off, membership lost, message / thread deleted (`chat_message_id` →
NULL). Accepted suggestions stay (they are context documents now, with their own delete); dismissed ones stay
(fingerprint memory). Memory mode `off` stops reading but keeps the inbox, as for jobs.

### 13.4 Assisted: "Summarise this conversation for project memory"

`GET /memory-suggestions/chat-prompt?project=&thread=` (`memory.suggestions.decide`, operator+; **the thread's owner
only** — anyone else 404, no oracle; mode `assisted` else 409; no shared message 409 `chat_not_shared`) returns an
ordinary job prompt: first line `[remyral:memory-summary thread=<id>]`, rules, the conversation's messages shared with
the project (the newest that fit in 12 000 characters, redacted, a part that still looks secret left out) fenced as data
with a fence that cannot occur in it. The chat header (`ThreadKnowledge.memorySummary`: shared projects in assisted mode
where the owner is operator+) shows **Summarise for <project> memory**, which opens the prompt **in the job composer**;
the owner reviews and submits it like any job (RBAC, quotas, approvals, runtime policy). Nothing calls a model by itself.
When that job succeeds the job pass reads only its `MEMORY:` lines (`agent_summary`); the conversation is attached as
provenance only if the job's creator owns it (a hand-written marker cannot claim someone else's thread).

### 13.5 Security review

| Threat | Mitigation | Test |
| --- | --- | --- |
| Private (unshared) chat reaching a project's inbox | only linked **and** `projectChatEligible` messages are read; unlinked threads never | integration: private thread and the unmentioned message of a loose thread produce no row in any project |
| Reviewers reading the conversation | API returns the suggestion + one redacted line, re-cut only while shared; no thread id for non-owners; thread routes owner-only | integration: other lines of the message and the thread id absent from a reviewer's response; web: no link, snippet as text |
| Sharing outliving the owner's choice | query-time `CHAT_VISIBLE`, purge on the next pass, nothing new read | integration: thread off (hidden at once, accept 404, purged, re-read after re-share), personal off, mode off, capture off, thread delete |
| Secrets becoming memory | redaction before extraction; `[REDACTED` / secret-scan drop; snippets re-scanned; assisted prompt redacted with secret-looking parts left out | integration: token decision never proposed, no `ghp_` / `REDACTED` in any row, token absent from the prompt; unit: snippet |
| Prompt injection through chat into memory | proposals only; operator+ accepts; plain-text rendering; memory is the lowest authority (ADR-0010); assistant answers only through explicit markers; the summarising job fences the conversation as data | unit: answer sentences ignored; web: markup rendered as text |
| Flooding the inbox | ≤ 5 per thread per day, ≤ 5 per message, dedupe | integration: cap, rate-limited count, next day |
| Silent model calls / cost | the chat pass is deterministic; semantic dedupe only with consent (as before); the assisted summary is a job the owner submits | web: nothing fetched until clicked, no job POST |
| Drafting a summary of someone else's conversation | owner only (404), operator+ in the project (viewer 403), membership (404) | integration |
| Repudiation | per-message `memory.suggestion.propose` audit (system); accept / dismiss audited as before | integration |

Residual: the decision heuristics are language rules and will miss or over-match some sentences (proposals only, dismiss
is permanent); a person's convention for another project, written in a thread linked to this one, is proposed here (the
reviewer dismisses it); the daily cap drops rather than defers.

### 13.6 Rollback and operations

`MEMORY_CHAT_PER_THREAD_DAY=0` stops reading chat (job suggestions continue); per project, mode `off`; per user / thread,
the sharing switches. Migration 0082 is additive (a code rollback ignores the new columns and table; chat-pass rows stay
as `source = chat` suggestions the old console shows as "from a conversation"). Metrics: pass stats gain `chatMessages`
and `rateLimited` (also in the backfill response). Deploy: master + web together (the console reads the new `chat` field
and `memorySummary`, and tolerates an older master); **no worker release** (no protocol or prompt-rule change;
`suggest_memory` unchanged).

### 13.7 Tests

- `apps/master/test/unit/memory-suggestions.test.ts` — decision rule (Turkish + English, questions, casual sentences),
  person vs assistant rules, no decisions in job summaries, snippet (line choice, redaction, length).
- `apps/master/test/integration/chat-memory-suggestions.test.ts` — linked chat only (thread project, mention; private and
  unmentioned never), idempotent pass, provenance as a reviewer and as the owner, accept with provenance + audit, secret
  drop, dedupe (exact, wording, meaning with capture), daily cap, switches (thread, personal, mode, capture, delete),
  assisted prompt (owner only, viewer 403, non-member 404, fenced, redacted) and its `MEMORY:` lines coming back.
- `apps/master/test/integration/memory-suggestions.test.ts` — `suggest_memory` rows carry the provenance shape.
- `apps/master/test/integration/{rbac-matrix,route-coverage}.test.ts` — `GET /memory-suggestions/chat-prompt`.
- `apps/web/test/memory-suggestions.test.tsx` — Chat badge, "from a conversation of …", snippet as text, no link.
- `apps/web/test/semantic-knowledge.test.tsx` — "Summarise for <project> memory" only in assisted mode; opens the
  composer without submitting anything.
