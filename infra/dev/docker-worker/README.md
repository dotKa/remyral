# Dev worker container (Linux)

A Remyral worker in a Docker container, for local fleet tests on a developer machine. **Not** a production image — production Linux nodes run the single-file worker as a systemd service ([docs/ops/worker-install.md](../../../docs/ops/worker-install.md)). How to use it: [docs/ops/local-fleet-test.md](../../../docs/ops/local-fleet-test.md).

| File | What |
|---|---|
| `Dockerfile` | `node:24-bookworm-slim` pinned by multi-arch index digest, `git`, non-root user `remyral` (uid 10001), the bundle at `/opt/remyral/remyral-worker.mjs`. Entrypoint `node /opt/remyral/remyral-worker.mjs`, default command `run`. |
| `Dockerfile.runtimes` | Optional variant on top of it with the four runtimes at their exact pins (compat/README.md §1), `bubblewrap` and `procps` (ADR-0023 removed OpenHands). Used for the credential-free hands-on checks ([docs/compat/handson-2026-10-13.md](../../../docs/compat/handson-2026-10-13.md)). No credentials inside. |

## Build

```sh
pnpm --filter @remyral/worker bundle                       # → apps/worker/dist/remyral-worker.mjs
docker build -f infra/dev/docker-worker/Dockerfile \
  --build-context bundle=apps/worker/dist \
  -t remyral-worker-dev infra/dev/docker-worker
# optional, ~10 minutes, ~4 GB image:
docker build -f infra/dev/docker-worker/Dockerfile.runtimes \
  -t remyral-worker-dev:runtimes infra/dev/docker-worker
```

The bundle comes in through the named build context `bundle`, so the build context stays tiny and nothing else from the repo (no `.env`, no secrets) is sent to the Docker daemon. The base digest is a multi-arch index (amd64 + arm64), but only `linux/arm64` (Apple silicon) was built and tested; `linux/amd64` is UNVERIFIED.

## Runtime contract

| Path in the container | Mount | Notes |
|---|---|---|
| `/etc/remyral-worker/config.json` | bind, read-only | `REMYRAL_WORKER_CONFIG` points here. Mode 0600 on the host is fine: Docker Desktop maps the owner to the container user. |
| `/etc/remyral-worker/ca.pem` | bind, read-only (optional) | Dev CA of a self-signed master; trusted with `-e NODE_EXTRA_CA_CERTS=/etc/remyral-worker/ca.pem`. TLS verification stays on. |
| `/var/lib/remyral-worker` | **named volume** | `dataDir`: device key, enrollment, outbox. Keep the volume to keep the worker's identity across container re-creation; delete it to pair as a new worker. |
| `/srv/remyral/workspaces` | container filesystem (or a volume) | `workspaceRoot`. |

Minimal config (`masterUrl` must be `wss://` unless it is loopback — and the container's loopback is not the host's):

```json
{
  "masterUrl": "wss://host.docker.internal:8443",
  "workspaceRoot": "/srv/remyral/workspaces",
  "dataDir": "/var/lib/remyral-worker"
}
```

## Limits

- Docker Desktop forwards `host.docker.internal` to the host's **loopback**, so a TLS proxy bound to `127.0.0.1` on the Mac is reachable from the container without exposing anything on the LAN (verified 2026-10-13, Docker Desktop 29.6.2).
- Under Docker's default seccomp profile, bubblewrap cannot create user namespaces: the Codex OS sandbox fails closed inside this container (handson finding 1). Do not loosen seccomp for routine use.
- No Docker inside the container, so the ADR-0007 `container` profile is not available here.
