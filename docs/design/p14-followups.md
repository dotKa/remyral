# Design note: `p14-followups` — sub-job race, code-node images on workers, console perf follow-ups

- **Date:** 2026-10-21. Three independent follow-ups, one commit each.
- **Migrations:** none for §1; see §2 / §3.

## 1. Sub-job leased after its parent ended (`p14-subjob-reserve-race`)

### Symptom

`apps/master/test/integration/subjob-local-login.test.ts` › "a Claude Code sub-job of a Claude Code parent (same
login) is reported as blocked_by_parent at once" failed about one run in three (also on the deployed baseline): the
child sub-job had one `job_attempts` row, although it must be cancelled with its parent (cascade) and never run.

### Evidence

Transition history of a failing run (ids are the global `job_transitions` order):

```
 7 P STARTING  -> RUNNING    runtime_started
 8 P RUNNING   -> VERIFYING  run_finished
 9 P VERIFYING -> SUCCEEDED  verification_passed_no_approval   (parent's lease released in the same tx)
10 C QUEUED    -> RESERVED   reserve (scheduler)                <- child leased AFTER its parent ended
11 C RESERVED  -> STARTING   lease_acked
12 C STARTING  -> CANCELLING cancel_requested (cascade)
```

### Root cause

`Orchestrator.#dispatch` checked "is this a sub-job of an ended parent?" once, at its start, and only then read the
worker facts for placement (`slot_leases`). The parent's terminal transition releases its lease in the same
transaction (`ATTEMPT_OPEN_STATES` includes VERIFYING, so the lease is held until SUCCEEDED). Interleaving:

1. dispatch reads the parent as VERIFYING (not ended) → orphan check passes;
2. the parent's `verification_passed_no_approval` commits: SUCCEEDED + lease released;
3. dispatch reads the worker's slot leases → the Claude login store is free → `placed`;
4. `acquireLease(child)` commits QUEUED → RESERVED; the worker starts it; the cascade cancels it a tick later.

A check-then-act across separate READ COMMITTED statements.

### Fix

The check moves into the lease transaction itself: `JobStore.acquireLease` (trigger `reserve`) refuses a job whose
`job_subtasks` parent is SUCCEEDED / FAILED / CANCELLED with `LeaseConflictError` ("its parent job ended (…)"); the
orchestrator already treats that as `skipped`, and the cascade cancels the child. This is sufficient without row
locks: placement can only see the parent's slot free after the parent's terminal transaction committed (the release
and the terminal state commit together), and the lease transaction's check runs after that read, so it sees the parent
ended. A child that legitimately started while its parent still ran (another login store) is unaffected. The early
check in `#dispatch` stays as a cheap shortcut.

### Tests

- `jobs.test.ts` › "never reserves a sub-job whose parent ended …": store-level, deterministic (red before the fix).
- `subjob-local-login.test.ts`: unchanged assertions (no sleeps; `expect.poll` only); 12/12 consecutive runs green
  after the fix (before: 1 failure in 4).

### Security / rollback

No new surface; an orphaned sub-job no longer runs for an ended parent. Rollback: revert the commit. Master only; no
migration, no worker release.

## 2. Code node images on workers (`p14-code-images`, workflow 14.3 K3)

### Problem

Code nodes need `remyral/code-js:0.1.0` / `remyral/code-python:0.1.0` on the worker (the executor runs them with
`--pull never`); until now an operator ran `node infra/worker/images/build.mjs --only code-js,code-python` by hand on
each host, and the worker release did not ship the build contexts. Without the images the worker never advertises
`function-code-v1`, so code nodes wait and fail `no_worker`.

### Design

- **Contexts in the release.** `scripts/security/code-images.mjs --write` embeds `infra/worker/images/code-js|code-python`
  (Dockerfile + runner, with SHA-256) into `apps/worker/src/functions/code-images.generated.ts`; the worker bundle
  carries them. `--check` runs in `pnpm security:pins`: the file must be current, each Dockerfile has exactly one
  `FROM`, equal to the digest in `FUNCTION_CODE_BASE_IMAGES` (the pins stay in one place), and no `ADD` / `ARG`.
- **Remote op `code.images.prepare`** (protocol, additive; no parameters — images, digests and contexts are fixed by
  the release). Worker feature `code-images-v1`, advertised only where the container runners exist (a container
  engine is configured). The worker (`functions/code-images.ts`) re-checks the embedded hashes and the pinned `FROM`,
  then per language: `<engine> pull name:tag@sha256:…` → private temp context (Dockerfile + runner only) →
  `<engine> build --tag remyral/code-<lang>:0.1.0 --label org.remyral.code-base=<pin> …` → `image inspect` (local id).
  Only the engine client env allowlist reaches the CLI; one preparation at a time; cancel between steps (`ops.cancel`).
  After success the executor's cached readiness is dropped and CAPABILITIES are re-sent, so the worker advertises
  `function-code-v1` at once. OPS_UPDATE `codeImages` = `{images: [{language, tag, base, id}], ready}`.
  Local opt-out: `remoteOps.disabled: [install]` refuses it (it is an install).
- **Master.** `POST /workers/:id/code-images/prepare` — `workers.ops.write` (admin) + standard step-up + CSRF, audited
  `worker.ops.code.images.prepare`, heavy rate limit, 45 min "lost" window; refused `worker_update_required`
  (`reason: code_images`) without `code-images-v1`. `GET /workers/:id/ops` adds `codeImages: {supported, ready}`.
  Migration **0115** widens `worker_ops.kind`.
- **Console.** Makine → Araçlar → "Kod düğümleri": Hazır / Hazır değil, admins get "Kod düğümü imajlarını hazırla"
  (step-up) and the operation line. The workflow inspector of a code node shows, when no machine advertises
  `function-code-v1` (`functionWorkers.code.total = 0`), a hint linking to Makineler. Strings in `@remyral/i18n`
  (`machines.codeImages`, `workflows.inspector.worker.codeNotReady*`, `errors.worker_update_required.code_images`).

### Security review

- No new code path from the panel to the host: the op has no arguments; the worker builds only the reviewed,
  hash-checked contexts in its own release, FROM digests (a registry or a tag move cannot change the base). The
  Dockerfiles install nothing and drop setuid bits; the run-time hardening of code runs is unchanged.
- Admin + step-up + audit like runtime / tool installs; the local `install` opt-out applies; old workers never get it.
- Engine stderr in failure details is cut to the last lines and redacted by the agent before it leaves the worker.
- Residual: the engine itself pulls from the registry named in the pin (Docker Hub); a host without registry access
  fails `pull_failed` (pre-load the base images there).

### Verification

- Unit: `functions-code-images.test.ts` (fake engine: order, digests, exact context files, env allowlist, failures,
  tamper refusals, single flight, cancel), `remote-ops-agent.test.ts` (op refused / built / failed / opt-out),
  master `remote-ops.test.ts` (feature gate, viewer 403, signed op without parameters, result, readiness, audit),
  web `diyalog-w3-machine-config.test.tsx`, `diyalog-workflow-functions.test.tsx`.
- Real engine: `REMYRAL_TEST_DOCKER=1` on this dev Mac (Docker Desktop 29.6.2, linux/arm64): prepare pulled and built
  both images, the executor was ready and ran a Python node; the existing real code-run suite passed on the built images.
- **UNVERIFIED** (needs real hosts): Linux Docker and rootless Podman, Windows Docker Desktop (temp context path,
  Windows engine env), Raspberry Pi arm64 (Pi 4/5 with Docker), a host without registry access.

### Deploy

Master (migration 0115) first, then a **worker release** (`code-images-v1`). Older workers keep working unchanged (the
panel says to update them). Rollback: revert; the 0115 CHECK value stays unused.

## 3. Console performance follow-ups (`p14-web-perf-2`)

The "not done" items of [p14-web-perf](p14-web-perf.md), plus one regression found on the way.

| Item | Change |
| --- | --- |
| Home asked `/jobs` once per active state | One `GET /jobs?state=RUNNING,STARTING,VERIFYING,AWAITING_APPROVAL&limit=200` (the master's `StateList` already took a list; 4 × 50 → one page of 200). Test fixtures and the Diyalog harness answer the merged URL. |
| İşler cost column read every usage record since the oldest listed job (≤ 500) | `GET /usage/records` takes `jobs=<id,id,…>` (≤ 200 uuids, `usage_records_job_idx`); İşler (Diyalog and classic) send the listed page's ids. An older master ignores the parameter (same answer as before). |
| `/jobs/:id/live` ran `count(*)` over the job's log chunks per call | `job_live_heads.log_chunk_count` (migration **0116**), incremented in the chunk-insert transaction (the head row is locked there), reset by the retention purge. Pre-0116 heads are NULL and are counted once, under the head row lock, on their first summary — the migration does not scan `job_log_chunks`. |
| Both languages' catalogs in the initial JS | `@remyral/i18n` bundles Turkish (the default and the import-time fallback) plus the English **errors** namespace (the master-message guard of `masterErrorSentence` needs it in every language); the rest of English is a lazy chunk (`loadCatalog('en')`). `main.tsx` loads it before the first frame when this browser last used English or chose the classic console; the classic shell / classic sign-in chunks bring it along; `I18nProvider` switches language only after the catalog is there; an unloaded language reads as Turkish, never throws. Node callers (master template texts, catalog tests) import `@remyral/i18n/all` (both, synchronously). |
| Command palette body in the entry (it also pulled the settings frame) | `palette/shortcut.ts` keeps ⌘K and its label in the shell; `CommandPalette` is a `lazyScreen`, preloaded on idle with the main routes and mounted at the first open. |
| (regression) zod schemas of the question cards reached the home via the nav badge's pending list | `api/questionsPending.ts` (no protocol import) for the badge / home; `api/questions.ts` keeps the full sets. zod still reaches the home through `api/chat.ts` → thread question sets (next candidate). |

### Bundle (`pnpm --filter @remyral/web bundle:report`, gzip -9 / brotli, budget 350 KB gz for the home)

| Initial JS | before | after |
| --- | --- | --- |
| **Diyalog home** | 356.8 KB gz / 303.5 KB br (57 chunks) — over budget | **317.5 KB gz / 275.2 KB br** (53 chunks) |
| Entry + static imports | 291.6 KB gz / 245.0 KB br | 252.1 KB gz / 216.6 KB br |
| Sohbet / İşler / Makineler / job | 455.1 / 370.5 / 331.7 / 440.3 KB gz | 420.3 / 331.3 / 292.3 / 401.1 KB gz |
| Classic shell | 293.9 KB gz | 254.5 KB gz (+ the English catalog chunk it loads) |

### Tests

`packages/i18n/test/lazy.test.ts` (Turkish at once, English only after `loadCatalog`, fallback, the bundled English
errors), master `usage.test.ts` (`jobs` filter, bad list 400), `live.test.ts` (kept count, duplicate not counted,
pre-0116 backfill, purge reset), web `p6-shell.test.tsx` (one active-jobs request), `diyalog-jobs.test.tsx` (the
`jobs` parameter); the web suite loads English once in `test/setup.ts`.

### Deploy

Master (migration 0116, the `jobs` parameter) and the web image. No worker release. Rollback: revert; the column
stays unused.
