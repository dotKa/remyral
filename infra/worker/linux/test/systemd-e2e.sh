#!/usr/bin/env bash
# End-to-end test of the Linux installer + systemd unit against real systemd in Docker.
#
#   infra/worker/linux/test/systemd-e2e.sh [trixie|bookworm]     (default: both)
#   DOCKER_PLATFORM=linux/amd64 ...   pick the image platform. Must match the host CPU: under
#   qemu-user emulation (e.g. amd64 on Apple silicon) systemd itself fails (journald, sandboxing).
#
# Needs Docker (privileged container, cgroup v2) and a built bundle
# (pnpm --filter @remyral/worker bundle). Covers: systemd-analyze verify, --dry-run as a
# non-root user, real install, user/permissions, hardening from inside the unit's namespace,
# `service status`, crash (SIGSEGV/SIGKILL) → restart, graceful stop → exit 0, exit 78 → no
# restart loop, idempotent re-run, container reboot (service comes back), uninstall/purge.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=node-images.sh
. "$HERE/node-images.sh"
LINUX_DIR=$(cd "$HERE/.." && pwd)
BUNDLE_DIR=$(cd "$HERE/../../../../apps/worker/dist" && pwd)
[ -f "$BUNDLE_DIR/remyral-worker.mjs" ] || { echo "build the bundle first: pnpm --filter @remyral/worker bundle" >&2; exit 1; }

flavors=("$@")
[ ${#flavors[@]} -gt 0 ] || flavors=(trixie bookworm)

for flavor in "${flavors[@]}"; do
  image=remyral-worker-systemd-test:$flavor${DOCKER_PLATFORM:+-${DOCKER_PLATFORM//\//-}}
  if [ "${REUSE_IMAGE:-0}" = 1 ] && docker image inspect "$image" >/dev/null 2>&1; then
    echo "=== $flavor: reusing $image (REUSE_IMAGE=1)"
  else
    echo "=== $flavor: building $image"
    docker build -q ${DOCKER_PLATFORM:+--platform "$DOCKER_PLATFORM"} --build-arg NODE_IMAGE="$(node_image_for "$flavor")" -t "$image" "$HERE" >/dev/null
  fi
  name=remyral-worker-e2e-$flavor-$$
  docker run -d ${DOCKER_PLATFORM:+--platform "$DOCKER_PLATFORM"} --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock \
    -v "$LINUX_DIR:/src:ro" -v "$BUNDLE_DIR:/bundle:ro" "$image" >/dev/null
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  docker exec "$name" bash /src/test/in-container.sh

  # Reboot: the enabled service must come back by itself with the same identity.
  echo "=== $flavor: reboot test"
  docker exec "$name" bash /src/install.sh --bundle /bundle/remyral-worker.mjs --master-url wss://m.example.com/v1/worker >/dev/null
  docker exec "$name" bash /src/test/wait-active.sh
  fp1=$(docker exec "$name" runuser -u remyral-worker -- remyral-worker identity show --data-dir /var/lib/remyral-worker --json | grep fingerprint)
  docker restart "$name" >/dev/null
  docker exec "$name" bash /src/test/wait-active.sh
  fp2=$(docker exec "$name" runuser -u remyral-worker -- remyral-worker identity show --data-dir /var/lib/remyral-worker --json | grep fingerprint)
  [ "$fp1" = "$fp2" ] || { echo "FAIL identity changed across reboot" >&2; exit 1; }
  echo "PASS service active after reboot with the same device identity"
  docker exec "$name" remyral-worker service status
  docker rm -f "$name" >/dev/null
  trap - EXIT
done
echo "=== systemd e2e passed: ${flavors[*]}"
