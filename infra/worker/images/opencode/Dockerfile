# OpenCode runtime image — pin from docs/compat/README.md §1. The Linux arm64 binary is
# UNVERIFIED upstream (compat §3). Build status: UNVERIFIED.
# p7-supply-chain: installed from the committed package-lock.json (`npm ci`, integrity-checked) with
# install scripts disabled. OpenCode's postinstall only copies the platform binary over the npm shim,
# so the platform binary is linked explicitly (as in infra/dev/docker-worker/Dockerfile.runtimes).
ARG BASE=remyral/runtime-base:0.1.0
FROM ${BASE}
USER root
COPY package.json package-lock.json /opt/remyral/runtime/
RUN set -eu; npm ci --prefix /opt/remyral/runtime --omit=dev --ignore-scripts --no-audit --no-fund; \
 oc_bin="$(find /opt/remyral/runtime/node_modules -maxdepth 3 -type f -name opencode -path '*opencode-linux-*/bin/*' | grep -v musl | grep -v baseline | head -n1)"; \
 test -n "$oc_bin"; ln -s "$oc_bin" /usr/local/bin/opencode; \
 npm cache clean --force; chown -R root:root /opt/remyral/runtime; chmod -R go-w /opt/remyral/runtime
USER 10001:10001
