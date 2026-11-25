# Credentials and models from the panel

How to give runtimes on remote workers an API key and a model without touching the machines
(p5-credentials-models, ADR-0016). Background and security review: docs/design/p5-credentials-models.md.

## Requirements

- Workers on a release that advertises `credential-vault-v1` (Settings → Credentials shows "vault ready" and a
  key fingerprint per worker; older builds show "update the worker").
- An owner/admin account with an authenticator (every write asks for step-up).
- A current browser with X25519 in WebCrypto (Chrome/Edge 133+, Firefox 130+, Safari 17+). The page says so if
  yours is not.

## Add a credential

1. Settings → Credentials → **Add credential**.
2. Fill in an **id** (`[a-z0-9_-]`, e.g. `openrouter-team`; the worker stores it as secret `vault-<id>`), a
   name, the **kind** (anthropic, openai, openrouter, gemini, custom-openai-compatible, github-token, generic)
   and the **env var** it is injected as (pre-filled per kind).
3. Tick the **workers** that should get it. Optionally compare each worker's fingerprint with
   `remyral-worker vault key` on that machine (first time, or after a "vault key changed" notification).
4. Paste the value and save. The browser encrypts it separately for each worker; the master never sees it.
   Claude subscription tokens (`sk-ant-oat…`) are refused — use local login for subscriptions (ADR-0014).
5. Watch the per-worker status turn **applied**. `needs re-seal` means the worker's key changed: enter the
   value again (Replace value).

## Use it

- Machines → <machine> → Configuration → **Credentials**: choose "Vault credential" for a runtime and pick it. The
  credential must be shared with that worker, otherwise saving is refused (`credential_not_shared`).
- Or put a `credentialRef` on a model profile (Settings → Models); runtimes using that profile without their
  own auth get it automatically.
- Jobs can reference it as `secret:vault-<id>` in `secretRefs`; the project's environment rules decide (a vault
  credential needs no `secret expose` on the machine — that applies only to secrets stored locally on the worker,
  [worker-secrets.md §3a](worker-secrets.md#3a-let-jobs-ask-for-a-secret-by-name-secret-expose)).

## Rotate, share, revoke

- **Replace value** = new version, sealed for the workers you tick; workers you untick lose it.
- **Add a worker** = Replace value with that worker ticked (the master cannot re-encrypt an existing value).
- **Remove from worker** deletes it there; **Revoke** deletes it everywhere and erases all ciphertext.
- **Rotate worker key** (per worker) makes the worker generate a new vault key; stored values stay valid.
- Values are write-only: there is no way to display one again.

## Chat

(p15-chat-vault, [design](../design/p15-chat-vault.md).) A key pasted into Sohbet never leaves the browser: the field
shows a `{{secret:pasted-N:…}}` badge and a warning. Administrators click **Kasaya kaydet** (name such as
`OPENAI_API_KEY`, kind *HTTP kimlik doğrulama* with the API host / *API anahtarı* / *genel*, machines) — the value is
sealed in the browser exactly like the form above and the badge becomes `{{credential:NAME}}`. Saying "bunu kasaya
kaydet" after a paste gives a card that the same tab completes. `@NAME` mentions credentials (admins only; name, kind and
hosts — never a value). "@NAME ile şu endpoint'e istek at" runs `run_http_request`: one function job on a machine that
holds the credential (an **HTTP kimlik doğrulama** credential bound to that host; the project's HTTP allowlist applies),
the response comes back redacted. Credentials of the API-key kind are for agent runtimes and are refused for requests —
save the key as HTTP kimlik doğrulama for that.

## Models

Settings → Models: create profiles (runtimes, provider, model, optional
credential, limits and pricing hints), enable/disable them, and set defaults per runtime (global or per
project). Use a profile in Machines → <machine> → Configuration → Runtimes & models. A runtime policy may contain a
profile with the same name only if it matches the catalog entry; changing a profile re-delivers every worker
configuration that uses it. The tab shows what each worker actually applied.

### Which model a job uses

1. The profile chosen in the composer (or the catalog id in the job's `model`).
2. Otherwise the **default** for the job's runtime: the project default, else the all-projects default
   (Settings → Models → Defaults).
3. Otherwise the worker's own default: its runtime settings (Machines → <machine> → Configuration) or its runtime
   policy's profiles; else the runtime's own default model.

With 1 or 2 the master attaches the profile to the job: the model as the runtime expects it (Pi and OpenCode get
`provider/model`, e.g. `anthropic/claude-opus-5-5`; a model that already contains `/` is kept) and the profile's
credential, which replaces the runtime's configured auth for that job. Such jobs run only on workers that
advertise `model-profile-v1`.

OpenHands, the only runtime without a model of its own, was removed on 2026-10-15
([ADR-0023](../adr/0023-remove-openhands.md)) together with the OpenHands-only profile fields (base URL, request
headers) and `model_required`. Profiles that served only OpenHands were archived by migration 0042
(`retired_model_profiles`); OpenHands defaults were deleted.

## Troubleshooting

| Symptom | Meaning / fix |
| --- | --- |
| job waits with `credential_missing` (not permanent) | delivery pending: worker offline or not yet acknowledged |
| `credential_missing` (permanent) | not shared with that worker, revoked or refused — check Settings → Credentials |
| `model_profile_unavailable` | profile disabled or not offered for that runtime; or the worker build predates `model-profile-v1` (update it) |
| 400 `runtime_removed` | the job, default or profile names OpenHands, which was removed (ADR-0023) — pick another runtime |
| status `rejected: bad_signature` / `unsigned` | the worker pins other master lease keys (`masterLeaseKeys`) |
| status `needs re-seal` | worker key changed or was lost; enter the value again |
