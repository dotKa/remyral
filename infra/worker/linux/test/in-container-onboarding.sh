#!/usr/bin/env bash
# Runs INSIDE the systemd test container (see onboarding-e2e.sh): the owner's path from Fleet → Add
# machine — download + verify the bootstrap exactly like the console's command, run it, private pinned
# Node (nonode) or the system Node (node), signed install, minimal config, service, pairing code shown
# and received by the master (waiting for approval), idempotent re-run, refused kit, uninstall.
#   in-container-onboarding.sh nonode|node
set -euo pipefail
MODE=${1:?nonode|node}
UNIT=remyral-worker.service
FM=/tmp/fm
PRIV=/opt/remyral-worker/node/node-v$NODE_V-linux-arm64
pass=0
ok() { pass=$((pass + 1)); printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*" >&2
  for f in /tmp/b*.log; do [ -f "$f" ] && { echo "--- $f" >&2; tail -40 "$f" >&2; }; done
  journalctl -u $UNIT -u fake-master --no-pager -n 30 >&2 || true
  exit 1
}
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
wait_for() {
  local t=$1 what=$2; shift 2
  for _ in $(seq 1 $((t * 5))); do if "$@"; then ok "$what"; return 0; fi; sleep 0.2; done
  fail "$what (timeout ${t}s)"
}
for _ in $(seq 1 100); do
  case $(systemctl is-system-running 2>/dev/null || true) in running | degraded) break ;; esac
  sleep 0.2
done
echo "systemd $(systemctl --version | head -1 | cut -d' ' -f2), arch $(uname -m), mode $MODE"
mkdir -p $FM
systemd-run --unit=fake-master -E FM_DIR=$FM -E FM_STATIC=/fx -E FM_PENDING=1 /tools/node /fm/fake-master.mjs >/dev/null
wait_for 20 "scripted master (bootstrap, kit, Node mirror) up" curl -fsS -o /dev/null http://127.0.0.1:8080/v1/worker/install/1.0.0/linux/bootstrap.sh

if [ "$MODE" = nonode ]; then
  check "no Node on this machine" bash -c '! command -v node'
else
  check "system Node 24 present" bash -c 'node --version | grep -q "^v24\."'
  sys_node_sum=$(sha256sum /usr/local/bin/node | cut -d' ' -f1)
fi

# --- 1. the console's two lines -----------------------------------------------------------------
cd /root
curl -fsSL -o remyral-bootstrap.sh 'http://127.0.0.1:8080/v1/worker/install/1.0.0/linux/bootstrap.sh' &&
  echo "$BOOT_SHA  remyral-bootstrap.sh" | sha256sum -c - >/tmp/b0.log 2>&1 || fail "bootstrap download + checksum"
ok "bootstrap downloaded and its SHA-256 matches the console's"
sh remyral-bootstrap.sh --node-dist-url http://127.0.0.1:8080/node-dist >/tmp/b1.log 2>&1 || fail "bootstrap install"
ok "bootstrap → kit → install.sh completed"
check "kit SHA-256 verified by the bootstrap" grep -q 'installer kit SHA-256 verified' /tmp/b1.log
check "kit SHA256SUMS verified by install.sh" grep -q 'installer kit checksums verified' /tmp/b1.log
check "signed release found and installed through the updater" grep -q 'signed release found next to the bundle' /tmp/b1.log
check "active.json says 1.0.0 (signature verified by adopt)" grep -q '"version":"1.0.0"' /opt/remyral-worker/state/active.json
check "kit kept for repair/uninstall, root-owned" [ "$(stat -c '%U %a' /opt/remyral-worker/installer/remyral-worker-1.0.0-linux/install.sh)" = "root 755" ]

if [ "$MODE" = nonode ]; then
  check "pinned Node downloaded, SHASUMS signature verified with gpgv" grep -q 'signature verified with the vendored Node release keys (gpgv)' /tmp/b1.log
  check "private Node installed root-owned, not writable by others" [ "$(stat -c '%U %a' "$PRIV/bin/node")" = "root 755" ]
  check "private Node runs v$NODE_V" [ "$("$PRIV/bin/node" --version)" = "v$NODE_V" ]
  check "system PATH unchanged: still no node" bash -c '! command -v node'
  check "unit runs the private Node" grep -q "^ExecStart=$PRIV/bin/node " /etc/systemd/system/$UNIT
  check "CLI wrapper runs the private Node" grep -q "exec $PRIV/bin/node " /usr/local/bin/remyral-worker
else
  check "system Node used, nothing downloaded" bash -c '[ ! -e /opt/remyral-worker/node ] && grep -q "node v24.* at /usr/local/bin/node" /tmp/b1.log'
  check "system Node untouched" [ "$(sha256sum /usr/local/bin/node | cut -d' ' -f1)" = "$sys_node_sum" ]
  check "unit runs the system Node" grep -q '^ExecStart=/usr/local/bin/node ' /etc/systemd/system/$UNIT
fi

keys=$(/tools/node -p 'Object.keys(JSON.parse(require("fs").readFileSync("/etc/remyral-worker/config.json","utf8"))).sort().join(",")')
check "minimal local config: master URL + paths only ($keys)" [ "$keys" = "masterUrl,workspaceRoot" ]
check "config points at the master" grep -q '"masterUrl": "ws://127.0.0.1:8080/v1/worker"' /etc/remyral-worker/config.json
wait_for 15 "service active" bash -c "[ \"\$(systemctl is-active $UNIT)\" = active ]"

# --- 2. pairing code shown on the machine = request waiting in the master ---------------------------
code=$(sed -n 's/^ *Pairing code: \([A-Z0-9-]*\)$/\1/p' /tmp/b1.log | tail -1)
fp=$(sed -n 's/^ *Fingerprint: *\(SHA256:[0-9A-F-]*\)$/\1/p' /tmp/b1.log | tail -1)
check "installer printed the pairing code ($code)" grep -Eq '^[A-Z2-9]{4}-[A-Z2-9]{4}$' <<<"$code"
check "installer printed the fingerprint" grep -q '^SHA256:' <<<"$fp"
wait_for 20 "master received this pairing request (waiting for approval)" grep -q "\"pairingCode\":\"$code\"" $FM/pairing.jsonl
check "fingerprint on the machine = fingerprint the master shows" grep -q "\"fingerprint\":\"$fp\"" $FM/pairing.jsonl
check "nothing approved: no session" bash -c "[ ! -s $FM/sessions.jsonl ]"

# --- 3. re-run = repair/upgrade, same identity ----------------------------------------------------------
key_before=$(sha256sum /var/lib/remyral-worker/device-key.json | cut -d' ' -f1)
sh remyral-bootstrap.sh --node-dist-url http://127.0.0.1:8080/node-dist >/tmp/b2.log 2>&1 || fail "re-run"
ok "re-run completed"
if [ "$MODE" = nonode ]; then check "re-run keeps the private Node" grep -q "private Node v$NODE_V (linux-arm64) already installed" /tmp/b2.log; fi
check "re-run keeps the config" grep -q 'config exists and was NOT changed' /tmp/b2.log
check "re-run keeps the device key" [ "$(sha256sum /var/lib/remyral-worker/device-key.json | cut -d' ' -f1)" = "$key_before" ]
check "service still active" [ "$(systemctl is-active $UNIT)" = active ]
# Repair: a damaged private Node is reinstalled from the pin.
if [ "$MODE" = nonode ]; then
  echo broken >"$PRIV/.remyral-sha256"
  sh remyral-bootstrap.sh --node-dist-url http://127.0.0.1:8080/node-dist >/tmp/b3.log 2>&1 || fail "repair"
  check "repair reinstalled the pinned Node" grep -q "private Node v$NODE_V installed" /tmp/b3.log
fi

# --- 4. a kit that does not match the console's hash is never installed --------------------------------
sed "s/^KIT_SHA256=.*/KIT_SHA256='$(printf '%064d' 0)'/" remyral-bootstrap.sh >evil.sh
if sh evil.sh >/tmp/b4.log 2>&1; then fail "mismatching kit accepted"; fi
check "kit hash mismatch refused before anything ran" grep -q 'installer kit SHA-256 mismatch' /tmp/b4.log

# --- 5. uninstall from the kept kit ----------------------------------------------------------------------
bash /opt/remyral-worker/installer/remyral-worker-1.0.0-linux/uninstall.sh >/tmp/b5.log 2>&1 || fail "uninstall"
check "uninstalled: service gone, program dir (incl. private Node) removed" bash -c "[ ! -e /etc/systemd/system/$UNIT ] && [ ! -e /opt/remyral-worker ]"
check "device key kept for a later re-install" [ -f /var/lib/remyral-worker/device-key.json ]
echo "ALL PASSED ($pass checks, $MODE)"
