# Remyral code node image, JavaScript (p14-workflow-engine 14.3, K3; ADR-0055).
# The base is pinned by digest and must equal FUNCTION_CODE_BASE_IMAGES.js (packages/protocol/src/function-job.ts;
# asserted by packages/protocol/test/function-code-images.test.ts). Runs as 10001 with no network, a read-only root
# and no secrets (apps/worker/src/functions/code.ts); nothing is installed.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

COPY run.mjs /opt/remyral/run.mjs
RUN chmod 0555 /opt/remyral /opt/remyral/run.mjs \
 && (find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true)

ENV HOME=/tmp NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false NO_UPDATE_NOTIFIER=1
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT []
CMD ["node", "/opt/remyral/run.mjs"]
