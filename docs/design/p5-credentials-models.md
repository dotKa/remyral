# Design note: `p5-credentials-models` — credential vault, model catalog, per-runtime settings

> **Note (2026-10-15):** the OpenHands parts (runtime settings, base URL, request headers, `model_required`) were removed by [ADR-0023](../adr/0023-remove-openhands.md).

- **Task:** `p5-credentials-models`. Owner requirement 2026-10-14: OpenHands settings, API credentials, the
  other agents' credentials and model management must be in the panel (no physical access to the machines).
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0016 (this vault), ADR-0015 (panel-managed workers; reserved `vault` slot and
  `modelProfile`), ADR-0006 (no secret values in the master, redaction), ADR-0014 (subscription logins are
  local only; `CLAUDE_CODE_OAUTH_TOKEN` refused), ADR-0005 (device key), ADR-0011 (additive protocol),
  p3-runtime-policy (model profiles, pins), p5-rbac.
- **Out of scope:** `p5-remote-ops` (runtime install, Claude login hand-off, restart, logs).

## Shape

```
packages/protocol/src/credential-seal.ts   pure WebCrypto seal/open (browser + Node), key id, fingerprint
packages/protocol/src/credential-vault.ts  kinds, env rules, APPLY/REVOKE_CREDENTIAL, ROTATE_VAULT_KEY,
                                           CREDENTIAL_STATUS, CAPABILITIES.credentialVault, signatures
packages/protocol/src/model-catalog.ts     catalog entry schema, projection onto runtimes
packages/protocol/src/worker-config.ts     vault refs valid with `credential-vault-v1`; Claude Code / Codex
                                           `model`; report `effective.runtimes` (applied settings)
apps/master/migrations/0030_…              worker_vault_keys, vault_credentials, vault_credential_workers,
                                           model_catalog, model_defaults; cause 'catalog'; kind vault.credential
apps/master/src/vault/                     VaultService (metadata, ciphertext, delivery, reports), routes
apps/master/src/models/                    ModelCatalogService (catalog, defaults, usage, policy consistency)
apps/master/src/worker-config/service.ts   reference checks, catalog resolution into the delivered document
apps/master/src/orchestration/credential-facts.ts  placement facts (credential readiness, unusable profiles)
packages/scheduler/src/placement.ts        reasons credential_missing, model_profile_unavailable
apps/worker/src/vault/                     X25519 key store, CredentialVault (apply/revoke/rotate/report)
apps/web                                   Settings → Credentials, Settings → Models, worker Credentials and
                                           Runtimes & models tabs, composer model groups
```

## 1. Keys

The worker generates an X25519 key pair on first start (or after upgrading) in `<dataDir>/vault-key.json`
(0600, atomic, POSIX ownership/permission checks like the device keystore; on Windows the installer's ACL is
relied on, as for the device key). After enrollment it announces `{keyId, publicKey, createdAt, signature}`
in every CAPABILITIES; `signature` is the Ed25519 device-key signature over `remana-vault-key/v1\n<workerId>
\n<keyId>\n<publicKey>\n<createdAt>`; `keyId` is the first 22 base64url characters of SHA-256(public key).

The master checks `keyId` against the key and the signature against the worker's pinned device key
(`session.publicKey`), then pins it (`worker_vault_keys`, one current row per worker). Anything else is refused
and audited `vault.key.refused`. A new key is audited `vault.key.rotated` when the announcement names the
current key as `previousKeyId`, otherwise `vault.key.replaced`, and admins are notified. The panel shows the
fingerprint `X25519:XXXX-…`; `remyral-worker vault key` prints the same on the machine.

Rotation from the panel (`POST /vault/workers/:id/rotate-key` → ROTATE_VAULT_KEY): the worker generates a new
key and keeps exactly one previous key, so values sealed just before the rotation still open. Values already
stored stay in the secret store — rotation never requires re-entering credentials.

## 2. Sealing (browser)

`sealCredential(value, workerPublicKey, binding)`:

- ephemeral X25519 key pair; `shared = X25519(eph, worker)`;
- `key = HKDF-SHA256(shared, salt = epk ‖ workerPublic, info = "remana-credential-seal/v1")` → AES-256-GCM;
- `ct = AES-GCM(key, iv = 12 random bytes, aad = "remana-credential-seal/v1\n" + workerId, credentialId,
  version, keyId, kind, env)`.

Tampering, another worker's key, another credential id, version, kind or env all make opening fail with one
undifferentiated error. The page feature-detects X25519 and refuses with a clear message when the browser lacks
it (current Chrome/Edge 133+, Firefox 130+, Safari 17+ have it). The value field is cleared right after sealing.
The web bundles only `@remyral/protocol/credential-seal` (no zod, no Node), resolved from source by Vite.

## 3. Master: metadata and ciphertext

`vault_credentials` holds metadata only; `vault_credential_workers` holds, per worker, the desired version, the
key id it was sealed to, the ciphertext and its digest — or `revoked` with the ciphertext set to NULL (a CHECK
enforces that only active rows hold ciphertext). Routes (admin; writes need step-up, CSRF; audited; notified):

| Route | Effect |
| --- | --- |
| `GET /vault/workers` | workers, vault support, pinned key + fingerprint |
| `GET /vault/credentials` | metadata and per-worker status (`pending`, `applied`, `rejected`, `needs_reseal`, `revoking`, `revoked`, `unsupported`), last use |
| `POST /vault/credentials` | create from per-worker ciphertext (version 1) |
| `PUT /vault/credentials/:id/value` | rotate: version + 1 sealed for the listed workers; unlisted workers lose it |
| `POST /vault/credentials/:id/unshare` | remove from workers |
| `DELETE /vault/credentials/:id` | revoke everywhere, erase every ciphertext |
| `POST /vault/workers/:id/rotate-key` | ROTATE_VAULT_KEY |

Validation: id `[a-z0-9][a-z0-9_-]{0,47}` (the worker stores it as secret `vault-<id>`), kind from a closed
list, env not a forbidden variable (subscription token, `NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, …), name and
description secret-scanned, each ciphertext schema-valid and sealed to that worker's **currently pinned** key
(`key_mismatch` otherwise), worker approved and advertising `credential-vault-v1`. No response schema has a
field for a value or a ciphertext; the master never decrypts anything.

## 4. Delivery and acknowledgement

APPLY_CREDENTIAL / REVOKE_CREDENTIAL are control messages (like APPLY_WORKER_CONFIG): the desired state lives
in Postgres and is re-sent after every write, on CAPABILITIES when the worker's report shows another version,
and never for a version the worker refused. Each is signed with the master lease key over
`remana-credential-delivery/v1\n<op>\n<worker>\n<credential>\n<version>\n<digest|->\n<issuedAt>`; the digest
covers kind, env and ciphertext.

Worker order of checks: `stale` (older than held, or ≤ tombstone) → `unchanged` → `version_conflict` (same
version, other digest) → `not_enrolled` → signature (`unsigned` / `bad_signature`; no keys at all = accepted
with a warning, as for worker configuration) → `unknown_key` (neither the current nor the previous key) →
`open_failed` → `subscription_token` / `invalid_value` → store as `vault-<id>` → `applied`. Revocation deletes
the value and records a tombstone. CAPABILITIES.credentialVault reports id, version, kind, env, applied and
last-use time per credential and the tombstones — never a value. Refusals are audited
(`vault.credential.rejected`) and notified; `unknown_key` / `open_failed` show as **needs re-seal** (re-enter
the value).

`remyral-worker secret set vault-*` is refused (reserved prefix). A secret-store wrapper records the last
time a job read a vault credential.

## 5. Model catalog and unification with runtime policies

`model_catalog` holds profiles: id, display name, runtimes, provider, model, optional base URL (OpenHands
LiteLLM), optional `credentialRef`, params (same shape as a runtime-policy profile), limits and pricing hints,
enabled. Secret-scanned like policy profiles. `model_defaults` holds defaults per runtime, globally or per
project; the composer preselects them.

**One concept, two projections — no duplicate model registry:**

- A runtime-policy profile **named like a catalog id is that catalog entry projected onto the runtime**. The
  master refuses a policy version whose such profile is disabled (`catalog_profile_disabled`), not offered
  for that runtime (`catalog_runtime_mismatch`) or disagrees on provider/model (`catalog_mismatch`). The
  Models page lists which policies use each profile and whether they are in sync; rolling a catalog change
  into a policy stays the policy's staged (canary) rollout. Policy profiles with non-catalog names keep
  working (backward compatible).
- A worker configuration's `runtimes.<kind>.modelProfile` names a catalog id (or, as before, a policy profile
  name). The master **resolves** it when it builds the delivered document: OpenHands `llm.provider/model/
  baseUrl`, Pi `provider`/`model`, OpenCode `model`, Claude Code / Codex `model` — explicitly set values win —
  and, when the runtime's auth is unset, the profile's `credentialRef`. The spec keeps only the reference.
  Every catalog change re-resolves the affected workers (new generation, cause `catalog`). Deleting a profile
  that a worker configuration or a default uses is refused (`in_use`); disabling is allowed and placement
  explains it.
- The composer's model list per runtime = policy profiles of the eligible workers' effective policies (value =
  profile name, catalog metadata attached) plus enabled catalog profiles for workers whose policy defines no
  profiles for the runtime (value = the runtime model id). Pricing, limits and defaults are shown.

## 5a. Job model profiles and request headers (p5-openhands-model-headers)

Live finding (2026-10-15): an OpenHands job failed with "OpenHands needs a LiteLLM model name" — catalog defaults
were only shown in the composer, never applied — and Claude Platform on AWS needs a header
(`anthropic-workspace-id`) next to the normal Anthropic key.

- **Request headers.** A catalog entry may carry `headers` (non-secret; `llm-headers.ts`): RFC 7230 token names,
  values without control characters (no CR/LF injection), at most 10, case-insensitive duplicates and
  credential-like names refused (`credential_header`: authorization, proxy-authorization, cookie, set-cookie,
  x-api-key, api-key, apikey, and names containing KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|
  SIGNATURE — the worker's credential-looking env pattern). Values are secret-scanned like other leaves. OpenHands
  only (`unused_for_runtimes` otherwise): it is the one runtime with a documented way to send extra headers
  (SDK `LLM.extra_headers`, verified in the installed 1.54.0 `openhands/sdk/llm/llm.py` and forwarded by LiteLLM
  through `apply_extra_headers`). They resolve into a worker document's `runtimes.openhands.llm.headers` only for
  `model-profile-v1` workers (older ones would strip the key and fail the hash); otherwise placement says
  `model_profile_unavailable`. Workers report header names only (`effective.runtimes.openhands.llmHeaders`).
- **Job model profiles.** At submission (`JobStore.create`, every path: REST, chat, workflows, schedules,
  interactive sessions) the master resolves the job's catalog profile — the enabled catalog id named in
  `spec.model`, else the project default, else the global default for the runtime — into `JobSpec.modelProfile`
  `{id, model, baseUrl?, headers?, credentialRef?}` (a submitter's value is discarded). `model` is the runtime's
  model string (`catalogModelFor`: Pi / OpenCode / OpenHands `provider/model` unless the model contains `/`).
  `spec.model` stays the id, so a worker whose runtime policy has profiles resolves it as the policy profile of
  that name; a worker without profiles uses `modelProfile.model`. The worker passes `baseUrl` / `headers` to
  OpenHands per job (`SpawnContext.job.llm`: the job's profile decides, its absent base URL means the provider
  default) and uses the profile's `credentialRef` as the runtime auth of that job (`secret:vault-<id>` or
  `secret:<name>`, env = the reference's, else the runtime default). The composer's catalog options now carry the
  catalog id as value. Placement: only `model-profile-v1` workers (`model_profile_unavailable`), and for a vault
  credential only workers holding its current version (`credential_missing`, permanent).
- **Runtimes without a model of their own** (`RUNTIMES_REQUIRING_MODEL` = OpenHands). A job that resolves no model
  needs a worker default: the worker's reported effective model, its delivered configuration's model, or profiles
  in its effective runtime policy. Placement reason `model_required` (permanent; not predicted for workers without
  a configuration report), the composer preview's `model.missing` ("Needs a model profile — Settings → Models"),
  submission refused with 400 `model_required` when no enrolled worker can supply one, and the worker's runtime
  gate refuses before starting (`model_required`). Runtime-policy profiles now give OpenHands `provider/model` as
  well (it was the bare model id). Claude Code, Codex, Pi and OpenCode keep their own default model.
- **Security.** Headers are configuration, never credentials: refused at every layer (web form, master catalog
  and worker-config validation, `JobSpec` schema on the worker, adapter re-check) and never logged as values in
  audit (`model.profile.*` records header names). A job's credential is a reference resolved in the worker's own
  store, exactly like runtime auth. No migration (headers live in the catalog entry JSON).

## 6. Per-runtime settings, applied settings, placement

The Runtimes & models tab validates each runtime with its own schema (protocol `WorkerRuntimeSettings`):
Claude Code — local login or API key (worker secret or vault), model profile / model; Codex — same; Pi and
OpenCode — provider and model (OpenCode options with `{env:NAME}` references only); OpenHands — profile +
credential (no local login), LLM provider/model/base URL, LiteLLM options, `maxIterations`, confirmation policy
fixed to `always-confirm` (ADR-0013). Claude Code / Codex `model` and vault refs need `credential-vault-v1`; the
master refuses them for older workers (`worker_update_required`) because an older worker would strip the
field and reject the document's hash.

The worker reports what it actually applied (`effective.runtimes`: auth mode, source, credential name/id, env,
whether the credential is present, profile, model, provider, base URL, iterations, pinned) and the panel shows
it next to the desired values.

Placement (`Orchestrator.candidates`, composer preview):

| Code | Permanent | When |
| --- | --- | --- |
| `credential_missing` | no | the runtime's vault credential is shared with the worker but not yet acknowledged |
| `credential_missing` | yes | not shared with the worker, revoked, refused, or the worker has no vault |
| `model_profile_unavailable` | yes | the worker's configured catalog profile, or the job's requested one, is disabled or not offered for the runtime; the job carries a profile and the worker lacks `model-profile-v1`; the worker's profile has headers its build cannot send or its delivered configuration predates |
| `model_required` | yes | the job's runtime has no model of its own (OpenHands), the job resolved no profile and the worker has no default model for it |

## 7. Security review

- **Browser as trust root.** Confidentiality of a value rests on the administrator's browser and the
  JavaScript it runs at the moment of entry. A compromised master or web host that ships malicious panel
  JavaScript (e.g. an injected `fetch` of the value, or substituting its own public key for a worker's) can
  capture values typed **after** the compromise. Mitigations: CSP `default-src 'self'; script-src 'self'` with
  no inline script and `connect-src 'self'` (an injected script cannot load or post off-origin through the
  page's own policy), content-hashed immutable bundles from a separate static image, fingerprints shown for
  out-of-band comparison with `remyral-worker vault key`, every vault write audited and notified. **SRI is not
  applied:** the bundles are same-origin and served by the same host as `index.html`, so an attacker able to
  alter the bundle can alter the integrity attribute too; SRI would only help with a separate CDN, which we do
  not use. **Residual risk accepted:** a panel-code compromise exposes values entered during the compromise;
  stored values remain unreadable to the master.
- **Master / database compromise.** Yields ciphertext and metadata only. An attacker could seal a value of
  their choosing (integrity) or swap a runtime's credential reference; both are audited and notified, and the
  worker verifies the lease-key signature (pin `masterLeaseKeys` to protect against a TLS-terminating proxy).
  A forged vault key cannot be pinned without the worker's device key.
- **Worker key theft.** Whoever reads `vault-key.json` (root on the machine) can open ciphertext sealed to that
  key — but such an attacker can read the secret store directly anyway. Ciphertext is erased on the master once
  superseded or revoked, limiting what a later key thief could open from a database dump. Response: rotate the
  key from the panel and rotate the affected provider keys.
- **Replay / downgrade.** Versions are monotonic per credential on the worker; tombstones refuse re-delivery
  of revoked versions; same-version different-digest is refused; the AEAD binding prevents re-targeting a
  ciphertext to another worker, credential, version, kind or env; signatures bind op, worker, credential,
  version and digest.
- **Code injection through a "credential".** Target env vars that change how processes load code are refused
  on the master and by the protocol schema on the worker.
- **Subscription tokens (ADR-0014).** `sk-ant-oat…` values are refused in the browser and again by the worker
  after opening; `CLAUDE_CODE_OAUTH_TOKEN` is never a target.
- **Redaction.** Values are registered with the worker's exact-value redactor when injected (existing secret
  path); tests assert no value in master logs, DB rows (credentials, deliveries, audit, outbox, notifications),
  API responses, worker logs, the vault index or the report.
- **Step-up.** Vault writes are in the account-security **always-fresh** class (p5-stepup-window): a TOTP
  from the last 10 minutes on every session type, including remember-me / trusted-device sessions
  (`ALWAYS_FRESH_ROUTES`). Catalog writes use the standard step-up window. There is no reveal route at all.

## Rollback

- Migration 0030 is additive (new tables, two widened CHECKs). An older master ignores the tables; older
  workers never receive vault messages (feature-gated) and keep worker-store secrets.
- A bad credential: rotate or revoke in Settings → Credentials. A bad profile: edit or disable it (workers are
  re-resolved). Worker side: deleting `vault.json` makes the master re-deliver; deleting `vault-key.json` makes
  the worker create a new key (`replaced`) and values must be re-entered.

## Operational metrics

Per credential and worker: status, acknowledged version, last delivery, last use. Audit: `vault.key.*`,
`vault.credential.*`, `model.profile.*`, `model.default.set`. Master logs `vault credentials sent`, `vault
credential status`; placement reasons `credential_missing`, `model_profile_unavailable`.

## Tests

`packages/protocol/test/credential-vault.test.ts`; `packages/scheduler/test/placement.test.ts`;
`apps/worker/test/vault.test.ts`, `vault-live.test.ts`, `vault-cli.test.ts`, `managed-config.test.ts`;
`apps/master/test/integration/vault.test.ts` (ciphertext only), `vault-e2e.test.ts` (real worker),
`models.test.ts`, RBAC matrix and route coverage; `apps/web/test/credentials.test.tsx`,
`worker-config.test.tsx`, `composer.test.tsx`.
