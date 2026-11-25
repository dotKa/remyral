# Design note: worker boot diagnostics (P6)

- **Status:** Implemented (worker release 1.0.23; migration 0056)
- **Date:** 2026-10-16
- **Backlog:** `p6-worker-boot-diagnostics`
- **Builds on:** [p2-signed-updates.md](p2-signed-updates.md) (privileged updater, health check, rollback),
  [p5-remote-ops.md](p5-remote-ops.md) §4 (`logs.tail`, `worker.log`), p2-service-windows (shawl service).
- **Incident:** [docs/ops/worker-updates.md §8](../ops/worker-updates.md#8-incident-2026-10-16-1022-rolled-back-on-windows-without-a-log-line).

## 1. Problem and what the analysis found

On 2026-10-16 ~09:00 UTC the privileged updater activated worker 1.0.22 (built from `b3a1f87`) on the owner's
Windows 11 worker (`NT SERVICE\RemyralWorker`, shawl, Node 24.21.0) and rolled it back with `health_check_failed`.
`<dataDir>\logs\worker.log` has no line from 1.0.22: 1.0.21 logged `worker daemon stopped` at 09:01:02, the next
line is 1.0.21 `config loaded` at 09:02:53. `worker.log` is opened only after the config is loaded, so anything that
happened to 1.0.22 before that — or a 1.0.22 that never ran — was invisible without a shell on the machine.

Static analysis (no access to the machine):

1. `git diff d31eef5 b3a1f87 -- apps/worker packages` (1.0.21 → 1.0.22; nothing else is bundled): 35 files, none on
   the boot path before `config loaded` (`bin.ts`, `cli.ts`, `config/*`, the first part of `daemon/run.ts` are
   unchanged; `run.ts` only gains the `site-bundle-v1` feature string, sent after the session is up).
2. Both bundles were built (`scripts/bundle.mjs`, `REMYRAL_BUILD_VERSION=1.0.21 / 1.0.22`) and their top-level
   statements diffed. New in 1.0.22 at module level: zod schemas (`SitePath`, `SiteBundle`, `RoutingRule`,
   `JobRuntimeFallback`), constant tables (`SITE_FILE_TYPES`, `LIMIT_PATTERNS`, `UNIT_MS`, `MONTHS`), `new Map()`,
   a class. No platform branch, no I/O, no `Intl` call, no `process.getuid`, no child process, no top-level await,
   no new dependency or optional native module at load. `site-bundle.ts` uses `constants.O_NOFOLLOW ?? 0` (undefined
   on Windows) only inside a function that runs for site-bundle jobs.
3. Both bundles were run under a simulated Windows host (`--import` preload: `process.platform = 'win32'`, POSIX
   uid/gid APIs removed, no `HOME`, `%ProgramData%` set, Windows-style config paths): both evaluate every module and
   reach `config loaded` identically, and fail later identically on the simulation's mixed path semantics.

**Conclusion: no Windows-only failure of the 1.0.22 bundle itself is provable statically.** The candidates, and how
the new evidence decides between them:

| # | Candidate | Evidence it would leave now |
| --- | --- | --- |
| A | **Restart race in the updater (a real bug, fixed here).** `net.exe stop` exits 2 both for "not started" and for "could not be stopped" (it gives up while the service is still `STOP_PENDING`; shawl waits up to its 60 s stop timeout for node, and the 1.0.21 daemon still awaits login / tool-inventory / assistant shutdown after logging `worker daemon stopped`). The updater accepted exit 2 and ran `net start` at once, which fails while the service is stopping — 1.0.22 never ran, the health check timed out, and the rollback's restart worked because by then the service had stopped. The `net start` error was logged to the scheduled task's stderr, which Windows discards. | verdict `never_started`, `restartErrors` with the `net.exe start` message, shawl log without a 1.0.22 start |
| B | 1.0.22's process started but Node never ran its code: the freshly written 4.6 MB bundle could not be read (AV real-time scan / quarantine, sharing violation). | verdict `never_started` without restart errors, service output with Node's own error |
| C | A machine-specific failure while 1.0.22 evaluated its modules or before its config loaded (not reproducible in the simulation). | verdict `crashed` (stage `module-load` / `startup`) or `exited` with the stack / stderr |
| D | 1.0.22 hung before loading its config. | verdict `hung_before_ready` |

The timeline fits all four (1.0.22 had the 90 s health timeout; the rollback restart, a fresh 4.6 MB file and a
node start took the remaining ~20 s). A is fixed in this change; B–D are now recorded. **UNVERIFIED** until the next
Windows update attempt (or the shawl / Event Log evidence still on the machine, see the incident note) confirms one.

## 2. Boot guard and `boot.log`

`src/boot/arm.ts` is the **first import** of `src/bin.ts`. ES modules evaluate imports in order, so it runs before
every other module of the bundle (verified in the built bundle: only lazy CommonJS / `__esm` wrappers and hoisted
function declarations precede it). It imports only the dependency-free path helpers, the version constant
(`src/version.ts`, moved out of `probe.ts`) and the redactor.

Only for `run` (what every service definition starts) — interactive commands print their own errors and must not
create files in an operator's home. One JSON line per event in `<dataDir>/logs/boot.log`:

- `start` (version, pid, platform, arch, Node, command); `ready` (config loaded, logger up — `runWorker`);
- `fatal` from `process.on('uncaughtExceptionMonitor')` (observes without changing Node's crash behaviour; fires
  for module-evaluation errors too, origin `unhandledRejection` under top-level await), from `daemonCommand`
  (origin `daemon`, or `config` for operator-fixable errors: verdict `exited`, not `crashed`) and from the entry's
  catch; with stage `module-load` → `startup` → `running`, error name / message / stack, redacted, ≤ 4 KiB each;
- `exit` for a non-zero exit except 75 (remote restart), with the stderr written before `ready` (≤ 4 KiB) — a
  config error that never reaches `worker.log`;
- `forced_exit`: handles still open 10 s after the daemon stopped (the entry then exits — a lingering handle must not
  turn a clean stop into a shawl stop timeout, see candidate A).

Where before the config is loaded: the `dataDir` of the config the process will load (`--config`,
`REMYRAL_WORKER_CONFIG`, else the OS default location — only that one absolute string field is read), else that
location's default (`%ProgramData%\RemyralWorker\data`, `/var/lib/remyral-worker`, `/Library/Application
Support/RemyralWorker/data`); `ready` moves it to the loaded `dataDir` if different. 0600 file in a 0700 directory,
256 KiB with one older generation (`boot.log.1`), synchronous appends that never throw.

## 3. Evidence of a failed attempt

`src/boot/diagnostics.ts` → protocol `UpdateDiagnostics` (`collectedBy`, `verdict`, `bootLog`, `serviceOutput`,
`updaterLog`, `restartErrors`, `redacted: true`; ≤ 40 lines × 2000 chars per list, ≤ 32 KiB in total, oldest lines
dropped first). Verdict (`bootVerdict`): records of the failed version since its restart (10 s slack) →
`never_started` / `crashed` / `exited` / `hung_before_ready` / `started`, or `no_boot_log`.

Service output: Windows `%ProgramData%\RemyralWorker\logs\remyral-worker_rCURRENT.log` (node's stdout/stderr as shawl
captures it) and `shawl_rCURRENT.log` (prefixed `[shawl]`), macOS `/Library/Logs/RemyralWorker/remyral-worker.log`,
Linux the journal (`journalctl -u remyral-worker.service --since @<restart> -n 80 -o cat --no-pager`, updater only).
JSON log lines of other versions are dropped (the restored version keeps appending to the same file).

- **Updater** (`Updater.#healthCheck`): collects right after the failed health check, *before* switching back, so
  the service output is still the failed version's; adds the restart errors of this attempt; writes
  `<installDir>/state/last-diagnostics.json` `{schema, attemptId, diagnostics}` — a separate file because older
  daemons parse `last-result.json` strictly (that file keeps its exact shape). Data-dir files are read with
  `readTailSafe`: `O_NOFOLLOW`, regular files only, and on POSIX only files owned by the data dir's owner (a hard
  link to a root-owned file is refused: root never ships a file the worker could not read itself).
- **Daemon** (`UpdateAgent.reportResult`): for `rolled_back` and `failed` (`health_check_failed`,
  `rollback_unavailable`) it attaches the updater's diagnostics of the same attempt, else collects what it can read
  itself (boot log, service output, updater log; `since` = finish − 2 × health timeout − 3 min). So the evidence
  flows as soon as the *restored* version is ≥ 1.0.23, even with an updater installed before this change.

## 4. Updater log file and the Windows restart

- `remyral-worker-updater.mjs apply | rollback | adopt` tee their (redacted) JSON log into
  `<installDir>/state/updater.log` (0644 in the root-owned state dir: the service account reads it for remote
  viewing; 1 MiB, one older generation). On Windows this is the only updater log (a scheduled task's output is
  discarded); on macOS / Linux it sits next to the launchd log / journal.
- `osServiceControl(scm).restart()`: after `net stop` (0 or 2) it polls `sc.exe queryex` until `STOPPED` (stop
  timeout + 30 s); still `STOP_PENDING` → throws (recorded) instead of a doomed start; unknown state (sc.exe
  unusable) → tries the start anyway. A failed `net start` is retried once after 5 s unless the service is already
  running / starting. Every failure carries the command's message into `restartErrors`.

## 5. Remote viewing and the console

- `logs.tail` gains `source: worker | boot | updater` (protocol `LogSource`; absent = worker). Fixed files only
  (`RemoteOpsDeps.logSources`), the same tail / chunk / re-redaction path, `logs_unavailable` when absent. Worker
  feature `logs-source-v1`; the master refuses a non-default source to a worker without it (`409
  worker_update_required` — an older worker would ignore the field and answer with its worker log) and does not put
  the default on the wire (older workers verify the same signed command as before). Authorization unchanged
  (`workers.ops.write` + step-up, audited with the source in the params).
- `UPDATE_STATUS.diagnostics` (optional, additive): the master stores it on the attempt
  (`worker_update_attempts.diagnostics jsonb`, migration 0056, ≤ 64 KiB check) after redacting every line again and
  re-validating the schema; the audit event `worker.update.<phase>` carries the verdict. `GET /releases` lists
  `verdict` and `hasDiagnostics` per attempt (not the evidence); `GET /releases/attempts/:id/diagnostics` returns it
  (`workers.ops.read`, admin — the audience of log lines).
- Console: Operations → Worker logs has a **Log** selector (Worker / Boot / Updater); Settings → Worker releases
  shows a failed attempt's detail line and **Why?**, which opens the verdict explanation, restart errors, boot
  records, service output and updater log.

## 6. Security review

- No new endpoint on the worker, no path parameter: `source` is an enum mapped to fixed files.
- Everything that leaves the machine is redacted on the machine (logger's exact secrets where the daemon collects,
  token patterns everywhere) and again on the master, and bounded by the protocol schema.
- The privileged updater reads only bounded tails of fixed files; data-dir files are opened without following the
  last component and only when owned by the service account (POSIX). Windows has no owner check (no uid); the files
  are fixed names in directories the installer ACLs, and the content is redacted, bounded display text for admins.
- `updater.log` is world-readable inside the root-owned state dir; it holds the updater's redacted JSON log only.
- The boot log stays 0600 like `worker.log`; it is read remotely only through `logs.tail` (admin + step-up).
- The diagnostics endpoint needs `workers.ops.read` (admin), the same as reading fetched log lines; viewers see only
  the verdict in the attempts list.

## 7. Rollout, compatibility, rollback

- Deploy the master first (migration 0056; it must know `logs-source-v1` before 1.0.23 workers advertise it — an
  unknown feature fails CAPABILITIES validation on an older master).
- Worker release 1.0.23: boot guard, diagnostics from the daemon side, `logs.tail` source, forced exit after stop.
- The updater part (own log file, collection before rollback, Windows restart wait) needs the **installer re-run**
  on each machine — the updater is never auto-updated (p2-signed-updates §7). Until then the daemon-side collection
  covers boot log, service output and (if present) the updater log.
- Rollback: everything is additive; an older master ignores `diagnostics`, an older worker never sends it.

## 8. Tests

- `apps/worker/test/boot-guard.test.ts`: boot log location per OS (Windows `%ProgramData%`, `--config`,
  `REMYRAL_WORKER_CONFIG`, junk / relative `dataDir`), records, redaction, bounds / rotation, never-throwing writes,
  verdict matrix, Windows / macOS / Linux evidence collection, protocol bound, safe tail reader (links, owner).
- `apps/worker/test/boot-bundle.test.ts` (**regression test**): the real bundle under a simulated `win32` host boots
  to `config loaded` with `start` / `ready` in boot.log; a failure injected during module evaluation lands as
  `fatal` (stage `module-load`, stack in the bundle) + `exit`, verdict `crashed`; a config error as `exited` with the
  stderr reason; interactive commands write no boot log.
- `apps/worker/test/update-diagnostics.test.ts`: updater collects between the failed start and the rollback restart,
  records the restart error, writes `last-diagnostics.json`, keeps `last-result.json`'s shape; daemon forwards /
  collects; Windows restart waits for STOPPED, refuses while stopping, retries a failed start once.
- `apps/worker/test/update-misc.test.ts`: `apply` writes `state/updater.log` (0644), `status` does not.
- `apps/worker/test/remote-ops-agent.test.ts`: `source` boot / updater, redaction, `logs_unavailable`.
- `packages/protocol/test/update-diagnostics.test.ts`: schema bounds, additive UPDATE_STATUS, `LogSource`.
- `apps/master/test/integration/releases.test.ts`, `remote-ops.test.ts`: stored, re-redacted diagnostics, list
  fields, endpoint + 404; feature gating, wire default, 400 for a path, 403 for a viewer.
- `apps/web/test/fleet.test.tsx`, `remote-ops.test.tsx`: attempt detail + Why?, log source selector.

Not verified on a real Windows host (needs the owner's machine): shawl's log file names under the installed
`--log-as` / `--log-cmd-as`, `net.exe` / `sc.exe` behaviour during a real slow stop, Defender behaviour on the new
bundle. The next Windows update attempt with a re-installed updater produces the evidence.
