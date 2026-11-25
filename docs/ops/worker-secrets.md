# Runbook: provider credentials on a worker

- **Applies to:** `remyral-worker` (`apps/worker`), ADR-0006 (secrets stay on the worker), task `p3-secrets-worker`
- **Audience:** the owner, on each worker machine, as the worker's OS user
- **Design:** [docs/design/p3-workspace-and-secrets.md](../design/p3-workspace-and-secrets.md)

Provider API keys (Anthropic, OpenAI, model gateways) are stored **on the worker** and injected into the
runtime process only for the duration of a job. The master and the console only ever see a reference
such as `secret:anthropic` (fully qualified: `worker:<workerId>/secret:anthropic`). Subscriptions are
used through the runtime's own login on that machine (`local-login`) — the worker never touches that
credential.

## 1. Choose a store (worker config `secretStore`)

| Value | Where values live | Platform status |
| --- | --- | --- |
| `file` (default) | `<dataDir>/secrets/<name>.json`, directory 0700, files 0600; refused if permissions are looser, a file is a symlink or owned by someone else | Verified on macOS; Linux same code path; Windows ACLs are the installer's job (UNVERIFIED) |
| `macos-keychain` | Generic passwords, service `remyral-worker`, account = name, in the default keychain or `keychainPath` | Verified on macOS (real `security`, temporary keychain) |
| `windows-dpapi` | `<dataDir>/secrets-dpapi/<name>.dpapi`, DPAPI blob (CurrentUser) via PowerShell | **UNVERIFIED** — tested with a fake PowerShell only |

A store that does not exist on the platform fails closed (exit 78). Keychain: a daemon that runs outside
the user's login session (LaunchDaemon) cannot use the login keychain; create a dedicated keychain and set
`"keychainPath"` (it must be unlocked when the worker starts — e.g. `security unlock-keychain` in the
service wrapper), or stay with `file`.

## 2. Store a key

Run as the worker's OS user (the same user the service runs as):

```sh
remyral-worker secret set anthropic            # prompts; input is not echoed
printenv ANTHROPIC_KEY_FROM_VAULT | remyral-worker secret set anthropic --stdin
remyral-worker secret list                     # names only
remyral-worker secret rm anthropic
```

- Never pass the value as an argument (it would be in shell history and `ps`); the CLI refuses it.
- `--stdin` removes one trailing newline. Values must be 6–16384 characters (shorter values cannot be
  redacted safely). Names: `[A-Za-z0-9_-]`, up to 64 characters.
- `--data-dir <dir>` uses the file store in that directory; otherwise `--config`/the default config
  selects the store.
- Rotation = `secret set` again. Running jobs keep the value they were started with.

## 3. Wire a runtime to it (worker config `runtimeAuth`)

```json
{
  "runtimeAuth": {
    "claude-code": { "mode": "secret-ref", "ref": "secret:anthropic" },
    "codex": { "mode": "secret-ref", "ref": "secret:openai" },
    "opencode": { "mode": "secret-ref", "ref": "secret:anthropic", "env": "ANTHROPIC_API_KEY" },
    "pi": { "mode": "local-login" }
  }
}
```

- `secret-ref` injects the value as `env` (defaults: Claude Code `ANTHROPIC_API_KEY`, Codex
  `CODEX_API_KEY`; OpenCode and Pi need `env`). `CLAUDE_CODE_OAUTH_TOKEN` is
  refused as a target: subscription tokens are never stored or injected by the platform.
- `local-login` uses the login you performed interactively **as the worker's OS user** on this machine
  (e.g. log in once with `claude` → `/login`, `codex login`, `opencode auth login`). The worker passes only
  `HOME`, `USER`, `LOGNAME` (+ Windows profile variables) and the runtime's config-dir variable
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`/`XDG_CONFIG_HOME` for OpenCode) so the runtime finds
  its own credentials; it never reads, copies, logs or transmits them. On macOS the runtime must run in
  the user's session for its login keychain to be reachable.
- A job's runtime gets a **minimal environment**: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
  `LC_ALL`, temp/TZ and Windows essentials, plus the injected secret. Nothing else of the worker's own
  environment is inherited — keys exported in the service's environment do not reach jobs.

## 3a. Let jobs ask for a secret by name (`secret expose`)

A job (`spec.secretRefs`, e.g. from the composer API or an automation) or a service (`secretEnv`) may name one of
this machine's secrets, `secret:<name>`. Since that request comes from the panel — any operator of a project — the
worker injects such a secret **only when you exposed it to jobs** on this machine; by default nothing is exposed.

```sh
remyral-worker secret expose gateway                    # jobs of every project on this machine
remyral-worker secret expose gateway --project acme     # only jobs / services of project acme (repeatable)
remyral-worker secret unexpose gateway
remyral-worker secret list                              # "gateway  (jobs: acme)"
```

- The list lives in `<dataDir>/job-secrets.json` (0600, owner only; a looser file exposes nothing and the worker logs
  why). It is read at every job start, so no restart is needed. Older worker versions ignore it.
- `runtimeAuth` keys (section 3) are the worker's own use and need no exposure — and normally should not be exposed.
- A reference that is not exposed is not injected; the job still runs, and its timeline says which variable was not
  set (the variable name only). A service with such a reference fails to start with the same explanation.
- Panel vault credentials (`vault-*`) cannot be exposed here: the master decides those per project
  (Projects → Policy → Environment variables).

## 4. What protects the value

- Read only at spawn time; registered for exact-value redaction (incl. URL/JSON/base64 encodings) in
  every log line, event and LOG_CHUNK before it is queued for the master; token patterns
  (`sk-ant-…`, `ghp_…`, `…TOKEN=…`) are redacted as well, which also covers a local-login runtime that
  prints its own token.
- The pre-push scan refuses a push whose commits contain an injected value or a known token pattern.
- Not protected: a runtime or agent running as the same OS user can read the value from its own
  environment, and any process of the worker user can read the store. Isolation between the agent and the
  worker user is `p3-sandbox` (dedicated user / container, ADR-0007).

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `secret "anthropic" is not stored in …` when a job starts | `remyral-worker secret set anthropic` as the worker user (same `dataDir`/keychain as the service). |
| `refusing to use …/secrets: writable by group or others` | `chmod 700 <dataDir>/secrets; chmod 600 <dataDir>/secrets/*.json` |
| `security find-generic-password failed (exit 51/36)` | Keychain locked or not reachable from the service session; unlock it or use `keychainPath`. |
| `secret reference worker:X/secret:… belongs to another worker` | References are per worker; store the key on the worker that runs the job. |
| Job timeline: “Environment variables not set: X — this machine does not expose these local secrets …” | `remyral-worker secret expose <name> [--project <id>]` on that machine. |
