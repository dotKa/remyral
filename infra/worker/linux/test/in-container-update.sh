#!/usr/bin/env bash
# Runs INSIDE the systemd test container (see update-e2e.sh): signed install, signed update through the
# real path unit + privileged updater + real systemd restart, forced-failure rollback, refusals
# (tampered release, downgrade), explicit rollback, a forged request from the worker account, uninstall.
set -euo pipefail

SRC=/src
FM=/tmp/fm
REL=$FM/releases
UNIT=remyral-worker.service
pass=0

ok() { pass=$((pass + 1)); printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*" >&2
  journalctl -u $UNIT -u remyral-worker-update.service --no-pager -n 60 >&2 || true
  cat $FM/status.jsonl >&2 2>/dev/null || true
  exit 1
}
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
wait_for() { # wait_for SECONDS DESCRIPTION CMD...
  local t=$1 what=$2; shift 2
  for _ in $(seq 1 $((t * 5))); do if "$@"; then ok "$what"; return 0; fi; sleep 0.2; done
  fail "$what (timeout ${t}s)"
}
prop() { systemctl show -p "$1" --value $UNIT; }
is_active() { [ "$(systemctl is-active $UNIT)" = active ]; }
status_has() { grep -q "$1" $FM/status.jsonl 2>/dev/null; }
active_is() { cmp -s /opt/remyral-worker/remyral-worker.mjs "$REL/$1/remyral-worker.mjs"; }
offer() { printf '%s\n' "$1" >$FM/offer.json; }

for _ in $(seq 1 100); do
  s=$(systemctl is-system-running 2>/dev/null || true)
  case $s in running | degraded) break ;; esac
  sleep 0.2
done
echo "systemd $(systemctl --version | head -1 | cut -d' ' -f2), arch $(uname -m)"
mkdir -p $FM && cp -r /rel $REL
sig() { printf -- '--bundle %s --manifest %s --signature %s --updater %s' "$REL/$1/remyral-worker.mjs" "$REL/$1/manifest.json" "$REL/$1/manifest.sig.json" "$REL/$1/remyral-worker-updater.mjs"; }

# --- 1. units verify, dry-run shows the updater plan --------------------------------------------
for u in remyral-worker-update.service remyral-worker-update.path; do
  sed "s#@NODE@#/usr/local/bin/node#" $SRC/$u >/tmp/$u
done
out=$(systemd-analyze verify --man=no /tmp/remyral-worker-update.service /tmp/remyral-worker-update.path 2>&1 || true)
check "systemd-analyze verify of the updater units: no findings ($out)" [ -z "$out" ]
# shellcheck disable=SC2046
out=$(su -s /bin/bash node -c "bash $SRC/install.sh --dry-run $(sig 1.0.0) --master-url ws://127.0.0.1:8080/v1/worker")
check "dry-run prints the signed adopt step" grep -q '^\[dry-run\] .*remyral-worker-updater.mjs adopt --install-dir /opt/remyral-worker' <<<"$out"
check "dry-run prints the path unit install" grep -q '^\[dry-run\] install .*/etc/systemd/system/remyral-worker-update.path' <<<"$out"
check "dry-run changed nothing" bash -c '[ ! -e /opt/remyral-worker ]'

# --- 2. signed install of 1.0.0 -------------------------------------------------------------------
# shellcheck disable=SC2046
bash $SRC/install.sh $(sig 1.0.0) --master-url ws://127.0.0.1:8080/v1/worker >/tmp/i1.log 2>&1 || { cat /tmp/i1.log; fail "signed install"; }
check "1.0.0 verified and active" active_is 1.0.0
check "versions/1.0.0 retained (root 644)" [ "$(stat -c '%a %U' /opt/remyral-worker/versions/1.0.0/remyral-worker.mjs)" = "644 root" ]
check "active.json says 1.0.0" grep -q '"version":"1.0.0"' /opt/remyral-worker/state/active.json
check "updater installed root 644" [ "$(stat -c '%a %U' /opt/remyral-worker/remyral-worker-updater.mjs)" = "644 root" ]
check "path unit active" [ "$(systemctl is-active remyral-worker-update.path)" = active ]
check "updater service enabled (boot resume)" [ "$(systemctl is-enabled remyral-worker-update.service)" = enabled ]
check "worker data dir has updates/ (700 worker)" [ "$(stat -c '%a %U' /var/lib/remyral-worker/updates)" = "700 remyral-worker" ]
# A 20 s health window keeps the forced-failure case short.
node -e 'const fs=require("fs");const p="/etc/remyral-worker/config.json";const c=JSON.parse(fs.readFileSync(p));c.updates={...(c.updates??{}),healthTimeoutSec:20};fs.writeFileSync(p,JSON.stringify(c,null,2))'
systemctl restart $UNIT
systemd-run --unit=fake-master -E FM_DIR=$FM /usr/local/bin/node /fm/fake-master.mjs >/dev/null
wait_for 30 "worker 1.0.0 connected and paired with the (fake) master" grep -q '"workerVersion":"1.0.0"' $FM/sessions.jsonl
check "the worker cannot write the install dir" bash -c "! runuser -u remyral-worker -- touch /opt/remyral-worker/x 2>/dev/null"

# --- 3. update to 1.1.0 through the privileged updater ---------------------------------------------
pid1=$(prop MainPID)
offer '{"version":"1.1.0"}'
wait_for 120 "1.1.0: worker reported succeeded after the restart" status_has '"version":"1.1.0","phase":"succeeded"'
check "1.0.0 reported downloading and activating before the restart" bash -c "grep -q '\"version\":\"1.1.0\",\"phase\":\"activating\"' $FM/status.jsonl"
check "active bundle is 1.1.0" active_is 1.1.0
check "remyral-worker --version is 1.1.0" [ "$(remyral-worker --version)" = 1.1.0 ]
check "service restarted (new MainPID)" [ "$(prop MainPID)" != "$pid1" ]
check "1.1.0 connected" grep -q '"workerVersion":"1.1.0"' $FM/sessions.jsonl
check "previous version retained" [ -f /opt/remyral-worker/versions/1.0.0/remyral-worker.mjs ]
check "updater logged the health check" bash -c "journalctl -u remyral-worker-update.service --no-pager -o cat | grep -q 'new version is healthy'"

# --- 4. forced failure: 1.2.0 is validly signed but never connects → automatic rollback --------------
offer '{"version":"1.2.0"}'
wait_for 150 "1.2.0: rolled back after the failed health check (reported by 1.1.0)" status_has '"version":"1.2.0","phase":"rolled_back","reason":"health_check_failed"'
check "active bundle is 1.1.0 again" active_is 1.1.0
check "active.json says 1.1.0" grep -q '"version":"1.1.0"' /opt/remyral-worker/state/active.json
check "service active after rollback" is_active
check "remyral-worker --version is 1.1.0" [ "$(remyral-worker --version)" = 1.1.0 ]

# --- 5. refusals: tampered artifact, downgrade without rollback ---------------------------------------
offer '{"version":"1.3.0"}'
wait_for 30 "tampered 1.3.0 refused by the worker" bash -c "grep -Eq '\"version\":\"1.3.0\",\"phase\":\"refused\",\"reason\":\"(size|sha256)_mismatch\"' $FM/status.jsonl"
offer '{"version":"1.0.0","nonce":"a"}'
wait_for 30 "downgrade without rollback refused" status_has '"version":"1.0.0","phase":"refused","reason":"downgrade_refused"'
check "still 1.1.0" active_is 1.1.0

# --- 6. a forged request from the worker account achieves nothing -----------------------------------
runuser -u remyral-worker -- sh -c 'd=/var/lib/remyral-worker/updates/staged/9.9.9 && mkdir -p $d && echo "evil()" >$d/remyral-worker.mjs && cp /opt/remyral-worker/versions/1.1.0/manifest.json /opt/remyral-worker/versions/1.1.0/manifest.sig.json $d/ && printf "{\"schema\":1,\"attemptId\":\"00000000-0000-4000-8000-000000000999\",\"version\":\"9.9.9\",\"rollback\":false,\"requestedAt\":\"2026-10-13T00:00:00.000Z\"}" >/var/lib/remyral-worker/updates/request.json.tmp && mv /var/lib/remyral-worker/updates/request.json.tmp /var/lib/remyral-worker/updates/request.json'
wait_for 30 "forged request refused by the updater" grep -q '"attemptId":"00000000-0000-4000-8000-000000000999".*"outcome":"refused"' /opt/remyral-worker/state/last-result.json
check "still 1.1.0 after the forged request" active_is 1.1.0

# --- 7. explicit rollback to 1.0.0 ------------------------------------------------------------------
offer '{"version":"1.0.0","rollback":true,"nonce":"b"}'
wait_for 120 "explicit rollback to 1.0.0 succeeded" status_has '"version":"1.0.0","phase":"succeeded"'
check "active bundle is 1.0.0" active_is 1.0.0

# --- 8. uninstall removes the updater units ---------------------------------------------------------
bash $SRC/uninstall.sh >/tmp/u1.log 2>&1 || { cat /tmp/u1.log; fail "uninstall"; }
check "updater units removed" bash -c '[ ! -e /etc/systemd/system/remyral-worker-update.service ] && [ ! -e /etc/systemd/system/remyral-worker-update.path ]'
check "program files (versions, state) removed" [ ! -e /opt/remyral-worker ]

echo "ALL PASSED ($pass checks)"
