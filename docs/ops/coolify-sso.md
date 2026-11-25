# Coolify single sign-on ("Open Coolify")

Owner request 2026-10-14 (p5-coolify-sso). Design and security review:
[docs/design/p5-coolify-sso.md](../design/p5-coolify-sso.md). Artefacts: [infra/coolify-sso/](../../infra/coolify-sso/).

After these steps an owner/admin clicks **Open Coolify** in the console (account menu or Settings) and Coolify
opens at `https://coolify.example.org`, signed in with the console account. Everybody else is stopped by Traefik
before Coolify sees the request. Coolify's ports 8000/6001/6002 stay closed in the security group; the SSH tunnel
keeps working as the break-glass path.

| Who | Step |
| --- | --- |
| owner | §1 DNS, §5 choose the Coolify admin e-mail / 2FA |
| orchestrator (host) | §2 secrets, §3 master variables + deploy, §4 Traefik file, §5 Coolify settings, §6 checks |

Values below are production; for staging use its own host names, `remana-staging-master` and its secrets dir.

## 1. DNS (owner)

Cloudflare → `example.org` → DNS → add `coolify` **A <elastic-ip>, Proxied** (orange cloud). SSL mode stays as for
the console (Full; Full (strict) once the origin certificate covers `coolify.example.org` —
[deploy-coolify.md](deploy-coolify.md) §4: issue it for `console.example.org` **and** `coolify.example.org`, or
`*.example.org`).

Also in Cloudflare: **Caching → Cache Rules → Bypass cache** for hostname `coolify.example.org` (every response must
come from the origin through the gate; Coolify's static files would otherwise be served from the edge without it).
WebSockets must be enabled (Network → WebSockets, on by default).

## 2. Secrets (host)

```sh
cd /data/remyral/prod/secrets
# ID-token signing key (RS256 — the only algorithm Coolify's OIDC client accepts)
sudo sh -c 'umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out oidc-signing.pem'
# OIDC client secret shared with Coolify (64 hex characters)
sudo sh -c 'umask 077; openssl rand -hex 32 > coolify-oidc-client-secret'
sudo chown 10001:10001 oidc-signing.pem coolify-oidc-client-secret
sudo chmod 0400 oidc-signing.pem coolify-oidc-client-secret
```

Back both up off-host with the other secrets ([backups.md](backups.md)). Losing them is harmless: generate new ones,
restart the master, paste the new client secret into Coolify (§5). Rotation = the same.

## 3. Master variables and deploy (host / Coolify resource "remyral")

Add to the resource's Environment Variables (none is secret; the secrets are the files of §2):

| Variable | Value |
| --- | --- |
| `SSO_CONSOLE_ORIGIN` | `https://console.example.org` |
| `OIDC_SIGNING_KEY_FILE` | `/run/secrets/remyral/oidc-signing.pem` |
| `OIDC_COOLIFY_CLIENT_SECRET_FILE` | `/run/secrets/remyral/coolify-oidc-client-secret` |
| `OIDC_COOLIFY_REDIRECT_URIS` | `https://coolify.example.org/auth/oidc/callback` |
| `OIDC_EMAIL_MAP` | `<owner-username>=<e-mail of the existing Coolify admin account>` (more: `user=email,user2=email2`) |
| `COOLIFY_SSO_HOST` | `coolify.example.org` |

Deploy the build that contains p5-coolify-sso (migration **0027**; `node scripts/deploy/deploy.mjs`,
[cicd.md](cicd.md)). The compose file now also gives the master the network alias `<project>-master` (`remyral-prod-master` by default; `<project>` is the install's compose project) on the
`coolify` network (used by Traefik's forwardAuth) and blocks `/api/forward-auth/*` and `/api/coolify-sso/callback`
on the console host.

Check: `curl -s https://console.example.org/api/oidc/.well-known/openid-configuration | jq .issuer` →
`"https://console.example.org/api/oidc"`. Coolify fetches discovery, JWKS, token and userinfo **server-side**
from the EC2 host through Cloudflare; check that path too (Cloudflare bot protection must not challenge it):
`sudo docker exec coolify curl -s -o /dev/null -w '%{http_code}\n' https://console.example.org/api/oidc/jwks` →
`200`.

**Email mapping.** Coolify links the SSO identity to an existing Coolify account **by e-mail** (and requires the
e-mail to be verified, which the master asserts for mapped accounts). Look up the admin's e-mail in Coolify
(Profile) or on the host:
`sudo docker exec coolify-db psql -U coolify -d coolify -c 'select id, email from users order by id'` — user id 0 is
the first (root) admin. The `OIDC_EMAIL_MAP` entry must match it exactly (case-insensitive). A console user without
an entry cannot sign in to Coolify.

## 4. Traefik dynamic configuration (host)

1. Confirm the realtime layout of this Coolify version: `sudo docker ps --format '{{.Names}}' | grep -i coolify`.
   Coolify ≥ 4.4 serves UI, realtime and terminal from the `coolify` container (ports 8080/6001/6002). If a separate
   `coolify-realtime` container exists (older installs), change the two service URLs `coolify:6001`/`coolify:6002` in
   the file to `coolify-realtime:6001`/`coolify-realtime:6002`.
2. Confirm the master is reachable from the proxy:
   `sudo docker exec coolify-proxy wget -qO- -S http://remyral-prod-master:8080/forward-auth/coolify 2>&1 | head -1`
   → `HTTP/1.1 403` (wrong host — the endpoint answers, it is not open).
3. Coolify UI (tunnel, [deploy-coolify.md §10](deploy-coolify.md#10-host-perimeter-and-access)) → Servers → localhost → Proxy → **Dynamic
   Configurations** → add `remana-coolify-sso.yaml` with the content of
   [infra/coolify-sso/remana-coolify-sso.yaml](../../infra/coolify-sso/remana-coolify-sso.yaml). (Equivalent:
   `sudo install -m 0644 remana-coolify-sso.yaml /data/coolify/proxy/dynamic/`.) Traefik reloads it by itself.
4. Check from anywhere (before Coolify knows its domain):
   ```sh
   curl -sI https://coolify.example.org/ -H 'Sec-Fetch-Mode: navigate' | grep -iE '^(HTTP|location|set-cookie)'
   # HTTP/2 302, location: https://console.example.org/api/coolify-sso/ticket?r=…, set-cookie: __Host-rcs-state-…
   curl -s -o /dev/null -w '%{http_code}\n' https://coolify.example.org/api/v1/version   # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://coolify.example.org/app/x -H 'Upgrade: websocket' -H 'Connection: Upgrade'   # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://console.example.org/api/forward-auth/coolify   # 404 (web)
   ```
   None of these may show Coolify content.

## 5. Coolify settings (tunnel, then through the gate)

Exact values: [infra/coolify-sso/coolify-settings.yaml](../../infra/coolify-sso/coolify-settings.yaml).

1. **Settings → General → Instance's Domain** = `https://coolify.example.org`. Coolify writes its own routers for the
   host (`/data/coolify/proxy/dynamic/coolify.yaml`); ours have priority ≥ 10000 and win. Re-run the §4 checks.
2. **Settings → Registration**: registration **off**; "Disable password registration when OAuth is enabled" on.
3. **Settings → OAuth → OpenID Connect**: Client ID `coolify`; Client secret = content of
   `coolify-oidc-client-secret` (`sudo cat /data/remyral/prod/secrets/coolify-oidc-client-secret`, paste, never
   store elsewhere); Issuer URL `https://console.example.org/api/oidc`; Redirect URI
   `https://coolify.example.org/auth/oidc/callback`; Scopes `openid email profile`; Use PKCE **on**; Require
   verified email **on**; Allow OIDC user creation **off**; Auto-join Root team off; Login button label
   `Remyral console`. Save, then **Enabled**.
4. **Coolify's own 2FA** (owner decision): if the Coolify admin has Coolify 2FA enabled, Coolify still asks for that
   code after SSO (so "Open Coolify" shows one Coolify prompt). Keeping it = two factors in two systems; turning it
   off (Profile → Two-factor) after §6 passed is acceptable because Coolify is only reachable through the gate, and
   the SSO login itself requires the console password, TOTP and a step-up within 10 minutes.

## 6. Test checklist

- [ ] Signed out of the console, open `https://coolify.example.org/` → console sign-in → "Continue to Coolify" →
      Coolify login page (or straight into Coolify via the button, below). No Coolify page before that.
- [ ] Console as owner → account menu → **Open Coolify** → new tab → (authenticator prompt if the last code is older
      than 10 minutes) → Coolify dashboard as the existing admin (same team/resources as before).
- [ ] Coolify realtime works (deployment logs stream; no "realtime connection" error banner) and a server terminal
      opens (terminal WebSocket through the gate).
- [ ] Console **Log out** → reload the Coolify tab → back to the console sign-in (gate closed within seconds).
- [ ] A viewer/operator account: no button; opening `https://coolify.example.org` ends at "needs the owner or admin
      role"; `oidc.authorize`/`sso.coolify.ticket` denied entries in Audit.
- [ ] Audit (console → Audit, filter `oidc.` / `sso.coolify.`): `sso.coolify.ticket`, `sso.coolify.session`,
      `oidc.authorize`, `oidc.token` success entries for the owner.
- [ ] `curl` checks of §4 still 302/401/401/404 after §5.
- [ ] Coolify API tokens are no longer usable from outside (by design: `/api/v1/*` is behind the gate). Automation
      that needs the Coolify API uses the SSH tunnel to `localhost:8000`.

## 7. Rollback

1. Disable the OIDC provider in Coolify (Settings → OAuth → OpenID Connect → Enabled off). Password login through the
   tunnel keeps working.
2. Remove the gate: delete the dynamic configuration `remana-coolify-sso.yaml` (Coolify UI or
   `sudo rm /data/coolify/proxy/dynamic/remana-coolify-sso.yaml`). **Then also clear Settings → Instance's Domain**
   (otherwise Coolify's own routers would serve `coolify.example.org` without the gate), or remove the DNS record.
3. Unset the six master variables and redeploy: the button disappears and the SSO endpoints answer 404. Migration
   0027 only added tables; nothing to undo.
4. Optional: delete the two secret files.

## 8. Operations

- Signals: audit actions `oidc.authorize`, `oidc.token`, `oidc.code.replay` (alert-worthy: a replayed code),
  `sso.coolify.ticket`, `sso.coolify.session`. The forward-auth endpoint logs only at warn (it is called for every
  Coolify request).
- Key rotation: replace `oidc-signing.pem`, restart the master; Coolify refetches the JWKS when it sees the new `kid`.
- Client-secret rotation: new file, restart the master, paste into Coolify — in that order, a login in between fails
  harmlessly.
