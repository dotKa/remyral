# Design note: P2 worker transport, pairing, heartbeat, replay and identity rotation

- **Tasks:** `p2-transport` (this section set first), `p2-pairing`, `p2-heartbeat-caps`, `p2-replay`, `p2-identity-rotation`.
- **Date:** 2026-10-13
- **Binding inputs:** ADR-0004 (idempotency, fencing), ADR-0005 (outbound WSS, device identity, pairing, revocation, rotation), ADR-0011 (versioning), ADR-0013 (future multiplexed stream channel), threat model T-WRK-\*, T-CP-\*, `docs/design/p2-worker-core.md` (daemon core this plugs into).

## Problem

Workers sit behind NAT on residential networks. They must reach the master over one outbound connection, prove who they are with a device key that never leaves the machine, survive flaky links without losing or duplicating messages, and be revocable within a second. The master must expose this endpoint to the internet without it becoming an unauthenticated control surface (T-CP-1) or a DoS target (T-WRK-3).

## Shape

```
packages/protocol
  auth.ts        AUTH payload "remana-worker-auth/v1\n<nonce>", verifyChallenge, fingerprint   (subpath @remyral/protocol/auth)
  control.ts     ACK{throughSeq} (both directions), sequenced-type lists
  master-messages.ts  + ENROLL_PENDING, + error codes (pairing_invalid, enrollment_denied, credential_superseded, session_expired, overloaded)

apps/master/src/workers
  gateway.ts     GET /v1/worker (Fastify + @fastify/websocket 11.3.4 / ws 8.22.0), route auth level `device`, per-IP upgrade limit
  connection.ts  WorkerConnection: handshake, rate limits, validation, ordered processing, ping, re-auth
  hub.ts         live connections by workerId (replace, disconnect, closeAll)
  types.ts       DeviceDirectory (who may connect) and WorkerSessionHandler (what a session does) ports

apps/worker/src/transport
  port.ts        TransportPort (+ refreshable ConnectParams, backpressure-aware event handler)
  ws.ts          WsTransport: outbound wss, handshake, validation, bounded two-lane send queue, read pause, ping, backoff
```

## p2-transport decisions

### Endpoint and authentication boundary

1. **One route, `GET /v1/worker`, route auth level `device`.** The human-session hook skips it; the device authenticates in-band. The route-coverage test (`apps/master/test/integration/route-coverage.test.ts`) carries an explicit, documented `DEVICE` allowlist with exactly this route, and asserts that a plain HTTP request gets **426** with no data. Any other route declaring `device` fails that test (it would not answer 401).
2. **Nothing but HELLO, then AUTH, before authentication.** A `WorkerConnection` starts in phase `hello`; any other message type, any invalid frame, or no HELLO within 10 s closes the socket (4401 / 4400 / 4408) after an `ERROR`. Unauthenticated peers get zero tolerance for malformed input; authenticated ones get `maxInvalidFrames` (10) before 4400.
3. **Proof of possession first, directory second.** HELLO carries the public key; the master answers with `CHALLENGE{nonce}` (32 random bytes, single use, 30 s timer). The worker signs `"remana-worker-auth/v1\n" + nonce` (shared helper in `@remyral/protocol/auth`, so neither side can drift; the domain prefix keeps an AUTH signature from ever being valid as a rotation statement). Only after the signature verifies does the master consult the `DeviceDirectory` (p2-pairing) — so even pairing requests prove key possession. The nonce is consumed on the first AUTH (right or wrong); a replayed or foreign nonce fails. Bad signatures are audited (`worker.auth` denied, fingerprint + IP).
4. **Session bound to the connection, ≤ 15 min (ADR-0005 §4).** There is no bearer token at all: the session *is* the authenticated socket. `SESSION_ESTABLISHED.sessionExpiresAt` = now + 15 min; one minute before, the master sends a fresh `CHALLENGE` in-band; a valid AUTH (and a still-active credential in the directory) renews the session (`SESSION_ESTABLISHED` without `resumeFromSeq`), otherwise `ERROR session_expired` + 4401. Revocation (p2-identity-rotation) does not wait for this: it closes the socket immediately.
5. **One live connection per worker.** A newer authenticated connection replaces the older one (close **4409**), which handles NAT rebinding where the old TCP flow is half-dead.
   - **p5-live-fixes-2.** HELLO carries an optional `instanceId`: a random id per worker process, kept across reconnects. The 4409 reason and the `worker.session.end` audit say which case it was:
     - "worker reconnected; the previous connection had gone stale": the same process reconnected. Cloudflare can cut the worker's leg without a close frame (worker sees 1006); the worker reconnects within about 1 s, but the master's ping needs up to 45 s to notice the dead socket.
     - "replaced by another process using this worker's key": another process, logged at warn. A worker that receives 4409 can only have lost its connection to another process, since its own superseded socket is ignored. It warns and waits the full backoff (60 s) instead of fighting for the connection every few seconds.
   - **`pairOnly` (`remyral-worker pair`).** A pair-only HELLO is answered with ENROLL_APPROVED and closed with 1000, both for an already-enrolled key and after a pending approval. It never opens a session, so a CLI call cannot replace the running service's session.
   - **Live worker (desktop-pc, 2026-10-14).** The worker's own log shows only 1006 drops on its Cloudflare connection (edge 172.67.x), each followed by a reconnect within 1–3 s, about every 1–5 minutes between 19:05 and 19:18 UTC. No second process used the key: the `RemyralWorkerAdmin` and `RemyralWorkerUpdater` tasks run every minute but never open a worker WebSocket. So the "replaced" entries in Fleet history were the master recording the service's own reconnects. Now they are labelled as such.

### Versioning (ADR-0011)

6. HELLO lists `supportedVersions`; the master picks the highest common one (`negotiateProtocolVersion`) and echoes it in `SESSION_ESTABLISHED.negotiatedVersion`; no common version → `ERROR upgrade_required` + **4426**, and the worker backs off to the maximum delay (self-update is p2-signed-updates). Message additions in this task (ACK, ENROLL_PENDING, error codes) are additive within 1.0; nothing has shipped, so no version bump.

### Framing (room for ADR-0013 streams)

7. **Text frames carry exactly one JSON envelope**, validated with `parseFrame` against the direction schema (unknown fields stripped). **Binary frames are refused today (close 1003) and reserved** for the future `STREAM_*` data plane: a binary frame will carry `[u8 kind][u32 streamId][payload]`, opened/closed/flow-controlled by JSON control messages (`STREAM_OPEN{streamId, target}`, `STREAM_WINDOW{streamId, credit}`, `STREAM_CLOSE{streamId, reason}`). Credit-based per-stream windows mean a terminal/proxy stream can never starve control traffic, and the existing per-connection limits stay the outer bound.
8. **Size:** `maxPayload = MAX_FRAME_BYTES` (512 KiB) on both ends (ws closes with 1009), plus the `parseFrame` byte check; `LOG_CHUNK.data` ≤ 64 KiB keeps every legitimate message far below it. Senders refuse to build a larger frame (`FrameTooLargeError`). **Compression is off** (`perMessageDeflate: false`): no decompression bombs, no CRIME-style length oracle on mixed secret/attacker data.
9. **`seq` semantics** (documented in `envelope.ts`): `seq ≥ 1` = sequenced, durable across reconnects and restarts, per worker per direction; `seq = 0` = connection-scoped control message (HELLO, AUTH, CHALLENGE, SESSION_ESTABLISHED, ENROLL_*, HEARTBEAT, CAPABILITIES, ACK, ERROR, DRAIN, ROTATE_*). `ACK{throughSeq}` exists in both directions (p2-replay uses it to trim outboxes).

### Limits and backpressure (T-WRK-3)

10. **Per-IP upgrade limit** before any protocol work (`preValidation`, Redis fixed window, default 60/min) → HTTP 429 with `retry-after`; the worker backs off to the maximum.
11. **Per-connection token buckets**: 200 msg/s (burst 400) and 2 MiB/s (burst 8 MiB) inbound → `ERROR rate_limited` + **4429**.
12. **Ordered, bounded inbound processing on both sides.** Messages of one connection are handled strictly in order; when more than 256 (master) / 64 (worker) are outstanding, the receiver calls `ws.pause()` and resumes below 64 / 16. TCP flow control then pushes back on the sender — memory stays bounded without dropping anything.
13. **Bounded send side.** Worker: two lanes (control: HELLO/AUTH/ACK/HEARTBEAT/CAPABILITIES ahead of data), ≤ 1024 messages / 8 MiB queued, written only while < 1 MiB is in flight in the socket; a full queue rejects with `SendQueueFullError` (durable messages stay in the outbox and are replayed). Master: a worker whose socket buffer exceeds 8 MiB is not reading → close **4503**; sequenced messages are replayed after reconnect.

### Liveness and reconnect

14. WebSocket ping/pong both ways (worker every 20 s, master every 30 s; no pong within 10 s / 15 s → terminate). This also keeps NAT mappings warm. Application heartbeats (p2-heartbeat-caps) are separate: they carry state and drive "offline" on the master.
15. **Reconnect** with exponential backoff and *equal jitter* (`d = min(60 s, 1 s·2^n)`, wait `d/2 + rand·d/2`), reset only after a session stayed up ≥ 30 s (a flapping master is not hammered). 429 / 4426 / 4429 jump to the maximum delay. **4403** (revoked, denied) stops reconnecting entirely. The transport re-reads its `ConnectParams` (cursor, enrollment, key) before every attempt.

### TLS and URL rules

16. `wss://` with Node's default certificate verification, `rejectUnauthorized: true` and `minVersion: 'TLSv1.3'` hard-coded (not configurable); an optional extra trust anchor (`ca`) exists for a private CA, it never disables verification. `ws://` only to `127.0.0.1` / `localhost` / `[::1]` (dev) — enforced by the config schema and again by the transport. No redirects followed, no credentials/query in the URL. No certificate pinning (Coolify/Traefik rotates Let's Encrypt certificates); the device signature makes a MITM useless for impersonating a worker, and the master's identity rests on WebPKI.

### Close codes

| Code | Meaning | Worker reaction |
|---|---|---|
| 1001 | master shutting down | reconnect (backoff) |
| 1003 | binary frame | reconnect |
| 1009 | frame too big | reconnect |
| 4400 | protocol violation | reconnect |
| 4401 | unauthenticated / session expired / key superseded by a rotation | reconnect (with the rotated key, if any) |
| 4403 | revoked, enrollment denied | **stop**; daemon acts on the preceding ERROR |
| 4408 | handshake / pairing timeout | reconnect |
| 4409 | replaced by a newer connection (reason names own reconnect vs another process) | reconnect; full backoff when another process took over |
| 4426 | upgrade required | reconnect at max backoff |
| 4429 | rate limited | reconnect at max backoff |
| 4503 | overloaded / too slow | reconnect |

### Multi-replica note

`WorkerHub` is per process. With more than one master replica, revocation, approval and drain must be fanned out (Redis pub/sub keyed by workerId) — a follow-up for p7-ha; today the master runs as one replica.

## Tests (p2-transport)

- `packages/protocol/test/auth.test.ts`: domain separation, RFC 8032 vector, fingerprint vector, never-throws, sequencing classification.
- `apps/master/test/integration/worker-gateway.test.ts` (raw protocol client against the in-process master): 426 for plain HTTP; HEARTBEAT before HELLO, ACK before AUTH, invalid JSON, binary and oversized frames, unsupported version (4426), bad signature (audited), replayed nonce, unknown key, session bound to workerId (spoofed workerId → 4400), replacement (4409), pending socket accepts nothing, per-connection flood (4429), shutdown (1001), HELLO timeout (4408), per-IP upgrade limit (HTTP 429), in-band re-auth renew / expire, re-auth refused after the key is deactivated.
- `apps/master/test/integration/route-coverage.test.ts`: `DEVICE` allowlist.
- `apps/master/test/integration/worker-transport.test.ts`: real `WsTransport` ↔ real gateway: session, message, server-side drop, automatic reconnect.
- `apps/worker/test/transport-ws.test.ts` (scripted fake master): URL rules, backoff/jitter, HELLO contents, signature, pending → approved without a second `connected`, re-auth and nonce reuse, invalid-frame budget, binary, pre-session messages, oversized frames, reconnect with refreshed cursor, no reconnect after 4403, ping timeout, read pause + in-order delivery, bounded send queue, outgoing size/validity, TLS: self-signed refused, accepted only as explicit `ca`.

## Security review (p2-transport)

| Threat | Mitigation | Residual / follow-up |
|---|---|---|
| T-CP-1 unauthenticated control endpoint | `/v1/worker` does nothing before key proof except answer HELLO with a CHALLENGE; route-coverage allowlist; no human-session bypass (the route exposes no REST) | Pre-auth cost: one Ed25519 verify per connection, bounded by the per-IP upgrade limit |
| T-WRK-1 impersonation | Challenge-response over a fresh single-use nonce with domain separation; session bound to the socket; in-band re-auth every 15 min re-checks the credential | Key theft from disk is out of scope here (keystore, p2-worker-core) |
| Replay of a captured AUTH | Nonce is random per connection and consumed on first use; TLS hides it anyway | — |
| T-WRK-3 flooding / oversized messages | Per-IP upgrade limit, per-connection msg/byte buckets, 512 KiB frames, no compression, invalid-frame budget, bounded queues, read pause, slow-consumer cut-off | Many IPs (botnet) can still open many sockets; ingress-level limits (Traefik) in p7-rate-limit |
| MITM / rogue master | TLS 1.3 with verification hard-wired on; no plaintext except loopback; no redirects | A compromised public CA could MITM the master identity; the device signature still cannot be forged; pinning deliberately not used (cert rotation) |
| Message smuggling | Zod schemas strip unknown fields; envelope `workerId` must match the session | — |
| Secrets in logs | Transport logs never include nonces, signatures or pairing codes; the worker logger redacts | — |
| Resource leaks | All timers cleared on close; closing handshake bounded (1–2 s then terminate); master shutdown closes sockets (1001) before the HTTP server drains | — |

## p2-pairing decisions

17. **Schema (migration `0004_workers.sql`):** `workers` (state per ROADMAP, quarantine reason, last HELLO facts, pairing hash/expiry/failures, approve/deny/revoke/drain bookkeeping, connectivity, capability summary), `worker_credentials` (one row per device key: `pending → active → superseded | revoked`, or `denied`; unique `public_key`; at most one `active` per worker; `rotated_from` + `rotation_signature` for p2-identity-rotation), `worker_runtimes` (p2-heartbeat-caps). Worker ids are `wrk_` + 26 base32 characters (128 random bits).
18. **Pairing request = proven key + code.** An unknown key with a pairing code (after AUTH verified) creates a `pending` worker and a `pending` credential and gets `ENROLL_PENDING{fingerprint, expiresAt}`; the socket stays open, accepts nothing else and is closed when the request expires (10 min). A worker restarted with a new code during/after the window renews the request (same key, new code, new window, audited). Requests are rate limited per IP (5 / 10 min, Redis) and fleet-wide (≤ 20 unexpired pending), serialised by an advisory lock. Codes are stored as SHA-256 (domain-separated), never in clear, and stay recorded after use: **a code is single-use forever**.
19. **Approval requires the code, not just a click.** `POST /workers/:id/approve {pairingCode}` (full session + step-up ≤ 10 min, CSRF): the admin types the code printed by `remyral-worker pair` and compares the fingerprint shown in the console with the one printed on the machine. This proves the admin is looking at *that* machine, which a fingerprint glance alone does not. Codes compare case/space-insensitively in constant time; 5 wrong codes deny the enrollment automatically (`quarantined / pairing_failed`). Expired requests answer 409 `pairing_expired`.
20. **Approval completes on the waiting socket.** After the commit the waiting connection receives `ENROLL_APPROVED{workerId}` and then `SESSION_ESTABLISHED` — no reconnect. A worker that was offline at approval time and still presents its code gets `ENROLL_APPROVED` before `SESSION_ESTABLISHED` on its next connect. Later connects are plain challenge-response.
21. **Deny** (`POST /workers/:id/deny`, step-up) quarantines the worker (`enrollment_denied`), marks the credential `denied` (the key is refused forever: `ERROR enrollment_denied` + 4403) and closes the live socket.
22. **REST:** `GET /workers` (pending first; state, fingerprint, platform, last seen, expiry), `GET /workers/:id` (+ credential history, runtimes). Malformed ids are 404 before touching SQL. All routes are `full` session routes (covered by the route-coverage test).
23. **Worker CLI:** `remyral-worker pair [--master <url>] [--config <path> | --data-dir <dir>]` loads/creates the device key, prints the code and fingerprint on stdout, connects with the code, prints "waiting", persists `{workerId, publicKey, enrolledAt}` on `ENROLL_APPROVED` and exits 0; denied/expired/refused exit 1, Ctrl-C 130, bad options/URL 78. Already enrolled → exit 0 without contacting the master. `remyral-worker run` still pairs too (code in the log), for headless installs.
24. **Fleet screen** (`apps/web/src/shell/FleetPage.tsx`) replaces the empty state: pending workers first with host, platform, full fingerprint, expiry, a pairing-code field and Approve/Deny (step-up dialog on `403 step_up_required`), then the worker table; polls every 5 s.
25. **Audit:** `worker.pairing.request` (success/denied with reason: rate_limited, code_reused, too_many_pending), `worker.approve` (success / denied with failure count), `worker.deny`, `worker.session.start` / `.end`, `worker.auth` denied.

### Tests (p2-pairing)

`apps/master/test/integration/worker-pairing.test.ts`: real `pairWorker` against the in-process master (pending with matching fingerprint → wrong code 400 → approve with lower-case code → identity persisted, credential active, audit trail); 401 without session, 403 without fresh step-up, 409 after expiry; approval on the waiting socket then reconnect with challenge only; deny → 4403 and the key refused forever; auto-deny after 5 wrong codes; single-use codes; unknown key without code; 404s; per-IP pairing rate limit (4429). `apps/worker/test/cli-pair.test.ts`: output, HELLO with code, identity stored, already-enrolled, denied (1), interrupted (130), option validation (78). `apps/web/test/fleet.test.tsx`: empty state, pending card with fingerprint, approve with code through the step-up dialog, CSRF header.

### Security review (p2-pairing)

| Threat | Mitigation | Residual |
|---|---|---|
| T-WRK-5 rogue enrollment | Admin must enter the code shown on the machine *and* see the fingerprint; key possession proven before any row is written; per-IP + fleet-wide limits; 10-min expiry; single-use codes; 5-strike auto-deny; step-up + CSRF on approve/deny | An admin who approves without comparing the fingerprint *and* is socially engineered into typing an attacker's code is not prevented |
| Pairing code brute force | 40-bit codes, guesses only via the authenticated admin API, 5 wrong → denied | — |
| Pending-row flood (DoS on the table/UI) | ≤ 20 unexpired pending fleet-wide, per-IP limit, audit of refusals | Expired pending rows remain until denied (cleanup job in p7-retention) |
| Code disclosure from DB | Stored as SHA-256 only; a used code is worthless | 40-bit hash is brute-forceable offline, but the code is single-use and expires |
| Denied/revoked key reconnecting | Credential status checked after AUTH on every connect; 4403 stops the worker's reconnect loop | — |

## p2-heartbeat-caps decisions

26. **States (ROADMAP P2) on the master:** `pending` (enrollment waiting), `online` (session up), `busy` (worker reports running jobs), `draining` (admin intent; wins over online/busy), `offline` (no session, or missed heartbeats), `quarantined` (denied / pairing failed / revoked), `updating` (worker reports it). Transitions: session start → online|draining; HEARTBEAT → online|busy|updating (draining if intent); session end with no newer connection → offline; sweep → offline. Quarantined is never overwritten by sessions or heartbeats.
27. **HEARTBEAT** every 15 s (control message, seq 0): `state` from the worker's own state machine, `runningJobs` (empty until p3/p4 run jobs), `load` (1-min load average per core, free memory, free disk of the data dir). The master stores `last_seen_at`, `running_jobs`, `load`. The worker also sends an immediate heartbeat after DRAIN.
28. **Offline by missed heartbeats:** a sweeper (every 5 s) marks workers whose last heartbeat is older than **45 s (3 beats)** offline and closes their socket with **4408** (a half-open NAT flow looks connected but is dead); rows left online without any live connection (master restart) are marked offline too. Uses the injected clock, so tests drive it deterministically. Single-replica assumption (see multi-replica note).
29. **CAPABILITIES** at the start of every session: the worker runs its P0 probe once per hour (no self-test, no credentials) and maps each runtime's truthful capability record (ADR-0008) plus `pinnedVersion`/`pinStatus` (ADR-0012; additive optional protocol fields), the *ready* sandbox profiles and found tools. The master upserts `worker_runtimes` keyed by **(worker, runtime, version, os, arch)** — os/arch from the authenticated HELLO facts — marks rows not in the newest report `present = false` (history kept as compatibility evidence), and stores profiles/tools/maxParallelJobs on the worker.
30. **DRAIN** (`POST /workers/:id/drain {reason?}`, step-up, audited `worker.drain`): persists `drain_requested_at` (admin intent survives reconnects), sets `draining`, sends `DRAIN` to a live session and **re-sends it on every new session** (p2-worker-core #10: the worker does not persist drain). Pending/quarantined workers cannot be drained (409). Un-draining is a follow-up (needs a protocol message; the worker state machine already has `drain_cancelled`).
31. **Fleet screen:** state badge, last seen, platform, fingerprint; a row expands to fingerprint, version, running jobs, the present runtimes with version, **pin status** (mismatch shows the pinned version) and auth status, and a Drain action (step-up).

### Tests (p2-heartbeat-caps)

`apps/master/test/integration/worker-heartbeat.test.ts` (real paired daemon + WsTransport): online with last seen, load, profiles, tools and runtimes with pin status; drain → worker draining → reconnect → DRAIN re-sent; capability history per version; silent session → sweep after 46 s → 4408 + offline; drain refused for pending / without step-up. `apps/worker/test/telemetry.test.ts`: CAPABILITIES + periodic HEARTBEATs only during a session, draining reported, stop on disconnect, probe mapping, load bounds. `apps/web/test/fleet.test.tsx`: details panel with runtimes/pin status, drain.

### Security review (p2-heartbeat-caps)

| Threat | Mitigation | Residual |
|---|---|---|
| T-WRK-2 worker lies about capabilities/state | Reports are informational; stored per authenticated worker only (envelope workerId bound to the session); schema-bounded (16 runtimes, 128 tools); scheduler (p4) must still verify results | A compromised worker can claim runtimes it lacks → jobs fail, no privilege gain |
| T-WRK-3 heartbeat flooding | Covered by per-connection rate limits; each heartbeat is one bounded UPDATE | — |
| Hidden dead connections | 45 s sweep + WebSocket ping both ways | — |
| Info disclosure in load/facts | Only coarse numbers and host facts the admin already sees; no paths, env or credentials | — |

## p2-replay decisions

32. **Two independent sequences per worker**, both durable (migration `0006_worker_replay.sql`): worker → master seq lives in the worker outbox (`outbox.jsonl`, fsynced before the producer continues), master → worker seq in `workers.next_master_seq` + `worker_outbox`. Only the sequenced types carry `seq ≥ 1` (protocol `SEQUENCED_*_TYPES`); control messages are `seq = 0` and never replayed.
33. **Resume cursors both ways.** `HELLO.resumeFromSeq` = highest master seq the worker processed (persisted with `recordMasterSeq`); `SESSION_ESTABLISHED.resumeFromSeq` = `workers.last_worker_seq`. Each side treats the peer's cursor as an implicit ACK (trim) and replays everything after it, in order.
34. **Exactly-once effect on the master** (at-least-once delivery + idempotent apply, ADR-0004 §4): every sequenced message is applied in **one transaction** with `SELECT … FOR UPDATE` on the worker row, the inbox write (`InboxSink`, default journal `worker_inbox`, unique per (worker, seq) and (worker, messageId)), the cursor advance and the dedupe record. Duplicates — same messageId (bounded window of the last 1024 per worker, `worker_processed_messages`) or seq ≤ cursor — are acknowledged without effect; a **messageId reused with another seq** is a protocol violation (4400); `seq = 0` on a sequenced type is a violation.
35. **Out-of-order delivery** (cannot happen on one ordered socket, but can across a replaced connection or a buggy peer): messages ahead of a gap wait in a per-session reorder buffer (≤ 256) and are applied as soon as the gap fills; overflow closes with 4503 so the worker reconnects and resumes from the cursor.
36. **ACK{throughSeq}** (control) is coalesced (50 ms) in both directions. The worker trims its outbox (`ackOutbound` persists the cursor before compacting); the master trims `worker_outbox`. An ACK beyond anything sent is a violation on the master and ignored (logged) on the worker.
37. **Ordered pumps.** Both sides send their outbox through a single per-session pump that reads "everything after the last sent seq" — new messages and replays can never interleave out of order. The worker pump stops at the first failed send (`NotConnectedError`, `SendQueueFullError`) and resumes on the next ACK, new message or session. The transport now also fails frames that were handed to the socket but never confirmed when the connection closes, so a sender can never wait forever (found by the drop-mid-stream test).
38. **Lost local state.** If the master's cursor is ahead of the worker's numbering (state dir reset but key kept), the worker fast-forwards its outbox numbering past it (`resumeOutbound`) instead of having new messages swallowed as duplicates.
39. **Bounds:** worker outbox 10 000 entries / 8 MiB (`OutboxFullError` = backpressure to the producer), master outbox 10 000 unacknowledged messages per worker (`MasterOutboxFullError`), dedupe window 1024, reorder buffer 256.

### Tests (p2-replay)

`apps/master/test/integration/worker-replay.test.ts`: real daemon sends 60 events while the master kills the socket after the 25th → inbox has exactly seq 1–60 once, in order, worker outbox drained; events queued with the network down and across daemon restarts are replayed; raw client: duplicate frames (same messageId) → one row + ACK, seq 3 before 2 → applied 1, 2, 3, old seq with new messageId ignored, messageId reused with another seq → 4400, sequenced seq 0 → 4400; master → worker: live delivery with seq/jobId, offline enqueue, reconnect with `resumeFromSeq: 1` replays only 2 and 3 in order, ACK trims, ACK beyond sent → 4400; real daemon processes 12 queued master messages once, in order (regression for a text-vs-number ordering bug), nothing re-processed after a reconnect. `apps/worker/test/replay.test.ts`: durable queueing before a session, replay after the resume cursor, ACK trimming, restart from disk, fast-forward, master duplicates ignored and acknowledged, control messages never move the cursor.

### Security review (p2-replay)

| Threat | Mitigation | Residual |
|---|---|---|
| ADR-0004 duplicate side effects | Apply-once in one transaction with the cursor; dedupe by messageId and seq; job-level fencing (epoch) stays the second line in p4 | The journal sink records, it does not act; p4 must keep effects inside the same transaction or fence them |
| T-WRK-3 replay flooding / memory | Reorder buffer and outboxes bounded; violations close the socket | A worker may legitimately hold 8 MiB of backlog; master processing is per-message transactions (throughput measured in p7-load) |
| Message forgery across workers | Session-bound workerId (p2-transport); cursors per worker | — |
| Log data in the inbox | LOG_CHUNK must assert `redacted: true` (schema) and is redacted by the worker; the master stores it as received | Master-side pattern redaction pass is p7 |

## p2-identity-rotation decisions

40. **Revoke** (`POST /workers/:id/revoke {reason?}`, step-up, audited `worker.revoke` with the revoked fingerprints): one transaction quarantines the worker (`revoked`), marks every active/pending credential `revoked` and clears any rotation request; after the commit the hub sends `ERROR revoked` and closes the socket with **4403** (measured < 1 s in tests, ADR-0005 verification). The daemon quarantines itself and stops its transport (4403 also stops the reconnect loop). Every later connect proves the key, then gets `ERROR revoked` + 4403 — also with a pairing code, so a revoked key can never re-enroll. A revoked worker needs a new key and a new pairing.
41. **Rotation request** (`POST /workers/:id/rotate`, step-up, worker must be online): the master stores the SHA-256 of a fresh 32-byte nonce with a 10-minute deadline and sends `ROTATE_CREDENTIAL{deadline, reason, nonce}` (nonce: additive optional field). If the worker reconnects before answering, the next session gets a *new* nonce (only hashes are stored).
42. **Rotation statement** (`@remyral/protocol/auth`): `"remana-worker-rotate/v1\n" + workerId + "\n" + oldPublicKey + "\n" + newPublicKey + "\n" + nonce`, signed by **both** keys and sent as `ROTATE_KEY{nonce, newPublicKey, oldKeySignature, newKeySignature}`. The old key vouches for continuity; the new key proves possession (nobody can rotate a worker onto someone else's key); worker id + both keys + nonce bind it to this one request. The domain prefix differs from the AUTH prefix, so an AUTH signature can never be a rotation statement (tested). The master additionally requires the session's own key to be the worker's active credential, an unexpired matching nonce (constant-time compare) and an unused new key. **The nonce is single use — consumed by success *and* by any refused attempt.** The old key's signature is stored with the new credential (`rotation_signature`, `rotated_from`) for later audit.
43. **Policy** `WORKER_ROTATION_REQUIRES_APPROVAL` (master env, default `false`): `false` → the new key is `active` at once and the old one `superseded`; `true` → the new key is `pending`, the worker keeps working with the old key, and `POST /workers/:id/approve-rotation` (step-up) activates it. The master answers `CREDENTIAL_ROTATED{fingerprint, status: active | pending_approval}`, and sends `active` again on approval if the worker is connected. Default rationale: the old key's signature already proves continuity; requiring approval is for fleets that want a human in every key change (documented trade-off: a stolen key can rotate itself away without approval — the legitimate worker then gets `credential_superseded`, which is logged loudly, and the admin revokes).
44. **Worker key handling is crash safe:** the next key is written (`device-key.next.json`, 0600, O_EXCL via the atomic writer) *before* `ROTATE_KEY` is sent and reused on retries; on `CREDENTIAL_ROTATED active` the worker verifies the fingerprint is its own next key, persists the enrollment for the new key **first**, then renames the next key over the current one (atomic) and reconnects with it. A crash between the two steps is completed on start (identity matches the next key → promote). If the master already activated the new key while the worker was away, its old key gets `ERROR credential_superseded` (close **4401**, not 4403, so the worker keeps reconnecting); the worker promotes its next key and the next attempt succeeds. Without a next key it stops and asks for re-pairing. `rotation_refused` discards the next key.
45. **Fleet screen:** the details panel lists the device keys with their status and offers *Rotate key* (connected workers), *Approve new key* (when one is pending) and *Revoke* (two-step confirmation, then step-up).

### Tests (p2-identity-rotation)

`apps/master/test/integration/worker-identity.test.ts`: revoke → daemon quarantined in < 1 s, credentials revoked, no automatic reconnect, same key refused (4403) also with a pairing code, double revoke 409, rotate on a revoked worker 409; rotation without approval → worker reconnects with a new key file and identity, credentials `[active new, superseded old]`, old key refused with `credential_superseded`, audit trail; forged statements → `no_outstanding_request`, `bad_signature` (old-key signature missing), nonce consumed by the failed attempt; approval policy → `pending` + old key still in use → approve → switch, second approve 409. `apps/master/test/integration/worker-lifecycle.test.ts`: the whole P2 path pair → approve → challenge → heartbeat → drop mid-stream → 40 log chunks exactly once → revoke < 1 s → refused. `apps/worker/test/rotation.test.ts`: next-key storage (idempotent, 0600, atomic promote, discard), statement verifies with both keys, pending vs active, foreign fingerprint ignored, superseded with/without next key, refused rotation discards, interrupted rotation completed on start. `packages/protocol/test/auth.test.ts`: statement binding and domain separation.

### Security review (p2-identity-rotation)

| Threat | Mitigation | Residual |
|---|---|---|
| T-WRK-1 stolen key keeps working | Revoke closes the socket at once and refuses the key forever (also for re-pairing); in-band re-auth re-checks the credential every 15 min anyway | Single replica: revocation fan-out to other master replicas is p7-ha |
| Rotation hijack (attacker rotates the worker onto their key) | Needs the current key (old-key signature *and* an authenticated session with it), a fresh admin-requested single-use nonce, step-up for the request, and proof of the new key | An attacker holding the current key can rotate it when an admin requests a rotation; the approval policy closes this, and the real worker's `credential_superseded` alarm reveals it |
| Statement replay / cross-protocol reuse | Bound to worker id, both keys, nonce; distinct domain prefix from AUTH; nonce single use even on failure | — |
| Key loss during rotation | Next key persisted before announcing it; ordered persistence; completion on restart; superseded fallback | Lost keystore ⇒ re-pair (ADR-0005 consequence) |
| Rotation request flooding | Admin-only, step-up, one outstanding request per worker, refused while a rotated key awaits approval | — |

## Platform verification

- **Verified on macOS arm64 (Node 24):** all unit/integration tests, and a smoke run with a real master process (throw-away database) plus the bundled `remyral-worker pair` and `remyral-worker run` on this Mac over `ws://127.0.0.1:8180` (8080 was taken by another local process): pending worker with matching fingerprint → approved through the REST API → `pair` exit 0 → `run` online with the real probe's runtimes and pin status (`claude-code` mismatch, `codex`/`opencode` match, `openhands` not installed, `pi` mismatch), tools, last seen → SIGTERM exit 0 → offline.
- **UNVERIFIED:** Linux/Raspberry Pi/Windows worker transport (CI matrix runs the unit tests; real fleet runs are the P2 gate), `wss://` through Coolify/Traefik (TLS 1.3 and certificate verification are tested only against a local self-signed server), CPU load on Windows (`loadavg` is 0 there), multi-replica master fan-out.

## Rollback

All additive (new routes, modules, protocol messages and optional fields, migrations 0004/0006 that only add tables/columns). Rollback = revert the commits; the migration runner refuses to start an older master on a database that has 0004/0006 applied (forward-only), so roll back the code together with a restored database backup, or keep the schema and roll forward. Workers of an older build stay offline (`UnimplementedTransport`). Revoked/rotated credentials stay valid history.

## Operational metrics

Worker: `WsTransport.stats` (connects, sessions, disconnects, invalidFrames, pausedReads, queueFull) and log events `disconnected from master; reconnecting`, `master did not answer ping`, `protocol violation by master`. Master logs: `worker rate limit exceeded`, `worker protocol violation`, `worker too slow; disconnecting`, `worker connection closed` (code, reason); audit `worker.auth` denied, `worker.session.start` / `.end`.

## p5-fleet-archive decisions

Owner request 2026-10-14: a denied enrollment stayed in Fleet as `quarantined` / "never seen" forever with no way to remove it. Workers are **archived** (removed from the list), never deleted — the row, its credentials and the audit trail must stay (ADR-0004/ADR-0009: audit history is append-only and every `target` keeps resolving).

44. **Schema (migration `0026_worker_archive.sql`):** `workers.archived_at`, `workers.archived_by` (user, `ON DELETE SET NULL`; `archived_by` only with `archived_at`). Archiving is orthogonal to the P2 state (decision 26): the state is not changed and no new state is added.
45. **Who can be archived** (`POST /workers/:id/archive`, admin action `workers.archive`, step-up, CSRF): a worker that can never work again — `quarantined` (any reason: `enrollment_denied`, `pairing_failed`, `revoked`) or `offline` without any `active`/`pending` credential (only revoked/superseded/denied keys). Refused with 409: `pending` (`not_archivable`, deny it first), any socket in the hub, also one waiting for approval (`connected`), an enrolled worker with a usable key (`not_archivable`: revoke it first — we refuse rather than revoke implicitly, so removal can never cut off a working machine), an unreleased lease, an open attempt or reported running jobs (`has_work`), already archived (`already_archived`). The checks run in the transaction that holds the worker row lock.
46. **Effect:** excluded from `GET /workers` (default), `GET /fleet/overview`, placement candidates (orchestrator, and therefore composer preview and interactive admission), the `worker.offline_with_work` alert rule, the offline-with-leases notification and the `workers` state gauge. `GET /workers?archived=1` lists only archived workers; `GET /workers/:id` and `/history` still work (detail carries `archivedAt`). Credentials are not touched: a denied/revoked key stays refused by the directory, so a new pairing from the same device is still refused and cannot resurrect or duplicate the worker.
47. **Unarchive** (`POST /workers/:id/unarchive`, same action/step-up) clears both columns (`409 not_archived` otherwise); the worker returns to the list in its unchanged state. Audit: `worker.archive` (metadata `state`, `reason` = quarantine reason or `no_usable_key`) and `worker.unarchive`, both on the Fleet timeline.
48. **Web:** eligible workers get **Remove from list** (two clicks + step-up, with a notice that nothing is deleted); a **Show archived** toggle lists archived workers with **Unarchive**. The UI eligibility check is a hint; the master decides.

### Tests (p5-fleet-archive)

`apps/master/test/integration/worker-archive.test.ts`: denied enrollment → 401 without session, 409 while pending, 403 with stale step-up, archive → hidden from `/workers`, `/fleet/overview`, listed by `?archived=1`, detail/history still work, same key re-pair refused `enrollment_denied`, audit with actor, unarchive + audit, double archive/unarchive 409; online worker 409 `connected`, offline enrolled 409 `not_archivable`, revoke → archive → key still refused; revoked worker holding a lease 409 `has_work`; key-less offline worker archived; archived worker absent from placement candidates, the offline-with-work alert and notification while a non-archived control fires. `rbac-matrix.test.ts` (new action) and `route-coverage.test.ts` (new routes). `apps/web/test/fleet-archive.test.tsx`: confirm + step-up + CSRF, removal from the list, Show archived + Unarchive, eligibility rules.

### Security review (p5-fleet-archive)

| Threat | Mitigation | Residual |
|---|---|---|
| Hiding evidence of a compromised worker | Nothing is deleted; audit events and credentials stay; archive/unarchive are themselves audited with the actor; archived workers are listed with `?archived=1` | An admin can hide a dead worker from the default view (by design) |
| Archive used to bypass a denial (re-pair the same key) | Credentials untouched: denied/revoked keys stay refused by the directory | — |
| Removing a worker that still works or holds work | Only quarantined or key-less offline workers; not connected; no leases/open attempts; row lock; admin + step-up + CSRF | — |

Rollback: migration 0026 only adds nullable columns; an older master ignores them, but it would list archived workers again.

