# Design note: `p17-domain-wizard` — set the console's domain in the setup wizard, without a terminal

- **Task:** `p17-domain-wizard`. **Date:** 2026-10-24. **Migration:** `0151_console_domain.sql` (after `0150_user_theme`).
- **ADR:** [ADR-0063 amendment 2026-10-24](../adr/0063-selfhost-distribution-and-update-trust.md#amendment-2026-10-24-the-consoles-domain-from-the-setup-wizard-p17-domain-wizard)
  (threat model there).
- **Owner direction (2026-10-24):** "kurulumda domaini terminalden setlememi söylüyor. bunu terminale gitmeden kurulum
  sihirbazında ayarlayabilmeliyim." The step "Alan adı ve erişim" (p17-remyral-brand) only showed facts and a
  `sudo remyral-ctl install --domain …` command.
- **Builds on:** p16-selfhost-onboarding (wizard, remyral-ctl, the daily `upgrade --check` timer, Traefik overlay),
  p16-ops-safety (`tls:public-origin`), ADR-0056 (step-up events), p5-worker-onboarding (PUBLIC_ORIGIN).
- **Guides:** customer EN [docs/ops/selfhost-install.md](../ops/selfhost-install.md#domain), TR
  [docs/guide/tr/kurulum.md](../guide/tr/kurulum.md).
- **Worker release:** none (no protocol or assistant change). **Host:** the new `remyral-ctl` arrives with the next
  control-plane release (see "Rollout").

## 1. Pieces

| Piece | Where |
| --- | --- |
| Setting + requests (migration 0151) | `console_domain_setting` (one row), `console_domain_requests` (one open at a time) |
| Master service, routes | `apps/master/src/console-domain/{origin,domain,dns,host-files,service,routes}.ts` |
| Live origin for link builders | `OriginInput` / `originOf` (installers, GitHub connect, git flow PR links, automations, workflow waits, webhooks-out, notifications, TLS check) |
| Host applier | `remyral-ctl apply-pending`, units `remyral-apply-pending.{service,path,timer}` |
| Shared directory | `<data>/host/{requests,status}` ↔ `/run/remyral-host` (only `compose.selfhost.yaml` mounts it; `HOST_APPLIER_DIR`) |
| Wizard step | `apps/web/src/diyalog/onboarding/DomainStep.tsx`, `apps/web/src/api/consoleDomain.ts` |

## 2. Setting precedence

`effective origin = console_domain_setting.public_origin ?? PUBLIC_ORIGIN ?? origin(NOTIFY_PUBLIC_URL)`; notification
links use `setting ?? NOTIFY_PUBLIC_URL`. `ConsoleDomainService.current()` is synchronous (in-memory copy, loaded on
`onReady`, after every save, and on the orchestrator tick — another master instance sees a change within one tick).
Consumers take an `OriginInput` (a string — tests, the release-import CLI — or a live source) and call `originOf()` per
link, so a saved address is used at once. Where a consumer had its own configured value (e.g. a test's
`gitflow.consoleOrigin`), `overlay(value)` keeps it as the fallback. The ops / preview / Coolify "console host is
protected" checks add the saved host live. The TLS check (`tls:public-origin`) re-checks when the origin changes.

`DELETE /console-domain` forgets the setting (back to the environment). The doctor's configuration summary still shows
the environment values (it reports configuration, not the setting).

## 3. Routes (owners; `console.domain.read` / `console.domain.write`)

| Route | Step-up | Does |
| --- | --- | --- |
| `GET /console-domain` | — | origin, source (`setting` / `environment` / `none`), the setting, the environment value, the host applier (`managed` = heartbeat ≤ 5 min old; domain, TLS mode, ACME e-mail, HTTPS port, version), the open request or the latest of 24 h (reconciles first) |
| `POST /console-domain/dns-check` | — | resolves A + AAAA (5 s, injectable resolver) and compares with the current name's addresses and the applier's addresses: `match` / `cloudflare` (all answers in Cloudflare's ranges — a hint only) / `mismatch` / `not_found` / `unknown` / `error` |
| `PUT /console-domain {domain, tls?, email?}` | event `console.domain` | no applier: stores `https://<domain>` (`console.domain.set`). Applier: the name the host already serves → only the setting; otherwise a signed request (`console.domain.request`), 409 while one is open |
| `DELETE /console-domain` | same | `console.domain.clear` |
| `POST /console-domain/request/cancel` | same | withdraws a `pending` request (removes the files) |

Validation (master and host alike): lower-case DNS name with a dot, ≤ 253, labels ≤ 63, not an IP, no scheme / port /
path (a pasted `https://name/` is reduced); TLS mode one of three; ACME e-mail `[A-Za-z0-9._%+-]+@…` (bash-safe).
Let's Encrypt needs ports 80/443 and an e-mail (given or stored on the host). Error codes: `invalid_domain`,
`invalid_email`, `email_required`, `letsencrypt_needs_standard_ports`, `domain_unchanged`,
`domain_change_in_progress`, `no_pending_request`, `host_applier_unavailable`.

## 4. Signed request, applier, rollback

**Request** (`requests/domain-change.json`, pretty JSON, fixed key order, one string per line; values are refused if
they contain a quote, backslash or control character): `kind = remyral-host-domain-change/v1`, `id` (uuid), `nonce`
(32 hex), `domain`, `tls`, `email` (`''` = keep the host's), `previousDomain` (the heartbeat's domain), `createdAt`,
`expiresAt` (`YYYY-MM-DDTHH:MM:SSZ`, +15 min). **Signature** (`domain-change.sig.json`): `{keyId, signature}` —
Ed25519 over `"remyral-host-domain-change/v1\n" ‖ bytes` with the master's lease-signing key
(`LeaseSigner.signHostDocument`; the context must match `remyral-host-<name>/v<n>`, never a worker statement). Written
atomically (temp + rename; signature first) inside the DB transaction that stores the request row.

**Applier** (`remyral-ctl apply-pending`, root): writes the heartbeat (`status/applier.json`: version, time, domain,
TLS mode, ACME e-mail, HTTPS port, global interface addresses + optional `REMYRAL_PUBLIC_ADDRESS`), takes the
`<data>/.lock` (busy → next run), copies the request only if both files are regular files (≤ 8 / 4 KiB), deletes them,
verifies the signature with the public half of `secrets/lease-signing.pem`, validates every field, refuses an expired
request, a known nonce (`state/domain-nonces`, last 500) and a `previousDomain` that is not `REMYRAL_DOMAIN`. Same name /
mode / e-mail → `applied` ("nothing to change"). Otherwise:

1. `status/domain-result.json` = `applying`; back up stack.env and `proxy/traefik.yml`.
2. `proxy/dynamic/domain-previous.yml`: file-provider routers for the **old** name to the same services and middlewares
   as the compose labels (`<project>-master@docker`, `-web@docker`, `-api-strip`, `-to-https`) — the old name keeps
   answering while the labels move.
3. stack.env: `REMYRAL_DOMAIN`, `REMYRAL_TLS_MODE`, `REMYRAL_ACME_EMAIL`; a changed TLS mode / e-mail rewrites
   `traefik.yml` (same template as `install`).
4. `compose up -d --wait master web` (new labels, `PUBLIC_ORIGIN`); `up -d --force-recreate proxy` when the static
   configuration changed.
5. Gate on the **new** name (60 × 5 s): master / web healthy, `/api/status` ok and the console through the proxy
   (`--resolve` to the bind address), with Let's Encrypt also `curl` without `-k` (a trusted certificate).
6. Healthy → `applied`; the old name answers one more hour (`state/domain-alias`, removed by the minute timer).
   Not healthy → restore stack.env + `traefik.yml`, remove the alias, recreate, gate the old name: `rolled_back` (or
   `failed` when the old one is unhealthy too). Every step is appended to `state/domain-history`.

**Master side** (`reconcile`, on the tick and on every `GET`): a result with the open request's id moves it
(`applying`; `applied` → the setting becomes `https://<domain>[:port]`, source `host-applier`, audited as
`system:host-applier`; `rolled_back` / `failed` / `refused` → audited failure with the host's reason). A refusal with
an empty id (bad signature) closes the waiting request. A `pending` request past `expiresAt` → `expired` (files
removed); `applying` without a result for 30 min → `failed`.

**Units** (`install`, `upgrade`, and the daily `upgrade --check` when missing — an install upgraded by an older
`remyral-ctl` gets them within a day): `remyral-apply-pending.path` (`PathChanged=<data>/host/requests/domain-change.json`),
`remyral-apply-pending.timer` (every minute), `remyral-apply-pending.service` (oneshot, 20 min timeout); `uninstall`
removes them. Without systemd: run `remyral-ctl apply-pending` every minute from root's crontab.

## 5. Wizard step (Diyalog)

Facts (address in use, where it comes from, certificate, access) and a form: **Alan adı** (prefilled from the address
in use, else the host the browser reached), on a remyral-ctl host **Sertifika ve bağlantı** (Let's Encrypt with its
e-mail / Cloudflare arkasında / Kendi vekil sunucum), **DNS bu sunucuyu gösteriyor mu?** (`DNS’i denetle`, verdict
explained), then **Kaydet ve uygula** (host) or **Kaydet** (links only; the step says what the platform's operator must
route). The authenticator dialog opens when the policy asks. While a request is open the step polls every 3 s:
"…sunucuya iletildi, sıra bekliyor…" (with "Vazgeç") → "Uygulanıyor…" → "Hazır: konsol artık … adresinde." (link
"Yeni adrese geç") or "Hata: … Eski adrese geri dönüldü." / "Sunucu isteği reddetti: …" / expired. No terminal command
is shown any more.

## 6. Production finding: "Genel adres: Ayarlı değil" on console.example.org

Read: `infra/coolify/compose.yaml` (master env `NOTIFY_PUBLIC_URL` and `PUBLIC_ORIGIN` = `https://${REMYRAL_DOMAIN:?}`),
`scripts/deploy/{deploy,plan}.mjs` (compose with `--env-file <data>/stack.env --env-file release.env`), the
REMANA→REMYRAL rename (`REMANA_DOMAIN` → `REMYRAL_DOMAIN` in the compose file) and
`scripts/cutover/remana-deploy.mjs` (removed in the cut-over cleanup; `migrate-env` renames every `REMANA_*` key of stack.env to `REMYRAL_*`, so
`REMANA_DOMAIN` became `REMYRAL_DOMAIN`; the deploy refuses a stack.env with `REMANA_*` keys). The master reads
`PUBLIC_ORIGIN` (else the origin of `NOTIFY_PUBLIC_URL`) into `installers.publicOrigin`, which the step showed. The
mapping survived the rename: `REMYRAL_DOMAIN` is a required (`:?`) variable, so `compose up` refuses to start the master
without it, and with it `PUBLIC_ORIGIN` is set. **No mapping was dropped; nothing to fix there.** A master started from
this compose file cannot report a null address; the host's stack.env was not read (rule). To confirm on the host
(no secret is printed): `sudo docker exec <project>-master-1 printenv PUBLIC_ORIGIN NOTIFY_PUBLIC_URL` (container
name per `docker ps`). Independently of the cause, the owner can now save `console.example.org` in the wizard
(no applier on that host → "Kaydet" stores the setting) and "Ayarlı değil" disappears.

## 7. Rollout

- Master + web: the next `deploy.mjs` (migration 0151, additive; rollback = drop the two tables, links fall back to
  the environment).
- Self-hosted hosts: a control-plane release carrying the new `remyral-ctl` and `compose.selfhost.yaml`. `upgrade`
  with the new `remyral-ctl` creates `<data>/host`, writes `REMYRAL_HOST_DIR` and installs the units before starting
  the release. An upgrade run by an older `remyral-ctl` mounts the default `/var/lib/remyral/host` (the default data
  dir); the daily `upgrade --check` of the new binary then sets up the directory and units. Until a heartbeat exists
  the wizard stores the address only.
- Coolify / EC2 (`infra/coolify/compose.yaml`) is unchanged: no host directory, no applier.

## 8. Tests and what is unverified

- `apps/master/test/integration/console-domain.test.ts` (11): precedence (environment → setting → another instance →
  cleared), links at once (`/installers`, `/integrations/github`, notification base, protected hosts), owners only,
  step-up and audit, validation, DNS verdicts with a fake resolver, the signed request (signature verified with the
  public key, field order), one open request, applying → applied (setting follows), rolled back, unattributed
  refusal, expiry, cancel, `email_required`, host-already-serves, stale heartbeat.
- `scripts/test/selfhost-ctl.test.mjs` (+7, fake docker / curl / systemctl): install sets up the directory, units and
  heartbeat; a request written by the master's own `writeRequest` is applied (alias for the old name, stack.env,
  traefik.yml, recreate, new-name gate with a trusted-certificate probe), replay refused; rollback when the new name is
  unreachable and when Let's Encrypt has no trusted certificate; foreign signature, expired, stale, and master-signed
  values outside the rules (backticks, upper case, IP, single label) refused with nothing run; the alias expires;
  uninstall removes the units.
- `apps/web/test/selfhost-onboarding.test.tsx` (domain cases): facts, setting-only save with the authenticator dialog
  and the Cloudflare DNS hint, invalid name, a remyral-ctl host (TLS mode, e-mail, DNS mismatch, pending → ready by
  polling), rolled back.
- **UNVERIFIED** (no Linux host with systemd and Docker here): the path unit firing on a rename into the directory, the
  Traefik file-provider alias routing to `@docker` services and ACME issuance for the new name on a real host,
  `hostname -I` output on the target distributions, shellcheck (not installed here).
