# shellcheck shell=bash
# Pinned Node.js 24 for the worker (p5-worker-onboarding) — sourced by infra/worker/linux/install.sh and
# infra/worker/macos/install.sh (bash 3.2 compatible: macOS /bin/bash). Not executable on its own.
#
# Installs the Node version pinned in pin.env into a PRIVATE, root-owned prefix (Linux
# /opt/remyral-worker/node, macOS /Library/Application Support/RemyralWorker/node). It never touches the
# system `node`, /usr/local, PATH or any other user's environment: only the worker's service definition
# and CLI wrapper point at the private binary.
#
# Verification chain (docs/design/p5-worker-onboarding.md §Node bootstrap):
#   1. SHASUMS256.txt must have the SHA-256 pinned in pin.env. That file's OpenPGP signature was verified
#      against the vendored Node release keys when the pin was written (scripts/security/node-pin.mjs).
#   2. If `gpgv` is available (Debian, Ubuntu, Raspberry Pi OS: always) the detached signature
#      SHASUMS256.txt.sig is verified AGAIN here against the vendored keyring — a failure is fatal.
#   3. The archive's line in SHASUMS256.txt must equal the per-platform hash in pin.env, and the
#      downloaded archive must hash to it.
#
# The caller provides: run (prints/executes), info, warn, die, DRY_RUN, and sets
#   NODE_PIN_FILE      path of pin.env
#   NODE_PREFIX_ROOT   private prefix (created root 0755)
#   NODE_KEYS_DIR      optional: dir with nodejs-keyring.gpg (kit) or keys/*.asc (repository)
#   NODE_DIST_OVERRIDE optional: mirror base URL (--node-dist-url); integrity stays pinned
# and gets REMYRAL_NODE_BIN (the private node binary) from remyral_node_ensure.

remyral_node_pin() { # remyral_node_pin KEY → value from pin.env (the file is parsed, never sourced)
  local v
  v=$(sed -n "s/^$1=\\([A-Za-z0-9._:\\/-]*\\)\$/\\1/p" "$NODE_PIN_FILE" | head -n 1)
  [ -n "$v" ] || die "$NODE_PIN_FILE has no valid $1"
  printf '%s' "$v"
}

remyral_node_platform() {
  local os arch
  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "no pinned Node build for $(uname -s)" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "no pinned Node build for $(uname -m) (Raspberry Pi needs the 64-bit OS)" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

remyral_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

remyral_download() { # remyral_download URL FILE — TLS 1.2+, no redirects to plain http
  local url=$1 out=$2
  if command -v curl >/dev/null 2>&1; then
    case $url in
      https://*) curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$out" "$url" ;;
      *) curl -fsSL --retry 3 -o "$out" "$url" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    case $url in
      https://*) wget -q --https-only --secure-protocol=TLSv1_2 -O "$out" "$url" ;;
      *) wget -q -O "$out" "$url" ;;
    esac
  else
    die "neither curl nor wget is installed; install one, or pass --node PATH"
  fi
}

# Builds a binary OpenPGP keyring for gpgv: the kit ships nodejs-keyring.gpg; a repository checkout has
# the armored keys and needs gpg to dearmor them. Prints the keyring path, or nothing.
remyral_node_keyring() {
  local tmp=$1 f
  [ -n "${NODE_KEYS_DIR:-}" ] || return 0
  if [ -f "$NODE_KEYS_DIR/nodejs-keyring.gpg" ]; then
    printf '%s' "$NODE_KEYS_DIR/nodejs-keyring.gpg"
    return 0
  fi
  if [ -d "$NODE_KEYS_DIR/keys" ] && command -v gpg >/dev/null 2>&1; then
    : >"$tmp/keyring.gpg"
    for f in "$NODE_KEYS_DIR"/keys/*.asc; do
      gpg --dearmor <"$f" >>"$tmp/keyring.gpg" 2>/dev/null || return 0
    done
    printf '%s' "$tmp/keyring.gpg"
  fi
}

# remyral_node_ensure — sets REMYRAL_NODE_BIN; installs the pinned Node if it is not there yet.
remyral_node_ensure() {
  local version plat key expected dist file dir bin tmp keyring line have
  version=$(remyral_node_pin NODE_VERSION)
  case $version in 24.*) ;; *) die "$NODE_PIN_FILE pins Node $version; the worker needs Node 24" ;; esac
  plat=$(remyral_node_platform)
  key=NODE_SHA256_$(printf '%s' "$plat" | tr '-' '_')
  expected=$(remyral_node_pin "$key")
  dist=${NODE_DIST_OVERRIDE:-$(remyral_node_pin NODE_DIST_URL)}
  dist=${dist%/}
  file=node-v$version-$plat.tar.gz
  dir=$NODE_PREFIX_ROOT/node-v$version-$plat
  bin=$dir/bin/node
  REMYRAL_NODE_BIN=$bin

  if [ -x "$bin" ] && [ -f "$dir/.remyral-sha256" ] && [ "$(cat "$dir/.remyral-sha256")" = "$expected" ] &&
    [ "$("$bin" --version 2>/dev/null || true)" = "v$version" ]; then
    info "private Node v$version ($plat) already installed at $dir"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] download %s/v%s/{SHASUMS256.txt,SHASUMS256.txt.sig,%s}\n' "$dist" "$version" "$file"
    printf '[dry-run] verify SHASUMS256.txt (pinned sha256 %s; gpgv signature if available) and %s (sha256 %s)\n' \
      "$(remyral_node_pin NODE_SHASUMS256_SHA256)" "$file" "$expected"
    printf '[dry-run] extract into %s (root-owned, not on PATH)\n' "$dir"
    return 0
  fi

  info "installing private Node v$version ($plat) from $dist"
  case $dist in https://*) ;; *) warn "Node mirror $dist is not https; integrity is still enforced by the pinned hashes" ;; esac
  run install -d -o root -g 0 -m 0755 "$NODE_PREFIX_ROOT"
  # Staging on the same filesystem (atomic rename); a crash leaves .staging.* that the next run prunes.
  tmp=$(mktemp -d "$NODE_PREFIX_ROOT/.staging.XXXXXX")
  remyral_download "$dist/v$version/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || { rm -rf "$tmp"; die "could not download SHASUMS256.txt from $dist"; }
  have=$(remyral_sha256 "$tmp/SHASUMS256.txt")
  if [ "$have" != "$(remyral_node_pin NODE_SHASUMS256_SHA256)" ]; then
    rm -rf "$tmp"
    die "SHASUMS256.txt for Node v$version has sha256 $have, pinned $(remyral_node_pin NODE_SHASUMS256_SHA256) — refusing (tampered mirror or wrong pin)"
  fi
  keyring=$(remyral_node_keyring "$tmp")
  if command -v gpgv >/dev/null 2>&1 && [ -n "$keyring" ]; then
    remyral_download "$dist/v$version/SHASUMS256.txt.sig" "$tmp/SHASUMS256.txt.sig" || { rm -rf "$tmp"; die "could not download SHASUMS256.txt.sig"; }
    if ! gpgv --keyring "$keyring" "$tmp/SHASUMS256.txt.sig" "$tmp/SHASUMS256.txt" >"$tmp/gpgv.log" 2>&1; then
      cat "$tmp/gpgv.log" >&2
      rm -rf "$tmp"
      die "the OpenPGP signature of SHASUMS256.txt does not verify against the vendored Node release keys"
    fi
    info "SHASUMS256.txt: pinned sha256 ok, signature verified with the vendored Node release keys (gpgv)"
  else
    info "SHASUMS256.txt: pinned sha256 ok (its signature was verified when the pin was made; gpgv not available here)"
  fi
  line=$(grep "  $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1 || true)
  if [ "$line" != "$expected" ]; then
    rm -rf "$tmp"
    die "SHASUMS256.txt lists ${line:-nothing} for $file, pin.env says $expected"
  fi
  remyral_download "$dist/v$version/$file" "$tmp/$file" || { rm -rf "$tmp"; die "could not download $file"; }
  have=$(remyral_sha256 "$tmp/$file")
  if [ "$have" != "$expected" ]; then
    rm -rf "$tmp"
    die "$file has sha256 $have, expected $expected — refusing"
  fi
  info "$file: sha256 verified"
  mkdir "$tmp/x"
  tar -xzf "$tmp/$file" -C "$tmp/x"
  [ -x "$tmp/x/node-v$version-$plat/bin/node" ] || { rm -rf "$tmp"; die "$file does not contain node-v$version-$plat/bin/node"; }
  printf '%s\n' "$expected" >"$tmp/x/node-v$version-$plat/.remyral-sha256"
  chown -R 0:0 "$tmp/x/node-v$version-$plat"
  chmod -R a+rX,go-w "$tmp/x/node-v$version-$plat"
  chmod 0755 "$tmp/x/node-v$version-$plat"
  [ ! -e "$dir" ] || run rm -rf "$dir"
  run mv "$tmp/x/node-v$version-$plat" "$dir"
  rm -rf "$tmp"
  [ "$("$bin" --version 2>/dev/null || true)" = "v$version" ] || die "$bin does not run (wrong architecture?)"
  info "private Node v$version installed at $dir"
}

# remyral_node_prune — removes private Node versions other than the active one (after the service
# definition points at the new binary).
remyral_node_prune() {
  local keep=$1 d
  [ -d "$NODE_PREFIX_ROOT" ] || return 0
  for d in "$NODE_PREFIX_ROOT"/node-v* "$NODE_PREFIX_ROOT"/.staging.*; do
    [ -e "$d" ] || continue
    case $keep in "$d"/*) continue ;; esac
    run rm -rf "$d"
  done
}
