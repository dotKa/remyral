# p22-harness-gaps — closing the harness gaps found in the 2026-11-02 review

Owner 2026-11-02, after the review of how far Remyral is an agent harness: "eksikleri kapatalım, başla". The vault
project allowlist has its own note ([p22-vault-projects](p22-vault-projects.md)); this note covers the rest.

## 1. An approved unverified Claude Code install is admitted

`runtime-gate.ts` admitted an owner-approved unverified install only when the probe's version equalled the install
record's. Claude Code driven by an agent SDK other than the pinned one reads `<cli>+sdk.<sdk>` (the SDK pin is part of
the runtime identity), the record names the CLI alone — so "Doğrulanmamış kuruluma izin ver" never applied to Claude
Code (bilinen-eksikler). Now both the gate and `checkRuntimeForJob` compare the CLI part (`cliVersionOf`), as
`verify-runtime.ts` already did; a different CLI version is still refused. Worker change (next worker release).

## 2. GitLab and Bitbucket keep to their rate limits

p22-github-rate paused a rate-limited GitHub installation and kept a background reserve; GitLab and Bitbucket were only
retried. `ApiRateBudget` (was `GitHubRateBudget`) now also reads GitLab's `ratelimit-*` headers; `HostedHttp` keeps one
budget per connection (its token, `hostRateBudgetOf`): a 429 pauses the connection until `RateLimit-Reset` /
`Retry-After` (a minute without either), requests in the pause fail at once without leaving, and the merge-state refresh
skips while the budget is below the reserve (`backgroundBudgetLow` on the GitLab / Bitbucket providers).

## 3. A pending restart is visible on the machine page

Owner: "yeniden başlatmam gerektiği herhangi bir infoda yer almıyor. makine ekranında üstte bu bilgi verilebilir." The
worker reported the settings waiting for a restart (`pendingRestart`), but the panel named them only inside
Yapılandırma → Yerel ayarlar. Every machine tab now opens with "Makinedeki Remyral yeniden başlatılmalı", the panel's names
of those settings and a link to Yönetim → Yeniden başlat (administrators; re-read every 30 s while pending, so it leaves
after the restart).

## 4. Linux: the login-store home survives the data-dir mask

Live, ip-172 2026-11-02, right after "Abonelik işleri paralel" was switched on: every Claude Code attempt exited 125,
`cp: cannot create regular file '/var/lib/remyral-worker/home/.claude.json': No such file or directory`. The system
install's HOME lies **inside** the data dir; `buildHostBwrapArgs` mounted the home view first and the data-dir tmpfs
after it, which erased the view. The view now follows the nesting: a home that contains the data dir or the workspace
root goes before their masks (as before), a home inside one goes after them and counts as bound back (protected paths
such as `.ssh` below it stay hidden — before, they were not hidden in this layout either). Reproduced and verified with
real bubblewrap in a throw-away Ubuntu 24.04 container with the ip-172 layout: the old arguments fail exactly like
production; the new ones give the seed copy, read-write login stores (writes reach the host: token refreshes persist),
read-only trusted config and `.gitconfig`, hidden `.ssh`, the masked data dir and a home whose other writes do not reach
the host.

## 5. Windows: folders owned by the pre-rename service

DESKTOP 2026-11-02: every Claude Code attempt with an added subscription account failed `icacls
…\runtime-accounts\claude-code\<id> failed (5): Access is denied`. The worker runs as `NT SERVICE\RemyralWorker`; the
folder (and `data\sandbox`) is owned by the pre-rename `NT SERVICE\RemanaWorker` (`S-1-5-80-3774…`), and the service only
has Modify there — changing an ACL needs ownership (or WRITE_DAC). The privileged updater's legacy-ACL cleanup never ran
on the machine: the updater is not auto-updated by design (p2-signed-updates) and is still the 24 October build. Changes:

- `install.ps1` gives the data and workspace trees to the service (`icacls … /setowner *<service SID> /T /C /Q`, every
  run, idempotent); a re-run of the installer kit repairs such a machine.
- The worker's icacls failure with exit 5 names the cause and the administrator's fix instead of a bare "Access is
  denied".
- Not verified by running: `infra/worker/windows/test/Install.Tests.ps1` (no PowerShell on the build machine).

## 6. Not closed here

- The two tests that fail only in full runs (`blob-upload` window boundary, `object-storage-rest` run files) did not
  reproduce: 300 repetitions of the first (1.2 GB of random data, no false secret hit in 80 MiB), five runs of the
  second against a real database. Their failure text was never recorded; the next full run keeps its log.
- Linux isolation live checks (p19-linux-*) run on ip-172 after this release (settings switched on from the panel).

## 7. Verification

- `apps/worker/test/runtime-unverified.test.ts`: `<cli>+sdk.<sdk>` admitted by its CLI version, another CLI refused.
- `apps/master/test/unit/p22-hosted-rate.test.ts`: GitLab 429 pause until the reset and resume, reserve, Bitbucket bare
  429 and `Retry-After`, 5xx pauses nothing, one budget per connection.
- `apps/web/test/machine-local-settings.test.tsx`: the banner with the setting's name and the restart link; none
  without a pending restart.
- `apps/worker/test/p22-worker-limits.test.ts`: a home inside the data dir is mounted after the mask, `.ssh` hidden; plus
  the real-bubblewrap run above.
- `apps/worker/test/p22-icacls-hint.test.ts`: exit 5 explains the ownership fix.

## Changelog

- fix(worker,master,web,i18n): **harness gaps** (p22-harness-gaps, [design](p22-harness-gaps.md); owner
  2026-11-02: "eksikleri kapatalım"). An owner-approved unverified Claude Code install is admitted when its agent SDK
  is not the pinned one (the probe's `<cli>+sdk.<sdk>` is compared by its CLI part); GitLab and Bitbucket rate limits
  pause the connection until the reset and keep a reserve for work that cannot wait, like GitHub's; every machine tab
  names the saved settings that wait for a restart ("Makinedeki Remyral yeniden başlatılmalı") with the way to the
  restart. Linux: the private home of parallel subscription jobs works on a system install whose HOME lies inside
  the data dir (every Claude Code attempt exited 125 on ip-172). Windows: the installer gives the data and workspace
  folders to the service (folders still owned by the pre-rename service made account lending fail "Access is
  denied"), and that failure now names the fix.
