#!/usr/bin/env bash
# End-to-end test of Fleet → "Add machine" on Linux (p5-worker-onboarding), offline by default:
#
#   infra/worker/linux/test/onboarding-e2e.sh            arm64: full systemd flow without and with a system
#                                                        Node; x64 (qemu): Node bootstrap + refusals + dry-run
#   CASES="full-nonode full-node node-arm64 node-x64"    pick cases
#   ONLINE=1 ...                                         also bootstrap the REAL pinned Node from nodejs.org
#                                                        (infra/worker/node/pin.env + vendored release keys)
#
# Fixtures (no network besides pulling pinned images): a throw-away release key signs a real worker build
# and its installer kit; a throw-away OpenPGP key signs a Node "mirror" (SHASUMS256.txt over tarballs that
# repackage the official node binary of the pinned node:24 image); the kit is built with that fixture pin
# (sign.mjs --node-dir). The scripted master (fake-master.mjs) serves the bootstrap, the kit and the mirror
# on 127.0.0.1:8080 and never approves (the worker stays in "waiting for approval").
# x64 runs under qemu-user on Apple silicon, where systemd itself does not work (see systemd-e2e.sh): there
# only the Node bootstrap and the installer dry-run are exercised.
set -euo pipefail
[ "${TRACE:-0}" != 1 ] || set -x

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=node-images.sh
. "$HERE/node-images.sh"
REPO=$(cd "$HERE/../../../.." && pwd)
CASES=${CASES:-full-nonode full-node node-arm64 node-x64}
NODE_IMAGE=$(node_image_for trixie)
DEBIAN_IMAGE=debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
WORK=$(mktemp -d "${TMPDIR:-/tmp}/remyral-onboarding-e2e.XXXXXX")
names=()
cleanup() {
  for n in "${names[@]:-}"; do [ -z "$n" ] || docker rm -f "$n" >/dev/null 2>&1 || true; done
  gpgconf --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$WORK" "${GNUPGHOME:-/nonexistent}"
}
trap cleanup EXIT
SIGN="node $REPO/scripts/release/sign.mjs"

echo "=== fixture Node mirror from $NODE_IMAGE"
V=$(docker run --rm --platform linux/arm64 --entrypoint node "$NODE_IMAGE" -p 'process.versions.node')
case $V in 24.*) ;; *) echo "unexpected node $V in $NODE_IMAGE" >&2; exit 1 ;; esac
DIST=$WORK/static/node-dist/v$V
mkdir -p "$DIST"
for arch in arm64 amd64; do
  plat=$([ $arch = amd64 ] && echo x64 || echo arm64)
  cid=$(docker create --platform linux/$arch "$NODE_IMAGE")
  mkdir -p "$WORK/tools-$arch" "$WORK/pkg/node-v$V-linux-$plat/bin"
  docker cp "$cid:/usr/local/bin/node" "$WORK/tools-$arch/node" >/dev/null
  docker rm "$cid" >/dev/null
  cp "$WORK/tools-$arch/node" "$WORK/pkg/node-v$V-linux-$plat/bin/node"
  tar -czf "$DIST/node-v$V-linux-$plat.tar.gz" -C "$WORK/pkg" "node-v$V-linux-$plat"
done
(
  cd "$DIST"
  for p in linux-x64 linux-arm64; do shasum -a 256 "node-v$V-$p.tar.gz"; done
  for p in darwin-x64 darwin-arm64; do printf '%064d  node-v%s-%s.tar.gz\n' 0 "$V" "$p"; done
  printf '%064d  node-v%s-win-x64.zip\n' 0 "$V"
) >"$DIST/SHASUMS256.txt"

# Short path: gpg-agent's socket path must stay below the UNIX socket limit.
GNUPGHOME=$(mktemp -d /tmp/rgpg.XXXXXX)
export GNUPGHOME
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-gen-key 'Remyral e2e Node releaser <e2e@invalid>' ed25519 sign never
FPR=$(gpg --batch --with-colons --list-keys | awk -F: '/^fpr:/ {print $10; exit}')
gpg --batch --yes --quiet --detach-sign --output "$DIST/SHASUMS256.txt.sig" "$DIST/SHASUMS256.txt"
PIN=$WORK/nodepin
mkdir -p "$PIN/keys"
cp "$REPO/infra/worker/node/install-node.sh" "$PIN/"
gpg --batch --armor --export "$FPR" >"$PIN/keys/$FPR.asc"
echo "$FPR" >"$PIN/keys/keys.list"
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
cat >"$PIN/pin.env" <<EOF
# e2e fixture pin (onboarding-e2e.sh) — NOT a real Node release pin
NODE_VERSION=$V
NODE_DIST_URL=https://nodejs.org/dist
NODE_SHASUMS256_SHA256=$(sum "$DIST/SHASUMS256.txt")
NODE_SIGNER=$FPR
NODE_SHA256_linux_x64=$(sum "$DIST/node-v$V-linux-x64.tar.gz")
NODE_SHA256_linux_arm64=$(sum "$DIST/node-v$V-linux-arm64.tar.gz")
NODE_SHA256_darwin_x64=$(printf '%064d' 0)
NODE_SHA256_darwin_arm64=$(printf '%064d' 0)
NODE_SHA256_win_x64=$(printf '%064d' 0)
EOF
# Refusal fixtures: a swapped archive, an altered SHASUMS256.txt, a signature over something else.
mk_bad() { mkdir -p "$WORK/static/$1/v$V" && cp "$DIST"/* "$WORK/static/$1/v$V/"; }
mk_bad bad-archive && for p in x64 arm64; do printf 'x' >>"$WORK/static/bad-archive/v$V/node-v$V-linux-$p.tar.gz"; done
mk_bad bad-sums && printf '\n' >>"$WORK/static/bad-sums/v$V/SHASUMS256.txt"
mk_bad bad-sig && echo other >"$WORK/other.txt" &&
  gpg --batch --yes --quiet --detach-sign --output "$WORK/static/bad-sig/v$V/SHASUMS256.txt.sig" "$WORK/other.txt"
cp -R "$PIN" "$WORK/static/nodepin"
node --input-type=module -e "import { nodeKeyring } from '$REPO/scripts/release/kit.mjs'; process.stdout.write(nodeKeyring('$PIN'))" >"$WORK/static/nodepin/nodejs-keyring.gpg"
if [ "${ONLINE:-0}" = 1 ]; then
  mkdir -p "$WORK/static/realpin"
  cp "$REPO/infra/worker/node/pin.env" "$REPO/infra/worker/node/install-node.sh" "$WORK/static/realpin/"
  node --input-type=module -e "import { nodeKeyring } from '$REPO/scripts/release/kit.mjs'; process.stdout.write(nodeKeyring('$REPO/infra/worker/node'))" >"$WORK/static/realpin/nodejs-keyring.gpg"
fi

echo "=== signed release 1.0.0 + installer kit (fixture Node pin)"
$SIGN keygen --out "$WORK/keys" >/dev/null
$SIGN build --version 1.0.0 --key "$WORK/keys/release-key.pem" --out "$WORK/rel" --node-dir "$PIN" --os linux >/dev/null
KIT=remyral-worker-1.0.0-linux.tar.gz
INST=$WORK/static/v1/worker/install/1.0.0/linux
mkdir -p "$INST"
cp "$WORK/rel/1.0.0/installers/$KIT" "$INST/"
$SIGN verify-installers --dir "$WORK/rel/1.0.0" --public-key "$(cat "$WORK/keys/release-key.pub")" >/dev/null
# The bootstrap exactly as the master generates it (apps/master/src/installers/bootstrap.ts).
node --input-type=module -e "
  import { bootstrapScript } from '$REPO/apps/master/src/installers/bootstrap.ts';
  process.stdout.write(bootstrapScript({ origin: 'http://127.0.0.1:8080', version: '1.0.0', os: 'linux',
    kitFile: '$KIT', kitSha256: '$(sum "$INST/$KIT")' }));" >"$INST/bootstrap.sh"
BOOT_SHA=$(sum "$INST/bootstrap.sh")

echo "=== bundling the scripted master"
mkdir -p "$WORK/fm"
(cd "$REPO/apps/worker" && pnpm exec esbuild "$HERE/fake-master.mjs" \
  --bundle --platform=node --format=esm --target=node24 --log-level=warning \
  --external:bufferutil --external:utf-8-validate \
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$WORK/fm/fake-master.mjs")

run_case() { # run_case NAME PLATFORM BASE SYSTEMD SCRIPT ARGS...
  local name=$1 platform=$2 base=$3 systemd=$4 script=$5
  shift 5
  local arch=${platform#linux/} image=remyral-worker-onboarding-test:$name cname=remyral-onboarding-$name-$$
  echo "=== $name ($platform, base ${base%%@*})"
  docker build -q --platform "$platform" --build-arg BASE="$base" -t "$image" -f "$HERE/Dockerfile.onboarding" "$HERE" >/dev/null
  local args=(-d --platform "$platform" --name "$cname" -v "$HERE/..:/src:ro" -v "$WORK/static:/fx:ro"
    -v "$WORK/fm:/fm:ro" -v "$WORK/tools-$arch:/tools:ro" -e "NODE_V=$V" -e "BOOT_SHA=$BOOT_SHA" -e "ONLINE=${ONLINE:-0}")
  if [ "$systemd" = 1 ]; then
    args+=(--privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$image")
  else
    args+=(--entrypoint sleep "$image" infinity)
  fi
  names+=("$cname")
  docker run "${args[@]}" >/dev/null
  docker exec "$cname" bash "/src/test/$script" "$@"
  docker rm -f "$cname" >/dev/null
}

for c in $CASES; do
  case $c in
    full-nonode) run_case full-nonode linux/arm64 "$DEBIAN_IMAGE" 1 in-container-onboarding.sh nonode ;;
    full-node) run_case full-node linux/arm64 "$NODE_IMAGE" 1 in-container-onboarding.sh node ;;
    node-arm64) run_case node-arm64 linux/arm64 "$DEBIAN_IMAGE" 0 node-bootstrap-check.sh ;;
    node-x64) run_case node-x64 linux/amd64 "$DEBIAN_IMAGE" 0 node-bootstrap-check.sh ;;
    node-x64-with-node) run_case node-x64-with-node linux/amd64 "$NODE_IMAGE" 0 node-bootstrap-check.sh ;;
    *) echo "unknown case $c" >&2; exit 2 ;;
  esac
done
echo "=== onboarding e2e passed: $CASES"
