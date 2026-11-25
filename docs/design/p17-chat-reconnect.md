# Design note: `p17-chat-reconnect` — chat turns survive a brief worker reconnect; reconnect reasons become visible

- **Task:** `p17-chat-reconnect`. **Date:** 2026-10-27. **Migration:** `0175_worker_disconnects.sql`.
- **Builds on:** p5-ops-chat (assistant host, ASSISTANT_UPDATE numbered per turn), p5-live-fixes-2 (HELLO
  `instanceId`, "newer connection replaces the existing one"), p15-chat-failover (re-run once on the next machine when
  the turn did not act), p2-transport (ping / pong liveness).
- **No new ADR:** no new trust boundary. The new master → worker message is a control message on the authenticated
  session, sent only to the worker process the turn already runs on; the new HELLO field is the worker's own
  diagnostics.
- **Worker release needed** for both parts (the master alone changes nothing for workers without
  `assistant-resume-v1`; older workers send no disconnect report).

## 1. Evidence (prod, 2026-10-27 UTC)

The Linux worker (1.1.6, 2 vCPU / 8 GB, idle) reconnected 8 times in 4 h. Each time the master logged "newer connection
replaces the existing one" (kind `reconnect`, same `instanceId`) and then "worker connection closed … the previous
connection had gone stale"; the new session was up ~1 s later. Three chat turns failed `assistant_disconnected` exactly
at a reconnect (one after 7 tool calls, so it was not re-run). Cause: `ChatService.onSessionEnd` failed every turn
bound to the ended connection at once, and the worker aborted its running turns on every transport `disconnected`
(`AssistantHost.onDisconnected`). Why the worker reconnected was only in the worker's own log.

## 2. How chat turn events flow (what had to change)

ASSISTANT_UPDATE is a **control** message (not in the durable outbox): the host numbers each turn's updates
(`seq` 1, 2, …) and the master drops `seq <= lastSeq`. Nothing was ever re-sent: an update written into a dead socket
was gone, and the worker's abort on a drop ended the turn anyway. Tool results (ASSISTANT_TOOL_RESULT) went over the
session the call arrived on.

## 3. Worker: keep the turn, keep its updates (`assistant-resume-v1`)

- `AssistantHost` keeps every update of a turn in a per-turn log (≤ 2 MiB; older entries dropped, `firstSeq` moves).
- Transport `disconnected` → running turns are **held**: they keep running, updates go to the log only. A tool call
  made while held waits past its 60 s timeout (re-armed while held); the hold bounds the wait.
- Finished turns keep their log for 60 s (`retainMs`: a stale socket swallows what was written during the last
  ping + pong window — the `done` may be among it) and while held.
- `ASSISTANT_RESUME {turnId, afterSeq}` (master → worker, control) → the logged updates with `seq > afterSeq` are sent
  again in order, then the turn continues live. The master's seq check makes each count exactly once.
- A turn the worker does not have (restarted, expired, log no longer reaching back to `afterSeq`) → `failed:
  assistant_disconnected` with seq `afterSeq + 1` (the master applies its usual rule at once).
- Not resumed within the hold (90 s, > the master's grace + reconnect) → the turn is aborted without another word.
- A new turn of the same thread while one is held → the master gave the held one up (it sends a thread's next turn only
  when none runs): the held turn is dropped and aborted, the new one runs (otherwise a retry from an older master
  would be refused `busy` for 90 s).
- A deliberate stop (`WorkerDaemon` shutdown) first reports running turns `failed: assistant_disconnected`, so the
  master never waits for a process that is going away.
- `resumeHoldMs: 0` restores the old behaviour (abort on drop).

## 4. Master: grace instead of instant failure

- `WorkerSession` now carries `instanceId` (HELLO). Each turn records the instance it was sent to.
- `onSessionEnd`: a bound turn whose worker advertises `assistant-resume-v1` and named its instance waits
  `reconnectGraceMs` (default **45 s**, `RECONNECT_GRACE_MS`; compose option `chat.reconnectGraceMs`) instead of
  failing. The thread stream gets `turn {state: 'reconnecting'}`; the snapshot says `reconnecting`.
- `onSessionStart` (new hook from `FleetSessionHandler`): turns of that worker that are held — **or still bound to an
  older connection whose end has not been processed yet** (the production order: the hub replaces the stale connection
  while the new session starts; the old close follows up to 1 s later) — continue when the instance matches: rebind to
  the new connection, send ASSISTANT_RESUME with `afterSeq = lastSeq`, re-send the kept tool results (last 8; the
  worker ignores calls it no longer waits for), publish `turn {state: running|sent}`. Another instance (a restart,
  another process with the key) → lost now.
- Grace over → lost as before. "Lost" is unchanged p15-chat-failover: `assistant_disconnected`, re-run once on the next
  machine only when the turn did not act, else the "already acted" line.
- Tool results now go over the turn's current connection (the tool may finish after the rebind); while held they are
  only kept.
- Workers without the feature, a missing `instanceId`, or `reconnectGraceMs: 0` → fail at once as before.

**Not covered (listed, not trivial):** a turn on another master replica's worker connection (with several replicas the
worker may reconnect to another replica; the owning replica's grace then runs out and the turn fails as before); an
attachment fetch in flight during the drop (the fetcher fails it → `attachment_unavailable`); remote operations
(OPS_COMMAND / OPS_UPDATE are control messages too — an op running during a drop is reported `lost` by its own window);
jobs are leased and unaffected.

## 5. Console

- Chat (Sohbet, home ops thread): a quiet line **"Bağlantı yeniden kuruluyor…"** under the answer being written while
  the turn state is `reconnecting` (from the stream or the thread snapshot); no error banner; it clears on the next
  `turn running` or text. If the grace runs out the usual error line appears.
- Makine → Genel bakış → "Bir bakışta": **Son bağlantı kopmaları** — time · cause (· code, detail, pong wait,
  event-loop delay, and for a pong timeout "makine takıldı" when the worst loop delay ≥ 5 s, else "büyük olasılıkla ağ
  kopması"), newest five. tr + en catalog.

## 6. Why the worker reconnected (HELLO `lastDisconnect`)

The transport records, for a connection that had a session, the first structured cause of its end:
`pong_timeout` (`pongWaitMs`, `loopDelayMaxMs` = worst event-loop delay over ~the last minute from
`perf_hooks.monitorEventLoopDelay`, two 30 s windows), `socket_error` (message), `closed` (close code / reason by the
master or a proxy), `worker_closed` (the worker closed it: handshake timeout, protocol error, reconnect request),
`upgrade_refused` (HTTP status); plus `at` and `connectedMs`. It is sent in the next HELLO (optional field, additive in
1.0 — an older master's schema strips it; no feature flag needed) until a session is up again. The master logs it at
info on "worker session established" and "newer connection replaces the existing one", and keeps the last 10 per worker
(`workers.disconnects`, newest first, the same report once), returned by `GET /workers/:id` (`disconnects`, additive).

## 7. The 10 s pong timeout behind Cloudflare → traefik

Not changed. The ping is answered by the master's WebSocket stack; a healthy path answers in milliseconds, so 10 s
without a pong means no data passed for 10 s (a dead NAT mapping / path — the worker cannot tell which hop) or an event
loop stalled. A longer timeout would only make real drops slower to notice; with the grace a quick detection and resume
is the cheaper outcome.

One false positive was real and is fixed: after a stall of the **worker's** event loop the timers phase runs before
the socket's pending input is read, so a pong that had already arrived lost the race and the worker cut a healthy
connection. The verdict is now taken one I/O turn later (`setImmediate`, after the poll phase); a pong read meanwhile
wins. A test reproduces it (a 120 ms stall with a 30 ms pong timeout ended the connection before; it no longer does).
The new reports (`pongWaitMs`, `loopDelayMaxMs`) show from the next release whether the prod drops are the path or a
stall; whether Cloudflare forwards WebSocket ping frames end to end or answers them itself is UNVERIFIED (it changes
which leg the timeout measures, not the decision). A stall of the master's event loop is not measured yet (follow-up
if the reports point there).

## 8. Security

- ASSISTANT_RESUME comes only from the authenticated master session; the worker answers only with updates of turns it
  ran (already redacted when they were produced) or with a `failed` that reveals nothing.
- A turn moves only to the same worker (`workerId`) and the same process (`instanceId`, random per process, sent after
  key-possession proof); attachment requests keep their "this turn on this connection" check (the rebind updates it).
- The disconnect report is bounded (detail ≤ 300 chars), schema-validated on both sides, contains error / close texts
  only (no secrets), and is readable with `workers.read` like the rest of the machine detail.

## 9. Rollback

Master revert: the column stays unused (or `ALTER TABLE workers DROP COLUMN disconnects`), turns fail at once again,
new workers' held turns end after their 90 s hold (a retry replaces them). Worker revert: no feature → the master fails
at once as before. Either side can ship first.

## 10. Tests

- worker `assistant-resume.test.ts`: a turn keeps running while disconnected and delivers everything after the resume
  exactly once (also what a stale socket swallowed); a tool call waits past its timeout; an unknown turn → `failed`;
  hold expiry; a new turn of the thread replaces a held one; busy otherwise; deliberate stop.
- worker `transport-ws.test.ts`: HELLO carries the last reason (pong timeout with wait and loop delay, close, socket
  error), once; a connection without a session does not replace it; a pong received during a loop stall keeps the
  connection.
- master `integration/chat-reconnect.test.ts` (real workers, fake engines): same-process reconnect within the grace →
  one answer, both tool rows once, no error, no re-run; a stale path through a TCP relay (worker pong timeout, the
  master learns of the old connection only on replacement) → continues, `pong_timeout` recorded; no return → fails
  after the grace, acted → not re-run; another process → fails at once, re-run on the backup; an older worker → fails
  at once; disconnect reasons on `GET /workers/:id`.
- web `chat-reconnect.test.tsx`, `diyalog-machines.test.tsx`: the reconnecting line renders and clears; the machine
  page lists recent drops.
