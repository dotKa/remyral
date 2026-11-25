# Control-plane master image (p1-data-services / p1-environments; docs/ops/deploy-coolify.md).
#
#   docker buildx build -f apps/master/Dockerfile -t remyral-master:<tag> .            # native arch
#   docker buildx build --platform linux/amd64 -f apps/master/Dockerfile -t ... .      # EC2 (amd64)
#
# Context is the repository root (.dockerignore keeps dist/, node_modules, .env and secrets out).
# Stages:
#   build   (build platform)  pnpm install + compile the master and EVERY workspace package it depends
#                             on from source — no stale dist/ can enter the image.
#   deploy  (target platform) `pnpm deploy --prod`: a pruned, self-contained node_modules (no dev deps)
#                             resolved for the target architecture.
#   runtime (target platform) node + git, non-root uid 10001, read-only root fs friendly.
#
# Runtime modes (first argument, see /usr/local/bin/remyral-master):
#   serve (default)           HTTP API (`dist/main.js`)
#   migrate                   apply pending migrations (run with the OWNER database role)
#   admin:create, admin:reset interactive owner/admin CLIs (need a TTY: docker exec -it … admin:create)
#   release:import            publish a signed release.json read from stdin (p6-release-import;
#                             scripts/release/publish.mjs: docker compose … exec -T master node dist/cli/release-import.js)
#   workflow:normalise-check  read-only dry run before WORKFLOW_ENGINE_V2_FOR_V1 (p14-workflow-engine 14.5)
#   setup:token               one-time token for the first owner (p16-selfhost-onboarding; remyral-ctl install prints it)
#   doctor                    the doctor checks from a shell (p16-selfhost-onboarding; remyral-ctl doctor runs it)
#   search:backfill           embed what the search / related-work indexers have not reached yet (p17-embeddings)
# No secret is read at build time; every secret arrives at run time (environment or mounted files).

# node:24-bookworm-slim, multi-arch index digest (linux/amd64 + linux/arm64), Node 24.22.1, pinned 2026-10-26.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG PNPM_VERSION=12.11.2

# ---------------------------------------------------------------- build (compile once, on the build host)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
WORKDIR /src
# Lockfile-only layer: dependency downloads are cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=remyral-pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=remyral-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store
# --filter-prod: the master plus its production workspace dependencies, in dependency order.
RUN pnpm --filter-prod "@remyral/master..." run build \
 && test -f apps/master/dist/main.js \
 && test -f apps/master/dist/cli/migrate.js \
 && test -f apps/master/dist/cli/admin-create.js \
 && test -f apps/master/dist/cli/admin-reset.js \
 && test -f apps/master/dist/cli/release-import.js \
 && test -f apps/master/dist/cli/setup-token.js \
 && test -f apps/master/dist/cli/doctor.js \
 && test -f apps/master/dist/cli/workflow-normalise-check.js \
 && test -f packages/workflow-expr/dist/sandbox-worker.js
# Hand the workspace (sources + fresh dist, no node_modules) to the target-platform stage.
RUN mkdir /ctx \
 && tar --exclude=node_modules -cf - package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc apps packages \
    | tar -xf - -C /ctx

# ---------------------------------------------------------------- deploy (pruned production dependencies)
FROM ${NODE_IMAGE} AS deploy
ARG PNPM_VERSION
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY --from=build /ctx/ ./
RUN --mount=type=cache,id=remyral-pnpm-store,target=/pnpm/store \
    pnpm --filter @remyral/master deploy --prod --frozen-lockfile --store-dir /pnpm/store /out
# Drop sources, tests and build configs from the master and the injected workspace packages; the
# runtime needs dist/, package.json and (master) migrations/ only.
RUN set -eu; \
    prune() { rm -rf "$1/src" "$1/test" "$1/scripts" "$1/e2e" "$1"/tsconfig*.json "$1/vitest.config.ts" "$1/Dockerfile"; }; \
    prune /out; \
    rm -f /out/pnpm-lock.yaml /out/pnpm-workspace.yaml; \
    for d in /out/node_modules/.pnpm/@remyral+*/node_modules/@remyral/*; do \
      [ -L "$d" ] || prune "$d"; \
    done; \
    find /out -name '*.d.ts.map' -delete; \
    test -d /out/migrations; \
    cd /out && node --input-type=module -e "await import('./dist/compose.js'); await import('./dist/cli/admin.js');"

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
# git: optional plain-git flow (GITFLOW_PLAIN_GIT, off by default); ca-certificates for git over https.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # p7-supply-chain: the master runs `node` only. The base image's bundled npm/corepack (and their own
 # dependencies, which carry the image's npm advisories) are not needed at runtime.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && useradd --system --uid 10001 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin remyral \
 && install -d -o remyral -g remyral -m 0700 /var/lib/remyral /var/lib/remyral/gitflow-cache /var/lib/remyral/blobs

COPY --from=deploy --chown=root:root /out /app

# Entry point: one image, several modes. No shell interpolation of user input; `exec` keeps node as the
# signal receiver (graceful shutdown on SIGTERM).
COPY --chmod=0755 <<'EOF' /usr/local/bin/remyral-master
#!/bin/sh
set -eu
cd /app
mode="${1:-serve}"
[ "$#" -gt 0 ] && shift
case "$mode" in
  serve)        exec node dist/main.js "$@" ;;
  migrate)      exec node dist/cli/migrate.js "$@" ;;
  admin:create) exec node dist/cli/admin-create.js "$@" ;;
  admin:reset)  exec node dist/cli/admin-reset.js "$@" ;;
  release:import) exec node dist/cli/release-import.js "$@" ;;
  workflow:normalise-check) exec node dist/cli/workflow-normalise-check.js "$@" ;;
  secrets:rotated) exec node dist/cli/secrets-rotated.js "$@" ;;
  setup:token)  exec node dist/cli/setup-token.js "$@" ;;
  doctor)       exec node dist/cli/doctor.js "$@" ;;
  memory:autolearn) exec node dist/cli/memory-autolearn.js "$@" ;;
  blobs:migrate) exec node dist/cli/blobs-migrate.js "$@" ;;
  search:backfill) exec node dist/cli/search-backfill.js "$@" ;;
  *) echo "usage: remyral-master [serve|migrate|admin:create|admin:reset|release:import|workflow:normalise-check|secrets:rotated|setup:token|doctor|memory:autolearn|blobs:migrate|search:backfill]" >&2; exit 64 ;;
esac
EOF

ENV NODE_ENV=production \
    MASTER_HOST=0.0.0.0 \
    MASTER_PORT=8080 \
    HOME=/nonexistent
USER 10001:10001
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MASTER_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/remyral-master"]
CMD ["serve"]
