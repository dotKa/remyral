#!/bin/bash
# Remyral worker installer for macOS (arm64/x64) - p2-service-macos.
#
# Creates the hidden role account _remyralworker, the directory layout under
# /Library/Application Support/RemyralWorker, the config (if missing) and the LaunchDaemon,
# then loads (or restarts) it. Idempotent: running it again changes only what differs.
# --dry-run prints every action without changing anything (no root needed).
#
#   sudo ./install.sh --bundle ./remyral-worker.mjs --master-url wss://master.example.com/v1/worker
#
# From an installer kit (Fleet -> Add machine, p5-worker-onboarding) everything is next to this script:
#   sudo ./install.sh --master-url wss://master.example.com/v1/worker
# The signed release, the updater and SHA256SUMS are picked up automatically; without a usable Node 24
# the pinned one (node/pin.env) is downloaded, verified and installed privately under
# /Library/Application Support/RemyralWorker/node (no system node, PATH or Homebrew change).
#
# Written for the bash 3.2 that ships with macOS. Design: docs/design/p2-service-install.md
set -euo pipefail
umask 077

SERVICE_USER=_remyralworker
LABEL=com.remyral.worker
BASE_DIR="/Library/Application Support/RemyralWorker"
BIN_DIR="$BASE_DIR/bin"
CONFIG_FILE="$BASE_DIR/config.json"
DATA_DIR="$BASE_DIR/data"
HOME_DIR="$DATA_DIR/home"
LOG_DIR=/Library/Logs/RemyralWorker
LOG_FILE=$LOG_DIR/remyral-worker.log
PLIST=/Library/LaunchDaemons/$LABEL.plist
CLI_WRAPPER=/usr/local/bin/remyral-worker
NODE_MAJOR=24
# p2-signed-updates: privileged updater LaunchDaemon (WatchPaths on the worker's request file).
UPDATER_LABEL=com.remyral.worker.updater
UPDATER_PLIST=/Library/LaunchDaemons/$UPDATER_LABEL.plist
UPDATER="$BIN_DIR/remyral-worker-updater.mjs"
# p5-machine-admin (ADR-0021): elevated broker LaunchDaemon (WatchPaths on the worker's session request).
ADMIN_LABEL=com.remyral.worker.admin
ADMIN_PLIST=/Library/LaunchDaemons/$ADMIN_LABEL.plist
# Role accounts live below 500 (hidden from the login window); we pick from 400-499.
ID_MIN=400
ID_MAX=499

HERE=$(cd "$(dirname "$0")" && pwd)

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
NODE_PREFIX_ROOT="$BASE_DIR/node"
MASTER_URL=""
WORKSPACE_ROOT="$DATA_DIR/workspaces"
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
  --release-public-key K  release public key(s), comma-separated (max 2), written to a NEW config
  --node PATH             Node 24 binary to use; must be root-owned (the nodejs.org .pkg installs
                          /usr/local/bin/node). Default: the private Node under .../RemyralWorker/node
                          if this installer put one there, else a usable system-wide Node 24, else
                          the pinned Node is downloaded and verified (see --private-node)
  --private-node          always use the pinned private Node (download + verify if missing)
  --node-dist-url URL     mirror of https://nodejs.org/dist (hashes stay pinned)
  --master-url URL        wss://<master>/v1/worker - written to a new config only
  --workspace-root DIR    job workspace root (default .../RemyralWorker/data/workspaces)
  --max-parallel-jobs N   optional local hard ceiling written to a NEW config (localCeiling,
                          ADR-0015); normally parallelism is set from the dashboard
  --allow-machine-admin   local ceiling: AI machine administration may be enabled from the dashboard
                          (localCeiling.allowMachineAdmin: true, an explicit opt-in). Without either
                          flag the key is not written: the dashboard decides (the default)
  --no-machine-admin      local veto: AI machine administration (root commands signed by the master)
                          is refused on this machine whatever the dashboard says
                          (localCeiling.allowMachineAdmin: false). Both flags also change an existing
                          config (only that key; the worker is restarted). docs/ops/machine-admin.md
  --replace-config        overwrite an existing config.json
  --no-start              install, but do not load/restart the LaunchDaemon
  --allow-unsafe-node     accept a Node binary that is not root-owned or is group/world-
                          writable, e.g. Homebrew's (NOT recommended: whoever can replace it
                          runs code as the worker)
  --dry-run               print every action, change nothing
  -h, --help
EOF
}

die() { printf 'install.sh: error: %s\n' "$*" >&2; exit 1; }
# Node checks: fatal for a real install; in --dry-run reported so the rest of the plan still prints.
refuse() {
  if [ "$DRY_RUN" = 1 ]; then warn "$* - a real install would STOP here"; else die "$*"; fi
}
warn() { printf 'install.sh: warning: %s\n' "$*" >&2; }
info() { printf '==> %s\n' "$*"; }

# Prints a command with shell quoting so paths with spaces are unambiguous.
show_cmd() {
  local out="" a
  for a in "$@"; do
    case $a in
      *[!A-Za-z0-9_./:=@%+,-]* | "") out="$out '${a//\'/\'\\\'\'}'" ;;
      *) out="$out $a" ;;
    esac
  done
  printf '%s' "${out# }"
}

# Every state-changing command goes through run(); in dry-run it is only printed.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$(show_cmd "$@")"
  else
    printf '+ %s\n' "$(show_cmd "$@")"
    "$@"
  fi
}

meta() { stat -f '%Lp %Su %Sg' "$1"; }

# install_file SRC DEST MODE OWNER GROUP - returns 0 if it changed (or would change).
install_file() {
  local src=$1 dest=$2 mode=$3 owner=$4 group=$5
  if [ -f "$dest" ] && cmp -s "$src" "$dest" && [ "$(meta "$dest")" = "${mode#0} $owner $group" ]; then
    return 1
  fi
  run install -o "$owner" -g "$group" -m "$mode" "$src" "$dest"
  return 0
}

ensure_dir() {
  local dir=$1 mode=$2 owner=$3 group=$4
  [ -L "$dir" ] && die "$dir is a symlink; refusing (remove it first)"
  if [ -d "$dir" ] && [ "$(meta "$dir")" = "${mode#0} $owner $group" ]; then return 0; fi
  if [ -d "$dir" ]; then
    run chown "$owner:$group" "$dir"
    run chmod "$mode" "$dir"
  else
    run install -d -o "$owner" -g "$group" -m "$mode" "$dir"
  fi
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
[ "$(uname -s)" = Darwin ] || die "this installer is for macOS (use infra/worker/linux or windows)"
if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo), or use --dry-run"; fi
if [ -n "$MAX_PARALLEL_JOBS" ]; then
  case $MAX_PARALLEL_JOBS in *[!0-9]*) die "--max-parallel-jobs must be a number 1-64" ;; esac
  { [ "$MAX_PARALLEL_JOBS" -ge 1 ] && [ "$MAX_PARALLEL_JOBS" -le 64 ]; } || die "--max-parallel-jobs must be 1-64"
fi
if [ -n "$NODE_BIN" ] && [ "$PRIVATE_NODE" = 1 ]; then die "--node and --private-node exclude each other"; fi
case $NODE_DIST_OVERRIDE in '' | https://* | http://127.0.0.1* | http://localhost*) ;; *) die "--node-dist-url must be https:// (plain http only for a local mirror)" ;; esac
# Installer kit (p5-worker-onboarding): every file must match SHA256SUMS before anything is installed.
if [ -f "$HERE/SHA256SUMS" ]; then
  (cd "$HERE" && shasum -a 256 -q -c SHA256SUMS) || die "installer kit files do not match $HERE/SHA256SUMS; download the kit again"
  info "installer kit checksums verified (SHA256SUMS)"
fi
case $WORKSPACE_ROOT in /*) ;; *) die "--workspace-root must be an absolute path" ;; esac
case $WORKSPACE_ROOT in /Users/*) die "--workspace-root may not be inside a user's home (ADR-0007: worker-owned root)" ;; esac
if [ -n "$MASTER_URL" ]; then
  case $MASTER_URL in
    wss://*) ;;
    ws://127.0.0.1* | ws://localhost* | ws://\[::1\]*) warn "plain ws:// is for local development only" ;;
    *) die "--master-url must start with wss:// (got: $MASTER_URL)" ;;
  esac
fi

if [ -z "$BUNDLE" ]; then
  for candidate in "$HERE/remyral-worker.mjs" "$HERE/../../../apps/worker/dist/remyral-worker.mjs"; do
    if [ -f "$candidate" ]; then BUNDLE=$candidate; break; fi
  done
fi
{ [ -n "$BUNDLE" ] && [ -f "$BUNDLE" ]; } || die "worker bundle not found; pass --bundle PATH (build it with: pnpm --filter @remyral/worker bundle)"
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
# A kit ships the signed release next to the bundle: install it through the verifying updater.
if [ -z "$MANIFEST$SIGNATURE" ] && [ -f "$(dirname "$BUNDLE")/manifest.json" ] && [ -f "$(dirname "$BUNDLE")/manifest.sig.json" ]; then
  MANIFEST="$(dirname "$BUNDLE")/manifest.json"
  SIGNATURE="$(dirname "$BUNDLE")/manifest.sig.json"
  info "signed release found next to the bundle: $MANIFEST"
fi
if [ -n "$BUNDLE_SHA256" ]; then
  actual=$(shasum -a 256 "$BUNDLE" | cut -d' ' -f1)
  [ "$actual" = "$BUNDLE_SHA256" ] || die "bundle SHA-256 mismatch: expected $BUNDLE_SHA256, got $actual"
  info "bundle SHA-256 verified"
elif [ -z "$MANIFEST" ]; then
  warn "neither --manifest/--signature nor --bundle-sha256 given: bundle integrity not verified"
fi
if [ -n "$MANIFEST$SIGNATURE" ]; then
  { [ -f "$MANIFEST" ] && [ -f "$SIGNATURE" ]; } || die "--manifest and --signature must both name existing files"
fi
if [ -n "$RELEASE_KEYS" ] && ! printf '%s' "$RELEASE_KEYS" | grep -Eq '^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43})?$'; then
  die "--release-public-key must be one or two base64url Ed25519 public keys, comma-separated"
fi
if [ -z "$UPDATER_SRC" ]; then
  for candidate in "$(dirname "$BUNDLE")/remyral-worker-updater.mjs" "$HERE/remyral-worker-updater.mjs"; do
    if [ -f "$candidate" ]; then UPDATER_SRC=$candidate; break; fi
  done
fi
if [ -n "$UPDATER_SRC" ]; then
  [ -f "$UPDATER_SRC" ] || die "updater not found: $UPDATER_SRC"
  UPDATER_SRC="$(cd "$(dirname "$UPDATER_SRC")" && pwd)/$(basename "$UPDATER_SRC")"
elif [ -n "$MANIFEST" ]; then
  die "a signed install needs remyral-worker-updater.mjs (pass --updater PATH)"
else
  warn "remyral-worker-updater.mjs not found: automatic updates will not be possible on this machine"
fi

# A worker installed before the Remyral rename (com.remana.worker) is not migrated by this kit any more (Remyral cut-over
# cleanup): refuse before anything changes. The 1.1.1 kit still migrates it in place.
if [ -e "/Library/Application Support/RemanaWorker/bin/remana-worker.mjs" ] || [ -e /Library/LaunchDaemons/com.remana.worker.plist ]; then
  die "a worker installed before the Remyral rename (com.remana.worker) is on this machine. This installer no longer migrates it: run the installer kit of worker 1.1.1 instead (console: /v1/worker/install/1.1.1/macos/...); it migrates the worker in place and the worker then updates itself"
fi

# Node 24 (T-SUP-2): root-owned, not group/world-writable, not in a home dir. Order: --node; the
# private pinned Node if this installer manages one (kept at the pin = upgrade/repair); a usable
# system-wide Node 24; otherwise the pinned Node (node/pin.env) under $NODE_PREFIX_ROOT.
node_problem() { # prints why PATH is not an acceptable worker Node, or nothing
  local p=$1 v q m o
  [ -x "$p" ] || { printf '%s is not executable' "$p"; return 0; }
  v=$("$p" --version 2>/dev/null || true)
  case $v in v$NODE_MAJOR.*) ;; *) printf 'Node.js %s is required (found %s at %s)' "$NODE_MAJOR" "${v:-nothing}" "$p"; return 0 ;; esac
  case $p in /Users/*) printf '%s is inside a home directory (nvm?)' "$p"; return 0 ;; esac
  for q in "$p" "$(dirname "$p")"; do
    m=$(stat -f '%Lp' "$q")
    o=$(stat -f '%Su' "$q")
    if [ "$o" != root ] || [ $((8#$m & 8#022)) -ne 0 ]; then
      printf 'unsafe Node location: %s (owner %s, mode %s) must be root-owned and not group/world-writable' "$q" "$o" "$m"
      return 0
    fi
  done
}
NODE_PIN_FILE=""
for candidate in "$HERE/node/pin.env" "$HERE/../node/pin.env"; do
  if [ -f "$candidate" ]; then NODE_PIN_FILE=$candidate; break; fi
done
NODE_KEYS_DIR=$(dirname "${NODE_PIN_FILE:-$HERE/node/pin.env}")
USING_PRIVATE_NODE=0
use_private_node() {
  [ -n "$NODE_PIN_FILE" ] || die "Node.js $NODE_MAJOR is needed but node/pin.env is missing (use the installer kit from the dashboard, or pass --node)"
  # shellcheck source=../node/install-node.sh
  . "$(dirname "$NODE_PIN_FILE")/install-node.sh"
  remyral_node_ensure
  NODE_BIN=$REMYRAL_NODE_BIN
  USING_PRIVATE_NODE=1
}
if [ -n "$NODE_BIN" ]; then
  [ -x "$NODE_BIN" ] || die "$NODE_BIN is not executable"
  NODE_BIN=$("$NODE_BIN" -p 'process.execPath' 2>/dev/null || printf '%s' "$NODE_BIN")   # resolves symlinks
  problem=$(node_problem "$NODE_BIN")
  case $problem in
    "") ;;
    unsafe*) if [ "$ALLOW_UNSAFE_NODE" = 1 ]; then warn "unsafe Node location accepted: ${problem#unsafe Node location: }"; else refuse "$problem - use the nodejs.org .pkg, drop --node for the pinned private Node (or pass --allow-unsafe-node)"; fi ;;
    *home*) refuse "$problem; install Node $NODE_MAJOR system-wide, or drop --node for the pinned private Node" ;;
    *) die "$problem" ;;
  esac
elif [ "$PRIVATE_NODE" = 1 ] || ls -d "$NODE_PREFIX_ROOT"/node-v* >/dev/null 2>&1; then
  use_private_node
else
  system_node=$(command -v node || true)
  problem=""
  if [ -n "$system_node" ]; then
    system_node=$("$system_node" -p 'process.execPath' 2>/dev/null || printf '%s' "$system_node")
    problem=$(node_problem "$system_node")
  fi
  if [ -n "$system_node" ] && [ -z "$problem" ]; then
    NODE_BIN=$system_node
  else
    info "${problem:-no system-wide Node.js $NODE_MAJOR}: using the pinned private Node (the system node is left alone)"
    use_private_node
  fi
fi
node_version=$("$NODE_BIN" --version 2>/dev/null || echo "v(pinned, dry-run)")
info "node $node_version at $NODE_BIN"

# ---------------------------------------------------------------------------------------------
info "Role account $SERVICE_USER"
used_ids() { dscl . -list "$1" "$2" 2>/dev/null | awk '{print $2}'; }
if dscl . -read "/Users/$SERVICE_USER" UniqueID >/dev/null 2>&1; then
  uid=$(dscl . -read "/Users/$SERVICE_USER" UniqueID | awk '{print $2}')
  shell=$(dscl . -read "/Users/$SERVICE_USER" UserShell | awk '{print $2}')
  case $shell in /usr/bin/false | /sbin/nologin | /usr/sbin/nologin) ;; *) die "existing $SERVICE_USER has a login shell ($shell); refusing" ;; esac
  [ "$uid" -lt 500 ] || die "existing $SERVICE_USER has uid $uid (>= 500: a visible login account); refusing"
  info "exists (uid $uid)"
  gid=$(dscl . -read "/Users/$SERVICE_USER" PrimaryGroupID | awk '{print $2}')
else
  taken=$( { used_ids /Users UniqueID; used_ids /Groups PrimaryGroupID; } | sort -n | uniq)
  uid=""
  id=$ID_MIN
  while [ "$id" -le "$ID_MAX" ]; do
    if ! printf '%s\n' "$taken" | grep -qx "$id"; then uid=$id; break; fi
    id=$((id + 1))
  done
  [ -n "$uid" ] || die "no free id in $ID_MIN-$ID_MAX for the role account"
  gid=$uid
  info "creating with uid/gid $uid (hidden role account, no shell, no password)"
  if ! dscl . -read "/Groups/$SERVICE_USER" >/dev/null 2>&1; then
    run dscl . -create "/Groups/$SERVICE_USER"
    run dscl . -create "/Groups/$SERVICE_USER" PrimaryGroupID "$gid"
    run dscl . -create "/Groups/$SERVICE_USER" RealName "Remyral Worker"
    run dscl . -create "/Groups/$SERVICE_USER" Password '*'
  else
    gid=$(dscl . -read "/Groups/$SERVICE_USER" PrimaryGroupID | awk '{print $2}')
  fi
  run dscl . -create "/Users/$SERVICE_USER"
  run dscl . -create "/Users/$SERVICE_USER" UniqueID "$uid"
  run dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID "$gid"
  run dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
  run dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory "$HOME_DIR"
  run dscl . -create "/Users/$SERVICE_USER" RealName "Remyral Worker"
  run dscl . -create "/Users/$SERVICE_USER" Password '*'
  run dscl . -create "/Users/$SERVICE_USER" IsHidden 1
fi

# ---------------------------------------------------------------------------------------------
info "Directories"
ensure_dir "$BASE_DIR" 0750 root "$SERVICE_USER"
ensure_dir "$BIN_DIR" 0755 root wheel
ensure_dir "$DATA_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
ensure_dir "$HOME_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
ensure_dir "$WORKSPACE_ROOT" 0700 "$SERVICE_USER" "$SERVICE_USER"
ensure_dir "$LOG_DIR" 0750 "$SERVICE_USER" admin
# p2-signed-updates: retained versions + updater state (root, readable by the worker); the worker's
# request/staging dir (watched by the updater LaunchDaemon).
ensure_dir "$BIN_DIR/versions" 0755 root wheel
ensure_dir "$BIN_DIR/state" 0755 root wheel
ensure_dir "$DATA_DIR/updates" 0700 "$SERVICE_USER" "$SERVICE_USER"
if [ ! -f "$LOG_FILE" ]; then
  run install -o "$SERVICE_USER" -g admin -m 0640 /dev/null "$LOG_FILE"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
changed_code=0
changed_plist=0

info "Updater"
if [ -n "$UPDATER_SRC" ]; then
  if install_file "$UPDATER_SRC" "$UPDATER" 0644 root wheel; then changed_code=1; else info "up to date"; fi
fi

info "Worker bundle"
if [ -n "$MANIFEST" ]; then
  # Signed release: verified by the updater, previous version kept under bin/versions, atomic switch.
  if [ -f "$BIN_DIR/remyral-worker.mjs" ] && cmp -s "$BUNDLE" "$BIN_DIR/remyral-worker.mjs"; then
    info "up to date"
  else
    if [ -f "$CONFIG_FILE" ]; then
      run "$NODE_BIN" "$UPDATER" adopt --install-dir "$BIN_DIR" --bundle "$BUNDLE" --manifest "$MANIFEST" --signature "$SIGNATURE" --config "$CONFIG_FILE"
    else
      run "$NODE_BIN" "$UPDATER" adopt --install-dir "$BIN_DIR" --bundle "$BUNDLE" --manifest "$MANIFEST" --signature "$SIGNATURE"
    fi
    changed_code=1
  fi
elif install_file "$BUNDLE" "$BIN_DIR/remyral-worker.mjs" 0644 root wheel; then changed_code=1; else info "up to date"; fi

cat >"$TMP/cli" <<EOF
#!/bin/sh
# remyral-worker CLI wrapper (installed by infra/worker/macos/install.sh)
exec '$NODE_BIN' '$BIN_DIR/remyral-worker.mjs' "\$@"
EOF
# Only create /usr/local/bin if missing; never change its owner (Intel Homebrew owns it).
[ -d /usr/local/bin ] || run install -d -o root -g wheel -m 0755 /usr/local/bin
if install_file "$TMP/cli" "$CLI_WRAPPER" 0755 root wheel; then show_file "$CLI_WRAPPER" "$TMP/cli"; fi

# ---------------------------------------------------------------------------------------------
info "Config $CONFIG_FILE"
have_config=0
if [ -f "$CONFIG_FILE" ] && [ "$REPLACE_CONFIG" = 0 ]; then
  have_config=1
  [ -z "$MASTER_URL" ] || warn "config exists and was NOT changed (edit it, or pass --replace-config)"
  if [ "$(meta "$CONFIG_FILE")" != "640 root $SERVICE_USER" ]; then
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
  # Minimal local config (p5-worker-onboarding): master + paths; everything else is a worker default or
  # comes from the dashboard. Written without node (dry-run before the pinned Node exists).
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
info "LaunchDaemon $PLIST"
sed "s#@NODE@#$NODE_BIN#g" "$HERE/$LABEL.plist" >"$TMP/plist"
if [ "$WORKSPACE_ROOT" != "$DATA_DIR/workspaces" ]; then
  info "custom workspace root $WORKSPACE_ROOT (owned by $SERVICE_USER, 0700)"
fi
plutil -lint "$TMP/plist" >/dev/null || die "rendered plist does not lint"
loaded=0
if launchctl print "system/$LABEL" >/dev/null 2>&1; then loaded=1; fi
if [ "$have_config" = 0 ]; then
  # Without a config the daemon would exit 78 every ThrottleInterval; install the plist later.
  info "not installing the LaunchDaemon yet: no config"
else
  if install_file "$TMP/plist" "$PLIST" 0644 root wheel; then changed_plist=1; show_file "$PLIST" "$TMP/plist"; else info "up to date"; fi
fi

# p2-signed-updates: the updater LaunchDaemon (root; started by launchd on the worker's request).
changed_updater=0
updater_loaded=0
if [ -n "$UPDATER_SRC" ] && [ "$have_config" = 1 ]; then
  info "Updater LaunchDaemon $UPDATER_PLIST"
  sed "s#@NODE@#$NODE_BIN#g" "$HERE/$UPDATER_LABEL.plist" >"$TMP/updater-plist"
  plutil -lint "$TMP/updater-plist" >/dev/null || die "rendered updater plist does not lint"
  if launchctl print "system/$UPDATER_LABEL" >/dev/null 2>&1; then updater_loaded=1; fi
  if install_file "$TMP/updater-plist" "$UPDATER_PLIST" 0644 root wheel; then changed_updater=1; show_file "$UPDATER_PLIST" "$TMP/updater-plist"; fi
fi
changed_admin=0
admin_loaded=0
if [ -n "$UPDATER_SRC" ] && [ "$have_config" = 1 ] && [ -f "$HERE/$ADMIN_LABEL.plist" ]; then
  info "Machine-admin LaunchDaemon $ADMIN_PLIST"
  sed "s#@NODE@#$NODE_BIN#g" "$HERE/$ADMIN_LABEL.plist" >"$TMP/admin-plist"
  plutil -lint "$TMP/admin-plist" >/dev/null || die "rendered machine-admin plist does not lint"
  if launchctl print "system/$ADMIN_LABEL" >/dev/null 2>&1; then admin_loaded=1; fi
  if install_file "$TMP/admin-plist" "$ADMIN_PLIST" 0644 root wheel; then changed_admin=1; fi
fi

# The plists now point at the active Node; older private Node versions can go.
if [ "$USING_PRIVATE_NODE" = 1 ]; then remyral_node_prune "$NODE_BIN"; fi

# ---------------------------------------------------------------------------------------------
info "Load and start"
if [ "$have_config" = 0 ]; then
  info "skipped: no config"
elif [ "$NO_START" = 1 ]; then
  info "--no-start: not loading (loaded: $loaded)"
elif [ "$loaded" = 1 ] && [ "$changed_plist" = 1 ]; then
  # A changed plist is only re-read on bootstrap.
  run launchctl bootout "system/$LABEL"
  run launchctl enable "system/$LABEL"
  run launchctl bootstrap system "$PLIST"
elif [ "$loaded" = 1 ] && [ "$changed_code" = 1 ]; then
  run launchctl kickstart -k "system/$LABEL"
elif [ "$loaded" = 1 ]; then
  info "already loaded, nothing changed"
else
  run launchctl enable "system/$LABEL"
  run launchctl bootstrap system "$PLIST"
fi

if [ -n "$UPDATER_SRC" ] && [ "$have_config" = 1 ] && [ "$NO_START" = 0 ]; then
  if [ "$updater_loaded" = 1 ] && [ "$changed_updater" = 1 ]; then
    run launchctl bootout "system/$UPDATER_LABEL"
    updater_loaded=0
  fi
  if [ "$updater_loaded" = 0 ]; then
    run launchctl enable "system/$UPDATER_LABEL"
    run launchctl bootstrap system "$UPDATER_PLIST"
  fi
  if [ -f "$HERE/$ADMIN_LABEL.plist" ]; then
    if [ "$admin_loaded" = 1 ] && [ "$changed_admin" = 1 ]; then
      run launchctl bootout "system/$ADMIN_LABEL"
      admin_loaded=0
    fi
    if [ "$admin_loaded" = 0 ]; then
      run launchctl enable "system/$ADMIN_LABEL"
      run launchctl bootstrap system "$ADMIN_PLIST"
    fi
  fi
fi

# Security fix (helper binding): the root helper serves exactly one worker id, recorded root-owned in
# $BIN_DIR/state/admin-binding.json. An enrolled worker (a re-run on an existing install) is bound here, once; a new
# machine is bound after its approval with the admin-bind line printed below. Never changes an existing binding and
# never fails the install.
if [ -n "$UPDATER_SRC" ] && [ "$have_config" = 1 ] && [ -f "$HERE/$ADMIN_LABEL.plist" ]; then
  info "Machine administration binding"
  run "$NODE_BIN" "$UPDATER" admin-bind --if-unbound --config "$CONFIG_FILE" ||
    warn "admin-bind failed; machine administration stays refused until: sudo '$NODE_BIN' '$UPDATER' admin-bind"
fi

done_note=""
[ "$DRY_RUN" = 0 ] || done_note=" (dry-run: nothing was changed)"
cat <<EOF

Done$done_note.
  Status:      sudo remyral-worker service status     (or: sudo launchctl print system/$LABEL)
  Logs:        tail -f $LOG_FILE
  Pairing:     grep pairingCode $LOG_FILE - then approve in the dashboard and compare the
               fingerprint (docs/ops/worker-pairing.md)
  Identity:    sudo -u $SERVICE_USER remyral-worker identity show --data-dir '$DATA_DIR'
  Updates:     sudo node '$UPDATER' status      (signed auto-update; docs/ops/worker-updates.md)
  Machine admin: once the machine is approved (only if you use machine administration):
               sudo '$NODE_BIN' '$UPDATER' admin-bind   (docs/ops/machine-admin.md)
  Uninstall:   sudo $HERE/uninstall.sh [--purge]
EOF
