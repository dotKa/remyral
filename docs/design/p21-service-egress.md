# p21-service-egress — the project's network access policy for services and IDE servers

Status: implemented (2026-11-01). No migration. Worker feature `service-egress-v1` (worker 1.2.14; deploy the master
first).

## 1. Owner problem

2026-11-01, project "sample-site": a dev server started with `start_service` ran `npm ci` and most package downloads got
`403` from the platform's egress proxy (`npm http fetch GET 403 https://registry.npmjs.org/zod/-/zod-4.6.7.tgz`); the
cached packages installed, the rest did not, and the service restarted for 15 minutes. The project's network access
policy was already "web + npm". The assistant tried to change it ("nothing to change"), concluded correctly that the
setting does not reach services, stopped the service and proposed a workaround (install in a job, start the service
from the job's worktree).

## 2. Cause

Three designs of the same day (2026-10-21) and one later one each own a part of "a process the worker runs for a
project":

| Process | Network policy before | Design said |
| --- | --- | --- |
| repository job (p14-repo-egress) | worker floor + project policy (`execution.repoEgress`, `repo-egress-v1`) | the project policy |
| service (p15-services) | worker floor only (`sandbox.egressAllow`, model APIs) | "same egress allowlist as a job" |
| IDE server (p19-ide W2) | worker floor only | "the project's egress allowlist (p14-repo-egress)" |

p14 put the policy on the **job assignment** (ASSIGN_JOB), not on the project as something every runner reads. p15 and
p19 copied the job's *launch call* (`network: { mode: 'allowlist', targets: egressAllow }`) — which in the job runner
is only the base that `repoNetworkPolicy` extends — so "same as a job" became "same floor as a job". Nothing tested the
policy end to end through a service, and the `start_service` tool description told the assistant "Same sandbox and
egress rules as jobs", so the assistant could not know.

## 3. Change

- **Protocol**: `ServiceSpec.network` and `IdeSpec.network` (optional `AssignedRepoEgress`). Part of the spec, so the
  existing signature covers it and a changed policy is a changed spec. Worker feature `service-egress-v1`; the master
  sends the field only to workers advertising it (an older worker's strict spec would refuse an unknown key).
- **Master**: `#sendStart` of services and IDE workspaces adds the project's effective policy **at each send**
  (`loadRepoEgress`, the same as a job's dispatch; never stored in the row). A read failure sends no policy (model
  APIs only: fails closed). A change of the policy (`PUT /projects/:id/repo-egress`) bumps the revision of the
  project's services and re-sends the running ones: the worker restarts a service only when its rules changed (same
  spec hash → no restart), and a service that failed on a refused host starts again. IDE servers are **not** restarted
  on a change (it would drop the user's editor); the policy applies at their next start. A worker that was just
  updated restarts its services from records kept without a policy; it reports them with
  `CAPABILITIES.services[].network: false` and the master sends them again at a new revision with the policy. Files (workspace-project) IDEs
  keep model APIs only.
- **Worker**: the service and IDE launches use `repoNetworkPolicy(spec.network ?? null, sandbox.egressAllow)` — the
  job's function, so the same modes, the same private-address floor and the same 403 hint naming
  Projeler → Politika → Ağ erişimi.
- **Console**: a service on a machine without the feature shows "Ağ: yalnızca model API'leri (makineyi güncelle)"
  (`ServiceView.network`).
- **Assistant**: the `start_service` description says the project's policy applies, what `model_apis_only` means and
  that a 403 during an install points to that setting (no workaround).

## 4. Not done

- ~~Services of workspace projects (and files IDEs) keep model APIs only~~ — done in
  [p22-worker-limits](p22-worker-limits.md): they get the project's Workspace-tab egress setting.
- ~~A service whose install fails on a refused host still restarts per its policy~~ — done in
  [p22-worker-limits](p22-worker-limits.md): a failed run after a policy 403 fails at once, naming the host.
- The "no machine can run this job" warning on the workaround card (ip-172 has Claude) is a separate readiness issue.

## 5. Tests

- worker `test/services-manager.test.ts`: no `network` → floor and the "did not send" hint; npm allowlist reaches the
  launch; the same policy at a higher revision does not restart; `web` at the next revision restarts.
- master `test/integration/services.test.ts`: no field for a worker without the feature (`network: model_apis_only`),
  after the update the reconnect report `network: false` brings revision 2 with the field (signed), a policy change re-sends the running service with the npm
  hosts at revision + 1.

## 6. Same day, the next report: a seed as a service, "I will look again in 10 minutes", `listen EINVAL`

Owner 2026-11-01 (screenshot): after `sample-site-dev` came up, the assistant ran the seed as a one-shot service
(`sample-site-seed`, unconfined, `… && echo SEED_TAMAM || echo SEED_BASARISIZ`), said "the platform will open this again
in about 10 minutes and I will write the result here" — and the user got an intervention card instead: "Bu hedef kendi
kendine ilerleyemiyor: beklenen sürede ilerleme olmadı (Servis henüz ayakta değil)". The seed had exited with 0 half an
hour earlier; nobody read its log.

Three causes, three fixes:

- **p21-goal-check — the assistant's own reevaluate time went straight to the user.** `goal_update {nextStep,
  reevaluateInMinutes}` let the assistant say when to look again, but when that time came the ledger made the goal an
  intervention (`no_progress`) — nobody gave the assistant the turn it had planned. Now, while the chat is reachable, an
  overdue goal the assistant owned becomes a **check turn** (`blocked_reason = check_due`, `next_action = resume`,
  delivered through the goal outbox as `goal:<id>:check-<n>`; the text names "kendi kontrol zamanın geldi" and the
  recorded next step) at most `GOAL_AUTO_CHECKS` = 2 times per goal; only after those it is the user's card. Rule 66 and
  the `goal_update` description say so ("I will look again in 10 minutes" is `reevaluateInMinutes: 10`).
- **p21-service-exit — a one-shot service never "ended" for a watch.** A service whose command exits by itself under
  the policy `never` is `stopped` while still wanted; `resolveUrl` counted only failed / refused / expired / stopped by
  a person as ended, so a watch said "Servis henüz ayakta değil" until its timeout. `stopped` now ends it (with
  `exitCode`), and `service_url {exited: true}` is a watch that is met when the command ended ("Servis … komutu
  bitti", state and exit code). `start_service` tells the assistant to run a one-shot command with policy `never` plus
  that watch, and to read the result in the logs.
- **p21-short-tmp — `$TMPDIR` too long for Unix sockets.** The attempt's tmp (`<root>/sandboxes/<service>/run/tmp`)
  is longer than a socket name allows (~104–108 bytes with the file name), so `tsx` (`<tmp>/tsx-<uid>/<pid>.pipe`)
  failed with `listen EINVAL`. On POSIX, when the tmp is longer than 64 characters: a bubblewrap view uses its own
  private tmpfs `/tmp`, an unconfined attempt a fresh `rmy-*` 0700 dir under the OS temp dir (removed with the
  attempt). macOS Seatbelt and Linux without bubblewrap keep the attempt's tmp (writes are allowed only there).

Tests: master `chat-outcome.test.ts` (check turn, held until its new time, the card after two), `services.test.ts`
(a self-exited service is ended with exit code 0), `watch-check-model.test.ts`; worker `sandbox-short-tmp.test.ts`.
