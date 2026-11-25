# Remyral base runtime image (ADR-0007 `container` profile).
# Node 24 LTS + git + CA certificates, non-root user 10001, nothing else.
# The base is pinned by digest (multi-arch index: linux/amd64 + linux/arm64).
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 remyral \
 && useradd --uid 10001 --gid 10001 --home-dir /home/remyral --no-create-home --shell /usr/sbin/nologin remyral \
 && mkdir -p /workspace /remyral/git /home/remyral \
 && chown 10001:10001 /home/remyral \
 && (find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true)

# No setuid/setgid binaries remain (see above): nothing to escalate through even if
# no-new-privileges were missing.
ENV HOME=/home/remyral NPM_CONFIG_UPDATE_NOTIFIER=false NO_UPDATE_NOTIFIER=1
USER 10001:10001
WORKDIR /workspace
