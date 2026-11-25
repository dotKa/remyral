# ADR-0016: Panel credential vault sealed end-to-end to each worker

- **Status:** Accepted — owner requirement, 2026-10-14: "OpenHands ayarları, API credential'lar, diğer
  agentların credential'ları, model yönetimi vs. de panelde olmalı." (OpenHands settings, API credentials, the
  other agents' credentials and model management must also be in the panel.) **Partially superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands was removed; the OpenHands settings and the model-profile base URL and request headers no longer apply).
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-credentials-models`
- **Amends:** ADR-0006 §2 (where a provider credential may come from), the reserved `credentialRef.source =
  "vault"` slot of ADR-0015. ADR-0005, ADR-0011, ADR-0014 are unchanged and binding.
- **Related:** `p5-credentials-models`; design note docs/design/p5-credentials-models.md; ops doc
  docs/ops/credentials-and-models.md

## Context
ADR-0006 keeps provider credentials on the worker: an operator types `remyral-worker secret set` on each
machine, and the master only ever holds references. The owner will not have physical or shell access to the
seven machines (ADR-0015), so credentials — like the rest of a worker's configuration — must be manageable
from the panel. AGENTS.md rule 4 still holds: never store plaintext provider tokens in the database or logs.
Anthropic's terms (ADR-0014) forbid the platform to collect, store or relay Claude subscription credentials.

## Decision
1. **Every worker owns an X25519 vault key.** It is generated at first start (or on upgrade) and kept in the
   worker's private data dir (`vault-key.json`, 0600, same checks as the device key). The public half is
   announced in CAPABILITIES, **signed by the worker's Ed25519 device key** and bound to its worker id. The
   master verifies the signature against the device key it pinned at pairing, then **pins the vault key per
   worker** and shows its fingerprint (`X25519:` + SHA-256). A different key later is recorded, audited and
   notified as `rotated` (continuity: the announcement names the replaced key) or `replaced` (no continuity,
   e.g. a wiped data dir).
2. **The administrator's browser is where a value is encrypted.** It seals the value separately to each
   selected worker's pinned key (ephemeral X25519 → HKDF-SHA256 → AES-256-GCM, WebCrypto only, no new
   dependency) with the worker id, credential id, version, key id, kind and target env var bound as AEAD
   additional data. The browser refuses Claude subscription tokens (`sk-ant-oat…`) before sealing.
3. **The master stores and relays ciphertext only.** It keeps credential metadata (id, name, kind, env,
   version, state) and per-worker ciphertext; no route accepts, returns or logs a value. Ciphertext is deleted
   as soon as a version is superseded for that worker or revoked. Writes are admin + always-fresh step-up + CSRF, audited
   and notified (`vault.credential`).
4. **Delivery** is `APPLY_CREDENTIAL` / `REVOKE_CREDENTIAL` (control messages, additive in protocol 1.0, sent
   only to workers advertising `credential-vault-v1`), signed by a master lease key over the operation,
   worker, credential, version and a digest of kind + env + ciphertext. The master re-sends whenever a
   worker's CAPABILITIES show another state, except a version the worker refused.
5. **The worker** verifies the signature (pinned `masterLeaseKeys` if configured, else the session's keys),
   refuses stale or conflicting versions and revoked tombstones, opens the value with its key (current or the
   one previous key), refuses subscription tokens, stores it in its **existing secret store** as
   `vault-<id>` and answers `CREDENTIAL_STATUS` with id and version — never the value. Revocation deletes it
   and keeps a tombstone.
6. **Write-only.** A credential can be rotated (new version, value re-entered), removed from workers or
   revoked, never revealed. Adding a worker to a credential means re-entering the value (the master cannot
   re-encrypt).
7. `credentialRef.source = "vault"` is valid for workers advertising `credential-vault-v1`; the master refuses
   it for others (`worker_update_required`) and refuses references to unknown, revoked or unshared
   credentials. `CLAUDE_CODE_OAUTH_TOKEN` and code-loading variables (`NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, …)
   are refused as target env vars everywhere.

## Alternatives considered
- **Master-side encryption at rest (KMS or a master key)** — rejected: the master (and anyone who compromises
  it) could decrypt every credential; the owner's requirement is that a panel compromise must not leak keys.
- **Seal on the master to the worker key** — rejected: the plaintext would transit and live in master memory
  and request logs.
- **P-256 ECDH instead of X25519** — not needed: X25519 is in WebCrypto in every current evergreen browser
  (Chrome/Edge 133+, Firefox 130+, Safari 17+); the panel detects support and refuses clearly otherwise. Using
  the same primitive in Node and the browser keeps one implementation (`@remyral/protocol/credential-seal`).
- **A JS crypto library (libsodium, tweetnacl)** — rejected: a new dependency in the trust-critical bundle
  where WebCrypto already provides vetted primitives.
- **Derive the X25519 key from the Ed25519 device key** — rejected: key separation; the device key's only job
  is authentication and its rotation (ADR-0005) must not silently change the vault key.

## Consequences
- Migration 0030; new routes `/vault/*` (`vault.read`/`vault.write`, admin) and the worker `vault` module;
  Settings → Credentials; worker configuration's Credentials tab can select vault credentials.
- **Trust root is the administrator's browser and the panel JavaScript it runs.** A compromised master that
  serves malicious JavaScript can read values typed afterwards. Mitigated by the strict CSP (`script-src
  'self'`, no inline script), hashed immutable bundles and the web image being served separately from the
  master; residual risk accepted and documented (design note §7).
- A compromised master cannot read stored credentials but can **replace** them (seal its own value) or point a
  runtime at another vault credential: integrity, not confidentiality, is at risk; every change is audited and
  notified.

- p5-openhands-model-headers (2026-10-15): a model profile's `credentialRef` may also travel in a job
  (`JobSpec.modelProfile.credentialRef`, a reference resolved in the worker's own store, replacing the runtime's
  auth for that job); placement requires the vault credential's current version on the worker. Model profiles
  may carry non-secret request headers (OpenHands); credential-like header names are refused at every layer, so
  this ADR's rule — values only through the sealed vault or the worker store — still holds.

## Verification
Protocol tests (seal/open, tamper, wrong worker key, re-targeted binding, signatures); worker tests (apply,
ack, stale/replay, version conflict, revoke + tombstone, key rotation keeps the previous key, unsigned with
pinned keys, subscription token refused, no value in logs/index/report); master integration tests (ciphertext
only — no plaintext in DB rows, logs, audit, notifications or responses; signed delivery; re-delivery;
step-up; RBAC matrix; placement readiness) and a real-worker end-to-end test; web tests (sealing in the
browser, request bodies without plaintext, subscription-token refusal).
