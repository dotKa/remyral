# Egress proxy sidecar: HTTP CONNECT allowlist proxy (apps/worker/src/sandbox/egress).
# The build context is prepared by ../build.mjs (bundled egress-proxy.mjs, no deps).
ARG BASE=remyral/runtime-base:0.1.0
FROM ${BASE}
USER root
# p7-supply-chain: the proxy runs `node` only; drop the base image's bundled npm/corepack (and the npm
# advisories of their dependencies).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --chown=0:0 egress-proxy.mjs /opt/remyral/egress-proxy.mjs
USER 10001:10001
ENTRYPOINT ["node", "/opt/remyral/egress-proxy.mjs"]
