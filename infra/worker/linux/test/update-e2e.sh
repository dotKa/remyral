#!/usr/bin/env bash
# End-to-end test of signed updates (p2-signed-updates) against real systemd in Docker:
#
#   infra/worker/linux/test/update-e2e.sh [trixie|bookworm]     (default: trixie)
#
# Builds and signs real releases with a throw-away release key (scripts/release/sign.mjs): 1.0.0 and
# 1.1.0 (good), 1.2.0 (validly signed, never connects → forced health-check failure), 1.3.0 (artifact
# altered after signing). A scripted master (fake-master.mjs, auto-approves, serves the releases) runs
# inside the container. Needs Docker (privileged, cgroup v2) and `pnpm install`.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=node-images.sh
. "$HERE/node-images.sh"
LINUX_DIR=$(cd "$HERE/.." && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
flavor=${1:-trixie}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/remyral-update-e2e.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
SIGN="node $REPO/scripts/release/sign.mjs"

echo "=== building and signing releases in $WORK"
$SIGN keygen --out "$WORK/keys" >/dev/null
KEY=$WORK/keys/release-key.pem
for v in 1.0.0 1.1.0; do $SIGN build --version $v --key "$KEY" --out "$WORK/rel" >/dev/null; done
printf 'setInterval(() => {}, 1 << 30); // validly signed, never connects\n' >"$WORK/bad.mjs"
$SIGN sign --artifact "$WORK/bad.mjs" --version 1.2.0 --key "$KEY" --out "$WORK/rel/1.2.0" >/dev/null
$SIGN sign --artifact "$WORK/rel/1.1.0/remyral-worker.mjs" --version 1.3.0 --key "$KEY" --out "$WORK/rel/1.3.0" >/dev/null
printf '\n// altered after signing\n' >>"$WORK/rel/1.3.0/remyral-worker.mjs"
for v in 1.0.0 1.1.0; do rm -rf "$WORK/rel/$v/build"; done

echo "=== bundling the scripted master"
mkdir -p "$WORK/fm"
(cd "$REPO/apps/worker" && NODE_PATH="$REPO/apps/worker/node_modules" pnpm exec esbuild "$HERE/fake-master.mjs" \
  --bundle --platform=node --format=esm --target=node24 --log-level=warning \
  --external:bufferutil --external:utf-8-validate \
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$WORK/fm/fake-master.mjs")

image=remyral-worker-systemd-test:$flavor${DOCKER_PLATFORM:+-${DOCKER_PLATFORM//\//-}}
if [ "${REBUILD:-0}" = 0 ] && docker image inspect "$image" >/dev/null 2>&1; then
  echo "=== $flavor: reusing $image (REBUILD=1 to rebuild)"
else
  echo "=== $flavor: building $image"
  docker build -q ${DOCKER_PLATFORM:+--platform "$DOCKER_PLATFORM"} --build-arg NODE_IMAGE="$(node_image_for "$flavor")" -t "$image" "$HERE" >/dev/null
fi
name=remyral-worker-update-e2e-$flavor-$$
docker run -d ${DOCKER_PLATFORM:+--platform "$DOCKER_PLATFORM"} --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -v "$LINUX_DIR:/src:ro" -v "$WORK/rel:/rel:ro" -v "$WORK/fm:/fm:ro" "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
docker exec "$name" bash /src/test/in-container-update.sh
echo "=== update e2e passed: $flavor"
