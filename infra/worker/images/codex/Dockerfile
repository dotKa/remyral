# Codex runtime image — pin from docs/compat/README.md §1. Inside our container the
# Codex sandbox runs with the `externalSandbox` policy (nested bwrap user namespaces
# are usually blocked); the container is the boundary. Build status: UNVERIFIED.
# p7-supply-chain: installed from the committed package-lock.json (`npm ci`, integrity-checked) with
# install scripts disabled (codex.md T1); `codex` resolves its platform package itself.
ARG BASE=remyral/runtime-base:0.1.0
FROM ${BASE}
USER root
COPY package.json package-lock.json /opt/remyral/runtime/
RUN npm ci --prefix /opt/remyral/runtime --omit=dev --ignore-scripts --no-audit --no-fund \
 && ln -s /opt/remyral/runtime/node_modules/.bin/codex /usr/local/bin/codex \
 && npm cache clean --force \
 && chown -R root:root /opt/remyral/runtime && chmod -R go-w /opt/remyral/runtime
USER 10001:10001
