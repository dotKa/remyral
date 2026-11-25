#!/usr/bin/env bash
# Remyral worker installer for Linux (x64/arm64, incl. Raspberry Pi OS 64-bit) - p2-service-linux.
#
# Creates the dedicated system user, the directory layout, the config (if missing) and the
# hardened systemd unit, then enables and (re)starts the service. Idempotent: running it
# again changes only what differs. --dry-run prints every action without changing anything.
#
#   sudo ./install.sh --bundle ./remyral-worker.mjs --master-url wss://master.example.com/v1/worker
#
# From an installer kit (Fleet -> Add machine, p5-worker-onboarding) everything is next to this script:
#   sudo ./install.sh --master-url wss://master.example.com/v1/worker
# The signed release (manifest.json + manifest.sig.json), the updater and SHA256SUMS are picked up
# automatically, and when no usable Node 24 is installed the pinned one (node/pin.env) is downloaded,
# verified and installed privately under /opt/remyral-worker/node (the system node is never touched).
#
# Design: docs/design/p2-service-install.md   Owner guide: docs/ops/worker-install.md
set -euo pipefail
umask 077

SERVICE_USER=remyral-worker
SERVICE_NAME=remyral-worker.service
OPT_DIR=/opt/remyral-worker
ETC_DIR=/etc/remyral-worker
CONFIG_FILE=$ETC_DIR/config.json
DATA_DIR=/var/lib/remyral-worker
HOME_DIR=$DATA_DIR/home
UNIT_FILE=/etc/systemd/system/$SERVICE_NAME
DROPIN_DIR=/etc/systemd/system/$SERVICE_NAME.d
DROPIN_FILE=$DROPIN_DIR/10-restart-backoff.conf
CLI_WRAPPER=/usr/local/bin/remyral-worker
NODE_MAJOR=24
# p2-signed-updates: privileged updater, its trigger and the versions layout.
UPDATER=$OPT_DIR/remyral-worker-updater.mjs
UPDATE_SERVICE=remyral-worker-update.service
UPDATE_PATH=remyral-worker-update.path
# p5-sandbox-ops: privileged sandbox preparation (signed requests only).
PREPARE_SERVICE=remyral-worker-prepare.service
PREPARE_PATH=remyral-worker-prepare.path
# p5-machine-admin (ADR-0021): elevated broker of AI machine administration (master-signed commands only).
ADMIN_SERVICE=remyral-worker-admin.service
ADMIN_PATH=remyral-worker-admin.path

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

DRY_RUN=0
NO_START=0
REPLACE_CONFIG=0
ALLOW_UNSAFE_NODE=0
BUNDLE=""
BUNDLE_SHA256=""
MANIFEST=""
SIGNATURE=""
UPDATER_SRC=""
RELEASE_KEYS=""
NODE_BIN=""
PRIVATE_NODE=0
NODE_DIST_OVERRIDE=""
NODE_PREFIX_ROOT=$OPT_DIR/node
MASTER_URL=""
WORKSPACE_ROOT=$DATA_DIR/workspaces
MAX_PARALLEL_JOBS=""
MACHINE_ADMIN=""

usage() {
  cat <<'EOF'
Usage: sudo install.sh [options]

  --bundle PATH           remyral-worker.mjs to install (default: next to this script,
                          then apps/worker/dist/remyral-worker.mjs of the repository)
  --bundle-sha256 HEX     refuse to install a bundle with a different SHA-256
  --manifest PATH         signed release manifest (manifest.json) of the bundle; with --signature
  --signature PATH        the bundle is verified against the release key and installed through the
                          updater (versions/ layout, downgrade refused) - p2-signed-updates
  --updater PATH          remyral-worker-updater.mjs (default: next to the bundle)
  --release-public-key K  release public key(s), comma-separated (max 2), written to a NEW config as
                          updates.releaseKeys (default: the keys compiled into the release build)
  --node PATH             Node 24 binary to use; must be root-owned. Default: the private Node under
                          /opt/remyral-worker/node if this installer put one there, else a usable
                          system-wide Node 24, else the pinned Node is downloaded (see --private-node)
  --private-node          always use the pinned private Node (download + verify if missing)
  --node-dist-url URL     mirror of https://nodejs.org/dist (hashes stay pinned; for offline sites/tests)
  --master-url URL        wss://<master>/v1/worker - written to a new config only
  --workspace-root DIR    job workspace root (default /var/lib/remyral-worker/workspaces)
  --max-parallel-jobs N   optional local hard ceiling written to a NEW config (localCeiling,
                          ADR-0015); normally parallelism is set from the dashboard
  --allow-machine-admin   local ceiling: AI machine administration may be enabled from the dashboard
                          (localCeiling.allowMachineAdmin: true, an explicit opt-in). Without either
                          flag the key is not written: the dashboard decides (the default)
  --no-machine-admin      local veto: AI machine administration (root commands signed by the master)
                          is refused on this machine whatever the dashboard says
                          (localCeiling.allowMachineAdmin: false). Both flags also change an existing
                          config (only that key; the worker is restarted). docs/ops/machine-admin.md
  --replace-config        overwrite an existing /etc/remyral-worker/config.json
  --no-start              install and enable, but do not (re)start the service
  --allow-unsafe-node     accept a Node binary that is not root-owned or is group/world-
                          writable (NOT recommended: whoever can replace it runs as the worker)
  --dry-run               print every action, change nothing (no root needed)
  -h, --help
EOF
}

die() { printf 'install.sh: error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'install.sh: warning: %s\n' "$*" >&2; }
info() { printf '==> %s\n' "$*"; }
# Node checks: fatal for a real install; in --dry-run reported so the rest of the plan still prints.
refuse() {
  if [ "$DRY_RUN" = 1 ]; then warn "$* - a real install would STOP here"; else die "$*"; fi
}

# Every state-changing command goes through run(); in dry-run it is only printed.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    printf '+ %s\n' "$*"
    "$@"
  fi
}

# install_file SRC DEST MODE OWNER GROUP - copies only when content or metadata differ.
# Returns 0 if something changed (or would change), 1 if already up to date.
install_file() {
  local src=$1 dest=$2 mode=$3 owner=$4 group=$5
  if [ -f "$dest" ] && cmp -s "$src" "$dest" &&
    [ "$(stat -c '%a %U %G' "$dest")" = "${mode#0} $owner $group" ]; then
    return 1
  fi
  run install -o "$owner" -g "$group" -m "$mode" "$src" "$dest"
  return 0
}

# ensure_dir DIR MODE OWNER GROUP - creates or fixes owner/mode (install -d does both).
ensure_dir() {
  local dir=$1 mode=$2 owner=$3 group=$4
  if [ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c '%a %U %G' "$dir")" = "${mode#0} $owner $group" ]; then
    return 0
  fi
  [ -L "$dir" ] && die "$dir is a symlink; refusing (remove it first)"
  run install -d -o "$owner" -g "$group" -m "$mode" "$dir"
}

show_file() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]   content of %s:\n' "$1"
    sed 's/^/[dry-run]   | /' "$2"
  fi
}

while [ $# -gt 0 ]; do
  case $1 in
    --bundle) BUNDLE=${2:?--bundle needs a path}; shift 2 ;;
    --bundle-sha256) BUNDLE_SHA256=${2:?--bundle-sha256 needs a value}; shift 2 ;;
    --manifest) MANIFEST=${2:?--manifest needs a path}; shift 2 ;;
    --signature) SIGNATURE=${2:?--signature needs a path}; shift 2 ;;
    --updater) UPDATER_SRC=${2:?--updater needs a path}; shift 2 ;;
    --release-public-key) RELEASE_KEYS=${2:?--release-public-key needs a key}; shift 2 ;;
    --node) NODE_BIN=${2:?--node needs a path}; shift 2 ;;
    --private-node) PRIVATE_NODE=1; shift ;;
    --node-dist-url) NODE_DIST_OVERRIDE=${2:?--node-dist-url needs a URL}; shift 2 ;;
    --master-url) MASTER_URL=${2:?--master-url needs a URL}; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT=${2:?--workspace-root needs a directory}; shift 2 ;;
    --max-parallel-jobs) MAX_PARALLEL_JOBS=${2:?--max-parallel-jobs needs a number}; shift 2 ;;
    --allow-machine-admin) [ "$MACHINE_ADMIN" != forbid ] || die "--allow-machine-admin and --no-machine-admin exclude each other"; MACHINE_ADMIN=allow; shift ;;
    --no-machine-admin) [ "$MACHINE_ADMIN" != allow ] || die "--allow-machine-admin and --no-machine-admin exclude each other"; MACHINE_ADMIN=forbid; shift ;;
    --replace-config) REPLACE_CONFIG=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --allow-unsafe-node) ALLOW_UNSAFE_NODE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------------------------
info "Preflight"
[ "$(uname -s)" = Linux ] || die "this installer is for Linux (use infra/worker/macos or windows)"
case $(uname -m) in
  x86_64 | aarch64 | arm64) ;;
  *) die "unsupported architecture $(uname -m): the worker supports x64 and arm64 (Raspberry Pi OS must be the 64-bit edition)" ;;
esac
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo), or use --dry-run"; fi
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
if [ ! -d /run/systemd/system ]; then
  if [ "$DRY_RUN" = 1 ]; then warn "systemd is not running as PID 1 here; continuing (dry-run)"; else die "systemd is not the running init system"; fi
fi
if [ -n "$MAX_PARALLEL_JOBS" ]; then
  case $MAX_PARALLEL_JOBS in *[!0-9]*) die "--max-parallel-jobs must be a number 1-64" ;; esac
  [ "$MAX_PARALLEL_JOBS" -ge 1 ] && [ "$MAX_PARALLEL_JOBS" -le 64 ] || die "--max-parallel-jobs must be 1-64"
fi
if [ -n "$NODE_BIN" ] && [ "$PRIVATE_NODE" = 1 ]; then die "--node and --private-node exclude each other"; fi
case $NODE_DIST_OVERRIDE in '' | https://* | http://127.0.0.1* | http://localhost* | http://\[::1\]*) ;; *) die "--node-dist-url must be https:// (plain http only for a local mirror)" ;; esac

# Installer kit (p5-worker-onboarding): SHA256SUMS covers every file of the kit; a partial or altered
# copy is refused before anything is installed.
if [ -f "$HERE/SHA256SUMS" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$HERE" && sha256sum --quiet -c SHA256SUMS) || die "installer kit files do not match $HERE/SHA256SUMS; download the kit again"
  else
    (cd "$HERE" && shasum -a 256 -q -c SHA256SUMS) || die "installer kit files do not match $HERE/SHA256SUMS; download the kit again"
  fi
  info "installer kit checksums verified (SHA256SUMS)"
fi
case $WORKSPACE_ROOT in /*) ;; *) die "--workspace-root must be an absolute path" ;; esac
case $WORKSPACE_ROOT in /home/* | /root/* | /run/user/*) die "--workspace-root may not be under /home, /root or /run/user (hidden from the service by ProtectHome)" ;; esac
if [ -n "$MASTER_URL" ]; then
  case $MASTER_URL in
    wss://*) ;;
    ws://127.0.0.1* | ws://localhost* | ws://\[::1\]*) warn "plain ws:// is for local development only" ;;
    *) die "--master-url must start with wss:// (got: $MASTER_URL)" ;;
  esac
fi

# Bundle (the single-file worker; packaging decision in the design note).
if [ -z "$BUNDLE" ]; then
  for candidate in "$HERE/remyral-worker.mjs" "$HERE/../../../apps/worker/dist/remyral-worker.mjs"; do
    if [ -f "$candidate" ]; then BUNDLE=$candidate; break; fi
  done
fi
[ -n "$BUNDLE" ] && [ -f "$BUNDLE" ] || die "worker bundle not found; pass --bundle PATH (build it with: pnpm --filter @remyral/worker bundle)"
BUNDLE=$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")
# A kit ships the signed release next to the bundle: install it through the verifying updater.
if [ -z "$MANIFEST$SIGNATURE" ] && [ -f "$(dirname "$BUNDLE")/manifest.json" ] && [ -f "$(dirname "$BUNDLE")/manifest.sig.json" ]; then
  MANIFEST=$(dirname "$BUNDLE")/manifest.json
  SIGNATURE=$(dirname "$BUNDLE")/manifest.sig.json
  info "signed release found next to the bundle: $MANIFEST"
fi
if [ -n "$BUNDLE_SHA256" ]; then
  actual=$(sha256sum "$BUNDLE" | cut -d' ' -f1)
  [ "$actual" = "$BUNDLE_SHA256" ] || die "bundle SHA-256 mismatch: expected $BUNDLE_SHA256, got $actual"
  info "bundle SHA-256 verified"
elif [ -z "$MANIFEST" ]; then
  warn "neither --manifest/--signature nor --bundle-sha256 given: bundle integrity not verified"
fi
if [ -n "$MANIFEST$SIGNATURE" ]; then
  [ -f "$MANIFEST" ] && [ -f "$SIGNATURE" ] || die "--manifest and --signature must both name existing files"
fi
if [ -n "$RELEASE_KEYS" ] && ! printf '%s' "$RELEASE_KEYS" | grep -Eq '^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})?$'; then
  die "--release-public-key must be one or two base64url Ed25519 public keys, comma-separated"
fi
# The privileged updater (separate bundle; never auto-updated: re-run this installer to update it).
if [ -z "$UPDATER_SRC" ]; then
  for candidate in "$(dirname "$BUNDLE")/remyral-worker-updater.mjs" "$HERE/remyral-worker-updater.mjs"; do
    if [ -f "$candidate" ]; then UPDATER_SRC=$candidate; break; fi
  done
fi
if [ -n "$UPDATER_SRC" ]; then
  [ -f "$UPDATER_SRC" ] || die "updater not found: $UPDATER_SRC"
  UPDATER_SRC=$(cd "$(dirname "$UPDATER_SRC")" && pwd)/$(basename "$UPDATER_SRC")
elif [ -n "$MANIFEST" ]; then
  die "a signed install needs remyral-worker-updater.mjs (pass --updater PATH)"
else
  warn "remyral-worker-updater.mjs not found: automatic updates will not be possible on this machine"
fi

# A worker installed before the Remyral rename (remana-worker) is not migrated by this kit any more (Remyral cut-over
# cleanup): refuse before anything changes. The 1.1.1 kit still migrates it in place.
if [ -e /opt/remana-worker/remana-worker.mjs ] || [ -e /etc/systemd/system/remana-worker.service ]; then
  die "a worker installed before the Remyral rename (remana-worker) is on this machine. This installer no longer migrates it: run the installer kit of worker 1.1.1 instead (console: /v1/worker/install/1.1.1/linux/...); it migrates the worker in place and the worker then updates itself"
fi

# Node 24 (T-SUP-2: whoever can replace the interpreter runs code as the worker): root-owned, not
# writable by anyone else, and not under /home (hidden by ProtectHome). Order: --node; the private
# pinned Node if this installer manages one (kept at the pin = upgrade/repair); a usable system-wide
# Node 24; otherwise download the pinned Node (node/pin.env) into /opt/remyral-worker/node.
node_problem() { # prints why PATH is not an acceptable worker Node, or nothing
  local p=$1 v q p_mode p_owner
  [ -x "$p" ] || { printf '%s is not executable' "$p"; return 0; }
  v=$("$p" --version 2>/dev/null || true)
  case $v in v$NODE_MAJOR.*) ;; *) printf 'Node.js %s is required (found %s at %s)' "$NODE_MAJOR" "${v:-nothing}" "$p"; return 0 ;; esac
  case $p in /home/* | /root/* | /run/user/*) printf '%s is under a home directory (nvm?); the service cannot see it (ProtectHome)' "$p"; return 0 ;; esac
  for q in "$p" "$(dirname "$p")"; do
    read -r p_mode p_owner <<<"$(stat -c '%a %U' "$q")"
    if [ "$p_owner" != root ] || [ $((8#$p_mode & 8#022)) -ne 0 ]; then
      printf 'unsafe Node location: %s (owner %s, mode %s) must be root-owned and not group/world-writable' "$q" "$p_owner" "$p_mode"
      return 0
    fi
  done
}
NODE_PIN_FILE=""
for candidate in "$HERE/node/pin.env" "$HERE/../node/pin.env"; do
  if [ -f "$candidate" ]; then NODE_PIN_FILE=$candidate; break; fi
done
NODE_KEYS_DIR=$(dirname "${NODE_PIN_FILE:-$HERE/node/pin.env}")
use_private_node() {
  [ "$DRY_RUN" = 1 ] || ensure_dir "$OPT_DIR" 0755 root root
  [ -n "$NODE_PIN_FILE" ] || die "Node.js $NODE_MAJOR is needed but node/pin.env is missing (use the installer kit from the dashboard, or pass --node)"
  # shellcheck source=../node/install-node.sh
  . "$(dirname "$NODE_PIN_FILE")/install-node.sh"
  remyral_node_ensure
  NODE_BIN=$REMYRAL_NODE_BIN
  USING_PRIVATE_NODE=1
}
USING_PRIVATE_NODE=0
if [ -n "$NODE_BIN" ]; then
  NODE_BIN=$(readlink -f "$NODE_BIN")
  problem=$(node_problem "$NODE_BIN")
  case $problem in
    "" ) ;;
    unsafe*) if [ "$ALLOW_UNSAFE_NODE" = 1 ]; then warn "unsafe Node location accepted: $problem"; else refuse "$problem (or pass --allow-unsafe-node)"; fi ;;
    *home*) refuse "$problem. Install Node $NODE_MAJOR system-wide, or drop --node to use the pinned private Node." ;;
    *) die "$problem" ;;
  esac
elif [ "$PRIVATE_NODE" = 1 ] || ls -d "$NODE_PREFIX_ROOT"/node-v* >/dev/null 2>&1; then
  use_private_node
else
  system_node=$(command -v node || true)
  [ -z "$system_node" ] || system_node=$(readlink -f "$system_node")
  problem=""
  if [ -n "$system_node" ]; then problem=$(node_problem "$system_node"); fi
  if [ -n "$system_node" ] && [ -z "$problem" ]; then
    NODE_BIN=$system_node
  else
    info "${problem:-no system-wide Node.js $NODE_MAJOR}: using the pinned private Node (the system node is left alone)"
    use_private_node
  fi
fi
node_version=$("$NODE_BIN" --version 2>/dev/null || echo "v(pinned, dry-run)")
info "node $node_version at $NODE_BIN"

systemd_version=$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')
info "systemd ${systemd_version:-unknown}"

# ---------------------------------------------------------------------------------------------
info "Service user $SERVICE_USER"
if getent passwd "$SERVICE_USER" >/dev/null; then
  IFS=: read -r _ _ u_uid _ _ u_home u_shell <<<"$(getent passwd "$SERVICE_USER")"
  case $u_shell in */nologin | */false) ;; *) die "existing user $SERVICE_USER has a login shell ($u_shell); refusing to run a worker as an interactive account" ;; esac
  [ "$u_uid" -lt 1000 ] || warn "existing user $SERVICE_USER is not a system account (uid $u_uid)"
  [ "$u_home" = "$HOME_DIR" ] || warn "existing user $SERVICE_USER has home $u_home (expected $HOME_DIR)"
  info "exists (uid $u_uid)"
else
  nologin=$(command -v nologin || echo /usr/sbin/nologin)
  run useradd --system --user-group --home-dir "$HOME_DIR" --no-create-home \
    --shell "$nologin" --comment "Remyral worker (service account)" "$SERVICE_USER"
fi
# In dry-run on a host without the user, chown targets cannot resolve; that is expected.

# ---------------------------------------------------------------------------------------------
info "Directories"
ensure_dir "$OPT_DIR" 0755 root root
ensure_dir "$ETC_DIR" 0750 root "$SERVICE_USER"
ensure_dir "$DATA_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
ensure_dir "$HOME_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
ensure_dir "$WORKSPACE_ROOT" 0700 "$SERVICE_USER" "$SERVICE_USER"
# p2-signed-updates: retained versions + updater state (root, readable by the worker); the worker's
# own request/staging dir (the path unit watches it).
ensure_dir "$OPT_DIR/versions" 0755 root root
ensure_dir "$OPT_DIR/state" 0755 root root
ensure_dir "$DATA_DIR/updates" 0700 "$SERVICE_USER" "$SERVICE_USER"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
changed_code=0
changed_unit=0

info "Updater"
if [ -n "$UPDATER_SRC" ]; then
  if install_file "$UPDATER_SRC" "$UPDATER" 0644 root root; then changed_code=1; else info "up to date"; fi
fi

info "Worker bundle"
if [ -n "$MANIFEST" ]; then
  # Signed release: the updater verifies the signature (pinned/configured release keys), keeps the
  # previous version under versions/ and switches the active bundle atomically; downgrades are refused.
  if [ -f "$OPT_DIR/remyral-worker.mjs" ] && cmp -s "$BUNDLE" "$OPT_DIR/remyral-worker.mjs"; then
    info "up to date"
  else
    adopt_config=()
    [ -f "$CONFIG_FILE" ] && adopt_config=(--config "$CONFIG_FILE")
    run "$NODE_BIN" "$UPDATER" adopt --install-dir "$OPT_DIR" --bundle "$BUNDLE" --manifest "$MANIFEST" \
      --signature "$SIGNATURE" "${adopt_config[@]}"
    changed_code=1
  fi
elif install_file "$BUNDLE" "$OPT_DIR/remyral-worker.mjs" 0644 root root; then changed_code=1; else info "up to date"; fi

cat >"$TMP/cli" <<EOF
#!/bin/sh
# remyral-worker CLI wrapper (installed by infra/worker/linux/install.sh)
exec $NODE_BIN $OPT_DIR/remyral-worker.mjs "\$@"
EOF
if install_file "$TMP/cli" "$CLI_WRAPPER" 0755 root root; then show_file "$CLI_WRAPPER" "$TMP/cli"; fi

# ---------------------------------------------------------------------------------------------
info "Config $CONFIG_FILE"
have_config=0
if [ -f "$CONFIG_FILE" ] && [ "$REPLACE_CONFIG" = 0 ]; then
  have_config=1
  [ -z "$MASTER_URL" ] || warn "config exists and was NOT changed (edit it, or pass --replace-config)"
  if [ "$(stat -c '%a %U %G' "$CONFIG_FILE")" != "640 root $SERVICE_USER" ]; then
    run chown "root:$SERVICE_USER" "$CONFIG_FILE"
    run chmod 0640 "$CONFIG_FILE"
  else
    info "exists, owner/mode ok"
  fi
  # --allow-machine-admin / --no-machine-admin also apply to an existing config: only that key changes (validated by
  # the updater before it writes), and the worker is restarted to read it.
  if [ -n "$MACHINE_ADMIN" ]; then
    [ -n "$UPDATER_SRC" ] || [ -f "$UPDATER" ] ||
      die "--allow-machine-admin / --no-machine-admin on an existing config need remyral-worker-updater.mjs (or set localCeiling.allowMachineAdmin in $CONFIG_FILE by hand)"
    run "$NODE_BIN" "$UPDATER" machine-admin-ceiling "$MACHINE_ADMIN" --config "$CONFIG_FILE"
    changed_code=1
  fi
elif [ -n "$MASTER_URL" ]; then
  # JSON is produced by node so the URL/path are escaped correctly.
  # Minimal local config (p5-worker-onboarding): where the master is and where the worker keeps its data;
  # everything else has a worker default and is managed from the dashboard. Written without node so a
  # dry-run works before the pinned Node is installed; values are checked to need no JSON escaping.
  for v in "$MASTER_URL" "$WORKSPACE_ROOT" "$RELEASE_KEYS"; do
    case $v in *[\"\\]* | *[[:cntrl:]]*) die "quotes, backslashes and control characters are not allowed in --master-url/--workspace-root" ;; esac
  done
  {
    # dataDir is not written: the worker's default for this config location is exactly $DATA_DIR.
    printf '{\n  "masterUrl": "%s",\n  "workspaceRoot": "%s"' "$MASTER_URL" "$WORKSPACE_ROOT"
    # p5-sandbox-ops: the dedicated account this installer runs the service as (a machine fact).
    printf ',\n  "sandbox": { "workerUser": "%s" }' "$SERVICE_USER"
    # Optional local hard ceiling (ADR-0015): parallelism, and the owner's word on machine administration.
    ceiling=""
    [ -z "$MAX_PARALLEL_JOBS" ] || ceiling="\"maxParallelJobs\": $MAX_PARALLEL_JOBS"
    case $MACHINE_ADMIN in
      allow) ceiling="${ceiling:+$ceiling, }\"allowMachineAdmin\": true" ;;
      forbid) ceiling="${ceiling:+$ceiling, }\"allowMachineAdmin\": false" ;;
    esac
    [ -z "$ceiling" ] || printf ',\n  "localCeiling": { %s }' "$ceiling"
    [ -z "$RELEASE_KEYS" ] || printf ',\n  "updates": { "releaseKeys": ["%s"] }' "$(printf '%s' "$RELEASE_KEYS" | sed 's/,/", "/')"
    printf '\n}\n'
  } >"$TMP/config.json"
  install_file "$TMP/config.json" "$CONFIG_FILE" 0640 root "$SERVICE_USER" || true
  show_file "$CONFIG_FILE" "$TMP/config.json"
  have_config=1
  changed_code=1
else
  warn "no config yet: pass --master-url, or create $CONFIG_FILE (root:$SERVICE_USER 0640) and re-run"
fi

# ---------------------------------------------------------------------------------------------
info "systemd unit $UNIT_FILE"
sed "s#@NODE@#$NODE_BIN#g" "$HERE/remyral-worker.service" >"$TMP/unit"
if [ "$WORKSPACE_ROOT" != "$DATA_DIR/workspaces" ]; then
  case $WORKSPACE_ROOT in
    "$DATA_DIR"/*) ;;
    *) sed -i "s#^ReadWritePaths=.*#& $WORKSPACE_ROOT#" "$TMP/unit" ;;
  esac
fi
if install_file "$TMP/unit" "$UNIT_FILE" 0644 root root; then changed_unit=1; show_file "$UNIT_FILE" "$TMP/unit"; else info "up to date"; fi
if [ -n "$systemd_version" ] && [ "$systemd_version" -ge 254 ]; then
  ensure_dir "$DROPIN_DIR" 0755 root root
  if install_file "$HERE/restart-backoff.conf" "$DROPIN_FILE" 0644 root root; then changed_unit=1; fi
else
  info "systemd < 254: exponential restart backoff unavailable, fixed RestartSec=5s applies"
fi
# p2-signed-updates: the privileged updater (root oneshot) and its trigger.
if [ -n "$UPDATER_SRC" ]; then
  sed "s#@NODE@#$NODE_BIN#g" "$HERE/$UPDATE_SERVICE" >"$TMP/update-service"
  if install_file "$TMP/update-service" "/etc/systemd/system/$UPDATE_SERVICE" 0644 root root; then
    changed_unit=1
    show_file "/etc/systemd/system/$UPDATE_SERVICE" "$TMP/update-service"
  fi
  if install_file "$HERE/$UPDATE_PATH" "/etc/systemd/system/$UPDATE_PATH" 0644 root root; then changed_unit=1; fi
  if [ -f "$HERE/$PREPARE_SERVICE" ]; then
    sed "s#@NODE@#$NODE_BIN#g" "$HERE/$PREPARE_SERVICE" >"$TMP/prepare-service"
    if install_file "$TMP/prepare-service" "/etc/systemd/system/$PREPARE_SERVICE" 0644 root root; then changed_unit=1; fi
    if install_file "$HERE/$PREPARE_PATH" "/etc/systemd/system/$PREPARE_PATH" 0644 root root; then changed_unit=1; fi
  fi
  if [ -f "$HERE/$ADMIN_SERVICE" ]; then
    sed "s#@NODE@#$NODE_BIN#g" "$HERE/$ADMIN_SERVICE" >"$TMP/admin-service"
    if install_file "$TMP/admin-service" "/etc/systemd/system/$ADMIN_SERVICE" 0644 root root; then changed_unit=1; fi
    if install_file "$HERE/$ADMIN_PATH" "/etc/systemd/system/$ADMIN_PATH" 0644 root root; then changed_unit=1; fi
  fi
fi
if [ "$changed_unit" = 1 ]; then run systemctl daemon-reload; fi
if [ "$DRY_RUN" = 0 ] && command -v systemd-analyze >/dev/null 2>&1; then
  if ! out=$(systemd-analyze verify "$UNIT_FILE" 2>&1) || [ -n "$out" ]; then
    warn "systemd-analyze verify reported:"
    printf '%s\n' "$out" >&2
  fi
fi

# The unit now points at the active Node; older private Node versions can go.
if [ "$USING_PRIVATE_NODE" = 1 ]; then remyral_node_prune "$NODE_BIN"; fi

# ---------------------------------------------------------------------------------------------
# p19-auto-bwrap: bubblewrap gives every host-restricted attempt its own view, so host jobs run in parallel
# (p19-linux-host-isolation). The distribution's fixed `bubblewrap` package (the privileged helper's package too);
# best effort: a failure is a warning, never a failed install (host jobs then run one at a time, and the helper
# tries again after each update activation).
info "bubblewrap (per-attempt host isolation)"
bwrap_pm=""
if [ -r /etc/os-release ]; then
  bwrap_ids=$(. /etc/os-release && printf '%s %s' "${ID:-}" "${ID_LIKE:-}") || bwrap_ids=""
  for id in $bwrap_ids; do
    case $id in
      debian | ubuntu | raspbian) bwrap_pm=apt; break ;;
      fedora | rhel | centos | rocky | almalinux) bwrap_pm=dnf; break ;;
    esac
  done
fi
if command -v bwrap >/dev/null 2>&1; then
  info "bubblewrap present ($(bwrap --version 2>/dev/null || echo bwrap))"
elif [ "$bwrap_pm" = apt ]; then
  if ! { run env DEBIAN_FRONTEND=noninteractive apt-get update &&
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bubblewrap; }; then
    warn "bubblewrap could not be installed (apt-get); host jobs run one at a time until it is (sudo apt-get install bubblewrap)"
  fi
elif [ "$bwrap_pm" = dnf ]; then
  if ! run dnf install -y bubblewrap; then
    warn "bubblewrap could not be installed (dnf); host jobs run one at a time until it is (sudo dnf install bubblewrap)"
  fi
else
  warn "bubblewrap is not installed and this distribution is not prepared automatically (apt/dnf only): install the bubblewrap package so host jobs can run in parallel"
fi

# ---------------------------------------------------------------------------------------------
info "Enable and start"
started_at=""
if [ "$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)" != enabled ]; then
  run systemctl enable "$SERVICE_NAME"
fi
if [ -n "$UPDATER_SRC" ]; then
  for u in "$UPDATE_PATH" "$UPDATE_SERVICE"; do
    if [ "$(systemctl is-enabled "$u" 2>/dev/null || true)" != enabled ]; then run systemctl enable "$u"; fi
  done
  if [ "$(systemctl is-active "$UPDATE_PATH" 2>/dev/null || true)" != active ]; then run systemctl start "$UPDATE_PATH"; fi
  if [ -f "$HERE/$PREPARE_PATH" ]; then
    if [ "$(systemctl is-enabled "$PREPARE_PATH" 2>/dev/null || true)" != enabled ]; then run systemctl enable "$PREPARE_PATH"; fi
    if [ "$(systemctl is-active "$PREPARE_PATH" 2>/dev/null || true)" != active ]; then run systemctl start "$PREPARE_PATH"; fi
  fi
  if [ -f "$HERE/$ADMIN_PATH" ]; then
    if [ "$(systemctl is-enabled "$ADMIN_PATH" 2>/dev/null || true)" != enabled ]; then run systemctl enable "$ADMIN_PATH"; fi
    if [ "$(systemctl is-active "$ADMIN_PATH" 2>/dev/null || true)" != active ]; then run systemctl start "$ADMIN_PATH"; fi
  fi
fi
active=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)
if [ "$NO_START" = 1 ]; then
  info "--no-start: not starting (state: ${active:-inactive})"
elif [ "$have_config" = 0 ]; then
  info "not starting: no config"
elif [ "$active" = active ]; then
  if [ "$changed_code" = 1 ] || [ "$changed_unit" = 1 ]; then
    started_at=$(date '+%Y-%m-%d %H:%M:%S')
    run systemctl restart "$SERVICE_NAME"
  else
    info "already running, nothing changed"
  fi
else
  started_at=$(date '+%Y-%m-%d %H:%M:%S')
  run systemctl start "$SERVICE_NAME"
fi

# Security fix (helper binding): the root helper serves exactly one worker id, recorded root-owned in
# $OPT_DIR/state/admin-binding.json. An enrolled worker (a re-run on an existing install) is bound here, once; a new
# machine is bound after its approval with the admin-bind line printed below. Never changes an existing binding and
# never fails the install.
if [ -n "$UPDATER_SRC" ] && [ "$have_config" = 1 ] && [ -f "$HERE/$ADMIN_PATH" ]; then
  info "Machine administration binding"
  run "$NODE_BIN" "$UPDATER" admin-bind --if-unbound --config "$CONFIG_FILE" ||
    warn "admin-bind failed; machine administration stays refused until: sudo $NODE_BIN $UPDATER admin-bind"
fi

# p5-worker-onboarding: show the pairing code + fingerprint right here, so the owner can approve the
# machine in Fleet -> "Waiting for approval" without reading the journal. An enrolled worker logs none.
if [ "$DRY_RUN" = 0 ] && [ -n "$started_at" ]; then
  pairing=""
  for _ in $(seq 1 60); do
    pairing=$(journalctl -u "$SERVICE_NAME" --since "$started_at" --no-pager -o cat 2>/dev/null | grep '"pairingCode":"' | tail -n 1 || true)
    [ -z "$pairing" ] || break
    [ "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)" = active ] || break
    sleep 0.5
  done
  if [ -n "$pairing" ]; then
    code=$(printf '%s' "$pairing" | sed 's/.*"pairingCode":"\([^"]*\)".*/\1/')
    fingerprint=$(printf '%s' "$pairing" | sed 's/.*"fingerprint":"\([^"]*\)".*/\1/')
    cat <<EOF

  This machine is waiting for approval. In the dashboard open Fleet -> Waiting for approval,
  check that the fingerprint matches, enter the pairing code and approve:

    Pairing code: $code
    Fingerprint:  $fingerprint
EOF
  fi
fi

done_note=""
[ "$DRY_RUN" = 0 ] || done_note=" (dry-run: nothing was changed)"
cat <<EOF

Done$done_note.
  Status:      remyral-worker service status        (or: systemctl status remyral-worker)
  Logs:        journalctl -u remyral-worker -f
  Pairing:     journalctl -u remyral-worker | grep pairingCode   - then approve in the dashboard
               and compare the fingerprint (docs/ops/worker-pairing.md)
  Identity:    sudo -u $SERVICE_USER remyral-worker identity show --data-dir $DATA_DIR
  Updates:     sudo node $UPDATER status        (signed auto-update; docs/ops/worker-updates.md)
  Machine admin: once the machine is approved (only if you use machine administration):
               sudo $NODE_BIN $UPDATER admin-bind   (docs/ops/machine-admin.md)
  Uninstall:   sudo $HERE/uninstall.sh [--purge]
EOF
