# ADR-0012: Runtime integration surface per agent

- **Status:** Accepted — owner-delegated sign-off, 2026-10-13 **Partially superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands was removed; the OpenHands rows and rules no longer apply).
- **Date:** 2026-10-12
- **Related:** docs/compat/README.md, p3-adapter-*, p3-runtime-policy, ADR-0006/0007/0008/0010

## Context
ROADMAP suggested: OpenHands API/SDK; Claude Code and Codex via pinned ACP adapters where feasible; Pi via RPC or validated ACP bridge; OpenCode via local password-protected HTTP API. AGENTS.md rule 12 requires verification against pinned releases. Research (docs/compat/*.md, 2026-10-12) showed that for Claude Code and Codex the ACP adapters are thin wrappers that *hide* exactly the controls we need (permission mode, hooks, approvals, abort), and the Codex ACP adapter pins an older Codex.

## Decision

| Runtime | Surface | Pin |
|---|---|---|
| OpenHands | Agent Server REST + WebSocket; one server per job bound to 127.0.0.1 with a random session key; Docker sandbox per job on Linux | ==1.54.0 |
| Claude Code | Claude Agent SDK `query()` in-process (streaming input, `canUseTool`, `interrupt()`), always with explicit `permissionMode`, `settingSources: []`, bypass disabled | `@anthropic-ai/claude-agent-sdk@0.3.310` |
| Codex | `codex app-server` over stdio (JSON-RPC), protocol types generated from the pinned binary; `codex exec --json` only for pre-authorised no-approval jobs | `@openai/codex@0.164.0` |
| Pi | `pi --mode rpc` over stdio + our permission-gate extension (deny on timeout/error), `--no-context-files` for untrusted repos | `@earendil-works/pi-coding-agent@1.6.0` |
| OpenCode | `opencode serve --hostname 127.0.0.1` with per-job `OPENCODE_SERVER_PASSWORD`, `OPENCODE_DISABLE_PROJECT_CONFIG=1` and a complete `OPENCODE_PERMISSION`; SDK client | `opencode-ai@1.19.4` |

Common rules for every adapter:
1. **Version gate:** `probe()` reads the runtime's version; any mismatch with the pin ⇒ capability set `unverified`, job refused unless policy allows (ADR-0008).
2. **Fail-closed local servers:** random per-job secret, explicit loopback bind, and a startup self-check that an unauthenticated request is refused; otherwise abort the job.
3. **Our policy beats repo policy:** project-level runtime config/settings are disabled; the adapter passes a complete permission policy (ADR-0010).
4. **Worker owns the process tree:** spawn in a new process group (POSIX) / Job Object (Windows); cancel = runtime-native interrupt, then kill the tree after a grace period; workspace state reconciled from git (ADR-0004).
5. **Credentials:** API keys (or Bedrock/Vertex) injected per job from the worker keystore (ADR-0006), or — amended by ADR-0014 — the owner's worker-local subscription login, which the platform never touches.
6. **Cost:** recorded with provenance; Codex cost is estimated from tokens.
7. ACP stays a documented fallback, not a primary path; revisit when ACP adapters expose permission mode/approvals without loss.

## Alternatives considered
- ACP for Claude Code and Codex (ROADMAP's first suggestion) — rejected for now: loses permission-mode control/hooks (Claude), version skew to Codex 0.160.x (Codex).
- OpenHands Python SDK in a sidecar — unnecessary; the server API covers the contract.
- Pi via `pi-acp` — too immature (0.0.34).

## Consequences
Five different transports (in-process SDK, stdio JSON-RPC, stdio JSONL, two loopback HTTP servers) — the adapter contract test kit (p3-adapter-contract) is essential. OpenHands needs Python 3.12 on the nodes that run it.

## Verification
p0-compat-handson checklists on each OS/arch; p3 contract tests per adapter; p3-e2e acceptance (A-RT-*).

## Implementation notes (2026-10-13, p3-adapter-pi / p3-adapter-opencode)

- **OpenCode 1.19.0 loads repository plugins** (`.opencode/plugin*/*.js`) even with `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `--pure`. The adapter therefore refuses any workspace (or parent) containing `.opencode`, `opencode.json` or `opencode.jsonc`. Report upstream.
- **OpenCode tool shells can read the server password**, so an approved bash call could self-approve later requests through the server API. Only detectable (unexpected permission replies, new sessions/terminals, mid-run config changes fail the job); `approval` is reported `degraded`. Prefer the `container` profile for OpenCode jobs.
- **Pi and OpenCode put tool processes in their own process groups**; cancel records child process groups before the kill and sweeps them afterwards; `safe_cancel` is `degraded`.
- **Claude Code 2.1.296:** `settingSources: []` alone starts in `auto` mode — the explicit `permissionMode` is mandatory; a hostile repo `acceptEdits` setting is neutralised by the hardened options.
- **Codex 0.162.1:** a repo `.codex/config.toml` (`network_access = true`) takes effect unless the workspace is marked `trust_level="untrusted"`; `project_doc_max_bytes=0` stops AGENTS.md injection. `thread/start` opens a websocket to api.openai.com even before a turn. `codex exec --json` is not implemented (app-server covers pre-authorised jobs).
- **OpenHands 1.54.0:** repo plugins/sub-agents under `.agents/` or `.openhands/` always load (a repo SessionStart hook ran before the first model call) → adapter refuses such workspaces; a follow-up prompt or `/run` implicitly executes actions waiting for approval → adapter rejects waiting actions first; the session key is readable via `ps eww` → bypass detected, `approval` degraded; `interrupt` does not stop running terminal commands → cancel always kills the process tree; approval policy is always `AlwaysConfirm` (the model's own risk label is not trusted); `local-login` unsupported (LiteLLM providers need keys); container profile refused until the container runner publishes the server port on loopback.

## Amendment 2026-10-23: versions above the release pin, by owner policy (p16-runtime-updates)

The pin table above stays the release's pinned set: what a worker release installs, what the contract suites ran
against and the only versions whose capabilities can be anything but `unverified`. The owner decided (2026-10-23)
that a newer upstream version must not wait for a worker release: with the security policy setting
`fleet.unverifiedRuntimeUpdates` (ADR-0056 amendment; on in every preset) an administrator may install an exact
newer version from the runtime's official npm package — the release's own root package (Claude Code: the agent SDK
whose `claudeCodeVersion` equals the requested CLI) at exactly that version, the registry's sha512 read by the master
and signed into the remote operation, every tarball checked before unpacking, install scripts never run, the same
unprivileged worker-owned layout. Such a version is labelled **unverified** everywhere (ADR-0008 unchanged: the probe
compares with the pin, so every capability reads `unverified … differs from pinned`), jobs run on it while the policy
is on, and going back to the pin is one action. An automatic check on one canary machine (integrity, version, help /
loopback auth, the adapter's probe; no model prompt, no contract suite) can mark it a *verified candidate*; that is
not a verification in this ADR's sense — the version is pinned only by a worker release
(`scripts/release/promote-runtime-pin.mjs` + the compat checklist). Off = pins only, as before. Details:
docs/design/p16-runtime-updates.md.

## Amendment 2026-10-26: pins moved for worker 1.1.4 (p17-pin-bump)

The decision table moved through `scripts/release/promote-runtime-pin.mjs` (lockfiles generated with
`npm install --package-lock-only --ignore-scripts`, root `dist.integrity` equal to the registry's, previous pins kept
under `infra/worker/runtimes/<rt>/previous/` as the one allowed downgrade):

| Runtime | Old pin | New pin | Verification run on the new pin (darwin-arm64, 2026-10-26) |
| --- | --- | --- | --- |
| Claude Code | SDK 0.3.296 / CLI 2.1.296 | SDK 0.3.310 / CLI 2.1.310 | `sdk.d.ts` diff (additive only), contract suite on the SDK-typed fake, real bundled-CLI smoke (no login) |
| Codex | 0.162.1 | 0.164.0 | protocol regenerated (`ImageGenerationItem` `fileId` \| `result`), fake app-server contract suite, real-binary suites with the mock Responses API |
| Pi | 1.1.0 | 1.4.0 | `pi-real` contract kit + smoke (scripted provider), RPC types unchanged |
| OpenCode | 1.19.0 | 1.19.4 | `opencode-real` contract kit + smoke (scripted provider) |

Capabilities stay as before: `supported` / `degraded` only where the contract kit ran on the pin (Pi and OpenCode on
darwin-arm64), `unverified` elsewhere; Claude Code and Codex still wait for the credentialed live run.

## Amendment 2026-11-26: Pi pin moved to 1.6.0

Pi `1.4.0` → `1.6.0` through `scripts/release/promote-runtime-pin.mjs` (lock generated with
`npm install --package-lock-only --ignore-scripts`, every package older than 24 h): clears the undici and minimatch
advisories of the 1.4.0 tree. RPC types unchanged; `pi-real`, `pi-assistant-real` and `pi-subtasks-real` passed on
darwin-arm64 (scripted provider). Capabilities as before: `supported` / `degraded` on darwin-arm64 only, `unverified`
elsewhere. Details: docs/compat/pi.md §2. The Claude Code image lock was refreshed in the same change within its
declared ranges (`hono` 4.13.22, `@hono/node-server` 2.1.11); the SDK 0.3.310 / CLI 2.1.310 pin is unchanged.

## Amendment 2026-10-27: master-side capability evidence from the panel (p17-runtime-verify)

Owner decision (2026-10-27): a capability may be proven on the customer's own machines, from the panel, instead of only
by a developer's credentialed live run plus a release. "Doğrula" (Makine → Runtime’lar; owner / admin, step-up of the
security policy's `machines.ops` event, rate-limited, audited) sends the signed remote operation
`runtime.capabilities.verify`; the worker runs the scenario set of `@remyral/agent-adapters` (`src/verification`, the
same checks as the contract kit and the live tests, one scenario per capability) through the real adapter with the
machine's configured auth, confined like a job, within a time and token budget, and answers with evidence signed by its
device key and bound to the master's operation id. The master stores verified evidence and overlays it on the
worker-reported static table:

1. only `unverified` is lifted, and only to the adapter's **declared** status (`supported` / `degraded`); `unsupported`
   stays, a reported `supported` / `degraded` is never changed;
2. only for the exact tuple — runtime, runtime version, OS, arch **and adapter revision** (rule 1's version gate still
   applies: another version is `unverified` again); fleet-wide for every machine on that tuple;
3. per capability the newest run that decided it counts (a later failure revokes a pass; a skip changes nothing).

Placement and the compatibility matrix use the overlaid status; ASSIGN_JOB carries the proven capabilities to the
worker, whose gate and attempt adapter apply them only to their own exact tuple. Worker reports stay truthful (the static
table). `allowUnverified` stays for the transition; the runtime policy page counts what still depends on it. The signed
version catalog is unchanged: a version verified for every installation is still the vendor's catalog routine
(docs/ops/update-channel.md §4); the panel's catalog mark is the owner's local record. Details:
docs/design/p17-runtime-verify.md.
