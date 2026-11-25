# p14-login-status-consistency — one story about a runtime's login

Status: implemented (2026-10-21). No ADR, no migration. Builds on p5-remote-ops (ADR-0017), p10-claude-login-health
and p13-runtime-accounts (ADR-0049).

## Problem

Owner screenshot, Diyalog Makine → Runtime’lar, machine `ip-10-0-0-12`, Claude Code, about 11 s after a login
check: the header pill said "Oturum kapalı", an amber notice said "Claude Code ip-10-0-0-12 makinesinde oturumu
kapalı.", while the row below said "Abonelik oturumu — Oturum açık · claude.ai ile · … denetlendi" and the toast said
the check succeeded.

The two halves come from different sources:

| What | Source | Computed by |
| --- | --- | --- |
| Pill + notice | fleet compatibility cell `not_authenticated` (apps/master/src/fleetview/overview.ts) | CAPABILITIES `runtimes[].authenticated: 'no'` — the adapter probe (`probeAuth`), or a flagged expired login (`loginExpired`) |
| "Abonelik oturumu" row | remote-ops login report | `LoginManager.status/check` — `claude auth status --json` |

They can disagree for three reasons:

1. **Stale probe.** After a login / status check / logout the remote-ops agent called `changed()` →
   `refreshCapabilities()` → `registry.refreshAll()` *without* `force`, so a probe younger than 60 s was re-sent as is.
2. **The web reloaded once too early.** For login operations `reportReflects` is immediately true, so the tab reloaded
   the compatibility cell once — usually before the worker's new CAPABILITIES had reached the master.
3. **Jobs do not use the subscription login at all.** In `secret-ref` mode the probe does not run the status command:
   it reports `credentialConfigured`. When the machine's applied `runtimeAuth` has *no* entry for the runtime, the
   registry builds the adapter as `secret-ref` with `credentialConfigured: false` → `authenticated: 'no'`, whatever
   the subscription login says. "Oturumu kapalı" is then the wrong explanation: the fix is to choose the subscription
   login (or bind an API key) in the machine's configuration, not to log in again.

A second owner screenshot (same machine, Linux x64, worker 1.0.46) showed the mismatch was **persistent** (71 s after
the check) and that the "Limit pencereleri" panel had no subscription window — i.e. the worker itself did not treat
Claude Code as a `local-login` runtime (usage windows, the queue's subscription accounting, the assistant and the
probe all key off the applied `runtimeAuth`). That is reason 3, reached in one of two ways the code allowed:

4. **The panel takeover dropped the subscription login.** For a machine still on its local file the panel's
   "take over" prefill (`suggestedFrom`, apps/master/src/worker-config/service.ts) copied projects, runtimes,
   parallelism and labels — but not `runtimeAuth`. Saving it produced a generation without `runtimes.claude-code.auth`;
   the worker's effective auth then had no entry (a local `runtimeAuth` only wins when written in the file, ADR-0015
   rule 4), so jobs had no sign-in method while the login relay (which does not care about the job auth) still
   reported the login as active.
5. **A configuration change was reported with the old adapters.** `APPLY_WORKER_CONFIG` re-sends CAPABILITIES right
   away, but the registry rebuild for the new auth (`RuntimeRegistry.reconfigure`, async: locate + mkdir per runtime)
   was not awaited; CAPABILITIES built before the swap carried the previous `authenticated: 'no'`, and nothing re-sent
   them later. So even after the panel was switched to "Makinedeki yerel giriş", the cell could stay "Oturum kapalı"
   until some unrelated CAPABILITIES (reconnect, install, login check after the cache aged out).

Which one applied on `ip-10-0-0-12` cannot be read from here (UNVERIFIED: Makine → Yapılandırma → Runtime ve modeller
shows the applied auth; with this change the Runtime’lar tab says it directly). Both are fixed.

A smaller divergence: the login relay parsed `auth status --json` tolerantly (a notice line around the JSON is fine),
the probe used a strict `JSON.parse` (→ `unknown`). The env was already the same for the configured login: both use
the worker's allow-listed env plus its own `CLAUDE_CONFIG_DIR` when set (`loginEnv` in login.ts, `loginEnv()` +
`minimalEnv` in the adapter); added accounts use their own dir on both sides.

## Design

**Worker.** `RemoteOpsDeps.reprobe(runtime)` (narrow, optional; wired to `registry.refresh(runtime, true)`). After a
successful `login.start`, after `login.status` and after `login.logout` of the configured login (`default`), the agent
re-probes the runtime (bounded by 20 s, never throws) and only then calls `changed()`; the operation's result is sent
after that, so CAPABILITIES with the fresh `authenticated` reach the master before the panel sees the operation end.
Added accounts only change the login report (`changed()` as before, no re-probe). The Claude Code probe parses the
status output like the relay (`parseAuthStatusJson`).

The registry rebuild for a new configuration now ends with `onRuntimesReconfigured` → CAPABILITIES again
(apps/worker/src/jobs/from-config.ts), so the reported auth state always follows the applied configuration.

**Master.** The takeover prefill carries `local-login` over (`runtimes.<kind>.auth`; key references cannot be
transcribed — the report has names only — so a `secret-ref` runtime is left for the admin). The fleet compatibility
cell's `not_authenticated` reason names the job auth from the stored config report: "no sign-in method is configured
for jobs …" (no entry) or "jobs on this machine use an API key (secret-ref) …" (secret-ref), else the old login text.
`lib/reasons.ts` / `reasonsTr.ts` turn those into their own sentences with "Open configuration" as the fix (Home,
machine list, machine page), instead of "signed out — log in again".

**Web (Diyalog Makine → Runtime’lar).**
- An active subscription login whose jobs use an API key or nothing says so under the login row ("İşler bu oturumu
  kullanmıyor …"), and both that note and the not-signed-in notice offer **"İşler abonelik oturumunu kullansın"**: the
  same configuration write as Makine → Yapılandırma (current generation, or the takeover prefill with `adopt`; step-up;
  refused with a note when the machine's local file pins the runtime's auth), after which the tab polls until the
  applied auth is `local-login` and the cell agrees.
- After a login operation ends (or the login dialog closes), the tab reloads the machine (compatibility) every 2 s,
  at most 5 times, until the runtime's cell agrees with the login report (`loginAgrees`: logged in ⇔ not
  `not_authenticated`); disagreement is only waited for where jobs use the subscription login (or that is not known).
- A login runtime whose cell is `not_authenticated` is explained by the machine's applied `runtimeAuth`
  (`GET /workers/:id/config` → `report.effective.runtimeAuth`, read once, only when needed):
  - `secret-ref` → "jobs use an API key that is not bound" + "Yapılandırmayı aç" (Makine → Yapılandırma);
  - no entry → "no sign-in method is chosen, so jobs do not use the subscription login" + the same link;
  - `local-login` and the login report says logged in → "Durum yenileniyor" (pill + line) while polling or while the
    configuration is read; afterwards a "the runtime report still shows it signed out — check again / restart the
    runtime" note instead of a bare "oturumu kapalı";
  - otherwise the existing reason.
- New strings in `@remyral/i18n` namespace `machines.runtimeAuth` (TR + EN).

## Security

No new data crosses a boundary: the worker re-runs its own status command (only the boolean is kept, ADR-0014 rule 4);
the web reads the machine configuration route it already used on the Yapılandırma tab (admin-only; names and modes,
never secret values). No credential is read or moved. Jobs never start using a subscription login on their own: the
switch is an explicit admin configuration write through the existing route (RBAC, CSRF, step-up, audited generation);
the takeover prefill only keeps the mode the machine already ran with, and the admin still saves it.

## Rollback

Web and worker parts are independent. Reverting the worker part brings back the 60 s cache delay (the web polling
still converges once the probe ages out); reverting the web part brings back the single reload and the generic
"oturumu kapalı".
