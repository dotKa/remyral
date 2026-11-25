# A Linux Remyral worker in a container, for local fleet tests (docs/ops/local-fleet-test.md).
# Not a production image: production Linux nodes run the worker as a systemd service (worker-install.md).
#
# Build (the single-file bundle comes in through the named build context `bundle`):
#   pnpm --filter @remyral/worker bundle
#   docker build -f infra/dev/docker-worker/Dockerfile \
#     --build-context bundle=apps/worker/dist -t remyral-worker-dev infra/dev/docker-worker
#
# Runtime contract:
#   /etc/remyral-worker/config.json  worker config, mounted read-only (REMYRAL_WORKER_CONFIG points here)
#   /etc/remyral-worker/ca.pem       optional dev CA for a self-signed master, mounted read-only and
#                                   trusted via NODE_EXTRA_CA_CERTS (TLS verification stays on)
#   /var/lib/remyral-worker          dataDir (device key, enrollment, outbox) — mount a named volume so
#                                   the identity survives container restarts
#   /srv/remyral/workspaces          workspaceRoot

# node:24-bookworm-slim, multi-arch index digest (linux/amd64 + linux/arm64), pinned 2026-10-26 (Node 24.22.1).
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# git: workspace checkouts (p3-workspace) and the probe's tool inventory. Nothing else is needed by the worker.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Dedicated non-root user; the worker refuses world-writable or foreign-owned config/data paths.
RUN useradd --create-home --uid 10001 --user-group --shell /bin/bash remyral \
  && install -d -o remyral -g remyral -m 0700 /var/lib/remyral-worker \
  && install -d -o remyral -g remyral -m 0750 /srv/remyral /srv/remyral/workspaces \
  && install -d -o root -g root -m 0755 /etc/remyral-worker /opt/remyral

COPY --from=bundle --chmod=0755 remyral-worker.mjs /opt/remyral/remyral-worker.mjs

ENV REMYRAL_WORKER_CONFIG=/etc/remyral-worker/config.json \
    NODE_ENV=production

USER remyral
WORKDIR /home/remyral

ENTRYPOINT ["node", "/opt/remyral/remyral-worker.mjs"]
CMD ["run"]
