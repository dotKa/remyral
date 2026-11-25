# ADR-0006: Secrets handling

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13
- **Date:** 2026-10-12
- **Related:** p3-secrets-worker, p7-secrets-scan, A-SEC-3, AGENTS.md rule 4

## Context
Provider tokens (Anthropic, OpenAI, model gateways), Git credentials and worker credentials must never appear in plaintext in the DB, logs, client JS, LLM transcripts or Git.

## Decision
1. **Control plane:** secrets the master must hold (e.g. Git App private key, notification webhooks) are stored as envelope-encrypted blobs: data key per secret, wrapped by AWS KMS (key in the control-plane account, IAM-scoped to the master role). The DB stores only ciphertext + `SecretsReferences` metadata.
2. **Runtime credentials stay on workers by default:** provider API keys / subscription logins live in the worker's OS keystore and are injected into the runtime process environment for the job only. The master stores a reference (`worker:<id>/secret:<name>`), never the value.
3. **Git access:** prefer short-lived installation tokens (GitHub App) minted by the master per job and scoped to one repository, delivered over the authenticated channel, never persisted on disk beyond the job.
4. **Redaction:** a shared redaction library (`packages/observability`) scrubs known secret values (exact match from the injected set) and secret patterns from logs, events, transcripts and artifacts before they leave the worker. The master applies the pattern pass again.
5. **Browser:** the web app never receives secret values; it can create/rotate but not read secrets.

**Amendment (ADR-0014):** runtimes may instead use the owner's worker-local subscription login; the platform never handles that credential.

**Amendment (ADR-0022):** the GitHub App connected from the panel (App Manifest flow) is stored by the master: private key, client secret and webhook secret as one AES-256-GCM blob under an HKDF sub-key of the master key file — an exception to "secrets by file reference only" for that one class. The key-file App keeps working.

**Amendment (ADR-0028):** the Coolify and Cloudflare API tokens connected in Settings → Integrations are stored by the master the same way (AES-256-GCM, HKDF sub-key `ops-integrations`, AAD per provider) and used only by the master to execute ops actions; they never reach a worker, a job or the chat assistant.

## Alternatives considered
- HashiCorp Vault — capable, but another stateful service to operate; KMS envelope encryption suffices for v1. Revisit if multi-tenant.
- Central storage of all provider keys pushed to workers — rejected by default; allowed per policy for workers without a keystore, encrypted to the worker's key.

## Consequences
Redaction cannot be perfect for unknown secrets; secret scanning (p7-secrets-scan) and bounded retention compensate.

## Verification
Canary secrets injected in tests must never appear in logs, events, DB dumps, or built JS bundles (automated check).
