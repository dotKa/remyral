# p22-runtime-diagnostics — diagnosable runtime crashes, trusted internal certificates, clear DNS failures

- **Task:** `p22-runtime-diagnostics`. **Date:** 2026-11-02. **Migration:** 0209. **Worker release:** yes (adapter,
  worker, protocol feature `function-tls-pins-v1`).
- **Evidence (test server, FAILED jobs, 14 days):**
  - `RuntimeCrashedError: claude-code: runtime crashed (exit unknown): Claude Code pr…` — 17 jobs (Claude Code jobs
    succeed 66 % vs Codex 87 %); nobody could tell why.
  - `http_error: request failed (DEPTH_ZERO_SELF_SIGNED_CERT): self-signed certificate` — 14 function jobs (HTTPS to
    internal services with self-signed certificates).
  - `dns_failed: <host> could not be resolved` — 7 function jobs.
- **Builds on:** [p11-usage-limit-fallback](p11-usage-limit-fallback.md), [p10-claude-login-health](p10-claude-login-health.md),
  [p15-auto-mode](p15-auto-mode.md) (automatic retries), p14-i18n-reasons (reasons as codes; no separate note),
  [p14-workflow-engine](p14-workflow-engine.md) (function jobs, ADR-0055), [p14-repo-egress](p14-repo-egress.md).

## 1. Runtime crashes

### 1.1 Why the exit was "unknown" (root cause, confirmed in code)

The Claude Code adapter starts the CLI through the Agent SDK with our own spawner (`DeferredOwnedProcess` around an
`OwnedProcess`; the owned process already listens to `exit`, not `close`, so a grandchild holding the pipes cannot hide
the leader's exit, and Windows job objects / POSIX process groups are killed as a tree). The exit **was** observed —
it was thrown away:

1. `startSession`'s generic catch built `new RuntimeCrashedError(RUNTIME, undefined, …)` — the exit was passed as
   `undefined` literally, so every start-up failure said `exit unknown`, whatever the process did.
2. The catch ran `cleanup()` (which kills the tree) before reading anything; the SDK can also reject on a closed stdout
   before the `exit` event arrives, so even a read would sometimes have been early.
3. A spawn failure (the confiner refused, ENOENT) reached the SDK only as a fabricated `exit 1`, which overwrote the
   SDK's own "Failed to spawn" error — the real reason was lost.
4. The mid-run crash path (`pump`) put the exit only in `SessionResult.exit`; the worker's JOB_RESULT error said
   `the run failed`.

### 1.2 Fix

- `settledExit()`: before cleanup, wait (bounded, 2 s) for the owned process's own `exit` event, then read code **and**
  signal; fall back to what the SDK error names (`exitCode` / `signal` tags, "exited with code N", "terminated by signal
  SIGX"). A spawn failure keeps its own message (`onSpawnError`).
- `describeExit` prints Windows NTSTATUS codes in hex (`exit code 0xC0000005`).
- `crash-diagnosis.ts` (pure): `diagnoseCrash({exit, text})` → `usage_limit | login | out_of_memory | killed |
  provider_overloaded | network | unknown`. Order: login wording (re-login is the only fix), usage limit, memory (heap
  out of memory, ENOMEM, NTSTATUS no-memory codes), provider 5xx / 529 / overloaded, network (ENOTFOUND, ECONNREFUSED,
  "Connection error"…), then the signal (SIGKILL / exit 137 → `killed`). It reuses `classifyProviderFailure`
  (p11) so the limit / login wording stays one list.
- The stderr tail: the last **20 lines / 2000 characters**, redacted by the adapter (`redactSecrets` with the job's
  secrets) and again by the worker's redactor, travels in `RuntimeCrashedError.diagnosis` / `SessionResult.crash`.

### 1.3 What the platform does with the cause

| Cause | Worker JOB_RESULT `error` | Master |
| --- | --- | --- |
| `usage_limit` (start-up) | `provider_usage_limit` + `resetAt` + `usageLimit` (scope from the run's auth) | the usage-limit policy (wait / fallback), never a retry storm |
| `login` | `login_expired` (already, adapter path) | re-login, scheduler waits |
| `provider_overloaded` | `runtime_crashed`, `params.cause` | transient `provider_error` (not machine-specific) → auto retry |
| `out_of_memory`, `killed`, `network`, `unknown` | `runtime_crashed`, `params.cause` | transient `runtime_crash`, machine-specific → auto retry, another machine first |

The error code of a diagnosed crash is now `runtime_crashed` (the console's reason code; `RuntimeCrashedError` from
older workers is still classified the same). The message keeps the exit and the stderr tail:
`claude-code: runtime crashed (signal SIGKILL): … (cause: killed)\nstderr (last lines):\n…`. The master's classifier
reads only the fixed `(cause: x)` marker. The console says each cause in TR / EN (`reasons.codes.runtime_crashed`,
REASON_CAUSES) with the fitting fix (re-login, usage, machine).

## 2. Trusting an internal certificate (opt-in, pinned, audited)

Default stays strict. No global "skip verification" switch exists or was added.

- **Worker** (`function-tls-pins-v1`): when an HTTPS hop of a function job fails certificate verification, the worker
  opens one more TLS connection to the already checked address and reads the presented chain — **nothing is written to
  it** — and takes the pinnable certificate: the self-signed top of the chain (the leaf itself for
  `DEPTH_ZERO_SELF_SIGNED_CERT`), else the leaf. Its SHA-256 (DER) is compared with ASSIGN_JOB `execution.tlsPins` for
  exactly this `host:port`. A match → the hop is made again with that certificate as an extra trust anchor for that one
  connection (`ca: system roots + pinned`, a pinned leaf as a partial chain); the handshake is verified again, so a
  swapped certificate fails (no TOCTOU), and the host name check is waived only for the exact pinned certificate. No
  match → `http_error` with `params {cause: tls_untrusted, tlsCode, host, port, certSha256[, pinMismatch]}`. The
  refused handshake sent no request bytes, so a retried POST is not a duplicate.
- **Master:** `project_tls_pins` (migration 0209: project, host, port, sha256, source job, who, when). `POST
  /projects/:id/tls-pins {jobId}` pins the certificate the latest attempt of that job (a job of this project) reported —
  the client never sends a fingerprint or host. `projects.egress.write` (project admin), step-up (the project policy
  event of the security policy, ADR-0056), audited `project.tls_pin.add`; `DELETE …/:pinId` audited
  `project.tls_pin.remove` (no step-up: it only makes requests stricter); at most 32 pins per project. Function jobs of
  the project carry the pins only to `function-tls-pins-v1` workers (older workers stay strict).
- **Console:** the failed job's page shows "Certificate not trusted", the fingerprint (`AB:CD:…`) and one button
  "Trust this certificate" (step-up dialog); a pin mismatch says the certificate changed.

Not covered here: the master-side guarded probe (uptime monitors, deploy health; `apps/master/src/uptime/probe.ts`) —
none of the evidence came from it (its message is `TLS certificate refused (…)`); it stays strict.

## 3. Names that do not resolve

`dns_failed` now says the domain does not resolve and where to look (its DNS records; Cloudflare: the record, the
zone), with the resolver code; `EAI_AGAIN` says the DNS server did not answer. A Cloudflare quick-tunnel address
(`*.trycloudflare.com`) says its tunnel (preview) was probably stopped (`params.cause = tunnel_address`). The master
turns a `dns_failed` whose host is a preview tunnel of the platform that is stopped (and no open tunnel holds the name)
into `preview_stopped` when the job is read. Sentences in TR / EN (`reasons.codes.dns_failed`).

## 4. Tests

- `packages/agent-adapters/test/crash-diagnosis.test.ts` — exit parsing, classification, bounds, hex NTSTATUS.
- `packages/agent-adapters/test/runtimes/claude-code/adapter.test.ts` — a real killed CLI reports `signal SIGKILL` and
  `cause: killed` (mid-run and at start-up, never `exit unknown`); start-up usage limit / 529 classified.
- `apps/worker/test/crash-report.test.ts` — JOB_RESULT error of a crash; usage limit → `provider_usage_limit`.
- `apps/worker/test/functions-tls-pin.test.ts` — real HTTPS server with a self-signed certificate: strict by default
  (server never got the request), pin lets it through, other host / other fingerprint refused; DNS wording.
- `apps/master/test/unit/auto-mode.test.ts` — classifier causes; `apps/master/test/unit/tls-pins.test.ts`.
- `apps/master/test/integration/tls-pins.test.ts` — the pin path against Postgres (audit, idempotence, refusals).
- `apps/web/test/tls-pins.test.ts` — the card's condition and the TR / EN sentences.

## 5. Security review

- Looser behaviour only by an explicit, per-project, per-`host:port`, per-certificate opt-in by a project admin with
  the policy's step-up; audited both ways; the fingerprint comes from the worker's report, not from the client.
- The certificate read sends no data; secrets are never attached to it. The pinned retry verifies the handshake again.
- stderr tails are redacted twice and bounded; only fixed patterns of them decide anything.
- Rollback: the table is additive; older workers ignore `execution.tlsPins` (and never get it); older consoles show
  the raw reason text.

## Changelog

- fix(master,worker,protocol,agent-adapters,web,i18n): **a crashed Claude Code run now says why — its real exit code or signal, the last stderr lines and a cause (out of memory, killed, provider overloaded, network, login, usage limit) — and a self-signed internal service can be trusted per project with one click** (p22-runtime-diagnostics, [design](p22-runtime-diagnostics.md); evidence 17 `runtime crashed (exit unknown)`, 14 `DEPTH_ZERO_SELF_SIGNED_CERT`, 7 `dns_failed` failed jobs in 14 days). The exit was thrown away in the adapter's start-up path; a usage limit at start-up now takes the usage-limit path instead of retrying, transient causes go to the automatic retry. "Trust this certificate" pins the exact SHA-256 the worker saw for that host:port (project admin, step-up, audited; migration 0209, worker feature `function-tls-pins-v1`); verification stays strict everywhere else. `dns_failed` says the domain does not resolve and to check DNS / Cloudflare, or that the preview tunnel was stopped.
