# Runbook: setting up agent runtimes on a worker

- **Applies to:** `remyral-worker` (`apps/worker`) job runner, the four runtimes of ADR-0012 (OpenHands removed, [ADR-0023](../adr/0023-remove-openhands.md))
- **Audience:** the owner, on each worker machine, **as the worker's OS user** (the user the service runs as)
- **Design:** [docs/design/p4-orchestration.md](../design/p4-orchestration.md) §3 "Worker execution",
  [p3-runtime-policy.md](../design/p3-runtime-policy.md), [p3-sandbox.md](../design/p3-sandbox.md),
  ADR-0008 (truthful capabilities), ADR-0012 (surfaces and pins), ADR-0014 (`local-login`)

**Since p5-remote-ops (ADR-0017) the panel does the installing:** Machines → <machine> → Runtimes installs,
upgrades, rolls back or removes the exact pinned version (checksum-verified, under `<dataDir>/runtimes`) and
relays the runtime's own subscription login — see [remote-ops.md](remote-ops.md). The manual steps below remain
valid for machines with remote operations disabled. You install the **exact pinned version**, choose an auth mode
per runtime, and enable the runtime in the worker config and in the runtime policy. A job is accepted only when all of these agree; otherwise the worker declines the
lease with a typed reason that is shown on the job (`GET /jobs/:id` → transitions / `orchestration`).

## 1. Pins and what is verified

| Runtime | Pin (ADR-0012) | Adapter status in this build | Contract-tested (ADR-0008) |
| --- | --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent@1.4.0` | real adapter | macOS arm64 (scripted provider) |
| OpenCode | `opencode-ai@1.19.4` | real adapter | macOS arm64 (scripted provider) |
| Claude Code | `@anthropic-ai/claude-agent-sdk@0.3.310` (bundles CLI 2.1.310) | real adapter | **none yet**: every core capability is `unverified` until the live run with credentials |
| Codex | `@openai/codex@0.164.0` | real adapter | **none yet**: every core capability is `unverified` until the live run with credentials |

On any other OS/arch (Linux, Windows, Raspberry Pi) — and for Claude Code and Codex everywhere — the
adapters report their capabilities `unverified` and the worker **refuses** jobs for them
(`capability_unverified`) unless the runtime policy allows it (§5). **For the first p3-e2e run with
Claude Code or Codex you must therefore set `allowUnverified: true` on that runtime's policy rule**; the
run is then the live contract evidence that lets a later change mark the capabilities `supported`.

**First live run (panel):** Settings → Runtimes → *Create default policy from current pins* (only when
`default` does not exist yet) → in the editor tick **Claude Code → Allow unverified** (or Codex) → change
note → *Save policy* with "To every worker of the policy now" → enter the authenticator code. Workers
without an assignment belong to `default` and receive it at once; Machines then shows the runtime as
`degraded` ("unverified (allowUnverified)") instead of "no ready runtime". Watch that first job: until a
live run has proven them, approvals and cancel may not be enforced. Untick it again later if you want only
verified capabilities. Nothing has been run against a real model provider by the platform's test suites (no credentials):
real provider auth, real cost reporting and long runs stay UNVERIFIED until the p3-e2e run.

## 2. Install the pinned version (as the worker user)

Never install globally as root; never `npm i -g <pkg>@latest`. Use a private prefix and point the worker at
the executable:

```sh
P=$HOME/.remyral-runtimes          # any directory owned by the worker user
npm install --prefix $P --ignore-scripts --save-exact @earendil-works/pi-coding-agent@1.4.0
npm install --prefix $P --ignore-scripts --save-exact opencode-ai@1.19.4
npm install --prefix $P --ignore-scripts --save-exact @openai/codex@0.164.0
# Claude Code: the worker does not bundle the Claude Agent SDK; it loads it at run time from the Claude Code
# runtime installed on this machine (Machines → Runtimes, or the locked install below: the SDK package next to its CLI)
$P/node_modules/.bin/pi --version                                        # 1.4.0
$P/node_modules/opencode-$(uname -s | tr A-Z a-z)-arm64/bin/opencode --version   # 1.19.4 (x64: -x64)
$P/node_modules/.bin/codex --version                                     # codex-cli 0.164.0
```

**Locked alternative (recommended, p7-supply-chain):** the repository carries a lockfile per runtime
(`infra/worker/images/<runtime>/package.json` + `package-lock.json`) that pins the whole transitive tree with
integrity hashes. Copy both files into a per-runtime prefix and install exactly that tree:

```sh
for rt in pi opencode codex; do
  mkdir -p $P/$rt && cp infra/worker/images/$rt/package*.json $P/$rt/
  npm ci --prefix $P/$rt --omit=dev --ignore-scripts --no-audit --no-fund
done
# binaries: $P/pi/node_modules/.bin/pi, $P/codex/node_modules/.bin/codex,
#           $P/opencode/node_modules/opencode-<os>-<arch>/bin/opencode
```

With `--ignore-scripts` the OpenCode npm shim cannot copy its platform binary; point the worker at the
**platform binary** (`node_modules/opencode-<os>-<arch>/bin/opencode`), not the shim — the adapter must own
the real process tree. Codex on Linux: its `CODEX_HOME` lives in the worker's sandbox dir, never under
`/tmp` (handson finding 3).

**Enable the runtime in the panel** (ADR-0015): Machines → <machine> → **Configuration** → *Runtimes* (allowed
runtimes, auth mode, default model profile; Pi provider/model, OpenCode model/options under
*Runtimes & models*). The worker applies it without a
restart. The local file (`/etc/remyral-worker/config.json` or the per-OS default) keeps only machine-local
facts a panel must never choose — where the executables and operator extension files are:

```jsonc
{
  "runtimes": {
    "pi":       { "binary": "/home/remyral/.remyral-runtimes/node_modules/.bin/pi" },
    "opencode": { "binary": "/home/remyral/.remyral-runtimes/node_modules/opencode-linux-x64/bin/opencode" },
    "codex":    { "binary": "/home/remyral/.remyral-runtimes/node_modules/.bin/codex" }
  }
}
```

A `model`/`provider`/`config` written in the local `runtimes.<kind>`, or `allowedRuntimes` / `runtimeAuth`
in the local file, still works but now **pins** that value (the panel's value for it is reported as
`blocked_by_local_ceiling`) — remove them to manage the runtime from the panel
([worker-pairing.md §4b](worker-pairing.md#4b-optional-pin-a-machine-with-a-local-ceiling)).

- `binary` is optional; without it the probe's PATH lookup is used (`remyral-worker probe` shows what it
  found and whether the version matches the pin).
- `containerBinary` (default: the pin's binary name) is the executable inside the runtime image for
  `container` jobs (`sandbox.container.images.<runtime>`, built by `node infra/worker/images/build.mjs`).
- Pi `extensions` / OpenCode `config` are operator hooks (never repository content). Credential-like keys
  in `config` must be `{env:NAME}` references — the config refuses literal keys.
- `devFakeRuntime` (fake adapter) is a development flag and is refused unless `masterUrl` is a loopback
  `ws://` dev master.

Restart the service; `remyral-worker probe` and the fleet view should show the runtime `installed`, pin
`match`, and its capability set from the adapter.

## 3. Choose the auth mode (panel: Configuration → Runtimes → auth)

Set per runtime in the panel: **local login** or **worker secret** (the *name* of a secret in the worker's
own store plus, optionally, the env variable). The panel never sees or stores the value; the vault that will
deliver credentials sealed to the worker's key is the follow-up `p5-credentials-models`. The equivalent local
`runtimeAuth` entries below still work and pin the auth of that runtime.

### `secret-ref` (API key; default for new workers)

```sh
remyral-worker secret set anthropic          # prompts, not echoed; or: ... --stdin
```

Panel: auth *worker secret*, name `anthropic` (env empty = the runtime default). Local-file equivalent:

```jsonc
"runtimeAuth": {
  "claude-code": { "mode": "secret-ref", "ref": "secret:anthropic" },                 // ANTHROPIC_API_KEY
  "codex":       { "mode": "secret-ref", "ref": "secret:openai" },                    // CODEX_API_KEY
  "pi":          { "mode": "secret-ref", "ref": "secret:anthropic", "env": "ANTHROPIC_API_KEY" },
  "opencode":    { "mode": "secret-ref", "ref": "secret:anthropic", "env": "ANTHROPIC_API_KEY" }
}
```

Pi and OpenCode have no default variable: name the provider's variable in `env`. The key is resolved per
job, injected into the runtime's environment only, registered for exact-value redaction and refused in
pushed commits (pre-push scan). See [worker-secrets.md](worker-secrets.md).

### `local-login` (subscription / the runtime's own login, ADR-0014)

Log in **interactively as the worker OS user** with the runtime's own flow; the worker never reads, copies
or transmits that credential, it only keeps the runtime's lookup working (HOME, keychain context):

| Runtime | Login (as the worker user) | Readiness the worker reports |
| --- | --- | --- |
| Claude Code | run `claude`, then `/login` in the session (keychain on macOS, `~/.claude` elsewhere) | `claude auth status --json` (`loggedIn` only) |
| Codex | `codex login` (browser) or `codex login --device-auth` on a headless machine | `codex login status` (exit code only) |
| Pi | run `pi`, then `/login` (writes `~/.pi/agent/auth.json`); set `runtimes.pi.provider` | `pi auth check --provider <p> --json --no-refresh` → yes/no |
| OpenCode | `opencode providers login` (alias `auth login`; plaintext `~/.local/share/opencode/auth.json`) | `opencode providers list` |

```jsonc
"runtimeAuth": { "claude-code": { "mode": "local-login" } },
"sandbox": { "keepHome": true, "allowKeychain": true }   // macOS host jobs: the login lives in HOME/keychain
```

`keepHome`/`allowKeychain` widen what a host-restricted runtime can read (its own login state) — see
[worker-sandbox.md](worker-sandbox.md). Subscription usage limits apply per account; the owner accepted
that risk (ADR-0014).

## 4. Sandbox profile

Jobs name a profile; the worker selects it or declines (`sandbox_unavailable (<reason>): … remedy: …`):

- `container` (Linux, rootless Docker/Podman, pinned images) — required for `sourceTrust: untrusted`.
- `host-restricted` — dedicated low-privilege worker user (`sandbox.workerUser`), Seatbelt on macOS; the
  project must opt in (`projects.host_execution`). OpenCode may listen on loopback there.
- `runtime-sandbox` — Codex/Claude Code native sandbox on Linux; offered only when `bwrap` really creates a
  user namespace on this machine (inside a container with the default seccomp profile it cannot).

CAPABILITIES carries `sandboxReadiness` per profile with the runner's own reason, e.g. "worker OS user not
acceptable: …" — fix that before expecting jobs. Keep `workspaceRoot` outside `dataDir`: Seatbelt denies
the runtime every read of the data dir.

## 5. Enable the runtime in the runtime policy

Without an applied policy the worker compares against the compiled pins and allows every configured auth
mode. Policies are written in the panel under **Settings → Runtimes** (p5-runtime-policy-ui: one row per
runtime with Allowed, the read-only pin, auth modes, Allow unverified, Allow unpinned and model profiles
from Settings → Models; saved for all workers or staged on canaries, with history, promote and rollback);
workers are assigned in Machines → <machine> → Sandbox & policy → "Runtime policy". `GET /runtime-policies/template` returns a
valid starter document from the compiled-in pins (`packages/protocol/src/runtime-pins.ts`); the API
equivalent of saving is `PUT /runtime-policies/<name>` (admin + step-up, `expectedVersion` = the newest
stored version). With a policy, a runtime must be listed:

```jsonc
{
  "runtimes": {
    "pi": {
      "version": "1.1.0",
      "authModes": ["secret-ref", "local-login"],
      "allowUnpinned": false,
      "allowUnverified": false,          // ADR-0008, see below
      "modelProfiles": [{ "name": "default", "provider": "anthropic", "model": "claude-sonnet-4-5", "params": {} }],
      "defaultProfile": "default"
    }
  },
  "projectProfiles": {}
}
```

- A job's `model` names a **model profile** when the runtime has profiles (Pi/OpenCode get
  `provider/model`, Claude Code/Codex the model id); without profiles it is passed to the runtime as is.
- **`allowUnverified: true`** lets jobs use capabilities the adapter reports `unverified` on this worker
  (not contract-tested on its OS/arch/version). The refusal `capability_unverified: …` names the policy and
  rule to change. It never makes the capabilities `supported`; prefer running the adapter's real-binary
  contract suite on that OS/arch and recording it (below). Unassigned workers belong to policy `default`.
- `allowUnpinned: true` runs a mismatching installed version (and therefore its unverified capabilities).
- `unsupported` capabilities are never allowed (e.g. a runtime without approvals needs jobs with
  `approvalPolicy: "deny-sensitive"`).

## 6. Running the real-binary suites (verification)

No credentials, no network: Pi uses its built-in faux provider extension, OpenCode a scripted
OpenAI-compatible server on 127.0.0.1.

```sh
export REMYRAL_PI_BIN=$P/node_modules/.bin/pi
export REMYRAL_OPENCODE_BIN=$P/node_modules/opencode-darwin-arm64/bin/opencode
pnpm vitest run packages/agent-adapters/test/pi-real.test.ts packages/agent-adapters/test/opencode-real.test.ts
# master + worker + real runtimes end to end (needs the dev stack: pnpm dev:up)
pnpm vitest run apps/master/test/integration/runtime-e2e.test.ts
```

The end-to-end suite submits jobs through the master, runs them on a worker with the production job wiring
(Pi under real Seatbelt on macOS; OpenCode unconfined because its scripted provider is on loopback; Pi in
the `remyral/runtime-pi:0.1.0` container when Docker is reachable — `REMYRAL_SKIP_DOCKER_TESTS=1` skips it)
and checks the commit with the `Remyral-Attempt` trailer pushed to a local bare repository, an approval
round trip and cancel mid-run. A passing adapter contract suite on a new OS/arch is the evidence for adding
it to `PI_CONTRACT_TESTED` / `OPENCODE_CONTRACT_TESTED` (and the Claude/Codex tables) in a normal change.

## 7. Troubleshooting (decline reasons)

| Reason prefix | Meaning | Fix |
| --- | --- | --- |
| `runtime_not_enabled` | not allowed in the worker's configuration | enable it in Machines → <machine> → Configuration (or widen the local ceiling) |
| `runtime_not_available_in_build` | no adapter in this build | wait for the adapter release |
| `runtime_binary_missing` | executable not found | install the pin, set `runtimes.<kind>.binary` |
| `runtime_not_allowed` / `auth_mode_not_allowed` / `model_profile_*` | runtime policy | edit the policy |
| `runtime_pin_mismatch` | installed ≠ pin | install the pinned version (or `allowUnpinned`) |
| `capability_unverified` | not contract-tested on this OS/arch/version | run §6 here, or `allowUnverified` |
| `capability_unsupported` | the runtime cannot do it | change the job (e.g. `deny-sensitive`) or runtime |
| `sandbox_unavailable (…)` | profile not ready | the message's remedy |
| JOB_RESULT `PushRejectedError` / `SecretScanError` | push refused (branch exists, credential, secret in the diff) | inspect the retained workspace |

## 8. Interactive OpenHands sessions and Canvas (removed)

Removed on 2026-10-15 together with OpenHands ([ADR-0023](../adr/0023-remove-openhands.md)): there are no
interactive sessions, no `/canvas` or `/api/oh/*` routes and no `CANVAS_DIR` any more. Past sessions remain
visible as read-only jobs. Follow-up messages to a running job ("Message the agent") and ops chat cover the
interactive use.
