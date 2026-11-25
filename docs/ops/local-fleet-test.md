# Local fleet test: this Mac + a Linux worker in Docker

Without real remote machines, a fleet can be tested with **this Mac** (or any workstation) plus **one Linux worker running in a Docker container**. Two ways to use it:

- **A. Automated end-to-end test** — `pnpm e2e:fleet` starts its own throw-away master and checks pairing, heartbeats, reconnects, drain and revoke, then removes everything.
- **B. Persistent container worker** paired to **your own dev console** — you approve it in Machines and it stays online.

Both reach the master the way a remote node does: `wss://` through a TLS-terminating proxy with a self-signed dev CA, and **TLS verification on** (the worker only trusts that CA). The worker refuses `ws://` for anything but loopback ([worker-pairing.md](worker-pairing.md)), and the container's loopback is not the Mac's.

```
container ──wss://host.docker.internal:8443──▶ TLS proxy (127.0.0.1:8443 on the Mac) ──ws://──▶ master (127.0.0.1:8080)
Mac worker ──wss://127.0.0.1:8443─────────────▶ same proxy
```

Docker Desktop forwards `host.docker.internal` to the Mac's loopback, so the proxy binds `127.0.0.1` only — nothing is exposed on the LAN.

Prerequisites: Docker Desktop running, the dev stack up (`pnpm dev:up`), the repo `.env` from `pnpm dev:keygen`, Node 24, pnpm, `openssl` (macOS has it).

## A. Automated test: `pnpm e2e:fleet`

```sh
pnpm install
pnpm e2e:fleet               # builds master + worker bundle first
pnpm e2e:fleet --skip-build  # reuse existing apps/master/dist and apps/worker/dist
pnpm e2e:fleet --no-host-worker --keep-logs
```

What it does (about 3–4 minutes):

1. Builds the master and the single-file worker bundle.
2. Drops and recreates the throw-away database **`remyral_e2e_fleet`**, migrates it, and flushes Redis logical DB **14**. Your `remyral` dev database and your running master are never touched.
3. Starts its own master on **127.0.0.1:8180** and the TLS proxy on **127.0.0.1:8443** (fresh dev CA in a temp dir; certificate SAN `host.docker.internal`, `localhost`, `127.0.0.1`). Checks that a container reaches it with the CA and is rejected without it.
4. Creates an owner with the master's own `createUser`, logs in and enrolls TOTP through the API (like `apps/web/e2e`).
5. Builds `infra/dev/docker-worker` and runs `remyral-worker pair` in a container with a named data volume. Reads the pairing code and fingerprint from the worker's output and approves it **exactly like the console**: finds the pending worker in `GET /workers`, compares the fingerprint, step-up with a fresh TOTP code, `POST /workers/<id>/approve {pairingCode}`.
6. Starts `remyral-worker run` in the container and asserts: `online`, host facts `linux/arm64` (the Docker server's architecture), capabilities and heartbeat load reported.
7. Pairs and runs a second worker **on this Mac** (`wss://127.0.0.1:8443`) and asserts both are online at once with different OS.
8. Chaos on the container worker: `docker pause` → offline (heartbeat loss) → `unpause` → online with a new session; `docker kill` + `rm` + a new container on the same volume → online again with the **same worker id and key** (challenge-response, no new enrollment); **drain** → `draining`; **revoke** → socket closed at once, quarantined, keys revoked; restarting the container → refused (`ERROR revoked`), no session.
9. Cleans up **always** (also on failure or Ctrl-C): host worker, containers (by label), volume, proxy, master, database, Redis DB 14, temp files.

Output ends with a PASS/FAIL table; exit code 0 only if every check passed. On failure the master and worker JSON logs are copied to `$TMPDIR/remyral-e2e-fleet-logs-<run>` (they hold no secrets). Ports can be changed with `E2E_FLEET_MASTER_PORT` / `E2E_FLEET_PROXY_PORT`.

Last run (2026-10-13, MacBook Air M-series, Docker Desktop 29.6.2): **17/17 PASS** (with build, about 3 minutes) — offline detected 19–41 s after `docker pause` (ping every 30 s, 15 s pong timeout), reconnect within 2 s after `unpause`, revoke closed the socket within 2 s.

## B. Persistent container worker paired to your dev console

### 1. Restart your dev master with the Fleet code

Your running master (started before the Fleet merge) does not have the worker gateway and Fleet API yet. Stop it (Ctrl-C in its terminal), apply the new migrations to your dev database, and start it again:

```sh
pnpm --filter @remyral/master migrate   # applies pending migrations (0004+ for Fleet) to the remyral dev DB
pnpm --filter @remyral/master dev       # rebuilds and starts on 127.0.0.1:8080
```

The web console on 5173 picks up the new Fleet screen by itself (Vite); reload the page.

### 2. Create the dev CA and server certificate (once)

```sh
node scripts/e2e/dev-ca.mjs infra/dev/secrets/fleet-tls
```

Writes `ca.pem`, `ca.key`, `server.pem`, `server.key` (keys 0600, valid 30 days) into the git-ignored `infra/dev/secrets/`. It never overwrites existing files; delete the directory to make new ones.

### 3. Start the TLS proxy (keep this terminal open)

```sh
node scripts/e2e/tls-proxy.mjs \
  --cert infra/dev/secrets/fleet-tls/server.pem --key infra/dev/secrets/fleet-tls/server.key \
  --listen 127.0.0.1:8443 --target 127.0.0.1:8080
```

### 4. Build the worker image

```sh
pnpm --filter @remyral/worker bundle
docker build -f infra/dev/docker-worker/Dockerfile \
  --build-context bundle=apps/worker/dist -t remyral-worker-dev infra/dev/docker-worker
```

### 5. Write the worker config

```sh
mkdir -p ~/.remyral-docker-worker
cat > ~/.remyral-docker-worker/config.json <<'EOF'
{
  "masterUrl": "wss://host.docker.internal:8443",
  "workspaceRoot": "/srv/remyral/workspaces",
  "dataDir": "/var/lib/remyral-worker"
}
EOF
chmod 600 ~/.remyral-docker-worker/config.json
docker volume create remyral-worker-linux-data
```

### 6. Pair

```sh
docker run --rm -it \
  -v remyral-worker-linux-data:/var/lib/remyral-worker \
  -v ~/.remyral-docker-worker/config.json:/etc/remyral-worker/config.json:ro \
  -v "$PWD/infra/dev/secrets/fleet-tls/ca.pem:/etc/remyral-worker/ca.pem:ro" \
  -e NODE_EXTRA_CA_CERTS=/etc/remyral-worker/ca.pem \
  remyral-worker-dev pair
```

It prints a **pairing code** and a **fingerprint** and waits. In the console open **Machines**: the worker is under **Waiting to pair** (platform `linux`, `arm64`). Compare the fingerprint character by character, type the pairing code, press **Approve**, and confirm with your authenticator when asked. The container prints `Approved: this machine is worker wrk_…` and exits.

### 7. Run it

```sh
docker run -d --name remyral-worker-linux --restart unless-stopped \
  -v remyral-worker-linux-data:/var/lib/remyral-worker \
  -v ~/.remyral-docker-worker/config.json:/etc/remyral-worker/config.json:ro \
  -v "$PWD/infra/dev/secrets/fleet-tls/ca.pem:/etc/remyral-worker/ca.pem:ro" \
  -e NODE_EXTRA_CA_CERTS=/etc/remyral-worker/ca.pem \
  remyral-worker-dev run
docker logs -f remyral-worker-linux       # JSON lines; Ctrl-C stops following, not the worker
```

Machines shows it **online** with its capabilities within a few seconds. Run commands from the repo root (`$PWD` in the mounts).

### Everyday operations

| Want | Do |
|---|---|
| Stop / start | `docker stop remyral-worker-linux` / `docker start remyral-worker-linux` (the identity lives in the volume) |
| Master or proxy restarted | nothing — the worker reconnects by itself with backoff |
| New worker code | rebuild the bundle and image (step 4), `docker rm -f remyral-worker-linux`, step 7 again — same volume, same identity |
| Remove for good | **Revoke** in Machines → <machine> → Admin, then `docker rm -f remyral-worker-linux && docker volume rm remyral-worker-linux-data` |
| Pair again after a revoke | a revoked key is never accepted again: remove the volume (new device key) and repeat steps 5–7 |

A worker on the Mac itself can join the same way without Docker: put a config with `"masterUrl": "wss://127.0.0.1:8443"` (or `ws://127.0.0.1:8080`, loopback only) in `~/Library/Application Support/RemyralWorker/config.json` and run `NODE_EXTRA_CA_CERTS=infra/dev/secrets/fleet-tls/ca.pem node apps/worker/dist/remyral-worker.mjs pair`, then `… run`.

## Security notes

- The dev CA key never leaves `infra/dev/secrets/` (git-ignored). Workers get only `ca.pem`. Never disable TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`) — the worker would then accept any master.
- The proxy binds `127.0.0.1`; do not change `--listen` to `0.0.0.0` on a laptop on a shared network.
- Under Docker's default seccomp profile, the Codex OS sandbox fails closed in this container ([compat/handson-2026-10-13.md](../compat/handson-2026-10-13.md), finding 1); this container is a fleet-connectivity test bed, not a job sandbox.
