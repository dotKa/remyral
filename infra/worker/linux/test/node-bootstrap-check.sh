#!/usr/bin/env bash
# Runs INSIDE a plain (non-systemd) container (see onboarding-e2e.sh; works under qemu for x64): the pinned
# Node bootstrap of infra/worker/node/install-node.sh as the installers use it — fresh install, idempotent
# re-run, refusal of a swapped archive / an altered SHASUMS256.txt / a bad signature, the system Node left
# alone, and the installer's --dry-run plan from the kit. ONLINE=1: also the real pin from nodejs.org.
set -euo pipefail
FM=/tmp/fm
pass=0
ok() { pass=$((pass + 1)); printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; cat /tmp/n.log >&2 2>/dev/null || true; exit 1; }
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
arch=$(uname -m)
plat=$([ "$arch" = x86_64 ] && echo x64 || echo arm64)
echo "arch $arch, Node fixture v$NODE_V"
mkdir -p $FM
FM_DIR=$FM FM_STATIC=/fx FM_PENDING=1 /tools/node /fm/fake-master.mjs >/tmp/fm.log 2>&1 &
for _ in $(seq 1 100); do curl -fsS -o /dev/null http://127.0.0.1:8080/nodepin/pin.env 2>/dev/null && break; sleep 0.2; done
sys_node=$(command -v node || true)
sys_sum=$([ -z "$sys_node" ] || sha256sum "$sys_node" | cut -d' ' -f1)

# A driver that sources the library exactly like install.sh does.
ensure() { # ensure DIST PREFIX [PINDIR]
  local pindir=${3:-/fx/nodepin}
  bash -c '
    set -euo pipefail
    DRY_RUN=0
    run() { printf "+ %s\n" "$*"; "$@"; }
    info() { printf "==> %s\n" "$*"; }
    warn() { printf "warning: %s\n" "$*" >&2; }
    die() { printf "error: %s\n" "$*" >&2; exit 1; }
    NODE_PIN_FILE=$3/pin.env NODE_KEYS_DIR=$3 NODE_PREFIX_ROOT=$2 NODE_DIST_OVERRIDE=$1
    . $3/install-node.sh
    remyral_node_ensure
    echo "NODE_BIN=$REMYRAL_NODE_BIN"
  ' _ "$1" "$2" "$pindir" >/tmp/n.log 2>&1
}
P=/opt/remyral-worker/node
B=$P/node-v$NODE_V-linux-$plat/bin/node
check "fresh install from the mirror" ensure http://127.0.0.1:8080/node-dist $P
check "signature verified with gpgv" grep -q 'signature verified with the vendored Node release keys (gpgv)' /tmp/n.log
check "archive hash verified" grep -q "node-v$NODE_V-linux-$plat.tar.gz: sha256 verified" /tmp/n.log
check "runs v$NODE_V" [ "$("$B" --version)" = "v$NODE_V" ]
check "root-owned, not group/world-writable" [ "$(stat -c '%U %a' "$B")" = "root 755" ]
check "not on PATH" bash -c "[ \"\$(command -v node || true)\" = \"$sys_node\" ]"
if [ -n "$sys_node" ]; then check "system Node untouched" [ "$(sha256sum "$sys_node" | cut -d' ' -f1)" = "$sys_sum" ]; fi
check "idempotent re-run (no download)" ensure http://127.0.0.1:8080/node-dist $P
check "re-run says already installed" grep -q 'already installed' /tmp/n.log
for bad in bad-archive bad-sums bad-sig; do
  if ensure "http://127.0.0.1:8080/$bad" /opt/t-$bad; then fail "$bad accepted"; fi
  case $bad in
    bad-archive) check "$bad refused" grep -q 'expected .* refusing' /tmp/n.log ;;
    bad-sums) check "$bad refused" grep -q 'SHASUMS256.txt for Node .* refusing' /tmp/n.log ;;
    bad-sig) check "$bad refused" grep -q 'does not verify against the vendored Node release keys' /tmp/n.log ;;
  esac
  check "$bad: nothing installed" bash -c "! ls /opt/t-$bad/node-v* >/dev/null 2>&1"
done
if ensure http://127.0.0.1:8080/does-not-exist /opt/t-404; then fail "missing mirror accepted"; fi
check "unreachable mirror is an error" grep -q 'could not download' /tmp/n.log

# The installer's plan from the kit (no systemd here: --dry-run only, as an unprivileged user).
rm -rf /opt/remyral-worker # a fresh machine again
mkdir -p /tmp/kit && tar -xzf /fx/v1/worker/install/1.0.0/linux/remyral-worker-1.0.0-linux.tar.gz -C /tmp/kit
useradd -m planner 2>/dev/null || true
out=$(runuser -u planner -- bash /tmp/kit/remyral-worker-1.0.0-linux/install.sh --dry-run --private-node --master-url wss://m.example.com/v1/worker 2>&1 || true)
printf '%s\n' "$out" >/tmp/n.log
check "dry-run plans the pinned Node download" grep -q "\[dry-run\] download https://nodejs.org/dist/v$NODE_V/" <<<"$out"
check "dry-run plans the signed adopt" grep -q 'remyral-worker-updater.mjs adopt' <<<"$out"
check "dry-run kit checksums verified" grep -q 'installer kit checksums verified' <<<"$out"
check "dry-run writes the minimal config" grep -q '"masterUrl": "wss://m.example.com/v1/worker"' <<<"$out"
check "no operational settings in the local config" bash -c '! grep -q "maxParallelJobs\|allowedRuntimes" "$1"' _ <(printf '%s' "$out")

if [ "${ONLINE:-0}" = 1 ]; then
  check "ONLINE: real pinned Node from nodejs.org, signature verified" ensure "" /opt/real /fx/realpin
  grep -q 'signature verified with the vendored Node release keys (gpgv)' /tmp/n.log || fail "ONLINE: no gpgv verification"
  /opt/real/node-v*/bin/node --version
fi
echo "ALL PASSED ($pass checks, $arch)"
