# Claude Code runtime image. The adapter drives the Agent SDK in the worker process
# (ADR-0012); the SDK spawns the CLI, and that CLI process is what runs in this
# container (SDK custom-spawn option → SandboxRunner.confiner; wiring is
# p3-adapter-claude). CLI 2.1.310 is the one bundled with
# @anthropic-ai/claude-agent-sdk@0.3.310. Build status: UNVERIFIED.
# p7-supply-chain: installs the Agent SDK pin (apps/worker/src/runtimes/pins.ts) from the committed
# package-lock.json (`npm ci`, integrity-checked, no install scripts) and exposes its bundled platform CLI
# as `claude` (as in infra/dev/docker-worker/Dockerfile.runtimes) — the same bytes the worker's SDK runs.
ARG BASE=remyral/runtime-base:0.1.0
FROM ${BASE}
USER root
COPY package.json package-lock.json /opt/remyral/runtime/
RUN set -eu; npm ci --prefix /opt/remyral/runtime --omit=dev --ignore-scripts --no-audit --no-fund; \
 claude_bin="$(find /opt/remyral/runtime/node_modules/@anthropic-ai -maxdepth 2 -type f -name claude -path '*claude-agent-sdk-linux-*' | grep -v musl | head -n1)"; \
 test -n "$claude_bin"; ln -s "$claude_bin" /usr/local/bin/claude; \
 npm cache clean --force; chown -R root:root /opt/remyral/runtime; chmod -R go-w /opt/remyral/runtime
USER 10001:10001
