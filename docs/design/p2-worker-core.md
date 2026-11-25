# Design note: `p2-worker-core`

- **Task:** `p2-worker-core` — apps/worker daemon core: config, state machine, structured logs, redaction. Unblocks `p2-transport`, `p2-service-*`, `p3-workspace`, `p3-secrets-worker`.
- **Date:** 2026-10-12
- **Binding inputs:** ADR-0004 (leases/fencing; workers persist lease state), ADR-0005 (outbound WSS, Ed25519 device key, pairing), ADR-0006 §4 (shared redaction library), ADR-0007 (workspace root is the only writable path), ADR-0011 (seq replay cursors, Zod), ADR-0012 rule 4 (worker owns process trees), threat model T-WRK-\*, T-SEC-\*.

## Problem

The P0 worker is a one-shot `probe`. P2 needs a long-running daemon that every later P2/P3 task plugs into: a validated config, an explicit lifecycle state machine, durable local state that survives crashes and reboots, a device identity for pairing, and logs that can never carry a secret. The network transport is a separate task (`p2-transport`), so the core must be complete and testable without a network.

## Shape

```
packages/observability (@remyral/observability, no runtime deps)
  redact/secret-set.ts  SecretSet: exact values (+ URL/JSON/base64/base64url encodings), never exposes them
  redact/rules.ts       DEFAULT_RULES: vendor token patterns, context rules, PEM block rule
  redact/redactor.ts    Redactor: exact pass + pattern pass → merged spans → [REDACTED:<label>]
  redact/stream.ts      StreamRedactor: chunked redaction with bounded lookbehind
  redact/deep.ts        redactDeep: JSON-safe, redacted copy of any value (errors, cycles, binary, limits)
  log/logger.ts         createLogger: JSON lines, levels, child loggers, every field through redactDeep

apps/worker/src
  config/   paths.ts (per-OS locations) · schema.ts (Zod) · load.ts (read → perms → parse → dataDir)
  state/    machine.ts (pure transition table + WorkerStateMachine wrapper)
  store/    store.ts (state.json) · outbox.ts (outbox.jsonl) · schema.ts
  identity/ device-key.ts (Ed25519) · keystore.ts (file + fail-closed OS stubs) · pairing.ts
  transport/ port.ts (TransportPort) · memory.ts (MemoryTransport fake, UnimplementedTransport)
  daemon/   daemon.ts (WorkerDaemon) · run.ts (composition) · children.ts · signals.ts
  fs/       ops.ts (FileOps port + node impl) · atomic.ts · permissions.ts
  cli.ts    probe | run | identity show
```

All filesystem access of the daemon goes through the `FileOps` port, so crash and permission scenarios are simulated in tests on any OS; path logic takes a `PathHost`, so Linux/macOS/Windows layouts are tested everywhere.

## Decisions

### Redaction (ADR-0006 §4)

1. **Two passes, one span model.** Exact values of registered secrets (first pass) and pattern rules (second pass) both produce spans; overlapping spans merge into one marker `[REDACTED:<label>]`. Label is the rule id, or the secret's registered label (an env-var name — never the value).
2. **Exact values include common encodings** (URL-encoded, JSON-escaped, base64 and base64url of the whole value), because tokens show up in `Authorization: Basic`, query strings and JSON dumps. A base64 substring at a non-aligned offset (e.g. base64 of `user:<secret>`) is *not* found by the exact pass; the `authorization-header` rule covers the common case. Secrets shorter than 6 characters are refused (`SecretTooShortError`) rather than shredding output.
3. **Patterns with low false positives:** vendor prefixes (`sk-ant-`, `sk-…` with a digit, `ghp_/gho_/ghu_/ghs_/ghr_`, `github_pat_`, `glpat-`, `AKIA/ASIA/…`, `AIza`, `xox?-`, `sk_live_`, `hf_`, `npm_`), JWTs (`eyJ….eyJ….…`), PEM private-key blocks, and *context* rules that redact only the value: `Authorization:` header values, `Bearer <≥16 chars>`, URL userinfo passwords, and `<…password|secret|token|api_key|access_key|private_key> = <≥8 chars>`. A benign-text corpus (commit SHAs, UUIDs, `max_tokens: 4096`, `PATH=…`, plain URLs, "Basic configuration…") is asserted unchanged. All regexes are linear (single character classes, bounded whitespace).
4. **Streaming with bounded lookbehind.** `StreamRedactor` holds back `lookbehind = max(1024, longest secret variant)` characters, plus any match that touches the end of the data seen so far (the token may continue). Invariant: every rule is prefix-closed within the lookbehind, so a token that starts before the hold-back window is already fully matched. A held secret that exceeds `maxHold` (64 KiB; e.g. a PEM block without END) is force-closed: a marker is emitted and the rest of the token is swallowed via the rule's continuation (character class, or "until END line"). A stream that ends inside a PEM block redacts to the end (fail closed). Property test: 200 random chunkings of a document with every canary give byte-identical output to one-shot redaction and never leak.
5. **Logger.** JSON lines `{ts, level, msg, …fields}` to stderr (journald/launchd/Event Log friendly), levels trace…fatal + `silent`, child loggers merge fields. Message, field keys and values, error messages, stacks and causes all pass through the redactor; string values under secret-looking keys (`*password`, `*token`, `*apiKey`, `authorization`, `cookie`, …) are replaced regardless of content. Errors become `{type, message, code, stack, cause}` — stacks are always redacted (option `stacks: 'omit'` drops them). Bounded: depth 8, 100 entries, 8 KiB per string, cycles → `[Circular]`, binary → `[binary N bytes]`. A throwing sink never crashes the caller (`droppedLines` counts it). There is no unredacted code path.

### Config

6. **Locations** (first existing wins; `--config` / `REMYRAL_WORKER_CONFIG` override): Linux `$XDG_CONFIG_HOME/remyral-worker/config.json` (relative XDG ignored) then `/etc/remyral-worker/config.json`; macOS `~/Library/Application Support/RemyralWorker/config.json` then `/Library/Application Support/RemyralWorker/config.json`; Windows `%ProgramData%\RemyralWorker\config.json`. **A privileged process (root) only considers the system location**, so a root daemon never reads a user-controlled file. Default `dataDir` follows the scope (`/var/lib/remyral-worker`, `$XDG_STATE_HOME/remyral-worker`, `…/RemyralWorker/data`).
7. **Schema** (`strictObject`: unknown keys are errors, so `maxParalelJobs` cannot silently default): `masterUrl` must be `wss://` — `ws://` only for `127.0.0.1`/`localhost`/`[::1]`; no userinfo, query or fragment; `workspaceRoot`/`dataDir` absolute for the *target* OS (drive/UNC on Windows); `maxParallelJobs` 1–64 (default 1); `allowedRuntimes` ⊆ protocol `RuntimeKind`, no duplicates; `logLevel`; `keystore` (`file` default). `dataDir` may not equal or sit inside `workspaceRoot` (agents can write there). Errors list every issue with its path; exit code 78 (`EX_CONFIG`) so service managers do not restart-loop.
8. **Permissions (POSIX):** refuse a world-writable config file or config directory, or one owned by a uid other than the worker user/root; create `dataDir` 0700 and refuse it if group/other-writable or foreign-owned; refuse a world-writable `workspaceRoot` if it exists.

### State machine

9. Pure `transition(status, event, limits)` over the ROADMAP states with explicit events: `connected_unenrolled`, `enrollment_approved`, `session_established`, `job_started`, `job_finished`, `drain_requested`, `drain_cancelled`, `disconnected`, `revoked`, `quarantine_cleared`, `update_started`, `update_finished`, `update_failed`. Status carries `runningJobs`, because jobs keep running while the worker is `offline` (a reconnect lands in `busy`). Guards: capacity, no update/enrollment/unquarantine with running jobs. Duplicate deliveries (second DRAIN, second disconnect, revoked while quarantined) are legal no-ops — the transport is at-least-once. `revoked` from any state → `quarantined`, left only by `quarantine_cleared` with zero jobs. `WorkerStateMachine` logs every change at info and every rejected event at warn and leaves the status unchanged. Tests enumerate every state × event × job count against an explicit expected table, plus seeded random walks checking invariants.
10. A `draining` worker that disconnects becomes `offline` and comes back `online`/`busy`; the master re-sends DRAIN (it owns drain intent). Documented trade-off rather than a persisted local flag.

### Durable store

11. **`state.json`** (Zod-validated, 0600): enrollment `{workerId, publicKey, enrolledAt}`, leases `{jobId, attemptId, epoch, expiresAt}` (ADR-0004), cursors `{lastMasterSeq, ackedOutboundSeq}` (ADR-0011). Every mutation is serialized and persisted before it resolves via **write temp (O_EXCL, 0600) → fsync → rename → fsync dir**. Windows: libuv's rename uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`; transient `EPERM/EACCES/EBUSY` (AV scanners, indexers) are retried with backoff up to 10 times; directory fsync is skipped (not supported). Leftover `*.tmp-*` files are removed on open.
12. **Fencing in the store:** a lease with a lower epoch than the one held for that job, or the same epoch with a different attempt, is rejected (`StaleEpochError`). The master cursor only moves forward (duplicates ignored); `resetMasterCursor()` is explicit.
13. **Corrupt state is never trusted:** an unparseable/invalid `state.json` is moved to `state.json.corrupt-<ts>`, the daemon starts empty and logs at error — leases must then be reconciled with the master (ADR-0004: reconcile, never blind rerun).
14. **Outbox** (`outbox.jsonl`): JSON lines `{seq, message}` appended with fsync, seq assigned durably and monotonically (derived from the file + acked cursor on open, so it survives restarts). A torn last line from a crash mid-append is dropped and the file rewritten; a failed append marks the file for rewrite before the next one (no glued lines). Bounded (10 000 entries / 8 MiB default): a full outbox throws `OutboxFullError` — backpressure, never silent drop. Ack = persist `ackedOutboundSeq` first, then trim/compact; a crash in between only leaves entries that are ignored on load.
15. Restored leases do **not** count as running jobs after a restart (the processes died with the daemon); they are logged at warn as "awaiting reconciliation".

### Device identity (ADR-0005)

16. Ed25519 via `node:crypto`. Public key = JWK `x` (raw 32 bytes, 43-char base64url = protocol `Ed25519PublicKey`); signatures 64 bytes = 86-char base64url (`Ed25519Signature`). Verified against RFC 8032 §7.1 test 1.
17. **Challenge payload is domain-separated:** the worker signs `"remana-worker-auth/v1\n" + nonce`, never a bare server-chosen string, so an AUTH signature cannot be repurposed (e.g. as a future key-rotation statement). *Proposed for `packages/protocol`* so master and worker share it.
18. **Fingerprint** for human comparison: `SHA256:` + SHA-256 of the raw public key in upper-case hex, 16 groups of 4.
19. **`DeviceKey`** keeps the `KeyObject` in an ES private field; `toJSON`/`String`/`inspect` render only public key + fingerprint. The private key crosses the `TransportPort` only as a `signChallenge(nonce)` callback.
20. **Keystore:** `FileKeystore` at `<dataDir>/device-key.json` (PKCS#8 DER base64 + public key, created 0600 with O_EXCL via the atomic writer). On POSIX `load` refuses a symlink, a foreign-owned file, any group/other permission bit, and a group/other-writable directory (`InsecurePermissionsError` with a `chmod`/`chown` remedy), and checks the stored public key matches the private key. `MacKeychainKeystore` and `WindowsDpapiKeystore` exist only as typed stubs that reject with `KeystoreUnavailableError` — not faked. Config `keystore` selects the backend; choosing an OS backend fails closed (exit 78).
21. **Pairing code** `XXXX-XXXX` from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (protocol `PairingCode` minus I/O), `crypto.randomInt`, 40 bits; displayed with the fingerprint in the startup log when not enrolled.

### Daemon skeleton

22. `remyral-worker run`: load config → logger + `Redactor` → open store (report temp cleanup, corrupt state, torn outbox) → keystore → load-or-generate key → `WorkerDaemon.start()` in `offline` → wait for shutdown. If the stored enrollment belongs to a different public key (keystore lost/replaced) the enrollment and its leases are cleared: re-pair (ADR-0005 consequences).
23. **Transport port** (`start(options, onEvent)`, `send`, `stop`): events `connected{enrolled}`, `disconnected`, `message{MasterToWorker}`. The daemon maps them onto the state machine and handles `ENROLL_APPROVED` (persist identity), `DRAIN`, `ERROR revoked` (quarantine + stop transport) and `ERROR upgrade_required` (logged; self-update is p2-signed-updates); other messages are logged as not handled yet. Every processed master message advances `lastMasterSeq`. Events are processed strictly in order. `MemoryTransport` is the test fake; `run` uses `UnimplementedTransport` and logs that it stays offline — no pretend connectivity.
24. **Shutdown:** POSIX SIGINT/SIGTERM, Windows SIGINT/SIGBREAK; `requestStop()` is the placeholder hook for the Windows Service SCM stop (p2-service-windows). Shutdown is idempotent: stop transport → terminate every registered child tree in parallel (`ChildRegistry`, graceful then tree kill after 10 s; `OwnedProcess` from agent-adapters fits structurally) → drain queued events → flush store. New children are refused once shutdown began. A second signal forces exit. Exit 0, or 2 if a child could not be confirmed dead.
25. `remyral-worker identity show [--config | --data-dir] [--json]` prints fingerprint, public key and keystore location (never the private key); it generates the key on first use (ADR-0005 "on first start"), saying so on stderr.

## Tests

`packages/observability`: 70 (pattern table per rule, benign corpus, idempotence, ReDoS bound, encodings, deep redaction limits, every-boundary and character-by-character stream splits, 200 random chunkings, force-close, logger canaries in message/fields/child fields/errors/stacks). `apps/worker` new: config (schema matrix, per-OS locations, loader errors, POSIX permission refusals), state machine (exhaustive table + random walks), store (persistence, fencing, concurrency, crash before rename, torn temp, corrupt state, Windows rename retry, outbox replay/ack/bounds/torn tail/crash between ack and compaction/failed append), identity (formats, RFC 8032 vector, domain separation, fingerprint vector, no key leakage, 0600/0700, tamper, symlink/owner/mode refusals, OS stubs), daemon (enroll/drain/disconnect/signal flow, revocation, illegal events, identity mismatch, restored leases, real child-tree termination), CLI (`identity show`, `run`, exit 78, option validation). Smoke: bundled `identity show` and `run` + SIGTERM.

## Security review

| Threat | Mitigation in this task | Residual / follow-up |
|---|---|---|
| T-SEC-1 secrets in logs/events | Logger has no unredacted path; exact + pattern + key-name redaction; streaming redactor for LOG_CHUNK data; canary tests on messages, fields, errors, stacks, stream splits | Unknown-format secrets with no context are not caught (ADR-0006 consequence); master pattern pass (p7) and p7-secrets-scan compensate. `p3-secrets-worker` must register every injected secret in the `SecretSet` |
| T-SEC-1 via crash output | CLI prints only `error.message` for unexpected daemon errors; logged errors are redacted | Node's own fatal handler output (uncaught exception outside `main`) is not redacted |
| T-WRK-1 stolen device key | Key file 0600, O_EXCL creation, owner/mode/symlink checks, dir 0700; key never logged/serialized; challenge domain separation | File keystore is readable by root/the service user; OS keystores (Keychain/DPAPI/TPM) **UNVERIFIED/not implemented**; Windows ACLs are the installer's job (**UNVERIFIED**) |
| T-WRK-1 rogue master via config tampering | `wss://` enforced (ws only loopback), no credentials in URL, config/dir not world-writable and owned by worker user/root, root reads only system location | Certificate pinning is a p2-transport decision |
| T-WRK-3 flooding / unbounded buffers | Outbox bounded with explicit `OutboxFullError`; config ≤ 64 KiB; state ≤ 1 MiB; logger depth/size bounds; stream hold bounded by `maxHold` | Rate limiting is master-side (p2-transport/p7) |
| T-WRK-5 rogue enrollment | Pairing code + fingerprint displayed together; code from CSPRNG | Expiry, single use and rate limiting are master-side (p2-pairing) |
| ADR-0004 duplicate side effects after restart | Leases persisted crash-safely; stale epochs rejected locally; restored leases never treated as running | Reconciliation protocol is p2-replay/p4-recovery |
| Data integrity after power loss | temp + fsync + rename + dir fsync; torn temp/outbox lines detected; corrupt state quarantined, not trusted | Directory fsync is skipped on Windows (NTFS metadata journaling assumed; **UNVERIFIED**) |
| Leftover child processes | `ChildRegistry` terminates all trees on shutdown; refuses new children during shutdown; failures reported (exit 2) | Hard kill of the daemon (SIGKILL/power loss) leaves process groups to the service manager (systemd `KillMode=control-group`, launchd, Job Objects in p3-sandbox) |

## Platform verification status

- **Verified on macOS (arm64, Node 24) by tests and smoke runs.** Linux uses the same POSIX paths; config locations and Windows path rules are unit-tested with injected hosts.
- **UNVERIFIED on Windows:** rename retry under real sharing violations, absence of directory fsync, SIGBREAK handling, service stop hook, ACL protection of the key file. **UNVERIFIED on Linux/Raspberry Pi** until CI/fleet runs (`p2-service-linux`, `p2-arm64`).

## Proposed protocol changes (not applied; `packages/protocol` is out of scope here)

1. Export the AUTH challenge payload (`remana-worker-auth/v1\n<nonce>`) and a `verifyChallenge` helper from `packages/protocol`, so master and worker cannot diverge.
2. Envelope doc: worker → master `seq` is durable and monotonic per worker **across reconnects** (it is the replay cursor), not "per connection".
3. Add a master → worker `ACK { throughSeq }` (or an ack field on an existing message) so the outbox can be trimmed during a session, not only at `SESSION_ESTABLISHED.resumeFromSeq` (p2-replay).

## Not in scope

WSS transport, pairing/approval flow on the master, heartbeat/capabilities, replay protocol, service installers, OS keystores, job execution.

## Rollback

New code paths only: `packages/observability` and the new `apps/worker/src/*` directories are additive; `probe` is unchanged in behaviour. Rollback = revert the commit. On a node, delete `dataDir` (`state.json`, `outbox.jsonl`, `device-key.json`); a new key means re-pairing.

## Operational metrics (for p2-heartbeat-caps / p7)

Log events to count: `illegal worker state transition rejected`, `stored enrollment does not match the device key`, corrupt state quarantine, outbox damaged entries, `OutboxFullError`, logger `droppedLines`, `child process could not be terminated`.
