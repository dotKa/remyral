# p15-chat-vault — vault credentials from the Sohbet chat

- **Owner request (2026-10-22):** "Chat'e API anahtarını kasaya kaydetme özelliği kazandıralım. Chat'e yapıştırılırsa
  yine bilgilendirmemizi yaparız, isterse kasaya kaydedebileceğimizi söyleriz ve kasaya kaydedip credential'ı değişken
  ismiyle badge gibi etiketli şekilde ifade ederiz. Hatta sohbette '@ ile credential'ı kullanarak istek oluştur, at' gibi
  yönergeler de verebiliriz."
- **Binding decisions:** ADR-0016 (values sealed in the browser to worker vault keys; the master cannot decrypt),
  ADR-0006 (no plaintext secrets in DB / logs), ADR-0055 §5 (function jobs: the master never opens the connection),
  ADR-0056 + p15-chat-execute-default (the user's command acts at once).
- **Migration:** 0134 (chat_drafts kinds `http_request`, `credential_save`). **Worker release:** yes (assistant tool
  schemas and prompt rule 32); no new function type, no protocol message change.

## 1. Tokens

`@remyral/protocol/chat-secrets` (pure; browser and master):

| Token | Meaning |
| --- | --- |
| `{{credential:NAME}}` | a vault credential, NAME = its name (variable style, `OPENAI_API_KEY`) |
| `{{secret:pasted-N:provider}}` | a value the user pasted and has not saved; only that browser tab holds it (memory, ≤ 30 min) |
| `{{secret:removed:rule}}` | a value the master removed from a message; unrecoverable |

`detectSecrets` knows vendor prefixes (OpenAI, Anthropic incl. subscription tokens, OpenRouter, GitHub, GitLab, Google,
Slack, Stripe, Hugging Face, npm, AWS key ids, JWT, PEM keys), bearer values and `key=value` assignments; a single random
token counts only as a whole paste. Provider facts give the suggested name, the API host and the header.

## 2. Paste flow (browser)

1. Composer `onPaste`: the pasted text is scanned; each value is kept in `pastedSecrets` (tab memory) and the field gets
   its `{{secret:pasted-N:…}}` token. A subscription token is never kept (`{{secret:removed:subscription}}`).
2. The warning (today's information, now in the composer) names what it looks like and offers **Kasaya kaydet** to
   administrators (the vault is admin-only; others are told so).
3. `SaveSecretPanel`: name (provider-based, free), kind (HTTP kimlik doğrulama + allowed hosts prefilled from the
   provider / API anahtarı = the provider's runtime kind / genel), machines (vault key; function-v1 for http-auth). It
   seals with the existing `sealForWorkers` and `POST /vault/credentials` (always-fresh step-up) — the same path as
   Settings → Credentials. The token becomes `{{credential:NAME}}`, the tab forgets the value.
4. On send, the whole text is scanned again (typed secrets), so nothing secret-looking leaves the page.

## 3. Master

- `scrubUserText` on every user message before it is stored, published, titled, searched or given to a model (protocol
  detector + the platform Redactor; our own tokens are never re-redacted). `meta.secretsRemoved` counts it.
- `{{credential:NAME}}` tokens → `meta.credentials` chips (name, id, kind, hosts, machine count) and a fenced metadata
  block for the model; only for `vault.read` users (admins), otherwise names only. `@credential` mentions (type
  `credential` in `GET /chat/mentions` and `MentionRef`) the same way.
- `run_http_request` (draft kind `http_request`, execute-default): `jobs.create` on the project, `vault.read` when a
  credential is used, the credential must be `http-auth` and bound to the URL's host; headers that carry credentials and
  secret-looking values are refused; the spec is built by the workflow HTTP builder (`buildFunction`: egress policy,
  host binding) and submitted as a function job. A direct run waits ≤ 40 s (under the worker's 60 s tool timeout) and
  returns the response (body preview ≤ 8 000 chars, redacted on the worker — exact credential value — and again here);
  otherwise `http_request_result` reads it (only the caller's own chat requests). Event: `workflows.privileged` with a
  credential, `chat.cards` without.
- `propose_credential_save` (draft kind `credential_save`, `ASSISTANT_BROWSER_TOOLS`): never executed by the master
  (direct path skips it; confirm answers 409 `browser_only`). The card (`CredentialSaveCard`) runs the same panel with the
  value from the tab (or a password field), then `POST /chat/drafts/:id/credential-saved {credentialId}` (vault.write;
  the caller's own open card; the credential must be active and created by the caller) marks it done, audits
  `chat.draft.confirm via browser` and notes `{{credential:NAME}}` in the thread.
- `GET /vault/workers` gains `functionSupported` (additive).

## 4. Security review

- Plaintext never reaches the master on the save path (browser seals; request bodies carry ciphertext only — web test
  opens the ciphertext with the worker key and checks no request contains the value).
- Raw values in messages: replaced in the browser and again on the master; integration test greps `chat_messages`,
  `chat_threads`, `chat_turns`, `audit_events`, `notifications` and the model input for the value.
- Requests: credential attached only by the worker for its bound hosts (unchanged executor); exact-value redaction of an
  echoing server is tested; no value in jobs, drafts, artifacts, audit.
- Residual: the master scrub sees a raw value when a client does not replace it (unavoidable; it is not logged or
  stored). A model can still choose an allowed host the user did not mean — bounded by the credential's host list and
  the project's HTTP allowlist.
- Credentials stay global (no project scope) — the vault's sealing model is per machine; "scope" in the panel = machines.

## 5. Tests

`packages/protocol/test/chat-secrets.test.ts`, `apps/web/test/chat-vault.test.tsx` (paste → token → save → sealed body,
typed secret, mention autocomplete, chips), `apps/master/test/integration/chat-vault.test.ts` (redaction everywhere,
token chips/blocks, mentions RBAC, run_http_request on a real function-v1 worker with a credential, refusals, the
browser-completed save card).
